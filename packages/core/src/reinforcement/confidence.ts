/**
 * confidence 演化(A3 混合速率)+ importance 调制辅助
 *
 * 范式:confidence 是 correctness 基础输入(存盘+演化),importance 是派生综合。
 * A3 速率:明确对错信号(refute/verify)即时大幅,模糊反馈(effective/failure)缓调。
 * 这是 confidence 区别于 importance(全慢)的全部理由——前额叶元认知对明确对错快速反应。
 *
 * @module @co-engram/core/reinforcement
 */

export type ConfidenceSignal = "refute" | "verify" | "effective" | "failure";

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 应用一次 confidence 信号,返回新 confidence(clamp [0,1])。
 *
 * A3 速率:
 *   refute    ×0.3          (即时大幅跌,前额叶式)
 *   verify    +0.2(上限 0.95)(即时大幅升,独立验证支撑)
 *   effective +0.05         (缓升,模糊正反馈)
 *   failure   −0.05         (缓降,模糊负反馈)
 */
export function applyConfidenceSignal(
  current: number,
  signal: ConfidenceSignal,
): number {
  switch (signal) {
    case "refute":
      return clamp01(current * 0.3);
    case "verify":
      return clamp01(Math.min(0.95, current + 0.2));
    case "effective":
      return clamp01(current + 0.05);
    case "failure":
      return clamp01(current - 0.05);
  }
}

/**
 * 低置信惩罚:daily-decay 对不可信记忆加速遗忘。
 * confidence≥0.5 无惩罚;<0.5 线性 (0.5−confidence)×0.1(最大 0.05)。
 */
export function lowConfidencePenalty(confidence: number): number {
  if (confidence >= 0.5) return 0;
  return (0.5 - confidence) * 0.1;
}
