/**
 * Graph Snapshot 构建（spec §12.2）
 *
 * 从派生索引（digest.jsonl + graph.json）构建 Graph View 用的快照。
 * 零额外存储：完全基于派生缓存，图视图本身不触发对权威源的读取。
 *
 * 过滤器（spec §12.6）：
 *   - 节点：kind / domainTags / freshness / status / emotionalValence / createdBy / createdAt 范围 / importance 阈值 / orphansOnly
 *   - 边：kinds / minWeight / hideContradicts
 *   - 预设：orphans / strong / contradictions / lineage
 *
 * @module @co-engram/core/graph
 */

import type {
  EngramKind,
  EngramFreshness,
  EngramStatus,
  EmotionalValence,
} from "../types/engram.js";
import type { SynapseKind, SynapseFamily } from "../types/synapse.js";
import type { DigestLine, GraphEdge, GraphIndex } from "../index/types.js";
import { getSynapseKindMeta } from "./registry.js";

// ============================================================
// 过滤器
// ============================================================

export interface GraphFilter {
  // === 节点过滤 ===
  readonly kinds?: readonly EngramKind[];
  readonly domainTags?: readonly string[];
  readonly freshness?: readonly EngramFreshness[];
  readonly status?: readonly EngramStatus[];
  readonly emotionalValence?: readonly EmotionalValence[];
  readonly createdBy?: readonly string[];
  /** createdAt 起始（ISO） */
  readonly createdAfter?: string;
  /** createdAt 结束（ISO） */
  readonly createdBefore?: string;
  /** 最小 importance（含） */
  readonly minImportance?: number;
  /** 最大 importance（含） */
  readonly maxImportance?: number;

  // === 边过滤 ===
  /** 只保留这些 kind 的边（不传=全部） */
  readonly synapseKinds?: readonly SynapseKind[];
  /** 只保留这些 family 的边 */
  readonly synapseFamilies?: readonly SynapseFamily[];
  /** 最小 weight（含） */
  readonly minWeight?: number;
  /** 隐藏 contradicts 边（专注结构关系） */
  readonly hideContradicts?: boolean;

  // === 预设视图 ===
  /** 只显示孤立节点（incoming=0 且 outgoing=0） */
  readonly orphansOnly?: boolean;
  /** 只显示矛盾图（contradicts + 相关节点） */
  readonly contradictionsOnly?: boolean;
}

// ============================================================
// 快照数据结构
// ============================================================

/** Graph View 渲染节点（digest line 子集 + 派生属性） */
export interface SnapshotNode {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly kinds: readonly string[];
  readonly domainTags: readonly string[];
  readonly importance: number;
  readonly freshness: string;
  readonly status: string;
  readonly emotionalValence: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retrievalCount: number;
  readonly effectiveRetrievals: number;
  readonly reinforcementScore: number;
  /** 派生：出边数（过滤后） */
  readonly outgoingCount: number;
  /** 派生：入边数（过滤后） */
  readonly incomingCount: number;
  /** 派生：是否 hub（incomingSynapseCount ≥ 10） */
  readonly isHub: boolean;
}

/** Graph View 渲染边（graph edge + family 元数据） */
export interface SnapshotEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: SynapseKind;
  readonly family: SynapseFamily;
  readonly weight: number;
  readonly direction: "directional" | "bidirectional";
  /** 派生：是否 contradicts（前端加粗红色虚线） */
  readonly isContradiction: boolean;
}

/** Graph 快照 */
export interface GraphSnapshot {
  readonly nodes: readonly SnapshotNode[];
  readonly edges: readonly SnapshotEdge[];
  readonly stats: GraphSnapshotStats;
}

export interface GraphSnapshotStats {
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly orphanCount: number;
  readonly hubCount: number;
  readonly contradictionCount: number;
  readonly byKind: Record<string, number>;
  readonly byDomain: Record<string, number>;
  readonly byFreshness: Record<string, number>;
}

/** Hub 阈值（spec §12.3：incomingSynapseCount ≥ 10） */
export const HUB_INCOMING_THRESHOLD = 10;

// ============================================================
// 构建
// ============================================================

export interface BuildSnapshotInput {
  readonly digest: ReadonlyMap<string, DigestLine> | readonly DigestLine[];
  readonly graph: GraphIndex;
  readonly filter?: GraphFilter;
}

/**
 * 构建 Graph View 快照
 *
 * 1. 节点过滤：对 digest 应用节点过滤器
 * 2. 边过滤：剔除两端任一节点被过滤掉的边；应用边过滤器
 * 3. 派生：节点 outgoingCount/incomingCount/isHub 基于过滤后的边
 * 4. 统计：orphan / hub / contradiction / byKind / byDomain / byFreshness
 */
