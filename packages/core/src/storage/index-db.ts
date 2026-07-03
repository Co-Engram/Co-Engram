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
}
