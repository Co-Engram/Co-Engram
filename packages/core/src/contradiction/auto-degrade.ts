/**
 * Contradiction Auto-Degrade（spec §3.9 阶段 3）
 *
 * 扫描所有 escalated 状态的 contradicts synapse，超过 expiresAt 的降级为 contested。
 * 检索时附带警告（由检索路径读取 resolutionState 实现）。
 *
 * @module @co-engram/core/contradiction
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SynapseResolutionState } from "../types/synapse.js";
import type { AuditLog } from "../observability/audit-log.js";
import { detectContradictions } from "./detector.js";
import {
  notFoundError,
  validationError,
} from "../tools/error-schema.js";

export interface AutoDegradeResult {
  readonly scanned: number;
  readonly degraded: ReadonlyArray<{
    readonly fromId: string;
    readonly synapseId: string;
    readonly toId: string;
    readonly expiredAt: string;
  }>;
}

/**
 * 处理所有超时的 escalated 矛盾
 *
 * 流程：
 *   1. 扫描 escalated 状态的 contradicts
 *   2. 检查 expiresAt 是否已过
 *   3. 标记为 contested（phase=3）
 *
 * 稳定扫描：按 (fromId, synapseId) 字典序
 */
export function processExpiredContradictions(
  repo: EngramRepository,
  options: { now?: Date; persist?: boolean } = {},
): AutoDegradeResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const persist = options.persist ?? true;

  const escalated = detectContradictions(repo, { filterStatus: "escalated" });
  const degraded: Array<{
    fromId: string;
    synapseId: string;
    toId: string;
    expiredAt: string;
  }> = [];

  for (const c of escalated) {
    const file = repo.readSynapses(c.fromId);
    const synapse = file.outgoing.find((s) => s.id === c.synapseId);
    if (!synapse?.resolutionState) continue;

    const expiresAt = synapse.resolutionState.expiresAt;
    if (!expiresAt) continue;
    const expMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expMs) || expMs > nowMs) continue;

    const nextState: SynapseResolutionState = {
      ...synapse.resolutionState,
      status: "contested",
      phase: 3,
    };

    if (persist) {
      repo.updateSynapseResolution(c.fromId, c.synapseId, nextState);
    }

    degraded.push({
      fromId: c.fromId,
      synapseId: c.synapseId,
      toId: c.toId,
      expiredAt: expiresAt,
    });
  }

  return { scanned: escalated.length, degraded };
}

/**
 * 人工解决矛盾（阶段 2 → resolved）
 *
 * 用于人工 finally 决定一个 escalated 矛盾。
 */
export interface ManualResolveInput {
  readonly fromId: string;
  readonly synapseId: string;
  readonly verdict: "keep_new" | "keep_old" | "merge" | "archive";
  readonly rationale: string;
  readonly resolvedBy: string;
}

export function manualResolveContradiction(
  repo: EngramRepository,
  input: ManualResolveInput,
  options: {
    readonly now?: Date;
    readonly persist?: boolean;
    /**
     * P0-5 修复:auditLog 注入。若提供,则写 merge_resolved audit(此前 enum 有值
     * 但代码从不调用)。让"谁在什么时候基于什么 rationale 把哪条 engram 判定
     * 为 superseded"完整可追溯 —— 这是 co-engram 最重要的决策类型审计。
     */
    readonly auditLog?: AuditLog;
    /** 宿主标识(透传到 audit entry) */
    readonly host?: "claude-code-mcp" | "openclaw-plugin" | string;
    /**
     * supersedes 自动提议(2026-08-16 突触类型失衡修复):verdict 为
     * keep_old / keep_new 时,胜者→被替代者的 supersedes 关系已被裁决确认,
     * 但此前只写 audit metadata 不落图 —— 时间族突触因此恒 0(系统已在
     * 语义上识别「替代」,只是不写进图)。现经 rem-synapse 提案落图,
     * 用户审批后生效(与 REM 审批化架构一致,不直接写)。
     * merge / archive 语义不同(合并/归档 ≠ 替代),不提议。
     */
    readonly proposalEngine?: {
      proposeSynapseOp(input: {
        readonly op: "add" | "delete" | "retype";
        readonly from: string;
        readonly to: string;
        readonly kind: import("../types/synapse.js").SynapseKind;
        readonly reason: string;
        readonly confidence: number;
        readonly fromTitle?: string;
        readonly toTitle?: string;
      }): boolean;
    };
  } = {},
): { resolved: boolean; finalStatus: SynapseResolutionState["status"] } {
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;
  const nowIso = now.toISOString();

  const file = repo.readSynapses(input.fromId);
  const synapse = file.outgoing.find((s) => s.id === input.synapseId);
  if (!synapse) {
    throw notFoundError(
      "Synapse",
      `${input.fromId}/${input.synapseId}`,
      `Use synapse_list on engram ${input.fromId} to enumerate its synapses.`,
    );
  }
  if (synapse.kind !== "contradicts") {
    throw validationError(
      `Not a contradicts synapse: ${input.synapseId} (kind=${synapse.kind})`,
      {
        suggestion:
          "auto_degrade requires a synapse with kind='contradicts'.",
        resourceId: input.synapseId,
      },
    );
  }

  const nextState: SynapseResolutionState = {
    status: "resolved",
    phase: synapse.resolutionState?.phase ?? 2,
    verdict: input.verdict,
    rationale: input.rationale,
    resolvedAt: nowIso,
    resolvedBy: input.resolvedBy,
  };

  if (persist) {
    repo.updateSynapseResolution(input.fromId, input.synapseId, nextState);

    // P0-5 修复:写 merge_resolved audit(enum 有值但代码从未调用,经典 fail-silent)
    if (options.auditLog) {
      options.auditLog.append({
        actor: "user",
        action: "merge_resolved",
        engramId: input.fromId,
        host: options.host,
        metadata: {
          synapseId: input.synapseId,
          fromId: input.fromId,
          toId: synapse.to,
          verdict: input.verdict,
          rationale: input.rationale,
          resolvedBy: input.resolvedBy,
          phase: nextState.phase,
          // 便于 audit_query(action: merge_resolved, engramId) 直接追溯
          // "某个 engram 是否被判定为 superseded"
          supersededEngramId:
            input.verdict === "keep_old" ? input.fromId : synapse.to,
          winningEngramId:
            input.verdict === "keep_old" ? synapse.to : input.fromId,
        },
      });
    }

    // supersedes 自动提议(2026-08-16):裁决确认的替代关系落图(经提案审批)。
    // 方向 = winning supersedes superseded(「A supersedes B」= A 替代 B,有向)。
    // 失败静默:提议是增益路径,不阻塞裁决本身。
    if (options.proposalEngine && (input.verdict === "keep_old" || input.verdict === "keep_new")) {
      try {
        const supersededId =
          input.verdict === "keep_old" ? input.fromId : synapse.to;
        const winningId =
          input.verdict === "keep_old" ? synapse.to : input.fromId;
        const readTitle = (id: string): string | undefined => {
          try {
            return repo.readEngram(id).title;
          } catch {
            return undefined;
          }
        };
        options.proposalEngine.proposeSynapseOp({
          op: "add",
          from: winningId,
          to: supersededId,
          kind: "supersedes",
          reason: `矛盾裁决 ${input.verdict}:胜者替代被替代者(${input.rationale.slice(0, 100)})`,
          confidence: 0.9,
          fromTitle: readTitle(winningId),
          toTitle: readTitle(supersededId),
        });
      } catch {
        // 提议失败不影响裁决结果
      }
    }
  }

  return { resolved: true, finalStatus: "resolved" };
}
