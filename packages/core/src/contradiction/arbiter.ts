/**
 * Contradiction Arbiter（spec §3.9 阶段 1）
 *
 * LLM 自动裁决：必须给依据（rationale）+ confidence。
 *
 * 抽象层（不绑定具体 LLM）：
 *   - ContradictionArbiter Provider 接口
 *   - LocalHeuristicContradictionArbiter 本地规则实现（默认）
 *
 * 本地规则：
 *   - 优先保留高 confidence 一方
 *   - 高 evidenceCount 优势
 *   - firsthand > secondhand > inferred
 *   - 内容长度差异（短而精 vs 长而冗余）
 *   - 同等条件 → merge + 低 confidence（升级人工）
 *
 * @module @co-engram/core/contradiction
 */

import type { ArbitrateInput, ArbitrateOutput } from "./types.js";
import type { ContradictionVerdict } from "../types/synapse.js";
import { internalError } from "../tools/error-schema.js";

/** Arbiter Provider 接口（host 可注入 LLM 实现） */
export interface ContradictionArbiter {
  arbitrate(input: ArbitrateInput): Promise<ArbitrateOutput> | ArbitrateOutput;
}

/** 来源类型权重（firsthand > secondhand > inferred） */
const SOURCE_TYPE_WEIGHT: Record<string, number> = {
  firsthand: 1.0,
  secondhand: 0.7,
  inferred: 0.5,
};

/**
 * 本地启发式裁决器
 *
 * 规则按优先级：
 *   1. confidence 差异 > 0.2 → 保留高方（confidence 0.8）
 *   2. evidenceCount 差异 ≥ 3 → 保留多证据方（confidence 0.75）
 *   3. sourceType 差异大 → 保留 firsthand 方（confidence 0.7）
 *   4. 其他 → merge（confidence 0.5，需人工确认）
 */
export class LocalHeuristicContradictionArbiter implements ContradictionArbiter {
  arbitrate(input: ArbitrateInput): ArbitrateOutput {
    const { newEngram: neu, oldEngram: old } = input;

    const confDelta = neu.confidence - old.confidence;
    const evidenceDelta = neu.evidenceCount - old.evidenceCount;
    const neuSourceW = SOURCE_TYPE_WEIGHT[neu.sourceType] ?? 0.5;
    const oldSourceW = SOURCE_TYPE_WEIGHT[old.sourceType] ?? 0.5;

    // 规则 1：confidence 差异 > 0.2
    if (Math.abs(confDelta) > 0.2) {
      const winner: "new" | "old" = confDelta > 0 ? "new" : "old";
      return {
        verdict: winner === "new" ? "keep_new" : "keep_old",
        rationale: `confidence差距 ${confDelta.toFixed(2)}，保留 ${winner} 方 (conf=${(winner === "new" ? neu.confidence : old.confidence).toFixed(2)})`,
        confidence: 0.85,
      };
    }

    // 规则 2：evidence 差异 ≥ 3
    if (Math.abs(evidenceDelta) >= 3) {
      const winner: "new" | "old" = evidenceDelta > 0 ? "new" : "old";
      return {
        verdict: winner === "new" ? "keep_new" : "keep_old",
        rationale: `evidence差距 ${evidenceDelta}，保留 ${winner} 方 (evidence=${winner === "new" ? neu.evidenceCount : old.evidenceCount})`,
        confidence: 0.8,
      };
    }

    // 规则 3：sourceType 差异（firsthand vs inferred/secondhand）
    const sourceDelta = neuSourceW - oldSourceW;
    if (Math.abs(sourceDelta) >= 0.3) {
      const winner: "new" | "old" = sourceDelta > 0 ? "new" : "old";
      return {
        verdict: winner === "new" ? "keep_new" : "keep_old",
        rationale: `sourceType差异 (${neu.sourceType} vs ${old.sourceType})，保留 ${winner} 方`,
        confidence: 0.75,
      };
    }

    // 规则 4：fallback → merge，低 confidence（升级人工）
    return {
      verdict: "merge",
      rationale: `证据不足自动裁决 (confΔ=${confDelta.toFixed(2)}, evidenceΔ=${evidenceDelta}, sourceΔ=${sourceDelta.toFixed(2)})，建议人工合并`,
      confidence: 0.5,
    };
  }
}

/**
 * 判断 verdict 是否会自动执行（confidence ≥ threshold）
 *
 * 默认 threshold = 0.8（spec §3.9 阶段 1）
 */
export function shouldAutoExecute(
  output: ArbitrateOutput,
  threshold = 0.8,
): boolean {
  return output.confidence >= threshold && output.verdict !== "archive";
}

/**
 * 验证 Arbiter 输出合法
 *
 * 强制要求：
 *   - verdict 是合法枚举
 *   - rationale 非空（spec：必须给依据）
 *   - confidence ∈ [0, 1]
 */
export function validateArbiterOutput(output: ArbitrateOutput): void {
  const validVerdicts: readonly ContradictionVerdict[] = [
    "keep_new",
    "keep_old",
    "merge",
    "archive",
  ];
  if (!validVerdicts.includes(output.verdict)) {
    throw internalError(`Invalid verdict: ${output.verdict}`);
  }
  if (!output.rationale || output.rationale.trim().length === 0) {
    throw internalError("Arbiter must provide rationale (spec §3.9)");
  }
  if (
    typeof output.confidence !== "number" ||
    output.confidence < 0 ||
    output.confidence > 1
  ) {
    throw internalError(
      `confidence must be in [0,1], got ${output.confidence}`,
    );
  }
}
