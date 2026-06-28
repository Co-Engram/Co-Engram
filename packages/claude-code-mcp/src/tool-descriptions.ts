/**
 * LLM-facing tool description helpers (re-export from core)
 *
 * 历史上这里 re-export 了 `LLM_TOOL_DESCRIPTIONS` 常量。该常量在 Finding 107/111
 * 三层拆分重构中已删除,agent 层描述统一迁入 i18n 字典(`tool.<name>.agent`)。
 * 本文件保留 thin re-export 以保持现有 MCP import 不破坏。
 *
 * @module @co-engram/claude-code
 */

export {
  overrideDescription,
  overrideDescriptions,
  auditDescriptionQuality,
  resolveLlmDescription,
  listAgentDescribedTools,
} from "@co-engram/core";
