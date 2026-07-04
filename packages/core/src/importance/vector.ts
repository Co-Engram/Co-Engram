/**
 * 多维重要性（spec §8 字段表：personal/team/project/network/temporal/composite）
 *
 * 五维独立追踪 + composite 加权聚合：
 *   - personal: 个人相关性（手动设置或系统派生）
 *   - team: 团队相关性（手动设置）
 *   - project: 项目相关性（手动设置）
 *   - network: 网络中心性（由 incomingSynapseCount 派生）
 *   - temporal: 时效性（由 lastEffectiveAt + decayHalfLifeDays 派生，艾宾浩斯衰退）
 *   - composite: 加权聚合，写入 engram.importance（检索公式消费此值）
 *
 * 默认权重（spec §9 决策 9 派生）：
 *   personal 0.20 + team 0.25 + project 0.25 + network 0.15 + temporal 0.15 = 1.00
 *
 * 神经科学依据：
 *   - personal/temporal 类似情景记忆（episodic）显著性
 *   - team/project 类似语义记忆（semantic）共识权重
 *   - network 类似突触强度（Hebbian：连接越多越重要）
 *
 * @module @co-engram/core/importance
 */

import type { EngramRepository } from "../storage/repository.js";
import type { ImportanceVector } from "../types/engram.js";
import { recencyDecay } from "../retrieval/scoring.js";
import { effectiveAge } from "../lifecycle/freshness.js";

/** 五维权重（和必须为 1） */
export interface ImportanceWeights {
  readonly personal: number;
  readonly team: number;
  readonly project: number;
  readonly network: number;
  readonly temporal: number;
}

/** 默认权重（spec §9 决策 9 派生） */
export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceWeights = {
  personal: 0.2,
  team: 0.25,
  project: 0.25,
  network: 0.15,
  temporal: 0.15,
};

/** network 派生：incomingSynapseCount ≥ 此阈值时 network=1 */
const NETWORK_SATURATION_INCOMING = 10;

/**
 * 校验权重和为 1（容差 0.001）
 */
