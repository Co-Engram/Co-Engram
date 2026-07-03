// packages/core/src/retrieval/sqlite-orchestrator.ts
//
// SQLite FTS5 trigram 召回编排器 —— 与 in-memory SearchOrchestrator 平行的
// 实现,作为 Phase 2 PR2 灰度切换的目标引擎。
//
// 核心差异(相对 in-memory orchestrator):
// - 索引数据由 SQLite 持久化(host 启动后无需重建 FTS)
// - 排序由 SQLite bm25() 计算(相关度),不再做三因子融合
//   (Phase 2 只验证召回质量等价 / 不退化;三因子融合在 Phase 3 加回,
//    从 engrams 主表读 importance + updated_at 参与 SQL ORDER BY)
// - 短 query(< 3 UTF-16 code units)走 LIKE 兜底,trigram 无法处理
//
// @module @co-engram/core/retrieval
import type { IndexDb } from "../storage/index-db.js";
import type { EngramCatalogEntry, EngramId, EngramKind } from "../types/engram.js";
import type { SearchFilter } from "../types/disclosure.js";
// 复用 in-memory orchestrator 的 SimpleSearchResult,保证两个引擎互换时
// 上层工具调用方零代码改动。
import type { SimpleSearchResult } from "./orchestrator.js";

/** SqliteSearchOrchestrator 构造参数 */
export interface SqliteSearchOptions {
  readonly db: IndexDb;
  /**
   * 时钟注入(测试用);当前实现未依赖时间,但保留接口便于后续三因子融合。
   */
  readonly nowFn?: () => Date;
}

/** search() 调用选项 */
export interface SearchQueryOptions {
  readonly filter?: SearchFilter;
  readonly limit?: number;
  /**
   * 游标分页(Phase 3 启用);当前实现忽略,只返回 nextCursor=null。
   */
  readonly cursor?: string | null;
}

/** search() 返回结构 */
export interface SearchResponse {
  readonly results: SimpleSearchResult[];
  readonly nextCursor: string | null;
}

/** trigram tokenizer 命中所需的最小 UTF-16 code unit 数 */
const LIKE_FALLBACK_MIN_CHARS = 3;

/**
 * SQLite FTS5 召回编排器。
 *
 * 与 in-memory SearchOrchestrator 接口兼容(same query → SimpleSearchResult[]),
 * 上层 engram_search 工具按 feature flag 切换引擎。
 */
export class SqliteSearchOrchestrator {
  private readonly db: IndexDb;

  constructor(opts: SqliteSearchOptions) {
    this.db = opts.db;
  }

  search(query: string, opts: SearchQueryOptions = {}): SearchResponse {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500);
    const q = query.trim();
    if (!q) return { results: [], nextCursor: null };

    const useLike = q.length < LIKE_FALLBACK_MIN_CHARS;
    const rows = useLike
      ? this.searchByLike(q, limit)
      : this.searchByFts(q, limit);

    const filtered = this.applyPostFilter(rows, opts.filter);

    const results: SimpleSearchResult[] = filtered.map((r) => ({
      id: r.id,
      score: r.score,
      entry: {
        id: r.id,
        title: r.title,
        kind: r.kind as EngramKind,
        domainTags: r.domainTags,
      },
    }));

