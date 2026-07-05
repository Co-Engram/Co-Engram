/**
 * LTD（Long-Term Depression）- 失败使用削弱
 *
 * 神经科学依据：海马 LTD，长期不被激活或激活后失败的突触削弱。
 * 业务含义：engram 被使用但失败 → importance 削弱。
 *
 * 触发场景：
 *   - 工具调用基于该 engram 后出错
 *   - LLM 引用后被指正
 *   - engram 内容与实际情况冲突
 *
 * 实现(importance 增量由 `importance/dynamics.ts` 单一来源计算):
 *   - failedUses += 1
 *   - retrievalCount += 1
 *   - importance = dynamics.updateOnReportFailure(current)(clamp [0,1])
 *
 * 触发降级条件（外层调用方判断）：
 *   - failedUses >= archiveThreshold(默认 3)→ 自动 archive
 *   - failedUses >= forgetThreshold(默认 5)→ 自动 forget
 *
 * D1 之后:删除 escalation 倍率机制 —— 单次惩罚固定为 dynamics.FAILURE_LOSS
 * (默认 0.1),不再随失败次数放大。
 *
 * @module @co-engram/core/reinforcement
 */

import type { EngramRepository } from "../storage/repository.js";
import type { Engram } from "../types/engram.js";
import { updateOnReportFailure } from "../importance/dynamics.js";
import { DEFAULT_CONFIG, type ReinforcementConfig } from "./config.js";

export interface LtdResult {
  readonly id: string;
  readonly importanceDelta: number; // 负数
  readonly importance: number;
  readonly failedUses: number;
  readonly retrievalCount: number;
  /** 是否触发降级建议（failedUses 达到阈值） */
  readonly shouldArchive: boolean;
  readonly shouldForget: boolean;
}

/**
 * 记录一次失败使用（LTD 削弱）
 *
 * importance 削弱规则(D1):固定调用 `dynamics.updateOnReportFailure`,
 * 单次 penalty = FAILURE_LOSS(默认 0.1),不再有 escalation 倍率。
 *
 * @param repo - 仓库
 * @param id - 目标 engram id
 * @param config - 配置(可选,提供 archiveThreshold / forgetThreshold)
 * @param archiveThreshold - 触发 archive 的 failedUses 阈值(覆盖 config)
 * @param forgetThreshold - 触发 forget 的 failedUses 阈值(覆盖 config)
 * @param nowIso - 当前时间
 */
export function recordRetrievalFailure(
  repo: EngramRepository,
  id: string,
  config: ReinforcementConfig = DEFAULT_CONFIG,
  archiveThreshold: number = config.archiveThreshold,
  forgetThreshold: number = config.forgetThreshold,
  nowIso: string = new Date().toISOString(),
): LtdResult {
  if (!repo.exists(id)) {
    throw new Error(`Engram not found: ${id}`);
  }
  if (archiveThreshold < 1 || forgetThreshold < archiveThreshold) {
    throw new Error(
      `thresholds invalid: archive=${archiveThreshold}, forget=${forgetThreshold}`,
    );
  }

  const before = repo.readEngram(id);
  const next = updateOnReportFailure(before.importance);
  const delta = next - before.importance; // 负数

  repo.bumpRetrievalStats(id, {
    retrievedDelta: 1,
    failedDelta: 1,
    importanceDelta: delta,
    lastRetrievedAt: nowIso,
  });

  const updated = repo.readEngram(id);
  return {
    id,
    importanceDelta: delta,
    importance: updated.importance,
    failedUses: updated.failedUses,
    retrievalCount: updated.retrievalCount,
    shouldArchive: updated.failedUses >= archiveThreshold,
    shouldForget: updated.failedUses >= forgetThreshold,
  };
}

/**
 * 计算失败 N 次后的预期 importance（不写盘）
 * D1 之后:循环调 `dynamics.updateOnReportFailure`,与实际写入路径一致。
 */
export function projectImportanceAfterFailures(
  engram: Engram,
  times: number,
  _config: ReinforcementConfig = DEFAULT_CONFIG,
): number {
  let importance = engram.importance;
  for (let i = 0; i < times; i++) {
    importance = updateOnReportFailure(importance);
    if (importance <= 0) return 0;
  }
  return Math.max(0, importance);
}

/** 默认降级阈值(等价于 DEFAULT_CONFIG.archiveThreshold,保留 export 以兼容现有 import) */
export const DEFAULT_ARCHIVE_THRESHOLD = DEFAULT_CONFIG.archiveThreshold;
export const DEFAULT_FORGET_THRESHOLD = DEFAULT_CONFIG.forgetThreshold;
