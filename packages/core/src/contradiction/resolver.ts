/**
 * Contradiction Resolver（spec §3.9 完整三阶段）
 *
 * resolveContradiction:
 *   阶段 1 - LLM 自动裁决（confidence ≥ threshold）
 *     → 执行 verdict (keep_new / keep_old / merge)
 *   阶段 2 - 升级归属人（confidence < threshold 或 verdict=archive）
 *     → 标记 escalated + 设置 expiresAt
 *   阶段 3 - 超时降级（由 processExpiredContradictions 单独处理）
 *
 * Verdict 执行的副作用：
 *   - keep_new: old verificationStatus = 'refuted'
 *   - keep_old: new verificationStatus = 'refuted'
 *   - merge: 合并 new → old（content + summary），删除 contradicts synapse
 *   - archive: 不自动执行（仅阶段 2 升级，由人工决定）
 *
 * revisionHistory 通过 synapse.evidence 数组追加记录每次裁决动作。
 *
 * @module @co-engram/core/contradiction
 */

import type { EngramRepository } from "../storage/repository.js";
import { stripDerivedSection } from "../storage/obsidian-links.js";
import {
  notFoundError,
  validationError,
} from "../tools/error-schema.js";
import type {
  SynapseResolutionState,
  ContradictionVerdict,
} from "../types/synapse.js";
import type { Engram, EngramId } from "../types/engram.js";
import {
  LocalHeuristicContradictionArbiter,
  validateArbiterOutput,
  shouldAutoExecute,
  type ContradictionArbiter,
} from "./arbiter.js";
import type {
  ArbitrateInput,
  ResolutionResult,
  RevisionEntry,
} from "./types.js";

/** 默认自动裁决阈值（spec §3.9 阶段 1：confidence ≥ 0.8） */
const DEFAULT_AUTO_THRESHOLD = 0.8;

/** 阶段 2 默认超时时间（天） */
const DEFAULT_ESCALATION_TIMEOUT_DAYS = 7;

export interface ResolveContradictionOptions {
  /** 自定义 arbiter（默认 LocalHeuristicContradictionArbiter） */
  readonly arbiter?: ContradictionArbiter;
  /** 自动裁决阈值（默认 0.8） */
  readonly autoThreshold?: number;
  /** 阶段 2 超时天数（默认 7） */
  readonly escalationTimeoutDays?: number;
  /** 当前时间（测试用） */
  readonly now?: Date;
  /** 是否实际落盘（默认 true） */
  readonly persist?: boolean;
}

export interface ResolveContradictionInput {
  readonly fromId: EngramId;
  readonly synapseId: string;
}

/**
 * 解决一个 contradicts synapse（三阶段流程入口）
 */
export async function resolveContradiction(
  repo: EngramRepository,
  input: ResolveContradictionInput,
  options: ResolveContradictionOptions = {},
): Promise<ResolutionResult> {
  const arbiter = options.arbiter ?? new LocalHeuristicContradictionArbiter();
  const threshold = options.autoThreshold ?? DEFAULT_AUTO_THRESHOLD;
  const timeoutDays =
    options.escalationTimeoutDays ?? DEFAULT_ESCALATION_TIMEOUT_DAYS;
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;

  // 1. 找到 contradicts synapse
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
      `Synapse ${input.synapseId} is not a contradicts (kind=${synapse.kind})`,
      {
        suggestion:
          "contradiction_resolve requires a synapse with kind='contradicts'.",
        resourceId: input.synapseId,
      },
    );
  }

  const fromEngram = repo.readEngram(input.fromId);
  const toEngram = repo.readEngram(synapse.to);

  // 2. 构造 arbiter 输入
  const arbInput: ArbitrateInput = {
    newEngram: engramToArbiterView(fromEngram),
    oldEngram: engramToArbiterView(toEngram),
    contradictionEvidence: synapse.evidence.map((e) => e.description),
  };

  // 3. 阶段 1：调 arbiter
  const arbOutput = await arbiter.arbitrate(arbInput);
  validateArbiterOutput(arbOutput);

  const history: RevisionEntry[] = [];
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + timeoutDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 4. 决定走自动还是升级
  if (shouldAutoExecute(arbOutput, threshold)) {
    // === 阶段 1：自动执行 ===
    history.push({
      at: nowIso,
      phase: 1,
      action: "execute_verdict",
      verdict: arbOutput.verdict,
      rationale: arbOutput.rationale,
      confidence: arbOutput.confidence,
      actor: "llm-arbiter",
    });

    if (persist) {
      executeVerdict(
        repo,
        input.fromId,
        synapse.to,
        input.synapseId,
        arbOutput.verdict,
        nowIso,
      );
    }

    // merge 已删除 synapse；其他 verdict 更新 resolutionState
    if (persist && arbOutput.verdict !== "merge") {
      const finalState: SynapseResolutionState = {
        status: "auto_resolved",
        phase: 1,
        verdict: arbOutput.verdict,
        rationale: arbOutput.rationale,
        confidence: arbOutput.confidence,
        resolvedAt: nowIso,
        resolvedBy: "llm-arbiter",
      };
      repo.updateSynapseResolution(input.fromId, input.synapseId, finalState);
    }

    return {
      synapseId: input.synapseId,
      fromId: input.fromId,
      toId: synapse.to,
      finalPhase: 1,
      finalStatus: "auto_resolved",
      verdict: arbOutput.verdict,
      rationale: arbOutput.rationale,
      confidence: arbOutput.confidence,
      persisted: persist,
      history,
    };
  }

  // === 阶段 2：升级归属人 ===
  history.push({
    at: nowIso,
    phase: 2,
    action: "escalated",
    verdict: arbOutput.verdict,
    rationale: arbOutput.rationale,
    confidence: arbOutput.confidence,
    actor: "system",
  });

  const escalatedState: SynapseResolutionState = {
    status: "escalated",
    phase: 2,
    verdict: arbOutput.verdict,
    rationale: arbOutput.rationale,
    confidence: arbOutput.confidence,
    escalatedTo: toEngram.createdBy,
    escalatedAt: nowIso,
    expiresAt: expiresAtIso,
  };

  if (persist) {
    repo.updateSynapseResolution(input.fromId, input.synapseId, escalatedState);
  }

  return {
    synapseId: input.synapseId,
    fromId: input.fromId,
    toId: synapse.to,
    finalPhase: 2,
    finalStatus: "escalated",
    verdict: arbOutput.verdict,
    rationale: arbOutput.rationale,
    confidence: arbOutput.confidence,
    persisted: persist,
    history,
  };
}

