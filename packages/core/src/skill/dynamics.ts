/**
 * Skill 印迹核纯函数（spec §2.3）
 * - utility: ACT-R Rescorla-Wagner
 * - retention: Oblivion exp(-n/S), S=(U+F+ε)·T
 * @module @co-engram/core/skill
 */
import type { AcquisitionStage, RetentionStage } from "../types/skill.js";

export const DEFAULT_LEARNING_RATE = 0.1;
/**
 * 基准衰减尺度(天)。15:低样本技能(用过 1 次,U≈0.55,F=0.05)的
 * S≈(0.55+0.05+0.1)×15≈10.5 天 → 7 天不用到 aging、约 14 天 stale、
 * 约 29 天 forgotten。原值 10 时 S≈6.8 天,5 天即 stale、9 天 forgotten,
 * "用进"的奖励追不上"废退"的惩罚(一次成功仅延长 S 0.3 天)。
 */
const OBLIVION_T = 15;
const OBLIVION_EPSILON = 0.1;
const FREQUENCY_CAP = 20;
const RETENTION_THRESHOLD_ACTIVE = 0.75;
const RETENTION_THRESHOLD_AGING = 0.5;
const RETENTION_THRESHOLD_STALE = 0.25;

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Rescorla-Wagner: U(n)=U(n-1)+α·[R(n)-U(n-1)] */
export function updateUtility(
  currentU: number,
  reward: number,
  alpha = DEFAULT_LEARNING_RATE,
): number {
  return clamp01(currentU + alpha * (reward - currentU));
}

/**
 * Oblivion: retention=exp(-n/S), S=(U+F+ε)·T, F=归一化频率
 *
 * n 的锚点:优先 lastUsedAt(用过→距上次使用);从未使用→距 createdAt
 * (注册起算)。原实现把 lastUsedAt=null 映射为 now(n≡0),导致从未使用的
 * 技能永久冻结在 active、"被使用过的技能反而先被遗忘"的倒置——修复后
 * never-used 也随库龄老化(未验证+陈旧→逐渐淡出注入清单),与 relearning
 * 通道(skill_invoke 复活 forgotten)配套成闭环。
 */
export function computeRetention(
  skill: {
    readonly utility: number;
    readonly invocationCount: number;
    readonly lastUsedAt: string | null;
    /** 衰减起点兜底:lastUsedAt=null(从未使用)时用 createdAt;null→n=0 */
    readonly createdAt: string | null;
  },
  nowMs: number,
): number {
  const u = clamp01(skill.utility);
  const f = Math.min(1, skill.invocationCount / FREQUENCY_CAP);
  const s = (u + f + OBLIVION_EPSILON) * OBLIVION_T;
  const anchor = skill.lastUsedAt ?? skill.createdAt;
  const last = anchor ? new Date(anchor).getTime() : nowMs;
  const nDays = Math.max(0, (nowMs - last) / 86_400_000);
  return Math.exp(-nDays / s);
}

export function projectRetentionStage(retention: number): RetentionStage {
  if (retention > RETENTION_THRESHOLD_ACTIVE) return "active";
  if (retention > RETENTION_THRESHOLD_AGING) return "aging";
  if (retention > RETENTION_THRESHOLD_STALE) return "stale";
  return "forgotten";
}

/**
 * 技能退役候选判定(纯函数,light 周期经 listRetireCandidates 调用)。
 *
 * 判据(全部满足):
 *   1. invocationCount === 0 —— 「零调用」:从未被使用验证过(实证:9 技能
 *      6 个零调用,SkillsBench 测得技能库使 19% 任务负 delta;零调用技能是
 *      潜在负资产,不是闲置资产)。「用过后来忘了」的技能不在此列 —— 它们
 *      已被验证有价值,且 forgotten 已联动移出注入清单,叠加退役是噪音。
 *   2. 锚点(lastUsedAt ?? createdAt,与 computeRetention 同锚)距今 ≥ minZeroUseDays
 *      —— 未验证状态持续足够久,排除刚注册还没机会被用的技能。
 *   3. retentionStage ∈ {stale, forgotten} —— 与衰退投影联动。注意默认参数
 *      (T=15, never-used S≈9 天)下 30 天零调用必然已 forgotten(仅判 stale
 *      会让规则在默认参数下永不触发);stale 分支覆盖用户调小 minZeroUseDays
 *      的配置。
 *   4. 未 retiredAt —— 已退役的不重复提案。
 */
export function isRetireCandidate(
  skill: {
    readonly invocationCount: number;
    readonly lastUsedAt: string | null;
    readonly createdAt: string | null;
    readonly retentionStage: RetentionStage;
    readonly retiredAt?: string;
  },
  nowMs: number,
  minZeroUseDays: number,
): boolean {
  if (skill.retiredAt !== undefined) return false;
  if (skill.invocationCount !== 0) return false;
  if (
    skill.retentionStage !== "stale" &&
    skill.retentionStage !== "forgotten"
  ) {
    return false;
  }
  const anchor = skill.lastUsedAt ?? skill.createdAt;
  if (!anchor) return false;
  const ageDays = (nowMs - new Date(anchor).getTime()) / 86_400_000;
  return ageDays >= minZeroUseDays;
}

const ACQUISITION_ORDER: readonly AcquisitionStage[] = [
  "draft",
  "compiled",
  "tuned",
];

export function canTransitionAcquisition(
  from: AcquisitionStage,
  to: AcquisitionStage,
): boolean {
  if (from === to) return false;
  return ACQUISITION_ORDER.indexOf(to) - ACQUISITION_ORDER.indexOf(from) === 1;
}
