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
import type { AuditLog } from "../observability/audit-log.js";
import { recordRetrievalSuccess } from "../reinforcement/ltp.js";
import {
  recordRetrievalFailure,
  DEFAULT_ARCHIVE_THRESHOLD,
  DEFAULT_FORGET_THRESHOLD,
} from "../reinforcement/ltd.js";
import { reinforceRelated } from "../reinforcement/related.js";
import { safeEmit } from "../prompt-signals/event-bus.js";
import {
  DEFAULT_CONFIG,
  type ReinforcementConfig,
} from "../reinforcement/config.js";
import { notFoundError, validationError } from "../tools/error-schema.js";

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
    /**
     * P0-1 修复:auditLog 注入。若提供,则:
     *   - 写 learning_loop_{success/partial/failure} audit(此前完全不写)
     *   - 透传给 reinforceRelated,让邻居联动也写 reinforce audit(P0-9)
     */
    readonly auditLog?: AuditLog;
    /** 宿主标识(透传到 audit entry) */
    readonly host?: "claude-code-mcp" | "openclaw-plugin" | string;
  } = {},
): CloseLearningLoopResult {
  if (!repo.exists(input.engramId)) {
    throw notFoundError("Engram", input.engramId);
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
    throw validationError(`effectiveness must be in [0,1], got ${effectiveness}`);
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
        {
          // P0-9 修复:透传 auditLog + triggeredBy,让邻居联动可观察
          auditLog: options.auditLog,
          triggeredBy: input.engramId,
          triggerTool: "close_learning_loop",
          host: options.host,
        },
      );
      reinforcedNeighborIds = relatedResult.reinforcedNeighborIds;
      skipped = relatedResult.skipped;
    }
  }

  // P0-1 修复:写 close_learning_loop 事件 audit(此前完全不写)
  // 用 outcome 区分 success/partial/failure,让 audit lifecycle 完整可追溯
  if (options.auditLog) {
    options.auditLog.append({
      actor: "user",
      action:
        input.outcome === "success"
          ? "learning_loop_success"
          : input.outcome === "partial"
            ? "learning_loop_partial"
            : "learning_loop_failure",
      engramId: input.engramId,
      host: options.host,
      metadata: {
        outcome: input.outcome,
        effectiveness,
        importanceDelta,
        reportedBy: input.reportedBy,
        reason: input.reason,
        shouldArchive,
        shouldForget,
        hebbianTriggered: reinforcedNeighborIds.length > 0,
        reinforcedNeighborIds,
      },
    });
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

  // Task 3.4 Phase B:闭合学习回路是 prompt-signals 的关键触发点——
  // success/partial → engram_reinforced;failure → engram_failed
  // (R13 实证:用户刚 confirm 的记忆,prompt 没反应,因为 prompt-builder
  // 注册时固定了 snapshot,要等 maintenance light stage 才刷新)
  safeEmit({
    type:
      input.outcome === "failure" ? "engram_failed" : "engram_reinforced",
    engramId: input.engramId,
    at: nowIso,
  });

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