/**
 * 执行 verdict 的副作用
 */
function executeVerdict(
  repo: EngramRepository,
  fromId: EngramId,
  toId: EngramId,
  synapseId: string,
  verdict: ContradictionVerdict,
  nowIso: string,
): void {
  switch (verdict) {
    case "keep_new": {
      repo.updateVerificationStatus(toId, "refuted");
      appendEvidence(
        repo,
        fromId,
        synapseId,
        `auto: keep_new (old ${toId} refuted)`,
        nowIso,
      );
      break;
    }
    case "keep_old": {
      repo.updateVerificationStatus(fromId, "refuted");
      appendEvidence(
        repo,
        fromId,
        synapseId,
        `auto: keep_old (new ${fromId} refuted)`,
        nowIso,
      );
      break;
    }
    case "merge": {
      const fromEngram = repo.readEngram(fromId);
      const toEngram = repo.readEngram(toId);
      repo.updateEngram(toId, {
        content: mergeContent(toEngram.content, fromEngram.content),
        summary: mergeSummary(toEngram.summary, fromEngram.summary),
        updatedBy: "contradiction-merge",
      });
      repo.removeOutgoingSynapse(fromId, synapseId);
      break;
    }
    case "archive":
      // 阶段 2 升级，不自动 archive
      break;
  }
}

function appendEvidence(
  repo: EngramRepository,
  fromId: EngramId,
  synapseId: string,
  description: string,
  atIso: string,
): void {
  const file = repo.readSynapses(fromId);
  const target = file.outgoing.find((s) => s.id === synapseId);
  if (!target) return;
  const newEvidence = [
    ...target.evidence,
    { description, addedAt: atIso, addedBy: "contradiction-resolver" },
  ];
  repo.replaceSynapseEvidence(fromId, synapseId, newEvidence);
}

function mergeContent(a: string, b: string): string {
  // readEngram.content 含 Obsidian 派生段(<!-- co-engram-derived:synapses --> 起到文件末尾),
  // 而本函数返回后会经过 removeOutgoingSynapse → regenerateObsidianLinks → stripDerivedSection,
  // 该 strip 按 marker 截断,不先剥离 a/b 各自的旧派生段,b 的派生 marker 之后合并进来的内容会被一并丢弃。
  const cleanA = stripDerivedSection(a);
  const cleanB = stripDerivedSection(b);
  return `${cleanA}\n\n---\n\n[merged from contradiction]\n${cleanB}`;
}

function mergeSummary(a: string, b: string): string {
  if (a === b) return a;
  return `${a} / ${b}`;
}

function engramToArbiterView(e: Engram) {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary,
    content: e.content,
    confidence: e.confidence,
    sourceType: e.sourceType as string,
    evidenceCount: e.evidenceCount,
  };
}
