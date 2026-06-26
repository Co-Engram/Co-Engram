/**
 * 图遍历操作
 *
 * 基于 graph.json 索引（来自派生缓存）做 BFS / DFS / 邻居查询
 *
 * @module @co-engram/core/graph
 */

import type { EngramId } from "../types/engram.js";
import type { SynapseKind } from "../types/synapse.js";
import type { GraphEdge, GraphIndex } from "../index/types.js";

/** 邻居查询选项 */
export interface GetNeighborsOptions {
  /** 最大深度（默认 1） */
  readonly depth?: number;
  /** 限制方向：outgoing（出边） / incoming（入边） / both */
  readonly direction?: "outgoing" | "incoming" | "both";
  /** 过滤 Synapse kind */
  readonly kinds?: readonly SynapseKind[];
  /** 最小 weight */
  readonly minWeight?: number;
  /** 最大结果数 */
  readonly limit?: number;
}

/** 邻居节点 */
export interface NeighborNode {
  readonly id: EngramId;
  readonly depth: number;
  readonly viaEdge: GraphEdge;
}

/**
 * 从 graph.json 索引构建遍历器
 */
export class GraphTraverser {
  constructor(private readonly index: GraphIndex) {}

  /**
   * 获取一阶或多阶邻居
   */
  getNeighbors(
    startId: EngramId,
    options: GetNeighborsOptions = {},
  ): NeighborNode[] {
    const {
      depth = 1,
      direction = "both",
      kinds,
      minWeight = 0,
      limit = 100,
    } = options;

    const result: NeighborNode[] = [];
    const visited = new Set<string>([startId]);
    const queue: Array<{ id: EngramId; depth: number }> = [
      { id: startId, depth: 0 },
    ];

    while (queue.length > 0 && result.length < limit) {
      const { id, depth: currentDepth } = queue.shift()!;
      if (currentDepth >= depth) {
        continue;
      }

      const nextEdges = this.collectEdges(id, direction);
      for (const edge of nextEdges) {
        if (result.length >= limit) break;
        if (kinds && !kinds.includes(edge.kind)) continue;
        if (edge.weight < minWeight) continue;

        const nextId = edge.from === id ? edge.to : edge.from;
        if (visited.has(nextId)) {
          continue;
        }
        visited.add(nextId);
        result.push({ id: nextId, depth: currentDepth + 1, viaEdge: edge });
        queue.push({ id: nextId, depth: currentDepth + 1 });
      }
    }

    return result;
  }

  /**
   * 收集节点的所有相关边
   */
  private collectEdges(
    id: EngramId,
    direction: "outgoing" | "incoming" | "both",
  ): GraphEdge[] {
    const result: GraphEdge[] = [];
    const edgeMap = new Map<string, GraphEdge>();
    for (const edge of this.index.edges) {
      edgeMap.set(edge.id, edge);
    }

    if (direction === "outgoing" || direction === "both") {
      const edgeIds = this.index.outgoingAdjacency[id] ?? [];
      for (const eid of edgeIds) {
        const e = edgeMap.get(eid);
        if (e) result.push(e);
      }
    }

    if (direction === "incoming" || direction === "both") {
      const edgeIds = this.index.incomingAdjacency[id] ?? [];
      for (const eid of edgeIds) {
        const e = edgeMap.get(eid);
        if (e) result.push(e);
      }
    }

    return result;
  }

  /**
   * 查找两个节点之间的路径（BFS 最短路径）
   */
  findPaths(fromId: EngramId, toId: EngramId, maxDepth = 5): EngramId[][] {
    if (fromId === toId) {
      return [[fromId]];
    }

    const paths: EngramId[][] = [];
    const queue: Array<{ id: EngramId; path: EngramId[] }> = [
      { id: fromId, path: [fromId] },
    ];
    const visited = new Set<string>([fromId]);

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (path.length > maxDepth) {
        continue;
      }

      const nextEdges = this.collectEdges(id, "both");
      for (const edge of nextEdges) {
        const nextId = edge.from === id ? edge.to : edge.from;
        if (visited.has(nextId)) {
          continue;
        }
        const newPath = [...path, nextId];
        if (nextId === toId) {
          paths.push(newPath);
          if (paths.length >= 10) {
            return paths;
          }
          continue;
        }
        visited.add(nextId);
        queue.push({ id: nextId, path: newPath });
      }
    }

    return paths;
  }

  /**
   * 遍历整个图（BFS）
   */
  traverse(startId: EngramId, maxDepth = 3): NeighborNode[] {
    return this.getNeighbors(startId, {
      depth: maxDepth,
      direction: "both",
      limit: 1000,
    });
  }

  /**
   * 检查节点是否孤立（无连接）
   */
  isIsolated(id: EngramId): boolean {
    const outgoing = this.index.outgoingAdjacency[id]?.length ?? 0;
    const incoming = this.index.incomingAdjacency[id]?.length ?? 0;
    return outgoing === 0 && incoming === 0;
  }

  /**
   * 获取入度 + 出度
   */
  getDegree(id: EngramId): {
    outgoing: number;
    incoming: number;
    total: number;
  } {
    const outgoing = this.index.outgoingAdjacency[id]?.length ?? 0;
    const incoming = this.index.incomingAdjacency[id]?.length ?? 0;
    return { outgoing, incoming, total: outgoing + incoming };
  }

  /**
   * 查找 Hub 节点（入度 ≥ threshold）
   */
  findHubs(threshold = 5): Array<{ id: EngramId; incoming: number }> {
    return this.index.nodes
      .filter((n) => n.incomingCount >= threshold)
      .map((n) => ({ id: n.id, incoming: n.incomingCount }))
      .sort((a, b) => b.incoming - a.incoming);
  }

  /**
   * 列出所有 contradicts 边
   */
  findContradictions(): GraphEdge[] {
    return this.index.edges.filter((e) => e.kind === "contradicts");
  }

  /**
   * 查找所有孤立节点
   */
  findOrphans(): EngramId[] {
    return this.index.nodes
      .filter((n) => n.outgoingCount === 0 && n.incomingCount === 0)
      .map((n) => n.id);
  }

  /**
   * 沿特定 kind 链追溯（如 derives_from / consolidates / supersedes）
   */
  traceLineage(
    startId: EngramId,
    kind: SynapseKind,
    maxDepth = 10,
  ): EngramId[] {
    const chain: EngramId[] = [startId];
    const visited = new Set<string>([startId]);
    let current: EngramId | null = startId;

    for (let i = 0; i < maxDepth && current; i++) {
      const currentId: EngramId = current;
      const outgoing: GraphEdge[] = (
        this.index.outgoingAdjacency[currentId] ?? []
      )
        .map((eid) => this.index.edges.find((e) => e.id === eid))
        .filter((e): e is GraphEdge => e !== undefined)
        .filter((e) => e.kind === kind);

      if (outgoing.length === 0) {
        break;
      }
      const next: EngramId = outgoing[0]!.to;
      if (visited.has(next)) {
        break;
      }
      visited.add(next);
      chain.push(next);
      current = next;
    }

    return chain;
  }
}
