/**
 * Skill 类型（程序性记忆，spec v2 精简版）
 *
 * 科学根基：ACT-R utility(动力学) + Options 三元组(结构) + Oblivion retention(衰退)。
 * 三层分离：不变本体 / 可变投影 / 可插拔载体(policy)。
 * @module @co-engram/core/types
 */

/** 执行载体（可插拔，不进本体语义） */
export interface SkillPolicy {
  readonly kind: "claude-skill" | "openclaw-skill" | "prompt" | "code" | "workflow";
  readonly ref: string;
}

/** 习得深度轴（ACT-R compilation，单向不可逆） */
export type AcquisitionStage = "draft" | "compiled" | "tuned";

/** 时间强度轴投影（Oblivion retention 离散化） */
export type RetentionStage = "active" | "aging" | "stale" | "forgotten";

/** sidecar imprint.json 的磁盘格式（JSON，英文 key） */
export interface SkillImprint {
  readonly schemaVersion: 1;
  readonly skillId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly initiationSet: string;
  readonly termination: string;
  readonly policy: SkillPolicy;
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
}

/** 运行时 Skill 对象（= SkillImprint，语义别名） */
export type Skill = SkillImprint;

export interface SkillCreateInput {
  readonly skillId: string;
  readonly sourcePath: string;
  readonly initiationSet: string;
  readonly termination: string;
  readonly policy: SkillPolicy;
  readonly visibility?: "public" | "team" | "private";
  readonly createdBy: string;
}

export interface SkillUpdateInput {
  readonly initiationSet?: string;
  readonly termination?: string;
  readonly policy?: SkillPolicy;
  readonly visibility?: "public" | "team" | "private";
  /** 手动迁移习得深度轴（draft→compiled→tuned） */
  readonly acquisitionStage?: AcquisitionStage;
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
