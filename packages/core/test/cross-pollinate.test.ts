import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  LocalHeuristicCrossPollinationProvider,
  computeDomainProfile,
  computeStructuralSimilarity,
  findCrossDomainCandidates,
  crossPollinate,
  crossPollinateBatch,
  type CrossPollinationProvider,
  type CrossPollinationProviderInput,
  type CrossPollinationProviderOutput,
} from "../src/generative/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-cross-"));
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
  importance?: number;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["t"],
    importance: input.importance ?? 0.5,
    createdBy: "tester",
  });
}

function addSynapse(
  fromId: string,
  toId: string,
  kind: "extends" | "depends_on" | "similar_to" | "causes" | "derives_from",
): void {
  repo.addOutgoingSynapse(fromId, {
    id: `syn-${fromId}-${toId}-${kind}-${Math.random().toString(36).slice(2, 6)}`,
    from: fromId,
    to: toId,
    kind,
    weight: 0.5,
    direction: "directional",
    evidence: [],
    createdBy: "tester",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.5,
  });
}

/** Stub provider */
class StubProvider implements CrossPollinationProvider {
  constructor(private readonly output: CrossPollinationProviderOutput) {}
  generate(
    _input: CrossPollinationProviderInput,
  ): CrossPollinationProviderOutput {
    return this.output;
  }
}

// ============================================================
// computeDomainProfile
// ============================================================

describe("computeDomainProfile", () => {
  it("domain 不存在 → null", () => {
    expect(computeDomainProfile(repo, "nobody")).toBeNull();
  });

  it("正确统计 engram 数量与 kind 分布", () => {
    makeEngram({ title: "a", kind: "observation", domainTags: ["android"] });
    makeEngram({ title: "b", kind: "observation", domainTags: ["android"] });
    makeEngram({ title: "c", kind: "fact", domainTags: ["android"] });

    const p = computeDomainProfile(repo, "android")!;
    expect(p.domain).toBe("android");
    expect(p.engramCount).toBe(3);
    expect(p.kindDistribution.observation).toBe(2);
    expect(p.kindDistribution.fact).toBe(1);
  });

  it("统计 outgoing synapses", () => {
    const a = makeEngram({ title: "a", domainTags: ["x"] });
    const b = makeEngram({ title: "b", domainTags: ["x"] });
    const c = makeEngram({ title: "c", domainTags: ["x"] });
    addSynapse(a.id, b.id, "extends");
    addSynapse(a.id, c.id, "extends");
    addSynapse(b.id, c.id, "similar_to");

    const p = computeDomainProfile(repo, "x")!;
    expect(p.synapseDistribution.extends).toBe(2);
    expect(p.synapseDistribution.similar_to).toBe(1);
  });

  it("计算平均 importance / confidence", () => {
    makeEngram({ title: "a", domainTags: ["x"], importance: 0.6 });
    makeEngram({ title: "b", domainTags: ["x"], importance: 0.8 });

    const p = computeDomainProfile(repo, "x")!;
    expect(p.avgImportance).toBeCloseTo(0.7, 6);
  });

  it("跨 domain 的 engram 不被统计", () => {
    makeEngram({ title: "a", kind: "observation", domainTags: ["android"] });
    makeEngram({ title: "b", kind: "fact", domainTags: ["ios"] });

    const android = computeDomainProfile(repo, "android")!;
    expect(android.engramCount).toBe(1);
    expect(android.kindDistribution.fact).toBe(0);

    const ios = computeDomainProfile(repo, "ios")!;
    expect(ios.kindDistribution.fact).toBe(1);
  });
});

// ============================================================
// computeStructuralSimilarity
// ============================================================

