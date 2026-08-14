/**
 * 静态 serverInfo.instructions(支持 session-fresh 动态段)
 *
 * MCP 客户端在 initialize 时读取一次,作为系统提示的稳定前缀。
 * 长度限制 ~2KB(建议 ≤1.5KB 避免 prompt-cache 失效)。
 *
 * 设计目标:
 *   1. 让 LLM 一进入会话就知道"有 team memory 可用"
 *   2. 给出最高优先级的 2-3 个 trigger(主动召回 / 主动捕获)
 *   3. 指向 tools/list 获取细节(避免在这里重复工具签名)
 *   4. 注入 session-fresh 摘要(总数 / pending / top tags / low-confidence)
 *
 * 关键不变量:**指令文本只能引用当前 profile 下真实暴露的工具**。
 * 否则 agent 跟随指令去调用,会触发 MCP -32602 "Tool not found"。
 * 通过 hasTool() 在生成文本前显式检查,避免文档与工具集脱钩。
 *
 * @module @co-engram/claude-code
 */

import type { Language } from "@co-engram/core";
import {
  formatPathOverview,
  formatSkillCatalog,
  type PathOverviewItem,
  type SkillCatalogEntry,
} from "@co-engram/core";
import type { ToolProfile } from "./tool-profile.js";
import { PROFILE_TOOL_SETS } from "./tool-profile.js";

/**
 * Session-fresh 状态摘要
 *
 * 由 register.ts 从 repository + proposalEngine + prompt-signals.json 装配。
 * undefined 表示不注入动态段(降级为纯静态)。
 */
export interface InstructionSessionState {
  /** engram 总数 */
  readonly totalEngrams: number;
  /** 待审核的 proposal 数 */
  readonly pendingProposals: number;
  /** 高频 tags(前 5) */
  readonly topTags: readonly string[];
  /** 低置信度话题(警告级) */
  readonly lowConfidenceTopics: readonly string[];
  /** 最近遗漏话题(RPE false negative) */
  readonly missedTopics: readonly string[];
  /**
   * 团队技能清单(collectSkillCatalog 结果:SKILL.md 原生 description,
   * forgotten 已过滤)。空/undefined 时不注入 skill 段。
   */
  readonly skills?: readonly SkillCatalogEntry[];
}

/**
 * 当前 profile 是否暴露某工具
 *
 * 用于动态段决定是给出"调用 X"指引,还是给出"切换 profile"指引。
 * 避免硬编码 `profile === 'minimal'` 判断,未来调整 PROFILE_TOOL_SETS 时自动同步。
 */
function hasTool(profile: ToolProfile, toolName: string): boolean {
  return PROFILE_TOOL_SETS[profile].has(toolName);
}

/**
 * 构建 serverInfo.instructions
 *
 * @param language 语言
 * @param profile 当前启用的工具 profile(影响提及的工具范围)
 * @param state 可选的 session-fresh 状态;提供则注入"Current state"段
 */
export function buildServerInstructions(
  language: Language,
  profile: ToolProfile,
  state?: InstructionSessionState,
  pathOverview?: readonly PathOverviewItem[],
): string {
  const base = language === "zh" ? buildZh(profile) : buildEn(profile);
  const overview =
    pathOverview && pathOverview.length > 0
      ? formatPathOverview(pathOverview, language)
      : "";
  if (!state && !overview) return base;
  const parts = [base];
  if (overview) parts.push(overview);
  if (state) {
    const dynamic =
      language === "zh"
        ? buildDynamicZh(profile, state)
        : buildDynamicEn(profile, state);
    parts.push(dynamic);
  }
  return parts.join("\n\n");
}

function buildEn(profile: ToolProfile): string {
  const profileNote = {
    minimal:
      `Minimal profile: ${PROFILE_TOOL_SETS.minimal.size} tools exposed — core (engram_search / engram_create / engram_get) + update / synapse / reinforce / list / proposal triage / sync. Self-healing (\`engram_doctor\`) and progressive disclosure (\`engram_list_paths\`) NOT exposed — switch to standard or full profile to enable them.`,
    standard:
      `Standard profile: ${PROFILE_TOOL_SETS.standard.size} tools for read, write, learning loop, proposal triage, self-healing (\`engram_doctor\`), progressive disclosure (\`engram_list_paths\`), and LLM synthesis (\`engram_synthesize\`). Use \`engram_list_proposals\` periodically to review pending captures.`,
    full: `Full profile: all ${PROFILE_TOOL_SETS.full.size} tools visible, including internal/admin tools, experimental self-healing/path-tree tools, and LLM synthesis. Use only if you understand the maintenance/verification internals.`,
  }[profile];

  const learningLoop = hasTool(profile, "close_learning_loop")
    ? "After using a memory and confirming it works, call `close_learning_loop` to reinforce it (raises importance/confidence). To formally verify a memory (upgrade its verificationStatus), use `upgrade_verification`. If a memory led to a wrong answer, call `engram_report_failure`."
    : "If a memory led to a wrong answer, call `engram_report_failure` to downgrade it. (Loop-closing tools are not exposed in minimal profile — the maintenance engine tracks effectiveness in the background.)";

  return `# Co-Engram Team Memory

You have access to a persistent team-memory store. Use it proactively — do not wait for the user to ask.

## When to retrieve

Call \`engram_search\` BEFORE answering when the user:
- References past work ("we decided", "previously", "last time")
- Mentions preferences ("I prefer", "I always use", "I hate when")
- Asks about project history ("why does X exist", "who decided")
- Reports a bug that may have been seen before

## When to capture

Call \`engram_create\` when the user:
- States a durable preference ("from now on, use arrow functions")
- Makes a design decision with rationale ("we'll use X because Y")
- Shares a bug lesson ("this failed because Z")

Do NOT capture trivial, throwaway, or already-documented information.

## Memory write path

co-engram is the **single** memory write path this session. Do NOT write \`~/.claude/projects/<cwd>/memory/*.md\` (Claude Code auto-memory) — it gets mirrored as pending proposals with visibility lost. Call \`engram_create\` directly.

## Learning loop

${learningLoop}

## Memory precedence

Project \`CLAUDE.md\` and inline docs override stored memories. If a memory contradicts current code, prefer the code and report the memory as outdated.

${profileNote}`;
}

