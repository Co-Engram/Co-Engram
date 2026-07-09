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
    let rows = useLike
      ? this.searchByLike(q, limit)
      : this.searchByFts(q, limit);

    // FTS5 trigram tokenizer 对短 token / 中英混合 query 可能 0 召回
    // (例:"co-engram loop 模式" — trigram tokenizer 切出跨空格 trigram,
    // 文档里没有这个连续序列)。fallback 到 LIKE:四个文本维度模糊匹配,
    // 覆盖 FTS 召回盲区。LIKE 排序仍走 importance + updatedAt DESC。
    if (!useLike && rows.length === 0) {
      rows = this.searchByLike(q, limit);
    }

    const filtered = this.applyPostFilter(rows, opts.filter);

    // AI-9 真正修复:把 SQLite bm25 的 -bm25_value(正数,无上界)归一化到 [0, 1]。
    //
    // 历史缺陷:之前直接透传 -bm25_value,实测 engram_search 返回 score=26.6,
    // 远超 SimpleSearchResult 注释承诺的"严格 ∈ [0, 1]"。这是 plan AI-9 硬门
    // "score 归一化到 [0, 1]"的真未完成投影 —— in-memory SearchOrchestrator.search
    // 已归一化,SQLite 路径跳过了。
    //
    // 归一化策略(与 in-memory 路径一致):除以本批 max,让 top hit = 1.0,
    // 其他按比例缩放。排序不变(max 是 top hit,归一化后仍 = 1.0 ≥ 其他)。
    //
    // 边界:
    //   - LIKE 路径所有 score=0 → maxScore=0 → 保留 0(无相关度信号,正确)
    //   - FTS 召回 0 条 fallback 到 LIKE → 同上
    //   - applyPostFilter 过滤掉原 top hit → 基于过滤后的次高归一化(正确)
    //
    // 语义损失:丢失 bm25 绝对强度信号(查询 A top=10 vs 查询 B top=2 归一化后
    // 都 1.0)。换取:与 in-memory 路径行为一致 + 用户可读的 [0,1] 区间 + LLM
    // 能跨查询比较"这条 top hit 比那条 top hit 相关度 0.9 vs 0.6"。
    const maxScore = filtered.reduce(
      (m, r) => (r.score > m ? r.score : m),
      0,
    );

    const results: SimpleSearchResult[] = filtered.map((r) => ({
      id: r.id,
      score: maxScore > 0 ? r.score / maxScore : 0,
      entry: {
        id: r.id,
        title: r.title,
        kind: r.kind as EngramKind,
        domainTags: r.domainTags,
      },
      // AI-9: SQLite FTS5 trigram tokenizer 不暴露 per-field 命中信息
      // (engram_fts 是合并列 title + summary + content_tokens 的单索引),
      // matchReason 留空数组。后续可用 FTS5 highlight() API 扩展。
      matchReason: [],
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
   * 实现:按空格 / 中英文标点拆 token,每个 token 用 phrase 语法(`"..."`)
   * 让 FTS5 trigram tokenizer 单独处理;多 token 用 OR 连接,部分命中即召回,
   * 全部命中的文档 bm25 得分更优排前。
   *
   * 为什么不用整体 phrase:trigram tokenizer 把 query 切成 3-char 窗口
   * (含跨空格),要求文档里有完全相同的连续字符序列。组合 query
   * (例:"co-engram loop 模式")在文档里几乎不可能有连续序列,导致 0 召回。
   *
   * `"` 内的双引号 escape 为 `""`(FTS5 标准做法)。
   */
  private buildFtsQuery(query: string): string | null {
    if (!query) return null;
    const tokens = query
      .trim()
      .split(/[\s,，。、;；!！?？()（）]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return null;
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
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
