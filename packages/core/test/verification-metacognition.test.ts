import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  computeTruthScore,
  applyMetacognition,
  TRUTH_WEIGHTS,
  TRUTH_THRESHOLDS,
  TIME_STABLE_SATURATION_DAYS,
  CROSS_CONTEXT_SATURATION_DOMAINS,
  type TruthInput,
} from "../src/verification/metacognition.js";
import type { Engram } from "../src/types/engram.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-meta-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let engramCounter = 0;
function makeEngramInput(
  overrides: Partial<Parameters<EngramRepository["createEngram"]>[0]> = {},
) {
  engramCounter += 1;
  return {
    title: `T-${engramCounter}`,
    content: "C",
    kind: "fact" as const,
    domainTags: [`dev-${engramCounter}`],
    createdBy: "tester",
    ...overrides,
  };
}

function makeEngram(
  overrides: Partial<Parameters<EngramRepository["createEngram"]>[0]> = {},
): Engram {
  return repo.createEngram(makeEngramInput(overrides));
}

function makeInput(
  overrides: Partial<TruthInput> & { engram?: Engram } = {},
): TruthInput {
  return {
    engram: overrides.engram ?? makeEngram(),
    synapseStats: {
      extends: 0,
      consolidates: 0,
      contradicts: 0,
      derivesFrom: 0,
    },
    ageDays: 1,
    createdByReliability: 0.5,
    ...overrides,
  };
}

// ============================================================
// 权重和阈值
// ============================================================

describe("Metacognition - 权重和阈值", () => {
  it("权重和为 1.0（不含 executable）", () => {
    const sum =
      TRUTH_WEIGHTS.crossContext +
      TRUTH_WEIGHTS.timeStable +
      TRUTH_WEIGHTS.mutuallySupported +
      TRUTH_WEIGHTS.sourceReliable;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("executable 权重为 0（仅作门槛）", () => {
    expect(TRUTH_WEIGHTS.executable).toBe(0);
  });

  it("阈值合理", () => {
    expect(TRUTH_THRESHOLDS.upgradeVerifiedOverall).toBe(0.85);
    expect(TRUTH_THRESHOLDS.upgradeVerifiedMinAgeDays).toBe(7);
    expect(TRUTH_THRESHOLDS.upgradeOneLevelOverall).toBe(0.7);
    expect(TRUTH_THRESHOLDS.refuteOverall).toBe(0.3);
  });

  it("饱和常量", () => {
    expect(TIME_STABLE_SATURATION_DAYS).toBe(30);
    expect(CROSS_CONTEXT_SATURATION_DOMAINS).toBe(2);
  });
});

// ============================================================
// 五维度独立测试
// ============================================================

describe("Metacognition - 五维度", () => {
  it("crossContext：domains=0 → 0", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: [] }),
      }),
    );
    expect(score.dimensions.crossContext).toBe(0);
  });

  it("crossContext：domains=2 → 1（饱和）", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a", "b"] }),
      }),
    );
    expect(score.dimensions.crossContext).toBe(1);
  });

  it("crossContext：domains=1 → 0.5", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a"] }),
      }),
    );
    expect(score.dimensions.crossContext).toBeCloseTo(0.5, 5);
  });

  it("crossContext：domains=5 → clamp 到 1", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a", "b", "c", "d", "e"] }),
      }),
    );
    expect(score.dimensions.crossContext).toBe(1);
  });

  it("timeStable：ageDays=0 → 0", () => {
    const score = computeTruthScore(makeInput({ ageDays: 0 }));
    expect(score.dimensions.timeStable).toBe(0);
  });

  it("timeStable：ageDays=15 → 0.5", () => {
    const score = computeTruthScore(makeInput({ ageDays: 15 }));
    expect(score.dimensions.timeStable).toBeCloseTo(0.5, 5);
  });

  it("timeStable：ageDays=30 → 1（饱和）", () => {
    const score = computeTruthScore(makeInput({ ageDays: 30 }));
    expect(score.dimensions.timeStable).toBe(1);
  });

  it("timeStable：ageDays=100 → clamp 到 1", () => {
    const score = computeTruthScore(makeInput({ ageDays: 100 }));
    expect(score.dimensions.timeStable).toBe(1);
  });

  it("mutuallySupported：无 synapse → 0.5（中性）", () => {
    const score = computeTruthScore(
      makeInput({
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 0,
          derivesFrom: 0,
        },
      }),
    );
    expect(score.dimensions.mutuallySupported).toBe(0.5);
  });

  it("mutuallySupported：全是 extends → 1", () => {
    const score = computeTruthScore(
      makeInput({
        synapseStats: {
          extends: 3,
          consolidates: 0,
          contradicts: 0,
          derivesFrom: 0,
        },
      }),
    );
    expect(score.dimensions.mutuallySupported).toBe(1);
  });

  it("mutuallySupported：全是 contradicts → 0", () => {
    const score = computeTruthScore(
      makeInput({
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 3,
          derivesFrom: 0,
        },
      }),
    );
    expect(score.dimensions.mutuallySupported).toBe(0);
  });

  it("mutuallySupported：extends + consolidates vs contradicts 比例", () => {
    const score = computeTruthScore(
      makeInput({
        synapseStats: {
          extends: 2,
          consolidates: 2,
          contradicts: 4,
          derivesFrom: 0,
        },
      }),
    );
    // (2+2) / (2+2+4) = 0.5
    expect(score.dimensions.mutuallySupported).toBeCloseTo(0.5, 5);
  });

  it("sourceReliable：默认 0.5", () => {
    const score = computeTruthScore(
      makeInput({ createdByReliability: undefined }),
    );
    expect(score.dimensions.sourceReliable).toBe(0.5);
  });

  it("sourceReliable：高可靠来源 → 接近 1", () => {
    const score = computeTruthScore(makeInput({ createdByReliability: 0.9 }));
    expect(score.dimensions.sourceReliable).toBe(0.9);
  });

  it("executable：非 procedure kind → 0.5（默认）", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ kind: "fact" }),
      }),
    );
    expect(score.dimensions.executable).toBe(0.5);
  });

  it("executable：procedure kind → 0.7", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ kind: "procedure" }),
      }),
    );
    expect(score.dimensions.executable).toBe(0.7);
  });
});

