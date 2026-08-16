/**
 * 工具暴露 profile(host-agnostic 单一源)
 *
 * 15 轮拉通分析的元2「双宿主无契约」修复:
 * 此前 PROFILE_TOOL_SETS / PROFILE_TOOL_COUNTS 只存在于 claude-code-mcp,
 * openclaw-plugin 完全没有 profile 选择机制。R13 实证 PROFILE_TOOL_COUNTS
 * 三档全错(minimal 写 11 实际 12,standard 写 17 实际 18,full 写 28 实际 29)。
 *
 * 修复方向:host-agnostic 概念应放 core 单一源,两宿主 re-export 引用,
 * 契约测试 trivially 满足(同一份对象引用)。PROFILE_TOOL_COUNTS 用 .size
 * 自动算,永久防回归。
 *
 * @module @co-engram/core/tools
 */

import type { Tool } from "./tool.js";

/**
 * 三档 profile
 */
export type ToolProfile = "minimal" | "standard" | "full";

/**
 * 每档 profile 包含的工具名集合
 *
 * minimal: 12 个 —— 核心读写 + proposal 处理三件套 + engram_sync
 *   proposal 工具进 minimal 的原因:维护引擎默认在后台运行,会持续产生
 *   proposals。若 minimal 暴露了"待审核候选 N 条"提示却不容许处理,会形成
 *   "看得到但处理不了"的体验断裂。把 list/accept/dismiss 提供到 minimal,
 *   让 agent 在任何 profile 下都能闭环处理 proposal。
 *   engram_sync 进 minimal:让所有 profile 都能主动掌控提交时机。
 *
 * standard: 40 个 = minimal 12 + 学习回路/contradiction/数据管理 +
 *   自愈/路径树 + engram_synthesize + engram_audit_query + 批量 proposal(2) +
 *   S1 skill CRUD(5) + S3 skill_invoke(报告使用) + S5 skill compose(6) +
 *   夜思 incubation_*(7)
 *
 * full: 48 个 = 全部 native 工具(包含隐藏的管理类工具,调试用),
 *   含 skill_invoke(S3 已实现,用于报告 skill 使用结果) +
 *   S5 skill compose(6) + 夜思 incubation_*(7)
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
    // minimal 12
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
    "engram_sync",
    // 学习回路 + contradiction + 数据管理
    "engram_delete",
    "close_learning_loop",
    "contradiction_resolve",
    // 仓库健康工具(自愈扫描 + 渐进式披露,面向所有用户)
    "engram_doctor",
    "engram_list_paths",
    // LLM 综合(手工触发 REM,需 llmClient 注入)
    "engram_synthesize",
    // 审计查询(让挑剔用户不开 viewer 也能查事件历史)
    "engram_audit_query",
    // AI-8 batch proposal(让用户一次清空数千 load-test 候选)
    "engram_accept_proposals_by_source",
    "engram_dismiss_proposals_by_filter",
    // S1 skill CRUD（读 + 管理）
    "skill_get",
    "skill_list",
    "skill_create",
    "skill_update",
    "skill_delete",
    // S3 skill_invoke（报告使用结果，更新印迹）
    "skill_invoke",
    // S5 skill compose（组合关系管理）
    "skill_compose_add",
    "skill_compose_remove",
    "skill_compose_list",
    "skill_related_engram_add",
    "skill_related_engram_remove",
    "skill_related_engram_list",
    // 夜思(incubation_*,spec §四)
    "incubation_create",
    "incubation_run",
    "incubation_list",
    "incubation_resolve",
    "incubation_report",
    "incubation_conclude",
    "incubation_update",
  ]),
  full: new Set<string>([
    // 全部 native 工具(含自愈/路径树等高级工具)
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
    "synapse_create",
    "synapse_get",
    "synapse_list",
    "synapse_delete",
    "skill_get",
    "skill_list",
    "skill_create",
    "skill_update",
    "skill_delete",
    // S3 skill_invoke（报告使用结果，更新印迹）
    "skill_invoke",
    // S5 skill compose（组合关系管理）
    "skill_compose_add",
    "skill_compose_remove",
    "skill_compose_list",
    "skill_related_engram_add",
    "skill_related_engram_remove",
    "skill_related_engram_list",
    "close_learning_loop",
    "contradiction_resolve",
    "get_evolution_lineage",
    "upgrade_verification",
    "engram_list_proposals",
    "engram_accept_proposal",
    "engram_dismiss_proposal",
    // AI-8 batch proposal
    "engram_accept_proposals_by_source",
    "engram_dismiss_proposals_by_filter",
    // 仓库健康工具(full-only)
    "engram_doctor",
    "engram_list_paths",
    // LLM 综合
    "engram_synthesize",
    // 审计查询(让挑剔用户不开 viewer 也能查事件历史)
    "engram_audit_query",
    // 手动 pull/commit/push
    "engram_sync",
    // 夜思(incubation_*,spec §四)
    "incubation_create",
    "incubation_run",
    "incubation_list",
    "incubation_resolve",
    "incubation_report",
    "incubation_conclude",
    "incubation_update",
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
 *
 * 15 轮拉通 R13 实证:此前硬编码 11/17/28 全错(实际 12/18/29)。
 * 改用 .size 自动算,永久防回归。
 */
export const PROFILE_TOOL_COUNTS: Record<ToolProfile, number> = {
  minimal: PROFILE_TOOL_SETS.minimal.size,
  standard: PROFILE_TOOL_SETS.standard.size,
  full: PROFILE_TOOL_SETS.full.size,
};
