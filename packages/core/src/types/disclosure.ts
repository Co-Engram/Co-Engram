/**
 * 渐进式披露类型定义
 *
 * Tier 0/1/2/3/4 数据单元（按粒度递增，不固定分层）
 *
 * @module @co-engram/core/types
 */

import type { EngramCatalogEntry, EngramDigest, EngramId } from "./engram.js";
import type { Synapse } from "./synapse.js";

/** 披露层级 */
export type DisclosureTier =
  | "catalog"
  | "digest"
  | "content"
  | "meta"
  | "synapses";

/** Context Window 预算 */
export interface ContextBudget {
  readonly totalTokens: number;
  readonly remaining: number;
  readonly reserved: number;
}

/** Synapse Bundle（Tier 4，扩展联想） */
export interface SynapseBundle {
  readonly engramId: EngramId;
  readonly outgoing: readonly Synapse[];
  readonly incoming: readonly Synapse[];
  readonly neighborDigests: readonly EngramDigest[];
}

/** 加载的 Engram 视图（可处于不同披露层级） */
export type EngramView =
  | { readonly tier: "catalog"; readonly entry: EngramCatalogEntry }
  | { readonly tier: "digest"; readonly digest: EngramDigest }
  | {
      readonly tier: "content";
      readonly entry: EngramCatalogEntry;
      readonly content: string;
    }
  | {
      readonly tier: "meta";
      readonly entry: EngramCatalogEntry;
      readonly meta: Record<string, unknown>;
    }
  | { readonly tier: "synapses"; readonly bundle: SynapseBundle };

/** 检索过滤器 */
export interface SearchFilter {
  readonly domainTags?: readonly string[];
  readonly kinds?: readonly string[];
  readonly status?: readonly string[];
  readonly freshness?: readonly string[];
  readonly emotionalValence?: readonly string[];
  readonly createdBy?: readonly string[];
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly minImportance?: number;
}

/** 检索请求 */
export interface SearchRequest {
  readonly query: string;
  readonly filter?: SearchFilter;
  readonly contextBudget?: ContextBudget;
  readonly limit?: number;
}

/** 检索结果（带 score 和 tier） */
export interface SearchResult {
  readonly id: EngramId;
  readonly score: number;
  readonly view: EngramView;
  readonly matchedBy: readonly ("fts" | "vector" | "recency" | "importance")[];
}
