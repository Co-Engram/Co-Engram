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
import { buildMatchReason } from "./orchestrator.js";
import { tokenize } from "./fts.js";
import {
  computeFiveFactorScore,
  DEFAULT_HOTNESS_HALF_LIFE_DAYS,
  DEFAULT_WEIGHTS,
  type FiveFactorWeights,
} from "./scoring.js";

/** SqliteSearchOrchestrator 构造参数 */
export interface SqliteSearchOptions {
  readonly db: IndexDb;
  /**
   * 时钟注入(测试用);当前实现未依赖时间,但保留接口便于后续三因子融合。
   */
  readonly nowFn?: () => Date;
  /**
   * M6:五因子权重(来自 config.search.scoring,经 scoringConfigToWeights 转换)。
   * 缺省 DEFAULT_WEIGHTS。此前 SQLite 路径 computeFiveFactorScore 只传 {now},
   * 恒用 DEFAULT_WEIGHTS,运维在 config 调 search.scoring 无效。
   */
  readonly weights?: FiveFactorWeights;
  /**
   * P0-2:hotness 半衰期天数(默认 7)。访问热度衰减参数,与权重解耦配置。
   */
  readonly hotnessHalfLifeDays?: number;
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
 * H1:检索默认 status 过滤门(与 in-memory retrieval/filter.ts matchesFilter 对齐)。
 *
 * 默认排除 frozen / forgotten —— 前者「不参与检索」、后者「移出索引」
 * (types/engram.ts EngramStatus 契约)。此前 SQLite 路径的 SQL 与
 * applyPostFilter 都无 status 谓词,导致 frozen/forgotten 照常泄漏进
 * engram_search 结果(实测确认)。调用方可经 filter.status 显式覆盖
 * (如 ["frozen"] 列出冻结记忆)。
 */
const DEFAULT_SEARCH_STATUS: readonly string[] = ["active", "draft"];

/**
 * SQLite FTS5 召回编排器。
 *
 * 与 in-memory SearchOrchestrator 接口兼容(same query → SimpleSearchResult[]),
 * 上层 engram_search 工具按 feature flag 切换引擎。
 */
export class SqliteSearchOrchestrator {
  private readonly db: IndexDb;
  private readonly nowFn: () => Date;
  private readonly weights: FiveFactorWeights;
  private readonly hotnessHalfLifeDays: number;

  constructor(opts: SqliteSearchOptions) {
    this.db = opts.db;
    this.nowFn = opts.nowFn ?? (() => new Date());
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.hotnessHalfLifeDays =
      opts.hotnessHalfLifeDays ?? DEFAULT_HOTNESS_HALF_LIFE_DAYS;
  }

  search(query: string, opts: SearchQueryOptions = {}): SearchResponse {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500);
    const q = query.trim();
    if (!q) return { results: [], nextCursor: null };

    // H1:status 过滤门下沉到 SQL 谓词(召回阶段即排除 frozen/forgotten),
    // 不让它们占用 recallLimit 配额。默认与 in-memory 引擎对齐为
    // ["active","draft"];调用方显式传 filter.status 时按显式值过滤。
    const statusFilter =
      opts.filter?.status && opts.filter.status.length > 0
        ? opts.filter.status
        : DEFAULT_SEARCH_STATUS;

    // T7:召回池放大到 limit*3(对齐 in-memory searchFts(limit*3)),给四因子
    // 重排留空间 —— 让"文本匹配弱但 importance 高 / verified"的记忆有机会
    // 进前 limit,而非被 bm25 前 limit 直接截断丢弃。
    const recallLimit = Math.min(limit * 3, 500);
    const useLike = q.length < LIKE_FALLBACK_MIN_CHARS;
    let rows = useLike
      ? this.searchByLike(q, recallLimit, statusFilter)
      : this.searchByFts(q, recallLimit, statusFilter);

    // FTS5 trigram tokenizer 对短 token / 中英混合 query 可能 0 召回
    // (例:"co-engram loop 模式" — trigram tokenizer 切出跨空格 trigram,
    // 文档里没有这个连续序列)。fallback 到 LIKE:四个文本维度模糊匹配。
    if (!useLike && rows.length === 0) {
      rows = this.searchByLike(q, recallLimit, statusFilter);
    }

    const filtered = this.applyPostFilter(rows, opts.filter);
    if (filtered.length === 0) return { results: [], nextCursor: null };

    // r12 修复:query tokens(index 口径)用于 matchReason 重建,见 results 构造。
    const queryTokens = tokenize(q, "index");

    // bm25 raw(正数)归一化到 [0,1] 作五因子 relevance 项。LIKE 路径 score 全 0
    // → maxRaw=0 → relevance 全 0,五因子退化为 β·recency + γ·effImp + δ·strength + ε·hotness
    // (纯增值信号排序,因 LIKE 无文本相关度分)。
    const maxRaw = filtered.reduce((m, r) => (r.score > m ? r.score : m), 0);
    const now = this.nowFn();

