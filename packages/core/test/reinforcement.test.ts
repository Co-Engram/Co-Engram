import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  recordRetrievalSuccess,
  reinforceEngram,
  projectImportance,
} from "../src/reinforcement/ltp.js";
import {
  recordRetrievalFailure,
  projectImportanceAfterFailures,
  DEFAULT_ARCHIVE_THRESHOLD,
  DEFAULT_FORGET_THRESHOLD,
} from "../src/reinforcement/ltd.js";
import { reinforceRelated } from "../src/reinforcement/related.js";
import {
  DEFAULT_CONFIG,
  validateConfig,
  type ReinforcementConfig,
} from "../src/reinforcement/config.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-reinforcement-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createEngram(
  overrides: {
    importance?: number;
    title?: string;
    content?: string;
  } = {},
) {
  return repo.createEngram({
    title: overrides.title ?? "A",
    content: overrides.content ?? "内容",
    kind: "fact",
    domainTags: ["t"],
    createdBy: "y",
    importance: overrides.importance ?? 0.5,
  });
}

// ============================================================
// config.ts
// ============================================================

describe("DEFAULT_CONFIG", () => {
  it("默认值符合 spec 6.2", () => {
    expect(DEFAULT_CONFIG.ltpGain).toBe(0.02);
    expect(DEFAULT_CONFIG.ltdPenalty).toBe(0.03);
    expect(DEFAULT_CONFIG.hebbianRatio).toBe(0.5);
    expect(DEFAULT_CONFIG.failureThreshold).toBe(3);
    expect(DEFAULT_CONFIG.failureEscalation).toBe(1.5);
  });
});

describe("validateConfig", () => {
  it("默认配置合法", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it("ltpGain 越界抛错", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, ltpGain: 0 })).toThrow(
      /ltpGain/,
    );
    expect(() => validateConfig({ ...DEFAULT_CONFIG, ltpGain: 2 })).toThrow(
      /ltpGain/,
    );
  });

  it("hebbianRatio 越界抛错", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, hebbianRatio: -0.1 }),
    ).toThrow(/hebbianRatio/);
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, hebbianRatio: 1.1 }),
    ).toThrow(/hebbianRatio/);
  });

  it("failureThreshold<1 抛错", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, failureThreshold: 0 }),
    ).toThrow(/failureThreshold/);
  });
});

// ============================================================
// ltp.ts
// ============================================================

describe("recordRetrievalSuccess", () => {
  it("基础：effective=1 → importance += 0.02", () => {
    const engram = createEngram({ importance: 0.5 });
    const result = recordRetrievalSuccess(repo, engram.id, 1);
    expect(result.importance).toBeCloseTo(0.52, 5);
    expect(result.importanceDelta).toBeCloseTo(0.02, 5);
    expect(result.effectiveRetrievals).toBe(1);
    expect(result.retrievalCount).toBe(1);
    expect(result.reinforcementScore).toBeCloseTo(1, 5);
    expect(result.lastEffectiveAt).toBeTruthy();
  });

  it("effective=0.5 → importance += 0.01", () => {
    const engram = createEngram({ importance: 0.5 });
    const result = recordRetrievalSuccess(repo, engram.id, 0.5);
    expect(result.importance).toBeCloseTo(0.51, 5);
    expect(result.importanceDelta).toBeCloseTo(0.01, 5);
    expect(result.reinforcementScore).toBeCloseTo(0.5, 5);
  });

  it("多次强化：importance 累积", () => {
    const engram = createEngram({ importance: 0.5 });
    for (let i = 0; i < 5; i++) {
      recordRetrievalSuccess(repo, engram.id, 1);
    }
    const final = repo.readEngram(engram.id);
    expect(final.importance).toBeCloseTo(0.6, 5); // 0.5 + 5×0.02
    expect(final.effectiveRetrievals).toBe(5);
  });

  it("importance 不超过 1", () => {
    const engram = createEngram({ importance: 0.95 });
    recordRetrievalSuccess(repo, engram.id, 1);
    // 0.95 + 0.02 = 0.97
    expect(repo.readEngram(engram.id).importance).toBeCloseTo(0.97, 5);
    recordRetrievalSuccess(repo, engram.id, 1);
    // 0.97 + 0.02 = 0.99
    expect(repo.readEngram(engram.id).importance).toBeCloseTo(0.99, 5);
    recordRetrievalSuccess(repo, engram.id, 1);
    // 0.99 + 0.02 = 1.01 → clamp 1
    expect(repo.readEngram(engram.id).importance).toBe(1);
  });

  it("effectiveness 越界抛错", () => {
    const engram = createEngram();
    expect(() => recordRetrievalSuccess(repo, engram.id, -0.1)).toThrow(
      /effectiveness/,
    );
    expect(() => recordRetrievalSuccess(repo, engram.id, 1.5)).toThrow(
      /effectiveness/,
    );
  });

  it("不存在抛错", () => {
    expect(() => recordRetrievalSuccess(repo, "no/such", 1)).toThrow(
      /not found/,
    );
  });

  it("【验收】10 次强化后 importance 从 0.5 → 约 0.7", () => {
    const engram = createEngram({ importance: 0.5 });
    for (let i = 0; i < 10; i++) {
      recordRetrievalSuccess(repo, engram.id, 1);
    }
    const final = repo.readEngram(engram.id);
    expect(final.importance).toBeCloseTo(0.7, 5);
  });
});