describe("computeStructuralSimilarity", () => {
  it("完全相同的分布 → similarity=1", () => {
    const p1 = computeDomainProfile(repo, "x")!;
    void p1;
    // 构造两个 profile（手工）
    const a = makeProfile({ extends: 4, similar_to: 2 });
    const b = makeProfile({ extends: 4, similar_to: 2 });
    expect(computeStructuralSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("完全不同的分布 → similarity=0", () => {
    const a = makeProfile({ extends: 4 });
    const b = makeProfile({ similar_to: 4 });
    expect(computeStructuralSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("部分重叠 → 0 < sim < 1", () => {
    const a = makeProfile({ extends: 3, similar_to: 1 });
    const b = makeProfile({ extends: 1, similar_to: 3 });
    const sim = computeStructuralSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("大小不同的 domain（归一化后相似）", () => {
    const a = makeProfile({ extends: 4, similar_to: 2 }); // 6 总
    const b = makeProfile({ extends: 8, similar_to: 4 }); // 12 总
    // 归一化后比例相同 → similarity 应为 1
    expect(computeStructuralSimilarity(a, b)).toBeCloseTo(1, 6);
  });
});

// ============================================================
// findCrossDomainCandidates
// ============================================================

describe("findCrossDomainCandidates", () => {
  it("返回相似度 ≥ threshold 的 domain 对", () => {
    // android + ios 同结构（都 extends 主导）
    const a1 = makeEngram({ title: "a1", domainTags: ["android"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["android"] });
    addSynapse(a1.id, a2.id, "extends");
    const i1 = makeEngram({ title: "i1", domainTags: ["ios"] });
    const i2 = makeEngram({ title: "i2", domainTags: ["ios"] });
    addSynapse(i1.id, i2.id, "extends");

    const candidates = findCrossDomainCandidates(repo);
    expect(candidates.length).toBeGreaterThan(0);
    const pair = candidates.find(
      (c) =>
        (c.domainA === "android" && c.domainB === "ios") ||
        (c.domainA === "ios" && c.domainB === "android"),
    );
    expect(pair).toBeDefined();
    expect(pair!.similarity).toBeGreaterThan(0.5);
  });

  it("不同结构 → 不出现在候选中", () => {
    // android 全 extends，ios 全 similar_to
    const a1 = makeEngram({ title: "a1", domainTags: ["android"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["android"] });
    addSynapse(a1.id, a2.id, "extends");
    const i1 = makeEngram({ title: "i1", domainTags: ["ios"] });
    const i2 = makeEngram({ title: "i2", domainTags: ["ios"] });
    addSynapse(i1.id, i2.id, "similar_to");

    const candidates = findCrossDomainCandidates(repo, { threshold: 0.5 });
    const pair = candidates.find(
      (c) =>
        (c.domainA === "android" && c.domainB === "ios") ||
        (c.domainA === "ios" && c.domainB === "android"),
    );
    expect(pair).toBeUndefined();
  });

  it("按相似度降序", () => {
    const a1 = makeEngram({ title: "a1", domainTags: ["a"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["a"] });
    addSynapse(a1.id, a2.id, "extends");
    const b1 = makeEngram({ title: "b1", domainTags: ["b"] });
    const b2 = makeEngram({ title: "b2", domainTags: ["b"] });
    addSynapse(b1.id, b2.id, "extends");
    const c1 = makeEngram({ title: "c1", domainTags: ["c"] });
    const c2 = makeEngram({ title: "c2", domainTags: ["c"] });
    addSynapse(c1.id, c2.id, "similar_to");

    const candidates = findCrossDomainCandidates(repo, { threshold: 0.0 });
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.similarity).toBeLessThanOrEqual(
        candidates[i - 1]!.similarity,
      );
    }
  });

  it("minEngramsPerDomain 过滤小 domain", () => {
    makeEngram({ title: "a1", domainTags: ["big"] });
    makeEngram({ title: "a2", domainTags: ["big"] });
    makeEngram({ title: "a3", domainTags: ["big"] });
    makeEngram({ title: "solo", domainTags: ["solo"] }); // 只有 1 个

    const candidates = findCrossDomainCandidates(repo, {
      threshold: 0,
      minEngramsPerDomain: 2,
    });
    expect(
      candidates.find((c) => c.domainA === "solo" || c.domainB === "solo"),
    ).toBeUndefined();
  });
});

// ============================================================
// crossPollinate
// ============================================================

describe("crossPollinate", () => {
  it("domain A 无 engram → 空结果", async () => {
    const result = await crossPollinate(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      {
        domainA: "nobody",
        domainB: "android",
        createdBy: "tester",
      },
    );
    expect(result.analogy).toBeNull();
    expect(result.adopted).toBe(false);
    expect(result.reason).toMatch(/no active engrams/);
  });

  it("结构相似 → 生成类比", async () => {
    const a1 = makeEngram({ title: "a1", domainTags: ["android"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["android"] });
    addSynapse(a1.id, a2.id, "extends");
    const i1 = makeEngram({ title: "i1", domainTags: ["ios"] });
    const i2 = makeEngram({ title: "i2", domainTags: ["ios"] });
    addSynapse(i1.id, i2.id, "extends");

    const result = await crossPollinate(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      {
        domainA: "android",
        domainB: "ios",
        createdBy: "tester",
      },
    );

    expect(result.analogy).not.toBeNull();
    expect(result.structuralSimilarity).toBeGreaterThan(0.5);
    expect(result.analogy!.analogy).toMatch(/android.*ios|ios.*android/);
  });

  it("createHypothesis=true 且 confidence ≥ threshold → 创建 engram", async () => {
    const a1 = makeEngram({ title: "a1", domainTags: ["android"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["android"] });
    addSynapse(a1.id, a2.id, "extends");
    const i1 = makeEngram({ title: "i1", domainTags: ["ios"] });
    const i2 = makeEngram({ title: "i2", domainTags: ["ios"] });
    addSynapse(i1.id, i2.id, "extends");

    const result = await crossPollinate(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      {
        domainA: "android",
        domainB: "ios",
        createdBy: "tester",
        createHypothesis: true,
        autoAdoptionThreshold: 0.5,
      },
    );

    expect(result.adopted).toBe(true);
    expect(result.engramId).not.toBeNull();
    const e = repo.readEngram(result.engramId!);
    expect(e.kind).toBe("hypothesis");
    expect(e.domainTags).toEqual(["android", "ios"]);
    expect(e.verificationStatus).toBe("unverified");
  });

  it("createHypothesis=false → 不创建 engram", async () => {
    const a1 = makeEngram({ title: "a1", domainTags: ["x"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["x"] });
    addSynapse(a1.id, a2.id, "extends");
    const b1 = makeEngram({ title: "b1", domainTags: ["y"] });
    const b2 = makeEngram({ title: "b2", domainTags: ["y"] });
    addSynapse(b1.id, b2.id, "extends");

    const result = await crossPollinate(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      {
        domainA: "x",
        domainB: "y",
        createdBy: "tester",
        createHypothesis: false,
      },
    );

    expect(result.adopted).toBe(false);
    expect(result.engramId).toBeNull();
  });

  it("注入自定义 Provider → 使用其输出", async () => {
    const a1 = makeEngram({ title: "a1", domainTags: ["x"] });
    const a2 = makeEngram({ title: "a2", domainTags: ["x"] });
    addSynapse(a1.id, a2.id, "extends");
    const b1 = makeEngram({ title: "b1", domainTags: ["y"] });
    const b2 = makeEngram({ title: "b2", domainTags: ["y"] });
    addSynapse(b1.id, b2.id, "extends");

    const stub = new StubProvider({
      analogy: "自定义类比",
      sharedPrinciple: "共同原理",
      confidence: 0.9,
      reason: "stub",
    });

    const result = await crossPollinate(repo, stub, {
      domainA: "x",
      domainB: "y",
      createdBy: "tester",
      createHypothesis: true,
    });

    expect(result.analogy!.analogy).toBe("自定义类比");
    expect(result.adopted).toBe(true);
  });
});

// ============================================================
// crossPollinateBatch
// ============================================================

describe("crossPollinateBatch", () => {
  it("批量处理所有候选 pair", async () => {
    // 3 个 domain，互相相似（都 extends 主导）
    const domains = ["a", "b", "c"];
    for (const d of domains) {
      const e1 = makeEngram({ title: `${d}1`, domainTags: [d] });
      const e2 = makeEngram({ title: `${d}2`, domainTags: [d] });
      addSynapse(e1.id, e2.id, "extends");
    }

    const { candidates, results } = await crossPollinateBatch(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      {
        createdBy: "tester",
        threshold: 0.5,
      },
    );

    // 3 个 domain 两两组合 = 3 对
    expect(candidates.length).toBe(3);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.analogy).not.toBeNull();
    }
  });

  it("无候选 → 空结果", async () => {
    makeEngram({ title: "a", domainTags: ["a"] }); // 单个 engram，无法形成 pair
    const { candidates, results } = await crossPollinateBatch(
      repo,
      new LocalHeuristicCrossPollinationProvider(),
      { createdBy: "tester" },
    );
    expect(candidates).toEqual([]);
    expect(results).toEqual([]);
  });
});

// ============================================================
// LocalHeuristicCrossPollinationProvider
// ============================================================

describe("LocalHeuristicCrossPollinationProvider", () => {
  it("相似度 < threshold → 输出低 confidence", () => {
    const p = new LocalHeuristicCrossPollinationProvider();
    const out = p.generate({
      domainA: "x",
      profileA: makeProfile({ extends: 4 }),
      domainB: "y",
      profileB: makeProfile({ similar_to: 4 }),
      structuralSimilarity: 0.2,
      sampleEngramsA: [],
      sampleEngramsB: [],
    });
    expect(out.confidence).toBe(0.2);
    expect(out.analogy).toMatch(/不足/);
  });

  it("相似度 ≥ threshold 且主导 kind 相同 → 强类比", () => {
    const p = new LocalHeuristicCrossPollinationProvider();
    const out = p.generate({
      domainA: "android",
      profileA: makeProfile({ extends: 5, similar_to: 1 }),
      profileB: makeProfile({ extends: 5, similar_to: 1 }),
      domainB: "ios",
      structuralSimilarity: 1.0,
      sampleEngramsA: [{ title: "a", content: "a" }],
      sampleEngramsB: [{ title: "b", content: "b" }],
    });
    expect(out.analogy).toMatch(/结构同构/);
    expect(out.sharedPrinciple).toMatch(/extends/);
  });
});

// ============================================================
// 辅助函数
// ============================================================

function makeProfile(
  synDist: Partial<
    Record<import("../src/types/synapse.js").SynapseKind, number>
  >,
): ReturnType<typeof computeDomainProfile> {
  const base = {
    extends: 0,
    part_of: 0,
    similar_to: 0,
    depends_on: 0,
    causes: 0,
    follows: 0,
    derives_from: 0,
    contradicts: 0,
    exemplifies: 0,
    supersedes: 0,
    consolidates: 0,
    contextualizes: 0,
  };
  return {
    domain: "test",
    engramCount: 10,
    kindDistribution: {
      observation: 5,
      fact: 3,
      pattern: 1,
      procedure: 1,
      hypothesis: 0,
    },
    synapseDistribution: { ...base, ...synDist },
    avgImportance: 0.5,
    avgConfidence: 0.7,
  } as ReturnType<typeof computeDomainProfile>;
}
