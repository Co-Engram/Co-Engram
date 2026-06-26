/**
 * 精确匹配去重（contentHash）
 *
 * 最快、最可靠的去重方式：相同内容 → 相同 hash。
 * 在调用相似度引擎之前先查 hash 表，命中直接 DUPLICATE。
 *
 * @module @co-engram/core/dedup
 */

import type { EngramId } from "../types/engram.js";
import type { EngramRepository } from "../storage/repository.js";

/**
 * 在仓库中查找 contentHash 已存在的 engram
 *
 * 扫描所有 engram 的 meta.yaml 的 contentHash 字段。
 * P1 简化：线性扫描（<1000 engram 时 OK）；P2 会引入 hash → id 索引。
 *
 * @returns 匹配的 engram id，或 null
 */
export function findExactHashMatch(
  repo: EngramRepository,
  hash: string,
): EngramId | null {
  if (!hash) return null;
  const entries = repo.listEngrams();
  for (const entry of entries) {
    const engram = repo.readEngram(entry.id);
    if (engram.contentHash === hash) {
      return entry.id;
    }
  }
  return null;
}

/**
 * 批量构建 hash → id 映射（用于高频查询场景）
 *
 * 首次调用 O(N)，之后 O(1)。
 * 注意：仓库变更（create/update/delete）后需重建。
 */
export function buildHashIndex(repo: EngramRepository): Map<string, EngramId> {
  const index = new Map<string, EngramId>();
  for (const entry of repo.listEngrams()) {
    const engram = repo.readEngram(entry.id);
    index.set(engram.contentHash, entry.id);
  }
  return index;
}
