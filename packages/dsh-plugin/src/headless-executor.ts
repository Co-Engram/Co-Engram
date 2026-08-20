/**
 * L2 headless 执行器已收敛到 @co-engram/core(2026-08-17)。
 *
 * 此处曾是 claude-code-mcp 版本的逐字复制品 —— 协议文本是隐性双维护点,
 * 漏改一份即 L2 静默失效。本文件保留 re-export 兼容既有 import 路径;
 * **禁止在此重新实现**,改动一律去 core。
 *
 * @module @co-engram/dsh
 */

export {
  createHeadlessExecutor,
  buildHeadlessArgs,
  buildHeadlessPrompt,
  parseHeadlessReport,
  READONLY_ALLOWED_TOOLS,
} from "@co-engram/core";
export type { HeadlessExecutorOptions } from "@co-engram/core";
