import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  DEFAULT_PROVENANCE_CONFIG,
  deriveSourceReliability,
  deriveAllSourceReliability,
  classifyReliability,
  applyProvenanceSignal,
  flagLowReliabilitySources,
  computeInitialConfidence,
  type ProvenanceConfig,
} from "../src/provenance/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-provenance-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content?: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  domainTags?: readonly string[];
  createdBy?: string;
  confidence?: number;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["t"],
    createdBy: input.createdBy ?? "alice",
    confidence: input.confidence ?? 0.5,
  });
}

/** 累加三信号到 engram */
function bumpStats(
  id: string,
  delta: { effective?: number; failed?: number; retrieved?: number },
) {
  repo.bumpRetrievalStats(id, {
    effectiveDelta: delta.effective,
    failedDelta: delta.failed,
    retrievedDelta: delta.retrieved,
  });
}

// ============================================================
// DEFAULT_PROVENANCE_CONFIG
// ============================================================

describe("DEFAULT_PROVENANCE_CONFIG", () => {
  it("spec 阈值符合预期", () => {
    expect(DEFAULT_PROVENANCE_CONFIG.lowReliabilityThreshold).toBe(0.4);
    expect(DEFAULT_PROVENANCE_CONFIG.highReliabilityThreshold).toBe(0.8);
    expect(DEFAULT_PROVENANCE_CONFIG.confidenceBoost).toBe(0.1);
    expect(DEFAULT_PROVENANCE_CONFIG.minSampleSize).toBe(3);
    expect(DEFAULT_PROVENANCE_CONFIG.flaggedVerificationStatus).toBe(
      "plausible",
    );
  });
});

// ============================================================
// deriveSourceReliability
// ============================================================

describe("deriveSourceReliability", () => {
  it("来源不存在 → null", () => {
    expect(deriveSourceReliability(repo, "nobody")).toBeNull();
  });

  it("新来源（无三信号）→ reliability=0.5（中性）", () => {
    makeEngram({ title: "A", createdBy: "alice" });
    const r = deriveSourceReliability(repo, "alice")!;
    expect(r.createdBy).toBe("alice");
    expect(r.totalEffective).toBe(0);
    expect(r.totalFailed).toBe(0);
    expect(r.reliability).toBe(0.5);
    expect(r.engramCount).toBe(1);
  });

  it("累加多个 engram 的三信号", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    const b = makeEngram({ title: "B", createdBy: "alice" });
    const c = makeEngram({ title: "C", createdBy: "bob" });

    bumpStats(a.id, { effective: 5, failed: 1, retrieved: 7 });
    bumpStats(b.id, { effective: 3, failed: 1, retrieved: 5 });
    bumpStats(c.id, { effective: 2, failed: 8, retrieved: 10 });

    const alice = deriveSourceReliability(repo, "alice")!;
    expect(alice.totalEffective).toBe(8);
    expect(alice.totalFailed).toBe(2);
    expect(alice.totalRetrievals).toBe(12);
    expect(alice.reliability).toBeCloseTo(8 / 10, 6);
    expect(alice.engramCount).toBe(2);

    const bob = deriveSourceReliability(repo, "bob")!;
    expect(bob.reliability).toBeCloseTo(2 / 10, 6);
  });

  it("只统计该来源的 engram（不混入其他来源）", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    const b = makeEngram({ title: "B", createdBy: "bob" });
    bumpStats(a.id, { effective: 5, failed: 0, retrieved: 5 });
    bumpStats(b.id, { effective: 0, failed: 5, retrieved: 5 });

    const alice = deriveSourceReliability(repo, "alice")!;
    expect(alice.reliability).toBe(1.0);
    expect(alice.engramCount).toBe(1);

    const bob = deriveSourceReliability(repo, "bob")!;
    expect(bob.reliability).toBe(0.0);
  });
});

// ============================================================
// deriveAllSourceReliability
// ============================================================

