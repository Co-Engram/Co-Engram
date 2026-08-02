/**
 * Skill 类型（程序性记忆，spec v2 精简版）
 *
 * 科学根基：ACT-R utility(动力学) + Options initiation(触发,I_ω) + Oblivion retention(衰退)。
 * 三层分离：不变本体 / 可变投影（policy/termination 于 S6.x 移除:co-engram 不执行 skill,β_ω/π_ω 无消费方）。
 * @module @co-engram/core/types
 */
import { SkillId, EngramId } from "./engram.js";

/**
 * 习得深度轴（ACT-R compilation，单向不可逆）
 * 对应 Fitts-Posner 三阶段：draft(认知期) → compiled(熟练期) → tuned(精通期)
 */
export type AcquisitionStage = "draft" | "compiled" | "tuned";

/** 时间强度轴投影（Oblivion retention 离散化） */
export type RetentionStage = "active" | "aging" | "stale" | "forgotten";

/**
 * sidecar imprint.json 的磁盘格式（JSON，英文 key）
 *
 * S6.x 移除 termination(β_ω) + policy(π_ω)：co-engram 不执行 skill，
 * 二者无消费方（detectComposeCandidates 的 termination∩initiationSet 判据
 * 是死代码,从未接入业务）。保留 initiationSet(I_ω,有检索/触发消费方)。
 */
export interface SkillImprint {
  readonly schemaVersion: 1;
  readonly skillId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly initiationSet: string;
  /** SKILL.md 原生字段(S6.x:从 frontmatter 提取,兼容 agentskills.io / Claude Code / OpenClaw 规范) */
  readonly allowedTools?: readonly string[];
  readonly license?: string;
  readonly skillVersion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly compatibility?: string;
  readonly utility: number;
  readonly sampleSize: number;
  readonly invocationCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt: string | null;
  readonly acquisitionStage: AcquisitionStage;
  readonly retentionStage: RetentionStage;
  readonly visibility: "public" | "team" | "private";
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  /** 组合关系：本 skill 可编排进哪些其他 skill 的 workflow（Skill Chaining） */
  readonly composes: readonly SkillId[];
  /** skill ↔ engram 关联：本 skill 关联哪些 engram（程序性 ↔ 陈述性） */
  readonly relatedEngrams: readonly EngramId[];
}

/** 运行时 Skill 对象（= SkillImprint，语义别名） */
export type Skill = SkillImprint;

export interface SkillCreateInput {
  readonly skillId: string;
  readonly sourcePath: string;
  readonly initiationSet: string;
  /** SKILL.md 原生字段(可选,从 frontmatter 提取) */
  readonly allowedTools?: readonly string[];
  readonly license?: string;
  readonly skillVersion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly compatibility?: string;
  readonly visibility?: "public" | "team" | "private";
  readonly createdBy: string;
  readonly composes?: readonly SkillId[];
  readonly relatedEngrams?: readonly EngramId[];
}

export interface SkillUpdateInput {
  readonly initiationSet?: string;
  readonly visibility?: "public" | "team" | "private";
  /** 手动迁移习得深度轴（draft→compiled→tuned） */
  readonly acquisitionStage?: AcquisitionStage;
  readonly composes?: readonly SkillId[];
  readonly relatedEngrams?: readonly EngramId[];
}

/** Skill 执行结果（skill_invoke stub 用，S1 不变） */
export interface SkillResult {
  readonly skillId: string;
  readonly success: boolean;
  readonly output: string;
  readonly effectiveness?: number;
  readonly error?: string;
  readonly executedAt: string;
}
