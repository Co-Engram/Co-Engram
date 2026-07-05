import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  estimateTokens,
  createBudget,
  consume,
  hasBudget,
  isExhausted,
  utilization,
} from "../src/disclosure/budget.js";
import {
  loadView,
  estimateViewSize,
  compareTier,
  upgradeView,
  viewIdOf,
} from "../src/disclosure/tier-loader.js";
import {
  adaptiveDisclosure,
  upgradeSingle,
} from "../src/disclosure/adaptive.js";
import type { DigestLine } from "../src/index/types.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-disclosure-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// budget.ts
// ============================================================

describe("estimateTokens", () => {
  it("空字符串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("纯中文：1 char ≈ 1 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("纯英文：~4 char/token", () => {
    // 8 字符 → 2 token
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("中英混合", () => {
    // 2 中文 + 4 英文 = 2 + 1 = 3
    expect(estimateTokens("你好test")).toBe(3);
  });
});

describe("createBudget", () => {
  it("无 reserved 时 remaining=total", () => {
    const b = createBudget(4096);
    expect(b.totalTokens).toBe(4096);
    expect(b.reserved).toBe(0);
    expect(b.remaining).toBe(4096);
  });

  it("reserved 扣除", () => {
    const b = createBudget(4096, 1000);
    expect(b.remaining).toBe(3096);
  });

  it("负数 totalTokens 抛错", () => {
    expect(() => createBudget(-1)).toThrow(/totalTokens/);
  });

  it("reserved > total 抛错", () => {
    expect(() => createBudget(100, 200)).toThrow(/reserved/);
  });
});

describe("consume / hasBudget", () => {
  it("消耗后 remaining 减少", () => {
    const b = createBudget(1000);
    const b2 = consume(b, 300);
    expect(b2.remaining).toBe(700);
    // 原对象不变
    expect(b.remaining).toBe(1000);
  });

  it("消耗到 0 不会变负", () => {
    const b = createBudget(100);
    const b2 = consume(b, 200);
    expect(b2.remaining).toBe(0);
  });

  it("hasBudget 判定", () => {
    const b = createBudget(100);
    expect(hasBudget(b, 100)).toBe(true);
    expect(hasBudget(b, 101)).toBe(false);
  });

  it("isExhausted", () => {
    expect(isExhausted(createBudget(100))).toBe(false);
    expect(isExhausted(consume(createBudget(100), 100))).toBe(true);
  });

  it("utilization", () => {
    expect(utilization(createBudget(100))).toBe(0);
    expect(utilization(consume(createBudget(100), 30))).toBeCloseTo(0.3, 5);
    expect(utilization(createBudget(0))).toBe(0);
  });
});

// ============================================================
// tier-loader.ts
// ============================================================

describe("estimateViewSize", () => {
  it("catalog 固定 50", () => {
    expect(estimateViewSize("catalog", {})).toBe(50);
  });

  it("digest 固定 120", () => {
    expect(estimateViewSize("digest", {})).toBe(120);
  });

  it("content 随 size 变化", () => {
    expect(estimateViewSize("content", { contentSize: 200 })).toBe(220);
    expect(estimateViewSize("content", { contentSize: 1000 })).toBe(620);
  });

  it("synapses 随 edges 变化", () => {
    expect(
      estimateViewSize("synapses", { outgoingCount: 5, incomingCount: 3 }),
    ).toBe(280);
  });
});

describe("compareTier", () => {
  it("catalog < digest < content < meta < synapses", () => {
    expect(compareTier("catalog", "digest")).toBeLessThan(0);
    expect(compareTier("digest", "content")).toBeLessThan(0);
    expect(compareTier("content", "meta")).toBeLessThan(0);
    expect(compareTier("meta", "synapses")).toBeLessThan(0);
  });

  it("相同 tier 返回 0", () => {
    expect(compareTier("digest", "digest")).toBe(0);
  });
});

describe("loadView", () => {
  it("catalog tier", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const view = loadView(repo, engram.id, "catalog");
    expect(view.tier).toBe("catalog");
    expect(view.entry.title).toBe("A");
  });

  it("digest tier", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const view = loadView(repo, engram.id, "digest");
    expect(view.tier).toBe("digest");
  });

  it("content tier", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容 ABC",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const view = loadView(repo, engram.id, "content");
    if (view.tier === "content") {
      expect(view.content).toBe("内容 ABC");
    } else {
      throw new Error(`expected content tier, got ${view.tier}`);
    }
  });

  it("catalog 不存在抛错", () => {
    expect(() => loadView(repo, "no/such", "catalog")).toThrow(/not found/);
  });
});

describe("viewIdOf / upgradeView", () => {
  it("viewIdOf 提取 id", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const cat = loadView(repo, engram.id, "catalog");
    expect(viewIdOf(cat)).toBe(engram.id);
  });

  it("upgradeView 升级到更高 tier", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const cat = loadView(repo, engram.id, "catalog");
    const { view, tierChanged } = upgradeView(repo, cat, "digest");
    expect(tierChanged).toBe(true);
    expect(view.tier).toBe("digest");
  });

  it("upgradeView 降级或同级不改变", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const dig = loadView(repo, engram.id, "digest");
    const { view, tierChanged } = upgradeView(repo, dig, "catalog");
    expect(tierChanged).toBe(false);
    expect(view.tier).toBe("digest");
  });
});

// ============================================================
// adaptive.ts
// ============================================================

function makeDigestLine(
  engram: {
    id: string;
    title: string;
    contentSize: number;
    importance?: number;
  },
  overrides: Partial<DigestLine> = {},
): DigestLine {
  return {
    id: engram.id,
    title: engram.title,
    kind: "fact",
    kinds: ["fact"],
    summary: engram.title,
    domainTags: ["t"],
    contextTags: [],
    importance: engram.importance ?? 0.5,
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
    contentSize: engram.contentSize,
    contentHash: "",
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
    ...overrides,
  };
}

