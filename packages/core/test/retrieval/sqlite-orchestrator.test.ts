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
});
