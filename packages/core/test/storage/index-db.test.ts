// packages/core/test/storage/index-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IndexDb } from "../../src/storage/index-db.js";

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
