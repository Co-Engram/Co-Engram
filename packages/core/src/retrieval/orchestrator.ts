/**
 * 检索编排器
 *
 * 协调 FTS / 过滤器 / 三因子排序，返回 Catalog Entry 列表
 *
 * P1 阶段实现（2.3）：
 *   - FTS 相关度（归一化到 [0,1]）
 *   - 三因子打分：α·relevance + β·recency + γ·importance
 *   - 权重可通过 setWeights() 配置
 *   - 同输入同输出（prompt cache 友好）
 *
 * P2 阶段会增加：
 *   - 向量余弦相似度（RRF 融合）
 *   - 动态自适应披露集成
 *
 * @module @co-engram/core/retrieval
 */

import type { EngramCatalogEntry, EngramId } from "../types/engram.js";
import type { SearchFilter, SearchResult } from "../types/disclosure.js";
import type { DigestLine } from "../index/types.js";
import { buildFtsIndex, searchFts, type FtsIndex } from "./fts.js";
import { applyFilter } from "./filter.js";
import {
  computeThreeFactorScore,
  DEFAULT_WEIGHTS,
  validateWeights,
  type ThreeFactorWeights,
} from "./scoring.js";

/**
 * 简单检索结果（P0 阶段）
 */
export interface SimpleSearchResult {
  readonly id: EngramId;
  readonly score: number;
  readonly entry: EngramCatalogEntry;
}

/**
 * 检索器
 *
 * 需要先调用 `build()` 构建 FTS 索引；后续搜索复用索引
 */
export class SearchOrchestrator {
  private ftsIndex: FtsIndex | null = null;
  private lines: readonly DigestLine[] = [];
  private weights: ThreeFactorWeights = DEFAULT_WEIGHTS;
  private nowFn: () => Date = () => new Date();

  /**
   * 构建 FTS 索引
   */
  build(lines: readonly DigestLine[]): void {
    this.lines = lines;
    this.ftsIndex = buildFtsIndex(lines);
  }

  /**
   * 配置三因子权重（默认 α=0.5, β=0.3, γ=0.2）
   *
   * 会校验和为 1。
   */
  setWeights(weights: ThreeFactorWeights): void {
    validateWeights(weights);
    this.weights = weights;
  }

  /** 读取当前权重 */
  getWeights(): ThreeFactorWeights {
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
      throw new Error("SearchOrchestrator not built. Call build() first.");
    }

    // 1. FTS 搜索
    const hits = searchFts(query, this.ftsIndex, limit * 3);
    if (hits.length === 0) return [];

    // 2. 归一化 FTS score 到 [0,1]（除以 max）
    const maxFts = hits[0]!.score;
    const now = this.nowFn();

    // 3. 应用过滤器 + 三因子打分
    const scored: Array<{ id: EngramId; score: number; line: DigestLine }> = [];
    for (const hit of hits) {
      const line = this.ftsIndex.docs.get(hit.docId);
      if (!line) continue;
      if (!applyFilter([line], filter).includes(line)) continue;
      const relevance = maxFts > 0 ? hit.score / maxFts : 0;
      const score = computeThreeFactorScore(relevance, line, {
        now,
        weights: this.weights,
      });
      scored.push({ id: line.id, score, line });
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
    }));
  }

  /**
   * 按过滤器列出（无查询）
   *
   * 不打相关度分（score=0），按原顺序返回。
   * 可通过 listByImportance() 获取按 importance 排序的列表。
   */
  listByFilter(filter?: SearchFilter, limit = 100): SimpleSearchResult[] {
    const filtered = applyFilter(this.lines, filter);
    return filtered.slice(0, limit).map((line) => ({
      id: line.id,
      score: 0,
      entry: {
        id: line.id,
        title: line.title,
        kind: line.kind as EngramCatalogEntry["kind"],
        domainTags: line.domainTags,
      },
    }));
  }

  /**
   * 按 importance + recency 排序列出（无 query）
   *
   * 用于"最近有效的最重要 engram"类查询（如首页推荐）。
   */
  listByImportance(filter?: SearchFilter, limit = 100): SimpleSearchResult[] {
    const filtered = applyFilter(this.lines, filter);
    const now = this.nowFn();
    const scored = filtered.map((line) => ({
      id: line.id,
      score: computeThreeFactorScore(0, line, { now, weights: this.weights }),
      line,
    }));
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
    }));
  }
}
