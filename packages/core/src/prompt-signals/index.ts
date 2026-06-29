/**
 * Prompt signals 模块入口
 *
 * 导出类型、统计逻辑、缓存读写。
 *
 * @module @co-engram/core/prompt-signals
 */

export type { PromptSignalSnapshot, PromptSignalStats } from "./types.js";
export { EMPTY_PROMPT_SIGNALS } from "./types.js";
export {
  computePromptSignals,
  type ComputePromptSignalsOptions,
} from "./stats.js";
export {
  readPromptSignals,
  writePromptSignals,
  PROMPT_SIGNALS_FILENAME,
  PromptSignalCache,
  type PromptSignalCacheOptions,
} from "./cache.js";
export {
  PromptSignalBus,
  type PromptSignalEvent,
  type PromptSignalEventType,
  getGlobalPromptSignalBus,
  resetGlobalPromptSignalBus,
  safeEmit,
} from "./event-bus.js";
