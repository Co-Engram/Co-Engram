// packages/core/src/storage/index-db.ts

// 用 createRequire 绕过 Vite 静态分析:`import { DatabaseSync } from "node:sqlite"`
// 在 vitest 2.x 下会被 Vite resolver 拦截,报 `Failed to load url sqlite`
// (stripping `node:` prefix)。createRequire 在运行时调用,Vite 无法静态解析,
// 直接走 Node builtin resolver —— 同 test/storage/node-sqlite-smoke.test.ts 的 workaround。
//
// 字符串拼接 `"node:" + "sqlite"` 进一步防止 Vite 把整个 require 调用静态化为
// bare import 解析。type import 在编译时被擦除,不被 resolver 拦截,可以安全使用。
import { createRequire } from "node:module";
import type { DatabaseSync, Statement } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SQLITE_MODULE = "node:" + "sqlite";
const sqliteModule = require(SQLITE_MODULE) as typeof import("node:sqlite");
const DatabaseSync = sqliteModule.DatabaseSync;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "index-db-schema.sql");

export interface IndexDbOptions {
  readonly dbPath: string;
  /** true = 删除现有 db 文件后重建(plan Task 1.3 暂未实现 reset 逻辑,占位字段) */
  readonly reset?: boolean;
}

/**
 * engram 在索引层的一份精简投影(只含搜索/排序/FTS 需要的字段)。
 *
 * domainTags 是多值字段,在 SQLite 端拆 engram_domains 表;其余标量字段直接落 engrams 主表。
 * contentTokens 是已切分的纯文本(可能含空格分隔的 token),用于 FTS5 trigram 倒排。
 */
export interface EngramIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly confidence: number;
  /** epoch ms */
  readonly updatedAt: number;
  readonly contentSize: number;
  readonly visibility: string;
  readonly status: string;
  readonly domainTags: readonly string[];
  readonly summary: string;
  readonly contentTokens: string;
}

/**
 * 突触(synapse)索引条目。外键 from_id / to_id 引用 engrams 主表,
 * 删除任一端 engram 时由 ON DELETE CASCADE 自动清空。
 */
export interface SynapseIndexEntry {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly kind: string;
  readonly weight: number;
}

/**
 * SQLite 索引库封装:打开 / schema 初始化 / 显式事务。
 *
 * 设计要点:
 * - WAL 模式:多读单写,显著降低并发读写冲突,适合 engram write-through 场景。
 * - 显式 BEGIN/COMMIT/ROLLBACK:node:sqlite 默认隐式事务,显式包裹保证多语句原子性。
 * - schema 通过外部 .sql 文件管理,便于审计和迁移工具比对。
 */
export class IndexDb {
  private db: DatabaseSync | null = null;
  private readonly opts: IndexDbOptions;

  constructor(opts: IndexDbOptions) {
    this.opts = opts;
  }

  open(): void {
    if (this.db) return;
    this.db = new DatabaseSync(this.opts.dbPath);
    // WAL 模式 + 外键 + 性能调优
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    // 初始化 schema
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    this.db.exec(schema);
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  prepare(sql: string): Statement {
    this.requireOpen();
    return this.db!.prepare(sql);
  }

  exec(sql: string): void {
    this.requireOpen();
    this.db!.exec(sql);
  }

  /**
   * 在事务中执行回调,失败 rollback。
   * 注意:node:sqlite 的 DatabaseSync 默认每条语句隐式事务,
   * 但我们用 BEGIN/COMMIT/ROLLBACK 显式包裹,确保多语句原子性。
   */
  transaction<T>(fn: () => T): T {
    this.requireOpen();
    this.db!.exec("BEGIN");
    try {
      const result = fn();
      this.db!.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db!.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  }

  private requireOpen(): void {
    if (!this.db) {
      throw new Error("IndexDb not opened. Call open() first.");
    }
  }

  /**
   * UPSERT 一个 engram 索引条目:主表 + domains(全量替换)+ FTS(delete+insert)。
   *
   * 实现要点:
   * - 整体在事务内,任一步失败 rollback,保证主表/domains/FTS 三地一致。
   * - domains 用 DELETE+INSERT 而非 ON CONFLICT:语义上是"全量替换 tag 集合",
   *   调用方传入的新集合就是真理源,旧 tag 不在该集合内就该被清掉。
   * - FTS5 不支持 ON CONFLICT,只能 delete + insert;否则会有重复倒排项。
   */
  upsertEngram(entry: EngramIndexEntry): void {
    this.transaction(() => {
      this.prepare(`
        INSERT INTO engrams (id, title, kind, importance, confidence, updated_at, content_size, visibility, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          kind = excluded.kind,
          importance = excluded.importance,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at,
          content_size = excluded.content_size,
          visibility = excluded.visibility,
          status = excluded.status
      `).run(
        entry.id,
        entry.title,
        entry.kind,
        entry.importance,
        entry.confidence,
        entry.updatedAt,
        entry.contentSize,
        entry.visibility,
        entry.status,
      );
      // domains 全量替换
      this.prepare("DELETE FROM engram_domains WHERE engram_id = ?").run(entry.id);
      const insertDomain = this.prepare(
        "INSERT OR IGNORE INTO engram_domains (engram_id, domain) VALUES (?, ?)",
      );
      for (const d of entry.domainTags) {
        insertDomain.run(entry.id, d);
      }
      // FTS5 不支持 ON CONFLICT,delete + insert
      this.prepare("DELETE FROM engram_fts WHERE id = ?").run(entry.id);
      this.prepare(
        "INSERT INTO engram_fts (id, title, summary, content_tokens) VALUES (?, ?, ?, ?)",
      ).run(entry.id, entry.title, entry.summary, entry.contentTokens);
    });
  }

  /**
   * UPSERT 一条 synapse。无 FTS,单语句即可,不需要事务包裹。
   */
  upsertSynapse(s: SynapseIndexEntry): void {
    this.prepare(`
      INSERT INTO synapses (id, from_id, to_id, kind, weight)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_id = excluded.from_id,
        to_id = excluded.to_id,
        kind = excluded.kind,
        weight = excluded.weight
    `).run(s.id, s.fromId, s.toId, s.kind, s.weight);
  }

  /**
   * 删除一个 engram 及其所有派生数据。
   *
   * - engrams 主表:显式 DELETE。
   * - engram_domains / synapses(from/to):外键 ON DELETE CASCADE 自动清。
   * - engram_fts:FTS5 表不参与外键,必须显式 DELETE。
   *
   * 包在事务里:即便 FTS 删除失败,主表删除也会 rollback,保持一致。
   */
  deleteEngram(engramId: string): void {
    this.transaction(() => {
      this.prepare("DELETE FROM engrams WHERE id = ?").run(engramId);
      this.prepare("DELETE FROM engram_fts WHERE id = ?").run(engramId);
    });
  }
}
