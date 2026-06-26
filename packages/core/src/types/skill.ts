/**
 * Skill 类型定义（程序性记忆）
 *
 * 与业界 Skill 的本质差异：业界把 Skill 当"工具"（静态、无记忆、无进化），
 * Co-Engram 把 Skill 当"神经通路"（活的、可进化、会衰退）。
 *
 * @module @co-engram/core/types
 */

import type { EngramId, IntentionId, SceneId, SkillId } from "./engram.js";

/** Skill 触发器 */
export interface SkillTrigger {
  readonly pattern: string;
  readonly keywords: readonly string[];
  readonly taskType: TaskType;
}

/** 任务类型 */
export type TaskType =
  | "debug"
  | "test"
  | "deploy"
  | "document"
  | "refactor"
  | "review"
  | "explore"
  | "other";

/** Skill 模板类型 */
export type SkillTemplateType =
  | "tool-sequence"
  | "prompt-template"
  | "code-snippet"
  | "workflow";

/** Skill 模板 */
export interface SkillTemplate {
  readonly type: SkillTemplateType;
  readonly content: string;
  readonly variables: readonly SkillVariable[];
}

/** Skill 变量 */
export interface SkillVariable {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}

/** Skill 自动化级别 */
export type SkillAutomationLevel = "suggest" | "auto-execute" | "deprecated";

/** Skill 自动化元数据 */
export interface SkillAutomation {
  readonly level: SkillAutomationLevel;
  readonly confidence: number;
}

/** Skill 衰退阶段 */
export type SkillDecayStage = "active" | "aging" | "stale" | "forgotten";

/** Skill 衰退状态 */
export interface SkillDecay {
  readonly halfLifeDays: number | null;
  readonly currentStrength: number;
  readonly stage: SkillDecayStage;
}

/** Skill 使用统计 */
export interface SkillStats {
  readonly successCount: number;
  readonly failureCount: number;
  readonly avgEffectiveness: number;
  readonly lastUsedAt?: string;
}

/**
 * Skill 完整对象
 *
 * 与 Engram 一样有完整生命周期（含衰退机制）
 */
export interface Skill {
  readonly id: SkillId;

  /* === 基础 === */
  readonly title: string;
  readonly trigger: SkillTrigger;
  readonly template: SkillTemplate;

  /* === 差异化 1：进化来源 === */
  readonly evolvedFrom: EngramId | IntentionId | null;

  /* === 差异化 2：适用边界（元认知） === */
  readonly applicableContext: string;
  readonly boundaryConditions: readonly string[];

  /* === 差异化 3：自动化级别（闭合回路） === */
  readonly automation: SkillAutomation;

  /* === 差异化 4：场景过滤 === */
  readonly activeInScenes: readonly SceneId[];
  readonly inhibitedInScenes: readonly SceneId[];

  /* === 组合性（Skill 网络） === */
  readonly composes: readonly SkillId[];

  /* === 差异化 5：衰退机制 === */
  readonly decay: SkillDecay;

  /* === 使用统计 === */
  readonly stats: SkillStats;

  /* === 安全机制 === */
  readonly reflectAfterConsecutiveFailures: number;

  /* === 可解释性 === */
  readonly relatedEngrams: readonly EngramId[];

  /* === 群体共享 === */
  readonly visibility: "public" | "team" | "private";

  /* === 审计 === */
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Skill 执行结果 */
export interface SkillResult {
  readonly skillId: SkillId;
  readonly success: boolean;
  readonly output: string;
  readonly effectiveness?: number;
  readonly error?: string;
  readonly executedAt: string;
}

/** 创建 Skill 的输入 */
export interface SkillCreateInput {
  readonly title: string;
  readonly trigger: SkillTrigger;
  readonly template: SkillTemplate;
  readonly evolvedFrom?: EngramId | IntentionId;
  readonly applicableContext: string;
  readonly boundaryConditions?: readonly string[];
  readonly automation?: SkillAutomation;
  readonly activeInScenes?: readonly SceneId[];
  readonly inhibitedInScenes?: readonly SceneId[];
  readonly composes?: readonly SkillId[];
  readonly decayHalfLifeDays?: number | null;
  readonly relatedEngrams?: readonly EngramId[];
  readonly visibility?: "public" | "team" | "private";
  readonly createdBy: string;
}
