/**
 * Graph 索引构建器
 *
 * 从所有 engrams/synapses/*.yaml 收集所有出边，构建 graph.json 索引。
 *
 * @module @co-engram/core/index
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import type { GraphEdge, GraphIndex, GraphNode } from "./types.js";

/**
 * Graph 构建器
 */
export class GraphBuilder {
  constructor(
    private readonly repo: EngramRepository,
    private readonly cachePath: string,
  ) {}

  /** graph.json 路径 */
  get graphFilePath(): string {
    return join(this.cachePath, "graph.json");
  }

  /**
   * 完全重建 graph 索引
   */
  rebuild(): { nodes: number; edges: number } {
    const allSynapses = this.repo.collectAllSynapses();
    const allEngrams = this.repo.listEngrams();

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const outgoingAdjacency: Record<string, string[]> = {};
    const incomingAdjacency: Record<string, string[]> = {};

    // 先构建邻接表骨架
    const allIds = new Set<string>(allEngrams.map((e) => e.id));
    for (const id of allIds) {
      outgoingAdjacency[id] = [];
      incomingAdjacency[id] = [];
    }

    // 添加边
    for (const { fromId, synapse } of allSynapses) {
      // 确保 from 和 to 都有邻接表项
      if (!outgoingAdjacency[fromId]) outgoingAdjacency[fromId] = [];
      if (!incomingAdjacencyHelper(incomingAdjacency, fromId))
        incomingAdjacency[fromId] = [];

      if (!outgoingAdjacency[synapse.to]) outgoingAdjacency[synapse.to] = [];
      if (!incomingAdjacencyHelper(incomingAdjacency, synapse.to))
        incomingAdjacency[synapse.to] = [];

      edges.push({
        id: synapse.id,
        from: fromId,
        to: synapse.to,
        kind: synapse.kind,
        weight: synapse.weight,
        direction: synapse.direction,
      });
      outgoingAdjacency[fromId]!.push(synapse.id);
      incomingAdjacency[synapse.to]!.push(synapse.id);
    }

    // 构建节点（读 digest 缓存或重新读）
    for (const entry of allEngrams) {
      const engram = this.repo.exists(entry.id)
        ? this.repo.readEngram(entry.id)
        : null;
      nodes.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        importance: engram?.importance ?? 0.5,
        outgoingCount: outgoingAdjacency[entry.id]?.length ?? 0,
        incomingCount: incomingAdjacency[entry.id]?.length ?? 0,
      });
    }

    const index: GraphIndex = {
      nodes,
      edges,
      outgoingAdjacency,
      incomingAdjacency,
    };

    this.write(index);
    return { nodes: nodes.length, edges: edges.length };
  }

  /**
   * 读取 graph.json
   */
  read(): GraphIndex | null {
    if (!existsSync(this.graphFilePath)) {
      return null;
    }
    const raw = readFileSync(this.graphFilePath, "utf8");
    return JSON.parse(raw) as GraphIndex;
  }

  private write(index: GraphIndex): void {
    mkdirSync(this.cachePath, { recursive: true });
    writeFileSync(this.graphFilePath, JSON.stringify(index, null, 2), "utf8");
  }
}

/** 辅助：检查 incomingAdjacency 是否有 key（避免 hasOwnProperty 调用） */
function incomingAdjacencyHelper(
  adj: Record<string, string[]>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(adj, key);
}
