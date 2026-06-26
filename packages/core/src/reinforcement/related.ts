/**
 * Hebbian 关联强化
 *
 * 神经科学依据："一起激活的神经元连接增强"（Hebb, 1949）。
 * 业务含义：engram A 被有效强化时，与 A 相连的邻居 engram 也得到部分增益。
 *
 * 策略：
 *   - 沿 outgoing/incoming synapse 找邻居
 *   - 每个邻居得到 importanceDelta × hebbianRatio（默认 0.5）
 *   - 排除 contradicts（矛盾邻居不强化）
 *   - 跳过 archived/forgotten（生命周期已结束的不强化）
 *
 * 与 ltp.ts 的关系：
 *   - ltp.recordRetrievalSuccess：直接强化单个 engram
 *   - related.reinforceRelated：触发 ltp 后，对邻居做 reinforceEngram（不更新统计）
 *
 * @module @co-engram/core/reinforcement
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SynapseKind } from "../types/synapse.js";
import { DEFAULT_CONFIG, type ReinforcementConfig } from "./config.js";
import { reinforceEngram } from "./ltp.js"; // 无循环依赖：ltp.ts 不 import related.ts

/** 不应该被强化的 synapse 类型（矛盾关系） */
const NEGATIVE_KINDS: ReadonlySet<SynapseKind> = new Set<SynapseKind>([
  "contradicts",
]);

export interface ReinforceRelatedResult {
  /** 被强化的邻居 id 列表 */
  readonly reinforcedNeighborIds: readonly string[];
  /** 跳过的邻居数（contradicts / archived / 不存在） */
  readonly skipped: number;
  /** 给每个邻居的 importanceDelta */
  readonly importanceDeltaPerNeighbor: number;
}

/**
 * 对邻居执行 Hebbian 强化
 *
 * @param repo - 仓库
 * @param engramId - 触发强化的 engram id
 * @param baseImportanceDelta - 原始 engram 得到的 importanceDelta
 * @param config - 配置（可选）
 * @param nowIso - 当前时间
 */
export function reinforceRelated(
  repo: EngramRepository,
  engramId: string,
  baseImportanceDelta: number,
  config: ReinforcementConfig = DEFAULT_CONFIG,
  nowIso: string = new Date().toISOString(),
): ReinforceRelatedResult {
  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }
  if (baseImportanceDelta < 0) {
    // LTD 不应触发 Hebbian 强化（避免反向放大失败）
    return {
      reinforcedNeighborIds: [],
      skipped: 0,
      importanceDeltaPerNeighbor: 0,
    };
  }
  const neighborDelta = baseImportanceDelta * config.hebbianRatio;
  if (neighborDelta <= 0) {
    return {
      reinforcedNeighborIds: [],
      skipped: 0,
      importanceDeltaPerNeighbor: 0,
    };
  }

  // 收集 outgoing + incoming 邻居
  const all = repo.collectAllSynapses();
  const neighborIds = new Set<string>();
  let skipped = 0;

  for (const { fromId, synapse } of all) {
    if (NEGATIVE_KINDS.has(synapse.kind)) {
      skipped += 1;
      continue;
    }
    if (fromId === engramId) {
      // 我是 from，邻居是 to
      neighborIds.add(synapse.to);
    } else if (synapse.to === engramId) {
      // 我是 to，邻居是 from
      neighborIds.add(fromId);
    }
  }

  const reinforced: string[] = [];
  for (const neighborId of neighborIds) {
    if (!repo.exists(neighborId)) {
      skipped += 1;
      continue;
    }
    const neighbor = repo.readEngram(neighborId);
    if (neighbor.status === "archived" || neighbor.status === "forgotten") {
      skipped += 1;
      continue;
    }
    reinforceEngram(repo, neighborId, neighborDelta, nowIso);
    reinforced.push(neighborId);
  }

  return {
    reinforcedNeighborIds: reinforced,
    skipped,
    importanceDeltaPerNeighbor: neighborDelta,
  };
}