function buildZh(profile: ToolProfile): string {
  const profileNote = {
    minimal:
      `当前为 minimal profile:暴露 ${PROFILE_TOOL_SETS.minimal.size} 个工具,核心为 engram_search / engram_create / engram_get,另含 update / synapse / reinforce / list / proposal 审批 / sync。自愈扫描(\`engram_doctor\`)与渐进式披露(\`engram_list_paths\`)未暴露,需切换到 standard 或 full profile 启用。`,
    standard:
      `当前为 standard profile:${PROFILE_TOOL_SETS.standard.size} 个工具,涵盖读写、学习回路、候选审批,自愈扫描(\`engram_doctor\`)、渐进式披露(\`engram_list_paths\`),以及 LLM 综合(\`engram_synthesize\`)。可定期调用 \`engram_list_proposals\` 审核待处理记忆。`,
    full: `当前为 full profile:暴露全部 ${PROFILE_TOOL_SETS.full.size} 个工具(含内部/管理工具 + 实验性自愈/路径树工具 + LLM 综合)。仅在了解维护/验证机制时使用。`,
  }[profile];

  const learningLoop = hasTool(profile, "close_learning_loop")
    ? "使用记忆并验证有效后,调用 `close_learning_loop` 强化它(提升 importance / confidence)。要正式验证记忆(升级 verificationStatus),用 `upgrade_verification`。若记忆导致错误答案,调用 `engram_report_failure`。"
    : "若记忆导致错误答案,调用 `engram_report_failure` 降低其权重。(minimal profile 下不暴露闭环工具,有效性由维护引擎在后台自动追踪。)";

  return `# Co-Engram 团队记忆

你可以访问一个持久的团队记忆库。请主动使用,不要等用户提醒。

## 何时召回

在回答前调用 \`engram_search\`,当用户:
- 引用过去的工作("我们之前决定"、"上次"、"以前我们")
- 提到偏好("我喜欢"、"我一直用"、"我讨厌")
- 问项目历史("X 为什么存在"、"谁决定的")
- 报告可能之前见过的 bug

## 何时捕获

调用 \`engram_create\`,当用户:
- 表达持久偏好("以后用 arrow function")
- 做出带理由的设计决策("我们用 X,因为 Y")
- 分享 bug 教训("这个失败因为 Z")

不要捕获琐碎、一次性或已文档化的信息。

## 记忆写入路径

co-engram 是本会话**唯一**记忆写入入口。不要写 \`~/.claude/projects/<cwd>/memory/*.md\`(Claude Code auto-memory)——它会被镜像为待审批 proposal,visibility 归属丢失。直接调 \`engram_create\`。

## 学习回路

${learningLoop}

## 记忆优先级

项目 \`CLAUDE.md\` 和内联文档优先于存储的记忆。若记忆与当前代码矛盾,以代码为准并将记忆标记为过时。

${profileNote}`;
}

function buildDynamicEn(
  profile: ToolProfile,
  s: InstructionSessionState,
): string {
  const lines: string[] = [];
  lines.push("## Current state (session-fresh)");
  lines.push("");
  if (s.topTags.length > 0) {
    lines.push(
      `- Top tags: ${s.topTags
        .slice(0, 20)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  if (s.lowConfidenceTopics.length > 0) {
    lines.push(
      `- Low-confidence topics (verify before relying): ${s.lowConfidenceTopics
        .slice(0, 3)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  if (s.missedTopics.length > 0) {
    lines.push(
      `- Recently missed topics (consider \`engram_create\`): ${s.missedTopics
        .slice(0, 3)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  // 团队技能清单(确定性注入,forgotten 已过滤;条数/长度由 collectSkillCatalog 预算防护)
  const skills = formatSkillCatalog(s.skills ?? [], "en");
  if (skills) lines.push("", skills);
  return lines.join("\n");
}

function buildDynamicZh(
  profile: ToolProfile,
  s: InstructionSessionState,
): string {
  const lines: string[] = [];
  lines.push("## 当前状态(会话级快照)");
  lines.push("");
  if (s.topTags.length > 0) {
    lines.push(
      `- 高频 tags: ${s.topTags
        .slice(0, 20)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  if (s.lowConfidenceTopics.length > 0) {
    lines.push(
      `- 低置信度话题(引用前先验证): ${s.lowConfidenceTopics
        .slice(0, 3)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  if (s.missedTopics.length > 0) {
    lines.push(
      `- 最近遗漏话题(可考虑 \`engram_create\` 捕获): ${s.missedTopics
        .slice(0, 3)
        .map((t) => `\`${t}\``)
        .join(" ")}`,
    );
  }
  // 团队技能清单(确定性注入,forgotten 已过滤;条数/长度由 collectSkillCatalog 预算防护)
  const skills = formatSkillCatalog(s.skills ?? [], "zh");
  if (skills) lines.push("", skills);
  return lines.join("\n");
}
