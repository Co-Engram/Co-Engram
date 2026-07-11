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
import { formatPathOverview, type PathOverviewItem } from "./path-overview.js";

export type { BuildPromptInput, PromptBuilder, PromptSignals };

/**
 * 构建可见性风险识别 section(常驻,Task 5)
 *
 * 在 LLM 调用 engram_create / engram_accept_proposal / engram_update 前,
 * 若 content 含凭据 / 个人身份 / 内部信息 / 敏感信息 / 路径中的用户名等
 * 风险信号,必须先询问用户是否设为 visibility: "private"。
 *
 * 该 section 不依赖任何工具可用性 —— 只要 base section 注入了(即任意
 * memory 工具已注册),就跟着注入。这样保证两种 host adapter(claude-code-mcp
 * 与 openclaw-plugin)在 LLM 看到记忆创建引导时,同步看到风险识别引导。
 *
 * 文案全部走 i18n(zh / en),见 `prompt.visibilityRisk.*`。
 */
function buildVisibilityRiskSection(language: Language): readonly string[] {
  // 11 行:标题空行 + 标题 + guidance + 空行 + 5 个列表项 + 询问模板 + 原则。
  // 行数契约由 prompt-builder.test.ts 固化(base N + 11)。
  return [
    "",
    translatePrompt(language, "prompt.visibilityRisk.title"),
    translatePrompt(language, "prompt.visibilityRisk.guidance"),
    "",
    `- ${translatePrompt(language, "prompt.visibilityRisk.credentials")}`,
    `- ${translatePrompt(language, "prompt.visibilityRisk.personal")}`,
    `- ${translatePrompt(language, "prompt.visibilityRisk.internal")}`,
    `- ${translatePrompt(language, "prompt.visibilityRisk.sensitive")}`,
    `- ${translatePrompt(language, "prompt.visibilityRisk.paths")}`,
    translatePrompt(language, "prompt.visibilityRisk.template"),
    translatePrompt(language, "prompt.visibilityRisk.principle"),
  ];
}

/**
 * 构建"唯一记忆系统"声明 section(常驻,Task:机制层强制 LLM 走 engram_create)
 *
 * 声明 co-engram 是本会话唯一的持久化记忆写入入口,引导 LLM 不要写
 * Claude Code auto-memory(`~/.claude/projects/<cwd>/memory/*.md`),直接调
 * engram_create。
 *
 * 紧凑注入:仅 title + rule 两行,无起始空行分隔。visibility judgment
 * 由工具自身 description + visibilityRisk section 处理,此处不重复。
 *
 * 行数契约由 prompt-builder.test.ts 固化(base N + 11 visibilityRisk + 2 exclusivity)。
 */
function buildExclusivitySection(language: Language): readonly string[] {
  return [
    translatePrompt(language, "prompt.exclusivity.title"),
    translatePrompt(language, "prompt.exclusivity.rule"),
  ];
}

/**
 * 构建基础 memory section(常驻部分)
 *
 * 包含:
 *   - section header
 *   - 仓库目录概览(条件性,depth=1 常驻注入)
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
  pathOverview: readonly PathOverviewItem[] | undefined,
): readonly string[] {
  const lines: string[] = [
    translatePrompt(language, "prompt.memory.section_header"),
  ];
  // 仓库结构概览:depth=1 顶级目录,常驻注入(结构信息不走自进化)
  // 让 LLM 在 search 之前先看到仓库布局;空列表跳过。
  if (pathOverview && pathOverview.length > 0) {
    const overview = formatPathOverview(pathOverview, language);
    if (overview) lines.push(overview);
  }
  lines.push(translatePrompt(language, "prompt.memory.when_to_search"));
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
    buildBaseSection(language, input.availableTools, input.pathOverview),
    buildVisibilityRiskSection(language),
    buildExclusivitySection(language),
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
 *   - pathOverview:动态(每次调用时通过 provider 获取 depth=1 目录概览)
 */
export function createPromptBuilder(options: {
  readonly language?: Language;
  readonly signals?: PromptSignals;
  readonly proposalCountProvider?: () => number;
  readonly pathOverviewProvider?: () => readonly PathOverviewItem[];
}): PromptBuilder {
  return (input: BuildPromptInput) =>
    buildCoEngramMemoryPrompt({
      ...input,
      language: options.language,
      signals: options.signals,
      proposalCount: options.proposalCountProvider?.() ?? 0,
      pathOverview: options.pathOverviewProvider?.(),
    });
}