describe("adaptiveDisclosure", () => {
  it("阶段 1：小预算默认全部加载为 catalog（无法升级）", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const e2 = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 2 }),
      [e2.id]: makeDigestLine({ id: e2.id, title: "B", contentSize: 2 }),
    };
    // catalog=50×2=100 够；digest 补差额 70 > 20 不够
    const budget = createBudget(120);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [
        { id: e1.id, score: 0.9 },
        { id: e2.id, score: 0.5 },
      ],
      digestLines: lines,
      budget,
    });
    expect(result.loaded.length).toBe(2);
    expect(result.tierBreakdown.catalog).toBe(2);
    expect(result.tierBreakdown.digest).toBe(0);
    expect(result.tierBreakdown.content).toBe(0);
    expect(result.reachedStage).toBe(1);
  });

  it("阶段 2：中等预算升级到 digest", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const e2 = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 2 }),
      [e2.id]: makeDigestLine({ id: e2.id, title: "B", contentSize: 2 }),
    };
    // 大预算，但限制 topK=0 → 不会升级到 content
    const budget = createBudget(4096);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [
        { id: e1.id, score: 0.9 },
        { id: e2.id, score: 0.5 },
      ],
      digestLines: lines,
      budget,
      topK: 0,
    });
    expect(result.tierBreakdown.digest).toBe(2);
    expect(result.tierBreakdown.content).toBe(0);
    expect(result.reachedStage).toBe(2);
  });

  it("阶段 3：Top-K 升级到 content", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a".repeat(100),
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 100 }),
    };
    const budget = createBudget(4096);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [{ id: e1.id, score: 1 }],
      digestLines: lines,
      budget,
      topK: 1,
    });
    expect(result.tierBreakdown.content).toBe(1);
    expect(result.reachedStage).toBe(3);
  });

  it("极小预算：连 catalog 都装不下", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 2 }),
    };
    const budget = createBudget(20); // < catalog(50)
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [{ id: e1.id, score: 1 }],
      digestLines: lines,
      budget,
    });
    expect(result.loaded.length).toBe(0);
    expect(result.tokensUsed).toBe(0);
  });

  it("中等预算：digest 够，content 不够", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a".repeat(500),
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 500 }),
    };
    // catalog(50) + digest(120) 够；content(370) 不够
    const budget = createBudget(200);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [{ id: e1.id, score: 1 }],
      digestLines: lines,
      budget,
      topK: 1,
    });
    expect(result.tierBreakdown.digest).toBe(1);
    expect(result.tierBreakdown.content).toBe(0);
    expect(result.reachedStage).toBe(2);
  });

  it("稳定排序：同 score 保持原顺序", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [a.id]: makeDigestLine({ id: a.id, title: "A", contentSize: 2 }),
      [b.id]: makeDigestLine({ id: b.id, title: "B", contentSize: 2 }),
    };
    const budget = createBudget(4096);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [
        { id: a.id, score: 0.5 },
        { id: b.id, score: 0.5 },
      ],
      digestLines: lines,
      budget,
      topK: 1,
    });
    // 同分 → 保持原顺序，A 升 content
    expect(result.loaded[0]!.id).toBe(a.id);
    expect(result.tierBreakdown.content).toBe(1);
  });

  it("多候选：高 score 先升级", () => {
    const a = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const b = repo.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [a.id]: makeDigestLine({ id: a.id, title: "A", contentSize: 2 }),
      [b.id]: makeDigestLine({ id: b.id, title: "B", contentSize: 2 }),
    };
    const budget = createBudget(4096);
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [
        { id: a.id, score: 0.3 },
        { id: b.id, score: 0.9 },
      ],
      digestLines: lines,
      budget,
      topK: 1,
    });
    // B score 高 → B 升 content；A 停在 digest
    expect(result.tierBreakdown.content).toBe(1);
    const bEntry = result.loaded.find((x) => x.id === b.id)!;
    expect(bEntry.view.tier).toBe("content");
  });

  it("tokensUsed 与 budgetRemaining 一致", () => {
    const e1 = repo.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const lines: Record<string, DigestLine> = {
      [e1.id]: makeDigestLine({ id: e1.id, title: "A", contentSize: 2 }),
    };
    const total = 4096;
    const result = adaptiveDisclosure({
      repository: repo,
      candidates: [{ id: e1.id, score: 1 }],
      digestLines: lines,
      budget: createBudget(total),
    });
    expect(result.tokensUsed + result.budgetRemaining).toBeLessThanOrEqual(
      total,
    );
    expect(result.tokensUsed).toBeGreaterThan(0);
  });
});

describe("upgradeSingle", () => {
  it("从 catalog 升级到 content（预算够）", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const cat = loadView(repo, engram.id, "catalog");
    const budget = createBudget(4096);
    const {
      view,
      budget: newBudget,
      tierChanged,
    } = upgradeSingle(repo, cat, "content", budget);
    expect(tierChanged).toBe(true);
    expect(view.tier).toBe("content");
    expect(newBudget.remaining).toBeLessThan(budget.remaining);
  });

  it("预算不足时不升级", () => {
    const engram = repo.createEngram({
      title: "A",
      content: "内容",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const cat = loadView(repo, engram.id, "catalog");
    const budget = createBudget(60); // catalog 50 已经用了，剩余 10 < content size
    const consumed = consume(budget, 50);
    const { view, tierChanged } = upgradeSingle(repo, cat, "content", consumed);
    expect(tierChanged).toBe(false);
    expect(view.tier).toBe("catalog");
  });
});
