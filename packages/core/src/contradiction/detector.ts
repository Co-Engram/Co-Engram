/**
 * Contradiction Detector（spec §3.9）
 *
 * 扫描所有 contradicts synapse，列出需要裁决的矛盾对。
 *
 * @module @co-engram/core/contradiction
 */

import type { EngramRepository } from "../storage/repository.js";
import type { ContradictionPair } from "./types.js";

/**
 * 扫描所有 contradicts synapse
 *
 * 稳定排序：按 (fromId, toId, synapseId) 字典序
 *
 * @param options.filterStatus - 仅返回指定状态的（默认全部）
 */
export function detectContradictions(
  repo: EngramRepository,
  options: {
    readonly filterStatus?: ContradictionPair["status"];
  } = {},
): readonly ContradictionPair[] {
  const all = repo.collectAllSynapses();
  const result: ContradictionPair[] = [];

  for (const { fromId, synapse } of all) {
    if (synapse.kind !== "contradicts") continue;
    const status = synapse.resolutionState?.status ?? "none";
    if (options.filterStatus !== undefined && status !== options.filterStatus) {
      continue;
    }
    result.push({
      synapseId: synapse.id,
      fromId,
      toId: synapse.to,
      weight: synapse.weight,
      status,
    });
  }

  return result.sort((a, b) => {
    if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    return a.synapseId < b.synapseId ? -1 : 1;
  });
}

/**
 * 统计当前 contradiction 概况
 */
export interface ContradictionStats {
  readonly total: number;
  readonly pending: number;
  readonly autoResolved: number;
  readonly escalated: number;
  readonly contested: number;
  readonly resolved: number;
  readonly none: number;
}

export function statsContradictions(
  repo: EngramRepository,
): ContradictionStats {
  const all = detectContradictions(repo);
  const stats: {
    total: number;
    pending: number;
    autoResolved: number;
    escalated: number;
    contested: number;
    resolved: number;
    none: number;
  } = {
    total: all.length,
    pending: 0,
    autoResolved: 0,
    escalated: 0,
    contested: 0,
    resolved: 0,
    none: 0,
  };
  for (const c of all) {
    switch (c.status) {
      case "pending":
        stats.pending++;
        break;
      case "auto_resolved":
        stats.autoResolved++;
        break;
      case "escalated":
        stats.escalated++;
        break;
      case "contested":
        stats.contested++;
        break;
      case "resolved":
        stats.resolved++;
        break;
      case "none":
        stats.none++;
        break;
    }
  }
  return stats;
}
