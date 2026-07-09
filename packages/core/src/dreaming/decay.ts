/**
 * 艾宾浩斯衰减批量应用（Deep Dreaming 的一部分）
 *
 * 神经科学依据：记忆痕迹随时间衰退，需通过再激活维持；
 * 长期未强化且低重要性的 engram 进入归档/遗忘。
 *
 * 规则（spec §5.2 + §6.2）：
 *   - freshness=forgotten → 直接 forget
 *   - freshness=stale 且 importance < forgetImportanceThreshold → forget
 *   - freshness=stale 且 importance ≥ 阈值 → archive（保留可恢复）
 *   - freshness=aging/fresh → 不动
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramFreshness, EngramStatus } from "../types/engram.js";
import type { EngramRepository } from "../storage/repository.js";
import { computeFreshness } from "../lifecycle/freshness.js";

export interface DecayOptions {
  /**
   * 当 freshness=stale 时，importance 低于此值 → forget；否则 archive。
   * 默认 0.2。
   */
  readonly forgetImportanceThreshold?: number;
  /** 当前时间（测试用），默认 new Date() */
  readonly nowIso?: string;
  /** 只读模式：只计算不落盘 */
  readonly dryRun?: boolean;
}

export interface DecayResult {
  /** 扫描的 active engram 数 */
  readonly scanned: number;
  /** 被遗忘的 engram id 列表 */
  readonly forgotten: string[];
  /** 被归档的 engram id 列表 */
  readonly archived: string[];
  /** 按 freshness 统计（扫描时计算，不含后续变更） */
  readonly byFreshness: Record<EngramFreshness, number>;
}

/** 默认遗忘重要性阈值（spec §6.2 + 经验值） */
export const DEFAULT_FORGET_IMPORTANCE_THRESHOLD = 0.2;

/**
 * 批量应用艾宾浩斯衰减
 *
 * 只处理 status=active 的 engram；已经是 archived/forgotten 的跳过。
 */
export function applyDecayBatch(
  repo: EngramRepository,
  options: DecayOptions = {},
): DecayResult {
  const forgetThreshold =
    options.forgetImportanceThreshold ?? DEFAULT_FORGET_IMPORTANCE_THRESHOLD;
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const dryRun = options.dryRun ?? false;

  const byFreshness: Record<EngramFreshness, number> = {
    fresh: 0,
    aging: 0,
    stale: 0,
    forgotten: 0,
  };

  const forgotten: string[] = [];
  const archived: string[] = [];

  // 按 id 字典序稳定扫描
  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  // 批量预取 digest(含 status/lastEffectiveAt/createdAt/importance)
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );

  let scanned = 0;
  for (const entry of entries) {
    const digest = digestById.get(entry.id);
    if (!digest) continue;
    if (digest.status !== "active") continue;
    scanned += 1;

    const freshness = computeFreshness(
      digest.lastEffectiveAt,
      digest.createdAt,
      digest.importance,
      now,
    );
    byFreshness[freshness] += 1;

    if (freshness === "forgotten") {
      forgotten.push(digest.id);
      if (!dryRun) {
        repo.updateLifecycle(
          digest.id,
          "forgotten" satisfies EngramStatus,
          freshness,
        );
      }
      continue;
    }

    if (freshness === "stale") {
      if (digest.importance < forgetThreshold) {
        forgotten.push(digest.id);
        if (!dryRun) {
          repo.updateLifecycle(
            digest.id,
            "forgotten" satisfies EngramStatus,
            freshness,
          );
        }
      } else {
        archived.push(digest.id);
        if (!dryRun) {
          repo.updateLifecycle(
            digest.id,
            "frozen" satisfies EngramStatus,
            freshness,
          );
        }
      }
    }
  }

  return { scanned, forgotten, archived, byFreshness };
}
