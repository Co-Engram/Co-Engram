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
  SkillComposeAddInputSchema,
  SkillComposeListInputSchema,
  SkillRelatedEngramInputSchema,
  type SkillGetToolInput,
  type SkillInvokeToolInput,
  type SkillCreateToolInput,
  type SkillListToolInput,
  type SkillUpdateToolInput,
  type SkillComposeAddToolInput,
  type SkillComposeListToolInput,
  type SkillRelatedEngramToolInput,
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
    const skill = requireSkillRepo(ctx).createSkill(parsed);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_create",
        metadata: { skillId: skill.skillId, sourcePath: skill.sourcePath },
      });
    }
    return skill;
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
    "更新 Skill 的 initiationSet/visibility，或手动迁移习得深度轴（draft→compiled→tuned，单向）。",
  inputSchema: SkillUpdateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillUpdateToolInput>(
      SkillUpdateInputSchema,
      input
    );
    const { id, ...patch } = parsed;
    const skill = requireSkillRepo(ctx).updateSkill(id, patch);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_update",
        metadata: {
          skillId: id,
          patch: Object.keys(patch),
          acquisitionStage: skill.acquisitionStage,
          retentionStage: skill.retentionStage
        },
      });
    }
    return skill;
  },
};

export const skillDeleteTool: Tool<SkillGetToolInput, { id: string; deleted: true }> = {
  name: "skill_delete",
  description: "删除 Skill 的 sidecar 印迹（不动 SKILL.md 本体）。",
  inputSchema: SkillGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillGetToolInput>(SkillGetInputSchema, input);
    const repo = requireSkillRepo(ctx);
    const existed = repo.exists(parsed.id);
    repo.deleteSkill(parsed.id);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_delete",
        metadata: {
          skillId: parsed.id,
          existed
        },
      });
    }
    return { id: parsed.id, deleted: true as const };
  },
};

// skill_invoke：记录一次 Skill 使用结果，更新印迹
export const skillInvokeTool: Tool<SkillInvokeToolInput, SkillResult> = {
  name: "skill_invoke",
  description:
    "报告一次 Skill 使用结果（success/effectiveness），用 Rescorla-Wagner 更新 utility + retention。**本工具只记录使用、不执行 skill 本身**——skill 的实际执行由宿主（Claude Code/OpenClaw）完成；agent 在实际用完一个 skill 后，调用本工具报告结果（成功/失败/效能），让 skill 的程序性记忆印迹随使用演化。forgotten 阶段的 skill 会拒绝。",
  inputSchema: SkillInvokeInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<SkillInvokeToolInput>(
      SkillInvokeInputSchema,
      input
    );
    const repo = requireSkillRepo(ctx);
    const before = repo.readSkill(parsed.id);
    if (before.retentionStage === "forgotten") {
      if (ctx.auditLog) {
        ctx.auditLog.append({
          actor: "user",
          action: "skill_invoke",
          metadata: {
            skillId: parsed.id,
            success: false,
            error: "forgotten",
            retentionStage: before.retentionStage
          },
        });
      }
      return {
        skillId: parsed.id,
        success: false,
        output: "",
        error: `Skill ${parsed.id} decayed to forgotten (re-instantiate or restore before use)`,
        executedAt: new Date().toISOString(),
      };
    }
    const after = repo.recordUse(parsed.id, { success: parsed.success, effectiveness: parsed.effectiveness });
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_invoke",
        metadata: {
          skillId: parsed.id,
          success: parsed.success,
          effectiveness: parsed.effectiveness,
          utilityBefore: before.utility,
          utilityAfter: after.utility,
          retentionStage: after.retentionStage
        },
      });
    }
    return {
      skillId: parsed.id,
      success: parsed.success,
      output: `utility=${after.utility.toFixed(3)} successCount=${after.successCount} failureCount=${after.failureCount} retentionStage=${after.retentionStage}`,
      effectiveness: parsed.effectiveness,
      executedAt: new Date().toISOString(),
    };
  },
};

