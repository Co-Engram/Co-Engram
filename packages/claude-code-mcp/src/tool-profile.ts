/**
 * 工具暴露 profile
 *
 * Claude Code MCP 不需要把全部 28 个工具暴露给 LLM。
 * 本模块定义三档 profile,通过环境变量 / 持久化配置选择。
 *
 * 核心理念:
 *   - LLM 只看到决策路径上需要的工具(避免决策疲劳 + token 浪费)
 *   - 内部/管理类工具(archive / restore / forget / recompute_importance /
 *     synapse_get/list/delete / skill_* / upgrade_verification /
 *     get_evolution_lineage)在所有 profile 下都不暴露,只通过 CLI 或维护引擎使用
 *   - engram_synthesize 是 LLM-driven 综合工具,standard+ 暴露(minimal 不暴露,
 *     因为它依赖 LLM 配置,且 minimal 关注核心读写闭环)
 *
 * profile 优先级:env > 持久化配置 > 默认(standard)
 *
 * PROFILE_TOOL_COUNTS 反映实际数量;改 profile 内容时同步更新。
 *
 * @module @co-engram/claude-code
 */

import type { Tool } from "@co-engram/core";

/**
 * 三档 profile
 */
export type ToolProfile = "minimal" | "standard" | "full";

/**
 * 每档 profile 包含的工具名集合
 *
 * minimal: 11 个 —— 核心读写 8 个 + proposal 处理 3 个
 *   proposal 工具进 minimal 的原因:维护引擎默认在后台运行,会持续产生
 *   proposals。若 minimal 暴露了"待审核候选 N 条"提示却不容许处理,会形成
 *   "看得到但处理不了"的体验断裂。把 list/accept/dismiss 提供到 minimal,
 *   让 agent 在任何 profile 下都能闭环处理 proposal。
 * standard: minimal + 学习回路 + contradiction + 数据管理 + 自愈/路径树 + engram_synthesize = 17 个
 * full: 全部 28 个(包含隐藏的管理类工具,调试用)
 */
export const PROFILE_TOOL_SETS: Record<ToolProfile, ReadonlySet<string>> = {
  minimal: new Set<string>([
    "engram_search",
    "engram_get",
    "engram_create",
    "engram_update",
    "engram_list",
    "synapse_create",
    "engram_reinforce",
    "engram_report_failure",
    // proposal 处理三件套(避免后台 proposal 累积但无法闭环)
    "engram_list_proposals",
    "engram_accept_proposal",
    "engram_dismiss_proposal",
    // 手动 pull/commit/push(让所有 profile 都能主动掌控提交时机)
    "engram_sync",
  ]),
  standard: new Set<string>([
    // minimal 11
    "engram_search",
    "engram_get",
    "engram_create",
    "engram_update",
    "engram_list",
    "synapse_create",
    "engram_reinforce",
    "engram_report_failure",
    "engram_list_proposals",
    "engram_accept_proposal",
    "engram_dismiss_proposal",
    // 学习回路 + contradiction + 数据管理
    "engram_delete",
    "close_learning_loop",
    "contradiction_resolve",
    // 仓库健康工具(自愈扫描 + 渐进式披露,面向所有用户)
    "engram_doctor",
    "engram_list_paths",
    // LLM 综合(手工触发 REM,需 llmClient 注入)
    "engram_synthesize",
    // 手动 pull/commit/push(已在 minimal 暴露,这里冗余列出便于阅读)
    "engram_sync",
  ]),
  full: new Set<string>([
    // 全部 28 个 native 工具(含自愈/路径树等高级工具)
    "engram_create",
    "engram_get",
    "engram_update",
    "engram_delete",
    "engram_search",
    "engram_list",
    "engram_reinforce",
    "engram_report_failure",
    "engram_archive",
    "engram_restore",
    "engram_forget",
    "engram_recompute_importance",
    "synapse_create",
    "synapse_get",
    "synapse_list",
    "synapse_delete",
    "skill_get",
    "skill_invoke",
    "close_learning_loop",
    "contradiction_resolve",
    "get_evolution_lineage",
    "upgrade_verification",
    "engram_list_proposals",
    "engram_accept_proposal",
    "engram_dismiss_proposal",
    // 仓库健康工具(full-only)
    "engram_doctor",
    "engram_list_paths",
    // LLM 综合
    "engram_synthesize",
    // 手动 pull/commit/push
    "engram_sync",
  ]),
};

const DEFAULT_PROFILE: ToolProfile = "standard";

/**
 * 已知的 profile 值(用于验证)
 */
const KNOWN_PROFILES: ReadonlySet<string> = new Set([
  "minimal",
  "standard",
  "full",
]);

/**
 * 解析 profile
 *
 * 优先级:
 *   1. env.COA_ENGRAM_TOOLS_PROFILE / CO_ENGRAM_TOOLS_PROFILE
 *   2. persistedConfig.toolsProfile
 *   3. 默认 'standard'
 *
 * 未知值降级为默认 + 记录警告(调用方决定如何 logging)
 */
export function resolveProfile(
  env: Record<string, string | undefined>,
  persistedConfig?: { readonly toolsProfile?: string },
): {
  profile: ToolProfile;
  source: "env" | "persisted" | "default";
  warned?: string;
} {
  const envValue = env.CO_ENGRAM_TOOLS_PROFILE ?? env.COA_ENGRAM_TOOLS_PROFILE;
  if (envValue !== undefined && envValue !== "") {
    if (KNOWN_PROFILES.has(envValue)) {
      return { profile: envValue as ToolProfile, source: "env" };
    }
    return {
      profile: DEFAULT_PROFILE,
      source: "env",
      warned: `Unknown CO_ENGRAM_TOOLS_PROFILE="${envValue}" (valid: minimal | standard | full), falling back to "${DEFAULT_PROFILE}"`,
    };
  }

  if (
    persistedConfig?.toolsProfile &&
    KNOWN_PROFILES.has(persistedConfig.toolsProfile)
  ) {
    return {
      profile: persistedConfig.toolsProfile as ToolProfile,
      source: "persisted",
    };
  }

  return { profile: DEFAULT_PROFILE, source: "default" };
}

/**
 * 按 profile 过滤工具列表
 *
 * full profile 不过滤(返回原数组)。
 * minimal / standard 用 Set.has() 过滤。
 */
export function filterToolsByProfile(
  tools: readonly Tool[],
  profile: ToolProfile,
): readonly Tool[] {
  if (profile === "full") return tools;
  const set = PROFILE_TOOL_SETS[profile];
  return tools.filter((t) => set.has(t.name));
}

/**
 * 暴露给测试 / 日志:每档 profile 的工具数量
 */
export const PROFILE_TOOL_COUNTS: Record<ToolProfile, number> = {
  minimal: 11,
  standard: 17,
  full: 28,
};
