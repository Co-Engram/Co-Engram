/**
 * L2 headless 执行器已收敛到 @co-engram/core(2026-08-17)。
 *
 * 原因:openclaw-plugin 接入 L2(M3)后三宿主共用同一实现,此处曾是逐字
 * 复制品 —— 协议文本是隐性双维护点(buildHeadlessPrompt 用字符串 replace
 * 锚定协议原文,漏改一份即 L2 静默失效)。本文件保留 re-export 兼容既有
 * import 路径(含测试);**禁止在此重新实现**,改动一律去 core。
 *
 * @module @co-engram/claude-code/night-thinking
 */

export {
  createHeadlessExecutor,
  buildHeadlessArgs,
  buildHeadlessPrompt,
  parseHeadlessReport,
  READONLY_ALLOWED_TOOLS,
} from "@co-engram/core";
export type { HeadlessExecutorOptions } from "@co-engram/core";
