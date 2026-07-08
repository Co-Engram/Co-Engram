/**
 * Observability barrel
 *
 * 四大组件:
 *   - AuditLog              记录状态变更 + 有效性信号(append-only jsonl)
 *   - EffectivenessTracker  管理 retrieve_hit 后的观察窗口
 *   - NecessityEvaluator    proposal 必要性评估(Layer 2)
 *   - ProposalEngine        主题聚类 + 候选提示
 *
 * 失败契约(AI-1):
 *   - fail-loud.ts          工具错误边界 / 锁 throw / 穷举性检查
 *
 * @module @co-engram/core/observability
 */

export * from "./audit-log.js";
export * from "./effectiveness-tracker.js";
export * from "./necessity-evaluator.js";
export * from "./proposal-engine.js";
export {
  wrapToolWithErrorBoundary,
  wrapAllToolsWithErrorBoundary,
  acquireLockOrThrow,
  assertNever,
} from "./fail-loud.js";
export {
  normalizeChinesePunctuation,
  normalizeDomainTags,
  normalizeProposalFields,
} from "./chinese-post-processor.js";
