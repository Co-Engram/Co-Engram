// packages/core/src/storage/index-db.ts

// 用 createRequire 绕过 Vite 静态分析:`import { DatabaseSync } from "node:sqlite"`
// 在 vitest 2.x 下会被 Vite resolver 拦截,报 `Failed to load url sqlite`
// (stripping `node:` prefix)。createRequire 在运行时调用,Vite 无法静态解析,
// 直接走 Node builtin resolver —— 同 test/storage/node-sqlite-smoke.test.ts 的 workaround。
//
// 字符串拼接 `"node:" + "sqlite"` 进一步防止 Vite 把整个 require 调用静态化为
// bare import 解析。type import 在编译时被擦除,不被 resolver 拦截,可以安全使用。
//
// Schema 以内联 TS 字符串形式注入(而非 `index-db-schema.sql` 外部文件),
// 避免 tsc 不会复制非 .ts 资源导致 dist 缺 schema 的 build-defect(曾使
// 0.2.0 sqlite 默认在 npm 部署后静默 fallback 到 memory)。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SQLITE_MODULE = "node:" + "sqlite";
const sqliteModule = require(SQLITE_MODULE) as typeof import("node:sqlite");
const DatabaseSync = sqliteModule.DatabaseSync;

// node:sqlite 的类型只导出 DatabaseSync(Statement 不是顶层 named export)。
// 通过 InstanceType / ReturnType 推导,避免重复 import 同名导致 TS2440 冲突。
type SqliteDb = InstanceType<typeof DatabaseSync>;
type Statement = ReturnType<SqliteDb["prepare"]>;

/**
 * 派生 SQLite 索引库的 schema 定义。
 *
 * 内联在此处而非外部 .sql 文件,确保 tsc emit 后 dist/ 自包含、无需额外资源复制步骤。
 *
 * 版本化:SCHEMA_VERSION 写入 schema_version 表。open() 时若磁盘版本与代码版本不符,
 * 全量 DROP 后重建。SQLite 是纯派生数据(.md 文件才是真理源),DROP 后 cold-start
 * rebuild 会在单个 transaction 里从 .md 灌回,语义上等价于"清缓存"。
 * 这避免了 ALTER TABLE 增量迁移的复杂度与兼容包袱。
 */
