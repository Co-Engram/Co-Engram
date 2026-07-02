/**
 * SynapseMerger — orchestrator for synapse file 3-way merge (spec §6).
 *
 * Composes:
 *   - synapse-rules: immutable / updatedAt_arbitration / max_updatedAt
 *   - evidence-union: array_union
 *   - resolution-state: state_machine
 *   - passthrough: unknown fields kept from ours
 *
 * Identity fields (id/from/to/kind/createdBy/createdAt) — divergent edits
 * escalate per spec §6.4 "kind 改变 → driver 不介入". Note that since
 * kind is part of the file path (`synapses/{kind}/syn-{id}.yaml`), kind
 * changes show up as rename/add in git itself, not as content conflict.
 *
 * `mergeSynapseFile` 是 sync 版本,只走 Layer A(机械规则)。
 * `mergeSynapseFileAsync` 在 updatedAt_arbitration 字段 escalate 时追加
 * Layer B(LLM)兜底;immutable 字段保持 escalate(spec §6.4)。
 *
 * @module @co-engram-core/merge
 */

import {
  parseSynapseFile,
  serializeSynapseFile,
} from "../storage/synapse-store.js";
import { classifySynapseField } from "./synapse-rules.js";
import { mergeSynapseImmutableField } from "./synapse-rules.js";
import { mergeSynapseUpdatedAtField } from "./synapse-rules.js";
import { mergeSynapseMaxUpdatedAt } from "./synapse-rules.js";
import { ImmutableSynapseViolationError } from "./synapse-rules.js";
import { mergeEvidence } from "./evidence-union.js";
import { mergeResolutionState } from "./resolution-state.js";
import type { Synapse, SynapseEvidence } from "../types/synapse.js";
import type { LlmArbiter } from "./llm-arbiter.js";
import type { LlmMergeInput } from "./llm-contract.js";

export interface SynapseMergeResult {
  /** Parsed merged synapse (only valid when escalated=false). */
  readonly merged: Synapse;
  /** Serialized merged YAML (with frontmatter delimiters). */
  readonly mergedContent: string;
  /** True when conflict could not be auto-resolved; markers in mergedContent. */
  readonly escalated: boolean;
  /** Human-readable summary of the strategy used. */
  readonly strategy: string;
  /** Winner side for updatedAt arbitrated fields, when applicable. */
  readonly arbitratedWinner: "ours" | "theirs" | null;
}

