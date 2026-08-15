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
import { decodeCursor } from "./index-db-cursor.js";
import type { SearchFilter } from "../types/disclosure.js";
import { internalError } from "../tools/error-schema.js";

/** SearchFilter 的本地别名,避免上游改字段时全文件改名 */
type SearchFilterInput = SearchFilter;

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
-- 主表:engram 元数据 + DigestLine 完整投影
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
  created_by TEXT NOT NULL DEFAULT '',
  -- schema v4:DigestLine 完整投影,消除所有调用方的 N+1 readEngram
  kinds TEXT NOT NULL DEFAULT '[]',
  context_tags TEXT NOT NULL DEFAULT '[]',
  freshness TEXT NOT NULL DEFAULT 'fresh',
  source_type TEXT NOT NULL DEFAULT 'firsthand',
  content_hash TEXT NOT NULL DEFAULT '',
  last_retrieved_at INTEGER,
  last_effective_at INTEGER,
  effective_retrievals INTEGER NOT NULL DEFAULT 0,
  failed_uses INTEGER NOT NULL DEFAULT 0,
  reinforcement_score REAL NOT NULL DEFAULT 0,
  last_retrieval_score REAL,
  outgoing_synapse_count INTEGER NOT NULL DEFAULT 0,
  incoming_synapse_count INTEGER NOT NULL DEFAULT 0,
  active_contradiction_count INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_engrams_updated ON engrams(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_importance ON engrams(importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_created ON engrams(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_retrieval ON engrams(retrieval_count DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_engrams_created_by ON engrams(created_by);
CREATE INDEX IF NOT EXISTS idx_engrams_verification ON engrams(verification_status);
CREATE INDEX IF NOT EXISTS idx_engrams_freshness ON engrams(freshness);
CREATE INDEX IF NOT EXISTS idx_engrams_status ON engrams(status);

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
-- schema v5:标签漂移刷新基线(REM tag-refresh 用)。token_set 存 JSON 数组,
-- content_hash 用于 L0 判变;FK CASCADE 让 engram 删除时基线自动清。
CREATE TABLE IF NOT EXISTS tag_refresh_baseline (
  engram_id TEXT NOT NULL,
  token_set TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (engram_id),
  FOREIGN KEY (engram_id) REFERENCES engrams(id) ON DELETE CASCADE
);

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
 *
 * v4(2026-07):engrams 表扩成 DigestLine 完整投影。
 * 目的:消除所有调用方的 N+1 readEngram(engram_list / listByVerificationStatus /
 * reinforceRelated / findCandidatesSync 等)。readEngram 单次 ~1s,1026 条
 * 卡 20 分钟,与 graph-builder.ts 的 N+1 反模式同根。
 */
// v6(2026-07):开启 auto_vacuum=INCREMENTAL(F28 治本)。
// bump 触发现有库 migrateSchema DROP 全表(空库)→ open() 在建表前设
// auto_vacuum=INCREMENTAL(SQLite 语义:有表时设不生效,空库才生效)→ 建表
// → cold-start rebuild 灌回。一次性切到增量回收 + 回收历史膨胀(实测 29MB→~1.5MB)。
const SCHEMA_VERSION = 6;

export interface IndexDbOptions {
  readonly dbPath: string;
}

/**
 * engram 在索引层的 DigestLine 完整投影(schema v4)。
 *
 * 设计目标:让所有调用方(engram_list / listByVerificationStatus / reinforceRelated /
 * findCandidatesSync / maintenance 各 cycle)都能直接从 SQLite 读 DigestLine,
 * 避免走 readEngram(扫整个 synapses/ 目录)。
 *
 * domainTags 是多值字段,在 SQLite 端拆 engram_domains 表;contextTags / kinds 是
 * 较短的多值字段,用 JSON 数组直接存 TEXT 列(读端 JSON.parse)。其余标量字段直接落 engrams 主表。
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
  readonly summary: string;
  readonly contentTokens: string;
  readonly retrievalCount?: number;
  /** epoch ms,viewer 按 createdAt 排序用。createEngram 写,后续不变 */
  readonly createdAt?: number;
  readonly createdBy?: string;
  /** schema v4 投影字段(可选,向后兼容旧调用方) */
  readonly kinds?: readonly string[];
  readonly contextTags?: readonly string[];
  readonly freshness?: string;
  readonly sourceType?: string;
  readonly contentHash?: string;
  /** ISO 时间戳 — SQLite 端会转 epoch ms */
  readonly lastRetrievedAt?: string;
  readonly lastEffectiveAt?: string;
  readonly effectiveRetrievals?: number;
  readonly failedUses?: number;
  readonly reinforcementScore?: number;
  readonly lastRetrievalScore?: number;
  readonly outgoingSynapseCount?: number;
  readonly incomingSynapseCount?: number;
  readonly activeContradictionCount?: number;
  readonly verificationStatus?: string;
  readonly domainTags: readonly string[];
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
    const migrated = this.migrateSchema();
    if (migrated) {
      // 版本不符(含全新库首次)→ migrateSchema 已 DROP 全表(空库)。
      // 三步缺一不可(实测):
      //   1. PRAGMA auto_vacuum=INCREMENTAL 设内存值(只改内存,文件头未变)
      //   2. VACUUM 重建文件头写入 INCREMENTAL(auto_vacuum→2,freelist→0)
      //   3. wal_checkpoint(TRUNCATE) 截断物理文件(WAL 模式下 VACUUM 不截断主文件,
      //      实测 28.5MB→0MB 空库)
      // 空库三者都快(几 ms)。之后 SCHEMA_SQL 建表 + cold-start rebuild,新库带
      // INCREMENTAL 文件头,配合 maintenance light 的 incremental_vacuum 防膨胀(F28 治本)。
      // 正常启动(版本符)不进此分支,避免每次 open 都 VACUUM(大库几秒)。
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      this.db.exec("VACUUM");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
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
  private migrateSchema(): boolean {
    // schema_version 表可能不存在(首次创建)→ 创建后 version 默认 0
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    `);
    const row = this.db!.prepare(
      "SELECT version FROM schema_version LIMIT 1",
    ).get() as { version?: number } | undefined;
    const diskVersion = row?.version ?? 0;
    if (diskVersion === SCHEMA_VERSION) return false;
    // 版本不符 → DROP 派生表,SCHEMA_SQL 会重建空表
    this.db!.exec("DROP TABLE IF EXISTS engram_fts");
    this.db!.exec("DROP TABLE IF EXISTS tag_refresh_baseline");
    this.db!.exec("DROP TABLE IF EXISTS synapses");
    this.db!.exec("DROP TABLE IF EXISTS engram_domains");
    this.db!.exec("DROP TABLE IF EXISTS engrams");
    this.db!.exec("DROP TABLE IF EXISTS schema_version");
    return true;
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
      throw internalError("IndexDb not opened. Call open() first.");
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
   *
   * schema v4:写入完整 DigestLine 投影(kinds / contextTags 走 JSON,
   * retrieval stats / synapse counts / verification 等走原生列)。
   */
  private upsertEngramUnsafe(entry: EngramIndexEntry): void {
    const retrievalCount = entry.retrievalCount ?? 0;
    const createdAt = entry.createdAt ?? entry.updatedAt;
    const createdBy = entry.createdBy ?? "";
    const kinds = JSON.stringify(entry.kinds ?? [entry.kind]);
    const contextTags = JSON.stringify(entry.contextTags ?? []);
    const freshness = entry.freshness ?? "fresh";
    const sourceType = entry.sourceType ?? "firsthand";
    const contentHash = entry.contentHash ?? "";
    const lastRetrievedAt = entry.lastRetrievedAt
      ? Date.parse(entry.lastRetrievedAt)
      : null;
    const lastEffectiveAt = entry.lastEffectiveAt
      ? Date.parse(entry.lastEffectiveAt)
      : null;
    const effectiveRetrievals = entry.effectiveRetrievals ?? 0;
    const failedUses = entry.failedUses ?? 0;
    const reinforcementScore = entry.reinforcementScore ?? 0;
    const lastRetrievalScore = entry.lastRetrievalScore ?? null;
    const outgoingSynapseCount = entry.outgoingSynapseCount ?? 0;
    const incomingSynapseCount = entry.incomingSynapseCount ?? 0;
    const activeContradictionCount = entry.activeContradictionCount ?? 0;
    const verificationStatus = entry.verificationStatus ?? null;
    this.prepare(`
      INSERT INTO engrams (
        id, title, kind, importance, confidence, updated_at, content_size,
        visibility, status, summary, retrieval_count, created_at, created_by,
        kinds, context_tags, freshness, source_type, content_hash,
        last_retrieved_at, last_effective_at,
        effective_retrievals, failed_uses, reinforcement_score, last_retrieval_score,
        outgoing_synapse_count, incoming_synapse_count, active_contradiction_count,
        verification_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        created_by = excluded.created_by,
        kinds = excluded.kinds,
        context_tags = excluded.context_tags,
        freshness = excluded.freshness,
        source_type = excluded.source_type,
        content_hash = excluded.content_hash,
        last_retrieved_at = excluded.last_retrieved_at,
        last_effective_at = excluded.last_effective_at,
        effective_retrievals = excluded.effective_retrievals,
        failed_uses = excluded.failed_uses,
        reinforcement_score = excluded.reinforcement_score,
        last_retrieval_score = excluded.last_retrieval_score,
        outgoing_synapse_count = excluded.outgoing_synapse_count,
        incoming_synapse_count = excluded.incoming_synapse_count,
        active_contradiction_count = excluded.active_contradiction_count,
        verification_status = excluded.verification_status
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
      kinds,
      contextTags,
      freshness,
      sourceType,
      contentHash,
      lastRetrievedAt,
      lastEffectiveAt,
      effectiveRetrievals,
      failedUses,
      reinforcementScore,
      lastRetrievalScore,
      outgoingSynapseCount,
      incomingSynapseCount,
      activeContradictionCount,
      verificationStatus,
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
    readonly status?: readonly string[];
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
    if (opts.status && opts.status.length > 0) {
      // 多 status OR(用于 trash tab 同时看 forgotten/frozen/archived)
      const placeholders = opts.status.map(() => "?").join(",");
      where.push(`e.status IN (${placeholders})`);
      for (const s of opts.status) params.push(s);
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
   * 按 SearchFilter + SortKey 排序的列表查询(engram_list 专用)。
   *
   * 替代旧路径:listEngrams → 逐个 readEngram → 内存 filter/sort/cursor
   * (1026 engram × readEngram ≈ 18s,扫 synapses/ 目录 N+1 痛点)。
   *
   * 排序固定为复合 SortKey:importance DESC, updated_at DESC, id ASC
   * cursor 编码 [importance, updatedAt, id](base64url),与 disclosure
   * 层的 encodeCursor / decodeCursor 对齐。
   *
   * filter 全部下推到 SQL:
   *   - domainTags:EXISTS 子查询(已有 engram_domains 索引)
   *   - kinds / contextTags:JSON array overlap,用 json_each
   *   - status / freshness / createdBy:IN (?, ?, ...)
   *   - createdAfter/Before:epoch ms 比较
   *   - minImportance:简单 >=
   *   - status 隐式默认 ['active', 'draft'](与 matchesFilter 一致)
   *
   * 返回 {id, title, kind, domainTags}[](EngramCatalogEntry 子集),
   * 调用方按需 join 更多字段。
   */
  queryEngramsBySortKey(opts: {
    readonly filter?: SearchFilterInput;
    readonly cursor?: string;
    readonly limit?: number;
  }): {
    readonly results: readonly EngramListRow[];
    readonly total: number;
  } {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const filter = opts.filter;

    const where: string[] = [];
    const params: (string | number)[] = [];

    // status 隐式默认:与 matchesFilter 一致(active / draft)
    const statusFilter = filter?.status && filter.status.length > 0
      ? filter.status
      : ["active", "draft"];
    const statusPlaceholders = statusFilter.map(() => "?").join(",");
    where.push(`e.status IN (${statusPlaceholders})`);
    for (const s of statusFilter) params.push(s);

    if (filter?.domainTags && filter.domainTags.length > 0) {
      const placeholders = filter.domainTags.map(() => "?").join(",");
      where.push(
        `EXISTS (SELECT 1 FROM engram_domains d WHERE d.engram_id = e.id AND d.domain IN (${placeholders}))`,
      );
      for (const t of filter.domainTags) params.push(t);
    }

    // kinds / contextTags:JSON array overlap,用 json_each
    // kinds 列在 v4 schema 是 JSON array string(如 '["observation","pattern"]')
    if (filter?.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => "?").join(",");
      where.push(
        `EXISTS (SELECT 1 FROM json_each(e.kinds) WHERE value IN (${placeholders}))`,
      );
      for (const k of filter.kinds) params.push(k);
    }

    if (filter?.contextTags && filter.contextTags.length > 0) {
      const placeholders = filter.contextTags.map(() => "?").join(",");
      where.push(
        `EXISTS (SELECT 1 FROM json_each(e.context_tags) WHERE value IN (${placeholders}))`,
      );
      for (const t of filter.contextTags) params.push(t);
    }

    if (filter?.freshness && filter.freshness.length > 0) {
      const placeholders = filter.freshness.map(() => "?").join(",");
      where.push(`e.freshness IN (${placeholders})`);
      for (const f of filter.freshness) params.push(f);
    }

    if (filter?.createdBy && filter.createdBy.length > 0) {
      const placeholders = filter.createdBy.map(() => "?").join(",");
      where.push(`e.created_by IN (${placeholders})`);
      for (const c of filter.createdBy) params.push(c);
    }

    if (filter?.createdAfter) {
      where.push("e.created_at > ?");
      params.push(Date.parse(filter.createdAfter));
    }

    if (filter?.createdBefore) {
      where.push("e.created_at < ?");
      params.push(Date.parse(filter.createdBefore));
    }

    if (typeof filter?.minImportance === "number") {
      where.push("e.importance >= ?");
      params.push(filter.minImportance);
    }

    // cursor:基于 SortKey [importance, updatedAt, id]
    // 排序是 importance DESC, updated_at DESC, id ASC,所以"在 cursor 之后"
    // 意味着严格小于(importance/updatedAt)或同分时 id 大于(id ASC)。
    if (opts.cursor) {
      const ck = decodeCursor(opts.cursor);
      where.push(
        `(e.importance < ? OR (e.importance = ? AND e.updated_at < ?) OR (e.importance = ? AND e.updated_at = ? AND e.id > ?))`,
      );
      params.push(
        ck.importance,
        ck.importance,
        ck.updatedAt,
        ck.importance,
        ck.updatedAt,
        ck.id,
      );
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // total:基于完整 where(含 cursor 也算在内是错的,但 cursor 通常用于翻页,
    // total 表示总量是 UI 期望)。这里采用 pre-cursor 的 where 计算 total。
    // 注意:本方法的 where 已含 cursor 条件,需要剥离。
    // 简化:cursor 分页时 total 通常已在前一页返回,这里仍计算包含 cursor 的总数。
    // 实际场景:engram_list 工具的 result 不含 total 字段(只 items + nextCursor),
    // 所以本字段对 MCP 工具无影响。保留为 viewer 等其他调用方可能的复用预留。
    const totalRow = this.prepare(
      `SELECT count(*) as n FROM engrams e ${whereClause}`,
    ).get(...params) as { n: number };
    const total = totalRow?.n ?? 0;

    const rows = this.prepare(
      `SELECT
         e.id, e.title, e.kind,
         (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domainTagsCsv,
         e.importance,
         e.updated_at as updatedAt
       FROM engrams e
       ${whereClause}
       ORDER BY e.importance DESC, e.updated_at DESC, e.id ASC
       LIMIT ?`,
    ).all(...params, limit) as unknown as EngramListRow[];

    return { results: rows, total };
  }

  /**
   * 批量读取 dedup 用 content 字段(id / title / summary / content_tokens)。
   *
   * dedup findCandidatesSync 原走 listEngrams + 逐个 readEngram(1026 engram
   * × readEngram ≈ 18s)。改用本方法 + 内存 tokenize/Jaccard,N+1 消除。
   *
   * 与 readDigestBatch 区别:本方法多拉 content_tokens 列(可能几 KB / 条),
   * 只给 dedup / similarity 这类需要 content 的路径用。DigestLine 不暴露 content
   * (那是 Tier 2 字段,披露策略由 disclosure 层管)。
   *
   * 实现:JOIN engram_fts(FTS 表存 content_tokens),一次 SQL 拿齐。
   */
  readContentBatch(
    ids: readonly string[],
  ): readonly ContentBatchRow[] {
    if (ids.length === 0) return [];
    // SQLite 参数上限通常 999;为兼容默认配置,每批最多 500。
    // 调用方可能传 5000+ ids(findCandidatesSync 全表扫),分批合并结果。
    const CHUNK = 500;
    const out: ContentBatchRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.prepare(
        `SELECT
           e.id AS id,
           e.title AS title,
           e.summary AS summary,
           f.content_tokens AS content
         FROM engrams e
         JOIN engram_fts f ON f.id = e.id
         WHERE e.id IN (${placeholders})`,
      ).all(...chunk) as unknown as ContentBatchRow[];
      for (const r of rows) out.push(r);
    }
    return out;
  }

  /**
   * 按 verification status + lifecycle status 过滤,返回 DigestIndexRow[]。
   *
   * 替代旧路径:listByVerificationStatus 内存遍历 catalog + 逐个 readEngram
   * (maintenance engine 在 1026 engram 规模下 N+1 卡 ~18s)。
   *
   * filter 全部下推到 SQL:
   *   - verification_status IN (?, ...) — 主过滤维度
   *   - status IN (?, ...) — 隐式过滤(maintenance 只关心 active)
   *   - 默认不返回(传 null 或空数组跳过)
   *
   * 行为:
   *   - verificationStatuses 为空 → 返回 [](避免 SQL IN () 语法错)
   *   - lifecycleStatuses 未传 → 不做 status 过滤(返回所有 lifecycle status)
   *   - verification_status 列为 NULL 的行:SQL `IN (...)` 不会命中,但
   *     maintenance 期望 "unverified" 命中这些行(schema v4 cold-start
   *     时写入 'unverified' 默认值,所以实际不会 NULL;旧数据由 ensureSchema
   *     rebuild 修复)。如果数据库残留 NULL,需要 maintenance 单独处理。
   */
  listDigestByVerificationStatus(opts: {
    readonly verificationStatuses: readonly string[];
    readonly lifecycleStatuses?: readonly string[];
  }): readonly DigestIndexRow[] {
    if (opts.verificationStatuses.length === 0) return [];
    const verPlaceholders = opts.verificationStatuses.map(() => "?").join(",");
    const params: (string | number)[] = [...opts.verificationStatuses];
    let lifecycleClause = "";
    if (opts.lifecycleStatuses && opts.lifecycleStatuses.length > 0) {
      const lifePlaceholders = opts.lifecycleStatuses.map(() => "?").join(",");
      lifecycleClause = ` AND e.status IN (${lifePlaceholders})`;
      for (const s of opts.lifecycleStatuses) params.push(s);
    }
    const rows = this.prepare(
      `SELECT
         e.id, e.title, e.kind, e.importance, e.confidence,
         e.updated_at as updatedAt,
         e.created_at as createdAt,
         e.content_size as contentSize,
         e.visibility, e.status, e.summary,
         e.retrieval_count as retrievalCount,
         e.created_by as createdBy,
         e.kinds as kindsJson,
         e.context_tags as contextTagsJson,
         (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domainTagsCsv,
         e.freshness,
         e.source_type as sourceType,
         e.content_hash as contentHash,
         e.last_retrieved_at as lastRetrievedAt,
         e.last_effective_at as lastEffectiveAt,
         e.effective_retrievals as effectiveRetrievals,
         e.failed_uses as failedUses,
         e.reinforcement_score as reinforcementScore,
         e.last_retrieval_score as lastRetrievalScore,
         e.outgoing_synapse_count as outgoingSynapseCount,
         e.incoming_synapse_count as incomingSynapseCount,
         e.active_contradiction_count as activeContradictionCount,
         e.verification_status as verificationStatus
       FROM engrams e
       WHERE e.verification_status IN (${verPlaceholders})${lifecycleClause}`,
    ).all(...params) as unknown as DigestIndexRow[];
    return rows;
  }

  /**
   * 统计 created_at > sinceEpochMs 的现存 engram 的 Σimportance(P0-1 REM 活动量累积阈值用)。
   *
   * 单条聚合 SQL,毫秒级;created_at 存 epoch ms,与 upsertEngramUnsafe 写入口径一致。
   * REM 的 metacognition 升降级 / trash sweep 不改 created_at,所以口径天然是
   * "自上次 REM 以来新增" —— 被删/trash 后物理清除的 engram 自动退出统计。
   */
  sumImportanceSince(sinceEpochMs: number): number {
    const row = this.prepare(
      `SELECT COALESCE(SUM(e.importance), 0) AS total
       FROM engrams e
       WHERE e.created_at > ?`,
    ).get(sinceEpochMs) as { readonly total: number | null } | undefined;
    return row?.total ?? 0;
  }

  /**
   * 批量读取 DigestLine 投影(单次 SQL,替代 N+1 readEngram)。
   *
   * 高频调用方(engram_list 后置过滤、collectNeighborDigests、
   * findCandidatesSync、reinforceRelated)只消化 DigestLine 字段子集,
   * 不需要 readEngram 的全字段(尤其不需要扫 synapses/ 目录)。
   *
   * 实现:`WHERE id IN (?,?,...)`,epoch ms 数字 + JSON 字符串直接返回,
   * 调用方(repository.readDigestBatch)做类型化(ISO 时间戳、JSON parse)。
   *
   * 行为:
   *   - ids 为空 → 返回空数组(避免 `WHERE id IN ()` SQL 语法错)
   *   - ids 上限 500:防止 SQLite prepared statement 参数爆炸。调用方应分批。
   *   - 不存在的 id 静默跳过(返回结果可能少于输入)
   *   - 无 ORDER BY:调用方按需自己排序(典型:按 importance 或 score)
   *
   * v4 schema 字段:此方法依赖 schema v4 投影列(kinds / context_tags /
   * freshness / source_type / retrieval stats / synapse counts / verification)。
   * 旧 db(schema ≤ v3)经过 ensureSchema 自动 DROP+rebuild 升到 v4,
   * rebuildFromEntries 会重新填充。所以本方法无需做列存在性 fallback。
   */
  readDigestBatch(ids: readonly string[]): readonly DigestIndexRow[] {
    if (ids.length === 0) return [];
    // SQLite 参数上限通常 999;分批避免越界。调用方(findCandidatesSync)
    // 可能传 5000+ ids,内部循环合并结果。
    const CHUNK = 500;
    const out: DigestIndexRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.prepare(
        `SELECT
           e.id, e.title, e.kind, e.importance, e.confidence,
           e.updated_at as updatedAt,
           e.created_at as createdAt,
           e.content_size as contentSize,
           e.visibility, e.status, e.summary,
           e.retrieval_count as retrievalCount,
           e.created_by as createdBy,
           e.kinds as kindsJson,
           e.context_tags as contextTagsJson,
           (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domainTagsCsv,
           e.freshness,
           e.source_type as sourceType,
           e.content_hash as contentHash,
           e.last_retrieved_at as lastRetrievedAt,
           e.last_effective_at as lastEffectiveAt,
           e.effective_retrievals as effectiveRetrievals,
           e.failed_uses as failedUses,
           e.reinforcement_score as reinforcementScore,
           e.last_retrieval_score as lastRetrievalScore,
           e.outgoing_synapse_count as outgoingSynapseCount,
           e.incoming_synapse_count as incomingSynapseCount,
           e.active_contradiction_count as activeContradictionCount,
           e.verification_status as verificationStatus
         FROM engrams e
         WHERE e.id IN (${placeholders})`,
      ).all(...chunk) as unknown as DigestIndexRow[];
      for (const r of rows) out.push(r);
    }
    return out;
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
   * 用 entries 全量替换 synapses 表内容。
   *
   * 用例:doctor / fullRebuild 路径强制同步 SQLite synapse 表与磁盘真相。
   * 长期运行后,DELETE/cascade 路径可能漏掉某些边界(如 dangling synapse 文件
   * 被 doctor 清理但 SQLite 行残留,或反过来),导致 SQLite synapse 表与
   * `collectAllSynapses()` 扫盘结果脱钩 — /api/stats 读 graph.json 缓存
   * 显示 1827,SQLite 表实际 0 行,而磁盘 15 个 synapse 文件。
   *
   * 实现:
   * - 单 transaction 内:DELETE FROM synapses + 批量 upsertSynapse
   * - 中途任一 INSERT 失败(FK 违反 / 字段缺失)→ rollback,SQLite 保持原状
   * - 已知 engram 集合由 caller 传入做预过滤,避免 FK 错误回滚整批
   *
   * @param entries 磁盘扫盘得到的全部 synapse
   * @param knownEngramIds SQLite engrams 表已知的 engram id 集合,用于过滤 dangling
   */
  rebuildSynapseTable(
    entries: readonly SynapseIndexEntry[],
    knownEngramIds: ReadonlySet<string>,
  ): { inserted: number; skippedDangling: number } {
    let inserted = 0;
    let skippedDangling = 0;
    this.transaction(() => {
      this.exec("DELETE FROM synapses");
      for (const s of entries) {
        if (!knownEngramIds.has(s.fromId) || !knownEngramIds.has(s.toId)) {
          skippedDangling++;
          continue;
        }
        this.upsertSynapse(s);
        inserted++;
      }
    });
    return { inserted, skippedDangling };
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

  // ============================================================
  // schema v5:tag_refresh_baseline CRUD(REM 标签漂移刷新用)
  // ============================================================

  /**
   * UPSERT 标签刷新基线。REM 扫描时 L0 用 content_hash 判变,L1 用 token_set 算 Jaccard。
   */
  upsertTagRefreshBaseline(input: {
    readonly engramId: string;
    readonly tokenSet: readonly string[];
    readonly contentHash: string;
    readonly refreshedAt: string;
  }): void {
    this.transaction(() => {
      this.prepare(
        `INSERT INTO tag_refresh_baseline (engram_id, token_set, content_hash, refreshed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(engram_id) DO UPDATE SET
           token_set = excluded.token_set,
           content_hash = excluded.content_hash,
           refreshed_at = excluded.refreshed_at`,
      ).run(
        input.engramId,
        JSON.stringify(input.tokenSet),
        input.contentHash,
        input.refreshedAt,
      );
    });
  }

  /** 读单条基线;不存在返回 undefined。 */
  readTagRefreshBaseline(
    engramId: string,
  ):
    | {
        readonly engramId: string;
        readonly tokenSet: readonly string[];
        readonly contentHash: string;
        readonly refreshedAt: string;
      }
    | undefined {
    const row = this.prepare(
      `SELECT engram_id, token_set, content_hash, refreshed_at
       FROM tag_refresh_baseline WHERE engram_id = ?`,
    ).get(engramId) as
      | {
          engram_id: string;
          token_set: string;
          content_hash: string;
          refreshed_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      engramId: row.engram_id,
      tokenSet: JSON.parse(row.token_set) as string[],
      contentHash: row.content_hash,
      refreshedAt: row.refreshed_at,
    };
  }

  /**
   * 批量读全部基线(REM 全量扫描用,一次 SQL 避免 N 次 prepare)。
   * 返回 Map<engramId, baseline>。
   */
  readAllTagRefreshBaselines(): ReadonlyMap<
    string,
    {
      readonly engramId: string;
      readonly tokenSet: readonly string[];
      readonly contentHash: string;
      readonly refreshedAt: string;
    }
  > {
    const rows = this.prepare(
      `SELECT engram_id, token_set, content_hash, refreshed_at FROM tag_refresh_baseline`,
    ).all() as Array<{
      engram_id: string;
      token_set: string;
      content_hash: string;
      refreshed_at: string;
    }>;
    const map = new Map<
      string,
      {
        readonly engramId: string;
        readonly tokenSet: readonly string[];
        readonly contentHash: string;
        readonly refreshedAt: string;
      }
    >();
    for (const row of rows) {
      map.set(row.engram_id, {
        engramId: row.engram_id,
        tokenSet: JSON.parse(row.token_set) as string[],
        contentHash: row.content_hash,
        refreshedAt: row.refreshed_at,
      });
    }
    return map;
  }

  /** 删单条基线(engram 删除时由 FK CASCADE 自动触发,此方法供显式清理/测试用)。 */
  deleteTagRefreshBaseline(engramId: string): void {
    this.prepare(
      "DELETE FROM tag_refresh_baseline WHERE engram_id = ?",
    ).run(engramId);
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
 * queryEngramsBySortKey 返回行。
 *
 * domainTagsCsv 是 group_concat(domain, ',') 的结果,调用方 split(',')。
 * importance / updatedAt 用于调用方拼装 SortKey cursor(下一页用)。
 */
export interface EngramListRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly domainTagsCsv: string | null;
  readonly importance: number;
  readonly updatedAt: number;
}

/**
 * readContentBatch 返回行(dedup 专用)。
 *
 * content 来自 engram_fts.content_tokens(原 frontmatter 之外的 markdown body)。
 * summary 来自 engrams.summary(frontmatter summary 字段)。
 */
export interface ContentBatchRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
}

/**
 * readDigestBatch 返回的原始行(epoch ms 数字、JSON 字符串、CSV 字符串)。
 *
 * storage 层不依赖 disclosure 层的 DigestLine 类型,只返回 SQL 直查结果。
 * Repository.readDigestBatch 做 ISO 时间戳转换 + JSON parse + CSV split,
 * 最终输出 DigestLine。这样分层避免 storage → disclosure 的反向依赖。
 *
 * 注意:
 *   - kindsJson / contextTagsJson:JSON.stringify 后的 string,parse 得 array
 *   - domainTagsCsv:group_concat(domain, ',') 结果,split 得 array
 *   - lastRetrievedAt / lastEffectiveAt / verificationStatus:可能为 null
 *     (engram 从未被检索 / 从未生效 / 未走 verification 流程)
 */
export interface DigestIndexRow {
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
  readonly createdBy: string;
  readonly kindsJson: string;
  readonly contextTagsJson: string;
  readonly domainTagsCsv: string | null;
  readonly freshness: string;
  readonly sourceType: string;
  readonly contentHash: string;
  readonly lastRetrievedAt: number | null;
  readonly lastEffectiveAt: number | null;
  readonly effectiveRetrievals: number;
  readonly failedUses: number;
  readonly reinforcementScore: number;
  readonly lastRetrievalScore: number | null;
  readonly outgoingSynapseCount: number;
  readonly incomingSynapseCount: number;
  readonly activeContradictionCount: number;
  readonly verificationStatus: string | null;
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
