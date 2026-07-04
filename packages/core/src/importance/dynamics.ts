// packages/core/src/importance/dynamics.ts
/**
 * Importance 动态化核心(D1)
 *
 * 神经科学依据:
 *   - 机制 B(预测误差):使用时意外程度更新
 *   - 机制 C(贝叶斯大脑):每次事件做后验更新
 *   - 机制 D(突触稳态):重要记忆衰减慢 → halflife 派生
 *
 * 配置通过 env 覆盖默认值,允许运行时调优。
 *
 * @module @co-engram/core/importance
 */

const LTP_GAIN = Number(process.env.CO_ENGRAM_LTP_GAIN ?? 0.1);
const RETRIEVAL_GAIN = Number(process.env.CO_ENGRAM_RETRIEVAL_GAIN ?? 0.05);
const FAILURE_LOSS = Number(process.env.CO_ENGRAM_FAILURE_LOSS ?? 0.1);
const TASK_SUCCESS_GAIN = Number(
  process.env.CO_ENGRAM_TASK_SUCCESS_GAIN ?? 0.15,
);
const TASK_FAILURE_LOSS = Number(
  process.env.CO_ENGRAM_TASK_FAILURE_LOSS ?? 0.05,
);
const DAILY_DECAY = Number(process.env.CO_ENGRAM_DAILY_DECAY ?? 0.95);
/**
 * 半衰期基准(天)。50 是经验值:让 importance=0.5 的中等记忆半衰期 ≈ 14 天
 * (50 × 0.6^2.5 ≈ 13.95),符合测试期望与用户对"中等记忆遗忘速度"的语义。
 */
const BASE_HALFLIFE_DAYS = Number(
  process.env.CO_ENGRAM_BASE_HALFLIFE_DAYS ?? 50,
);

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

export function applyDailyDecay(current: number): number {
  return clamp01(current * DAILY_DECAY);
}

/**
 * 半衰期派生(机制 D):重要记忆衰减慢。
 *
 * 公式:halflife = BASE * (importance + 0.1) ^ 2.5
 *   importance=0.0 → 0.16 天(快速遗忘)
 *   importance=0.5 → 14 天(中等)
 *   importance=1.0 → 63 天(深度巩固)
 */
export function deriveHalfLifeDays(importance: number): number {
  return BASE_HALFLIFE_DAYS * Math.pow(importance + 0.1, 2.5);
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