export function mergeSynapseFile(params: {
  baseRaw: string;
  oursRaw: string;
  theirsRaw: string;
  /**
   * 预解析的字段解决方案(用于 async 版注入 LLM 结果)。
   * sync 调用方不传;key=字段名,value=替代 escalate 的最终值。
   */
  preResolvedFields?: Record<string, unknown>;
}): SynapseMergeResult {
  const { baseRaw, oursRaw, theirsRaw, preResolvedFields } = params;

  const base = parseSynapseFile(baseRaw);
  const ours = parseSynapseFile(oursRaw);
  const theirs = parseSynapseFile(theirsRaw);

  const escalatedFields: string[] = [];
  let arbitratedWinner: "ours" | "theirs" | null = null;

  // Mutable copy
  const merged: Record<string, unknown> = {};

  // Collect all keys from all sides
  const allKeys = new Set<string>([
    ...Object.keys(base as unknown as Record<string, unknown>),
    ...Object.keys(ours as unknown as Record<string, unknown>),
    ...Object.keys(theirs as unknown as Record<string, unknown>),
  ]);

  for (const key of allKeys) {
    const klass = classifySynapseField(key);
    const baseV = (base as unknown as Record<string, unknown>)[key];
    const oursV = (ours as unknown as Record<string, unknown>)[key];
    const theirsV = (theirs as unknown as Record<string, unknown>)[key];

    // Layer B 注入:如果字段已在 preResolvedFields 中,直接采用,跳过 Layer A
    if (preResolvedFields && key in preResolvedFields) {
      merged[key] = preResolvedFields[key];
      // 不更新 arbitratedWinner(preResolvedFields 来源是 LLM,不是 updatedAt)
      continue;
    }

    switch (klass) {
      case "immutable": {
        try {
          merged[key] = mergeSynapseImmutableField({
            base: baseV,
            ours: oursV,
            theirs: theirsV,
            fieldName: key,
          });
        } catch (e) {
          if (e instanceof ImmutableSynapseViolationError) {
            escalatedFields.push(key);
            merged[key] = oursV; // provisional; will be overwritten by markers
          } else {
            throw e;
          }
        }
        break;
      }

      case "updatedAt_arbitration": {
        const r = mergeSynapseUpdatedAtField({
          base: baseV,
          ours: oursV,
          theirs: theirsV,
          oursUpdatedAt: ours.updatedAt,
          theirsUpdatedAt: theirs.updatedAt,
        });
        if ("escalated" in r) {
          escalatedFields.push(key);
          merged[key] = oursV;
        } else {
          merged[key] = r.value;
          if (r.winner) arbitratedWinner = r.winner;
        }
        break;
      }

      case "max_updatedAt": {
        merged[key] = mergeSynapseMaxUpdatedAt(
          ours.updatedAt,
          theirs.updatedAt,
        );
        break;
      }

      case "array_union": {
        // Spec §6.1: only evidence is array_union.
        merged[key] = mergeEvidence({
          base: (baseV as readonly SynapseEvidence[] | undefined) ?? [],
          ours: (oursV as readonly SynapseEvidence[] | undefined) ?? [],
          theirs: (theirsV as readonly SynapseEvidence[] | undefined) ?? [],
        });
        break;
      }

      case "state_machine": {
        // resolutionState
        const r = mergeResolutionState({
          base: baseV as Synapse["resolutionState"],
          ours: oursV as Synapse["resolutionState"],
          theirs: theirsV as Synapse["resolutionState"],
        });
        if (r.merged) merged[key] = r.merged;
        if (
          r.strategy === "tie-keep-ours" ||
          r.strategy === "higher-phase" ||
          r.strategy === "higher-priority-status"
        ) {
          // Surfaced for downstream evidence append (loser rationale)
        }
        break;
      }

      case "recomputed": {
        // retrievalWeight is recomputed downstream; keep base value as placeholder.
        merged[key] = baseV ?? oursV;
        break;
      }

      case "passthrough":
      default: {
        // Unknown fields: keep ours if both present
        merged[key] = oursV ?? theirsV ?? baseV;
        break;
      }
    }
  }

  if (escalatedFields.length > 0) {
    const wrapped = `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
    return {
      merged: ours, // provisional; caller should use mergedContent
      mergedContent: wrapped,
      escalated: true,
      strategy: `synapse escalated: ${escalatedFields.join(", ")}`,
      arbitratedWinner: null,
    };
  }

  // Reconstruct Synapse from merged record.
  const mergedSynapse: Synapse = reconstructSynapse(merged);
  const serialized = serializeSynapseFile(mergedSynapse, "en");

  const strategyBits: string[] = [];
  if (arbitratedWinner) {
    strategyBits.push(`arbitrated(${arbitratedWinner})`);
  }
  strategyBits.push(
    `evidence[${mergedSynapse.evidence.length}]`,
    `updatedAt-max`,
  );

  return {
    merged: mergedSynapse,
    mergedContent: serialized,
    escalated: false,
    strategy: `synapse: ${strategyBits.join(" + ")}`,
    arbitratedWinner,
  };
}

/**
 * Async 版 synapse 合并,在 Layer A escalate 后追加 Layer B(LLM)兜底。
 *
 * 触发条件(spec §5.7):
 *   - updatedAt_arbitration 字段(weight/direction/sourceSemantic/targetSemantic)
 *     双方都改 + updatedAt 一致 → LLM 决定
 *
 * 不触发:
 *   - immutable 字段 escalate(spec §6.4: identity 字段冲突必须人工)
 *   - Layer A 已解决
 */
export async function mergeSynapseFileAsync(params: {
  baseRaw: string;
  oursRaw: string;
  theirsRaw: string;
  arbiter: LlmArbiter;
  path: string;
}): Promise<SynapseMergeResult> {
  // Step 1: Layer A (sync)
  const layerA = mergeSynapseFile(params);
  if (!layerA.escalated) {
    return layerA;
  }

  // Parse escalated field names from strategy string ("synapse escalated: a, b")
  const fieldsList = layerA.strategy.replace(/^synapse escalated:\s*/, "");
  const escalatedFields = fieldsList
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);

  // Step 2: 仅对 updatedAt_arbitration 类型字段调 LLM
  const base = parseSynapseFile(params.baseRaw);
  const ours = parseSynapseFile(params.oursRaw);
  const theirs = parseSynapseFile(params.theirsRaw);
  const baseRec = base as unknown as Record<string, unknown>;
  const oursRec = ours as unknown as Record<string, unknown>;
  const theirsRec = theirs as unknown as Record<string, unknown>;

  const preResolvedFields: Record<string, unknown> = {};
  let resolvedCount = 0;
  let llmAttempted = 0;
  const stillEscalatedImmutable: string[] = [];

  for (const fieldName of escalatedFields) {
    const klass = classifySynapseField(fieldName);
    if (klass !== "updatedAt_arbitration") {
      // immutable / state_machine 等 — 不让 LLM 介入
      stillEscalatedImmutable.push(fieldName);
      continue;
    }

    llmAttempted++;
    const llmInput: LlmMergeInput = {
      conflictType: "synapse_field",
      path: params.path,
      fieldName,
      base: baseRec[fieldName],
      ours: oursRec[fieldName],
      theirs: theirsRec[fieldName],
      meta: {
        oursUpdatedAt: ours.updatedAt,
        theirsUpdatedAt: theirs.updatedAt,
        oursUpdatedBy: (oursRec.createdBy as string) ?? "unknown",
        theirsUpdatedBy: (theirsRec.createdBy as string) ?? "unknown",
      },
    };
    const result = await params.arbiter.arbitrate(llmInput);

    if (result.verdict.kind === "resolved") {
      const output = result.verdict.output;
      if (output.verdict === "merge" && "mergedValue" in output) {
        preResolvedFields[fieldName] = output.mergedValue;
        resolvedCount++;
      } else if (output.verdict === "ours") {
        preResolvedFields[fieldName] = oursRec[fieldName];
        resolvedCount++;
      } else if (output.verdict === "theirs") {
        preResolvedFields[fieldName] = theirsRec[fieldName];
        resolvedCount++;
      }
      // verdict=escalate → 不填,该字段继续走 Layer A escalate
    }
  }

  if (resolvedCount === 0) {
    // LLM 一无所获 — 返回原 escalate 结果
    return layerA;
  }

  // Step 3: 用 preResolvedFields 重跑合并
  const merged2 = mergeSynapseFile({
    ...params,
    preResolvedFields,
  });

  // 注:如果仍有 immutable 字段 escalate,merged2.escalated 仍为 true
  // 在 strategy 中标注 LLM 解决了多少
  if (merged2.escalated) {
    return merged2; // immutable 字段仍 escalate,strategy 不变
  }

  return {
    ...merged2,
    strategy: `${merged2.strategy} + llm:${resolvedCount}/${llmAttempted} resolved`,
  };
}

function reconstructSynapse(record: Record<string, unknown>): Synapse {
  // Ensure required fields are present (they are immutable so always exist).
  return {
    id: record.id as Synapse["id"],
    from: record.from as Synapse["from"],
    to: record.to as Synapse["to"],
    kind: record.kind as Synapse["kind"],
    weight: typeof record.weight === "number" ? (record.weight as number) : 0.5,
    direction: (record.direction as Synapse["direction"]) ?? "directional",
    evidence: (record.evidence as SynapseEvidence[]) ?? [],
    createdBy: (record.createdBy as string) ?? "",
    createdAt: (record.createdAt as string) ?? "",
    updatedAt: (record.updatedAt as string) ?? "",
    retrievalWeight:
      typeof record.retrievalWeight === "number"
        ? (record.retrievalWeight as number)
        : 0.5,
    sourceSemantic: record.sourceSemantic as string | undefined,
    targetSemantic: record.targetSemantic as string | undefined,
    resolutionState: record.resolutionState as Synapse["resolutionState"],
    visibility:
      record.visibility === "private" ||
      record.visibility === "team" ||
      record.visibility === "restricted" ||
      record.visibility === "public"
        ? (record.visibility as Synapse["visibility"])
        : "public",
  };
}
