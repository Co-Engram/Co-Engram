/**
 * Prompt signals 统计逻辑
 *
 * 从 EngramRepository 的 listEngrams() 扫描所有 domainTags,
 * 统计高频 tag,生成 PromptSignalSnapshot。
 *
 * 当前实现:
 *   - topTags:高频领域(从 domainTags 统计)
 *   - lowConfidenceTopics:频繁检索但 truthScore 低(RPE 反馈)
 *   - missedTopics:暂留空(需对话历史分析,后续接入 signals sink / audit log)
 *
 * @module @co-engram/core/prompt-signals
 */

import type { EngramRepository } from "../storage/repository.js";
import type { PromptSignalSnapshot, PromptSignalStats } from "./types.js";

/**
 * 统计参数
 */
export interface ComputePromptSignalsOptions {
  /** top N tags(默认 5) */
  readonly topTagsLimit?: number;
  /** tag 频次低于此值不计入 topTags(默认 3,避免噪声) */
  readonly topTagsMinCount?: number;
  /** 低置信度话题最大数量(默认 3) */
  readonly lowConfidenceLimit?: number;
  /** 被认定为"频繁检索"的最小 retrievalCount(默认 2) */
  readonly lowConfidenceMinRetrievals?: number;
  /** truthScore 阈值,低于此值视为低置信(默认 0.4) */
  readonly lowConfidenceMaxScore?: number;
  /** 生成器标识(写入 snapshot.generatedBy) */
  readonly generatedBy?: string;
}

const DEFAULT_TOP_TAGS_LIMIT = 5;
const DEFAULT_TOP_TAGS_MIN_COUNT = 3;
const DEFAULT_LOW_CONFIDENCE_LIMIT = 3;
const DEFAULT_LOW_CONFIDENCE_MIN_RETRIEVALS = 2;
const DEFAULT_LOW_CONFIDENCE_MAX_SCORE = 0.4;

/**
 * 从 repository 统计 prompt signals
 *
 * 扫描所有 engram,生成三类信号:
 *   - topTags:高频领域(从 domainTags 统计)
 *   - lowConfidenceTopics:频繁检索但 truthScore 低(RPE 反馈)
 *   - missedTopics:暂留空(需对话历史分析)
 *
 * 内部需要读取完整 engram(不只 catalog)以访问 confidence/retrievalCount。
 * 代价是 N 次 fs 读,light stage 5 分钟一次可接受。
 */
export function computePromptSignals(
  repository: EngramRepository,
  options: ComputePromptSignalsOptions = {},
): PromptSignalSnapshot {
  const topTagsLimit = options.topTagsLimit ?? DEFAULT_TOP_TAGS_LIMIT;
  const topTagsMinCount = options.topTagsMinCount ?? DEFAULT_TOP_TAGS_MIN_COUNT;
  const lowConfidenceLimit =
    options.lowConfidenceLimit ?? DEFAULT_LOW_CONFIDENCE_LIMIT;
  const lowConfidenceMinRetrievals =
    options.lowConfidenceMinRetrievals ?? DEFAULT_LOW_CONFIDENCE_MIN_RETRIEVALS;
  const lowConfidenceMaxScore =
    options.lowConfidenceMaxScore ?? DEFAULT_LOW_CONFIDENCE_MAX_SCORE;
  const generatedBy = options.generatedBy ?? "light-stage";

  const entries = repository.listEngrams();
  const tagCounts = countTags(entries);
  const topTags = pickTopTags(tagCounts, topTagsLimit, topTagsMinCount);

  // 收集低置信度 engram 的 tags(RPE 反馈)
  const lowConfidenceTagCounts: Record<string, number> = {};
  for (const entry of entries) {
    let engram: { confidence: number; retrievalCount: number } | null = null;
    try {
      const full = repository.readEngram(entry.id);
      engram = {
        confidence: full.confidence,
        retrievalCount: full.retrievalCount,
      };
    } catch {
      continue;
    }
    if (engram.retrievalCount < lowConfidenceMinRetrievals) continue;
    if (engram.confidence >= lowConfidenceMaxScore) continue;
    for (const tag of entry.domainTags ?? []) {
      const normalized = tag.trim();
      if (!normalized) continue;
      lowConfidenceTagCounts[normalized] =
        (lowConfidenceTagCounts[normalized] ?? 0) + 1;
    }
  }
  const lowConfidenceTopics = pickTopTags(
    lowConfidenceTagCounts,
    lowConfidenceLimit,
    1, // 低置信度话题出现 1 次就计入(本身已经够显著)
  );

  const stats: PromptSignalStats = {
    totalEngrams: entries.length,
    totalTagOccurrences: sumCounts(tagCounts),
    uniqueTags: Object.keys(tagCounts).length,
    tagCounts,
  };

  return {
    version: 1,
    topTags,
    // 后续接入对话历史分析时填充(signals sink / audit log)
    missedTopics: [],
    lowConfidenceTopics,
    updatedAt: new Date().toISOString(),
    generatedBy,
    stats,
  };
}

/**
 * 统计所有 domainTags 的频次
 */
function countTags(
  entries: ReadonlyArray<{ readonly domainTags: readonly string[] }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    for (const tag of entry.domainTags ?? []) {
      const normalized = tag.trim();
      if (!normalized) continue;
      counts[normalized] = (counts[normalized] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * 选取 top N tags(按频次降序,过滤低于 minCount 的)
 */
function pickTopTags(
  counts: Readonly<Record<string, number>>,
  limit: number,
  minCount: number,
): readonly string[] {
  return Object.entries(counts)
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/**
 * 对频次表求和(用于 stats)
 */
function sumCounts(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(counts)) {
    total += count;
  }
  return total;
}