// ============================================================
// overall 综合
// ============================================================

describe("Metacognition - overall", () => {
  it("overall 在 [0, 1]", () => {
    for (const domains of [0, 1, 2, 5]) {
      for (const age of [0, 7, 30, 100]) {
        for (const ext of [0, 1, 5]) {
          for (const con of [0, 1, 5]) {
            const score = computeTruthScore(
              makeInput({
                engram: makeEngram({
                  domainTags: Array.from(
                    { length: domains },
                    (_, i) => `d${i}`,
                  ),
                }),
                ageDays: age,
                synapseStats: {
                  extends: ext,
                  consolidates: 0,
                  contradicts: con,
                  derivesFrom: 0,
                },
                createdByReliability: 0.5,
              }),
            );
            expect(score.overall).toBeGreaterThanOrEqual(0);
            expect(score.overall).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("全维度高 → overall 接近 1", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a", "b", "c"], kind: "procedure" }),
        ageDays: 60,
        synapseStats: {
          extends: 5,
          consolidates: 3,
          contradicts: 0,
          derivesFrom: 1,
        },
        createdByReliability: 0.95,
      }),
    );
    expect(score.overall).toBeGreaterThan(0.85);
  });

  it("全维度低 → overall 低", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: [], kind: "fact" }),
        ageDays: 0,
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 0,
          derivesFrom: 0,
        },
        createdByReliability: 0.1,
      }),
    );
    // cross=0, time=0, mutual=0.5, source=0.1
    // overall = 0 + 0 + 0.25*0.5 + 0.2*0.1 = 0.145
    expect(score.overall).toBeLessThan(0.2);
  });
});

// ============================================================
// recommendation
// ============================================================

