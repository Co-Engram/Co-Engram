/**
 * 检索编排器
 *
 * 协调 FTS / 过滤器 / 四因子排序,返回 Catalog Entry 列表
 *
 * 实现:
 *   - FTS 相关度(归一化到 [0,1])
 *   - 四因子打分:α·relevance + β·recency + γ·effectiveImportance + δ·strength
 *   - 权重可通过 setWeights() 配置
 *   - 同输入同输出(prompt cache 友好)
 *
 * P2 阶段会增加:
 *   - 向量余弦相似度(RRF 融合)
 *   - 动态自适应披露集成
 *
 * @module @co-engram/core/retrieval
 */

import type { EngramCatalogEntry, EngramId } from "../types/engram.js";
import type { SearchFilter, SearchResult } from "../types/disclosure.js";
import type { DigestLine } from "../index/types.js";
import { buildFtsIndex, searchFts, tokenize, type FtsIndex } from "./fts.js";
import { applyFilter } from "./filter.js";
import {
  computeFourFactorScore,
  DEFAULT_WEIGHTS,
  validateWeights,
  type FourFactorWeights,
} from "./scoring.js";
import {
  compareSortKey,
  decodeCursor,
  encodeCursor,
  type SortKey,
} from "../storage/index-db-cursor.js";
import { internalError } from "../tools/error-schema.js";

/**
 * cursor 分页返回 shape(Phase 3 PR3)。
 *
 * engram_list / listByFilter / listByImportance 共用。
 */
export interface CursorListResult {
  readonly items: SimpleSearchResult[];
  readonly nextCursor: string | null;
}

/**
 * 把 DigestLine 投影成 SortKey。
 *
 * 排序顺序与 compareSortKey 严格一致:importance DESC, updatedAt DESC, id ASC。
 * 缺省 updatedAt 兜底为 epoch,避免 Date.parse(undefined) 返回 NaN 干扰排序。
 */
function digestLineToSortKey(line: DigestLine): SortKey {
  return {
    importance: line.importance,
    updatedAt: Date.parse(line.updatedAt ?? "1970-01-01"),
    id: line.id,
  };
}

/**
 * 从排序后的 lines + cursor 计算 { items, nextCursor }。
 *
 * caller 必须先按 SortKey 排序好 lines,再传入。本函数只做 cursor 过滤 + slice。
 */
function paginateSortedLines(
  sorted: readonly DigestLine[],
  limit: number,
  cursor: string | null,
): CursorListResult {
  let startIdx = 0;
  if (cursor) {
    const ck = decodeCursor(cursor);
    startIdx = sorted.findIndex((line) => {
      return compareSortKey(digestLineToSortKey(line), ck) > 0;
    });
    if (startIdx === -1) startIdx = sorted.length;
  }
  const slice = sorted.slice(startIdx, startIdx + limit);
  const items = slice.map((line) => ({
    id: line.id,
    score: 0,
    entry: {
      id: line.id,
      title: line.title,
      kind: line.kind as EngramCatalogEntry["kind"],
      domainTags: line.domainTags,
    },
    // AI-9: 无查询分页路径返回空 matchReason(score=0,无字段命中解释)
    matchReason: [] as readonly MatchReason[],
  }));
  const hasMore = startIdx + limit < sorted.length && items.length > 0;
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(digestLineToSortKey(slice[slice.length - 1]!))
      : null;
  return { items, nextCursor };
}

/**
 * 单条命中解释(AI-9):哪个字段的哪个 term 命中 + 该命中的权重占比。
 *
 * 权重语义:同一检索结果内,所有 matchReason 的 weight 加起来 = 1
 * (每个 (field, term) pair 等权贡献)。LLM 据此判断"这条结果为什么排第一"。
 *
 * 字段说明:
 *   - title:标题命中(tokenize 后 token 在 title 集合中)
 *   - summary:摘要命中
 *   - domainTags:领域标签命中
 *   - contextTags:情境标签命中
 */
export interface MatchReason {
  readonly field: "title" | "summary" | "domainTags" | "contextTags";
  readonly term: string;
  readonly weight: number;
}

