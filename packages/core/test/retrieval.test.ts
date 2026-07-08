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

  it("中文词级切分 + 单字 fallback(P0-6 修订 Task 4.1)", () => {
    // Task 4.1 原设计:Intl.Segmenter 词级切分,消除 bigram(N-gram 索引产物)假阳性。
    // P0-6 修订:索引端 word-level segment 长度 > 1 时额外补单字 token,
    //           让单字 query(如"记")能命中含该字的词(如"记忆系统")。
    //           代价是 segmenter 不识别的 2 字 query(如"忆系")会跨词边界
    //           匹配(单字 token 都在索引里),但用户极少查无意义 2 字组合,
    //           而单字 query 极常见。FTS 真正消除假阳性需要 phrase matching。
    const lines = [
      makeLine({
        id: "a",
        title: "记忆系统设计",
        summary: "记忆系统的设计原则",
      }),
    ];
    const index = buildFtsIndex(lines);
    // 搜真正的词——应匹配
    const realHits = searchFts("记忆", index);
    expect(realHits.length).toBeGreaterThan(0);
    // P0-6 新断言:搜单字"记"——应命中含该字的文档(原 Task 4.1 修复前会失败)
    const singleCharHits = searchFts("记", index);
    expect(singleCharHits.length).toBeGreaterThan(0);
    expect(singleCharHits[0].docId).toBe("a");
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
    const result = orchestrator.listByFilter({
      filter: { domainTags: ["x"] },
      limit: 100,
      cursor: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a");
    expect(result.nextCursor).toBeNull();
  });

  it("setWeights 配置四因子权重", () => {
    const orchestrator = new SearchOrchestrator();
    orchestrator.setWeights({ alpha: 0.6, beta: 0.2, gamma: 0.1, delta: 0.1 });
    expect(orchestrator.getWeights().alpha).toBe(0.6);
  });

  it("setWeights 拒绝非 1 和", () => {
    const orchestrator = new SearchOrchestrator();
    expect(() =>
      orchestrator.setWeights({
        alpha: 0.5,
        beta: 0.3,
        gamma: 0.4,
        delta: 0.1,
      }),
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
    // 两条 relevance 同(都是 title 命中),importance 不同
    // createdAt 相同 → recency 相同(都按 createdAt 衰退)
    // score = 0.5×1 + 0.3×recency + 0.2×importance
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
    const result = orchestrator.listByImportance({
      limit: 100,
      cursor: null,
    });
    expect(result.items[0].id).toBe("b");
    expect(result.items[0].id).not.toBe(result.items[1].id);
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

// ============================================================
// AI-9 score 归一化 + matchReason
// ============================================================

describe("AI-9: score 归一化 + matchReason", () => {
  it("score 严格 ∈ [0, 1](clamp01 兜底)", () => {
    // 极端构造:importance=1 + 多次 reinforce 让 strength 接近 1 + title 命中
    // 四因子加权和理论 ≤ 1,但 corner case 可能数值漂移,clamp01 兜底
    const lines = [
      makeLine({
        id: "a",
        title: "Test ADB",
        summary: "ADB debugging",
        importance: 1.0,
        reinforcementScore: 1.0,
        verificationStatus: undefined,
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("ADB");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("matchReason 暴露 title 命中", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "Android ADB",
        summary: "调试方法",
        domainTags: ["mobile"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("adb");
    expect(results.length).toBe(1);
    const mr = results[0].matchReason;
    expect(mr.length).toBeGreaterThan(0);
    const titleHit = mr.find((m) => m.field === "title");
    expect(titleHit).toBeDefined();
    expect(titleHit!.term).toBe("adb");
  });

  it("matchReason 暴露 summary 命中(非 title)", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "Android 调试",
        summary: "通过 ADB 连接设备",
        domainTags: ["mobile"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("adb");
    expect(results.length).toBe(1);
    const summaryHit = results[0].matchReason.find((m) => m.field === "summary");
    expect(summaryHit).toBeDefined();
    expect(summaryHit!.term).toBe("adb");
    // title 不含 "adb",所以不应有 title 命中
    const titleHit = results[0].matchReason.find((m) => m.field === "title");
    expect(titleHit).toBeUndefined();
  });

  it("matchReason 暴露 domainTags 命中", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "配置",
        summary: "环境设置",
        domainTags: ["testing", "adb"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("testing");
    expect(results.length).toBe(1);
    const domainHit = results[0].matchReason.find(
      (m) => m.field === "domainTags",
    );
    expect(domainHit).toBeDefined();
    expect(domainHit!.term).toBe("testing");
  });

  it("matchReason weight 加起来 = 1(等权归一化)", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "Android ADB",
        summary: "ADB 调试",
        domainTags: ["adb"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const results = orchestrator.search("adb");
    expect(results.length).toBe(1);
    const mr = results[0].matchReason;
    expect(mr.length).toBeGreaterThan(0);
    const sum = mr.reduce((acc, m) => acc + m.weight, 0);
    // 浮点精度容差
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });

  it("listByFilter 返回空 matchReason(无查询路径)", () => {
    const lines = [
      makeLine({ id: "a", domainTags: ["x"] }),
      makeLine({ id: "b", domainTags: ["y"] }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    const result = orchestrator.listByFilter({
      filter: { domainTags: ["x"] },
      limit: 100,
      cursor: null,
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0].matchReason).toEqual([]);
    expect(result.items[0].score).toBe(0);
  });

  it("matchReason 多 token 多字段命中", () => {
    const lines = [
      makeLine({
        id: "a",
        title: "Android ADB",
        summary: "调试 android 设备",
        domainTags: ["android", "testing"],
      }),
    ];
    const orchestrator = new SearchOrchestrator();
    orchestrator.build(lines);
    // 查两个 token:android + testing
    const results = orchestrator.search("android testing");
    expect(results.length).toBe(1);
    const mr = results[0].matchReason;
    // 至少 2 个字段命中(android + testing)
    expect(mr.length).toBeGreaterThanOrEqual(2);
    // weight 加和 = 1
    const sum = mr.reduce((acc, m) => acc + m.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });
});
