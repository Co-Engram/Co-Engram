/**
 * 检索过滤器
 *
 * 基于 SearchFilter 对 DigestLine 应用各种过滤条件
 *
 * @module @co-engram/core/retrieval
 */

import type { DigestLine } from "../index/types.js";
import type { SearchFilter } from "../types/disclosure.js";

/**
 * 应用过滤器，返回是否通过
 */
export function matchesFilter(
  line: DigestLine,
  filter: SearchFilter | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.domainTags && filter.domainTags.length > 0) {
    if (!filter.domainTags.some((t) => line.domainTags.includes(t))) {
      return false;
    }
  }

  // P0-3 修复:contextTags 此前在 SearchFilter 三方缺失,现在补齐
  // 语义与 domainTags 一致:engram.contextTags 与 filter.contextTags 有交集则通过
  if (filter.contextTags && filter.contextTags.length > 0) {
    if (!filter.contextTags.some((t) => line.contextTags.includes(t))) {
      return false;
    }
  }

  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.some((k) => line.kinds.includes(k))) {
      return false;
    }
  }

  if (filter.status && filter.status.length > 0) {
    if (!filter.status.includes(line.status)) {
      return false;
    }
  }

  // 默认排除 archived/forgotten（除非显式查询）
  const statusFilter = filter.status ?? ["active", "draft"];
  if (!statusFilter.includes(line.status)) {
    return false;
  }

  if (filter.freshness && filter.freshness.length > 0) {
    if (!filter.freshness.includes(line.freshness)) {
      return false;
    }
  }

  if (filter.emotionalValence && filter.emotionalValence.length > 0) {
    if (!filter.emotionalValence.includes(line.emotionalValence)) {
      return false;
    }
  }

  if (filter.createdBy && filter.createdBy.length > 0) {
    if (!filter.createdBy.includes(line.createdBy)) {
      return false;
    }
  }

  if (filter.createdAfter && line.createdAt < filter.createdAfter) {
    return false;
  }

  if (filter.createdBefore && line.createdAt > filter.createdBefore) {
    return false;
  }

  if (
    filter.minImportance !== undefined &&
    line.importance < filter.minImportance
  ) {
    return false;
  }

  return true;
}

/**
 * 过滤 DigestLine 列表
 */
export function applyFilter(
  lines: readonly DigestLine[],
  filter: SearchFilter | undefined,
): DigestLine[] {
  return lines.filter((line) => matchesFilter(line, filter));
}
