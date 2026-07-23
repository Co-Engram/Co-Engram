/**
 * OpenClaw adapter for the shared prompt builder
 *
 * 实际逻辑在 @co-engram/core/prompt-builder。
 * 本文件只做两件事:
 *   1. re-export core 的 host-agnostic API(向后兼容)
 *   2. 提供 OpenClaw 协议特定的类型适配(MemoryPromptBuilderParams / MemoryPromptBuilder)
 *
 * @module @co-engram/openclaw
 */

import {
  buildCoEngramMemoryPrompt as coreBuildPrompt,
  createPromptBuilder as coreCreateBuilder,
  type BuildPromptInput,
  type PromptSignals,
  type PathOverviewItem,
} from "@co-engram/core";
import type { Language } from "@co-engram/core";

// Re-export 共享 API(向后兼容旧 import)
export { coreBuildPrompt as buildCoEngramMemoryPrompt };
export type { BuildPromptInput, PromptSignals } from "@co-engram/core";

/**
 * OpenClaw `registerMemoryCapability.promptBuilder` 的参数协议
 *
 * availableTools + citationsMode 是 OpenClaw 协议字段;
 * 宿主调用时传入,adapter 把它适配成 core 的 BuildPromptInput。
 */
export interface MemoryPromptBuilderParams {
  readonly availableTools: ReadonlySet<string>;
  readonly citationsMode?: "off" | "compact" | "full";
}

/**
 * OpenClaw promptBuilder 协议签名
 */
export type MemoryPromptBuilder = (
  params: MemoryPromptBuilderParams,
) => readonly string[];

/**
 * 旧的 BuildPromptInput alias(向后兼容)
 *
 * @deprecated 直接使用 `BuildPromptInput` from `@co-engram/core`。
 */
export type BuildPromptInputLegacy = BuildPromptInput;

/**
 * 工厂:创建符合 OpenClaw MemoryPromptBuilder 协议的函数
 *
 * 额外参数通过闭包注入:
 *   - language:固定(plugin 注册时确定)
 *   - signals:固定 snapshot(plugin 注册时读取,下次重启刷新)
 *   - proposalCount:动态(每次 promptBuilder 调用时从 proposalEngine 获取)
 *   - pathOverview:动态(每次 promptBuilder 调用时取 depth=1 目录概览)
 */
export function createCoEngramPromptBuilder(options: {
  readonly language?: Language;
  readonly signals?: PromptSignals;
  readonly proposalCountProvider?: () => number;
  readonly pathOverviewProvider?: () => readonly PathOverviewItem[];
}): MemoryPromptBuilder {
  const coreBuilder = coreCreateBuilder({
    language: options.language,
    signals: options.signals,
    proposalCountProvider: options.proposalCountProvider,
    pathOverviewProvider: options.pathOverviewProvider,
  });

  return (params: MemoryPromptBuilderParams) => {
    const out = coreBuilder({
      availableTools: params.availableTools,
      citationsMode: params.citationsMode,
    });
    return out;
  };
}
