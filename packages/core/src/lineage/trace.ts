/**
 * 进化血统追溯（spec §3.4 / §12.7 场景 6，P3 4.6）
 *
 * 语义级 commit history：通过 synapse 图谱追溯 engram 的"祖先"和"后代"。
 *
 * 支持的血统 synapse kind（spec §12.7）：
 *   - derives_from：A 从 B 派生（如 hypothesis 从多个 observation 派生）
 *   - consolidates：A 整合 B（如 pattern 从多个 fact 整合）
 *   - supersedes：A 取代 B（如新版 procedure 取代旧版）
 *
 * 追溯方向：
 *   - ancestors：当前 engram 的"来源"（沿 outgoing 这些 kind 找 to）
 *     例如 hypothesis.derives_from → observation
 *   - descendants：当前 engram 的"演化结果"（沿 incoming 找 from）
 *     例如 observation 被 hypothesis.derives_from 引用
 *
 * 返回 DAG（防止环），按 BFS 保证最短路径。
 *
 * @module @co-engram/core/lineage
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramId, EngramKind } from "../types/engram.js";
import type { SynapseKind } from "../types/synapse.js";
import { notFoundError } from "../tools/error-schema.js";

/** 血统 synapse kind 集合 */
export const LINEAGE_KINDS: ReadonlySet<SynapseKind> = new Set<SynapseKind>([
  "derives_from",
  "consolidates",
  "supersedes",
]);

/** 血统关系类型（self 或三种 lineage kind 之一） */
export type LineageRelation =
  | "self"
  | "derives_from"
  | "consolidates"
  | "supersedes";

/** 类型守卫：将 SynapseKind 收窄为 LineageRelation */
function asLineageRelation(kind: SynapseKind): LineageRelation {
  if (
    kind === "derives_from" ||
    kind === "consolidates" ||
    kind === "supersedes"
  ) {
    return kind;
  }
  // 理论上不会到这（LINEAGE_KINDS.has 已过滤）
  return "self";
}

/** 单个血统节点 */
export interface LineageNode {
  readonly engramId: EngramId;
  readonly title: string;
  readonly kind: EngramKind;
  /** 距离起点的深度（root=0） */
  readonly depth: number;
  /**
   * 到达此节点的血统关系：
   *   - 'self'：起点本身
   *   - 'derives_from' / 'consolidates' / 'supersedes'：经过的 synapse kind
   */
  readonly relation: LineageRelation;
  /** 触达此节点的 synapse ID（self 时为 undefined） */
  readonly viaSynapseId?: string;
  /** 创建时间（用于排序） */
  readonly createdAt: string;
  /** 创建者 */
  readonly createdBy: string;
}

/** 单条血统边 */
export interface LineageEdge {
  readonly from: EngramId;
  readonly to: EngramId;
  readonly kind: SynapseKind;
  readonly synapseId: string;
  /** 边的方向：root → ancestor（追溯历史）或 descendant → root（演化结果） */
  readonly direction: "ancestor" | "descendant";
}

/** 血统查询方向 */
export type LineageDirection = "ancestors" | "descendants" | "both";

/** 完整血统图 */
export interface EvolutionLineage {
  /** 起点 engram ID */
  readonly rootId: EngramId;
  /** 所有节点（包括 root） */
  readonly nodes: readonly LineageNode[];
  /** 所有边 */
  readonly edges: readonly LineageEdge[];
  /** 最大深度 */
  readonly maxDepth: number;
  /** 节点总数 */
  readonly totalNodes: number;
  /**
   * 起源节点（ancestors 方向的叶子，无更深的 ancestor）
   * 例：observation 是最原始的来源
   */
  readonly origins: readonly EngramId[];
  /**
   * 终点节点（descendants 方向的叶子，无更深的 descendant）
   * 例：procedure / skill 是演化的最终形态
   */
  readonly terminals: readonly EngramId[];
  /** 是否检测到环（边数异常多时） */
  readonly hasCycle: boolean;
}

/** 查询选项 */
export interface GetLineageOptions {
  /** 追溯方向（默认 both） */
  readonly direction?: LineageDirection;
  /** 最大深度（默认 10） */
  readonly maxDepth?: number;
  /** 限制使用的 synapse kind（默认全部三种） */
  readonly kinds?: readonly SynapseKind[];
}

const DEFAULT_MAX_DEPTH = 10;

/**
 * 获取 engram 的完整进化血统
 *
 * 算法：双向 BFS
 *   - ancestors 方向：从 root 出发，沿 outgoing(d|c|s) 找 to（历史来源）
 *   - descendants 方向：从 root 出发，遍历所有 engram 的 outgoing，找指向 root 的 synapse
 *
 * 防环：visited set 跟踪所有访问过的 engramId；同一 engram 可能从多条路径触达，
 *      但只保留最短路径的 depth。
 *
 * @returns EvolutionLineage
 */
