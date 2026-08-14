import { describe, it, expect } from "vitest";
import {
  computeFourFactorScore,
  computeFiveFactorScore,
  computeHotness,
  computeFourFactorScores,
  recencyDecay,
  truthFactorFromStatus,
  reciprocalRankFusion,
  scoringConfigToWeights,
  validateWeights,
  DEFAULT_HOTNESS_HALF_LIFE_DAYS,
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
// computeHotness(P0-2:OpenViking hotness 移植)
// ============================================================

describe("computeHotness", () => {
  const NOW = new Date("2026-08-15T00:00:00Z");

  it("从未被检索(lastRetrievedAt=null)→ 0,不加权", () => {
    expect(computeHotness(0, null, { now: NOW })).toBe(0);
    expect(computeHotness(10, undefined, { now: NOW })).toBe(0);
    expect(computeHotness(0, NOW.toISOString(), { now: NOW })).toBe(0);
  });

  it("count=1 + 刚访问 → sigmoid(ln2) ≈ 0.667", () => {
    const h = computeHotness(1, NOW.toISOString(), { now: NOW });
    expect(h).toBeCloseTo(1 / (1 + Math.exp(-Math.log1p(1))), 5);
    expect(h).toBeCloseTo(0.667, 2);
  });

  it("对数压缩防刷:count 10→100 只提升 ~0.07", () => {
    const h10 = computeHotness(10, NOW.toISOString(), { now: NOW });
    const h100 = computeHotness(100, NOW.toISOString(), { now: NOW });
    expect(h10).toBeGreaterThan(0.9);
    expect(h100 - h10).toBeLessThan(0.08);
  });

  it("7 天半衰期:age=7d → 频次项减半;age=14d → 四分之一", () => {
    const iso = (daysAgo: number) =>
      new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    const freq = 1 / (1 + Math.exp(-Math.log1p(5)));
    expect(computeHotness(5, iso(7), { now: NOW })).toBeCloseTo(
      freq * 0.5,
      5,
    );
    expect(computeHotness(5, iso(14), { now: NOW })).toBeCloseTo(
      freq * 0.25,
      5,
    );
  });

  it("半衰期可配置:halfLifeDays=1 时 1 天前 → 减半", () => {
    const iso = new Date(NOW.getTime() - DAY).toISOString();
    const freq = 1 / (1 + Math.exp(-Math.log1p(5)));
    expect(computeHotness(5, iso, { now: NOW, halfLifeDays: 1 })).toBeCloseTo(
      freq * 0.5,
      5,
    );
  });

  it("默认半衰期为 7 天", () => {
    expect(DEFAULT_HOTNESS_HALF_LIFE_DAYS).toBe(7);
  });

  it("非法 lastRetrievedAt → 0(NaN 防御)", () => {
    expect(computeHotness(5, "not-a-date", { now: NOW })).toBe(0);
  });
});

// ============================================================
// computeFiveFactorScore hotness 因子(P0-2)
// ============================================================

describe("computeFiveFactorScore hotness", () => {
  const NOW = new Date("2026-08-15T00:00:00Z");

  it("同基础条件下,被频繁访问的记忆分数更高(访问抬升排序)", () => {
    const base = {
      importance: 0.5,
      reinforcementScore: 0,
      verificationStatus: null,
      createdAt: NOW.toISOString(),
      lastEffectiveAt: null,
    };
    const never = makeLine({ ...base, id: "never" });
    const accessed = makeLine({
      ...base,
      id: "accessed",
      retrievalCount: 10,
      lastRetrievedAt: NOW.toISOString(),
    });
    const s1 = computeFiveFactorScore(0.5, never, { now: NOW });
    const s2 = computeFiveFactorScore(0.5, accessed, { now: NOW });
    expect(s2).toBeGreaterThan(s1);
    // hotness 贡献 = ε(0.05) × sigmoid(ln(1+10)) ≈ 0.05 × 0.917 ≈ 0.046
    expect(s2 - s1).toBeCloseTo(
      0.05 * (1 / (1 + Math.exp(-Math.log1p(10)))),
      3,
    );
  });

  it("7 天前的访问基本衰减殆尽(14 天 → 频次项 × 0.25)", () => {
    const base = {
      importance: 0.5,
      reinforcementScore: 0,
      verificationStatus: null,
      createdAt: NOW.toISOString(),
      lastEffectiveAt: null,
      retrievalCount: 10,
    };
    const fresh = makeLine({
      ...base,
      id: "fresh",
      lastRetrievedAt: NOW.toISOString(),
    });
    const stale = makeLine({
      ...base,
      id: "stale",
      lastRetrievedAt: new Date(NOW.getTime() - 14 * DAY).toISOString(),
    });
    const sFresh = computeFiveFactorScore(0.5, fresh, { now: NOW });
    const sStale = computeFiveFactorScore(0.5, stale, { now: NOW });
    expect(sFresh - sStale).toBeCloseTo(0.05 * 0.917 * 0.75, 2);
  });

  it("epsilon=0(显式关闭)→ hotness 不参与排序", () => {
    const base = {
      importance: 0.5,
      reinforcementScore: 0,
      verificationStatus: null,
      createdAt: NOW.toISOString(),
      lastEffectiveAt: null,
    };
    const never = makeLine({ ...base, id: "never" });
    const accessed = makeLine({
      ...base,
      id: "accessed",
      retrievalCount: 10,
      lastRetrievedAt: NOW.toISOString(),
    });
    const w = { alpha: 0.5, beta: 0.15, gamma: 0.25, delta: 0.1, epsilon: 0 };
    const s1 = computeFiveFactorScore(0.5, never, { now: NOW, weights: w });
    const s2 = computeFiveFactorScore(0.5, accessed, { now: NOW, weights: w });
    expect(s1).toBeCloseTo(s2, 10);
  });
});

// ============================================================
// scoringConfigToWeights hotness 兼容规则(P0-2)
// ============================================================

describe("scoringConfigToWeights hotness", () => {
  it("空 config → δ=0.05 / ε=0.05(与 DEFAULT_WEIGHTS 一致)", () => {
    expect(scoringConfigToWeights({})).toEqual(DEFAULT_WEIGHTS);
  });

  it("老四项配置(strength=0.1,和=1)→ 对半拆分 δ=0.05 / ε=0.05,和仍为 1", () => {
    const w = scoringConfigToWeights({
      relevance: 0.5,
      recency: 0.15,
      importance: 0.25,
      strength: 0.1,
    });
    expect(w.delta).toBeCloseTo(0.05, 5);
    expect(w.epsilon).toBeCloseTo(0.05, 5);
    expect(() => validateWeights(w)).not.toThrow();
  });

  it("显式配置 hotness → 按显式值,strength 缺省 0.05(其余项需重平衡使和=1)", () => {
    const w = scoringConfigToWeights({
      relevance: 0.5,
      recency: 0.1,
      importance: 0.25,
      hotness: 0.1,
    });
    expect(w.delta).toBeCloseTo(0.05, 5);
    expect(w.epsilon).toBeCloseTo(0.1, 5);
  });

  it("显式配置 hotness=0 → 完全关闭访问热度", () => {
    const w = scoringConfigToWeights({
      relevance: 0.5,
      recency: 0.15,
      importance: 0.25,
      strength: 0.1,
      hotness: 0,
    });
    expect(w.epsilon).toBe(0);
    expect(w.delta).toBeCloseTo(0.1, 5);
    expect(() => validateWeights(w)).not.toThrow();
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
  it("默认权重 α=0.5 β=0.15 γ=0.25 δ=0.05 ε=0.05(2026-08 P0-2:strength 拆分出 hotness)", () => {
    expect(DEFAULT_WEIGHTS.alpha).toBe(0.5);
    expect(DEFAULT_WEIGHTS.beta).toBe(0.15);
    expect(DEFAULT_WEIGHTS.gamma).toBe(0.25);
    expect(DEFAULT_WEIGHTS.delta).toBe(0.05);
    expect(DEFAULT_WEIGHTS.epsilon).toBe(0.05);
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
    const expectedHotness = 0; // lastRetrievedAt=null → hotness=0
    const expected =
      0.5 * 1 +
      0.15 * expectedRecency +
      0.25 * expectedEffImp +
      0.05 * expectedStrength +
      0.05 * expectedHotness;
    expect(computeFourFactorScore(1, line, { now })).toBeCloseTo(expected, 3);
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
    // strength 贡献差 = 0.05 × (0.5 - 0) = 0.025(P0-2 后 δ 从 0.1 拆为 0.05+0.05)
    expect(s2 - s1).toBeCloseTo(0.025, 3);
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
    expect(computeFourFactorScore(0.7, line, { weights })).toBeCloseTo(0.7, 3);
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
