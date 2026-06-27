/**
 * CrossFileCoordinator (spec §7) — post-merge 跨文件一致性 check。
 *
 * git merge driver 只看单文件冲突,**看不到跨文件状态**。当 engram 被
 * refuted/forgotten 但另一方在其上加 synapse 时,driver 不知道 — 这类
 * 不一致通过本模块在 post-merge hook / maintenance light stage 检测。
 *
 * 设计:
 *   - 不重试 / 不阻塞(失败只 audit,等待下次 deep stage)
 *   - 明确语义的 check 自动修复;需要语义判断的 check 调 LLM
 *   - 报告 spec §7.4 统计影响
 *
 * @module @co-engram/core/merge
 */

import type { EngramRepository } from "../storage/repository.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { LlmArbiter } from "./llm-arbiter.js";
import type { EngramStatus, VerificationStatus } from "../types/engram.js";

/** spec §7.3 不一致类型 */
export type InconsistencyKind =
  | "refuted_engram_has_active_synapse"
  | "supersedes_target_not_archived"
  | "contradicts_resolution_state_drift"
  | "disjoint_domain_tags";

export interface Inconsistency {
  readonly kind: InconsistencyKind;
  readonly path?: string;
  readonly engramId?: string;
  readonly synapseId?: string;
  readonly detail: string;
  /** 是否被自动修复;false 表示需要 LLM/人工 */
  readonly autoFixed: boolean;
}

export interface CrossFileConsistencyReport {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly inconsistencies: readonly Inconsistency[];
  readonly autoFixedCount: number;
  readonly llmEscalatedCount: number;
}

/** spec §7.3 中"refuted/forgotten"对应的 engram status 集合 */
const INACTIVE_STATUSES: readonly EngramStatus[] = ["archived", "forgotten"];

/** spec §7.3 中"应被 archived"的 verification status */
const REFUTED_VERIFICATION: VerificationStatus = "refuted";

/**
 * 跑一遍跨文件一致性 check(spec §7.3)。
 *
 * 不抛错(失败 → 写 inconsistency,继续)。
 * 不阻塞调用方(post-merge hook 必须 fast-fail)。
 */
export async function runCrossFileConsistency(params: {
  repository: EngramRepository;
  auditLog?: AuditLog;
  /**
   * 可选 LLM 仲裁器。提供时用于需要语义判断的 check(domainTags union
   * vs 二选一 / contradicts resolutionState)。不提供 → 这两类只记录 inconsistency。
   */
  llmArbiter?: LlmArbiter;
}): Promise<CrossFileConsistencyReport> {
  const { repository, auditLog, llmArbiter } = params;
  const startedAt = Date.now();
  const inconsistencies: Inconsistency[] = [];

  // Check 1: refuted/forgotten engram 仍有 active outgoing synapse (spec §7.3 行 1)
  inconsistencies.push(...checkRefutedEngramsHaveActiveSynapses(repository));

  // Check 2: supersedes 关系破裂 (spec §7.3 行 2)
  inconsistencies.push(...checkSupersedesTargets(repository));

  // Check 3 + 4: 需要 LLM 介入的不一致(可选)
  if (llmArbiter) {
    inconsistencies.push(
      ...(await checkContradictsDrift(repository, llmArbiter)),
    );
    inconsistencies.push(
      ...(await checkDisjointDomainTags(repository, llmArbiter)),
    );
  } else {
    // 无 LLM — 仍扫描并 audit,但不尝试修复
    inconsistencies.push(...scanContradictsDriftNoLlm(repository));
    inconsistencies.push(...scanDisjointDomainTagsNoLlm(repository));
  }

  // 自动修复的 inconsistency 标 autoFixed=true(已在 check 内部完成)
  // 写 audit log
  if (auditLog) {
    for (const inc of inconsistencies) {
      auditLog.append({
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: {
          kind: inc.kind,
          path: inc.path,
          engramId: inc.engramId,
          synapseId: inc.synapseId,
          detail: inc.detail,
          autoFixed: inc.autoFixed,
          source: "cross-file-coordinator",
        },
      });
    }
  }

  const finishedAt = Date.now();
  const autoFixedCount = inconsistencies.filter((i) => i.autoFixed).length;
  const llmEscalatedCount = inconsistencies.filter((i) => !i.autoFixed).length;

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    inconsistencies,
    autoFixedCount,
    llmEscalatedCount,
  };
}

// ============================================================
// Check 1: refuted/forgotten engram 仍有 active outgoing synapse
// ============================================================

