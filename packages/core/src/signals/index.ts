/**
 * Signals 模块 barrel（P4 自动维护服务）
 *
 * 行为信号提取：从工具调用事件流推断 engram 的"真实效用"，不依赖 agent 自律上报。
 *
 * @module @co-engram/core/signals
 */

export * from "./types.js";
export * from "./file-sink.js";
export * from "./extract.js";
export * from "./rpe.js";
