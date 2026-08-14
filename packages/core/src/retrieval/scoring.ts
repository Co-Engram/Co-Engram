/**
 * 五因子检索打分
 *
 * score = α·relevance + β·recency + γ·effectiveImportance + δ·strength + ε·hotness
 *
 *   - relevance ∈ [0,1]:FTS 归一化分(或向量余弦,P2 引入)
 *   - recency ∈ [0,1]:`0.5^(ageDays / deriveHalfLifeDays(importance))`
 *     (艾宾浩斯衰退;半衰期由 importance 派生 —— 重要记忆衰退慢)
 *   - effectiveImportance ∈ [0,1]:dynamics.effectiveImportance(importance, truthFactor)
 *     真相约束(importance × (0.3 + 0.7 × truthFactor))——
 *     高价值 + 高可信 → 全力使用;高价值 + 低可信 → 减弱;低价值 → 自然低分
 *   - strength ∈ [0,1]:clamp01(reinforcementScore)
 *     用户反馈累积(RPE 强化 - LTD 失败);独立于 importance,反映"被实际用得多 + 用得好"
 *   - hotness ∈ [0,1]:computeHotness(retrievalCount, lastRetrievedAt)
 *     访问热度(OpenViking 移植,2026-08):sigmoid(log1p(count)) 频次对数压缩
 *     × exp(−ln2·ageDays/半衰期) 访问新近度指数衰减。**纯派生量**——从
 *     retrievalCount / lastRetrievedAt 现算,不落盘、无衰减后台任务。
 *     与 strength 正交:strength 是"被验证有效"(reinforce/failure 分化),
 *     hotness 是"被频繁访问"(无论有效与否)。
 *
 * 默认权重(见下方 DEFAULT_WEIGHTS 常量):α=0.5, β=0.15, γ=0.25, δ=0.05, ε=0.05。
 * 2026-08 起 δ 从 0.1 拆分为 δ+ε(访问热度分流显式强化的份额而非新增总权重,
 * 保证分数域仍 ≤1)。config 侧未显式配置 hotness 时,scoringConfigToWeights
 * 把 strength 预算对半拆给 δ/ε(见该函数注释)。
 *
 * truthFactor 由 verificationStatus 派生:verified=1.0 / probable=0.7 /
 * plausible=0.5 / unverified=0.3 / refuted=0。refuted 记忆默认不进检索
 * (M2:retrieval/filter.ts matchesFilter 与 sqlite-orchestrator.ts
 * applyPostFilter 都默认排除 refuted)。truthFactor 在此处仅作用于
 * effectiveImportance 项的真相约束:refuted 时 effImp = importance·0.3
 * (0.3 + 0.7·0);relevance / recency / strength / hotness 四项不受
 * truthFactor 影响,故 refuted 即使混入检索也不会得 0 分(高相关时
 * ≈ α+β = 0.65)——这正是 filter 默认排除 refuted 的必要性,不能依赖
 * 打分兜底压到 0。
 *
 * 排序稳定性:相同输入产生相同输出(不依赖 Math.random;时间相关项统一
 * 经 options.now / options.halfLifeDays 注入,测试可控)。
 *
 * @module @co-engram/core/retrieval
 */

import { effectiveAge } from "../lifecycle/freshness.js";
import {
  deriveHalfLifeDays,
  effectiveImportance as computeEffectiveImportance,
} from "../importance/dynamics.js";
import type { VerificationStatus } from "../types/engram.js";
import { validationError } from "../tools/error-schema.js";

/** 五因子权重配置 */
export interface FiveFactorWeights {
  /** relevance 权重(语义/关键词匹配) */
  readonly alpha: number;
  /** recency 权重(艾宾浩斯衰退) */
  readonly beta: number;
  /** effectiveImportance 权重(价值 × 真相约束) */
  readonly gamma: number;
  /** strength 权重(用户反馈累积) */
  readonly delta: number;
  /**
   * hotness 权重(访问热度)。可选:缺省视为 0(纯四因子行为,向后兼容
   * 旧的 FourFactorWeights 字面量;validateWeights 按缺省 0 校验和)。
   */
  readonly epsilon?: number;
}

