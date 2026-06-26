/**
 * Contradiction Resolution 共享类型（spec §3.9）
 *
 * @module @co-engram/core/contradiction
 */

import type { EngramId, SynapseId } from "../types/engram.js";
import type {
  ContradictionVerdict,
  SynapseResolutionStatus,
} from "../types/synapse.js";

/** 矛盾对（A vs B，A 是 synapse.from，B 是 synapse.to） */
export interface ContradictionPair {
  readonly synapseId: SynapseId;
  readonly fromId: EngramId;
  readonly toId: EngramId;
  /** 矛盾强度（synapse.weight） */
  readonly weight: number;
  /** 当前裁决状态（undefined=未进入流程） */
  readonly status: SynapseResolutionStatus | "none";
}

/** Arbiter 输入：两个 engram 的简要信息 */
export interface ArbitrateInput {
  readonly newEngram: {
    readonly id: EngramId;
    readonly title: string;
    readonly summary: string;
    readonly content: string;
    readonly confidence: number;
    readonly sourceType: string;
    readonly evidenceCount: number;
  };
  readonly oldEngram: {
    readonly id: EngramId;
    readonly title: string;
    readonly summary: string;
    readonly content: string;
    readonly confidence: number;
    readonly sourceType: string;
    readonly evidenceCount: number;
  };
  /** 触发矛盾的 synapse 上的证据描述 */
  readonly contradictionEvidence: readonly string[];
}

/** Arbiter 输出：裁决结果 */
export interface ArbitrateOutput {
  readonly verdict: ContradictionVerdict;
  readonly rationale: string;
  readonly confidence: number;
}

/** 一条裁决历史记录（revisionHistory） */
export interface RevisionEntry {
  readonly at: string;
  readonly phase: 1 | 2 | 3;
  readonly action: SynapseResolutionStatus | "execute_verdict";
  readonly verdict?: ContradictionVerdict;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly actor: string;
}

/** 裁决流程结果 */
export interface ResolutionResult {
  readonly synapseId: SynapseId;
  readonly fromId: EngramId;
  readonly toId: EngramId;
  /** 最终进入的阶段（1=自动 / 2=升级 / 3=降级） */
  readonly finalPhase: 1 | 2 | 3;
  readonly finalStatus: SynapseResolutionStatus;
  readonly verdict?: ContradictionVerdict;
  readonly rationale?: string;
  readonly confidence?: number;
  /** 是否实际落盘 */
  readonly persisted: boolean;
  /** revisionHistory */
  readonly history: readonly RevisionEntry[];
}
