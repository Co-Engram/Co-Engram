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
import { isSymmetricKind } from "../types/synapse.js";

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

    // 额外取 slug(viewer 路由跳转用,frontmatter 显式锁或从 title 派生)
    // listEngramIndex 来自 engram-index.json,毫秒级,不扫盘
    const slugById = new Map<string, string>();
    try {
      for (const e of this.repo.listEngramIndex()) {
        slugById.set(e.id, e.slug);
      }
    } catch {
      // 索引不可用就降级为不带 slug(viewer 端会用 id 跳转)
    }

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
      // 过滤 dangling synapse:from/to 任一不在 engram 集合(engram 已删但
      // .yaml 残留)则跳过,不进 graph.json / 统计。graph 视图本就只渲染两端
      // 存在的边,此处对齐,避免 /api/stats totalSynapses 含 dangling 误导用户
      // (实测某库 1829 synapse 中 1814 dangling,统计栏报 1829 而实际有效仅 15)。
      if (!allIds.has(fromId) || !allIds.has(synapse.to)) continue;
      // 确保 from 和 to 都有邻接表项(过滤后二者必在 allIds,邻接表已存在,以下防御)
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
        direction: isSymmetricKind(synapse.kind)
          ? "bidirectional"
          : "directional",
        evidenceCount: synapse.evidence?.length ?? 0,
        ...(synapse.resolutionState?.status
          ? { resolutionStatus: synapse.resolutionState.status }
          : {}),
        ...(synapse.createdBy ? { createdBy: synapse.createdBy } : {}),
      });
      outgoingAdjacency[fromId]!.push(synapse.id);
      incomingAdjacency[synapse.to]!.push(synapse.id);
    }

    // 构建节点
    // importance 优先从 SQLite 一次性查(毫秒级);降级走 readEngram(N×扫盘,慢)
    // 真实瓶颈(2026-07 1000 engram 规模):原 readEngram 循环 7+ 分钟未跑完,
    // 因为 readEngram → assembleEngram → listSynapsesForEngram 扫整个 synapses/ 目录,
    // 1026 × 1826 ≈ 1.8M operations。SQLite SELECT 一次性返回 1026 行,几毫秒。
    const importanceById = new Map<string, number>();
    if (this.repo.indexDb) {
      try {
        const rows = this.repo.indexDb.prepare(
          "SELECT id, importance FROM engrams",
        ).all() as { id: string; importance: number }[];
        for (const r of rows) {
          importanceById.set(r.id, r.importance);
        }
      } catch {
        // SQLite 查询失败,降级到 readEngram
      }
    }
    for (const entry of allEngrams) {
      let importance = importanceById.get(entry.id);
      if (importance === undefined) {
        const engram = this.repo.exists(entry.id)
          ? this.repo.readEngram(entry.id)
          : null;
        importance = engram?.importance ?? 0.5;
      }
      const slug = slugById.get(entry.id);
      nodes.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        importance,
        outgoingCount: outgoingAdjacency[entry.id]?.length ?? 0,
        incomingCount: incomingAdjacency[entry.id]?.length ?? 0,
        ...(slug ? { slug } : {}),
        ...(entry.domainTags?.length
          ? { domainTags: entry.domainTags }
          : {}),
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