    // T7:五因子重排(relevance + recency + effImp + strength + hotness),
    // 与 in-memory SearchOrchestrator 同公式同权重,让高价值记忆在宽泛搜索中浮现。
    const scored = filtered
      .map((r) => {
        const relevance = maxRaw > 0 ? r.score / maxRaw : 0;
        const score = computeFiveFactorScore(
          relevance,
          {
            importance: r.importance,
            createdAt:
              r.createdAtMs > 0
                ? new Date(r.createdAtMs).toISOString()
                : new Date(0).toISOString(),
            lastEffectiveAt:
              r.lastEffectiveAtMs != null && r.lastEffectiveAtMs > 0
                ? new Date(r.lastEffectiveAtMs).toISOString()
                : null,
            verificationStatus: r.verificationStatus,
            reinforcementScore: r.reinforcementScore,
            // P0-2:hotness 输入(访问计数 + 访问新近度),列由 SELECT 带回
            retrievalCount: r.retrievalCount,
            lastRetrievedAt:
              r.lastRetrievedAtMs != null && r.lastRetrievedAtMs > 0
                ? new Date(r.lastRetrievedAtMs).toISOString()
                : null,
          },
          {
            now,
            weights: this.weights,
            hotnessHalfLifeDays: this.hotnessHalfLifeDays,
          },
        );
        return { r, score };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        // 稳定排序:同分按 id 字典序(与 in-memory 一致,prompt cache 友好)
        return a.r.id < b.r.id ? -1 : 1;
      });

    const results: SimpleSearchResult[] = scored.slice(0, limit).map(({ r, score }) => ({
      id: r.id,
      score,
      entry: {
        id: r.id,
        title: r.title,
        kind: r.kind as EngramKind,
        domainTags: r.domainTags,
      },
      // r12 修复:SQLite 路径 matchReason 此前恒空数组(bm25 不暴露 per-field
      // 命中)。现用 query tokens 对 title/summary/domainTags/contextTags 四字段
      // tokenize 比对重建,与 in-memory buildMatchReason 同一逻辑——score 的
      // 命中解释在两引擎行为一致。
      matchReason: buildMatchReason(queryTokens, {
        title: r.title,
        summary: r.summary,
        domainTags: r.domainTags,
        contextTags: r.contextTags,
      }),
    }));

    return { results, nextCursor: null };
  }

