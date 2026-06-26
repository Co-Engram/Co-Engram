/**
 * Graph View 自动聚类（spec §12.8，P3 4.7.3）
 *
 * 当节点数超过阈值（默认 5000）时，按 domain 自动折叠为超节点（super-node）。
 * 用户点击 super-node 时再展开子图。
 *
 * 聚类策略：
 *   - 主聚类维度：domainTags[0]（与 domain-cluster 布局一致）
 *   - 二级聚类：kind（同 domain 内按 kind 分子簇）
 *   - 边聚合：跨簇的边被合并为簇间边（带 weight sum）
 *
 * 输出：ClusteredGraph（superNodes + superEdges）
 *
 * @module @co-engram/core/graph
 */

import type { GraphSnapshot, SnapshotNode, SnapshotEdge } from "./snapshot.js";

/** 节点数阈值（spec §12.8：> 5000 节点时启用聚类） */
export const DEFAULT_CLUSTER_THRESHOLD = 5000;

/** 每个超节点最少包含的原始节点数（少于则不合并） */
export const DEFAULT_MIN_CLUSTER_SIZE = 5;

/** 超节点（聚类后的虚拟节点） */
export interface SuperNode {
  /** Cluster ID：`cluster:<domain>:<kind>` 或 `cluster:<domain>` */
  readonly id: string;
  /** 显示标签 */
  readonly label: string;
  /** 主 domain */
  readonly domain: string;
  /** 主 kind（如果按 kind 二级聚类） */
  readonly kind?: string;
  /** 包含的原始节点 ID 列表 */
  readonly memberIds: readonly string[];
  /** 成员数 */
  readonly memberCount: number;
  /** 派生：平均 importance */
  readonly avgImportance: number;
  /** 派生：平均 retrievalCount */
  readonly totalRetrievalCount: number;
  /** 派生：总 effectiveRetrievals */
  readonly totalEffectiveRetrievals: number;
  /** 派生：是否 hub 簇（memberCount ≥ hubClusterSize） */
  readonly isHubCluster: boolean;
}

/** 超边（聚类后的虚拟边） */
export interface SuperEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** 聚合的原始边数 */
  readonly aggregatedCount: number;
  /** 总 weight（求和） */
  readonly totalWeight: number;
  /** 主导 kind（出现频率最高的） */
  readonly dominantKind: string;
  /** 是否含 contradicts（至少一条原始边是 contradicts） */
  readonly hasContradiction: boolean;
}

/** 聚类后的图 */
export interface ClusteredGraph {
  readonly superNodes: readonly SuperNode[];
  readonly superEdges: readonly SuperEdge[];
  /** 未被聚类的独立节点（memberCount < minClusterSize） */
  readonly standaloneNodes: readonly SnapshotNode[];
  /** 未被聚类的独立边 */
  readonly standaloneEdges: readonly SnapshotEdge[];
  readonly stats: ClusterStats;
}

export interface ClusterStats {
  readonly totalSuperNodes: number;
  readonly totalSuperEdges: number;
  readonly totalStandaloneNodes: number;
  /** 聚类压缩比 = superNodes / originalNodes */
  readonly compressionRatio: number;
  /** 最大簇大小 */
  readonly maxClusterSize: number;
  readonly avgClusterSize: number;
}

export interface ClusterOptions {
  /** 启用阈值：节点数 > threshold 才聚类（默认 5000） */
  readonly threshold?: number;
  /** 最小簇大小（小于则作为 standalone 保留） */
  readonly minClusterSize?: number;
  /** hub 簇阈值（memberCount ≥ 此值视为 hub） */
  readonly hubClusterSize?: number;
  /** 二级聚类：同 domain 内按 kind 分子簇（默认 true） */
  readonly secondaryByKind?: boolean;
}

export const DEFAULT_HUB_CLUSTER_SIZE = 50;

/**
 * 主聚类函数
 *
 * 行为：
 *   1. 节点数 ≤ threshold → 直接返回（不聚类）
 *   2. 按 domain 分组（domainTags[0]）
 *   3. 可选：同 domain 内按 kind 二级分组
 *   4. 每个 size ≥ minClusterSize 的组成为一个 SuperNode
 *   5. 边聚合：跨 super-node 的边合并
 *
 * @returns ClusteredGraph
 */
