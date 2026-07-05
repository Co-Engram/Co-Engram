/**
 * 派生索引数据结构
 *
 * 所有派生数据都存储在 .co-engram/ 目录下，gitignore 不提交。
 * 冷启动时基于权威源（engrams/）增量重建。
 *
 * @module @co-engram/core/index
 */

import type {
  EngramCatalogEntry,
  EngramDigest,
  EngramId,
  ImportanceVector,
} from "../types/engram.js";
import type { SynapseKind } from "../types/synapse.js";

/** Catalog Entry 索引行（digest.jsonl 一行一条） */
export interface DigestLine {
  /** Engram id（相对路径） */
  readonly id: EngramId;
  /** 标题 */
  readonly title: string;
  /** 主 kind */
  readonly kind: string;
  /** 所有 kinds */
  readonly kinds: readonly string[];
  /** 摘要 */
  readonly summary: string;
  /** 领域标签 */
  readonly domainTags: readonly string[];
  /** 情境标签 */
  readonly contextTags: readonly string[];
  /** 重要性 [0,1]（recomputeImportance 后为 composite） */
  readonly importance: number;
  /** 多维重要性向量（可选，spec §8） */
  readonly importanceVector?: ImportanceVector;
  /** 新鲜度 */
  readonly freshness: string;
  /** 生命周期状态 */
  readonly status: string;
  /** 来源类型 */
  readonly sourceType: string;
  /** createdBy */
  readonly createdBy: string;
  /** createdAt ISO 时间戳 */
  readonly createdAt: string;
  /** updatedAt ISO 时间戳 */
  readonly updatedAt: string;
  /** lastRetrievedAt */
  readonly lastRetrievedAt: string | null;
  /** lastEffectiveAt */
  readonly lastEffectiveAt: string | null;
  /** retrievalCount */
  readonly retrievalCount: number;
  /** effectiveRetrievals */
  readonly effectiveRetrievals: number;
  /** failedUses */
  readonly failedUses: number;
  /** reinforcementScore */
  readonly reinforcementScore: number;
  /** decayHalfLifeDays */
  readonly decayHalfLifeDays: number | null;
  /** contentSize */
  readonly contentSize: number;
  /** contentHash */
  readonly contentHash: string;
  /** outgoingSynapseCount（缓存） */
  readonly outgoingSynapseCount: number;
  /** incomingSynapseCount（缓存） */
  readonly incomingSynapseCount: number;
  /** activeContradictionCount（缓存） */
  readonly activeContradictionCount: number;
}

/** Graph 索引节点 */
export interface GraphNode {
  readonly id: EngramId;
  readonly title: string;
  readonly kind: string;
  readonly importance: number;
  readonly outgoingCount: number;
  readonly incomingCount: number;
}

/** Graph 索引边 */
export interface GraphEdge {
  readonly id: string;
  readonly from: EngramId;
  readonly to: EngramId;
  readonly kind: SynapseKind;
  readonly weight: number;
  readonly direction: "directional" | "bidirectional";
}

/** Graph 索引文件结构 */
export interface GraphIndex {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** 邻接表：from -> [edgeIds] */
  readonly outgoingAdjacency: Record<string, readonly string[]>;
  /** 反向邻接表：to -> [edgeIds] */
  readonly incomingAdjacency: Record<string, readonly string[]>;
}

/** 增量索引状态 */
export interface IncrementalState {
  /** 上次索引完成时间 */
  readonly lastIndexedAt: string;
  /** 已索引的 engram id 列表 */
  readonly indexedEngrams: readonly EngramId[];
}

/** Digest 构建结果 */
export interface DigestBuildResult {
  readonly total: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
}

/** Catalog Entry 来源（digest.jsonl 派生） */
export type CatalogEntrySource = EngramCatalogEntry;

/** Digest 来源（digest.jsonl 派生） */
export type DigestSource = EngramDigest;
