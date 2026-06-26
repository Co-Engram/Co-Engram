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
 * 实现：
 *   - failedUses += 1
 *   - retrievalCount += 1
 *   - importance -= ltdPenalty × escalationFactor
 *     · escalationFactor：失败累积 ≥ failureThreshold 后按 failureEscalation 倍增
 *
 * 触发降级条件（外层调用方判断）：
 *   - failedUses >= 阈值（如 3）→ 自动 archive
 *   - failedUses >= 高阈值（如 5）→ 自动 forget
 *
 * @module @co-engram/core/reinforcement
 */

import type { EngramRepository } from "../storage/repository.js";
import type { Engram } from "../types/engram.js";
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

/** 默认降级阈值（失败次数达到即触发） */
export const DEFAULT_ARCHIVE_THRESHOLD = 3;
export const DEFAULT_FORGET_THRESHOLD = 5;

/**
 * 记录一次失败使用（LTD 削弱）
 *
 * importance 削弱规则：
 *   - failedUses < failureThreshold：penalty = ltdPenalty
 *   - failedUses >= failureThreshold：penalty = ltdPenalty × failureEscalation
 *
 * @param repo - 仓库
 * @param id - 目标 engram id
 * @param config - 配置（可选）
 * @param archiveThreshold - 触发 archive 的 failedUses 阈值（默认 3）
 * @param forgetThreshold - 触发 forget 的 failedUses 阈值（默认 5）
 * @param nowIso - 当前时间
 */
export function recordRetrievalFailure(
  repo: EngramRepository,
  id: string,
  config: ReinforcementConfig = DEFAULT_CONFIG,
  archiveThreshold: number = DEFAULT_ARCHIVE_THRESHOLD,
  forgetThreshold: number = DEFAULT_FORGET_THRESHOLD,
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
  const newFailedUses = before.failedUses + 1;
  const isEscalated = newFailedUses >= config.failureThreshold;
  const penalty = isEscalated
    ? config.ltdPenalty * config.failureEscalation
    : config.ltdPenalty;

  repo.bumpRetrievalStats(id, {
    retrievedDelta: 1,
    failedDelta: 1,
    importanceDelta: -penalty,
    lastRetrievedAt: nowIso,
  });

  const updated = repo.readEngram(id);
  return {
    id,
    importanceDelta: -penalty,
    importance: updated.importance,
    failedUses: updated.failedUses,
    retrievalCount: updated.retrievalCount,
    shouldArchive: updated.failedUses >= archiveThreshold,
    shouldForget: updated.failedUses >= forgetThreshold,
  };
}

/**
 * 计算失败 N 次后的预期 importance（不写盘）
 */
export function projectImportanceAfterFailures(
  engram: Engram,
  times: number,
  config: ReinforcementConfig = DEFAULT_CONFIG,
): number {
  let importance = engram.importance;
  let failedUses = engram.failedUses;
  for (let i = 0; i < times; i++) {
    failedUses += 1;
    const isEscalated = failedUses >= config.failureThreshold;
    const penalty = isEscalated
      ? config.ltdPenalty * config.failureEscalation
      : config.ltdPenalty;
    importance -= penalty;
    if (importance <= 0) return 0;
  }
  return Math.max(0, importance);
}