/**
 * 简单检索结果（P0 阶段）
 *
 * AI-9 修复:
 *   - score 严格 clamp01 兜底(四因子加权和理论上 ≤ 1,但 reinforcementScore
 *     累积等 corner case 可能让数值漂移 > 1,这里防御性 clamp)
 *   - 新增 matchReason 字段,提供 per-(field, term) 命中解释
 */
export interface SimpleSearchResult {
  readonly id: EngramId;
  /** 最终相关性得分,严格 ∈ [0, 1] */
  readonly score: number;
  readonly entry: EngramCatalogEntry;
  /**
   * 命中解释(可空数组):
   *   - in-memory 引擎:基于 FTS matchedTokens + 各字段 tokenize 重建
   *   - SQLite bm25 引擎:无字段级信息,返回空数组(后续可用 FTS5 highlight() 扩展)
   *   - listByFilter / listByImportance 等无查询路径:空数组(score=0)
   */
  readonly matchReason: readonly MatchReason[];
}

/**
 * 检索器
 *
 * 需要先调用 `build()` 构建 FTS 索引；后续搜索复用索引
 */
export class SearchOrchestrator {
  private ftsIndex: FtsIndex | null = null;
  private lines: readonly DigestLine[] = [];
  private weights: FourFactorWeights = DEFAULT_WEIGHTS;
  private nowFn: () => Date = () => new Date();

  /**
   * 构建 FTS 索引
   */
  build(lines: readonly DigestLine[]): void {
    this.lines = lines;
    this.ftsIndex = buildFtsIndex(lines);
  }

  /**
   * 配置四因子权重(默认 α=0.5, β=0.2, γ=0.2, δ=0.1)
   *
   * 会校验和为 1。
   */
  setWeights(weights: FourFactorWeights): void {
    validateWeights(weights);
    this.weights = weights;
  }

  /** 读取当前权重 */
  getWeights(): FourFactorWeights {
    return this.weights;
  }

  /**
   * 注入时钟函数（测试用，避免依赖系统时间）
   */
  setClock(nowFn: () => Date): void {
    this.nowFn = nowFn;
  }

  /**
   * 搜索
   *
   * @param query - 查询字符串
   * @param filter - 过滤器（可选）
   * @param limit - 最大结果数（默认 20）
   */
  search(
    query: string,
    filter?: SearchFilter,
    limit = 20,
  ): SimpleSearchResult[] {
    if (!this.ftsIndex) {
      throw internalError("SearchOrchestrator not built. Call build() first.");
    }

    // 1. FTS 搜索
    const hits = searchFts(query, this.ftsIndex, limit * 3);
    if (hits.length === 0) return [];

    // 2. 归一化 FTS score 到 [0,1]（除以 max）
    const maxFts = hits[0]!.score;
    const now = this.nowFn();

    // 3. 应用过滤器 + 三因子打分 + 命中解释
    const scored: Array<{
      id: EngramId;
      score: number;
      line: DigestLine;
      matchReason: readonly MatchReason[];
    }> = [];
    for (const hit of hits) {
      const line = this.ftsIndex.docs.get(hit.docId);
      if (!line) continue;
      if (!applyFilter([line], filter).includes(line)) continue;
      const relevance = maxFts > 0 ? hit.score / maxFts : 0;
      const rawScore = computeFourFactorScore(relevance, line, {
        now,
        weights: this.weights,
      });
      // AI-9: 最终 score 严格 clamp01 兜底,防 reinforcementScore 累积等
      // corner case 让加权和漂移 > 1。理论值 ≤ 1,clamp 是防御性。
      const score = clamp01(rawScore);
      const matchReason = buildMatchReason(hit.matchedTokens, line);
      scored.push({ id: line.id, score, line, matchReason });
    }

    // 4. 稳定排序：按 score 倒序，同分按 id 字典序（prompt cache 友好）
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.id < b.id ? -1 : 1;
    });

    return scored.slice(0, limit).map((item) => ({
      id: item.id,
      score: item.score,
      entry: {
        id: item.line.id,
        title: item.line.title,
        kind: item.line.kind as EngramCatalogEntry["kind"],
        domainTags: item.line.domainTags,
      },
      matchReason: item.matchReason,
    }));
  }

  /**
   * 按过滤器列出(无查询,cursor 分页)
   *
   * Phase 3 PR3:opts signature + cursor。排序键 = SortKey(importance DESC,
   * updatedAt DESC, id ASC),与 cursor encoding 一致,翻页稳定。
   *
   * 不打相关度分(score=0)。原顺序不再保留 —— 如需原顺序,直接读 repository。
   */
  listByFilter(opts: {
    filter?: SearchFilter;
    limit: number;
    cursor: string | null;
  }): CursorListResult {
    if (this.ftsIndex === null) {
      throw internalError("SearchOrchestrator not built. Call build() first.");
    }
    const filtered = applyFilter(this.lines, opts.filter);
    const sorted = [...filtered].sort((a, b) =>
      compareSortKey(digestLineToSortKey(a), digestLineToSortKey(b)),
    );
    return paginateSortedLines(sorted, opts.limit, opts.cursor);
  }

  /**
   * 按 importance + recency 排序列出(无 query,cursor 分页)
   *
   * Phase 3 PR3:opts signature + cursor。排序键与 listByFilter 一致(SortKey),
   * 让翻页 cursor 精确;recency 因子已隐含在 updatedAt 字段(updatedAt 越
   * 新排序越靠前,等效于"最近有效的最重要 engram")。
   *
   * 与历史实现差异:旧版用 computeFourFactorScore 排序,新版用 SortKey。
   * 行为变化:仅当两条 engram 的 importance 相同但 updatedAt 不同时,新版
   * 严格按 updatedAt 排序,旧版按 computeFourFactorScore 的 recency 因子
   * 排序。两者语义等价(都是 "importance 主 + recency 次"),但公式不同。
   * 由于 listByImportance 当前无外部 caller,这个变化无破坏性影响。
   */
  listByImportance(opts: {
    filter?: SearchFilter;
    limit: number;
    cursor: string | null;
  }): CursorListResult {
    if (this.ftsIndex === null) {
      throw internalError("SearchOrchestrator not built. Call build() first.");
    }
    const filtered = applyFilter(this.lines, opts.filter);
    const sorted = [...filtered].sort((a, b) =>
      compareSortKey(digestLineToSortKey(a), digestLineToSortKey(b)),
    );
    return paginateSortedLines(sorted, opts.limit, opts.cursor);
  }
}

