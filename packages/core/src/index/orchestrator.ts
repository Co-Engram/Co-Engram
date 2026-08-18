/**
 * 索引编排器
 *
 * 协调 digest / graph / 增量状态 / SQLite synapse 表 等多个索引的构建
 *
 * @module @co-engram/core/index
 */

import { join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import { DigestBuilder } from "./digest-builder.js";
import { GraphBuilder } from "./graph-builder.js";
import { IncrementalTracker } from "./incremental.js";
import type { DigestBuildResult } from "./types.js";

/** 索引构建结果汇总 */
export interface IndexBuildResult {
  readonly digest: DigestBuildResult;
  readonly graph: { nodes: number; edges: number };
  /** SQLite synapse 表重建结果(undefined 表示未触发,如 indexDb 未注入) */
  readonly synapses?: { inserted: number; skippedDangling: number };
  readonly durationMs: number;
}

/**
 * 索引编排器
 */
export class IndexOrchestrator {
  readonly digestBuilder: DigestBuilder;
  readonly graphBuilder: GraphBuilder;
  readonly tracker: IncrementalTracker;

  constructor(
    private readonly repo: EngramRepository,
    private readonly cachePath: string,
  ) {
    this.digestBuilder = new DigestBuilder(repo, cachePath);
    this.graphBuilder = new GraphBuilder(repo, cachePath);
    this.tracker = new IncrementalTracker(cachePath);
  }

  /**
   * 冷启动：检查并增量重建索引
   *
   * - 如果 .co-engram/ 不存在，全量重建
   * - 如果存在但内容变化，增量更新
   */
  coldStartIfNeeded(): IndexBuildResult | null {
    if (!this.tracker.needsRebuild()) {
      // 仍尝试增量（可能 content 有变化）
      const digestResult = this.digestBuilder.buildIncremental();
      if (
        digestResult.added === 0 &&
        digestResult.updated === 0 &&
        digestResult.removed === 0
      ) {
        return null;
      }
      const graphResult = this.graphBuilder.rebuild();
      this.tracker.updateLastIndexedAt();
      return {
        digest: digestResult,
        graph: graphResult,
        durationMs: 0,
      };
    }

    // 全量重建
    return this.fullRebuild();
  }

  /**
   * 全量重建所有索引
   *
   * 三处派生索引同时重建,保证一致:
   *   1. digest.jsonl(DigestBuilder)
   *   2. graph.json(GraphBuilder,/api/stats 读这里)
   *   3. SQLite synapse 表(若 indexDb 注入)
   *
   * 第 3 项在长期运行后可能与磁盘脱钩 — 例如 doctor 清理 dangling synapse 文件
   * 但 SQLite 行残留,或反之。每次 fullRebuild 强制同步,让 stats 端点读到的
   * totalSynapses 与磁盘真相一致,而不是历史峰值快照。
   */
  fullRebuild(): IndexBuildResult {
    const start = Date.now();
    const digestResult = this.digestBuilder.rebuild();
    const graphResult = this.graphBuilder.rebuild();
    let synapses: { inserted: number; skippedDangling: number } | undefined;
    if (this.repo.indexDb) {
      synapses = this.rebuildSynapseTableFromDisk();
    }
    this.tracker.updateLastIndexedAt();
    return {
      digest: digestResult,
      graph: graphResult,
      ...(synapses ? { synapses } : {}),
      durationMs: Date.now() - start,
    };
  }

  /**
   * 从磁盘 collectAllSynapses 重建 SQLite synapse 表。
   *
   * 单独抽出以便 doctor 在不重建 digest/graph 的情况下也能强制同步 synapse 表。
   * 返回插入/跳过统计,doctor 报告可附在 fixes 里让用户看到。
   */
  rebuildSynapseTableFromDisk(): { inserted: number; skippedDangling: number } {
    const db = this.repo.indexDb;
    if (!db) return { inserted: 0, skippedDangling: 0 };
    const all = this.repo.collectAllSynapses();
    const knownEngramIds = new Set(this.repo.listEngrams().map((e) => e.id));
    return db.rebuildSynapseTable(
      all.map(({ synapse }) => ({
        id: synapse.id,
        fromId: synapse.from,
        toId: synapse.to,
        kind: synapse.kind,
        weight: synapse.weight ?? 0.5,
        createdBy: synapse.createdBy,
      })),
      knownEngramIds,
    );
  }

  /**
   * 只重建 synapse 派生层(graph.json + SQLite synapse 表),不动 digest.jsonl
   * 也不重投 SQLite engrams 表。
   *
   * 使用场景:dataWatcher 收到 .yaml 变化时,host adapter 通过
   * `repo.addSynapseChangeListener` 注册的回调调用本方法。只重建 synapse
   * 派生层而非 fullRebuild,因为:
   *   - digest.jsonl / engrams 表不依赖 .yaml,无需重建
   *   - 全量 rebuild 走 collectAllSynapses(~50ms/1000 synapse)+ SQL transaction
   *     (~10ms),相比 fullRebuild(含 digest build,200ms+)快很多
   *   - 频繁触发不影响 engram 检索性能
   *
   * 幂等:同一磁盘状态多次调用产生相同的 graph.json + SQLite 行。
   * 失败语义:任一步抛错向上传递,host adapter 的 listener 包装 try/catch。
   */
  rebuildSynapseLayer(): {
    graph: { nodes: number; edges: number };
    synapses?: { inserted: number; skippedDangling: number };
  } {
    const graphResult = this.graphBuilder.rebuild();
    if (this.repo.indexDb) {
      const synapseResult = this.rebuildSynapseTableFromDisk();
      return { graph: graphResult, synapses: synapseResult };
    }
    return { graph: graphResult };
  }

  /**
   * 增量更新（不强制全量）
   */
  incrementalUpdate(): IndexBuildResult {
    const start = Date.now();
    const digestResult = this.digestBuilder.buildIncremental();
    const graphResult = this.graphBuilder.rebuild();
    this.tracker.updateLastIndexedAt();
    return {
      digest: digestResult,
      graph: graphResult,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * 解析 .co-engram.config.yaml 路径
 *
 * 返回默认 ~/team-memory/
 */
export function defaultCachePath(repoRootPath: string): string {
  return join(repoRootPath, ".co-engram");
}

/**
 * 解析默认仓库路径
 *
 * ~/team-memory/（用户主目录下）
 */
export function defaultRepoPath(): string {
  return join(
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".",
    "team-memory",
  );
}
