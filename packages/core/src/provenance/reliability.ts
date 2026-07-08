/**
 * Provenance 奖惩回路（spec §3.8 核心创新）
 *
 * 把单条 engram 的三信号追踪聚合到来源（createdBy）级别，形成信用系统：
 *
 *   sourceReliability = Σ effectiveRetrievals / (Σ effectiveRetrievals + Σ failedUses)
 *
 * 关键设计：派生而非存储（零额外字段）。每次需要时从所有 engram 的统计派生。
 *
 * 副作用（落盘时）：
 *   - 低 reliability 来源旗下 engram 的 verificationStatus 降级（默认 → plausible）
 *   - 高 reliability 来源的新 engram 初始 confidence 加成（默认 +0.1）
 *
 * 与 closeLearningLoop 集成：上层在 onProvenanceUpdate 回调中调用 applyProvenanceSignal，
 * 或显式调用本模块独立 API。
 *
 * @module @co-engram/core/provenance
 */

import type { EngramRepository } from "../storage/repository.js";
import type { VerificationStatus } from "../types/engram.js";
import type { LearningOutcome } from "../learning/loop.js";

/** 单来源 reliability 派生结果 */
export interface SourceReliability {
  readonly createdBy: string;
  /** 该来源所有 engram 的 effectiveRetrievals 累加 */
  readonly totalEffective: number;
  /** 该来源所有 engram 的 failedUses 累加 */
  readonly totalFailed: number;
  /** 该来源所有 engram 的 retrievalCount 累加（包含 partial 等） */
  readonly totalRetrievals: number;
  /** 该来源的 engram 数量 */
  readonly engramCount: number;
  /** reliability ∈ [0,1]，无样本时返回 0.5（中性） */
  readonly reliability: number;
}

/** Provenance 配置 */
export interface ProvenanceConfig {
  /** reliability < 此值 → 标记为低信用（默认 0.4） */
  readonly lowReliabilityThreshold: number;
  /** reliability > 此值 → 标记为高信用（默认 0.8） */
  readonly highReliabilityThreshold: number;
  /** 高信用来源新 engram 的 confidence 加成（默认 0.1，上限 1.0） */
  readonly confidenceBoost: number;
  /** 样本量下限：effectiveRetrievals + failedUses < 此值时不评判（默认 3） */
  readonly minSampleSize: number;
  /** 低信用来源旗下 engram 的 verificationStatus 降级目标（默认 'plausible'） */
  readonly flaggedVerificationStatus: VerificationStatus;
}

export const DEFAULT_PROVENANCE_CONFIG: ProvenanceConfig = {
  lowReliabilityThreshold: 0.4,
  highReliabilityThreshold: 0.8,
  confidenceBoost: 0.1,
  minSampleSize: 3,
  flaggedVerificationStatus: "plausible",
};

/** Provenance 信号处理结果 */
export interface ProvenanceSignalResult {
  readonly engramId: string;
  readonly createdBy: string;
  readonly outcome: LearningOutcome;
  readonly effectiveness: number;
  /** 信号处理后的 reliability 快照（不是 before，因为派生只读当前状态） */
  readonly reliability: SourceReliability;
  /** reliability 是否跨越低信用阈值 */
  readonly isLowReliability: boolean;
  /** reliability 是否跨越高信用阈值 */
  readonly isHighReliability: boolean;
  /** 是否因为样本不足跳过判定 */
  readonly insufficientSamples: boolean;
}

/** 批量标记结果 */
export interface FlagLowReliabilityResult {
  readonly flagged: ReadonlyArray<{
    readonly createdBy: string;
    readonly reliability: number;
    readonly engramIds: readonly string[];
  }>;
  readonly persisted: boolean;
}

/**
 * 派生单个来源的 reliability
 *
 * 实现细节：扫描所有 engram，过滤 createdBy 匹配的，累加三信号。
 * 无样本时 reliability = 0.5（中性，避免一上来就被标记为低信用）。
 */