export function getEvolutionLineage(
  repo: EngramRepository,
  engramId: EngramId,
  options: GetLineageOptions = {},
): EvolutionLineage {
  if (!repo.exists(engramId)) {
    throw notFoundError("Engram", engramId);
  }

  const direction = options.direction ?? "both";
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const allowedKinds = options.kinds
    ? new Set(options.kinds)
    : new Set<SynapseKind>([...LINEAGE_KINDS]);

  const rootEngram = repo.readEngram(engramId);

  // nodes map：engramId → LineageNode（保留最短 depth）
  const nodesMap = new Map<EngramId, LineageNode>();
  const edges: LineageEdge[] = [];
  // 全局 visited（ancestors + descendants 共享）
  const globalVisited = new Set<EngramId>([engramId]);

  // root
  nodesMap.set(engramId, {
    engramId,
    title: rootEngram.title,
    kind: rootEngram.kind,
    depth: 0,
    relation: "self",
    createdAt: rootEngram.createdAt,
    createdBy: rootEngram.createdBy,
  });

  // ============================================================
  // ancestors 方向：root.outgoing(d|c|s).to
  // ============================================================
  if (direction === "ancestors" || direction === "both") {
    const queue: Array<{ id: EngramId; depth: number }> = [
      { id: engramId, depth: 0 },
    ];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const file = repo.readSynapses(id);
      for (const syn of file.outgoing) {
        if (!allowedKinds.has(syn.kind)) continue;
        if (!LINEAGE_KINDS.has(syn.kind)) continue;
        if (!repo.exists(syn.to)) continue;

        edges.push({
          from: id,
          to: syn.to,
          kind: syn.kind,
          synapseId: syn.id,
          direction: "ancestor",
        });

        if (globalVisited.has(syn.to)) {
          continue;
        }
        globalVisited.add(syn.to);

        const ancestorEngram = repo.readEngram(syn.to);
        nodesMap.set(syn.to, {
          engramId: syn.to,
          title: ancestorEngram.title,
          kind: ancestorEngram.kind,
          depth: depth + 1,
          relation: asLineageRelation(syn.kind),
          viaSynapseId: syn.id,
          createdAt: ancestorEngram.createdAt,
          createdBy: ancestorEngram.createdBy,
        });

        queue.push({ id: syn.to, depth: depth + 1 });
      }
    }
  }

  // ============================================================
  // descendants 方向：扫描仓库的 outgoing，找指向当前节点的 synapse
  // ============================================================
  if (direction === "descendants" || direction === "both") {
    const queue: Array<{ id: EngramId; depth: number }> = [
      { id: engramId, depth: 0 },
    ];
    const localVisited = new Set<EngramId>([engramId]);

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      for (const entry of repo.listEngrams()) {
        if (entry.id === id) continue;
        const file = repo.readSynapses(entry.id);
        for (const syn of file.outgoing) {
          if (!allowedKinds.has(syn.kind)) continue;
          if (!LINEAGE_KINDS.has(syn.kind)) continue;
          if (syn.to !== id) continue;

          edges.push({
            from: entry.id,
            to: id,
            kind: syn.kind,
            synapseId: syn.id,
            direction: "descendant",
          });

          if (localVisited.has(entry.id)) {
            continue;
          }
          localVisited.add(entry.id);
          globalVisited.add(entry.id);

          const descEngram = repo.readEngram(entry.id);
          nodesMap.set(entry.id, {
            engramId: entry.id,
            title: descEngram.title,
            kind: descEngram.kind,
            depth: depth + 1,
            relation: asLineageRelation(syn.kind),
            viaSynapseId: syn.id,
            createdAt: descEngram.createdAt,
            createdBy: descEngram.createdBy,
          });

          queue.push({ id: entry.id, depth: depth + 1 });
        }
      }
    }
  }

  // 简单的环检测：边数 > 节点数 * 2 时疑似有环
  const hasCycle = edges.length > nodesMap.size * 2;

  // 收集结果
  const nodes = [...nodesMap.values()].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.engramId < b.engramId ? -1 : 1;
  });

  const maxDepthFound = nodes.reduce((m, n) => Math.max(m, n.depth), 0);

  // origins：ancestors 方向的叶子节点（深度 > 0 + 没有更深的 ancestor 出边）
  const ancestorEdgeTargets = new Set(
    edges.filter((e) => e.direction === "ancestor").map((e) => e.to),
  );
  const ancestorEdgeSources = new Set(
    edges.filter((e) => e.direction === "ancestor").map((e) => e.from),
  );
  const origins = [...ancestorEdgeTargets].filter(
    (id) => !ancestorEdgeSources.has(id),
  );

  // terminals：descendants 方向的叶子节点（作为 descendant 但没有更深的 descendant）
  const descendantEdgeSources = new Set(
    edges.filter((e) => e.direction === "descendant").map((e) => e.from),
  );
  const descendantEdgeTargets = new Set(
    edges.filter((e) => e.direction === "descendant").map((e) => e.to),
  );
  const terminals = [...descendantEdgeSources].filter(
    (id) => !descendantEdgeTargets.has(id),
  );

  return {
    rootId: engramId,
    nodes,
    edges,
    maxDepth: maxDepthFound,
    totalNodes: nodes.length,
    origins,
    terminals,
    hasCycle,
  };
}