describe("deriveAllSourceReliability", () => {
  it("返回所有来源，按 reliability 升序", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    const b = makeEngram({ title: "B", createdBy: "bob" });
    const c = makeEngram({ title: "C", createdBy: "carol" });
    bumpStats(a.id, { effective: 0, failed: 5, retrieved: 5 }); // alice = 0
    bumpStats(b.id, { effective: 3, failed: 3, retrieved: 6 }); // bob = 0.5
    bumpStats(c.id, { effective: 5, failed: 0, retrieved: 5 }); // carol = 1

    const all = deriveAllSourceReliability(repo);
    expect(all.map((r) => r.createdBy)).toEqual(["alice", "bob", "carol"]);
    expect(all[0]!.reliability).toBe(0);
    expect(all[1]!.reliability).toBeCloseTo(0.5, 6);
    expect(all[2]!.reliability).toBe(1);
  });

  it("空仓库 → []", () => {
    expect(deriveAllSourceReliability(repo)).toEqual([]);
  });

  it("稳定排序：reliability 相同时按 createdBy 字典序", () => {
    makeEngram({ title: "Z", createdBy: "zoe" });
    makeEngram({ title: "A", createdBy: "alice" });
    // 两个都是 0.5（无样本）
    const all = deriveAllSourceReliability(repo);
    expect(all.map((r) => r.createdBy)).toEqual(["alice", "zoe"]);
  });
});

// ============================================================
// classifyReliability
// ============================================================

describe("classifyReliability", () => {
  const cfg = DEFAULT_PROVENANCE_CONFIG;

  it("样本不足 → insufficient=true", () => {
    const r: {
      totalEffective: number;
      totalFailed: number;
      reliability: number;
    } = {
      totalEffective: 1,
      totalFailed: 1,
      reliability: 0.5,
    };
    const cls = classifyReliability(r as never, cfg);
    expect(cls.insufficient).toBe(true);
    expect(cls.isLow).toBe(false);
    expect(cls.isHigh).toBe(false);
  });

  it("reliability < 0.4 → isLow", () => {
    const r = { totalEffective: 2, totalFailed: 8, reliability: 0.2 };
    const cls = classifyReliability(r as never, cfg);
    expect(cls.insufficient).toBe(false);
    expect(cls.isLow).toBe(true);
    expect(cls.isHigh).toBe(false);
  });

  it("reliability > 0.8 → isHigh", () => {
    const r = { totalEffective: 9, totalFailed: 1, reliability: 0.9 };
    const cls = classifyReliability(r as never, cfg);
    expect(cls.insufficient).toBe(false);
    expect(cls.isLow).toBe(false);
    expect(cls.isHigh).toBe(true);
  });

  it("中间区间 → 既不低也不高", () => {
    const r = { totalEffective: 5, totalFailed: 5, reliability: 0.5 };
    const cls = classifyReliability(r as never, cfg);
    expect(cls.insufficient).toBe(false);
    expect(cls.isLow).toBe(false);
    expect(cls.isHigh).toBe(false);
  });
});

// ============================================================
// applyProvenanceSignal
// ============================================================

describe("applyProvenanceSignal", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() => applyProvenanceSignal(repo, "no/such", "success", 1)).toThrow(
      /not found/,
    );
  });

  it("读取信号快照（不写盘）", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 8, failed: 2, retrieved: 10 });

    const result = applyProvenanceSignal(repo, a.id, "success", 1);
    expect(result.engramId).toBe(a.id);
    expect(result.createdBy).toBe("alice");
    expect(result.outcome).toBe("success");
    expect(result.effectiveness).toBe(1);
    expect(result.reliability.reliability).toBeCloseTo(0.8, 6);
    expect(result.isHighReliability).toBe(true);
    expect(result.isLowReliability).toBe(false);
    expect(result.insufficientSamples).toBe(false);
  });

  it("失败信号也能正确派生（reliability 自然走低）", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 2, failed: 8, retrieved: 10 });

    const result = applyProvenanceSignal(repo, a.id, "failure", 0);
    expect(result.outcome).toBe("failure");
    expect(result.reliability.reliability).toBeCloseTo(0.2, 6);
    expect(result.isLowReliability).toBe(true);
  });

  it("样本不足 → insufficientSamples=true", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 1, failed: 1, retrieved: 2 });

    const result = applyProvenanceSignal(repo, a.id, "partial", 0.5);
    expect(result.insufficientSamples).toBe(true);
    expect(result.isLowReliability).toBe(false);
    expect(result.isHighReliability).toBe(false);
  });
});