export function deriveSourceReliability(
  repo: EngramRepository,
  createdBy: string,
): SourceReliability | null {
  const entries = repo.listEngrams();
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const allIds = entries.map((e) => e.id);
  const digests = repo.readDigestBatch(allIds);

  let totalEffective = 0;
  let totalFailed = 0;
  let totalRetrievals = 0;
  let engramCount = 0;

  for (const digest of digests) {
    if (digest.createdBy !== createdBy) continue;
    totalEffective += digest.effectiveRetrievals;
    totalFailed += digest.failedUses;
    totalRetrievals += digest.retrievalCount;
    engramCount += 1;
  }

  if (engramCount === 0) return null;

  const sampleSize = totalEffective + totalFailed;
  const reliability = sampleSize === 0 ? 0.5 : totalEffective / sampleSize;

  return {
    createdBy,
    totalEffective,
    totalFailed,
    totalRetrievals,
    engramCount,
    reliability,
  };
}

/**
 * 派生所有来源的 reliability
 *
 * 返回按 reliability 升序排序（最低信用在前，便于优先标记）。
 *
 * 性能(2026-07 修复):原实现遍历每个 creator 调用 deriveSourceReliability,
 * 每次都 readDigestBatch 全量。M 个 creator × N 个 engram = M×N 次扫描。
 * 现按 createdBy 分组一次扫描,内联累加,O(N) 总成本。
 */
export function deriveAllSourceReliability(
  repo: EngramRepository,
): SourceReliability[] {
  const entries = repo.listEngrams();
  const allIds = entries.map((e) => e.id);
  const digests = repo.readDigestBatch(allIds);

  const byCreator = new Map<
    string,
    {
      totalEffective: number;
      totalFailed: number;
      totalRetrievals: number;
      engramCount: number;
    }
  >();

  for (const digest of digests) {
    const entry = byCreator.get(digest.createdBy) ?? {
      totalEffective: 0,
      totalFailed: 0,
      totalRetrievals: 0,
      engramCount: 0,
    };
    entry.totalEffective += digest.effectiveRetrievals;
    entry.totalFailed += digest.failedUses;
    entry.totalRetrievals += digest.retrievalCount;
    entry.engramCount += 1;
    byCreator.set(digest.createdBy, entry);
  }

  const result: SourceReliability[] = [];
  for (const [createdBy, stats] of byCreator) {
    const sampleSize = stats.totalEffective + stats.totalFailed;
    const reliability =
      sampleSize === 0 ? 0.5 : stats.totalEffective / sampleSize;
    result.push({
      createdBy,
      totalEffective: stats.totalEffective,
      totalFailed: stats.totalFailed,
      totalRetrievals: stats.totalRetrievals,
      engramCount: stats.engramCount,
      reliability,
    });
  }

  result.sort((a, b) => {
    if (a.reliability !== b.reliability) return a.reliability - b.reliability;
    return a.createdBy < b.createdBy ? -1 : 1;
  });
  return result;
}

/**
 * 判定 reliability 是否为低/高信用
 *
 * 样本不足时一律不评判（避免新来源被误判）。
 */
export function classifyReliability(
  reliability: SourceReliability,
  config: ProvenanceConfig = DEFAULT_PROVENANCE_CONFIG,
): { isLow: boolean; isHigh: boolean; insufficient: boolean } {
  const sample = reliability.totalEffective + reliability.totalFailed;
  if (sample < config.minSampleSize) {
    return { isLow: false, isHigh: false, insufficient: true };
  }
  return {
    isLow: reliability.reliability < config.lowReliabilityThreshold,
    isHigh: reliability.reliability >= config.highReliabilityThreshold,
    insufficient: false,
  };
}

/**
 * Provenance 奖惩钩子
 *
 * 从 engramId 解析 createdBy，派生当前 reliability，返回信号快照。
 *
 * 注意：reliability 本身是派生的，三信号已经在 closeLearningLoop 的 LTP/LTD 阶段
 * 更新到 engram 上，所以本函数只做"读取 + 分类"，不写盘。
 *
 * 副作用（如 verificationStatus 降级）通过 flagLowReliabilitySources 显式触发。
 */
