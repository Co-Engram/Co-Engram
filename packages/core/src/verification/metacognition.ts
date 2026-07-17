/**
 * Metacognition 五维度真值评分（P4 C.1）
 *
 * 人类"元认知"机制的工程化映射：根据结构化证据自动判定 engram 真实性。
 *
 * 五维度（权重）：
 *   crossContext      0.30  跨情境稳定性（不同 domainTag 出现次数）
 *   timeStable        0.25  时间稳定性（ageDays,30 天饱和）
 *   mutuallySupported 0.25  互相支持（extends+consolidates 占比）
 *   sourceReliable    0.20  来源可靠性（createdBy 的可靠性分数）
 *   executable        门槛  procedure kind 的可执行性（默认 0.5,不参与加权）
 *
 * 综合 score + thresholds → recommendation:
 *   - upgrade_verified   :overall ≥ 0.85 且 ageDays ≥ 7
 *   - upgrade_one_level  :overall ≥ 0.70
 *   - refute             :overall < 0.30 且有 contradicts
 *   - hold               :其他
 *
 * applyMetacognition 把 recommendation 落库（调 verification/upgrade.ts）。
 *
 * 设计原则：纯结构化,不调 LLM。每条 engram 评分 O(1)。
 *
 * @module @co-engram/core/verification
 */

import type { Engram, EngramId, VerificationStatus } from "../types/engram.js";
import type { EngramRepository } from "../storage/repository.js";
import { upgradeVerification, refuteEngram } from "./upgrade.js";
import { canTransition } from "./state-machine.js";

/** 元认知输入 */
export interface TruthInput {
  readonly engram: Engram;
  /** synapse 统计（按 kind 分组计数） */
  readonly synapseStats: {
    readonly extends: number;
    readonly consolidates: number;
    readonly contradicts: number;
    readonly derivesFrom: number;
  };
  /** engram 存在的天数 */
  readonly ageDays: number;
  /** 创建者可靠性分数 [0,1]（可选,默认 0.5） */
  readonly createdByReliability?: number;
}

/** 五维度评分 */
export interface TruthScore {
  /** 综合分 [0,1] */
  readonly overall: number;
  /** 各维度原始分 */
  readonly dimensions: Readonly<Record<TruthDimension, number>>;
  /** 推荐动作 */
  readonly recommendation: TruthRecommendation;
  /** 人类可读的推理过程 */
  readonly reasoning: string;
}

/** 五个维度名 */
export type TruthDimension =
  | "crossContext"
  | "timeStable"
  | "mutuallySupported"
  | "sourceReliable"
  | "executable";

/** 推荐动作 */
export type TruthRecommendation =
  | "upgrade_verified"
  | "upgrade_one_level"
  | "refute"
  | "hold";

/** 维度权重（executable 不参与加权,仅作门槛） */
export const TRUTH_WEIGHTS = {
  crossContext: 0.3,
  timeStable: 0.25,
  mutuallySupported: 0.25,
  sourceReliable: 0.2,
  executable: 0, // 不加权
} as const;

/** 阈值 */
export const TRUTH_THRESHOLDS = {
  upgradeVerifiedOverall: 0.85,
  upgradeVerifiedMinAgeDays: 7,
  upgradeOneLevelOverall: 0.7,
  refuteOverall: 0.3,
} as const;

/** 时间稳定性饱和天数（30 天） */
export const TIME_STABLE_SATURATION_DAYS = 30;

/** 跨情境稳定性的 domainTag 饱和数（≥2 个 domain 视为跨情境） */
export const CROSS_CONTEXT_SATURATION_DOMAINS = 2;

/**
 * 计算五维度真值评分（纯函数,不写库）
 */
export function computeTruthScore(input: TruthInput): TruthScore {
  const dimensions = computeDimensions(input);
  const overall = computeOverall(dimensions);
  const recommendation = computeRecommendation(overall, input, dimensions);
  const reasoning = buildReasoning(input, dimensions, overall, recommendation);
  return { overall, dimensions, recommendation, reasoning };
}

/**
 * 应用元认知评分到 engram（写库）
 *
 * 根据 recommendation：
 *   - upgrade_verified   → 升级到 verified
 *   - upgrade_one_level  → 升级一级（unverified → plausible → probable）
 *   - refute             → refuteEngram（任意状态 → refuted）
 *   - hold               → 不动
 *
 * 可选参数：
 *   - ageDays: 覆盖自动计算的年龄（测试 / 强制重新评分用）
 *   - createdByReliability: 创建者可靠性分数
 */