// ============================================================
// flagLowReliabilitySources
// ============================================================

describe("flagLowReliabilitySources", () => {
  it("低 reliability 来源 → verificationStatus 降级为 plausible", () => {
    const a1 = makeEngram({ title: "A1", createdBy: "alice" });
    const a2 = makeEngram({ title: "A2", createdBy: "alice" });
    const b1 = makeEngram({ title: "B1", createdBy: "bob" });

    // alice: 2/10 = 0.2 (低)
    bumpStats(a1.id, { effective: 1, failed: 4, retrieved: 5 });
    bumpStats(a2.id, { effective: 1, failed: 4, retrieved: 5 });
    // bob: 8/10 = 0.8 (高)
    bumpStats(b1.id, { effective: 8, failed: 2, retrieved: 10 });

    const result = flagLowReliabilitySources(repo);

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]!.createdBy).toBe("alice");
    expect(result.flagged[0]!.reliability).toBeCloseTo(0.2, 6);
    expect(result.flagged[0]!.engramIds).toHaveLength(2);

    const a1After = repo.readEngram(a1.id);
    expect(a1After.verificationStatus).toBe("plausible");
    const b1After = repo.readEngram(b1.id);
    expect(b1After.verificationStatus).toBe("unverified");
  });

  it("已是 refuted 的 engram 不被覆盖", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 1, failed: 9, retrieved: 10 });
    repo.updateVerificationStatus(a.id, "refuted");

    const result = flagLowReliabilitySources(repo);

    expect(result.flagged[0]!.engramIds).toContain(a.id);
    const after = repo.readEngram(a.id);
    expect(after.verificationStatus).toBe("refuted");
  });

  it("persist=false → 不写盘但仍返回候选", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 1, failed: 9, retrieved: 10 });

    const result = flagLowReliabilitySources(repo, { persist: false });

    expect(result.persisted).toBe(false);
    expect(result.flagged).toHaveLength(1);
    const after = repo.readEngram(a.id);
    expect(after.verificationStatus).toBe("unverified");
  });

  it("无低 reliability 来源 → 返回空", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 8, failed: 2, retrieved: 10 });

    const result = flagLowReliabilitySources(repo);
    expect(result.flagged).toEqual([]);
  });

  it("样本不足的来源不被标记", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 1, failed: 1, retrieved: 2 }); // 样本量 2 < 3

    const result = flagLowReliabilitySources(repo);
    expect(result.flagged).toEqual([]);
  });

  it("自定义阈值生效", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 5, failed: 5, retrieved: 10 }); // reliability = 0.5

    // 把 low 阈值提到 0.6，则 0.5 也算低
    const result = flagLowReliabilitySources(repo, {
      config: { lowReliabilityThreshold: 0.6 },
    });
    expect(result.flagged).toHaveLength(1);
  });
});

// ============================================================
// computeInitialConfidence
// ============================================================