describe("Metacognition - recommendation", () => {
  it("overall ≥ 0.85 且 age ≥ 7 → upgrade_verified", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a", "b", "c"] }),
        ageDays: 30,
        synapseStats: {
          extends: 5,
          consolidates: 3,
          contradicts: 0,
          derivesFrom: 1,
        },
        createdByReliability: 0.95,
      }),
    );
    expect(score.overall).toBeGreaterThanOrEqual(0.85);
    expect(score.recommendation).toBe("upgrade_verified");
  });

  it("overall ≥ 0.85 但 age < 7 → upgrade_one_level", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a", "b", "c"] }),
        ageDays: 3,
        synapseStats: {
          extends: 5,
          consolidates: 3,
          contradicts: 0,
          derivesFrom: 1,
        },
        createdByReliability: 1.0,
      }),
    );
    // cross=1, time=0.1, mutual=1, source=1
    // overall = 0.3 + 0.025 + 0.25 + 0.2 = 0.775
    expect(score.overall).toBeGreaterThanOrEqual(0.7);
    expect(score.overall).toBeLessThan(0.85);
    expect(score.recommendation).toBe("upgrade_one_level");
  });

  it("0.7 ≤ overall < 0.85 → upgrade_one_level", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a"] }),
        ageDays: 30,
        synapseStats: {
          extends: 2,
          consolidates: 1,
          contradicts: 0,
          derivesFrom: 0,
        },
        createdByReliability: 0.7,
      }),
    );
    // cross=0.5, time=1, mutual=1, source=0.7
    // overall = 0.15 + 0.25 + 0.25 + 0.14 = 0.79
    expect(score.overall).toBeGreaterThanOrEqual(0.7);
    expect(score.overall).toBeLessThan(0.85);
    expect(score.recommendation).toBe("upgrade_one_level");
  });

  it("overall < 0.3 且有 contradicts → refute", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: [] }),
        ageDays: 0,
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 2,
          derivesFrom: 0,
        },
        createdByReliability: 0.1,
      }),
    );
    expect(score.overall).toBeLessThan(0.3);
    expect(score.recommendation).toBe("refute");
  });

  it("overall < 0.3 但无 contradicts → hold（不贸然 refute）", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: [] }),
        ageDays: 0,
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 0,
          derivesFrom: 0,
        },
        createdByReliability: 0.1,
      }),
    );
    expect(score.overall).toBeLessThan(0.3);
    expect(score.recommendation).toBe("hold");
  });

  it("中等分（0.3-0.7）→ hold", () => {
    const score = computeTruthScore(
      makeInput({
        engram: makeEngram({ domainTags: ["a"] }),
        ageDays: 15,
        synapseStats: {
          extends: 0,
          consolidates: 0,
          contradicts: 0,
          derivesFrom: 0,
        },
        createdByReliability: 0.5,
      }),
    );
    expect(score.overall).toBeGreaterThanOrEqual(0.3);
    expect(score.overall).toBeLessThan(0.7);
    expect(score.recommendation).toBe("hold");
  });
});

// ============================================================
// applyMetacognition 写库
// ============================================================

