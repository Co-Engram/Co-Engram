/**
 * Freshness 自动计算（P1：记忆生命周期）
 *
 * 神经科学依据：艾宾浩斯遗忘曲线 + 多级存储模型
 *
 * 计算规则（基于 spec §3.1）：
 *   - freshness 由 lastEffectiveAt + decayHalfLifeDays 派生（不存储）
 *   - halfLife 内 → fresh
 *   - 1×~2×halfLife → aging
 *   - 2×~4×halfLife → stale
 *   - 4×+halfLife → forgotten（候选遗忘）
 *
 * decayHalfLifeDays = null 表示永不衰退，恒为 fresh
 *
 * @module @co-engram/core/lifecycle
 */

import type { EngramFreshness } from "../types/engram.js";

/** 默认半衰期天数（与 EngramRepository 默认值一致） */
export const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * 根据 lastEffectiveAt + decayHalfLifeDays 计算当前 freshness
 *
 * @param lastEffectiveAt - 最后一次有效检索时间（ISO），null 表示从未有效
 * @param decayHalfLifeDays - 半衰期天数，null 表示永不衰退
 * @param now - 当前时间（可注入用于测试），默认 new Date()
 */
export function computeFreshness(
  lastEffectiveAt: string | null | undefined,
  decayHalfLifeDays: number | null | undefined,
  now: Date = new Date(),
): EngramFreshness {
  // 永不衰退
  if (decayHalfLifeDays === null || decayHalfLifeDays === undefined) {
    return "fresh";
  }

  // 从未有效检索 → 视为 fresh（新创建的 engram）
  if (!lastEffectiveAt) {
    return "fresh";
  }

  const lastEffective = new Date(lastEffectiveAt).getTime();
  if (Number.isNaN(lastEffective)) {
    return "fresh";
  }

  const ageMs = now.getTime() - lastEffective;
  if (ageMs < 0) {
    // 时间倒流（时钟偏差）→ fresh
    return "fresh";
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const halfLife = decayHalfLifeDays;

  if (ageDays <= halfLife) return "fresh";
  if (ageDays <= halfLife * 2) return "aging";
  if (ageDays <= halfLife * 4) return "stale";
  return "forgotten";
}

/**
 * 批量计算 freshness（用于派生索引重建）
 */
export function computeFreshnessBatch(
  items: ReadonlyArray<{
    readonly lastEffectiveAt: string | null | undefined;
    readonly decayHalfLifeDays: number | null | undefined;
  }>,
  now: Date = new Date(),
): EngramFreshness[] {
  return items.map((item) =>
    computeFreshness(item.lastEffectiveAt, item.decayHalfLifeDays, now),
  );
}
