/**
 * 闭合学习回路（spec §5.3.5：多巴胺闭环）
 *
 * closeLearningLoop：把使用结果（outcome + effectiveness）反馈到系统：
 *   1. 更新 engram 的 importance / reinforcementScore / failedUses（LTP/LTD）
 *   2. 触发相关 synapse 的 Hebbian 强化（成功时；失败不反向放大）
 *   3. 触发 Provenance 奖惩回路更新（P2 3.7 接口预留）
 *
 * 业务场景：
 *   - agent 使用 engram 后，主动上报 outcome（success/failure/partial）
 *   - 这是"三信号追踪"的天然信号源（retrieved/effective/failed）
 *
 * @module @co-engram/core/learning
 */

import type { EngramRepository } from "../storage/repository.js";
import { recordRetrievalSuccess } from "../reinforcement/ltp.js";
import {
  recordRetrievalFailure,
  DEFAULT_ARCHIVE_THRESHOLD,
  DEFAULT_FORGET_THRESHOLD,
} from "../reinforcement/ltd.js";
import { reinforceRelated } from "../reinforcement/related.js";
import {
  DEFAULT_CONFIG,
  type ReinforcementConfig,
} from "../reinforcement/config.js";

/** 使用结果分类 */
export type LearningOutcome = "success" | "failure" | "partial";

export interface CloseLearningLoopInput {
  readonly engramId: string;
  readonly outcome: LearningOutcome;
  /** 有效性 [0,1]（partial 时必填，success 默认 1，failure 默认 0） */
  readonly effectiveness?: number;
  /** 失败原因（outcome=failure 时建议填写，供审计） */
  readonly reason?: string;
  /** 调用者标识 */
  readonly reportedBy: string;
}

export interface CloseLearningLoopResult {
  readonly engramId: string;
  readonly outcome: LearningOutcome;
  /** LTP/LTD 处理后的 importance */
  readonly importance: number;
  readonly importanceDelta: number;
  readonly reinforcementScore: number;
  readonly failedUses: number;
  readonly effectiveRetrievals: number;
  /** 触发的 Hebbian 邻居强化（仅 success/partial） */
  readonly hebbianReinforcement: {
    readonly triggered: boolean;
    readonly reinforcedNeighborIds: readonly string[];
    readonly skipped: number;
  };
  /** 触发的 Provenance 奖惩（stub，P2 3.7 接入） */
  readonly provenanceUpdate: {
    readonly triggered: boolean;
    readonly message: string;
  };
  /** 是否触发自动降级（failedUses 达阈值） */
  readonly shouldArchive: boolean;
  readonly shouldForget: boolean;
  /** 最终时间戳 */
  readonly reportedAt: string;
}

/**
 * 闭合学习回路
 *
 * 行为分支：
 *   - success (effectiveness 默认 1):
 *       recordRetrievalSuccess → reinforceRelated → provenanceReward
 *   - partial (effectiveness 必填，通常 0.3-0.7):
 *       同 success 但 effectiveness 较低 → 邻居强化按比例衰减
 *   - failure:
 *       recordRetrievalFailure → 不触发 reinforceRelated → provenancePenalty
 *       检查 shouldArchive / shouldForget，但不自动执行（由调用方决定）
 *
 * Provenance 奖惩回路（P2 3.7）：
 *   - 当前为 stub，只返回 triggered 标记
 *   - 实际接入后：找到 engram.createdBy 对应的 source，更新 source.reliability
 */
export function closeLearningLoop(
  repo: EngramRepository,
  input: CloseLearningLoopInput,
  options: {
    readonly config?: ReinforcementConfig;
    readonly archiveThreshold?: number;
    readonly forgetThreshold?: number;
    readonly nowIso?: string;
    /** Provenance 回调（P2 3.7 接入时注入） */
    readonly onProvenanceUpdate?: (
      engramId: string,
      outcome: LearningOutcome,
      effectiveness: number,
    ) => void;
  } = {},
): CloseLearningLoopResult {
  if (!repo.exists(input.engramId)) {
    throw new Error(`Engram not found: ${input.engramId}`);
  }
  const config = options.config ?? DEFAULT_CONFIG;
  const archiveThreshold =
    options.archiveThreshold ?? DEFAULT_ARCHIVE_THRESHOLD;
  const forgetThreshold = options.forgetThreshold ?? DEFAULT_FORGET_THRESHOLD;
  const nowIso = input.reportedBy
    ? (options.nowIso ?? new Date().toISOString())
    : (options.nowIso ?? new Date().toISOString());

  // 根据 outcome 决定 effectiveness
  let effectiveness: number;
  switch (input.outcome) {
    case "success":
      effectiveness = input.effectiveness ?? 1;
      break;
    case "partial":
      effectiveness = input.effectiveness ?? 0.5;
      break;
    case "failure":
      effectiveness = 0;
      break;
  }
  if (effectiveness < 0 || effectiveness > 1) {
    throw new Error(`effectiveness must be in [0,1], got ${effectiveness}`);
  }

  let importanceDelta = 0;
  let shouldArchive = false;
  let shouldForget = false;
  let reinforcedNeighborIds: readonly string[] = [];
  let skipped = 0;

  if (input.outcome === "failure") {
    // === LTD 路径 ===
    const ltdResult = recordRetrievalFailure(
      repo,
      input.engramId,
      config,
      archiveThreshold,
      forgetThreshold,
      nowIso,
    );
    importanceDelta = ltdResult.importanceDelta;
    shouldArchive = ltdResult.shouldArchive;
    shouldForget = ltdResult.shouldForget;
    // 不触发 Hebbian 强化（避免反向放大失败）
  } else {
    // === LTP 路径（success / partial）===
    const ltpResult = recordRetrievalSuccess(
      repo,
      input.engramId,
      effectiveness,
      config,
      nowIso,
    );
    importanceDelta = ltpResult.importanceDelta;

    // Hebbian 邻居强化（仅当 importanceDelta > 0）
    if (importanceDelta > 0) {
      const relatedResult = reinforceRelated(
        repo,
        input.engramId,
        importanceDelta,
        config,
        nowIso,
      );
      reinforcedNeighborIds = relatedResult.reinforcedNeighborIds;
      skipped = relatedResult.skipped;
    }
  }

  // Provenance 奖惩（P2 3.7 stub）
  let provenanceTriggered = false;
  let provenanceMessage = "provenance update not configured";
  if (options.onProvenanceUpdate) {
    options.onProvenanceUpdate(input.engramId, input.outcome, effectiveness);
    provenanceTriggered = true;
    provenanceMessage = `provenance ${input.outcome} signal delivered`;
  }

  const finalEngram = repo.readEngram(input.engramId);

  return {
    engramId: input.engramId,
    outcome: input.outcome,
    importance: finalEngram.importance,
    importanceDelta,
    reinforcementScore: finalEngram.reinforcementScore,
    failedUses: finalEngram.failedUses,
    effectiveRetrievals: finalEngram.effectiveRetrievals,
    hebbianReinforcement: {
      triggered: reinforcedNeighborIds.length > 0,
      reinforcedNeighborIds,
      skipped,
    },
    provenanceUpdate: {
      triggered: provenanceTriggered,
      message: provenanceMessage,
    },
    shouldArchive,
    shouldForget,
    reportedAt: nowIso,
  };
}
