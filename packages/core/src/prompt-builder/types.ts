/**
 * Prompt builder 类型定义(host-agnostic)
 *
 * 与 OpenClaw / MCP 等具体宿主解耦 — 宿主 adapter 负责把各自的协议参数
 * 适配为 BuildPromptInput,再调用 buildCoEngramMemoryPrompt。
 *
 * @module @co-engram/core/prompt-builder
 */

import type { Language } from "../i18n/index.js";
import type { PromptSignalSnapshot } from "../prompt-signals/types.js";

/**
 * 自进化信号(从 PromptSignalSnapshot 派生)
 *
 * 完整 snapshot 由 maintenance light stage 生成,
 * 缓存在 `<dataRoot>/.co-engram/prompt-signals.json`。
 *
 * promptBuilder 只读取 snapshot 的字符串字段,不关心 stats 元数据。
 */
export type PromptSignals = PromptSignalSnapshot;

/**
 * Prompt builder 的完整输入(base + 动态状态)
 *
 * Host-agnostic:不依赖 OpenClaw MemoryPromptBuilderParams 等宿主协议类型。
 * 宿主 adapter 负责在自己的类型和此类型之间转换。
 */
export interface BuildPromptInput {
  /** 当前会话可用的工具名集合(决定是否注入提示) */
  readonly availableTools: ReadonlySet<string>;
  /** 引用模式(目前实现忽略,预留扩展) */
  readonly citationsMode?: "off" | "compact" | "full";
  /** 自进化 signals;undefined 时跳过动态部分 */
  readonly language?: Language;
  /** 自进化 signals;undefined 时跳过动态部分 */
  readonly signals?: PromptSignals;
  /** 待处理 proposal 数量;0 时不注入 proposal 提醒 */
  readonly proposalCount?: number;
}

/**
 * Prompt builder 函数签名
 */
export type PromptBuilder = (input: BuildPromptInput) => readonly string[];