describe("reinforceEngram", () => {
  it("只升 importance 不动 retrieval 统计", () => {
    const engram = createEngram({ importance: 0.5 });
    const result = reinforceEngram(repo, engram.id, 0.1);
    expect(result.importance).toBeCloseTo(0.6, 5);
    const engram2 = repo.readEngram(engram.id);
    expect(engram2.effectiveRetrievals).toBe(0);
    expect(engram2.retrievalCount).toBe(0);
  });

  it("amount<0 抛错", () => {
    const engram = createEngram();
    expect(() => reinforceEngram(repo, engram.id, -0.1)).toThrow(/amount/);
  });
});

describe("projectImportance", () => {
  it("预测 N 次强化后的 importance", () => {
    const engram = createEngram({ importance: 0.5 });
    const projected = projectImportance(engram, 10);
    expect(projected).toBeCloseTo(0.7, 5);
  });

  it("上限为 1", () => {
    const engram = createEngram({ importance: 0.9 });
    expect(projectImportance(engram, 100)).toBe(1);
  });
});

// ============================================================
// ltd.ts
// ============================================================

describe("recordRetrievalFailure", () => {
  it("基础：importance -= 0.03", () => {
    const engram = createEngram({ importance: 0.5 });
    const result = recordRetrievalFailure(repo, engram.id);
    expect(result.importanceDelta).toBeCloseTo(-0.03, 5);
    expect(result.importance).toBeCloseTo(0.47, 5);
    expect(result.failedUses).toBe(1);
    expect(result.retrievalCount).toBe(1);
    expect(result.shouldArchive).toBe(false);
    expect(result.shouldForget).toBe(false);
  });

  it("失败累积到阈值后升级（×1.5 倍率）", () => {
    const engram = createEngram({ importance: 0.9 });
    // 前 2 次正常惩罚
    recordRetrievalFailure(repo, engram.id); // failedUses=1, penalty=0.03
    recordRetrievalFailure(repo, engram.id); // failedUses=2, penalty=0.03
    // 第 3 次达到 failureThreshold=3 → penalty=0.03×1.5=0.045
    const result = recordRetrievalFailure(repo, engram.id);
    expect(result.failedUses).toBe(3);
    expect(result.importanceDelta).toBeCloseTo(-0.045, 5);
    expect(result.shouldArchive).toBe(true);
    expect(result.shouldForget).toBe(false);
    // importance = 0.9 - 0.03 - 0.03 - 0.045 = 0.795
    expect(result.importance).toBeCloseTo(0.795, 5);
  });

  it("达到 forget 阈值（5 次）", () => {
    const engram = createEngram({ importance: 1 });
    for (let i = 0; i < 5; i++) {
      recordRetrievalFailure(repo, engram.id);
    }
    const final = repo.readEngram(engram.id);
    expect(final.failedUses).toBe(5);
    // 第 5 次仍触发 shouldArchive + shouldForget
  });

  it("importance 不低于 0", () => {
    const engram = createEngram({ importance: 0.01 });
    recordRetrievalFailure(repo, engram.id);
    expect(repo.readEngram(engram.id).importance).toBe(0);
  });

  it("不存在抛错", () => {
    expect(() => recordRetrievalFailure(repo, "no/such")).toThrow(/not found/);
  });

  it("非法阈值抛错", () => {
    const engram = createEngram();
    expect(() =>
      recordRetrievalFailure(repo, engram.id, DEFAULT_CONFIG, 5, 3),
    ).toThrow(/thresholds invalid/);
  });

  it("DEFAULT_ARCHIVE_THRESHOLD=3, DEFAULT_FORGET_THRESHOLD=5", () => {
    expect(DEFAULT_ARCHIVE_THRESHOLD).toBe(3);
    expect(DEFAULT_FORGET_THRESHOLD).toBe(5);
  });
});

describe("projectImportanceAfterFailures", () => {
  it("预测 N 次失败后的 importance", () => {
    const engram = createEngram({ importance: 0.9 });
    // 前 2 次 0.03 + 第 3 次 0.045 = 0.105 → 0.795
    const projected = projectImportanceAfterFailures(engram, 3);
    expect(projected).toBeCloseTo(0.795, 5);
  });

  it("下限为 0", () => {
    const engram = createEngram({ importance: 0.01 });
    expect(projectImportanceAfterFailures(engram, 100)).toBe(0);
  });
});

// ============================================================
// related.ts (Hebbian)
// ============================================================

