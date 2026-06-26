/**
 * LLM-facing tool description overrides (re-export from core)
 *
 * The canonical implementation now lives in `@co-engram/core` so that both
 * MCP and OpenClaw adapters share the same LLM-friendly descriptions.
 * This file is kept as a thin re-export so existing MCP imports keep working.
 *
 * @module @co-engram/claude-code
 */

export {
  LLM_TOOL_DESCRIPTIONS,
  overrideDescription,
  overrideDescriptions,
  auditDescriptionQuality,
  resolveLlmDescription,
} from "@co-engram/core";