    return { results, nextCursor: null };
  }

  /** FTS5 trigram MATCH,bm25 排序(负值越优,ASC 即最相关在前) */
  private searchByFts(
    q: string,
    limit: number,
  ): RawSearchRow[] {
    const ftsQuery = this.buildFtsQuery(q);
    if (!ftsQuery) return [];
    const stmt = this.db.prepare(`
      SELECT e.id AS id, e.title AS title, e.kind AS kind, e.importance AS importance,
        (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domain_tags,
        bm25(engram_fts) AS fts_score
      FROM engram_fts
      JOIN engrams e ON e.id = engram_fts.id
      WHERE engram_fts MATCH ?
      ORDER BY fts_score ASC
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, limit) as unknown as Array<SqliteFtsRow>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      importance: r.importance,
      domainTags: splitCsv(r.domain_tags),
      // bm25 返回负值,反转成正数(score 越大越优,与 in-memory 一致)
      score: -r.fts_score,
    }));
  }

  /**
   * LIKE 兜底:1-2 字符 query(trigram 无法处理)或 FTS5 MATCH 无命中时降级。
   *
   * LIKE 覆盖四个文本维度:engrams.title + engram_fts.summary +
   * engram_fts.content_tokens + engram_domains.domain。仅靠 title 召回过窄
   * (中文 1-2 字 query 经常只在 summary / content / domainTags 中出现),
   * 必须扫全部索引文本,与 in-memory FTS 的索引字段对齐。
   *
   * 排序:importance + updatedAt DESC(无相关度信号,用静态质量分代替)。
   */
  private searchByLike(q: string, limit: number): RawSearchRow[] {
    const stmt = this.db.prepare(`
      SELECT e.id AS id, e.title AS title, e.kind AS kind, e.importance AS importance,
        (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domain_tags
      FROM engrams e
      JOIN engram_fts f ON f.id = e.id
      WHERE e.title LIKE ? ESCAPE '\\'
         OR f.summary LIKE ? ESCAPE '\\'
         OR f.content_tokens LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM engram_domains d
           WHERE d.engram_id = e.id AND d.domain LIKE ? ESCAPE '\\'
         )
      ORDER BY e.importance DESC, e.updated_at DESC
      LIMIT ?
    `);
    const pattern = `%${escapeLike(q)}%`;
    const rows = stmt.all(pattern, pattern, pattern, pattern, limit) as unknown as Array<SqliteLikeRow>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      importance: r.importance,
      domainTags: splitCsv(r.domain_tags),
      score: 0,
    }));
  }

  /**
   * 把用户 query 转成 FTS5 MATCH 表达式。
   *
   * 实现:整体作为 FTS5 string query(`"..."` 语法),FTS5 trigram tokenizer
   * 自行切分。`"` 内的双引号 escape 为 `""`(FTS5 标准做法)。
   *
   * 不做手工 trigram 切分:trigram tokenizer 已在 SQL 层做,手工切分反而
   * 会和 tokenizer 双重处理,导致短语匹配失效。
   */
  private buildFtsQuery(query: string): string | null {
    if (!query) return null;
    return `"${query.replace(/"/g, '""')}"`;
  }

  /**
   * 后置过滤(SQL 端已做 limit,这里做 filter 收紧)。
   *
   * 当前实现只处理 domainTags;其余 SearchFilter 字段(kinds / status /
   * freshness / contextTags / 时间窗 / minImportance)留待 Phase 3 在 SQL
   * 端实现以避免 N+1 拉取。
   */
  private applyPostFilter(
    rows: RawSearchRow[],
    filter: SearchFilter | undefined,
  ): RawSearchRow[] {
    if (!filter) return rows;
    if (filter.domainTags && filter.domainTags.length > 0) {
      const want = new Set(filter.domainTags);
      rows = rows.filter((r) => r.domainTags.some((t) => want.has(t)));
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const want = new Set(filter.kinds);
      rows = rows.filter((r) => want.has(r.kind));
    }
    if (typeof filter.minImportance === "number") {
      const floor = filter.minImportance;
      rows = rows.filter((r) => r.importance >= floor);
    }
    return rows;
  }
}

/** 内部行结构(从 SQL 拉回后已归一化为 camelCase) */
interface RawSearchRow {
  readonly id: EngramId;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly domainTags: readonly string[];
  readonly score: number;
}

/** FTS5 路径返回的 SQL row(snake_case,直接对应 SELECT alias) */
interface SqliteFtsRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly domain_tags: string | null;
  readonly fts_score: number;
}

/** LIKE 路径返回的 SQL row(无 fts_score 列) */
interface SqliteLikeRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly domain_tags: string | null;
}

/** group_concat(domain, ',') 拆回数组(null / "" → []) */
function splitCsv(joined: string | null | undefined): string[] {
  if (!joined) return [];
  return joined.split(",").filter(Boolean);
}

/** LIKE escape:% _ \ 三个特殊字符转义,使用 ESCAPE '\' 子句 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