const SCHEMA_SQL = `
-- 主表:engram 元数据
CREATE TABLE IF NOT EXISTS engrams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  updated_at INTEGER NOT NULL,
  content_size INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_engrams_updated ON engrams(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_importance ON engrams(importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_created ON engrams(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_retrieval ON engrams(retrieval_count DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_created_by ON engrams(created_by);

-- 多值 tag
CREATE TABLE IF NOT EXISTS engram_domains (
  engram_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  PRIMARY KEY (engram_id, domain),
  FOREIGN KEY (engram_id) REFERENCES engrams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domains_domain ON engram_domains(domain);

-- 突触
CREATE TABLE IF NOT EXISTS synapses (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  FOREIGN KEY (from_id) REFERENCES engrams(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES engrams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_synapses_from ON synapses(from_id);
CREATE INDEX IF NOT EXISTS idx_synapses_to ON synapses(to_id);

-- FTS5 trigram
CREATE VIRTUAL TABLE IF NOT EXISTS engram_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  content_tokens,
  tokenize = 'trigram'
);

-- schema 版本号。open() 时若版本不符,DROP 全部表后重建。SQLite 是纯派生数据,
-- 重建在 cold-start 阶段从 .md 灌回,语义等价于"清缓存",避免 ALTER TABLE 复杂度。
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

/**
 * 当前 schema 版本号。schema 任何不向后兼容的变更都必须 +1。
 *
 * v2(2026-07):engrams 表加 summary / retrieval_count / created_at 三列,
 * 配套 idx_engrams_created / idx_engrams_retrieval 索引。
 * 目的:viewer /api/engrams 改 SQL 查询后,这三个字段必须可在 SQLite 取得,
 * 避免 N+1 readEngram 卡死(1024 条 engram 让 gateway event loop 完全堵塞)。
 *
 * v3(2026-07):engrams 表加 created_by 列。
 * 目的:viewer /api/stats 的 topContributors 聚合完全走 SQL,避免 26 条
 * readEngram × assembleEngram(listSynapsesForEngram 扫 1826 文件)卡 24s。
 */
const SCHEMA_VERSION = 3;

export interface IndexDbOptions {
  readonly dbPath: string;
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
  /**
   * 检索命中次数(累计)。viewer list 用此字段排序,需要在 SQLite 端可达以避免
   * 每次请求 N+1 readEngram。createEngram 写 0,bumpRetrievalStats 走增量 UPDATE。
   */
  readonly retrievalCount?: number;
  /** epoch ms,viewer 按 createdAt 排序用。createEngram 写,后续不变 */
  readonly createdAt?: number;
  /**
   * 创建者标识(对应 frontmatter 的 createdBy 字段)。viewer /api/stats 的
   * topContributors 聚合用此字段 GROUP BY,避免 N+1 readEngram 卡 24s
   * (2026-07 schema v3 修复)。
   */
  readonly createdBy?: string;
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
  private db: SqliteDb | null = null;
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
    // 版本检查:旧版 db 或损坏 db → DROP 后重建。SQLite 是纯派生数据,
    // 缺失行由 cold-start rebuild 从 .md 灌回。SCHEMA_SQL 用 IF NOT EXISTS 兜底,
    // 但版本不符时主动 DROP 整张表强制同步到当前 schema。
    this.migrateSchema();
    // 初始化 schema(内联 SCHEMA_SQL,无外部文件依赖)
    this.db.exec(SCHEMA_SQL);
    // 写入当前版本(schema_version 表 IF NOT EXISTS 后,首行未初始化时插入)
    this.writeSchemaVersion();
  }

  /**
   * Schema 版本检查与迁移。
   *
   * 策略:任何不向后兼容的 schema 变更都 +SCHEMA_VERSION。open() 时若磁盘版本
   * 与代码版本不符(包括首次创建 / 旧版 / 损坏),DROP 全部派生表后让 SCHEMA_SQL
   * 重建。SQLite 行可由 .md 文件 cold-start rebuild 完整恢复,语义等价于"清缓存"。
   *
   * 比 ALTER TABLE 简单:不写迁移脚本、不留兼容代码、不担心半迁移状态。
   */
  private migrateSchema(): void {
    // schema_version 表可能不存在(首次创建)→ 创建后 version 默认 0
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    `);
    const row = this.db!.prepare(
      "SELECT version FROM schema_version LIMIT 1",
    ).get() as { version?: number } | undefined;
    const diskVersion = row?.version ?? 0;
    if (diskVersion === SCHEMA_VERSION) return;
    // 版本不符 → DROP 派生表,SCHEMA_SQL 会重建空表
    this.db!.exec("DROP TABLE IF EXISTS engram_fts");
    this.db!.exec("DROP TABLE IF EXISTS synapses");
    this.db!.exec("DROP TABLE IF EXISTS engram_domains");
    this.db!.exec("DROP TABLE IF EXISTS engrams");
    this.db!.exec("DROP TABLE IF EXISTS schema_version");
  }

  /** 把 SCHEMA_VERSION 写入 schema_version 表(单行) */
  private writeSchemaVersion(): void {
    this.db!.exec("DELETE FROM schema_version");
    this.db!.prepare(
      "INSERT INTO schema_version (version) VALUES (?)",
    ).run(SCHEMA_VERSION);
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
    this.transaction(() => this.upsertEngramUnsafe(entry));
  }

  /**
   * 内部 UPSERT(无事务包裹)。调用方必须已在外层 transaction 内。
   *
   * 单条写入走 upsertEngram;批量 cold start rebuild 走 rebuildFromEntries,
   * 后者在单个 transaction 里循环调用本方法,避免每条都 BEGIN/COMMIT。
   */
  private upsertEngramUnsafe(entry: EngramIndexEntry): void {
    const retrievalCount = entry.retrievalCount ?? 0;
    const createdAt = entry.createdAt ?? entry.updatedAt;
    const createdBy = entry.createdBy ?? "";
    this.prepare(`
      INSERT INTO engrams (id, title, kind, importance, confidence, updated_at, content_size, visibility, status, summary, retrieval_count, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        importance = excluded.importance,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        content_size = excluded.content_size,
        visibility = excluded.visibility,
        status = excluded.status,
        summary = excluded.summary,
        retrieval_count = excluded.retrieval_count,
        created_at = excluded.created_at,
        created_by = excluded.created_by
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
      entry.summary,
      retrievalCount,
      createdAt,
      createdBy,
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
  }

  /**
   * 轻量增量更新:retrieval_count +N。bumpRetrievalStats 高频调用时避免全字段 upsert。
   *
   * 不更新 updated_at(那是内容修改时间,与 retrieval 计数无关)。
   * 不更新 FTS(检索次数变化不影响倒排)。
   */
  bumpRetrievalCount(engramId: string, delta: number): void {
    if (delta === 0) return;
    this.prepare(
      "UPDATE engrams SET retrieval_count = retrieval_count + ? WHERE id = ?",
    ).run(delta, engramId);
  }

  /**
   * 查询 engrams(viewer list / cursor pagination 用)。
   *
   * 设计目标:消除 viewer /api/engrams 的 N+1 readEngram 卡死。所有 viewer list
   * 排序所需字段(createdAt / updatedAt / importance / retrievalCount / title)都在
   * engrams 主表里,SQL ORDER BY + LIMIT 直接搞定,无需"先 list 再 enriched"。
   *
   * 过滤:
   *   - kind:精确匹配
   *   - domainTags:OR 语义(任一匹配即保留),通过 engram_domains 表 EXISTS 子查询
   *
   * 排序:createdAt / updatedAt / importance / retrievalCount / title,asc/desc。
   *
   * 分页:cursor 是上一页最后一条的 (sortField, id) 编码,提供时走 WHERE 半开区间。
   * 不提供 cursor 时返回头页。total 不依赖 cursor,用于 UI 显示"共 N 条"。
   *
   * 返回字段:engram 主表所有列 + domainTags(JSON 聚合)。无 summary 详情页另请求。
   */
  queryEngrams(opts: {
    readonly kind?: string;
    readonly domainTags?: readonly string[];
    readonly sort?: "createdAt" | "updatedAt" | "importance" | "retrievalCount" | "title";
    readonly descending?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
  }): { readonly results: readonly EngramQueryRow[]; readonly total: number } {
    const sort = opts.sort ?? "updatedAt";
    const descending = opts.descending ?? true;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const dir = descending ? "DESC" : "ASC";

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.kind) {
      where.push("e.kind = ?");
      params.push(opts.kind);
    }
    if (opts.domainTags && opts.domainTags.length > 0) {
      const placeholders = opts.domainTags.map(() => "?").join(",");
      where.push(
        `EXISTS (SELECT 1 FROM engram_domains d WHERE d.engram_id = e.id AND d.domain IN (${placeholders}))`,
      );
      for (const t of opts.domainTags) params.push(t);
    }

    // cursor 是 base64(sortValue|id),保证翻页稳定。同 sortValue 时按 id 二级排序。
    const sortColumn =
      sort === "createdAt"
        ? "e.created_at"
        : sort === "importance"
          ? "e.importance"
          : sort === "retrievalCount"
            ? "e.retrieval_count"
            : sort === "title"
              ? "e.title"
              : "e.updated_at";
    const idColumn = "e.id";

    // count(*) 必须用「不含 cursor」的 where:否则 total 会随 cursor 前进而递减
    // (返回的是「剩余数」而非「绝对总数」),UI 上「已加载 1026 / 共 26」的反转 bug
    // 即源于此。snapshot 当前 where/params 长度,cursor 条件在快照之后追加。
    const preCursorWhereCount = where.length;
    const preCursorParamCount = params.length;
    if (opts.cursor) {
      const decoded = decodeQueryCursor(opts.cursor);
      if (decoded) {
        const [sortVal, idVal] = decoded;
        // 半开区间:DESC 时 cursor 之前的(更小),ASC 时 cursor 之后的(更大)
        const op = descending ? "<" : ">";
        // 同 sortVal 时按 id 二级排序保证唯一
        const idOp = descending ? "<" : ">";
        where.push(
          `(${sortColumn} ${op} ? OR (${sortColumn} = ? AND ${idColumn} ${idOp} ?))`,
        );
        params.push(sortVal, sortVal, idVal);
      }
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const countWhereClause = preCursorWhereCount > 0
      ? `WHERE ${where.slice(0, preCursorWhereCount).join(" AND ")}`
      : "";
    const countParams = params.slice(0, preCursorParamCount);

    // total:不依赖 cursor,UI 显示总量用
    const totalRow = this.prepare(
      `SELECT count(*) as n FROM engrams e ${countWhereClause}`,
    ).get(...countParams) as { n: number };
    const total = totalRow?.n ?? 0;

    const rows = this.prepare(
      `SELECT
         e.id, e.title, e.kind, e.importance, e.confidence,
         e.updated_at as updatedAt,
         e.created_at as createdAt,
         e.content_size as contentSize,
         e.visibility, e.status, e.summary,
         e.retrieval_count as retrievalCount
       FROM engrams e
       ${whereClause}
       ORDER BY ${sortColumn} ${dir}, ${idColumn} ${dir}
       LIMIT ?`,
    ).all(...params, limit) as unknown as EngramQueryRow[];

    return { results: rows, total };
  }

  /**
   * 按 status / kind / visibility 分组统计(单次 SQL,替代 N+1 readEngram)。
   *
   * viewer /api/status 用本方法替代 computeStatus 内的 N+1 readEngram 路径
   * (1026 engrams 走 N+1 同步 readEngram 会让 viewer event loop 阻塞 30 秒)。
   * 不传 indexDb 时(CLI 场景)computeStatus 仍走 N+1 兜底。
   */
  countGrouped(): {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byKind: Readonly<Record<string, number>>;
    readonly byVisibility: Readonly<Record<string, number>>;
    readonly total: number;
  } {
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byVisibility: Record<string, number> = {};
    let total = 0;
    const rows = this.prepare(
      `SELECT status, kind, visibility, count(*) as n FROM engrams GROUP BY status, kind, visibility`,
    ).all() as { status: string; kind: string; visibility: string; n: number }[];
    for (const r of rows) {
      const n = r.n;
      total += n;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + n;
      byVisibility[r.visibility] = (byVisibility[r.visibility] ?? 0) + n;
    }
    return { byStatus, byKind, byVisibility, total };
  }

  /**
   * Cold start 重建:用 entries 全量替换 SQLite 索引内容。
   *
   * 用例:host 启动时检测到 .co-engram/index.db 缺失或损坏 → 扫描所有
   * engrams/*.md → 调本方法一次性灌入。
   *
   * 实现:
   * - 单个 transaction 内:DELETE engrams(CASCADE 清 domains + synapses)
   *   + DELETE engram_fts(FTS 不参与外键,手动清)+ 批量 upsertEngramUnsafe。
   * - 中途任一步失败 → rollback,SQLite 保持原状(数据可能旧但一致)。
   * - 调用方决定是否清空 synapses:本方法不重建 synapses(它们由 synapse
   *   create 路径单独维护),CASCADE 会把它们一并清掉,rebuild 期间 synapse
   *   数据丢失是可接受的(可以从 markdown frontmatter 重新解析)。
   */
  rebuildFromEntries(entries: readonly EngramIndexEntry[]): void {
    this.transaction(() => {
      this.exec("DELETE FROM engrams");
      this.exec("DELETE FROM engram_fts");
      for (const e of entries) {
        this.upsertEngramUnsafe(e);
      }
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

/**
 * queryEngrams 返回的单行结构。所有列别名都已 normalize 成 camelCase,
 * viewer 直接 JSON 化返回前端。
 *
 * 注意:row.importance / retrievalCount 是 number,row.updatedAt / createdAt 是 epoch ms
 * (number)。前端如需 ISO 字符串自行转换。
 */
export interface EngramQueryRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly confidence: number;
  readonly updatedAt: number;
  readonly createdAt: number;
  readonly contentSize: number;
  readonly visibility: string;
  readonly status: string;
  readonly summary: string;
  readonly retrievalCount: number;
}

/**
 * 编码 queryEngrams 翻页 cursor(JSON [sortValue, id] → base64url)。
 *
 * 与 `index-db-cursor.ts` 的 encodeCursor 区别:本 helper 用于 viewer list 的多 sort
 * 字段(createdAt / updatedAt / importance / retrievalCount / title),不固定 SortKey。
 * 两套 cursor 在 API 边界隔离(engram_list MCP 工具用 SortKey 那套,
 * viewer /api/engrams 用本 helper)。
 */
export function encodeQueryCursor(
  sortValue: string | number,
  id: string,
): string {
  const json = JSON.stringify([sortValue, id]);
  return Buffer.from(json, "utf8").toString("base64url");
}

/** 解码 queryEngrams cursor,失败返回 null(调用方按"无 cursor"处理,返回头页)。 */
export function decodeQueryCursor(
  cursor: string,
): readonly [string | number, string] | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === "string" || typeof parsed[0] === "number") &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
    return null;
  } catch {
    return null;
  }
}