export function applyProvenanceSignal(
  repo: EngramRepository,
  engramId: string,
  outcome: LearningOutcome,
  effectiveness: number,
  options: { config?: Partial<ProvenanceConfig> } = {},
): ProvenanceSignalResult {
  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }
  const cfg: ProvenanceConfig = {
    ...DEFAULT_PROVENANCE_CONFIG,
    ...options.config,
  };
  const engram = repo.readEngram(engramId);
  const reliability = deriveSourceReliability(repo, engram.createdBy)!;
  const cls = classifyReliability(reliability, cfg);

  return {
    engramId,
    createdBy: engram.createdBy,
    outcome,
    effectiveness,
    reliability,
    isLowReliability: cls.isLow,
    isHighReliability: cls.isHigh,
    insufficientSamples: cls.insufficient,
  };
}

/**
 * 扫描所有来源，把低 reliability 来源旗下 engram 的 verificationStatus 降级
 *
 * 默认目标状态：plausible（spec §3.8：触发反思或标记为"不可信来源"）。
 * 已是 refuted 的不升回 plausible（避免覆盖人工裁决）。
 *
 * @param persist true 则写盘 verificationStatus；false 只返回计算结果
 */
export function flagLowReliabilitySources(
  repo: EngramRepository,
  options: {
    config?: Partial<ProvenanceConfig>;
    persist?: boolean;
  } = {},
): FlagLowReliabilityResult {
  const cfg: ProvenanceConfig = {
    ...DEFAULT_PROVENANCE_CONFIG,
    ...options.config,
  };
  const persist = options.persist ?? true;

  const all = deriveAllSourceReliability(repo);
  const flagged: Array<{
    createdBy: string;
    reliability: number;
    engramIds: string[];
  }> = [];

  // 性能修复(2026-07):预取 digest 一次,避免下方 for-source × for-entry 双层
  // 循环里反复 readEngram(原实现 O(|sources| × N))
  const allEntries = repo.listEngrams();
  const allIds = allEntries.map((e) => e.id);
  const digests = repo.readDigestBatch(allIds);

  for (const source of all) {
    const cls = classifyReliability(source, cfg);
    if (!cls.isLow) continue;

    const engramIds: string[] = [];
    for (const digest of digests) {
      if (digest.createdBy !== source.createdBy) continue;
      // 已 refuted 的不覆盖（保留人工裁决）
      if (digest.verificationStatus === "refuted") {
        engramIds.push(digest.id);
        continue;
      }
      // 已是目标状态的不重复写盘
      if (digest.verificationStatus === cfg.flaggedVerificationStatus) {
        engramIds.push(digest.id);
        continue;
      }
      if (persist) {
        repo.updateVerificationStatus(digest.id, cfg.flaggedVerificationStatus);
      }
      engramIds.push(digest.id);
    }

    if (engramIds.length > 0) {
      flagged.push({
        createdBy: source.createdBy,
        reliability: source.reliability,
        engramIds,
      });
    }
  }

  return { flagged, persisted: persist };
}

/**
 * 计算高 reliability 来源新 engram 的初始 confidence 加成
 *
 * 用法：engram_create 时，先按 sourceType 默认 confidence 生成 base，
 * 再调用本函数：如果 createdBy reliability 高，返回 min(1.0, base + boost)。
 *
 * @returns 调整后的 confidence ∈ [0,1]
 */
export function computeInitialConfidence(
  repo: EngramRepository,
  createdBy: string,
  baseConfidence: number,
  options: { config?: Partial<ProvenanceConfig> } = {},
): number {
  const cfg: ProvenanceConfig = {
    ...DEFAULT_PROVENANCE_CONFIG,
    ...options.config,
  };
  const reliability = deriveSourceReliability(repo, createdBy);
  if (!reliability) return clamp01(baseConfidence);

  const cls = classifyReliability(reliability, cfg);
  if (!cls.isHigh) return clamp01(baseConfidence);

  return clamp01(baseConfidence + cfg.confidenceBoost);
}

/** 数值截断到 [0,1] */
function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
