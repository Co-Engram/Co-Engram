/**
 * Maintenance 模块 barrel（P4 自动维护服务）
 *
 * @module @co-engram/core/maintenance
 */

export * from "./types.js";
export * from "./engine.js";
export * from "./state.js";
// REM 深度思考 + 夜思(spec 2026-08-15):类型/选材/模式/校验/critic/runner/孵化器
export * from "./insight/types.js";
export * from "./insight/incubator.js";
export { buildSubgraph, buildBaselineSubgraph } from "./insight/spread.js";
export { computeModeSignals, retrospectiveSeedFilter, inspirationSeedFilter, buildModePrompt, buildNightThinkingL1Prompt, serializeSubgraph, nodeAlias, buildAliasMap } from "./insight/modes.js";
export { runDeepThought, scanInsightDecay } from "./insight/run.js";
export { validateInsightDraft } from "./insight/validate.js";
export { critique } from "./insight/critic.js";
export { parseDrafts } from "./insight/run.js";
export {
  CONTEMPLATION_PROTOCOL,
  buildProtocol,
  createL1Executor,
  collectSeedDigests,
  collectResourceHints,
  synthesizeAnswerDraft,
  NO_SURVIVOR_MARKER,
} from "./insight/night-thinking.js";
export {
  createHeadlessExecutor,
  buildHeadlessArgs,
  buildHeadlessPrompt,
  parseHeadlessReport,
  READONLY_ALLOWED_TOOLS,
  CONTEMPLATION_SESSION_ENV,
} from "./insight/headless-executor.js";
export type { HeadlessExecutorOptions } from "./insight/headless-executor.js";
export { insightEntityId } from "../observability/proposal-engine.js";
