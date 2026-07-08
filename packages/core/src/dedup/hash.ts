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
 * 走 EngramRepository.listEngramIndex() 拿 EngramIndexEntry.contentHash
 * (由 createEngram 流程同步维护),匹配 hash 后用 repo.exists() 复核文件
 * 存在。
 *
 * 性能修复(2026-07):旧实现 listEngrams + 逐个 readEngram,N=1026 时
 * 30+s 卡死 CPU(CPU profile:66.7% 时间在 YAML parser)。根因是
 * EngramCatalogEntry(Tier 0)只有 4 字段不含 contentHash,被迫 readEngram
 * 拿完整 Engram。新实现用 index entry 的 contentHash(O(n) 内存扫)+
 * exists(O(1) stat),1026 engram 约 50ms,vs 旧路径 30s。
 *
 * F2 stale entry 容错保留:listEngramIndex 不过滤"index 有 entry 但磁盘
 * 文件不存在"的孤儿(跨进程 race / 部分 crash 后,deleteEngram 部分失败
 * 留下)。不跳过的后果:返回 stale targetId,后续 triage 把它当作
 * DUPLICATE 返回,用户无法重建同 contentHash 的 engram(死锁)。exists
 * 复核保证返回的 id 对应磁盘真实文件。
 *
 * @returns 匹配的 engram id，或 null
 */
export function findExactHashMatch(
  repo: EngramRepository,
  hash: string,
): EngramId | null {
  if (!hash) return null;
  for (const entry of repo.listEngramIndex()) {
    if (entry.contentHash !== hash) continue;
    if (!repo.exists(entry.id)) continue; // F2 stale 容错
    return entry.id;
  }
  return null;
}

/**
 * 批量构建 hash → id 映射（用于高频查询场景）
 *
 * 首次调用 O(N)，之后 O(1)。
 * 注意：仓库变更（create/update/delete）后需重建。
 *
 * 性能修复(2026-07):同 findExactHashMatch,用 listEngramIndex()
 * 替代 listEngrams + readEngram 循环,消除 N+1 readEngram。
 *
 * 同 F2 stale 容错:exists 复核,避免 stale entry 污染映射。
 */
export function buildHashIndex(repo: EngramRepository): Map<string, EngramId> {
  const index = new Map<string, EngramId>();
  for (const entry of repo.listEngramIndex()) {
    if (!repo.exists(entry.id)) continue; // F2 stale 容错
    index.set(entry.contentHash, entry.id);
  }
  return index;
}
