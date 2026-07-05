import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  DEFAULT_IMPORTANCE_WEIGHTS,
  validateImportanceWeights,
  deriveNetworkImportance,
  deriveTemporalImportance,
  compositeImportance,
  defaultImportanceVector,
  recomputeImportance,
  recomputeImportanceBatch,
} from "../src/importance/vector.js";
import type { ImportanceVector } from "../src/types/engram.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-importance-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title?: string;
  content?: string;
  importance?: number;
  importanceVector?: ImportanceVector;
}) {
  return repo.createEngram({
    title: input.title ?? "A",
    content: input.content ?? "a",
    kind: "observation",
    domainTags: ["t"],
    createdBy: "y",
    importance: input.importance ?? 0.5,
    importanceVector: input.importanceVector,
  });
}

function synapseTo(target: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const w = repo.createEngram({
      title: `W${i}`,
      content: `w ${i}`,
      kind: "observation",
      domainTags: ["t"],
      createdBy: "y",
    });
    repo.addOutgoingSynapse(w.id, {
      id: `s-${i}`,
      from: w.id,
      to: target,
      kind: "exemplifies",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.5,
    });
  }
}

// ============================================================
// DEFAULT_IMPORTANCE_WEIGHTS
// ============================================================

describe("DEFAULT_IMPORTANCE_WEIGHTS", () => {
  it("五维权重和为 1", () => {
    const sum =
      DEFAULT_IMPORTANCE_WEIGHTS.personal +
      DEFAULT_IMPORTANCE_WEIGHTS.team +
      DEFAULT_IMPORTANCE_WEIGHTS.project +
      DEFAULT_IMPORTANCE_WEIGHTS.network +
      DEFAULT_IMPORTANCE_WEIGHTS.temporal;
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });

  it("每维在 [0,1]", () => {
    for (const v of Object.values(DEFAULT_IMPORTANCE_WEIGHTS)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================
// validateImportanceWeights
// ============================================================

describe("validateImportanceWeights", () => {
  it("合法权重 → 不抛错", () => {
    expect(() =>
      validateImportanceWeights(DEFAULT_IMPORTANCE_WEIGHTS),
    ).not.toThrow();
  });

  it("和 ≠ 1 → 抛错", () => {
    expect(() =>
      validateImportanceWeights({
        personal: 0.3,
        team: 0.3,
        project: 0,
        network: 0,
        temporal: 0,
      }),
    ).toThrow(/sum to 1/);
  });

  it("越界 → 抛错", () => {
    expect(() =>
      validateImportanceWeights({
        personal: 1.5,
        team: -0.5,
        project: 0,
        network: 0,
        temporal: 0,
      }),
    ).toThrow(/\[0,1\]/);
  });
});

// ============================================================
// deriveNetworkImportance
// ============================================================

describe("deriveNetworkImportance", () => {
  it("incomingSynapseCount=0 → 0", () => {
    expect(deriveNetworkImportance(0)).toBe(0);
  });

  it("incomingSynapseCount ≥ saturation → 1", () => {
    expect(deriveNetworkImportance(10)).toBe(1);
    expect(deriveNetworkImportance(100)).toBe(1);
  });

  it("中间值线性增长", () => {
    expect(deriveNetworkImportance(5)).toBeCloseTo(0.5, 5);
    expect(deriveNetworkImportance(2)).toBeCloseTo(0.2, 5);
  });

  it("自定义 saturation", () => {
    expect(deriveNetworkImportance(5, 5)).toBe(1);
    expect(deriveNetworkImportance(2, 5)).toBeCloseTo(0.4, 5);
  });
});

// ============================================================
// deriveTemporalImportance
// ============================================================

describe("deriveTemporalImportance", () => {
  const now = new Date("2026-06-20T00:00:00Z");
  const FIXED_CREATED_AT = "2020-01-01T00:00:00Z";

  it("未生效 engram 用 createdAt 兜底,新记忆也按艾宾浩斯衰退", () => {
    const created10DaysAgo = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    // importance=0.5 → halfLife≈14 天,recency = 0.5^(10/14) ≈ 0.61
    expect(deriveTemporalImportance(null, created10DaysAgo, 0.5, now)).toBeGreaterThan(0.4);
    expect(deriveTemporalImportance(undefined, created10DaysAgo, 0.5, now)).toBeGreaterThan(0.4);
  });

  it("刚 lastEffectiveAt → 接近 1", () => {
    const recent = "2026-06-19T00:00:00Z"; // 1 天前
    expect(deriveTemporalImportance(recent, FIXED_CREATED_AT, 0.5, now)).toBeGreaterThan(0.95);
  });

  it("很久以前 lastEffectiveAt → 接近 0", () => {
    const old = "2020-01-01T00:00:00Z"; // 数年前
    expect(deriveTemporalImportance(old, FIXED_CREATED_AT, 0.05, now)).toBeLessThan(0.01);
  });

  it("半衰期精确:age=halfLife → 0.5", () => {
    // importance=0.5 → halfLife ≈ 14 天;14 天前 lastEffectiveAt → recency ≈ 0.5
    const halfLife = 50 * Math.pow(0.5 + 0.1, 2.5);
    const halfLifeDaysAgo = new Date(
      now.getTime() - halfLife * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(deriveTemporalImportance(halfLifeDaysAgo, FIXED_CREATED_AT, 0.5, now)).toBeCloseTo(
      0.5,
      3,
    );
  });

  it("importance 越高 → halflife 越长 → 同样 age 下 temporal 更大", () => {
    const old = "2025-01-01T00:00:00Z";
    const lowImp = deriveTemporalImportance(old, FIXED_CREATED_AT, 0.05, now);
    const highImp = deriveTemporalImportance(old, FIXED_CREATED_AT, 0.9, now);
    expect(highImp).toBeGreaterThan(lowImp);
  });
});

// ============================================================
// compositeImportance
// ============================================================

describe("compositeImportance", () => {
  it("全 0 → composite=0", () => {
    const c = compositeImportance({
      personal: 0,
      team: 0,
      project: 0,
      network: 0,
      temporal: 0,
    });
    expect(c).toBe(0);
  });

  it("全 1 → composite=1", () => {
    const c = compositeImportance({
      personal: 1,
      team: 1,
      project: 1,
      network: 1,
      temporal: 1,
    });
    expect(c).toBe(1);
  });

  it("全 0.5 → composite=0.5", () => {
    const c = compositeImportance({
      personal: 0.5,
      team: 0.5,
      project: 0.5,
      network: 0.5,
      temporal: 0.5,
    });
    expect(c).toBeCloseTo(0.5, 5);
  });

  it("自定义权重生效", () => {
    // 只看 personal：personal=1 → composite=1
    const c = compositeImportance(
      { personal: 1, team: 0, project: 0, network: 0, temporal: 0 },
      { personal: 1, team: 0, project: 0, network: 0, temporal: 0 },
    );
    expect(c).toBeCloseTo(1, 5);
  });

  it("非法权重抛错", () => {
    expect(() =>
      compositeImportance(
        { personal: 0.5, team: 0.5, project: 0.5, network: 0.5, temporal: 0.5 },
        { personal: 1, team: 1, project: 0, network: 0, temporal: 0 },
      ),
    ).toThrow(/sum to 1/);
  });
});

// ============================================================
// defaultImportanceVector
// ============================================================

describe("defaultImportanceVector", () => {
  it("personal/team/project 默认 0.5", () => {
    const v = defaultImportanceVector();
    expect(v.personal).toBe(0.5);
    expect(v.team).toBe(0.5);
    expect(v.project).toBe(0.5);
  });

  it("network/temporal 默认 0（未派生）", () => {
    const v = defaultImportanceVector();
    expect(v.network).toBe(0);
    expect(v.temporal).toBe(0);
  });

  it("composite 默认 0.5", () => {
    expect(defaultImportanceVector().composite).toBe(0.5);
  });
});

// ============================================================
// recomputeImportance
// ============================================================

describe("recomputeImportance", () => {
  const NOW = new Date("2026-06-20T00:00:00Z");

  it("不存在 → 抛错", () => {
    expect(() => recomputeImportance(repo, "no/such")).toThrow(/not found/);
  });

  it("默认重算:network/temporal 派生,personal/team/project 保留 0.5", () => {
    const e = makeEngram({});
    const result = recomputeImportance(repo, e.id, { now: NOW });
    expect(result.next.personal).toBe(0.5);
    expect(result.next.team).toBe(0.5);
    expect(result.next.project).toBe(0.5);
    expect(result.next.network).toBe(0); // 0 incoming
    // 未生效 engram 的 temporal 基于 createdAt 派生(艾宾浩斯衰退)
    // createEngram 写入 createdAt=now(),NOW=2026-06-20;若 createdAt > NOW(时钟偏差)→ effectiveAge=0 → temporal=1
    // 若 createdAt < NOW → temporal = 0.5^(ageDays/90),随时间衰减
    expect(result.next.temporal).toBeGreaterThan(0);
    expect(result.next.temporal).toBeLessThanOrEqual(1);
    expect(result.next.composite).toBeGreaterThan(0);
  });

  it("有 incomingSynapseCount → network > 0", () => {
    const e = makeEngram({});
    synapseTo(e.id, 5);
    const result = recomputeImportance(repo, e.id, { now: NOW });
    expect(result.next.network).toBeCloseTo(0.5, 5);
  });

  it("有 lastEffectiveAt → temporal > 0", () => {
    // importance=0.9 → halfLife≈49 天;1 天前 → recency = 0.5^(1/49) ≈ 0.986
    const e = makeEngram({ importance: 0.9 });
    repo.bumpRetrievalStats(e.id, {
      effectiveDelta: 1,
      lastEffectiveAt: "2026-06-19T00:00:00Z",
    });
    const result = recomputeImportance(repo, e.id, { now: NOW });
    expect(result.next.temporal).toBeGreaterThan(0.95);
  });

  it("overrides 覆盖 personal/team/project", () => {
    const e = makeEngram({});
    const result = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.9, team: 0.8, project: 0.7 },
    });
    expect(result.next.personal).toBe(0.9);
    expect(result.next.team).toBe(0.8);
    expect(result.next.project).toBe(0.7);
  });

  it("overrides 部分覆盖：其他维度保留原值", () => {
    const e = makeEngram({});
    // 先设 personal=0.3
    recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.3, team: 0.3, project: 0.3 },
      persist: true,
    });
    // 再只覆盖 team
    const result = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { team: 0.9 },
    });
    expect(result.next.personal).toBe(0.3); // 保留
    expect(result.next.team).toBe(0.9); // 覆盖
    expect(result.next.project).toBe(0.3); // 保留
  });

  it("persist=true（默认）→ meta 落盘", () => {
    const e = makeEngram({});
    recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.9 },
    });
    const updated = repo.readEngram(e.id);
    expect(updated.importanceVector).toBeDefined();
    expect(updated.importanceVector!.personal).toBe(0.9);
    // composite 也写回 meta.importance
    expect(updated.importance).toBe(updated.importanceVector!.composite);
  });

  it("persist=false → 不落盘", () => {
    const e = makeEngram({});
    const before = repo.readEngram(e.id).importance;
    const result = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.9 },
      persist: false,
    });
    expect(result.persisted).toBe(false);
    const after = repo.readEngram(e.id);
    expect(after.importanceVector).toBeUndefined();
    expect(after.importance).toBe(before);
  });

  it("previous 是上次的 importanceVector", () => {
    const e = makeEngram({});
    // 第一次：无 previous
    const r1 = recomputeImportance(repo, e.id, { now: NOW });
    expect(r1.previous).toBeUndefined();
    // 第二次：previous = r1.next
    const r2 = recomputeImportance(repo, e.id, { now: NOW });
    expect(r2.previous).toBeDefined();
    expect(r2.previous!.personal).toBe(r1.next.personal);
  });
});

