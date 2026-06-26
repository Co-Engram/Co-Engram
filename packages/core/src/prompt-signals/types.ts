/**
 * Prompt signals 类型定义
 *
 * 由 maintenance light stage 周期性生成,缓存到
 * `<dataRoot>/.co-engram/prompt-signals.json`。
 *
 * promptBuilder 读取这份 snapshot,动态填充 memory section 的
 * "Frequent topics" / "Recently missed" 等条件性提示。
 *
 * 设计原则:
 *   - snapshot 是不可变的(readonly),只整体替换
 *   - 字段全部可选(除 version),允许增量演进(初版只填 topTags)
 *   - 含 stats 元数据,便于调试和审计
 *
 * @module @co-engram/core/prompt-signals
 */

/**
 * 完整的 prompt signals snapshot
 */
export interface PromptSignalSnapshot {
  /** schema 版本 */
  readonly version: 1;
  /** 高频 engram 领域(从 domainTags 统计 top N) */
  readonly topTags: readonly string[];
  /** 最近遗漏话题(RPE false negative 检测) */
  readonly missedTopics: readonly string[];
  /** 低置信度频繁检索话题 */
  readonly lowConfidenceTopics: readonly string[];
  /** ISO timestamp,light stage 每次更新时刷新 */
  readonly updatedAt: string;
  /** 生成器标识(如 "light-stage@0.1.0") */
  readonly generatedBy: string;
  /** 统计元数据(调试/审计用,不影响 prompt 生成) */
  readonly stats: PromptSignalStats;
}

/**
 * 统计元数据
 */
export interface PromptSignalStats {
  /** team-memory 中 engram 总数 */
  readonly totalEngrams: number;
  /** 参与统计的 tag 总频次 */
  readonly totalTagOccurrences: number;
  /** 唯一 tag 数量 */
  readonly uniqueTags: number;
  /** 完整 tag 频次表(调试用,不进 prompt) */
  readonly tagCounts: Readonly<Record<string, number>>;
}

/**
 * 空快照(用于初始化或失败降级)
 */
export const EMPTY_PROMPT_SIGNALS: PromptSignalSnapshot = {
  version: 1,
  topTags: [],
  missedTopics: [],
  lowConfidenceTopics: [],
  updatedAt: "",
  generatedBy: "",
  stats: {
    totalEngrams: 0,
    totalTagOccurrences: 0,
    uniqueTags: 0,
    tagCounts: {},
  },
};
