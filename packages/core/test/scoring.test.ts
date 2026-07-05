import { describe, it, expect } from "vitest";
import {
  computeFourFactorScore,
  computeFourFactorScores,
  recencyDecay,
  truthFactorFromStatus,
  reciprocalRankFusion,
  validateWeights,
  DEFAULT_WEIGHTS,
  type FourFactorWeights,
} from "../src/retrieval/scoring.js";
import { deriveHalfLifeDays } from "../src/importance/dynamics.js";
import type { DigestLine } from "../src/index/types.js";

const DAY = 1000 * 60 * 60 * 24;

function makeLine(overrides: Partial<DigestLine> = {}): DigestLine {
  return {
    id: "test/id",
    title: "T",
    kind: "fact",
    kinds: ["fact"],
    summary: "S",
    domainTags: ["t"],
    contextTags: [],
    importance: 0.5,
    freshness: "fresh",
    status: "active",
    sourceType: "firsthand",
    createdBy: "y",
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    lastRetrievedAt: null,
    lastEffectiveAt: null,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0,
    contentSize: 10,
    contentHash: "",
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
    verificationStatus: null,
    ...overrides,
  };
}

// ============================================================
// validateWeights
// ============================================================

describe("validateWeights", () => {
  it("默认权重合法", () => {
    expect(() => validateWeights(DEFAULT_WEIGHTS)).not.toThrow();
  });

  it("和不等于 1 抛错", () => {
    expect(() =>
      validateWeights({ alpha: 0.5, beta: 0.3, gamma: 0.3, delta: 0.1 }),
    ).toThrow(/sum to 1/);
  });

  it("权重为负抛错", () => {
    expect(() =>
      validateWeights({ alpha: -0.1, beta: 0.5, gamma: 0.5, delta: 0.1 }),
    ).toThrow(/\[0,1\]/);
  });
});

// ============================================================
// recencyDecay
// ============================================================

describe("recencyDecay", () => {
  it("ageDays<=0 → 1(未来/刚发生)", () => {
    expect(recencyDecay(0, 0.5)).toBe(1);
    expect(recencyDecay(-10, 0.5)).toBe(1);
  });

  it("age=halfLife → 0.5(半衰期定义)", () => {
    const importance = 0.5;
    const halfLife = deriveHalfLifeDays(importance);
    expect(recencyDecay(halfLife, importance)).toBeCloseTo(0.5, 5);
  });

  it("age=2×halfLife → 0.25", () => {
    const importance = 0.5;
    const halfLife = deriveHalfLifeDays(importance);
    expect(recencyDecay(halfLife * 2, importance)).toBeCloseTo(0.25, 5);
  });

  it("age=3×halfLife → 0.125", () => {
    const importance = 0.5;
    const halfLife = deriveHalfLifeDays(importance);
    expect(recencyDecay(halfLife * 3, importance)).toBeCloseTo(0.125, 5);
  });

  it("高 importance → halflife 更长 → 同样 ageDays 下 recency 更高", () => {
    const ageDays = 30;
    expect(recencyDecay(ageDays, 0.9)).toBeGreaterThan(
      recencyDecay(ageDays, 0.1),
    );
  });
});

// ============================================================
// truthFactorFromStatus
// ============================================================

describe("truthFactorFromStatus", () => {
  it("verified → 1.0", () => {
    expect(truthFactorFromStatus("verified")).toBe(1.0);
  });

  it("probable → 0.7", () => {
    expect(truthFactorFromStatus("probable")).toBeCloseTo(0.7, 5);
  });

  it("plausible → 0.5", () => {
    expect(truthFactorFromStatus("plausible")).toBeCloseTo(0.5, 5);
  });

  it("unverified → 0.3", () => {
    expect(truthFactorFromStatus("unverified")).toBeCloseTo(0.3, 5);
  });

  it("refuted → 0(即使是高 importance 也得 0 分)", () => {
    expect(truthFactorFromStatus("refuted")).toBe(0);
  });

  it("null/undefined/未知 → 0.3(等同 unverified)", () => {
    expect(truthFactorFromStatus(null)).toBeCloseTo(0.3, 5);
    expect(truthFactorFromStatus(undefined)).toBeCloseTo(0.3, 5);
    expect(truthFactorFromStatus("garbage")).toBeCloseTo(0.3, 5);
  });
});

