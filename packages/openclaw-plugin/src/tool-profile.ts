/**
 * 工具暴露 profile —— openclaw-plugin re-export
 *
 * 实际定义在 @co-engram/core/tools/tool-profile.ts(单一源,15 轮拉通元2 修复)。
 * 此前 openclaw-plugin 完全没有 profile 选择机制,只能拿 full 集合;
 * 现在与 claude-code-mcp 对齐,共享同一份 PROFILE_TOOL_SETS。
 *
 * @module @co-engram/openclaw
 */

export {
  type ToolProfile,
  PROFILE_TOOL_SETS,
  PROFILE_TOOL_COUNTS,
  resolveProfile,
  filterToolsByProfile,
} from "@co-engram/core";
