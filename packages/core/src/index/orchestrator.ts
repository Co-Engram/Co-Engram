/**
 * 索引编排器
 *
 * 协调 digest / graph / 增量状态 等多个索引的构建
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
   */
  fullRebuild(): IndexBuildResult {
    const start = Date.now();
    const digestResult = this.digestBuilder.rebuild();
    const graphResult = this.graphBuilder.rebuild();
    this.tracker.updateLastIndexedAt();
    return {
      digest: digestResult,
      graph: graphResult,
      durationMs: Date.now() - start,
    };
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