describe("Metacognition - applyMetacognition", () => {
  it("recommendation=hold → 不动 status", async () => {
    const engram = makeEngram({ domainTags: ["a"] });
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 0.5,
    });
    expect(result.applied).toBe(false);
    expect(result.newStatus).toBeUndefined();
    const after = repo.readEngram(engram.id);
    expect(after.verificationStatus).toBe("unverified");
  });

  it("recommendation=upgrade_one_level → unverified → plausible", async () => {
    const engram = makeEngram({ domainTags: ["a", "b", "c"] });
    // 加一个 extends synapse 让 mutualSupported=1
    const other = makeEngram({ domainTags: ["ext-domain"] });
    repo.addOutgoingSynapse(engram.id, {
      id: "ext-1",
      from: engram.id,
      to: other.id,
      kind: "extends",
      weight: 1,
      state: "active",
      evidence: [],
      createdAt: new Date().toISOString(),
    });
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 1.0,
      ageDays: 3, // cross=1, time=0.1, mutual=1, source=1 → overall=0.775
    });
    expect(result.score.recommendation).toBe("upgrade_one_level");
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("plausible");
    const after = repo.readEngram(engram.id);
    expect(after.verificationStatus).toBe("unverified"); // REM 审批化:不直接落盘;
  });

  it("recommendation=upgrade_verified → verified", async () => {
    const engram = makeEngram({ domainTags: ["a", "b", "c"] });
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 0.95,
      ageDays: 30, // timeStable=1,overall ≈ 0.99
    });
    expect(result.score.recommendation).toBe("upgrade_verified");
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("verified");
    const after = repo.readEngram(engram.id);
    expect(after.verificationStatus).toBe("unverified"); // REM 审批化:不直接落盘;
  });

  it("recommendation=refute → refuted", async () => {
    const engram = makeEngram({ domainTags: [] });
    const other = makeEngram({ title: "other", domainTags: ["other"] });
    repo.addOutgoingSynapse(other.id, {
      id: "syn-1",
      from: other.id,
      to: engram.id,
      kind: "contradicts",
      weight: 1,
      state: "active",
      evidence: [],
      createdAt: new Date().toISOString(),
    });
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 0.1,
      ageDays: 0,
    });
    expect(result.score.recommendation).toBe("refute");
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("refuted");
  });

  it("hold → 不动 status", async () => {
    const engram = makeEngram({ domainTags: ["a"] });
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 0.5,
      ageDays: 15, // 0.5*0.5+0.5*0.25+0.5*0.25+0.5*0.2 = 0.475,hold
    });
    expect(result.score.recommendation).toBe("hold");
    expect(result.applied).toBe(false);
    const after = repo.readEngram(engram.id);
    expect(after.verificationStatus).toBe("unverified");
  });

  it("已 verified + recommendation=upgrade_verified → 保持 verified（幂等,applied=false）", async () => {
    const engram = makeEngram({ domainTags: ["a", "b", "c"] });
    repo.updateVerificationStatus(engram.id, "verified");
    const result = await applyMetacognition(repo, engram.id, {
      createdByReliability: 0.95,
      ageDays: 30,
    });
    expect(result.score.recommendation).toBe("upgrade_verified");
    // 已 verified,无需再动（幂等）
    expect(result.applied).toBe(false);
    expect(result.newStatus).toBeUndefined(); // 已 verified,无需再升
    const after = repo.readEngram(engram.id);
    expect(after.verificationStatus).toBe("verified"); // 已 verified,REM 不改(审批化)
  });

  it("engram 不存在 → 抛错", async () => {
    await expect(applyMetacognition(repo, "nonexistent")).rejects.toThrow();
  });

  it("reasoning 字段非空", async () => {
    const engram = makeEngram();
    const result = await applyMetacognition(repo, engram.id);
    expect(result.score.reasoning).toBeTruthy();
    expect(result.score.reasoning).toContain("overall=");
  });

  it("synapse 统计正确读取（outgoing + incoming）", async () => {
    const a = makeEngram({ title: "A", domainTags: ["a"] });
    const b = makeEngram({ title: "B", domainTags: ["b"] });
    // a → b extends（a 的 outgoing）
    repo.addOutgoingSynapse(a.id, {
      id: "s1",
      from: a.id,
      to: b.id,
      kind: "extends",
      weight: 1,
      state: "active",
      evidence: [],
      createdAt: new Date().toISOString(),
    });
    // a → b consolidates
    repo.addOutgoingSynapse(a.id, {
      id: "s2",
      from: a.id,
      to: b.id,
      kind: "consolidates",
      weight: 1,
      state: "active",
      evidence: [],
      createdAt: new Date().toISOString(),
    });

    // 对 b 调用 metacognition：incoming 应有 2 个支持
    const result = await applyMetacognition(repo, b.id, {
      createdByReliability: 0.5,
      ageDays: 1,
    });
    // mutuallySupported 应为 1（全是 extends+consolidates）
    expect(result.score.dimensions.mutuallySupported).toBe(1);
  });
});
