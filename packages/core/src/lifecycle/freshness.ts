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
 * 计算 engram 的有效年龄(天)
 *
 * 衰退计时起点 = `lastEffectiveAt ?? createdAt`:
 *   - 已生效 engram → 用 lastEffectiveAt(上次有效检索时间)
 *   - 未生效 engram → 用 createdAt(创建时间)
 *
 * 第一性原理:艾宾浩斯模型里所有记忆都随时间衰退,使用只是刷新计时。
 * "未生效"不是免衰退的特权状态,它只是"还没第一次刷新",新记忆从编码完成起即开始衰退。
 *
 * 鲁棒性:lastEffectiveAt 损坏(非法字符串)时 fallback 到 createdAt;两者都损坏返回 0(视为 fresh)。
 *
 * @param lastEffectiveAt - 最后一次有效检索时间(ISO),null/undefined/损坏 表示从未生效或数据异常
 * @param createdAt - engram 创建时间(ISO),必填
 * @param now - 当前时间
 */
export function effectiveAge(
  lastEffectiveAt: string | null | undefined,
  createdAt: string,
  now: Date = new Date(),
): number {
  const lastEffMs = lastEffectiveAt ? new Date(lastEffectiveAt).getTime() : Number.NaN;
  const createdMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  // 优先 lastEffectiveAt(若为合法时间戳);否则 fallback createdAt
  const ts = !Number.isNaN(lastEffMs) ? lastEffMs : createdMs;
  if (Number.isNaN(ts)) return 0;
  const ageMs = now.getTime() - ts;
  if (ageMs < 0) return 0; // 时钟偏差/未来
  return ageMs / (1000 * 60 * 60 * 24);
}

/**
 * 根据 lastEffectiveAt + createdAt + decayHalfLifeDays 计算当前 freshness
 *
 * @param lastEffectiveAt - 最后一次有效检索时间(ISO),null/undefined 表示从未生效
 * @param createdAt - engram 创建时间(ISO),未生效时的衰退起点
 * @param decayHalfLifeDays - 半衰期天数,null 表示永不衰退
 * @param now - 当前时间(可注入用于测试),默认 new Date()
 */
export function computeFreshness(
  lastEffectiveAt: string | null | undefined,
  createdAt: string,
  decayHalfLifeDays: number | null | undefined,
  now: Date = new Date(),
): EngramFreshness {
  // 永不衰退
  if (decayHalfLifeDays === null || decayHalfLifeDays === undefined) {
    return "fresh";
  }

  const ageDays = effectiveAge(lastEffectiveAt, createdAt, now);
  const halfLife = decayHalfLifeDays;

  if (ageDays <= halfLife) return "fresh";
  if (ageDays <= halfLife * 2) return "aging";
  if (ageDays <= halfLife * 4) return "stale";
  return "forgotten";
}

/**
 * 批量计算 freshness(用于派生索引重建)
 */
export function computeFreshnessBatch(
  items: ReadonlyArray<{
    readonly lastEffectiveAt: string | null | undefined;
    readonly createdAt: string;
    readonly decayHalfLifeDays: number | null | undefined;
  }>,
  now: Date = new Date(),
): EngramFreshness[] {
  return items.map((item) =>
    computeFreshness(
      item.lastEffectiveAt,
      item.createdAt,
      item.decayHalfLifeDays,
      now,
    ),
  );
}