export function clusterSnapshot(
  snapshot: GraphSnapshot,
  options: ClusterOptions = {},
): ClusteredGraph {
  const threshold = options.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const hubClusterSize = options.hubClusterSize ?? DEFAULT_HUB_CLUSTER_SIZE;
  const secondaryByKind = options.secondaryByKind ?? true;

  // 节点数不超阈值 → 不聚类
  if (snapshot.nodes.length <= threshold) {
    return {
      superNodes: [],
      superEdges: [],
      standaloneNodes: [...snapshot.nodes],
      standaloneEdges: [...snapshot.edges],
      stats: {
        totalSuperNodes: 0,
        totalSuperEdges: 0,
        totalStandaloneNodes: snapshot.nodes.length,
        compressionRatio: 1,
        maxClusterSize: 0,
        avgClusterSize: 0,
      },
    };
  }

  // Step 1: 按 (domain, kind?) 分组
  const groupKey = (n: SnapshotNode): string => {
    const domain = n.domainTags[0] ?? "__no_domain__";
    if (!secondaryByKind) return domain;
    return `${domain}::${n.kind}`;
  };

  const groups = new Map<string, SnapshotNode[]>();
  for (const node of snapshot.nodes) {
    const key = groupKey(node);
    const arr = groups.get(key) ?? [];
    arr.push(node);
    groups.set(key, arr);
  }

  // Step 2: 拆分 large groups (≥ minClusterSize) 和 small groups (standalone)
  const largeGroups = new Map<string, SnapshotNode[]>();
  const standaloneNodeIds = new Set<string>();
  for (const [key, group] of groups) {
    if (group.length >= minClusterSize) {
      largeGroups.set(key, group);
    } else {
      for (const n of group) {
        standaloneNodeIds.add(n.id);
      }
    }
  }

  // Step 3: 为每个 node 映射到 clusterId（或 standalone）
  const nodeToCluster = new Map<string, string>();
  const superNodes: SuperNode[] = [];

  for (const [key, group] of largeGroups) {
    const [domain, kind] = key.split("::");
    const clusterId = kind ? `cluster:${domain}:${kind}` : `cluster:${domain}`;

    const memberIds = group.map((n) => n.id);
    for (const n of group) {
      nodeToCluster.set(n.id, clusterId);
    }

    // 派生统计
    const avgImportance =
      group.reduce((s, n) => s + n.importance, 0) / group.length;
    const totalRetrieval = group.reduce((s, n) => s + n.retrievalCount, 0);
    const totalEffective = group.reduce((s, n) => s + n.effectiveRetrievals, 0);

    superNodes.push({
      id: clusterId,
      label: kind
        ? `${domain} / ${kind} (${group.length})`
        : `${domain} (${group.length})`,
      domain: domain ?? "__no_domain__",
      kind: kind ?? undefined,
      memberIds,
      memberCount: group.length,
      avgImportance,
      totalRetrievalCount: totalRetrieval,
      totalEffectiveRetrievals: totalEffective,
      isHubCluster: group.length >= hubClusterSize,
    });
  }

  // Step 4: 边聚合
  const standaloneNodes = snapshot.nodes.filter((n) =>
    standaloneNodeIds.has(n.id),
  );
  const standaloneEdges: SnapshotEdge[] = [];
  const superEdgeMap = new Map<string, SuperEdge>();

  for (const edge of snapshot.edges) {
    const fromCluster = nodeToCluster.get(edge.from);
    const toCluster = nodeToCluster.get(edge.to);

    // 两端都是 standalone → 保留原始边
    if (fromCluster === undefined && toCluster === undefined) {
      standaloneEdges.push(edge);
      continue;
    }

    // 至少一端在 cluster 中 → 聚合
    const fromId = fromCluster ?? edge.from;
    const toId = toCluster ?? edge.to;

    // 自环（同 cluster 内部边）：跳过（不显示）
    if (fromId === toId) continue;

    const edgeKey = `${fromId}-->${toId}`;
    const existing = superEdgeMap.get(edgeKey);
    if (existing) {
      // 聚合：增加 count + sum weight
      superEdgeMap.set(edgeKey, {
        ...existing,
        aggregatedCount: existing.aggregatedCount + 1,
        totalWeight: existing.totalWeight + edge.weight,
        hasContradiction: existing.hasContradiction || edge.isContradiction,
      });
    } else {
      superEdgeMap.set(edgeKey, {
        id: `se-${edgeKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        from: fromId,
        to: toId,
        aggregatedCount: 1,
        totalWeight: edge.weight,
        dominantKind: edge.kind,
        hasContradiction: edge.isContradiction,
      });
    }
  }

  const superEdges = [...superEdgeMap.values()];

  // 统计
  const clusterSizes = superNodes.map((s) => s.memberCount);
  const maxClusterSize = clusterSizes.reduce((m, s) => Math.max(m, s), 0);
  const avgClusterSize =
    clusterSizes.length > 0
      ? clusterSizes.reduce((s, n) => s + n, 0) / clusterSizes.length
      : 0;
  const compressionRatio =
    snapshot.nodes.length > 0
      ? (superNodes.length + standaloneNodes.length) / snapshot.nodes.length
      : 1;

  return {
    superNodes,
    superEdges,
    standaloneNodes,
    standaloneEdges,
    stats: {
      totalSuperNodes: superNodes.length,
      totalSuperEdges: superEdges.length,
      totalStandaloneNodes: standaloneNodes.length,
      compressionRatio,
      maxClusterSize,
      avgClusterSize,
    },
  };
}

/**
 * 展开一个 super-node：返回其成员节点的子图
 *
 * 用于"点击 super-node 展开子图"场景（spec §12.8）。
 */
export function expandSuperNode(
  snapshot: GraphSnapshot,
  superNode: SuperNode,
): {
  readonly nodes: readonly SnapshotNode[];
  readonly edges: readonly SnapshotEdge[];
} {
  const memberIds = new Set(superNode.memberIds);
  const nodes = snapshot.nodes.filter((n) => memberIds.has(n.id));
  const edges = snapshot.edges.filter(
    (e) => memberIds.has(e.from) && memberIds.has(e.to),
  );
  return { nodes, edges };
}

/**
 * 判断是否需要聚类
 *
 * 工具函数：UI 层可以根据节点数决定是否切换到聚类模式。
 */
export function shouldCluster(
  nodeCount: number,
  threshold: number = DEFAULT_CLUSTER_THRESHOLD,
): boolean {
  return nodeCount > threshold;
}