// ============================================================
// computeFourFactorScore
// ============================================================

describe("computeFourFactorScore", () => {
  it("默认权重 α=0.5 β=0.2 γ=0.2 δ=0.1", () => {
    expect(DEFAULT_WEIGHTS.alpha).toBe(0.5);
    expect(DEFAULT_WEIGHTS.beta).toBe(0.2);
    expect(DEFAULT_WEIGHTS.gamma).toBe(0.2);
    expect(DEFAULT_WEIGHTS.delta).toBe(0.1);
  });

  it("全 0 输入 + 久远 createdAt + refuted → 接近 0", () => {
    const line = makeLine({
      importance: 0,
      reinforcementScore: 0,
      lastEffectiveAt: null,
      verificationStatus: "refuted",
      createdAt: "1900-01-01T00:00:00Z",
    });
    expect(computeFourFactorScore(0, line)).toBeCloseTo(0, 3);
  });

  it("relevance=1 + 最近有效 + 高 importance + verified → 接近 1", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const importance = 0.9;
    const halfLife = deriveHalfLifeDays(importance);
    const line = makeLine({
      importance,
      reinforcementScore: 0,
      verificationStatus: "verified",
      lastEffectiveAt: new Date(now.getTime() - DAY).toISOString(),
    });
    const expectedRecency = Math.pow(0.5, 1 / halfLife);
    // truthFactor=1.0 → effImp = 0.9 × (0.3 + 0.7 × 1.0) = 0.9
    const expectedEffImp = 0.9 * (0.3 + 0.7 * 1.0);
    const expectedStrength = 0;
    const expected =
      0.5 * 1 +
      0.2 * expectedRecency +
      0.2 * expectedEffImp +
      0.1 * expectedStrength;
    expect(computeFourFactorScore(1, line, { now })).toBeCloseTo(
      expected,
      3,
    );
  });

  it("strength 维度独立于 importance:同 importance 但 reinforcementScore 不同 → 分数不同", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const baseLine = makeLine({
      importance: 0.5,
      reinforcementScore: 0,
      verificationStatus: "unverified",
      lastEffectiveAt: new Date(now.getTime() - DAY).toISOString(),
    });
    const reinforcedLine = makeLine({
      ...baseLine,
      reinforcementScore: 0.5,
      id: "reinforced",
    });
    const s1 = computeFourFactorScore(0.5, baseLine, { now });
    const s2 = computeFourFactorScore(0.5, reinforcedLine, { now });
    expect(s2).toBeGreaterThan(s1);
    // strength 贡献差 = 0.1 × (0.5 - 0) = 0.05
    expect(s2 - s1).toBeCloseTo(0.05, 3);
  });

  it("verificationStatus 提升时 effImp 增大,分数随之提升(truthFactor 约束)", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const unverifiedLine = makeLine({
      importance: 0.8,
      reinforcementScore: 0,
      verificationStatus: "unverified",
      lastEffectiveAt: new Date(now.getTime() - DAY).toISOString(),
    });
    const verifiedLine = makeLine({
      ...unverifiedLine,
      verificationStatus: "verified",
      id: "verified",
    });
    const s1 = computeFourFactorScore(0.5, unverifiedLine, { now });
    const s2 = computeFourFactorScore(0.5, verifiedLine, { now });
    expect(s2).toBeGreaterThan(s1);
  });

  it("权重可配置", () => {
    const line = makeLine({
      importance: 0.5,
      lastEffectiveAt: null,
      verificationStatus: "unverified",
    });
    const weights: FourFactorWeights = {
      alpha: 1,
      beta: 0,
      gamma: 0,
      delta: 0,
    };
    // 纯 relevance
    expect(computeFourFactorScore(0.7, line, { weights })).toBeCloseTo(
      0.7,
      3,
    );
  });

  it("同输入同输出(确定性)", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const line = makeLine({
      importance: 0.6,
      verificationStatus: "plausible",
      lastEffectiveAt: new Date(now.getTime() - 10 * DAY).toISOString(),
    });
    const s1 = computeFourFactorScore(0.7, line, { now });
    const s2 = computeFourFactorScore(0.7, line, { now });
    expect(s1).toBe(s2);
  });

  it("lastEffectiveAt=undefined 用 line.lastEffectiveAt", () => {
    const line = makeLine({ lastEffectiveAt: null });
    expect(computeFourFactorScore(0.5, line)).toBeGreaterThanOrEqual(0);
  });

  it("options.lastEffectiveAt 覆盖 line", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const line = makeLine({ lastEffectiveAt: null });
    const score = computeFourFactorScore(0.5, line, {
      now,
      lastEffectiveAt: new Date(now.getTime() - DAY).toISOString(),
    });
    // relevance=0.5 × 0.5 + recency>0 × 0.2 + effImp>0 × 0.2 + 0 × 0.1
    expect(score).toBeGreaterThan(0.5 * 0.5);
  });
});

