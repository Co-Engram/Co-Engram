// packages/core/test/storage/index-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IndexDb, encodeQueryCursor } from "../../src/storage/index-db.js";
import type { EngramIndexEntry, SynapseIndexEntry } from "../../src/storage/index-db.js";

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "co-engram-test-"));
  dbPath = join(dbDir, "index.db");
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe("IndexDb", () => {
  it("open 创建 .db 文件并初始化 schema", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    expect(existsSync(dbPath)).toBe(true);
    // 4 表 + FTS5 应存在
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("engrams");
    expect(names).toContain("engram_domains");
    expect(names).toContain("synapses");
    expect(names).toContain("engram_fts");
    db.close();
  });

  it("transaction 提交后数据可见", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO engrams (id, title, kind, importance, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .run("id-1", "test", "fact", 0.5, 0.8, Date.now());
    });
    const row = db.prepare("SELECT count(*) as n FROM engrams").get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  it("transaction 抛错时 rollback", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO engrams (id, title, kind, importance, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("id-1", "test", "fact", 0.5, 0.8, Date.now());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const row = db.prepare("SELECT count(*) as n FROM engrams").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("WAL 模式生效", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
    db.close();
  });
});

const sampleEngram: EngramIndexEntry = {
  id: "01KWMH4ETY5T7BF6Y8365F4ZZZ",
  title: "测试 engram",
  kind: "fact",
  importance: 0.85,
  confidence: 0.9,
  updatedAt: 1718000000000,
  contentSize: 1024,
  visibility: "public",
  status: "active",
  domainTags: ["测试", "demo"],
  summary: "这是一条测试记忆",
  contentTokens: "测试 engram 内容",
};

