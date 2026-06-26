/**
 * Intention 类型定义（前瞻记忆）
 *
 * 补全"未来"维度。
 *
 * @module @co-engram/core/types
 */

import type { EngramId, IntentionId, SceneId, SkillId } from "./engram.js";

/** 时间触发 */
export interface TimeBasedTrigger {
  readonly kind: "time-based";
  readonly at: string;
  readonly recurrence?: string;
}

/** 事件触发 */
export interface EventBasedTrigger {
  readonly kind: "event-based";
  readonly condition: string;
  readonly detector: DetectorSpec;
}

/** 活动触发 */
export interface ActivityBasedTrigger {
  readonly kind: "activity-based";
  readonly afterTask: TaskPattern;
  readonly sceneAffinity?: SceneId;
}

/** 触发器联合类型 */
export type IntentionTrigger =
  | TimeBasedTrigger
  | EventBasedTrigger
  | ActivityBasedTrigger;

/** 事件检测器规格 */
export interface DetectorSpec {
  readonly type: "logcat" | "file-change" | "http" | "process" | "custom";
  readonly pattern: string;
  readonly args?: Record<string, string>;
}

/** 任务模式 */
export interface TaskPattern {
  readonly taskType: string;
  readonly args?: Record<string, string>;
}

/** 提醒动作 */
export interface RemindAction {
  readonly kind: "remind";
  readonly message: string;
}

/** 验证动作 */
export interface VerifyAction {
  readonly kind: "verify";
  readonly engramId: EngramId;
  readonly check: string;
}

/** 执行动作 */
export interface ExecuteAction {
  readonly kind: "execute";
  readonly skillId: SkillId;
}

/** 提议动作 */
export interface ProposeAction {
  readonly kind: "propose";
  readonly hypothesisTemplate: string;
}

/** 动作联合类型 */
export type IntentionAction =
  | RemindAction
  | VerifyAction
  | ExecuteAction
  | ProposeAction;

/** Intention 状态 */
export type IntentionStatus =
  | "pending"
  | "fired"
  | "snoozed"
  | "completed"
  | "cancelled";

/** Intention 触发统计 */
export interface IntentionStats {
  readonly firedCount: number;
  readonly effectivenessAfterFire: number;
}

/**
 * Intention 完整对象
 */
export interface Intention {
  readonly id: IntentionId;
  readonly trigger: IntentionTrigger;
  readonly action: IntentionAction;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly status: IntentionStatus;
  readonly priority: number;
  readonly stats: IntentionStats;
}

/** 创建 Intention 的输入 */
export interface IntentionCreateInput {
  readonly trigger: IntentionTrigger;
  readonly action: IntentionAction;
  readonly createdBy: string;
  readonly priority?: number;
}