// ============================================================
// computeFourFactorScores (批量)
// ============================================================

describe("computeFourFactorScores", () => {
  it("保持原数组顺序", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const items = [
      {
        id: "a",
        relevance: 0.9,
        line: makeLine({ id: "a", lastEffectiveAt: null }),
      },
      {
        id: "b",
        relevance: 0.5,
        line: makeLine({ id: "b", lastEffectiveAt: null }),
      },
    ];
    const result = computeFourFactorScores(items, { now });
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("高 relevance 得分更高", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const items = [
      { id: "low", relevance: 0.3, line: makeLine({ id: "low" }) },
      { id: "high", relevance: 0.9, line: makeLine({ id: "high" }) },
    ];
    const result = computeFourFactorScores(items, { now });
    const high = result.find((r) => r.id === "high")!.score;
    const low = result.find((r) => r.id === "low")!.score;
    expect(high).toBeGreaterThan(low);
  });
});

// ============================================================
// reciprocalRankFusion
// ============================================================

describe("reciprocalRankFusion", () => {
  it("单 list 输出按原顺序", () => {
    const rrf = reciprocalRankFusion([["a", "b", "c"]]);
    expect(rrf.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(rrf[0].score).toBeGreaterThan(rrf[1].score);
    expect(rrf[1].score).toBeGreaterThan(rrf[2].score);
  });

  it("两个 list 同时出现的 id 分数更高", () => {
    const rrf = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    const a = rrf.find((x) => x.id === "a")!.score;
    const b = rrf.find((x) => x.id === "b")!.score;
    const c = rrf.find((x) => x.id === "c")!.score;
    const d = rrf.find((x) => x.id === "d")!.score;
    expect(a).toBeCloseTo(b, 5);
    expect(a).toBeGreaterThan(c);
    expect(c).toBeCloseTo(d, 5);
  });

  it("同分稳定排序(按 id 字典序)", () => {
    const rrf = reciprocalRankFusion([["z", "a", "m"]]);
    expect(rrf[0].id).toBe("z");
    expect(rrf[1].id).toBe("a");
    expect(rrf[2].id).toBe("m");
  });

  it("空 list 返回空数组", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  it("k<=0 抛错", () => {
    expect(() => reciprocalRankFusion([["a"]], 0)).toThrow(/RRF k/);
    expect(() => reciprocalRankFusion([["a"]], -1)).toThrow(/RRF k/);
  });

  it("可自定义 k", () => {
    const rrf = reciprocalRankFusion([["a"]], 10);
    // 1 / (10 + 1) = 0.0909
    expect(rrf[0].score).toBeCloseTo(1 / 11, 5);
  });
});

// ============================================================
// 端到端:四因子 vs 纯 relevance
// ============================================================

describe("四因子 vs 纯 relevance(验收)", () => {
  it("近期高 importance 的 engram 优先于纯 relevance 高但陈旧的", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    // A: relevance=0.5,但近期有效,importance=0.9,verified
    const lineA = makeLine({
      id: "a",
      importance: 0.9,
      reinforcementScore: 0,
      verificationStatus: "verified",
      lastEffectiveAt: new Date(now.getTime() - DAY).toISOString(),
    });
    // B: relevance=0.9,但很久没用了,importance=0.3,unverified
    const lineB = makeLine({
      id: "b",
      importance: 0.3,
      reinforcementScore: 0,
      verificationStatus: "unverified",
      lastEffectiveAt: new Date(now.getTime() - 365 * DAY).toISOString(),
    });

    const scoreA = computeFourFactorScore(0.5, lineA, { now });
    const scoreB = computeFourFactorScore(0.9, lineB, { now });
    expect(scoreA).toBeGreaterThan(scoreB);
  });
});