  /** FTS5 trigram MATCH,bm25 排序(负值越优,ASC 即最相关在前) */
  private searchByFts(
    q: string,
    limit: number,
    statusFilter: readonly string[],
  ): RawSearchRow[] {
    const ftsQuery = this.buildFtsQuery(q);
    if (!ftsQuery) return [];
    // H1:AND e.status IN (...) 召回阶段排除 frozen/forgotten。statusFilter
    // 来自 search() 入口归一化(非空),动态构造 placeholder 防注入。
    const statusPlaceholders = statusFilter.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT e.id AS id, e.title AS title, e.kind AS kind, e.importance AS importance,
        (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domain_tags,
        e.summary AS summary,
        e.context_tags AS context_tags_json,
        e.created_at AS created_at,
        e.last_effective_at AS last_effective_at,
        e.last_retrieved_at AS last_retrieved_at,
        e.retrieval_count AS retrieval_count,
        e.reinforcement_score AS reinforcement_score,
        e.verification_status AS verification_status,
        bm25(engram_fts) AS fts_score
      FROM engram_fts
      JOIN engrams e ON e.id = engram_fts.id
      WHERE engram_fts MATCH ? AND e.status IN (${statusPlaceholders})
      ORDER BY fts_score ASC
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, ...statusFilter, limit) as unknown as Array<SqliteFtsRow>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      importance: r.importance,
      domainTags: splitCsv(r.domain_tags),
      summary: r.summary ?? "",
      contextTags: parseContextTags(r.context_tags_json),
      // bm25 返回负值,反转成正数(score 越大越优,与 in-memory 一致)
      score: -r.fts_score,
      createdAtMs: r.created_at ?? 0,
      lastEffectiveAtMs: r.last_effective_at ?? null,
      lastRetrievedAtMs: r.last_retrieved_at ?? null,
      retrievalCount: r.retrieval_count ?? 0,
      reinforcementScore: r.reinforcement_score ?? 0,
      verificationStatus: r.verification_status ?? null,
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
  private searchByLike(
    q: string,
    limit: number,
    statusFilter: readonly string[],
  ): RawSearchRow[] {
    // H1:OR 文本条件用括号包住,再 AND e.status IN (...) 排除 frozen/forgotten。
    const statusPlaceholders = statusFilter.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT e.id AS id, e.title AS title, e.kind AS kind, e.importance AS importance,
        (SELECT group_concat(domain, ',') FROM engram_domains d WHERE d.engram_id = e.id) AS domain_tags,
        e.summary AS summary,
        e.context_tags AS context_tags_json,
        e.created_at AS created_at,
        e.last_effective_at AS last_effective_at,
        e.last_retrieved_at AS last_retrieved_at,
        e.retrieval_count AS retrieval_count,
        e.reinforcement_score AS reinforcement_score,
        e.verification_status AS verification_status
      FROM engrams e
      JOIN engram_fts f ON f.id = e.id
      WHERE (e.title LIKE ? ESCAPE '\\'
         OR f.summary LIKE ? ESCAPE '\\'
         OR f.content_tokens LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM engram_domains d
           WHERE d.engram_id = e.id AND d.domain LIKE ? ESCAPE '\\'
         ))
         AND e.status IN (${statusPlaceholders})
      ORDER BY e.importance DESC, e.updated_at DESC
      LIMIT ?
    `);
    const pattern = `%${escapeLike(q)}%`;
    const rows = stmt.all(pattern, pattern, pattern, pattern, ...statusFilter, limit) as unknown as Array<SqliteLikeRow>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      importance: r.importance,
      domainTags: splitCsv(r.domain_tags),
      summary: r.summary ?? "",
      contextTags: parseContextTags(r.context_tags_json),
      score: 0,
      createdAtMs: r.created_at ?? 0,
      lastEffectiveAtMs: r.last_effective_at ?? null,
      lastRetrievedAtMs: r.last_retrieved_at ?? null,
      retrievalCount: r.retrieval_count ?? 0,
      reinforcementScore: r.reinforcement_score ?? 0,
      verificationStatus: r.verification_status ?? null,
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
   * status / verificationStatus 是「检索默认门」—— 即使 filter 为 undefined
   * 也要应用(status 已在 SQL 谓词下沉,verificationStatus 在此处的默认排除
   * 提到 `if (!filter) return rows` 早返之前)。其余字段(kinds / freshness /
   * contextTags / 时间窗 / minImportance)仅在 filter 存在时生效。
   */
  private applyPostFilter(
    rows: RawSearchRow[],
    filter: SearchFilter | undefined,
  ): RawSearchRow[] {
    // M2:verificationStatus 默认排除 refuted(已证伪记忆不进默认检索,与
    // in-memory retrieval/filter.ts matchesFilter 对齐)。RawSearchRow 的
    // verificationStatus 已由 SQL SELECT 带回(engrams.verification_status)。
    // null 视为 unverified,不被默认排除;显式传 filter.verificationStatus 时
    // 按包含语义过滤(便于管理面查询 refuted)。
    if (filter?.verificationStatus && filter.verificationStatus.length > 0) {
      const want = new Set(filter.verificationStatus);
      rows = rows.filter(
        (r) => r.verificationStatus != null && want.has(r.verificationStatus),
      );
    } else {
      rows = rows.filter((r) => r.verificationStatus !== "refuted");
    }
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
  // matchReason 重建输入(r12 修复:SQLite 路径此前恒空数组)
  readonly summary: string;
  readonly contextTags: readonly string[];
  // T7:五因子重排需要(epoch ms / 原始值,search() 转 ISO 后喂 computeFiveFactorScore)
  readonly createdAtMs: number;
  readonly lastEffectiveAtMs: number | null;
  // P0-2:hotness 因子输入(访问计数 + 最后命中时间)
  readonly lastRetrievedAtMs: number | null;
  readonly retrievalCount: number;
  readonly reinforcementScore: number;
  readonly verificationStatus: string | null;
}

/** FTS5 路径返回的 SQL row(snake_case,直接对应 SELECT alias) */
interface SqliteFtsRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly domain_tags: string | null;
  readonly summary: string | null;
  readonly context_tags_json: string | null;
  readonly created_at: number | null;
  readonly last_effective_at: number | null;
  readonly last_retrieved_at: number | null;
  readonly retrieval_count: number | null;
  readonly reinforcement_score: number | null;
  readonly verification_status: string | null;
  readonly fts_score: number;
}

/** LIKE 路径返回的 SQL row(无 fts_score 列) */
interface SqliteLikeRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly domain_tags: string | null;
  readonly summary: string | null;
  readonly context_tags_json: string | null;
  readonly created_at: number | null;
  readonly last_effective_at: number | null;
  readonly last_retrieved_at: number | null;
  readonly retrieval_count: number | null;
  readonly reinforcement_score: number | null;
  readonly verification_status: string | null;
}

/** context_tags JSON 列解析回数组(容错:null / 非法 JSON → []) */
function parseContextTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
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