export function validateImportanceWeights(w: ImportanceWeights): void {
  const sum = w.personal + w.team + w.project + w.network + w.temporal;
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(
      `Importance weights must sum to 1, got ${sum} (p=${w.personal} t=${w.team} pr=${w.project} n=${w.network} te=${w.temporal})`,
    );
  }
  for (const [name, v] of [
    ["personal", w.personal],
    ["team", w.team],
    ["project", w.project],
    ["network", w.network],
    ["temporal", w.temporal],
  ] as const) {
    if (v < 0 || v > 1) {
      throw new Error(`Importance weight ${name} must be in [0,1], got ${v}`);
    }
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 派生 network 维度（网络中心性）
 *
 * `network = min(1, incomingSynapseCount / SATURATION)`
 *
 * 饱和点默认 10：达到 10 条入边即视为高中心性。
 */
export function deriveNetworkImportance(
  incomingSynapseCount: number,
  saturation = NETWORK_SATURATION_INCOMING,
): number {
  if (saturation <= 0) return 0;
  return clamp01(incomingSynapseCount / saturation);
}

/**
 * 派生 temporal 维度(艾宾浩斯衰退)
 *
 * `temporal = recencyDecay(ageDays, decayHalfLifeDays)`
 *
 * - decayHalfLifeDays=null → 1(永不衰退)
 * - 衰退起点 = `lastEffectiveAt ?? createdAt`:未生效 engram 从创建时间起衰退
 */
export function deriveTemporalImportance(
  lastEffectiveAt: string | null | undefined,
  createdAt: string,
  decayHalfLifeDays: number | null,
  now: Date,
): number {
  const ageDays = effectiveAge(lastEffectiveAt, createdAt, now);
  return recencyDecay(ageDays, decayHalfLifeDays);
}

/**
 * 计算复合重要性
 *
 * `composite = Σ w_i · v_i`（截断到 [0,1]）
 */
export function compositeImportance(
  v: Omit<ImportanceVector, "composite">,
  weights: ImportanceWeights = DEFAULT_IMPORTANCE_WEIGHTS,
): number {
  validateImportanceWeights(weights);
  const raw =
    weights.personal * v.personal +
    weights.team * v.team +
    weights.project * v.project +
    weights.network * v.network +
    weights.temporal * v.temporal;
  return clamp01(raw);
}

/**
 * 构造默认 ImportanceVector（全 0.5 + composite 0.5）
 *
 * 用于未调用 recomputeImportance 的老数据。
 */
export function defaultImportanceVector(): ImportanceVector {
  return {
    personal: 0.5,
    team: 0.5,
    project: 0.5,
    network: 0,
    temporal: 0,
    composite: 0.5,
  };
}

// ============================================================
// 重新计算 + 持久化
// ============================================================

export interface RecomputeImportanceOptions {
  /** 手动覆盖 personal/team/project（network/temporal 永远派生） */
  readonly overrides?: Partial<
    Pick<ImportanceVector, "personal" | "team" | "project">
  >;
  /** 自定义权重（默认 DEFAULT_IMPORTANCE_WEIGHTS） */
  readonly weights?: ImportanceWeights;
  /** 当前时间（测试用，默认 new Date()） */
  readonly now?: Date;
  /** 是否写回 meta.yaml（默认 true） */
  readonly persist?: boolean;
  /** 调用者标识（persist=true 时写入 updatedBy） */
  readonly updatedBy?: string;
}

export interface RecomputeImportanceResult {
  readonly id: string;
  readonly previous: ImportanceVector | undefined;
  readonly next: ImportanceVector;
  readonly previousScalarImportance: number;
  readonly nextScalarImportance: number;
  readonly persisted: boolean;
}

/**
 * 重新计算 engram 的多维重要性
 *
 * 1. 读取当前 engram + 已有 importanceVector（若有）
 * 2. network/temporal 派生（不受 overrides 影响）
 * 3. personal/team/project 用 overrides，否则保留原值或默认 0.5
 * 4. 算 composite
 * 5. 持久化：更新 meta.importanceVector + meta.importance = composite
 */
export function recomputeImportance(
  repo: EngramRepository,
  id: string,
  options: RecomputeImportanceOptions = {},
): RecomputeImportanceResult {
  if (!repo.exists(id)) {
    throw new Error(`Engram not found: ${id}`);
  }
  const engram = repo.readEngram(id);
  const weights = options.weights ?? DEFAULT_IMPORTANCE_WEIGHTS;
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;

  const prevVector = engram.importanceVector;
  const prevScalar = engram.importance;

  const personal = options.overrides?.personal ?? prevVector?.personal ?? 0.5;
  const team = options.overrides?.team ?? prevVector?.team ?? 0.5;
  const project = options.overrides?.project ?? prevVector?.project ?? 0.5;
  const network = deriveNetworkImportance(engram.incomingSynapseCount);
  const temporal = deriveTemporalImportance(
    engram.lastEffectiveAt,
    engram.createdAt,
    engram.decayHalfLifeDays,
    now,
  );

  const composite = compositeImportance(
    { personal, team, project, network, temporal },
    weights,
  );

  const next: ImportanceVector = {
    personal,
    team,
    project,
    network,
    temporal,
    composite,
  };

  if (persist) {
    repo.updateImportanceVector(id, {
      vector: next,
      updatedBy: options.updatedBy ?? "importance-recompute",
    });
  }

  return {
    id,
    previous: prevVector,
    next,
    previousScalarImportance: prevScalar,
    nextScalarImportance: composite,
    persisted: persist,
  };
}

/**
 * 批量重算（Deep Dreaming / 定期任务调用）
 *
 * 稳定扫描：按 id 字典序。
 */
export interface BatchRecomputeResult {
  readonly scanned: number;
  readonly recomputed: number;
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
}

export function recomputeImportanceBatch(
  repo: EngramRepository,
  options: Omit<RecomputeImportanceOptions, "overrides"> & {
    readonly overrides?: (
      engramId: string,
    ) =>
      | Partial<Pick<ImportanceVector, "personal" | "team" | "project">>
      | undefined;
  } = {},
): BatchRecomputeResult {
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;

  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  let scanned = 0;
  let recomputed = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const entry of entries) {
    const engram = repo.readEngram(entry.id);
    if (engram.status !== "active") {
      skipped.push({ id: engram.id, reason: `status=${engram.status}` });
      continue;
    }
    scanned += 1;

    const overrides = options.overrides?.(engram.id);
    try {
      recomputeImportance(repo, engram.id, {
        ...options,
        overrides,
        now,
        persist,
      });
      recomputed += 1;
    } catch (e) {
      skipped.push({
        id: engram.id,
        reason: `failed: ${(e as Error).message}`,
      });
    }
  }

  return { scanned, recomputed, skipped };
}