/**
 * @deprecated 2026-08 五因子化(P0-2 hotness)后改名 FiveFactorWeights。
 * 保留 alias 供外部 import 兼容;epsilon 可选,旧四字段字面量仍可赋值。
 */
export type FourFactorWeights = FiveFactorWeights;

/** 一天的毫秒数(hotness 衰减 ageDays 换算用) */
const MS_PER_DAY = 86_400_000;

/** hotness 默认半衰期(天)。对齐 OpenViking memory_lifecycle 的 7 天经验值 */
export const DEFAULT_HOTNESS_HALF_LIFE_DAYS = 7;

/**
 * 默认权重。
 *
 * 2026-07 修正(importance/freshness 职责分离):
 *   - β(recency)= 0:freshness(effectiveAge)不参与排序。freshness 只管
 *     forgotten 过滤(filter.ts 默认排除 forgotten),不参与检索分。
 *     原 β=0.2 让 importance 通过 halflife(recency)双计,正反馈放大。
 *   - γ(importance)0.2→0.4:吸收 β 权重。importance 是唯一排序信号
 *     (含近期使用信号 via reinforce/decay)。
 *
 * 2026-08 修正(P0-2 hotness,OpenViking 对标):
 *   - δ(strength)0.1→0.05,新增 ε(hotness)=0.05。访问热度分流显式强化
 *     的份额而非新增总权重,分数域保持 ≤1。存量行为影响:未配置 config 的
 *     部署,strength 因子影响减半,访问热度获得 0.05 份额。
 */
export const DEFAULT_WEIGHTS: FiveFactorWeights = {
  alpha: 0.5,
  beta: 0.15,
  gamma: 0.25,
  delta: 0.05,
  epsilon: 0.05,
};

/**
 * 校验权重和为 1(容差 0.001)+ 每个权重 ∈ [0,1]。
 * epsilon 缺省按 0 计入求和(纯四因子配置仍要求和为 1)。
 */
export function validateWeights(w: FiveFactorWeights): void {
  const epsilon = w.epsilon ?? 0;
  const sum = w.alpha + w.beta + w.gamma + w.delta + epsilon;
  if (Math.abs(sum - 1) > 0.001) {
    throw validationError(
      `Weights must sum to 1, got ${sum} (α=${w.alpha} β=${w.beta} γ=${w.gamma} δ=${w.delta} ε=${epsilon})`,
    );
  }
  for (const v of [w.alpha, w.beta, w.gamma, w.delta, epsilon]) {
    if (v < 0 || v > 1) {
      throw validationError(`Weight must be in [0,1], got ${v}`);
    }
  }
}

/**
 * M6:把 config.search.scoring(ScoringSectionConfig: relevance/recency/
 * importance/strength/hotness)转成五因子权重(FiveFactorWeights),并校验和为 1。
 *
 * 字段映射:relevance→alpha / recency→beta / importance→gamma / strength→delta
 * / hotness→epsilon(与 config/defaults.ts DEFAULT_SEARCH_SECTION 的正向映射
 * 对偶)。供 host adapter 装配时把持久化配置注入检索引擎,让运维在
 * team-memory/config.json 调 search.scoring 真正生效。
 *
 * hotness 权重的兼容规则(2026-08 P0-2):
 *   - 用户显式配置 hotness → 按显式值,strength 缺省用 DEFAULT_WEIGHTS.delta
 *   - 未配置 hotness → 把 strength 预算(cfg.strength,缺省 0.1 = 旧四因子
 *     时代的合并默认)对半拆分给 δ/ε。效果:
 *       * 空 config → δ=0.05 / ε=0.05(与 DEFAULT_WEIGHTS 一致)
 *       * 老的四项配置(如 strength=0.1,和=1)→ δ=0.05 / ε=0.05,
 *         和仍为 1,启动不炸(fillDefaults 也不会给老配置补 hotness,
 *         见 DEFAULT_SEARCH_SECTION 注释)
 *
 * 用 inline 结构类型而非 import ScoringSectionConfig,避免 retrieval→config
 * 循环依赖(config/defaults 已 import 本模块的 DEFAULT_WEIGHTS);调用方传
 * ScoringSectionConfig 结构兼容。
 */
