// packages/core/src/importance/dynamics.ts
/**
 * Importance 动态化核心(D1)
 *
 * 神经科学依据:
 *   - 机制 B(预测误差):使用时意外程度更新
 *   - 机制 C(贝叶斯大脑):每次事件做后验更新
 *   - 机制 D(突触稳态):重要记忆衰减慢 → halflife 派生
 *
 * 2026-07-20 重大修改:移除 Daily 衰减(applyDailyDecay)。
 * 原因:importance 代表突触强度,神经学上时间不直接降低突触强度——只有
 * 缺乏 LTP 信号(不使用)才会间接导致 LTD。Daily 衰减让 importance 被时间
 * 污染,与 freshness 形成循环依赖(importance↓→halfLife↓→freshness 加速衰退)。
 * 移除后:importance 纯事件驱动(RPE/LTP/LTD),freshness 纯时间驱动(age vs
 * halfLife),搜索用 recency(β)独立提供时间维度。
 *
 * 配置通过 env 覆盖默认值,允许运行时调优。
 *
 * @module @co-engram/core/importance
 */

import type { EngramKind } from "../types/engram.js";

const LTP_GAIN = Number(process.env.CO_ENGRAM_LTP_GAIN ?? 0.1);
const RETRIEVAL_GAIN = Number(process.env.CO_ENGRAM_RETRIEVAL_GAIN ?? 0.05);
const FAILURE_LOSS = Number(process.env.CO_ENGRAM_FAILURE_LOSS ?? 0.1);
const TASK_SUCCESS_GAIN = Number(
  process.env.CO_ENGRAM_TASK_SUCCESS_GAIN ?? 0.15,
);
const TASK_FAILURE_LOSS = Number(
  process.env.CO_ENGRAM_TASK_FAILURE_LOSS ?? 0.05,
);
/**
 * 半衰期基准(天)。50 是经验值:让 importance=0.5 的 fact 记忆半衰期 ≈ 23 天
 * (50 × 0.6^1.5 ≈ 23.2),符合"中等记忆遗忘速度"的语义。
 */
const BASE_HALFLIFE_DAYS = Number(
  process.env.CO_ENGRAM_BASE_HALFLIFE_DAYS ?? 50,
);

/**
 * kind → halfLife 倍率。不同记忆类型的持久度不同(神经学:情景记忆 < 语义记忆 < 巩固记忆)。
 *
 * observation ×0.6: 情景记忆(海马依赖),最快衰退
 * hypothesis ×0.7: 待验证假设,不应久留
 * procedure  ×0.8: 工具相关流程,可能过时(如 ADB 命令随版本变)
 * fact       ×1.0: 语义记忆(皮层),基准
 * pattern    ×1.5: REM 提炼产物,已跨情境验证,最持久
 */
const KIND_HALFLIFE_MULTIPLIER: Record<EngramKind, number> = {
  observation: 0.6,
  hypothesis: 0.7,
  procedure: 0.8,
  fact: 1.0,
  pattern: 1.5,
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function updateOnCreate(initial?: number): number {
  return clamp01(initial ?? 0.5);
}

export function updateOnReinforce(current: number, eff: number): number {
  return clamp01(current + eff * LTP_GAIN);
}

export function updateOnRetrieveHit(current: number): number {
  return clamp01(current + RETRIEVAL_GAIN);
}

export function updateOnReportFailure(current: number): number {
  return clamp01(current - FAILURE_LOSS);
}

export function updateOnTaskSuccess(current: number, value: number): number {
  return clamp01(current + value * TASK_SUCCESS_GAIN);
}

export function updateOnTaskFailure(current: number): number {
  return clamp01(current - TASK_FAILURE_LOSS);
}

/**
 * 半衰期派生(机制 D):重要记忆衰减慢 + kind 感知持久度。
 *
 * 公式:halflife = BASE * (importance + 0.1) ^ 1.5 * kindMultiplier(kind)
 *
 * importance 维度(importance 越高 → halfLife 越长 → freshness 衰退越慢):
 *   importance=0.0 → 基准 ×0.0316(快速但非暴坠)
 *   importance=0.5 → 基准 ×0.465(中等)
 *   importance=1.0 → 基准 ×0.854(深度巩固)
 *
 * kind 维度(不同记忆类型持久度不同):
 *   observation(fact 基准):×0.6(情景,最快衰退)
 *   procedure:×0.8(工具相关,可能过时)
 *   fact:×1.0(语义,基准)
 *   pattern:×1.5(REM 提炼,最持久)
 *
 * 2026-07-20:移除 Daily 衰减后,halfLife 公式不变,但 importance 不再被
 * Daily 衰减降低 → halfLife 稳定 → freshness 老化速率稳定(不加速)。
 */
export function deriveHalfLifeDays(
  importance: number,
  kind?: EngramKind,
): number {
  const multiplier = kind ? (KIND_HALFLIFE_MULTIPLIER[kind] ?? 1.0) : 1.0;
  return BASE_HALFLIFE_DAYS * Math.pow(importance + 0.1, 1.5) * multiplier;
}

/**
 * 真相约束(用户修正:价值-真相非正交,价值是上游,真相是约束)。
 *
 * effectiveImportance = importance * (0.3 + 0.7 * truthFactor)
 *   高价值 + 高可信 → 全力使用
 *   高价值 + 低可信 → 减弱(用户修正 1)
 *   低价值 + 高可信 → 自然低分
 *   低价值 + 低可信 → 几乎忽略
 */
export function effectiveImportance(
  importance: number,
  truthFactor: number,
): number {
  return clamp01(importance * (0.3 + 0.7 * truthFactor));
}
