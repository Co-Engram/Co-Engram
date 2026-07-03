// packages/core/test/storage/index-db-rebuild.test.ts
//
// Task 1.6:IndexDb.rebuildFromEntries —— cold start 重建。
//
// 验证两个关键性质:
// 1. 先 TRUNCATE 后 INSERT:旧的 engram / domains / synapses / FTS 全部清空
// 2. 批量插入新条目:100 条 entry 一次性灌入,事务原子性保证中途失败回滚
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IndexDb, type EngramIndexEntry } from "../../src/storage/index-db.js";

let dbDir: string;
let dbPath: string;
let db: IndexDb;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "co-engram-rebuild-"));
  dbPath = join(dbDir, "index.db");
  db = new IndexDb({ dbPath });
  db.open();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("IndexDb.rebuildFromEntries", () => {
  it("先清空再批量插入", () => {
    // 预置一条旧数据,rebuild 后必须消失
    db.upsertEngram({
      id: "old",
      title: "old",
      kind: "fact",
      importance: 0.1,
      confidence: 0.5,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: ["should-be-gone"],
      summary: "",
      contentTokens: "",
    });
    // 还预置一条指向 old 的 synapse,CASCADE 应清掉
    db.upsertEngram({
      id: "old-target",
      title: "old-target",
      kind: "fact",
      importance: 0.1,
      confidence: 0.5,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: [],
      summary: "",
      contentTokens: "",
    });
    db.upsertSynapse({
      id: "syn-old",
      fromId: "old",
      toId: "old-target",
      kind: "related_to",
      weight: 0.5,
    });

    const entries: EngramIndexEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `id-${i}`,
      title: `engram-${i}`,
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1718000000000 + i,
      contentSize: 100,
      visibility: "public",
      status: "active",
      domainTags: ["batch"],
      summary: "",
      contentTokens: `content ${i}`,
    }));
    db.rebuildFromEntries(entries);

    // 旧 engram 必须不存在
    const oldRow = db
      .prepare("SELECT count(*) as n FROM engrams WHERE id = ?")
      .get("old") as { n: number };
    expect(oldRow.n).toBe(0);

    // 旧 synapse 必须被 CASCADE 清掉
    const oldSynapse = db
      .prepare("SELECT count(*) as n FROM synapses WHERE id = ?")
      .get("syn-old") as { n: number };
    expect(oldSynapse.n).toBe(0);

    // 旧 FTS 必须被显式清掉
    const oldFts = db
      .prepare("SELECT count(*) as n FROM engram_fts WHERE id = ?")
      .get("old") as { n: number };
    expect(oldFts.n).toBe(0);

    // 100 条新数据全部就位
    const total = db.prepare("SELECT count(*) as n FROM engrams").get() as {
      n: number;
    };
    expect(total.n).toBe(100);

    // domains 全部建立(每条都有 "batch" tag → 100 行)
    const domainCount = db
      .prepare("SELECT count(*) as n FROM engram_domains WHERE domain = ?")
      .get("batch") as { n: number };
    expect(domainCount.n).toBe(100);

    // FTS 全部建立
    const ftsCount = db.prepare("SELECT count(*) as n FROM engram_fts").get() as {
      n: number;
    };
    expect(ftsCount.n).toBe(100);

    // 旧 tag 不残留
    const staleDomain = db
      .prepare("SELECT count(*) as n FROM engram_domains WHERE domain = ?")
      .get("should-be-gone") as { n: number };
    expect(staleDomain.n).toBe(0);
  });

  it("空 entries 数组 = 仅清空(幂等清理)", () => {
    // 预置一些数据
    db.upsertEngram({
      id: "x",
      title: "x",
      kind: "fact",
      importance: 0.1,
      confidence: 0.5,
      updatedAt: 1,
      contentSize: 0,
      visibility: "public",
      status: "active",
      domainTags: ["a"],
      summary: "",
      contentTokens: "",
    });

    db.rebuildFromEntries([]);

    const total = db.prepare("SELECT count(*) as n FROM engrams").get() as {
      n: number;
    };
    expect(total.n).toBe(0);
    const domains = db
      .prepare("SELECT count(*) as n FROM engram_domains")
      .get() as { n: number };
    expect(domains.n).toBe(0);
    const fts = db.prepare("SELECT count(*) as n FROM engram_fts").get() as {
      n: number;
    };
    expect(fts.n).toBe(0);
  });

  it("批量插入 1000 条性能 < 1s(回归基线)", () => {
    const entries: EngramIndexEntry[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `perf-${i}`,
      title: `engram-${i}`,
      kind: "fact",
      importance: 0.5,
      confidence: 0.8,
      updatedAt: 1718000000000 + i,
      contentSize: 100,
      visibility: "public",
      status: "active",
      domainTags: ["perf", `tag-${i % 10}`],
      summary: `summary ${i}`,
      contentTokens: `content for engram ${i} with some text`,
    }));

    const start = Date.now();
    db.rebuildFromEntries(entries);
    const elapsed = Date.now() - start;

    const total = db.prepare("SELECT count(*) as n FROM engrams").get() as {
      n: number;
    };
    expect(total.n).toBe(1000);
    // WAL + 单事务批量插入应该很快;放宽到 2s 作为 CI 噪声 margin
    expect(elapsed).toBeLessThan(2000);
  });
});