export async function applyMetacognition(
  repo: EngramRepository,
  engramId: EngramId,
  input?: Partial<TruthInput>,
): Promise<TruthApplicationResult> {
  const engram = repo.readEngram(engramId);
  const synapseStats = collectSynapseStats(repo, engramId);
  const ageDays = input?.ageDays ?? computeAgeDays(engram.createdAt);
  const fullInput: TruthInput = {
    engram,
    synapseStats,
    ageDays,
    createdByReliability: input?.createdByReliability,
  };
  const score = computeTruthScore(fullInput);

  let applied = false;
  let newStatus: VerificationStatus | undefined;
  let reason = score.reasoning;

  // REM 审批化(2026-07):不直接 upgrade/refute(落盘),只返回建议。
  // engine 收集 result → 生成 verification proposal → 用户 accept 才落盘。
  if (score.recommendation === "refute") {
    applied = true;
    newStatus = "refuted";
    reason = `metacognition_refute: overall=${score.overall.toFixed(2)} < ${TRUTH_THRESHOLDS.refuteOverall} with ${synapseStats.contradicts} contradicts`;
  } else if (score.recommendation === "upgrade_verified") {
    applied = true;
    newStatus = "verified";
    reason = `metacognition_upgrade_verified: overall=${score.overall.toFixed(2)}`;
  } else if (score.recommendation === "upgrade_one_level") {
    const next = nextStatusLevel(engram.verificationStatus);
    if (next) {
      applied = true;
      newStatus = next;
      reason = `metacognition_upgrade: overall=${score.overall.toFixed(2)} ≥ ${TRUTH_THRESHOLDS.upgradeOneLevelOverall}`;
    } else {
      reason = reasoningHold("already verified");
    }
  }

  return {
    engramId,
    score,
    applied,
    newStatus,
    reason,
  };
}

/** 应用结果 */
export interface TruthApplicationResult {
  readonly engramId: EngramId;
  readonly score: TruthScore;
  readonly applied: boolean;
  readonly newStatus: VerificationStatus | undefined;
  readonly reason: string;
}

// ============================================================
// 内部辅助
// ============================================================

function computeDimensions(input: TruthInput): Record<TruthDimension, number> {
  const domains = input.engram.domainTags?.length ?? 0;
  const crossContext = Math.min(1, domains / CROSS_CONTEXT_SATURATION_DOMAINS);

  const timeStable = Math.min(1, input.ageDays / TIME_STABLE_SATURATION_DAYS);

  const denom =
    input.synapseStats.extends +
    input.synapseStats.consolidates +
    input.synapseStats.contradicts;
  const mutuallySupported =
    denom === 0
      ? 0.5
      : (input.synapseStats.extends + input.synapseStats.consolidates) / denom;

  const sourceReliable = input.createdByReliability ?? 0.5;

  // executable：仅 procedure kind 有意义,默认 0.5
  const executable =
    input.engram.kind === "procedure" ||
    (input.engram.kinds?.includes("procedure") ?? false)
      ? 0.7 // procedure kind 默认 0.7（高于平均）
      : 0.5;

  return {
    crossContext,
    timeStable,
    mutuallySupported,
    sourceReliable,
    executable,
  };
}

function computeOverall(d: Record<TruthDimension, number>): number {
  return (
    TRUTH_WEIGHTS.crossContext * d.crossContext +
    TRUTH_WEIGHTS.timeStable * d.timeStable +
    TRUTH_WEIGHTS.mutuallySupported * d.mutuallySupported +
    TRUTH_WEIGHTS.sourceReliable * d.sourceReliable
  );
}

function computeRecommendation(
  overall: number,
  input: TruthInput,
  d: Record<TruthDimension, number>,
): TruthRecommendation {
  if (
    overall >= TRUTH_THRESHOLDS.upgradeVerifiedOverall &&
    d.timeStable * TIME_STABLE_SATURATION_DAYS >=
      TRUTH_THRESHOLDS.upgradeVerifiedMinAgeDays
  ) {
    return "upgrade_verified";
  }
  if (overall >= TRUTH_THRESHOLDS.upgradeOneLevelOverall) {
    return "upgrade_one_level";
  }
  if (
    overall < TRUTH_THRESHOLDS.refuteOverall &&
    input.synapseStats.contradicts >= 1
  ) {
    return "refute";
  }
  return "hold";
}

