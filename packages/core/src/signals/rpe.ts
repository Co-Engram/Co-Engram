/**
 * RPE（Reward Prediction Error）有效性计算（P4 B）
 *
 * 人类多巴胺机制的工程化映射：
 *
 *   effectiveness = actual - expected
 *
 * 其中：
 *   expected = 检索时算出的相关性分数（lastRetrievalScore，[0,1]）
 *   actual   = 该 engram 在后续工具调用流中收到的累积信号（signalWeight，[-1,1]）
 *
 * effectiveness 为正 → 超预期（强化）；为负 → 失望（衰减）。
 *
 * @module @co-engram/core/signals
 */

import type { EngramRepository } from "../storage/repository.js";

/** RPE 输入 */
export interface RpeInput {
  /** 检索时的相关性分数 [0,1]，作为"预期值" */
  readonly expected: number;
  /** 累积行为信号 [-1,1]，作为"实际值" */
  readonly signalWeight: number;
  /** 触发信号的次数（用于判断是否应更新） */
  readonly signalCount: number;
}

/** 默认学习率（Δreinforcement 系数） */
export const DEFAULT_RPE_LEARNING_RATE = 0.1;

/** effectiveness 死区阈值：|eff| ≤ DEAD_ZONE 时不更新 */
export const RPE_DEAD_ZONE = 0.05;

/**
 * 计算 RPE（不写库）
 *
 * - signalCount === 0 → 返回 0（无信号不更新）
 * - actual = (clamp(signalWeight, -1, 1) + 1) / 2  // 归一化到 [0,1]
 * - rpe = actual - expected                          // ∈ [-1, 1]
 *
 * @returns effectiveness ∈ [-1, 1]
 */
export function computeRpe(input: RpeInput): number {
  if (input.signalCount === 0) return 0;
  const clampedSignal = Math.max(-1, Math.min(1, input.signalWeight));
  const actual = (clampedSignal + 1) / 2;
  const expected = Math.max(0, Math.min(1, input.expected));
  return actual - expected;
}

/**
 * 应用一次 RPE 更新（写库）
 *
 * 根据 effectiveness 符号：
 *   eff > 0.05  → effectiveRetrievals += 1, reinforcementScore += eff * lr
 *   eff < -0.05 → failedUses += 1, reinforcementScore += eff * lr（负值,衰减）
 *   |eff| ≤ 0.05 → 中性,不更新
 *
 * 不触发 version++。
 *
 * @returns 更新详情（供审计/日志）
 */
export function applyRpeUpdate(
  repo: EngramRepository,
  engramId: string,
  effectiveness: number,
  learningRate: number = DEFAULT_RPE_LEARNING_RATE,
): RpeUpdateResult {
  if (Math.abs(effectiveness) <= RPE_DEAD_ZONE) {
    return { engramId, effectiveness, action: "neutral", delta: 0 };
  }

  const delta = effectiveness * learningRate;

  if (effectiveness > 0) {
    repo.bumpRetrievalStats(engramId, {
      effectiveDelta: 1,
      reinforcementDelta: delta,
      lastEffectiveAt: new Date().toISOString(),
    });
    return { engramId, effectiveness, action: "reinforced", delta };
  }

  repo.bumpRetrievalStats(engramId, {
    failedDelta: 1,
    reinforcementDelta: delta,
  });
  return { engramId, effectiveness, action: "penalized", delta };
}

/** RPE 应用结果 */
export interface RpeUpdateResult {
  readonly engramId: string;
  readonly effectiveness: number;
  readonly action: "reinforced" | "penalized" | "neutral";
  readonly delta: number;
}