function checkRefutedEngramsHaveActiveSynapses(
  repository: EngramRepository,
): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const entry of repository.listEngrams()) {
    let engram;
    try {
      engram = repository.readEngram(entry.id);
    } catch {
      continue; // 索引过期 / 文件已被删
    }
    const isInactive =
      INACTIVE_STATUSES.includes(engram.status) ||
      engram.verificationStatus === REFUTED_VERIFICATION;
    if (!isInactive) continue;
    // 查该 engram 的 outgoing synapses
    const { outgoing } = repository.readSynapses(engram.id);
    if (outgoing.length === 0) continue;
    out.push({
      kind: "refuted_engram_has_active_synapse",
      engramId: engram.id,
      detail: `engram status=${engram.status}/verificationStatus=${engram.verificationStatus ?? "unverified"} but has ${outgoing.length} outgoing synapse(s)`,
      autoFixed: false,
    });
  }
  return out;
}

// ============================================================
// Check 2: supersedes 关系破裂 — A supersedes B,B 应 archived
// ============================================================

function checkSupersedesTargets(repository: EngramRepository): Inconsistency[] {
  const out: Inconsistency[] = [];
  // 遍历所有 engram,查 kind=supersedes 的 outgoing synapse
  for (const entry of repository.listEngrams()) {
    let engram;
    try {
      engram = repository.readEngram(entry.id);
    } catch {
      continue;
    }
    const { outgoing } = repository.readSynapses(engram.id);
    for (const syn of outgoing) {
      if (syn.kind !== "supersedes") continue;
      let target;
      try {
        target = repository.readEngram(syn.to);
      } catch {
        continue; // target 不存在 — dangling synapse,doctor 已处理
      }
      if (target.status === "archived") continue;
      // 自动修复:把 target.status 设为 archived(spec §7.3 行 2:明确语义)
      try {
        repository.updateLifecycle(target.id, "archived");
        out.push({
          kind: "supersedes_target_not_archived",
          engramId: target.id,
          synapseId: syn.id,
          detail: `auto-archived ${target.id} (superseded by ${engram.id})`,
          autoFixed: true,
        });
      } catch {
        out.push({
          kind: "supersedes_target_not_archived",
          engramId: target.id,
          synapseId: syn.id,
          detail: `failed to auto-archive ${target.id}`,
          autoFixed: false,
        });
      }
    }
  }
  return out;
}

// ============================================================
// Check 3: contradicts synapse resolutionState drift (LLM-assisted)
// ============================================================

async function checkContradictsDrift(
  repository: EngramRepository,
  _arbiter: LlmArbiter,
): Promise<Inconsistency[]> {
  // 完整 LLM 仲裁涉及大量 LLM 调用,Phase 3 先扫描 + 记录,实际修复留 P4
  return scanContradictsDriftNoLlm(repository);
}

function scanContradictsDriftNoLlm(
  repository: EngramRepository,
): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const entry of repository.listEngrams()) {
    let engram;
    try {
      engram = repository.readEngram(entry.id);
    } catch {
      continue;
    }
    const { outgoing } = repository.readSynapses(engram.id);
    for (const syn of outgoing) {
      if (syn.kind !== "contradicts") continue;
      const rs = syn.resolutionState;
      if (!rs) continue;
      // pending / auto_resolved 状态长期停留 → 可能 drift
      if (rs.status === "pending" || rs.status === "auto_resolved") {
        out.push({
          kind: "contradicts_resolution_state_drift",
          engramId: engram.id,
          synapseId: syn.id,
          detail: `contradicts synapse stuck in ${rs.status} phase ${rs.phase}`,
          autoFixed: false,
        });
      }
    }
  }
  return out;
}

// ============================================================
// Check 4: disjoint domainTags (LLM-assisted)
// ============================================================

async function checkDisjointDomainTags(
  repository: EngramRepository,
  _arbiter: LlmArbiter,
): Promise<Inconsistency[]> {
  // 完整 LLM 仲裁涉及版本对比,Phase 3 先扫描空 tags / 单元素 tags 异常
  return scanDisjointDomainTagsNoLlm(repository);
}

function scanDisjointDomainTagsNoLlm(
  repository: EngramRepository,
): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const entry of repository.listEngrams()) {
    let engram;
    try {
      engram = repository.readEngram(entry.id);
    } catch {
      continue;
    }
    const tags = engram.domainTags ?? [];
    if (tags.length === 0) {
      out.push({
        kind: "disjoint_domain_tags",
        engramId: engram.id,
        detail: `engram has empty domainTags after merge`,
        autoFixed: false,
      });
    }
  }
  return out;
}
