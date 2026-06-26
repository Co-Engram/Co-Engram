/**
 * 增量索引状态管理
 *
 * 跟踪上次索引完成时间，支持冷启动增量构建
 *
 * @module @co-engram/core/index
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { IncrementalState } from "./types.js";

/**
 * 增量状态管理器
 */
export class IncrementalTracker {
  constructor(private readonly cachePath: string) {}

  /** last-indexed-at.txt 路径 */
  get stateFilePath(): string {
    return join(this.cachePath, "last-indexed-at.txt");
  }

  /**
   * 读取上次索引时间
   *
   * 简化版：只返回 mtime 字符串（不存完整 state.json）
   */
  readLastIndexedAt(): string | null {
    if (!existsSync(this.stateFilePath)) {
      return null;
    }
    return readFileSync(this.stateFilePath, "utf8").trim();
  }

  /**
   * 更新索引时间戳
   */
  updateLastIndexedAt(timestamp: string = new Date().toISOString()): void {
    mkdirSync(this.cachePath, { recursive: true });
    writeFileSync(this.stateFilePath, timestamp, "utf8");
  }

  /**
   * 判断是否需要重建（基于时间戳）
   */
  needsRebuild(): boolean {
    return !existsSync(this.stateFilePath);
  }
}