describe("reinforceRelated", () => {
  it("邻居得到 50% 增益", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    // 创建 A→B 的 synapse（extends）
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    // A 得到 importanceDelta=0.1，B 应得 0.05
    const result = reinforceRelated(repo, a.id, 0.1);
    expect(result.reinforcedNeighborIds).toContain(b.id);
    expect(result.importanceDeltaPerNeighbor).toBeCloseTo(0.05, 5);
    const finalB = repo.readEngram(b.id);
    expect(finalB.importance).toBeCloseTo(0.55, 5);
  });

  it("incoming synapse 的源端也被强化", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    // 强化 B → A 作为 incoming source 也被强化
    const result = reinforceRelated(repo, b.id, 0.2);
    expect(result.reinforcedNeighborIds).toContain(a.id);
    const finalA = repo.readEngram(a.id);
    expect(finalA.importance).toBeCloseTo(0.6, 5); // 0.5 + 0.2×0.5
  });

  it("contradicts synapse 的邻居不强化", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "contradicts",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    const result = reinforceRelated(repo, a.id, 0.2);
    expect(result.reinforcedNeighborIds).not.toContain(b.id);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(repo.readEngram(b.id).importance).toBe(0.5);
  });

  it("archived 邻居不强化", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    repo.updateLifecycle(b.id, "archived", undefined);
    const result = reinforceRelated(repo, a.id, 0.2);
    expect(result.reinforcedNeighborIds).not.toContain(b.id);
    expect(repo.readEngram(b.id).importance).toBe(0.5);
  });

  it("baseImportanceDelta<0（LTD）不触发 Hebbian", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    const result = reinforceRelated(repo, a.id, -0.1);
    expect(result.reinforcedNeighborIds).toEqual([]);
    expect(result.importanceDeltaPerNeighbor).toBe(0);
  });

  it("hebbianRatio=0 → 邻居不强化", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
      retrievalWeight: 0.5,
    });
    const config: ReinforcementConfig = { ...DEFAULT_CONFIG, hebbianRatio: 0 };
    const result = reinforceRelated(repo, a.id, 0.2, config);
    expect(result.reinforcedNeighborIds).toEqual([]);
    expect(repo.readEngram(b.id).importance).toBe(0.5);
  });

  it("不存在抛错", () => {
    expect(() => reinforceRelated(repo, "no/such", 0.1)).toThrow(/not found/);
  });
});

// ============================================================
// 端到端：工具级流程模拟
// ============================================================

describe("端到端：LTP + Hebbian + LTD 组合", () => {
  it("A B C 链式强化：A→B→C，强化 A 时 B、C 都得到增益", () => {
    const a = createEngram({ title: "A", importance: 0.5 });
    const b = createEngram({ title: "B", importance: 0.5 });
    const c = createEngram({ title: "C", importance: 0.5 });
    repo.addOutgoingSynapse(a.id, makeSynapse("syn-1", a.id, b.id, "extends"));
    repo.addOutgoingSynapse(b.id, makeSynapse("syn-2", b.id, c.id, "extends"));

    // 强化 A：A += 0.02，B 作为 A 的 outgoing 邻居 += 0.01
    const directA = recordRetrievalSuccess(repo, a.id, 1);
    const relatedA = reinforceRelated(repo, a.id, directA.importanceDelta);
    expect(relatedA.reinforcedNeighborIds).toContain(b.id);
    // C 没有被强化（因为 Hebbian 只跳一跳）
    expect(repo.readEngram(c.id).importance).toBe(0.5);

    // 继续强化 B：B += 0.02；A 作为 incoming 源 += 0.01；C 作为 outgoing 目标 += 0.01
    const directB = recordRetrievalSuccess(repo, b.id, 1);
    reinforceRelated(repo, b.id, directB.importanceDelta);
    // 最终：
    // A: 0.5 + 0.02 + 0.01 = 0.53
    // B: 0.5 + 0.01 + 0.02 = 0.53
    // C: 0.5 + 0.01 = 0.51
    expect(repo.readEngram(a.id).importance).toBeCloseTo(0.53, 5);
    expect(repo.readEngram(b.id).importance).toBeCloseTo(0.53, 5);
    expect(repo.readEngram(c.id).importance).toBeCloseTo(0.51, 5);
  });

  it("多次失败的 engram 自动建议降级", () => {
    const engram = createEngram({ importance: 0.9 });
    let lastResult;
    for (let i = 0; i < 5; i++) {
      lastResult = recordRetrievalFailure(repo, engram.id);
    }
    expect(lastResult!.shouldArchive).toBe(true);
    expect(lastResult!.shouldForget).toBe(true);
    // importance 累计惩罚：
    // 0.9 - 0.03 - 0.03 - 0.045 - 0.045 - 0.045 = 0.705
    expect(lastResult!.importance).toBeCloseTo(0.705, 5);
  });
});

function makeSynapse(
  id: string,
  from: string,
  to: string,
  kind: "extends" | "contradicts",
) {
  return {
    id,
    from,
    to,
    kind,
    weight: 0.5,
    direction: "directional" as const,
    evidence: [],
    createdBy: "y",
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    retrievalWeight: 0.5,
  };
}
