/**
 * 三因子检索打分
 *
 * 实现 spec 3.7：
 *   score = α·relevance + β·recency + γ·importance
 *
 * 其中：
 *   - relevance ∈ [0,1]：来自 FTS 归一化分（或向量余弦，P2 引入）
 *   - recency ∈ [0,1]：`0.5^(ageDays / decayHalfLifeDays)`（Ebbinghaus 衰退）
 *     · decayHalfLifeDays=null → recency=1（永不衰退）
 *     · ageDays ≤ 0（未来/刚刚）→ recency=1
 *   - importance ∈ [0,1]：`engram.importance × (1 + reinforcementScore)`
 *     · reinforcementScore 由 P1 2.1 三信号追踪累积
 *     · 用 min 截断到 [0,1]，避免上溢
 *
 * 默认权重：α=0.5, β=0.3, γ=0.2（spec 3.7 / 决策 9）
 *
 * 排序稳定性：相同输入产生相同输出（不依赖 Math.random/Date.now）。
 *
 * @module @co-engram/core/retrieval
 */

import type { DigestLine } from "../index/types.js";

/** 三因子权重配置 */
export interface ThreeFactorWeights {
  /** relevance 权重（语义/关键词匹配） */
  readonly alpha: number;
  /** recency 权重（艾宾浩斯衰退） */
  readonly beta: number;
  /** importance 权重（价值） */
  readonly gamma: number;
}

/** 默认权重（spec 3.7：α=0.5, β=0.3, γ=0.2） */
export const DEFAULT_WEIGHTS: ThreeFactorWeights = {
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
};

/**
 * 校验权重和为 1（容差 0.001）
 */
export function validateWeights(w: ThreeFactorWeights): void {
  const sum = w.alpha + w.beta + w.gamma;
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(
      `Weights must sum to 1, got ${sum} (α=${w.alpha} β=${w.beta} γ=${w.gamma})`,
    );
  }
  for (const v of [w.alpha, w.beta, w.gamma]) {
    if (v < 0 || v > 1) {
      throw new Error(`Weight must be in [0,1], got ${v}`);
    }
  }
}

/**
 * 艾宾浩斯衰退函数
 *
 * `recency = 0.5^(ageDays / decayHalfLifeDays)`
 *
 * - decayHalfLifeDays=null/undefined → 1（永不衰退）
 * - decayHalfLifeDays<=0 → 1（非法半衰期视为不衰退）
 * - ageDays<=0 → 1（未来或刚刚）
 */
export function recencyDecay(
  ageDays: number,
  decayHalfLifeDays: number | null | undefined,
): number {
  if (!decayHalfLifeDays || decayHalfLifeDays <= 0) return 1;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / decayHalfLifeDays);
}

/**
 * 有效重要性
 *
 * `effectiveImportance = importance × (1 + reinforcementScore)`
 *
 * 截断到 [0,1]，避免 reinforcement 累积导致 > 1。
 *
 * - reinforcementScore 由 P1 2.1 累积（每次 reinforce 加 effectiveness）
 * - 高 reinforcement → importance 接近原值上限
 */
export function effectiveImportance(
  importance: number,
  reinforcementScore: number,
): number {
  if (reinforcementScore <= 0) {
    return clamp01(importance);
  }
  // 衰减式提升：避免 importance × (1+∞) → 1
  // P1 简化：直接 importance × (1 + reinforcementScore)，clamp 到 [0,1]
  return clamp01(importance * (1 + reinforcementScore));
}

/**
 * 从 DigestLine + relevance 计算三因子得分
 *
 * @param relevance - 归一化相关度 [0,1]
 * @param line - DigestLine（含 recency/importance 数据）
 * @param lastEffectiveAt - 最后有效检索时间（可选，省略则用 line.lastEffectiveAt）
 * @param now - 当前时间（可选，便于测试；省略则 new Date()）
 * @param weights - 权重配置（可选，省略用默认）
 */
export function computeThreeFactorScore(
  relevance: number,
  line: DigestLine,
  options: {
    lastEffectiveAt?: string | null;
    now?: Date;
    weights?: ThreeFactorWeights;
  } = {},
): number {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  validateWeights(weights);

  const now = options.now ?? new Date();
  const lastEffective = options.lastEffectiveAt ?? line.lastEffectiveAt;
  const ageDays = computeAgeDays(lastEffective, now);

  const recency = recencyDecay(ageDays, line.decayHalfLifeDays);
  const importance = effectiveImportance(
    line.importance,
    line.reinforcementScore,
  );

  return (
    weights.alpha * clamp01(relevance) +
    weights.beta * recency +
    weights.gamma * importance
  );
}

/**
 * 三因子批量打分（保持原数组顺序，稳定排序友好）
 */
export function computeThreeFactorScores(
  items: ReadonlyArray<{ id: string; relevance: number; line: DigestLine }>,
  options: {
    now?: Date;
    weights?: ThreeFactorWeights;
  } = {},
): ReadonlyArray<{ id: string; score: number }> {
  return items.map((item) => ({
    id: item.id,
    score: computeThreeFactorScore(item.relevance, item.line, options),
  }));
}

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * 将多个 rank list 融合为一个综合 rank。
 * 常用场景：FTS top-K + 向量 top-K → 综合 top-K。
 *
 * 公式：`score(d) = Σ 1 / (k + rank_i(d))`，其中 k 默认 60（业界经验值）。
 *
 * - rank 从 1 开始；未出现在某 list 中的 doc 不贡献分
 * - 输出按融合分倒序
 *
 * @param rankedLists - 多个有序 id 列表（每个 list 已经按相关度从高到低排好）
 * @param k - 平滑常数（默认 60）
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): ReadonlyArray<{ id: string; score: number }> {
  if (k <= 0) {
    throw new Error(`RRF k must be > 0, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      // 稳定排序：同分按 id 字典序（保证可重现）
      return a.id < b.id ? -1 : 1;
    });
}

// ============================================================
// 辅助函数
// ============================================================

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeAgeDays(
  lastEffectiveAt: string | null | undefined,
  now: Date,
): number {
  if (!lastEffectiveAt) return Number.POSITIVE_INFINITY; // 从未有效 → age = ∞ → recency → 0
  const ts = new Date(lastEffectiveAt).getTime();
  if (Number.isNaN(ts)) return Number.POSITIVE_INFINITY;
  const ageMs = now.getTime() - ts;
  if (ageMs < 0) return 0; // 时钟偏差/未来
  return ageMs / (1000 * 60 * 60 * 24);
}