// ============================================================
// recomputeImportanceBatch
// ============================================================

describe("recomputeImportanceBatch", () => {
  const NOW = new Date("2026-06-20T00:00:00Z");

  it("空仓库 → 0 scanned", () => {
    const result = recomputeImportanceBatch(repo, { now: NOW });
    expect(result.scanned).toBe(0);
    expect(result.recomputed).toBe(0);
  });

  it("批量扫描按 id 字典序", () => {
    makeEngram({ title: "Z" });
    makeEngram({ title: "A" });
    makeEngram({ title: "M" });
    const r1 = recomputeImportanceBatch(repo, { now: NOW });
    const r2 = recomputeImportanceBatch(repo, { now: NOW });
    expect(r1.scanned).toBe(r2.scanned);
    expect(r1.recomputed).toBe(3);
  });

  it("跳过 archived", () => {
    const e = makeEngram({});
    repo.updateLifecycle(e.id, "archived");
    const result = recomputeImportanceBatch(repo, { now: NOW });
    expect(result.scanned).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it("overrides 回调按 engramId 派生", () => {
    const eA = makeEngram({ title: "A", content: "aaa" });
    const eB = makeEngram({ title: "B", content: "bbb" });
    recomputeImportanceBatch(repo, {
      now: NOW,
      overrides: (id) => (id === eA.id ? { personal: 0.9 } : { personal: 0.1 }),
    });
    expect(repo.readEngram(eA.id).importanceVector!.personal).toBe(0.9);
    expect(repo.readEngram(eB.id).importanceVector!.personal).toBe(0.1);
  });

  it("dryRun（persist=false）→ 不落盘", () => {
    const e = makeEngram({});
    const result = recomputeImportanceBatch(repo, { now: NOW, persist: false });
    expect(result.recomputed).toBe(1);
    expect(repo.readEngram(e.id).importanceVector).toBeUndefined();
  });
});

// ============================================================
// spec 验收：同一 engram 对不同团队/项目有不同重要性
// ============================================================

describe("spec 验收：多维重要性", () => {
  const NOW = new Date("2026-06-20T00:00:00Z");

  it("不同 overrides 产生不同 composite", () => {
    const e = makeEngram({});

    // 场景 A：团队 A 视角（personal=0.9）
    const a = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.9, team: 0.5, project: 0.5 },
      persist: false,
    });

    // 场景 B：团队 B 视角（personal=0.1）
    const b = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.1, team: 0.5, project: 0.5 },
      persist: false,
    });

    expect(a.next.composite).toBeGreaterThan(b.next.composite);
  });

  it("检索公式集成：recompute 后 engram.importance = composite", () => {
    const e = makeEngram({ importance: 0.5 });
    // 派生条件：5 个 incoming + 1 天前有效检索
    synapseTo(e.id, 5);
    repo.bumpRetrievalStats(e.id, {
      effectiveDelta: 1,
      lastEffectiveAt: "2026-06-19T00:00:00Z",
    });

    const result = recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 1, team: 1, project: 1 },
    });

    // composite 严格高于纯 0.5
    const updated = repo.readEngram(e.id);
    expect(updated.importance).toBeCloseTo(result.next.composite, 5);
    expect(updated.importance).toBeGreaterThan(0.5);
  });

  it("端到端：complete importance flow（创建 → 派生 → 持久化 → 读回）", () => {
    const e = makeEngram({});
    // 1. 初始无 importanceVector
    expect(repo.readEngram(e.id).importanceVector).toBeUndefined();

    // 2. 累积使用证据
    synapseTo(e.id, 3);
    repo.bumpRetrievalStats(e.id, {
      effectiveDelta: 2,
      lastEffectiveAt: "2026-06-18T00:00:00Z",
    });

    // 3. 重算
    recomputeImportance(repo, e.id, {
      now: NOW,
      overrides: { personal: 0.8, team: 0.7 },
    });

    // 4. 读回验证
    const engram = repo.readEngram(e.id);
    expect(engram.importanceVector).toBeDefined();
    expect(engram.importanceVector!.personal).toBe(0.8);
    expect(engram.importanceVector!.team).toBe(0.7);
    expect(engram.importanceVector!.project).toBe(0.5); // 默认
    expect(engram.importanceVector!.network).toBeCloseTo(0.3, 5); // 3/10
    expect(engram.importanceVector!.temporal).toBeGreaterThan(0.9); // 2 天前
    expect(engram.importance).toBe(engram.importanceVector!.composite);
  });
});