function buildReasoning(
  input: TruthInput,
  d: Record<TruthDimension, number>,
  overall: number,
  rec: TruthRecommendation,
): string {
  const parts: string[] = [];
  parts.push(`overall=${overall.toFixed(2)}`);
  parts.push(
    `cross=${d.crossContext.toFixed(2)}(${input.engram.domainTags?.length ?? 0}d)`,
  );
  parts.push(`time=${d.timeStable.toFixed(2)}(${input.ageDays}d)`);
  parts.push(
    `mutual=${d.mutuallySupported.toFixed(2)}(e=${input.synapseStats.extends},c=${input.synapseStats.contradicts})`,
  );
  parts.push(`source=${d.sourceReliable.toFixed(2)}`);
  parts.push(`→ ${rec}`);
  return parts.join(" ");
}

function reasoningHold(extra: string): string {
  return `hold (${extra})`;
}

/**
 * 从仓库读取 synapse 统计
 *
 * 简单实现：读 outgoing + incoming（通过遍历所有 engram 的 outgoing 查找指向 engramId 的）。
 * 注意：这是 O(n) 操作,适合 REM 阶段（低频）。
 */
function collectSynapseStats(
  repo: EngramRepository,
  engramId: EngramId,
): {
  extends: number;
  consolidates: number;
  contradicts: number;
  derivesFrom: number;
} {
  const stats = { extends: 0, consolidates: 0, contradicts: 0, derivesFrom: 0 };
  try {
    // 自己的 outgoing
    const own = repo.readSynapses(engramId);
    for (const s of own.outgoing) {
      if (s.kind === "extends") stats.extends += 1;
      else if (s.kind === "consolidates") stats.consolidates += 1;
      else if (s.kind === "contradicts") stats.contradicts += 1;
      else if (s.kind === "derives_from") stats.derivesFrom += 1;
    }
  } catch {
    // engram 可能已被删除
  }

  // incoming：遍历所有 engram 的 outgoing 找指向 engramId 的
  // 注意：这是 O(n),REM 阶段可接受
  try {
    const all = repo.collectAllSynapses();
    for (const { synapse } of all) {
      if (synapse.to !== engramId) continue;
      if (synapse.kind === "extends") stats.extends += 1;
      else if (synapse.kind === "consolidates") stats.consolidates += 1;
      else if (synapse.kind === "contradicts") stats.contradicts += 1;
      else if (synapse.kind === "derives_from") stats.derivesFrom += 1;
    }
  } catch {
    // ignore
  }

  return stats;
}

function computeAgeDays(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  return Math.max(0, (Date.now() - created) / (24 * 60 * 60 * 1000));
}

/** 升级一级：unverified → plausible → probable（已 verified 则无下一级） */
function nextStatusLevel(
  current: VerificationStatus | undefined,
): VerificationStatus | undefined {
  if (current === undefined || current === "unverified") return "plausible";
  if (current === "plausible") return "probable";
  if (current === "probable") return "verified";
  return undefined; // verified 或 refuted,无升级
}

/**
 * 按状态机逐步升级到目标状态
 *
 * canTransition 强制相邻级别,所以 metacognition 一次大跨度升级需要分步。
 * 每步都用 force=true（已通过 metacognition 评分,不再查升级条件）。
 */
function upgradeToTarget(
  repo: EngramRepository,
  engramId: EngramId,
  target: VerificationStatus,
  score: TruthScore,
  ageDays: number,
): { applied: boolean; newStatus: VerificationStatus | undefined } {
  const UPGRADE_PATH: readonly VerificationStatus[] = [
    "plausible",
    "probable",
    "verified",
  ];
  let current = repo.readEngram(engramId).verificationStatus;
  let applied = false;

  for (const step of UPGRADE_PATH) {
    if (current === target) break;
    if (!canTransition(current, step)) break;
    const result = upgradeVerification(
      repo,
      engramId,
      step,
      {
        description: `metacognition_upgrade: overall=${score.overall.toFixed(2)}, ageDays=${ageDays}, step=${step}`,
        verifiedBy: "metacognition",
        confidence: score.overall,
      },
      { force: true },
    );
    if (result.applied) {
      applied = true;
      current = result.newStatus;
    } else {
      break;
    }
  }

  return { applied, newStatus: current };
}
