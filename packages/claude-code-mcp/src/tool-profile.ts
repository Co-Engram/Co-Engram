/**
 * 工具暴露 profile —— claude-code-mcp re-export
 *
 * 实际定义已搬到 @co-engram/core/tools/tool-profile.ts(15 轮拉通元2 修复),
 * 本文件保留用于兼容历史 import 路径(如 instructions.ts / register.ts 的
 * `from "./tool-profile.js"`)。
 *
 * @module @co-engram/claude-code
 */

export {
  type ToolProfile,
  PROFILE_TOOL_SETS,
  PROFILE_TOOL_COUNTS,
  resolveProfile,
  filterToolsByProfile,
} from "@co-engram/core";
