/**
 * Skill 工具集（P0 框架）
 *
 * 仅提供 get / invoke 框架，具体执行逻辑在 P1 实现。
 * Skill 持久化（skill-store）也在 P1。
 *
 * P0 阶段：从 host 注入的 in-memory registry 读取
 *
 * @module @co-engram/core/tools
 */

import type { Skill, SkillResult } from "../types/skill.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import {
  SkillGetInputSchema,
  SkillInvokeInputSchema,
  type SkillGetToolInput,
  type SkillInvokeToolInput,
} from "./schemas.js";

/**
 * Skill 扩展上下文（可选）
 *
 * host 可以注入一个 in-memory skill registry，工具从中读取
 */
export interface SkillToolContextExtension {
  readonly skills?: ReadonlyMap<string, Skill>;
  readonly skillExecutor?: (
    skill: Skill,
    args: Record<string, unknown>,
  ) => Promise<SkillResult> | SkillResult;
}

type SkillAwareContext = ToolContext & SkillToolContextExtension;

// ============================================================
// skill_get
// ============================================================

export const skillGetTool: Tool<SkillGetToolInput, Skill> = {
  name: "skill_get",
  description: "读取 Skill 元信息（程序性记忆）。P0 阶段从内存 registry 读取。",
  inputSchema: SkillGetInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<SkillGetToolInput>(SkillGetInputSchema, input);
    const ext = ctx as SkillAwareContext;
    if (!ext.skills) {
      throw new Error("Skill registry not available in ToolContext");
    }
    const skill = ext.skills.get(parsed.id);
    if (!skill) {
      throw new Error(`Skill not found: ${parsed.id}`);
    }
    return skill;
  },
};

// ============================================================
// skill_invoke
// ============================================================

export const skillInvokeTool: Tool<SkillInvokeToolInput, SkillResult> = {
  name: "skill_invoke",
  description:
    "调用一个 Skill（程序性记忆）。P0 阶段是框架；具体模板执行（tool-sequence / prompt-template）在 P1 实现。",
  inputSchema: SkillInvokeInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<SkillInvokeToolInput>(
      SkillInvokeInputSchema,
      input,
    );
    const ext = ctx as SkillAwareContext;
    if (!ext.skills) {
      throw new Error("Skill registry not available in ToolContext");
    }
    const skill = ext.skills.get(parsed.id);
    if (!skill) {
      throw new Error(`Skill not found: ${parsed.id}`);
    }

    // 检查是否处于 deprecated 状态
    if (skill.automation.level === "deprecated") {
      return {
        skillId: parsed.id,
        success: false,
        output: "",
        error: `Skill ${parsed.id} is deprecated`,
        executedAt: new Date().toISOString(),
      };
    }

    // 检查是否处于 forgotten 衰退阶段
    if (skill.decay.stage === "forgotten") {
      return {
        skillId: parsed.id,
        success: false,
        output: "",
        error: `Skill ${parsed.id} has decayed to forgotten stage`,
        executedAt: new Date().toISOString(),
      };
    }

    // 如果 host 注入了 executor，委托给它
    if (ext.skillExecutor) {
      return await ext.skillExecutor(skill, parsed.args);
    }

    // P0 默认：仅返回框架结果（不真正执行模板）
    return {
      skillId: parsed.id,
      success: true,
      output: `[P0 stub] Skill ${skill.title} invoked with args: ${JSON.stringify(parsed.args)}`,
      executedAt: new Date().toISOString(),
    };
  },
};

export const ALL_SKILL_TOOLS: readonly Tool[] = [skillGetTool, skillInvokeTool];
