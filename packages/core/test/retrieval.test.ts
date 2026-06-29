import { describe, it, expect } from "vitest";
import { buildFtsIndex, searchFts } from "../src/retrieval/fts.js";
import { applyFilter, matchesFilter } from "../src/retrieval/filter.js";
import { SearchOrchestrator } from "../src/retrieval/orchestrator.js";
import type { DigestLine } from "../src/index/types.js";

function makeLine(overrides: Partial<DigestLine>): DigestLine {
  return {
    id: "test/id",
    title: "测试",
    kind: "fact",
    kinds: ["fact"],
    summary: "一条测试",
    domainTags: ["test"],
    contextTags: [],
    importance: 0.5,
    emotionalValence: "neutral",
    freshness: "fresh",
    status: "active",
    sourceType: "firsthand",
    createdBy: "tester",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    lastRetrievedAt: null,
    lastEffectiveAt: null,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0,
    decayHalfLifeDays: 90,
    contentSize: 10,
    contentHash: "sha256:abc",
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
    ...overrides,
  };
}

describe("FTS 索引", () => {
  it("构建索引并搜索", () => {
    const lines = [
      makeLine({ id: "a", title: "Android ADB 调试", summary: "adb wireless" }),
      makeLine({
        id: "b",
        title: "OTA 升级失败",
        summary: "ota upgrade failed",
      }),
      makeLine({
        id: "c",
        title: "Android 网络配置",
        summary: "network config",
      }),
    ];
    const index = buildFtsIndex(lines);
    const hits = searchFts("adb", index);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe("a");
  });

  it("中文 bigram 匹配", () => {
    const lines = [
      makeLine({ id: "a", title: "调试工具", summary: "调试方法" }),
    ];
    const index = buildFtsIndex(lines);
    const hits = searchFts("调试", index);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("title 中的 token 权重更高", () => {
    const lines = [
      makeLine({ id: "a", title: "关键", summary: "其他内容" }),
      makeLine({ id: "b", title: "其他", summary: "关键 在摘要" }),
    ];
    const index = buildFtsIndex(lines);
    const hits = searchFts("关键", index);
    expect(hits[0].docId).toBe("a");
  });

  it("无匹配返回空数组", () => {
    const lines = [
      makeLine({ id: "a", title: "完全不同", summary: "无关内容" }),
    ];
    const index = buildFtsIndex(lines);
    const hits = searchFts("xyz", index);
    expect(hits).toEqual([]);
  });

  it("中文词级切分不产生 bigram 假阳性(Task 4.1)", () => {
    // bigram 实现:"记忆系统设计" → 含 "忆系" 这个无意义 token
    // Intl.Segmenter 词级切分:"记忆系统设计" → ["记忆", "系统", "设计"]
    // 不会产生跨词边界的 token
    const lines = [
      makeLine({
        id: "a",
        title: "记忆系统设计",
        summary: "记忆系统的设计原则",
      }),
    ];
    const index = buildFtsIndex(lines);
    // 搜 "忆系"(跨词边界的 bigram)——应无匹配
    const falseHits = searchFts("忆系", index);
    expect(falseHits).toEqual([]);
    // 搜真正的词——应匹配
    const realHits = searchFts("记忆", index);
    expect(realHits.length).toBeGreaterThan(0);
  });
});

describe("过滤器", () => {
  it("domainTags 过滤", () => {
    const lines = [
      makeLine({ id: "a", domainTags: ["testing", "adb"] }),
      makeLine({ id: "b", domainTags: ["development"] }),
    ];
    const filtered = applyFilter(lines, { domainTags: ["testing"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("kind 过滤", () => {
    const lines = [
      makeLine({ id: "a", kind: "fact", kinds: ["fact"] }),
      makeLine({ id: "b", kind: "procedure", kinds: ["procedure"] }),
    ];
    const filtered = applyFilter(lines, { kinds: ["fact"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("status 默认排除 archived/forgotten", () => {
    const lines = [
      makeLine({ id: "a", status: "active" }),
      makeLine({ id: "b", status: "archived" }),
    ];
    const filtered = applyFilter(lines, {});
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("显式 status 包含 archived", () => {
    const lines = [
      makeLine({ id: "a", status: "active" }),
      makeLine({ id: "b", status: "archived" }),
    ];
    const filtered = applyFilter(lines, { status: ["archived"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("minImportance 过滤", () => {
    const lines = [
      makeLine({ id: "a", importance: 0.3 }),
      makeLine({ id: "b", importance: 0.8 }),
    ];
    const filtered = applyFilter(lines, { minImportance: 0.5 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("matchesFilter 无 filter 返回 true", () => {
    expect(matchesFilter(makeLine({}), undefined)).toBe(true);
  });
});

describe("SearchOrchestrator", () => {
  it("未构建时搜索抛错", () => {
    const orchestrator = new SearchOrchestrator();
    expect(() => orchestrator.search("x")).toThrow(/not built/);
  });

  it("build 后能搜索", () => {
    const lines = [
      makeLine({ id: "a", title: "Android ADB", summary: "adb 调试" }),
      makeLine({ id: "b", title: "Other", summary: "无关" }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("adb");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("a");
  });

  it("搜索应用过滤器", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "Android ADB",
        summary: "adb",
        domainTags: ["testing"],
      }),
      makeLine({
        id: "b",
        title: "Android ADB",
        summary: "adb",
        domainTags: ["development"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("adb", { domainTags: ["testing"] });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a");
  });

  it("listByFilter 不带查询", () => {
    const lines = [
      makeLine({ id: "a", domainTags: ["x"] }),
      makeLine({ id: "b", domainTags: ["y"] }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.listByFilter({ domainTags: ["x"] });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a");
  });

  it("setWeights 配置三因子权重", () => {
    const orchestrator = new SearchOrchestrator();
    orchestrator.setWeights({ alpha: 0.7, beta: 0.2, gamma: 0.1 });
    expect(orchestrator.getWeights().alpha).toBe(0.7);
  });

  it("setWeights 拒绝非 1 和", () => {
    const orchestrator = new SearchOrchestrator();
    expect(() =>
      orchestrator.setWeights({ alpha: 0.5, beta: 0.3, gamma: 0.4 }),
    ).toThrow(/sum to 1/);
  });

  it("setClock 注入固定时钟", () => {
    const fixedNow = new Date("2026-06-20T00:00:00Z");
    const orchestrator = new SearchOrchestrator();
    orchestrator.setClock(() => fixedNow);
    const lines = [
      makeLine({
        id: "a",
        lastEffectiveAt: new Date(fixedNow.getTime() - 86400000).toISOString(),
      }),
    ];
    orchestrator.build(lines);
    // 不抛错即可（recencyDecay 受控）
    expect(() => orchestrator.search("测试")).not.toThrow();
  });

  it("三因子排序：高 importance 反超低 importance（同 relevance）", () => {
    const lines = [
      makeLine({ id: "a", title: "ADB", summary: "调试", importance: 0.2 }),
      makeLine({ id: "b", title: "ADB", summary: "调试", importance: 0.9 }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("ADB");
    // 两条 relevance 同（都是 title 命中），importance 不同
    // 但 lastEffectiveAt=null → recency 都为 0
    // score = 0.5×1 + 0.3×0 + 0.2×importance
    // b (0.2×0.9=0.18) > a (0.2×0.2=0.04)
    expect(results[0].id).toBe("b");
  });

  it("listByImportance 按 importance+recency 排序", () => {
    const lines = [
      makeLine({ id: "a", importance: 0.2 }),
      makeLine({ id: "b", importance: 0.9 }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.listByImportance();
    expect(results[0].id).toBe("b");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("排序稳定性：相同输入相同输出", () => {
    const lines = [
      makeLine({ id: "a", title: "X", summary: "匹配" }),
      makeLine({ id: "b", title: "X", summary: "匹配" }),
    ];
    const orchestrator1 = new SearchOrchestrator();
    orchestrator1.build(lines);
    const r1 = orchestrator1.search("X");

    const orchestrator2 = new SearchOrchestrator();
    orchestrator2.build(lines);
    const r2 = orchestrator2.search("X");

    expect(r1.map((r) => r.id)).toEqual(r2.map((r) => r.id));
    expect(r1.map((r) => r.score)).toEqual(r2.map((r) => r.score));
  });
});
