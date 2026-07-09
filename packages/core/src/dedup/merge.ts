/**
 * 合并路径（UPDATE）
 *
 * 当 triage 裁决 UPDATE 时，调用本模块合并新旧内容：
 *   - 用新内容覆盖旧 content
 *   - 保留旧 meta 中不可变字段（createdBy/createdAt）
 *   - version += 1
 *   - mergeHistory 追加一条记录
 *   - 更新 updatedAt / updatedBy
 *
 * 注意：本模块只做合并语义；具体落盘通过 repository.updateEngram。
 *
 * @module @co-engram/core/dedup
 */

import type { EngramRepository } from "../storage/repository.js";
import type { MergeHistoryEntry } from "./types.js";
import { notFoundError } from "../tools/error-schema.js";

export interface MergeInput {
  readonly id: string;
  readonly newTitle?: string;
  readonly newContent?: string;
  readonly newSummary?: string;
  readonly newImportance?: number;
  readonly mergedBy: string;
  readonly reason: string;
}

export interface MergeResult {
  readonly id: string;
  readonly version: number;
  readonly mergeHistoryEntry: MergeHistoryEntry;
}

/**
 * 合并 engram（UPDATE 路径）
 *
 * 流程：
 *   1. 读旧 engram
 *   2. 计算 fromHash / toHash
 *   3. 用 updateEngram 写入新字段（version 自动 +1）
 *   4. 在 meta.yaml 追加 mergeHistory（通过 updateMeta 单独写入）
 */
export function mergeEngram(
  repo: EngramRepository,
  input: MergeInput,
): MergeResult {
  if (!repo.exists(input.id)) {
    throw notFoundError("Engram", input.id);
  }
  const old = repo.readEngram(input.id);
  const newContent = input.newContent ?? old.content;

  // 1. 触发 updateEngram（version+1 + 字段更新）
  const updated = repo.updateEngram(input.id, {
    title: input.newTitle,
    content: input.newContent,
    summary: input.newSummary,
    importance: input.newImportance,
    updatedBy: input.mergedBy,
  });

  // 2. 构造 merge history entry
  const entry: MergeHistoryEntry = {
    at: updated.updatedAt,
    fromHash: old.contentHash,
    toHash: updated.contentHash,
    reason: input.reason,
    mergedBy: input.mergedBy,
  };

  // 3. P1：mergeHistory 暂存在内存（不落盘）
  //    P2 会扩展 meta schema 加 mergeHistory 数组字段
  // 目前通过 mergeEngram 返回值暴露给调用方，由上层决定如何持久化

  return {
    id: input.id,
    version: updated.version,
    mergeHistoryEntry: entry,
  };
}