// skill_compose_add：给 Skill 加一个组合关系（A 可编排进 B 的 workflow）
export const skillComposeAddTool: Tool<SkillComposeAddToolInput, Skill> = {
  name: "skill_compose_add",
  description: "给 Skill 加一个组合关系（A 可编排进 B 的 workflow）。去重。",
  inputSchema: SkillComposeAddInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillComposeAddToolInput>(
      SkillComposeAddInputSchema,
      input
    );
    const skill = requireSkillRepo(ctx).addCompose(parsed.skillId, parsed.targetSkillId);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_compose_add",
        metadata: {
          skillId: parsed.skillId,
          targetSkillId: parsed.targetSkillId
        },
      });
    }
    return skill;
  },
};

// skill_compose_remove：移除 Skill 的一个组合关系
export const skillComposeRemoveTool: Tool<SkillComposeAddToolInput, Skill> = {
  name: "skill_compose_remove",
  description: "移除 Skill 的一个组合关系。",
  inputSchema: SkillComposeAddInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillComposeAddToolInput>(
      SkillComposeAddInputSchema,
      input
    );
    const skill = requireSkillRepo(ctx).removeCompose(parsed.skillId, parsed.targetSkillId);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_compose_remove",
        metadata: {
          skillId: parsed.skillId,
          targetSkillId: parsed.targetSkillId
        },
      });
    }
    return skill;
  },
};

// skill_compose_list：列出 Skill 的组合关系（composes）
export const skillComposeListTool: Tool<
  SkillComposeListToolInput,
  { composes: readonly string[] }
> = {
  name: "skill_compose_list",
  description: "列出 Skill 的组合关系（composes）。",
  inputSchema: SkillComposeListInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillComposeListToolInput>(
      SkillComposeListInputSchema,
      input
    );
    return {
      composes: requireSkillRepo(ctx).readSkill(parsed.skillId).composes,
    };
  },
};

// skill_related_engram_add：给 Skill 加 engram 关联（程序性 ↔ 陈述性记忆）
export const skillRelatedEngramAddTool: Tool<SkillRelatedEngramToolInput, Skill> = {
  name: "skill_related_engram_add",
  description: "给 Skill 加一个 engram 关联（程序性 ↔ 陈述性记忆）。去重。",
  inputSchema: SkillRelatedEngramInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillRelatedEngramToolInput>(
      SkillRelatedEngramInputSchema,
      input,
    );
    const skill = requireSkillRepo(ctx).addRelatedEngram(parsed.skillId, parsed.engramId);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_related_engram_add",
        metadata: { skillId: parsed.skillId, engramId: parsed.engramId },
      });
    }
    return skill;
  },
};

// skill_related_engram_remove：移除 Skill 的一个 engram 关联
export const skillRelatedEngramRemoveTool: Tool<SkillRelatedEngramToolInput, Skill> = {
  name: "skill_related_engram_remove",
  description: "移除 Skill 的一个 engram 关联。",
  inputSchema: SkillRelatedEngramInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillRelatedEngramToolInput>(
      SkillRelatedEngramInputSchema,
      input,
    );
    const skill = requireSkillRepo(ctx).removeRelatedEngram(parsed.skillId, parsed.engramId);
    if (ctx.auditLog) {
      ctx.auditLog.append({
        actor: "user",
        action: "skill_related_engram_remove",
        metadata: { skillId: parsed.skillId, engramId: parsed.engramId },
      });
    }
    return skill;
  },
};

// skill_related_engram_list：列出 Skill 关联的 engram（relatedEngrams）
export const skillRelatedEngramListTool: Tool<
  SkillComposeListToolInput,
  { relatedEngrams: readonly string[] }
> = {
  name: "skill_related_engram_list",
  description: "列出 Skill 关联的 engram（relatedEngrams）。",
  inputSchema: SkillComposeListInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillComposeListToolInput>(
      SkillComposeListInputSchema,
      input,
    );
    return {
      relatedEngrams: requireSkillRepo(ctx).readSkill(parsed.skillId).relatedEngrams,
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
  skillComposeAddTool,
  skillComposeRemoveTool,
  skillComposeListTool,
  skillRelatedEngramAddTool,
  skillRelatedEngramRemoveTool,
  skillRelatedEngramListTool,
];
