/**
 * Co-Engram memory prompt builder(host-agnostic)
 *
 * 生成注入到 LLM 系统提示的 "## Memory Recall" section。
 *
 * 三层设计(可独立启用/禁用):
 *
 *   1. 基础引导(常驻)——何时调用 memory_search / 何时跳过 / 如何解读结果
 *   2. Proposal 提醒(条件性)——count > 0 时注入
 *   3. 自进化信号(条件性)——基于 prompt-signals.json:
 *      - topTags(高频 engram 领域)
 *      - lowConfidenceTopics(RPE false negative 检测)
 *
 * 所有文字走 i18n(en/zh)。
 *
 * 宿主集成:
 *   - OpenClaw:`registerMemoryCapability.promptBuilder`
 *   - Claude Code MCP:`serverInfo.instructions`(静态)+ hook(动态)
 *
 * @module @co-engram/core/prompt-builder
 */

import { DEFAULT_LANGUAGE, translatePrompt } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type {
  BuildPromptInput,
  PromptBuilder,
  PromptSignals,
} from "./types.js";

export type { BuildPromptInput, PromptBuilder, PromptSignals };

/**
 * 构建基础 memory section(常驻部分)
 *
 * 包含:
 *   - section header
 *   - 何时调用 memory_search(语义检索场景)
 *   - 何时调用 engram_list(列举场景,仅当 engram_list 可用时注入)
 *   - 何时跳过(负向引导)
 *   - 如何解读结果(truthScore + 低分处理)
 *   - 创建/更新引导(条件性)
 *   - 强化闭环引导(条件性,仅当 engram_reinforce 可用时注入)
 */
function buildBaseSection(
  language: Language,
  availableTools: ReadonlySet<string>,
): readonly string[] {
  const lines: string[] = [
    translatePrompt(language, "prompt.memory.section_header"),
    translatePrompt(language, "prompt.memory.when_to_search"),
  ];
  // 仅当 engram_list 在可用工具集时才注入列举场景引导
  // (避免对未注册 engram_list 的 host adapter 误导 agent)
  if (availableTools.has("engram_list")) {
    lines.push(translatePrompt(language, "prompt.memory.when_to_list"));
  }
  lines.push(
    translatePrompt(language, "prompt.memory.when_not_to_search"),
    translatePrompt(language, "prompt.memory.reading_results"),
  );
  // 写入引导:仅当 engram_create 或 engram_update 可用时注入
  // 避免 agent 在 createdBy 填通用词(AIOS/openclaw/assistant)
  if (
    availableTools.has("engram_create") ||
    availableTools.has("engram_update")
  ) {
    lines.push(translatePrompt(language, "prompt.memory.writing"));
  }
  // 强化闭环引导:仅当 engram_reinforce 可用时注入
  // 引导 agent 在用户明确确认后主动调 engram_reinforce(避免 importance 评分污染)
  if (availableTools.has("engram_reinforce")) {
    lines.push(translatePrompt(language, "prompt.memory.when_to_reinforce"));
  }
  return lines;
}

/**
 * 构建 proposal 提醒(条件性)
 *
 * 仅当 count > 0 时返回非空数组。
 */
function buildProposalSection(
  count: number,
  language: Language,
): readonly string[] {
  if (count <= 0) return [];
  return [
    translatePrompt(language, "prompt.memory.proposal_reminder", { count }),
  ];
}

/**
 * 构建自进化 signals 提示(条件性)
 *
 * 仅当 signals 存在且对应字段非空时注入。
 */
function buildSignalsSection(
  signals: PromptSignals | undefined,
  language: Language,
): readonly string[] {
  if (!signals) return [];
  const lines: string[] = [];

  if (signals.topTags.length > 0) {
    lines.push(
      translatePrompt(language, "prompt.memory.frequent_topics", {
        tags: signals.topTags.join(", "),
      }),
    );
  }

  if (signals.missedTopics && signals.missedTopics.length > 0) {
    lines.push(
      translatePrompt(language, "prompt.memory.missed_topics", {
        topics: signals.missedTopics.join(", "),
      }),
    );
  }

  if (signals.lowConfidenceTopics && signals.lowConfidenceTopics.length > 0) {
    lines.push(
      translatePrompt(language, "prompt.memory.low_confidence_topics", {
        topics: signals.lowConfidenceTopics.join(", "),
      }),
    );
  }

  return lines;
}

/**
 * 主构建函数:组装所有部分
 *
 * 返回 string[](宿主期望的 prompt lines 格式)。
 * 每个 element 是一段,宿主用换行连接。
 *
 * 工具未注册时返回空(没有任何 memory 工具就不需要 memory section)。
 */
export function buildCoEngramMemoryPrompt(
  input: BuildPromptInput,
): readonly string[] {
  const language = input.language ?? DEFAULT_LANGUAGE;

  const hasSearch = input.availableTools.has("memory_search");
  const hasGet = input.availableTools.has("memory_get");
  const hasEngramSearch = input.availableTools.has("engram_search");
  const hasEngramGet = input.availableTools.has("engram_get");
  if (!hasSearch && !hasGet && !hasEngramSearch && !hasEngramGet) return [];

  const sections: readonly (readonly string[])[] = [
    buildBaseSection(language, input.availableTools),
    buildSignalsSection(input.signals, language),
    buildProposalSection(input.proposalCount ?? 0, language),
  ];

  return sections.flat();
}

/**
 * 工厂:创建闭包绑定的 prompt builder
 *
 * 额外参数通过闭包注入:
 *   - language:固定(adapter 注册时确定)
 *   - signals:固定 snapshot(adapter 注册时读取,下次重启刷新)
 *   - proposalCount:动态(每次调用时通过 provider 获取)
 */
export function createPromptBuilder(options: {
  readonly language?: Language;
  readonly signals?: PromptSignals;
  readonly proposalCountProvider?: () => number;
}): PromptBuilder {
  return (input: BuildPromptInput) =>
    buildCoEngramMemoryPrompt({
      ...input,
      language: options.language,
      signals: options.signals,
      proposalCount: options.proposalCountProvider?.() ?? 0,
    });
}