describe("computeInitialConfidence", () => {
  it("高 reliability 来源 → 加成", () => {
    const a = makeEngram({ title: "A", createdBy: "alice", confidence: 0.5 });
    bumpStats(a.id, { effective: 9, failed: 1, retrieved: 10 });

    const boosted = computeInitialConfidence(repo, "alice", 0.65);
    expect(boosted).toBeCloseTo(0.75, 6); // 0.65 + 0.1
  });

  it("低 reliability 来源 → 不加成", () => {
    const a = makeEngram({ title: "A", createdBy: "alice", confidence: 0.5 });
    bumpStats(a.id, { effective: 1, failed: 9, retrieved: 10 });

    const boosted = computeInitialConfidence(repo, "alice", 0.65);
    expect(boosted).toBeCloseTo(0.65, 6);
  });

  it("加成不超过 1.0", () => {
    const a = makeEngram({ title: "A", createdBy: "alice", confidence: 0.9 });
    bumpStats(a.id, { effective: 10, failed: 0, retrieved: 10 });

    const boosted = computeInitialConfidence(repo, "alice", 0.95);
    expect(boosted).toBe(1.0);
  });

  it("样本不足 → 不加成", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 1, failed: 0, retrieved: 1 });

    const boosted = computeInitialConfidence(repo, "alice", 0.65);
    expect(boosted).toBeCloseTo(0.65, 6);
  });

  it("来源不存在 → 返回 base", () => {
    const boosted = computeInitialConfidence(repo, "nobody", 0.7);
    expect(boosted).toBeCloseTo(0.7, 6);
  });

  it("自定义加成幅度生效", () => {
    const a = makeEngram({ title: "A", createdBy: "alice" });
    bumpStats(a.id, { effective: 9, failed: 1, retrieved: 10 });

    const boosted = computeInitialConfidence(repo, "alice", 0.65, {
      config: { confidenceBoost: 0.2 },
    });
    expect(boosted).toBeCloseTo(0.85, 6);
  });
});

// ============================================================
// spec 验收：奖惩回路端到端
// ============================================================

describe("spec 验收：奖惩回路", () => {
  it("来源多次 failedUses 后，新 engram 的初始 confidence 被调低（间接：reliability 低不加成）", () => {
    // alice 历史：5 个 engram 全部 failed
    for (let i = 0; i < 5; i++) {
      const e = makeEngram({
        title: `old-${i}`,
        createdBy: "alice",
      });
      bumpStats(e.id, { effective: 0, failed: 2, retrieved: 2 });
    }

    const r = deriveSourceReliability(repo, "alice")!;
    expect(r.reliability).toBe(0);
    expect(r.engramCount).toBe(5);

    // 新 engram 走 base confidence（不会被加成）
    const base = 0.65; // firsthand 默认
    const adjusted = computeInitialConfidence(repo, "alice", base);
    expect(adjusted).toBe(0.65);

    // 标记低 reliability 来源 → 旗下 engram verificationStatus 降级
    const flagResult = flagLowReliabilitySources(repo);
    expect(flagResult.flagged[0]!.createdBy).toBe("alice");
    expect(flagResult.flagged[0]!.engramIds).toHaveLength(5);
  });

  it("高 reliability 来源的新 engram confidence 加成", () => {
    // bob 历史：5 个 engram 全部 effective
    for (let i = 0; i < 5; i++) {
      const e = makeEngram({
        title: `good-${i}`,
        createdBy: "bob",
      });
      bumpStats(e.id, { effective: 3, failed: 0, retrieved: 3 });
    }

    const r = deriveSourceReliability(repo, "bob")!;
    expect(r.reliability).toBe(1.0);

    const boosted = computeInitialConfidence(repo, "bob", 0.65);
    expect(boosted).toBeCloseTo(0.75, 6);
  });

  it("多来源场景：alice 低、bob 高、carol 中性", () => {
    const setup = [
      { who: "alice", eff: 1, fail: 9 },
      { who: "bob", eff: 9, fail: 1 },
      { who: "carol", eff: 5, fail: 5 },
    ];
    const createdIds: Record<string, string> = {};
    for (const s of setup) {
      const e = makeEngram({ title: `e-${s.who}`, createdBy: s.who });
      createdIds[s.who] = e.id;
      bumpStats(e.id, {
        effective: s.eff,
        failed: s.fail,
        retrieved: s.eff + s.fail,
      });
    }

    const flagged = flagLowReliabilitySources(repo);
    expect(flagged.flagged).toHaveLength(1);
    expect(flagged.flagged[0]!.createdBy).toBe("alice");

    // bob 不被标记（高 reliability）
    const bobEngram = repo.readEngram(createdIds.bob!);
    expect(bobEngram.verificationStatus).toBe("unverified");
  });
});
