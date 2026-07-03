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
 * F2 修复(dedupe fail-safe):跳过"index 有 entry 但磁盘文件不存在"的 stale entry。
 * 这种情况发生在跨进程 race / 部分 crash 后,deleteEngram 部分失败,留下孤儿 entry。
 * 不跳过的后果:readEngram 抛错 → 整个 dedupe 失败;或者更糟,后续 triage 把
 * stale targetId 当作 DUPLICATE 返回,用户无法重建同 contentHash 的 engram
 * (死锁)。修复后 stale entry 被跳过,继续走相似度召回或 NEW 路径。
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
    if (!repo.exists(entry.id)) continue;
    let engram: { contentHash: string };
    try {
      engram = repo.readEngram(entry.id);
    } catch {
      continue;
    }
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
 *
 * 同 F2 修复:跳过 stale entry,避免 buildHashIndex 抛错或返回坏映射。
 */
export function buildHashIndex(repo: EngramRepository): Map<string, EngramId> {
  const index = new Map<string, EngramId>();
  for (const entry of repo.listEngrams()) {
    if (!repo.exists(entry.id)) continue;
    let engram: { contentHash: string };
    try {
      engram = repo.readEngram(entry.id);
    } catch {
      continue;
    }
    index.set(engram.contentHash, entry.id);
  }
  return index;
}