describe("IndexDb UPSERT", () => {
  it("upsertEngram 写入主表 + domains + FTS", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    db.upsertEngram(sampleEngram);
    const row = db
      .prepare("SELECT * FROM engrams WHERE id = ?")
      .get(sampleEngram.id) as {
      title: string;
      kind: string;
      importance: number;
      confidence: number;
      updated_at: number;
      content_size: number;
      visibility: string;
      status: string;
    };
    expect(row.title).toBe(sampleEngram.title);
    expect(row.kind).toBe(sampleEngram.kind);
    expect(row.importance).toBe(sampleEngram.importance);
    expect(row.confidence).toBe(sampleEngram.confidence);
    expect(row.updated_at).toBe(sampleEngram.updatedAt);
    expect(row.content_size).toBe(sampleEngram.contentSize);
    expect(row.visibility).toBe(sampleEngram.visibility);
    expect(row.status).toBe(sampleEngram.status);
    const domains = db
      .prepare(
        "SELECT domain FROM engram_domains WHERE engram_id = ? ORDER BY domain",
      )
      .all(sampleEngram.id) as { domain: string }[];
    expect(domains.map((d) => d.domain)).toEqual(["demo", "测试"]);
    const ftsRow = db
      .prepare("SELECT title, summary, content_tokens FROM engram_fts WHERE id = ?")
      .get(sampleEngram.id) as {
      title: string;
      summary: string;
      content_tokens: string;
    };
    expect(ftsRow.title).toBe(sampleEngram.title);
    expect(ftsRow.summary).toBe(sampleEngram.summary);
    expect(ftsRow.content_tokens).toBe(sampleEngram.contentTokens);
    db.close();
  });

  it("upsertEngram 重复调用 = 更新(字段覆盖,domains 不重复)", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    db.upsertEngram(sampleEngram);
    db.upsertEngram({
      ...sampleEngram,
      title: "更新后标题",
      importance: 0.5,
      domainTags: ["demo", "测试", "新增"],
    });
    const row = db
      .prepare("SELECT title, importance FROM engrams WHERE id = ?")
      .get(sampleEngram.id) as { title: string; importance: number };
    expect(row.title).toBe("更新后标题");
    expect(row.importance).toBe(0.5);
    // domains 应被替换为新的 3 个,而非累加
    const domains = db
      .prepare(
        "SELECT domain FROM engram_domains WHERE engram_id = ? ORDER BY domain",
      )
      .all(sampleEngram.id) as { domain: string }[];
    expect(domains.map((d) => d.domain)).toEqual(["demo", "新增", "测试"]);
    const count = db
      .prepare("SELECT count(*) as n FROM engram_domains WHERE engram_id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(count.n).toBe(3);
    // FTS 应反映新标题(无残留)
    const ftsRow = db
      .prepare("SELECT title FROM engram_fts WHERE id = ?")
      .get(sampleEngram.id) as { title: string };
    expect(ftsRow.title).toBe("更新后标题");
    db.close();
  });

  it("upsertSynapse 写入 + 更新", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    // synapses 有外键,需要先建 engram
    db.upsertEngram(sampleEngram);
    db.upsertEngram({ ...sampleEngram, id: "syn-target-1", title: "target" });
    const synapse: SynapseIndexEntry = {
      id: "syn-1",
      fromId: sampleEngram.id,
      toId: "syn-target-1",
      kind: "related_to",
      weight: 0.7,
    };
    db.upsertSynapse(synapse);
    let row = db
      .prepare("SELECT * FROM synapses WHERE id = ?")
      .get(synapse.id) as {
      from_id: string;
      to_id: string;
      kind: string;
      weight: number;
    };
    expect(row.from_id).toBe(synapse.fromId);
    expect(row.to_id).toBe(synapse.toId);
    expect(row.kind).toBe(synapse.kind);
    expect(row.weight).toBe(synapse.weight);
    // 再次 upsert,更新 weight
    db.upsertSynapse({ ...synapse, weight: 0.3, kind: "extends" });
    row = db
      .prepare("SELECT kind, weight FROM synapses WHERE id = ?")
      .get(synapse.id) as { kind: string; weight: number };
    expect(row.kind).toBe("extends");
    expect(row.weight).toBe(0.3);
    const count = db
      .prepare("SELECT count(*) as n FROM synapses")
      .get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("deleteEngram 级联删除 domains + synapses + FTS", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    db.upsertEngram(sampleEngram);
    db.upsertEngram({ ...sampleEngram, id: "syn-target-1", title: "target" });
    db.upsertSynapse({
      id: "syn-1",
      fromId: sampleEngram.id,
      toId: "syn-target-1",
      kind: "related_to",
      weight: 0.5,
    });
    db.deleteEngram(sampleEngram.id);
    // 主表
    const row = db
      .prepare("SELECT count(*) as n FROM engrams WHERE id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(row.n).toBe(0);
    // domains(CASCADE)
    const domains = db
      .prepare("SELECT count(*) as n FROM engram_domains WHERE engram_id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(domains.n).toBe(0);
    // synapses from_id / to_id CASCADE
    const synFrom = db
      .prepare("SELECT count(*) as n FROM synapses WHERE from_id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(synFrom.n).toBe(0);
    const synTo = db
      .prepare("SELECT count(*) as n FROM synapses WHERE to_id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(synTo.n).toBe(0);
    // FTS 显式删
    const fts = db
      .prepare("SELECT count(*) as n FROM engram_fts WHERE id = ?")
      .get(sampleEngram.id) as { n: number };
    expect(fts.n).toBe(0);
    db.close();
  });
});

describe("IndexDb.queryEngrams cursor 翻页", () => {
  // 回归 bug:count(*) 误把 cursor 条件带进 WHERE,导致 total 随 cursor 前进递减。
  // UI 上看到「已加载 1026 / 共 26」的反转 —— cursor 推到末页时 total = 末页剩余数。
  // 修复后:任何 cursor 位置 total 都应等于绝对仓库总数。
  it("cursor 推进时 total 不变(等于仓库总数)", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    const totalInserted = 25;
    for (let i = 0; i < totalInserted; i++) {
      db.upsertEngram({
        ...sampleEngram,
        id: `p-${i.toString().padStart(3, "0")}`,
        title: `engram ${i}`,
        updatedAt: 1718000000000 + i,
      });
    }

    const limit = 10;
    // page 1:无 cursor
    const r1 = db.queryEngrams({ sort: "updatedAt", descending: true, limit });
    expect(r1.total).toBe(25);
    expect(r1.results.length).toBe(10);

    // 用 page 1 末条造 cursor → page 2
    const last1 = r1.results[r1.results.length - 1]!;
    const cursor1 = encodeQueryCursor(last1.updatedAt, last1.id);
    const r2 = db.queryEngrams({
      sort: "updatedAt",
      descending: true,
      limit,
      cursor: cursor1,
    });
    // 关键 bug 复现点:修复前 r2.total 会是 15(25 - 10)。修复后必须仍是 25。
    expect(r2.total).toBe(25);
    expect(r2.results.length).toBe(10);

    // page 3 同样验证
    const last2 = r2.results[r2.results.length - 1]!;
    const cursor2 = encodeQueryCursor(last2.updatedAt, last2.id);
    const r3 = db.queryEngrams({
      sort: "updatedAt",
      descending: true,
      limit,
      cursor: cursor2,
    });
    expect(r3.total).toBe(25);
    expect(r3.results.length).toBe(5);
    db.close();
  });

  it("kind 过滤时 total 反映该 kind 总数,与 cursor 无关", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    // 8 条 fact + 5 条 pattern
    for (let i = 0; i < 8; i++) {
      db.upsertEngram({
        ...sampleEngram,
        id: `f-${i}`,
        kind: "fact",
        updatedAt: 1718000000000 + i,
      });
    }
    for (let i = 0; i < 5; i++) {
      db.upsertEngram({
        ...sampleEngram,
        id: `p-${i}`,
        kind: "pattern",
        updatedAt: 1818000000000 + i,
      });
    }

    const limit = 3;
    const r1 = db.queryEngrams({ kind: "fact", limit });
    expect(r1.total).toBe(8);
    expect(r1.results.length).toBe(3);

    const last1 = r1.results[r1.results.length - 1]!;
    const cursor1 = encodeQueryCursor(last1.updatedAt, last1.id);
    const r2 = db.queryEngrams({ kind: "fact", limit, cursor: cursor1 });
    // bug 复现前:r2.total 会是 5(8 - 3)。修复后必须仍是 8。
    expect(r2.total).toBe(8);
    expect(r2.results.length).toBe(3);

    const last2 = r2.results[r2.results.length - 1]!;
    const cursor2 = encodeQueryCursor(last2.updatedAt, last2.id);
    const r3 = db.queryEngrams({ kind: "fact", limit, cursor: cursor2 });
    expect(r3.total).toBe(8);
    expect(r3.results.length).toBe(2);
    db.close();
  });

  it("domainTags 过滤时 total 反映该 tag 总数,与 cursor 无关", () => {
    const db = new IndexDb({ dbPath });
    db.open();
    for (let i = 0; i < 6; i++) {
      db.upsertEngram({
        ...sampleEngram,
        id: `t-${i}`,
        domainTags: ["alpha"],
        updatedAt: 1718000000000 + i,
      });
    }
    for (let i = 0; i < 4; i++) {
      db.upsertEngram({
        ...sampleEngram,
        id: `u-${i}`,
        domainTags: ["beta"],
        updatedAt: 1818000000000 + i,
      });
    }

    const limit = 2;
    const r1 = db.queryEngrams({ domainTags: ["beta"], limit });
    expect(r1.total).toBe(4);

    const last1 = r1.results[r1.results.length - 1]!;
    const cursor1 = encodeQueryCursor(last1.updatedAt, last1.id);
    const r2 = db.queryEngrams({
      domainTags: ["beta"],
      limit,
      cursor: cursor1,
    });
    expect(r2.total).toBe(4);
    db.close();
  });
});