export function scoringConfigToWeights(
  cfg: {
    readonly relevance?: number;
    readonly recency?: number;
    readonly importance?: number;
    readonly strength?: number;
    readonly hotness?: number;
  },
): FiveFactorWeights {
  // 未显式配置 strength 时的「strength + hotness 合并预算」(旧四因子默认 δ=0.1)
  const combinedBudget = cfg.strength ?? 0.1;
  const weights: FiveFactorWeights =
    cfg.hotness !== undefined
      ? {
          alpha: cfg.relevance ?? DEFAULT_WEIGHTS.alpha,
          beta: cfg.recency ?? DEFAULT_WEIGHTS.beta,
          gamma: cfg.importance ?? DEFAULT_WEIGHTS.gamma,
          delta: cfg.strength ?? DEFAULT_WEIGHTS.delta,
          epsilon: cfg.hotness,
        }
      : {
          alpha: cfg.relevance ?? DEFAULT_WEIGHTS.alpha,
          beta: cfg.recency ?? DEFAULT_WEIGHTS.beta,
          gamma: cfg.importance ?? DEFAULT_WEIGHTS.gamma,
          delta: combinedBudget / 2,
          epsilon: combinedBudget / 2,
        };
  validateWeights(weights);
  return weights;
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
 * hotness:访问热度(OpenViking memory_lifecycle 公式移植)
 *
 * `hotness = sigmoid(ln(1 + retrievalCount)) · exp(−ln2 · ageDays / halfLifeDays)`
 *
 *   - 频次项 sigmoid(log1p(count)):对数压缩防刷,count=1→0.67、
 *     10→0.92、100→0.99(刷 100 次只比 10 次多 0.07)
 *   - 衰减项:7 天半衰期(默认),按 lastRetrievedAt 距今指数衰减。
 *     **打分时现算**——衰减不需要后台任务,无「衰减债」
 *   - 纯派生量:输入 retrievalCount / lastRetrievedAt 均为每次检索命中后
 *     已异步落盘的既有字段,本函数零写路径
 *   - 边界:count≤0 或 lastRetrievedAt 空(从未被检索)→ 0,不加权;
 *     lastRetrievedAt 非法格式 → ageDays NaN → decay NaN → clamp01 兜底 0
 *
 * @param retrievalCount - 检索命中次数(engram.retrievalCount)
 * @param lastRetrievedAt - 最后一次检索命中时间 ISO(engram.lastRetrievedAt)
 * @param options.now - 当前时间(测试注入)
 * @param options.halfLifeDays - 半衰期天数(默认 7)
 */
export function computeHotness(
  retrievalCount: number,
  lastRetrievedAt: string | null | undefined,
  options: { readonly now?: Date; readonly halfLifeDays?: number } = {},
): number {
  if (!lastRetrievedAt) return 0;
  const count = Math.max(0, Math.floor(retrievalCount));
  if (count <= 0) return 0;
  const halfLife = options.halfLifeDays ?? DEFAULT_HOTNESS_HALF_LIFE_DAYS;
  if (halfLife <= 0) return 0;

  const now = options.now ?? new Date();
  const ageDays =
    (now.getTime() - new Date(lastRetrievedAt).getTime()) / MS_PER_DAY;
  if (Number.isNaN(ageDays)) return 0;

  const frequency = 1 / (1 + Math.exp(-Math.log1p(count)));
  const decay = Math.exp(-Math.LN2 * (Math.max(0, ageDays) / halfLife));
  return clamp01(frequency * decay);
}

/**
 * 从 FiveFactorInput + relevance 计算五因子得分(适用于 DigestLine 及 SQLite 召回行)
 *
 * recency 维度的衰退计时起点 = `lastEffectiveAt ?? line.lastEffectiveAt ?? line.createdAt`:
 * 未生效 engram 用 createdAt 兜底,新记忆从编码完成起开始衰退(艾宾浩斯模型)。
 * hotness 维度的衰减计时起点 = `line.lastRetrievedAt`(访问新近度,与
 * lastEffectiveAt 语义不同:前者是"命中过",后者是"命中且被验证有效")。
 *
 * @param relevance - 归一化相关度 [0,1]
 * @param line - 打分输入(含 importance / reinforcementScore / verificationStatus /
 *   retrievalCount / lastRetrievedAt;后两者缺省时 hotness=0)
 * @param options.lastEffectiveAt - 最后有效检索时间(可选,省略则用 line.lastEffectiveAt)
 * @param options.now - 当前时间(可选,便于测试;省略则 new Date())
 * @param options.weights - 权重配置(可选,省略用默认)
 * @param options.hotnessHalfLifeDays - hotness 半衰期天数(可选,默认 7)
 */
export interface FiveFactorInput {
  /** 重要性 [0,1] — recency(经 halflife)+ effImp 双用 */
  readonly importance: number;
  /** 创建时间 ISO — 未生效时的衰退起点兜底 */
  readonly createdAt: string;
  /** 最后有效检索 ISO — 衰退计时首选起点,null/undefined 则 fallback createdAt */
  readonly lastEffectiveAt?: string | null;
  /** 验证状态 — 派生 truthFactor 调制 effImp */
  readonly verificationStatus?: VerificationStatus | string | null;
  /** 强化分 — strength 因子 */
  readonly reinforcementScore?: number;
  /** 检索命中次数 — hotness 因子频次项(缺省 0) */
  readonly retrievalCount?: number;
  /** 最后一次检索命中 ISO — hotness 因子衰减项(缺省/null 则 hotness=0) */
  readonly lastRetrievedAt?: string | null;
}

/** @deprecated 五因子化后改名 FiveFactorInput,保留 alias 兼容 */
export type FourFactorInput = FiveFactorInput;

export function computeFiveFactorScore(
  relevance: number,
  line: FiveFactorInput,
  options: {
    lastEffectiveAt?: string | null;
    now?: Date;
    weights?: FiveFactorWeights;
    hotnessHalfLifeDays?: number;
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
  const strength = clamp01(line.reinforcementScore ?? 0);
  const hotness = computeHotness(line.retrievalCount ?? 0, line.lastRetrievedAt, {
    now,
    halfLifeDays: options.hotnessHalfLifeDays,
  });

  return (
    weights.alpha * clamp01(relevance) +
    weights.beta * recency +
    weights.gamma * effImp +
    weights.delta * strength +
    (weights.epsilon ?? 0) * hotness
  );
}

/** @deprecated 五因子化后改名 computeFiveFactorScore,保留 alias 兼容 */
export const computeFourFactorScore = computeFiveFactorScore;

/**
 * 五因子批量打分(保持原数组顺序,稳定排序友好)
 */
export function computeFiveFactorScores(
  items: ReadonlyArray<{ id: string; relevance: number; line: FiveFactorInput }>,
  options: {
    now?: Date;
    weights?: FiveFactorWeights;
    hotnessHalfLifeDays?: number;
  } = {},
): ReadonlyArray<{ id: string; score: number }> {
  return items.map((item) => ({
    id: item.id,
    score: computeFiveFactorScore(item.relevance, item.line, options),
  }));
}

/** @deprecated 五因子化后改名 computeFiveFactorScores,保留 alias 兼容 */
export const computeFourFactorScores = computeFiveFactorScores;

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
