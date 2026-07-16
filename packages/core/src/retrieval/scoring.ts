/**
 * 四因子检索打分
 *
 * score = α·relevance + β·recency + γ·effectiveImportance + δ·strength
 *
 *   - relevance ∈ [0,1]:FTS 归一化分(或向量余弦,P2 引入)
 *   - recency ∈ [0,1]:`0.5^(ageDays / deriveHalfLifeDays(importance))`
 *     (艾宾浩斯衰退;半衰期由 importance 派生 —— 重要记忆衰退慢)
 *   - effectiveImportance ∈ [0,1]:dynamics.effectiveImportance(importance, truthFactor)
 *     真相约束(importance × (0.3 + 0.7 × truthFactor))——
 *     高价值 + 高可信 → 全力使用;高价值 + 低可信 → 减弱;低价值 → 自然低分
 *   - strength ∈ [0,1]:clamp01(reinforcementScore)
 *     用户反馈累积(RPE 强化 - LTD 失败);独立于 importance,反映"被实际用得多 + 用得好"
 *
 * 默认权重(spec §3.7):α=0.5, β=0.2, γ=0.2, δ=0.1
 *
 * truthFactor 由 verificationStatus 派生:verified=1.0 / probable=0.7 /
 * plausible=0.5 / unverified=0.3 / refuted=0。refuted 默认不进检索
 * (filter 已排除),此处保留映射确保即使混入也得 0 分。
 *
 * 排序稳定性:相同输入产生相同输出(不依赖 Math.random/Date.now)。
 *
 * @module @co-engram/core/retrieval
 */

import type { DigestLine } from "../index/types.js";
import { effectiveAge } from "../lifecycle/freshness.js";
import {
  deriveHalfLifeDays,
  effectiveImportance as computeEffectiveImportance,
} from "../importance/dynamics.js";
import type { VerificationStatus } from "../types/engram.js";
import { validationError } from "../tools/error-schema.js";

/** 四因子权重配置 */
export interface FourFactorWeights {
  /** relevance 权重(语义/关键词匹配) */
  readonly alpha: number;
  /** recency 权重(艾宾浩斯衰退) */
  readonly beta: number;
  /** effectiveImportance 权重(价值 × 真相约束) */
  readonly gamma: number;
  /** strength 权重(用户反馈累积) */
  readonly delta: number;
}

/**
 * 默认权重。
 *
 * 2026-07 修正(importance/freshness 职责分离):
 *   - β(recency)= 0:freshness(effectiveAge)不参与排序。freshness 只管
 *     forgotten 过滤(filter.ts 默认排除 forgotten),不参与检索分。
 *     原 β=0.2 让 importance 通过 halflife(recency)双计,正反馈放大。
 *   - γ(importance)0.2→0.4:吸收 β 权重。importance 是唯一排序信号
 *     (含近期使用信号 via reinforce/decay)。
 */
export const DEFAULT_WEIGHTS: FourFactorWeights = {
  alpha: 0.5,
  beta: 0,
  gamma: 0.4,
  delta: 0.1,
};

/**
 * 校验权重和为 1(容差 0.001)+ 每个权重 ∈ [0,1]
 */
export function validateWeights(w: FourFactorWeights): void {
  const sum = w.alpha + w.beta + w.gamma + w.delta;
  if (Math.abs(sum - 1) > 0.001) {
    throw validationError(
      `Weights must sum to 1, got ${sum} (α=${w.alpha} β=${w.beta} γ=${w.gamma} δ=${w.delta})`,
    );
  }
  for (const v of [w.alpha, w.beta, w.gamma, w.delta]) {
    if (v < 0 || v > 1) {
      throw validationError(`Weight must be in [0,1], got ${v}`);
    }
  }
}

/**
 * 艾宾浩斯衰退函数
 *
 * `recency = 0.5^(ageDays / deriveHalfLifeDays(importance))`
 *
 * 半衰期从 importance 实时派生(机制 D):重要记忆衰退慢。
 *
 * - ageDays<=0 → 1(未来或刚刚)
 */
export function recencyDecay(ageDays: number, importance: number): number {
  if (ageDays <= 0) return 1;
  const halfLife = deriveHalfLifeDays(importance);
  if (halfLife <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * verificationStatus → truthFactor 映射(机制 D 的"真相约束"输入)
 *
 * 用于 dynamics.effectiveImportance(importance, truthFactor):refuted=0,
 * verified=1.0,中间档线性插值。缺失或未知 → 0.3(等同 unverified)。
 */
export function truthFactorFromStatus(
  status?: VerificationStatus | string | null,
): number {
  switch (status) {
    case "verified":
      return 1.0;
    case "probable":
      return 0.7;
    case "plausible":
      return 0.5;
    case "refuted":
      return 0;
    case "unverified":
    default:
      return 0.3;
  }
}

/**
 * 从 DigestLine + relevance 计算四因子得分
 *
 * recency 维度的衰退计时起点 = `lastEffectiveAt ?? line.lastEffectiveAt ?? line.createdAt`:
 * 未生效 engram 用 createdAt 兜底,新记忆从编码完成起开始衰退(艾宾浩斯模型)。
 *
 * @param relevance - 归一化相关度 [0,1]
 * @param line - DigestLine(含 importance / reinforcementScore / verificationStatus)
 * @param lastEffectiveAt - 最后有效检索时间(可选,省略则用 line.lastEffectiveAt)
 * @param now - 当前时间(可选,便于测试;省略则 new Date())
 * @param weights - 权重配置(可选,省略用默认)
 */
export function computeFourFactorScore(
  relevance: number,
  line: DigestLine,
  options: {
    lastEffectiveAt?: string | null;
    now?: Date;
    weights?: FourFactorWeights;
  } = {},
): number {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  validateWeights(weights);

  const now = options.now ?? new Date();
  const lastEffective = options.lastEffectiveAt ?? line.lastEffectiveAt;
  const ageDays = effectiveAge(lastEffective, line.createdAt, now);

  const recency = recencyDecay(ageDays, line.importance);
  const truthFactor = truthFactorFromStatus(line.verificationStatus);
  const effImp = computeEffectiveImportance(line.importance, truthFactor);
  const strength = clamp01(line.reinforcementScore);

  return (
    weights.alpha * clamp01(relevance) +
    weights.beta * recency +
    weights.gamma * effImp +
    weights.delta * strength
  );
}

/**
 * 四因子批量打分(保持原数组顺序,稳定排序友好)
 */
export function computeFourFactorScores(
  items: ReadonlyArray<{ id: string; relevance: number; line: DigestLine }>,
  options: {
    now?: Date;
    weights?: FourFactorWeights;
  } = {},
): ReadonlyArray<{ id: string; score: number }> {
  return items.map((item) => ({
    id: item.id,
    score: computeFourFactorScore(item.relevance, item.line, options),
  }));
}

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * 将多个 rank list 融合为一个综合 rank。
 * 常用场景:FTS top-K + 向量 top-K → 综合 top-K。
 *
 * 公式:`score(d) = Σ 1 / (k + rank_i(d))`,其中 k 默认 60(业界经验值)。
 *
 * - rank 从 1 开始;未出现在某 list 中的 doc 不贡献分
 * - 输出按融合分倒序
 *
 * @param rankedLists - 多个有序 id 列表(每个 list 已经按相关度从高到低排好)
 * @param k - 平滑常数(默认 60)
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): ReadonlyArray<{ id: string; score: number }> {
  if (k <= 0) {
    throw validationError(`RRF k must be > 0, got ${k}`);
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
      // 稳定排序:同分按 id 字典序(保证可重现)
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
