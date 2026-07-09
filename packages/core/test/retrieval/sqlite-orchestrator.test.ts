// packages/core/test/retrieval/sqlite-orchestrator.test.ts
//
// Task 2.1:SqliteSearchOrchestrator —— 走 SQLite FTS5 trigram 召回。
//
// 验证两个核心性质:
// 1. 中文 trigram query(≥3 字符)命中 FTS5 召回
// 2. limit 限制返回数量,且按 bm25 相关度排序
//
// 3 字符以下 query 走 LIKE 兜底(在 sqlite-orchestrator-like-fallback 单测覆盖)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IndexDb } from "../../src/storage/index-db.js";
import { SqliteSearchOrchestrator } from "../../src/retrieval/sqlite-orchestrator.js";

let dbDir: string;
let db: IndexDb;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "co-engram-sqlite-search-"));
  db = new IndexDb({ dbPath: join(dbDir, "index.db") });
  db.open();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("SqliteSearchOrchestrator", () => {
  it("FTS5 trigram 命中中文查询", () => {
    db.upsertEngram({
      id: "1",
      title: "记忆印迹规模化",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: ["demo"],
      summary: "记忆系统架构",
      contentTokens: "假设记忆印迹和突触增长到数千条",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("记忆");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.title).toContain("记忆");
  });

  it("limit 限制返回数量", () => {
    for (let i = 0; i < 10; i++) {
      db.upsertEngram({
        id: `id-${i}`,
        title: `记忆 ${i}`,
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: i,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: ["demo"],
        summary: "",
        contentTokens: "记忆内容",
      });
    }
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("记忆", { limit: 5 });
    expect(results).toHaveLength(5);
  });

  it("空 query 返回空结果", () => {
    db.upsertEngram({
      id: "x",
      title: "任意",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "任意内容",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results, nextCursor } = orchestrator.search("   ");
    expect(results).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it("无命中返回空数组(不抛错)", () => {
    db.upsertEngram({
      id: "x",
      title: "完全无关",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "完全无关的内容",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("量子纠缠");
    expect(results).toEqual([]);
  });

  it("domainTags filter 后置过滤生效", () => {
    db.upsertEngram({
      id: "a",
      title: "记忆 A",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: ["keep"],
      summary: "",
      contentTokens: "记忆内容 A",
    });
    db.upsertEngram({
      id: "b",
      title: "记忆 B",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 2,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: ["drop"],
      summary: "",
      contentTokens: "记忆内容 B",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("记忆", {
      filter: { domainTags: ["keep"] },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("a");
  });

  it("LIKE 兜底:1-2 字符 query 走 title LIKE 而非 FTS5(不抛错)", () => {
    db.upsertEngram({
      id: "short",
      title: "AB 标题",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "短查询测试",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    // 2 字符 query,FTS5 trigram 无法处理,LIKE 兜底匹配 title
    const { results } = orchestrator.search("AB");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.title).toContain("AB");
  });

  // buildFtsQuery 改造(phrase → OR)的回归覆盖:
  // 旧实现把整个 query 包成一个 phrase,FTS5 trigram 要求文档里有完全相同的
  // 连续字符序列,组合 query 几乎必然 0 召回。新实现按 token 拆 + OR 连接,
  // 部分命中即召回,全部命中的文档 bm25 得分更优排前。

  it("多 token 组合 query 命中(中英混合,OR 召回)", () => {
    db.upsertEngram({
      id: "mix",
      title: "co-engram loop 模式",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "持续改进循环",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    // 旧实现:phrase "co-engram loop 模式" 要求文档里有这个连续序列 → 0 召回
    // 新实现:tokens = ["co-engram", "loop", "模式"],OR 召回
    const { results } = orchestrator.search("co-engram loop 模式");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe("mix");
  });

  it("多 token 组合 query 部分命中也召回", () => {
    // 文档只含 "改进循环",不含 "挑剔用户";OR query 仍应命中
    db.upsertEngram({
      id: "partial",
      title: "co-engram 改进循环",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "持续改进",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("挑剔用户 改进循环");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe("partial");
  });

  it("含特殊字符的 token 正确 escape 双引号(不抛 SQL 错)", () => {
    db.upsertEngram({
      id: "special",
      title: '含 "双引号" 的标题',
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "双引号测试",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    // query 含 " → buildFtsQuery 必须转义为 ""(FTS5 标准),否则 SQL parse 失败
    const { results } = orchestrator.search('含 "双引号"');
    expect(results.length).toBeGreaterThan(0);
  });

  it("FTS 命中数足够时,LIKE fallback 不触发(score 非零)", () => {
    // 此前误判:常见 token(如 co-engram)bm25 ≈ -0.000002,toFixed(3)=0.000
    // 让人以为是 LIKE fallback。这里确保 FTS 命中时返回 bm25 真实分数。
    db.upsertEngram({
      id: "common-token",
      title: "唯一罕见词出现在这里",
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "罕见词内容",
    });
    const orchestrator = new SqliteSearchOrchestrator({ db });
    const { results } = orchestrator.search("罕见词");
    expect(results.length).toBeGreaterThan(0);
    // 罕见词 IDF 高,bm25 分数应该明显非零
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  // ============================================================
  // AI-9 真正修复:score 归一化到 [0, 1]
  // ============================================================
  // 历史缺陷:sqlite-orchestrator.ts 直接透传 -bm25_value(正数,无上界),
  // 实测 engram_search MCP 工具返回 score=26.6,违反 SimpleSearchResult
  // 注释承诺的"严格 ∈ [0, 1]"。修复后,SQLite 路径除以本批 max,让 top hit = 1.0。
  describe("AI-9 score 归一化到 [0, 1]", () => {
    it("FTS 多命中:top hit score = 1.0,其他 ≤ 1.0", () => {
      db.upsertEngram({
        id: "high-bm25",
        title: "唯一罕见词 alpha 出现在这里",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 1,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: [],
        summary: "",
        contentTokens: "罕见词 alpha 内容",
      });
      db.upsertEngram({
        id: "low-bm25",
        title: "罕见词 alpha 也出现在这里但 IDF 低",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 2,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: [],
        summary: "",
        contentTokens: "罕见词 alpha 重复 alpha alpha",
      });
      const orchestrator = new SqliteSearchOrchestrator({ db });
      const { results } = orchestrator.search("罕见词 alpha");
      expect(results.length).toBeGreaterThanOrEqual(2);
      // top hit 归一化后应为 1.0(允许浮点误差)
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
      // 所有 score ∈ [0, 1]
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it("LIKE 兜底路径:所有 score = 0(无相关度信号,不归一化)", () => {
      // 1-2 字符 query 走 LIKE,LIKE 不算 bm25,score 恒为 0
      db.upsertEngram({
        id: "short-query-hit",
        title: "中",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 1,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: [],
        summary: "",
        contentTokens: "",
      });
      const orchestrator = new SqliteSearchOrchestrator({ db });
      const { results } = orchestrator.search("中");
      if (results.length > 0) {
        // LIKE 路径 maxScore=0,所有 score 保留 0
        for (const r of results) {
          expect(r.score).toBe(0);
        }
      }
    });

    it("单 hit:top hit score = 1.0(自己除自己)", () => {
      db.upsertEngram({
        id: "solo-hit",
        title: "独特组合词xyz abc",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 1,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: [],
        summary: "",
        contentTokens: "独特组合词xyz abc 内容",
      });
      const orchestrator = new SqliteSearchOrchestrator({ db });
      const { results } = orchestrator.search("独特组合词xyz");
      expect(results.length).toBe(1);
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
    });

    it("postFilter 过滤掉原 top hit:剩余结果按次高归一化", () => {
      db.upsertEngram({
        id: "top-but-filtered",
        title: "独特查询词xyz 出现在 high importance",
        kind: "fact",
        importance: 0.9,
        confidence: 0.8,
        updatedAt: 1,
        contentSize: 0,
        visibility: "public",
        status: "active",
        // 用 domainTags 做过滤:这条 tag 不同,会被 postFilter 排除
        domainTags: ["filtered-tag"],
        summary: "",
        contentTokens: "独特查询词xyz",
      });
      db.upsertEngram({
        id: "second-best",
        title: "独特查询词xyz 出现在另一条",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 2,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: ["kept-tag"],
        summary: "",
        contentTokens: "独特查询词xyz",
      });
      const orchestrator = new SqliteSearchOrchestrator({ db });
      const { results: filtered } = orchestrator.search("独特查询词xyz", {
        filter: { domainTags: ["kept-tag"] },
      });
      expect(filtered.length).toBe(1);
      // 过滤后 maxScore 基于 second-best 自己 → 归一化为 1.0
      expect(filtered[0]!.score).toBeCloseTo(1.0, 5);
    });
  });
});
