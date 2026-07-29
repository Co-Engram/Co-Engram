/**
 * Skill 工具集（S1：CRUD 持久化版）
 * - skill_create/list/get/update/delete：持久化 CRUD（ctx.skillRepository）
 * - skill_invoke：仍为 stub（S3 实现），适配新 Skill 类型
 * skill_get 从 SkillRepository 读（不再依赖 host 注入的内存 registry）。
 * @module @co-engram/core/tools
 */
import type { Skill, SkillResult } from "../types/skill.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput, notFoundError, configError } from "./tool.js";
import {
  SkillGetInputSchema,
  SkillInvokeInputSchema,
  SkillCreateInputSchema,
  SkillListInputSchema,
  SkillUpdateInputSchema,
  type SkillGetToolInput,
  type SkillInvokeToolInput,
  type SkillCreateToolInput,
  type SkillListToolInput,
  type SkillUpdateToolInput,
} from "./schemas.js";

function requireSkillRepo(ctx: ToolContext) {
  if (!ctx.skillRepository) {
    throw configError(
      "ctx.skillRepository",
      "skill tools require a SkillRepository — host adapter must inject `skillRepository` into ToolContext (S4)."
    );
  }
  return ctx.skillRepository;
}

export const skillCreateTool: Tool<SkillCreateToolInput, Skill> = {
  name: "skill_create",
  description:
    "创建一个 Skill（程序性记忆）实体并持久化到 sidecar imprint.json。skillId 通常 = 宿主 skill 的 name frontmatter。",
  inputSchema: SkillCreateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillCreateToolInput>(
      SkillCreateInputSchema,
      input
    );
    return requireSkillRepo(ctx).createSkill(parsed);
  },
};

export const skillGetTool: Tool<SkillGetToolInput, Skill> = {
  name: "skill_get",
  description: "读取 Skill 元信息与印迹（utility/retention/stage）。",
  inputSchema: SkillGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillGetToolInput>(SkillGetInputSchema, input);
    return requireSkillRepo(ctx).readSkill(parsed.id);
  },
};

export const skillListTool: Tool<SkillListToolInput, { items: Skill[] }> = {
  name: "skill_list",
  description: "列出所有 Skill，可按 acquisitionStage / retentionStage 过滤。",
  inputSchema: SkillListInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillListToolInput>(
      SkillListInputSchema,
      input
    );
    let items = requireSkillRepo(ctx).listSkills();
    if (parsed.acquisitionStage) {
      items = items.filter((s) => s.acquisitionStage === parsed.acquisitionStage);
    }
    if (parsed.retentionStage) {
      items = items.filter((s) => s.retentionStage === parsed.retentionStage);
    }
    return { items };
  },
};

export const skillUpdateTool: Tool<SkillUpdateToolInput, Skill> = {
  name: "skill_update",
  description:
    "更新 Skill 的 initiationSet/termination/policy/visibility，或手动迁移习得深度轴（draft→compiled→tuned，单向）。",
  inputSchema: SkillUpdateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillUpdateToolInput>(
      SkillUpdateInputSchema,
      input
    );
    const { id, ...patch } = parsed;
    return requireSkillRepo(ctx).updateSkill(id, patch);
  },
};

export const skillDeleteTool: Tool<SkillGetToolInput, { id: string; deleted: true }> = {
  name: "skill_delete",
  description: "删除 Skill 的 sidecar 印迹（不动 SKILL.md 本体）。",
  inputSchema: SkillGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillGetToolInput>(SkillGetInputSchema, input);
    requireSkillRepo(ctx).deleteSkill(parsed.id);
    return { id: parsed.id, deleted: true as const };
  },
};

// skill_invoke：记录一次 Skill 使用结果，更新印迹
export const skillInvokeTool: Tool<SkillInvokeToolInput, SkillResult> = {
  name: "skill_invoke",
  description:
    "记录一次 Skill 使用结果（success/effectiveness），Rescorla-Wagner 更新 utility + retention。语义=记录使用+更新可塑性，不替代宿主执行（真实执行由宿主完成，本调用用于固化程序性记忆的印迹）。",
  inputSchema: SkillInvokeInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<SkillInvokeToolInput>(
      SkillInvokeInputSchema,
      input
    );
    const repo = requireSkillRepo(ctx);
    const before = repo.readSkill(parsed.id);
    if (before.retentionStage === "forgotten") {
      return {
        skillId: parsed.id,
        success: false,
        output: "",
        error: `Skill ${parsed.id} decayed to forgotten (re-instantiate or restore before use)`,
        executedAt: new Date().toISOString(),
      };
    }
    const after = repo.recordUse(parsed.id, { success: parsed.success, effectiveness: parsed.effectiveness });
    return {
      skillId: parsed.id,
      success: parsed.success,
      output: `utility=${after.utility.toFixed(3)} successCount=${after.successCount} failureCount=${after.failureCount} retentionStage=${after.retentionStage}`,
      effectiveness: parsed.effectiveness,
      executedAt: new Date().toISOString(),
    };
  },
};

export const ALL_SKILL_TOOLS: readonly Tool[] = [
  skillCreateTool,
  skillGetTool,
  skillListTool,
  skillUpdateTool,
  skillDeleteTool,
  skillInvokeTool,
];