export function buildGraphSnapshot(input: BuildSnapshotInput): GraphSnapshot {
  const digestList: DigestLine[] = Array.isArray(input.digest)
    ? [...input.digest]
    : Array.from(input.digest.values());

  const filter = input.filter ?? {};
  const edgeById = new Map<string, GraphEdge>();
  for (const e of input.graph.edges) edgeById.set(e.id, e);

  // --- Step 1: 节点过滤 ---
  const nodeSet = new Set<string>();
  const filteredDigests: DigestLine[] = [];
  for (const line of digestList) {
    if (!matchesNodeFilter(line, filter)) continue;
    nodeSet.add(line.id);
    filteredDigests.push(line);
  }

  // --- Step 2: 边过滤 ---
  const filteredEdges: SnapshotEdge[] = [];
  for (const edge of input.graph.edges) {
    // 两端必须都在过滤后的节点集中
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    if (!matchesEdgeFilter(edge, filter)) continue;
    filteredEdges.push(toSnapshotEdge(edge));
  }

  // --- 预设：contradictionsOnly ---
  let finalEdges = filteredEdges;
  let finalNodeSet = nodeSet;
  let finalDigests = filteredDigests;
  if (filter.contradictionsOnly) {
    finalEdges = filteredEdges.filter((e) => e.isContradiction);
    const keepIds = new Set<string>();
    for (const e of finalEdges) {
      keepIds.add(e.from);
      keepIds.add(e.to);
    }
    finalDigests = filteredDigests.filter((d) => keepIds.has(d.id));
    finalNodeSet = keepIds;
  }

  // --- Step 3: 派生节点属性 ---
  const outgoingCount = new Map<string, number>();
  const incomingCount = new Map<string, number>();
  for (const e of finalEdges) {
    outgoingCount.set(e.from, (outgoingCount.get(e.from) ?? 0) + 1);
    incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
  }

  const nodes: SnapshotNode[] = finalDigests.map((line) => {
    const outgoing = outgoingCount.get(line.id) ?? 0;
    const incoming = incomingCount.get(line.id) ?? 0;
    return {
      id: line.id,
      title: line.title,
      kind: line.kind,
      kinds: line.kinds,
      domainTags: line.domainTags,
      importance: line.importance,
      freshness: line.freshness,
      status: line.status,
      emotionalValence: line.emotionalValence,
      createdBy: line.createdBy,
      createdAt: line.createdAt,
      updatedAt: line.updatedAt,
      retrievalCount: line.retrievalCount,
      effectiveRetrievals: line.effectiveRetrievals,
      reinforcementScore: line.reinforcementScore,
      outgoingCount: outgoing,
      incomingCount: incoming,
      isHub: line.incomingSynapseCount >= HUB_INCOMING_THRESHOLD,
    };
  });

  // --- Step 4: 预设 orphansOnly ---
  let finalNodes = nodes;
  if (filter.orphansOnly) {
    finalNodes = nodes.filter(
      (n) => n.outgoingCount === 0 && n.incomingCount === 0,
    );
    const keepIds = new Set(finalNodes.map((n) => n.id));
    finalEdges = finalEdges.filter(
      (e) => keepIds.has(e.from) && keepIds.has(e.to),
    );
  }

  // --- 统计 ---
  const stats = computeStats(finalNodes, finalEdges);

  return { nodes: finalNodes, edges: finalEdges, stats };
}

// ============================================================
// 过滤匹配
// ============================================================

function matchesNodeFilter(line: DigestLine, filter: GraphFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(line.kind as EngramKind))
    return false;
  if (
    filter.domainTags &&
    !filter.domainTags.some((d) => line.domainTags.includes(d))
  )
    return false;
  if (
    filter.freshness &&
    !filter.freshness.includes(line.freshness as EngramFreshness)
  )
    return false;
  if (filter.status && !filter.status.includes(line.status as EngramStatus))
    return false;
  if (
    filter.emotionalValence &&
    !filter.emotionalValence.includes(line.emotionalValence as EmotionalValence)
  )
    return false;
  if (filter.createdBy && !filter.createdBy.includes(line.createdBy))
    return false;
  if (filter.createdAfter && line.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore && line.createdAt > filter.createdBefore)
    return false;
  if (
    filter.minImportance !== undefined &&
    line.importance < filter.minImportance
  )
    return false;
  if (
    filter.maxImportance !== undefined &&
    line.importance > filter.maxImportance
  )
    return false;
  return true;
}

function matchesEdgeFilter(edge: GraphEdge, filter: GraphFilter): boolean {
  if (filter.synapseKinds && !filter.synapseKinds.includes(edge.kind))
    return false;
  if (filter.synapseFamilies) {
    const meta = getSynapseKindMeta(edge.kind);
    if (!filter.synapseFamilies.includes(meta.family)) return false;
  }
  if (filter.minWeight !== undefined && edge.weight < filter.minWeight)
    return false;
  if (filter.hideContradicts && edge.kind === "contradicts") return false;
  return true;
}

function toSnapshotEdge(edge: GraphEdge): SnapshotEdge {
  const meta = getSynapseKindMeta(edge.kind);
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    family: meta.family,
    weight: edge.weight,
    direction: edge.direction,
    isContradiction: edge.kind === "contradicts",
  };
}

function computeStats(
  nodes: readonly SnapshotNode[],
  edges: readonly SnapshotEdge[],
): GraphSnapshotStats {
  const byKind: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const byFreshness: Record<string, number> = {};
  let orphanCount = 0;
  let hubCount = 0;
  for (const n of nodes) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    for (const d of n.domainTags) byDomain[d] = (byDomain[d] ?? 0) + 1;
    byFreshness[n.freshness] = (byFreshness[n.freshness] ?? 0) + 1;
    if (n.outgoingCount === 0 && n.incomingCount === 0) orphanCount += 1;
    if (n.isHub) hubCount += 1;
  }
  const contradictionCount = edges.filter((e) => e.isContradiction).length;
  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    orphanCount,
    hubCount,
    contradictionCount,
    byKind,
    byDomain,
    byFreshness,
  };
}