// ============================================================
// AI-9 辅助函数
// ============================================================

/** 防御性 clamp 到 [0, 1],防 NaN / 数值漂移 */
function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 把 FTS matchedTokens 转成 per-(field, term) 命中解释。
 *
 * 算法:
 *   1. 对每个字段(title / summary / domainTags / contextTags)用与 FTS 索引
 *      阶段相同的 tokenize("index") 拆 token,得到字段 token set。
 *   2. 对每个 matchedToken,检查它在哪些字段的 token set 中。
 *   3. 每个 (field, term) pair 作为一个 MatchReason。
 *   4. 同一 hit 内所有 matchReason 的 weight 加起来 = 1(等权归一化)。
 *
 * 设计取舍:
 *   - 不在 FTS 层做 per-field 倒排(4 倍索引开销,收益小)
 *   - 用等权而非真实分数贡献(四因子权重与 FTS title 加权纠缠,清晰拆分需重写)
 *   - LLM 据此可判断"这条结果为什么命中",具体权重交给 LLM 解读
 */
function buildMatchReason(
  matchedTokens: readonly string[],
  line: DigestLine,
): readonly MatchReason[] {
  if (matchedTokens.length === 0) return [];

  const fieldTokens: ReadonlyArray<{
    readonly name: MatchReason["field"];
    readonly tokens: ReadonlySet<string>;
  }> = [
    { name: "title", tokens: new Set(tokenize(line.title, "index")) },
    {
      name: "summary",
      tokens: new Set(tokenize(line.summary ?? "", "index")),
    },
    {
      name: "domainTags",
      tokens: new Set(tokenize(line.domainTags.join(" "), "index")),
    },
    {
      name: "contextTags",
      tokens: new Set(tokenize((line.contextTags ?? []).join(" "), "index")),
    },
  ];

  const reasons: MatchReason[] = [];
  for (const token of matchedTokens) {
    for (const f of fieldTokens) {
      if (f.tokens.has(token)) {
        reasons.push({ field: f.name, term: token, weight: 0 });
      }
    }
  }

  if (reasons.length === 0) return [];
  const w = 1 / reasons.length;
  return reasons.map((r) => ({ ...r, weight: w }));
}