// ============================================================
// 便捷函数
// ============================================================

/**
 * 仅追溯祖先（直接、间接来源）
 */
export function getAncestors(
  repo: EngramRepository,
  engramId: EngramId,
  options: Omit<GetLineageOptions, "direction"> = {},
): EvolutionLineage {
  return getEvolutionLineage(repo, engramId, {
    ...options,
    direction: "ancestors",
  });
}

/**
 * 仅追溯后代（直接、间接演化结果）
 */
export function getDescendants(
  repo: EngramRepository,
  engramId: EngramId,
  options: Omit<GetLineageOptions, "direction"> = {},
): EvolutionLineage {
  return getEvolutionLineage(repo, engramId, {
    ...options,
    direction: "descendants",
  });
}

/**
 * 追溯到原 observation（最深的 ancestor 中 kind=observation 的）
 *
 * spec §4.6 验收：从 Skill 反向追溯到原 observation 的完整链路。
 */
export function traceToOriginObservations(
  repo: EngramRepository,
  engramId: EngramId,
  options: Omit<GetLineageOptions, "direction"> = {},
): readonly EngramId[] {
  const lineage = getEvolutionLineage(repo, engramId, {
    ...options,
    direction: "ancestors",
  });
  // 在 origins 中找 kind=observation
  const result: EngramId[] = [];
  for (const originId of lineage.origins) {
    const node = lineage.nodes.find((n) => n.engramId === originId);
    if (node && node.kind === "observation") {
      result.push(originId);
    }
  }
  return result;
}

/**
 * 从 root 到指定 ancestor 的路径（任一最短路径）
 *
 * @returns 节点序列；不存在时返回空
 */
export function findPathToAncestor(
  repo: EngramRepository,
  fromId: EngramId,
  toAncestorId: EngramId,
  options: Omit<GetLineageOptions, "direction"> = {},
): readonly EngramId[] {
  const lineage = getEvolutionLineage(repo, fromId, {
    ...options,
    direction: "ancestors",
  });

  if (!lineage.nodes.some((n) => n.engramId === toAncestorId)) {
    return [];
  }

  // 反向追溯：从 ancestor 回到 root
  // ancestor 方向边：from=root-side, to=ancestor-side
  // 所以 to 的 parent 是 from
  const parentMap = new Map<EngramId, EngramId>();
  for (const edge of lineage.edges) {
    if (edge.direction !== "ancestor") continue;
    if (!parentMap.has(edge.to)) {
      parentMap.set(edge.to, edge.from);
    }
  }

  const path: EngramId[] = [toAncestorId];
  let current: EngramId | undefined = toAncestorId;
  // 防止死循环
  for (let i = 0; i < lineage.nodes.length + 1; i++) {
    if (current === fromId) break;
    const parent = parentMap.get(current!);
    if (!parent) break;
    path.unshift(parent);
    current = parent;
  }

  return current === fromId ? path : [];
}

/**
 * 统计：仓库的血统健康度
 *
 *   - totalLineageEdges：derives_from + consolidates + supersedes 总边数
 *   - engramsWithLineage：有血统关系的 engram 数
 *   - orphanEngrams：无任何血统关系的 engram 数（独立存在的）
 *   - avgDepth：平均血统深度
 */
export interface LineageStats {
  readonly totalLineageEdges: number;
  readonly engramsWithLineage: number;
  readonly orphanEngrams: number;
  readonly avgDepth: number;
  readonly maxDepth: number;
}

export function computeLineageStats(repo: EngramRepository): LineageStats {
  let totalEdges = 0;
  const engramsWithLineage = new Set<EngramId>();
  const allEngrams = repo.listEngrams();

  for (const entry of allEngrams) {
    const file = repo.readSynapses(entry.id);
    for (const syn of file.outgoing) {
      if (!LINEAGE_KINDS.has(syn.kind)) continue;
      if (!repo.exists(syn.to)) continue;
      totalEdges += 1;
      engramsWithLineage.add(entry.id);
      engramsWithLineage.add(syn.to);
    }
  }

  let maxDepth = 0;
  let depthSum = 0;
  let counted = 0;
  for (const entry of engramsWithLineage) {
    const lineage = getEvolutionLineage(repo, entry, {
      direction: "both",
      maxDepth: 5,
    });
    if (lineage.maxDepth > maxDepth) maxDepth = lineage.maxDepth;
    depthSum += lineage.maxDepth;
    counted += 1;
  }
  const avgDepth = counted > 0 ? depthSum / counted : 0;

  return {
    totalLineageEdges: totalEdges,
    engramsWithLineage: engramsWithLineage.size,
    orphanEngrams: allEngrams.length - engramsWithLineage.size,
    avgDepth,
    maxDepth,
  };
}
