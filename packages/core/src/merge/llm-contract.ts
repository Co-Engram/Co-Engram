/**
 * LLM merge arbitration contract (spec §5.2, §5.3).
 *
 * Pure types + JSON parsing — no LLM client coupling here.
 * The LlmArbiter (P3.2) consumes these and drives the actual LLM call.
 *
 * @module @co-engram/core/merge
 */

/**
 * 冲突类型 —— 决定 prompt 上下文与 LLM 介入的成本权衡。
 *
 * - engram_frontmatter:engram 的 YAML 字段冲突(title / domainTags 等)
 * - engram_content:engram 正文段落冲突
 * - synapse_field:synapse 的 YAML 字段冲突
 * - synapse_evidence:synapse.evidence 数组合并冲突
 * - resolution_state:synapse 的 resolutionState 合并冲突
 * - updatedAt_collision:updatedAt 完全一致 + 内容分歧的边界场景
 * - cross_file_inconsistency:跨文件一致性(P3.6 CrossFileCoordinator 触发)
 */
export type LlmMergeConflictType =
  | "engram_frontmatter"
  | "engram_content"
  | "synapse_field"
  | "synapse_evidence"
  | "resolution_state"
  | "updatedAt_collision"
  | "cross_file_inconsistency";

/**
 * LLM 仲裁输入(spec §5.2)
 *
 * 调用方负责把 base/ours/theirs 序列化为 JSON-safe 值;LLM 只看结构化字段,
 * 不直接接触原始 markdown / yaml 文本(降低 token、避免 prompt injection)。
 */
export interface LlmMergeInput {
  readonly conflictType: LlmMergeConflictType;
  readonly path: string;
  readonly fieldName?: string;
  readonly base: unknown;
  readonly ours: unknown;
  readonly theirs: unknown;
  readonly meta: {
    readonly oursUpdatedAt: string;
    readonly theirsUpdatedAt: string;
    readonly oursUpdatedBy: string;
    readonly theirsUpdatedBy: string;
  };
}

/**
 * LLM 仲裁输出(spec §5.3)
 *
 * verdict 语义:
 *   - "ours"     : 取 ours 原值
 *   - "theirs"   : 取 theirs 原值
 *   - "merge"    : 综合双方,mergedValue 必填
 *   - "escalate" : 无法判定 / 低置信 / 语义不一致 → 留 marker
 *
 * confidence:[0,1] 区间,低于阈值(默认 0.7)时调用方按 escalate 处理。
 */
export interface LlmMergeOutput {
  readonly verdict: "ours" | "theirs" | "merge" | "escalate";
  readonly mergedValue?: unknown;
  readonly rationale: string;
  readonly confidence: number;
}

/**
 * JSON 解析失败原因 —— 调用方据此决定 fallback 行为。
 */
export type LlmOutputParseErrorReason =
  | "empty_response"
  | "invalid_json"
  | "missing_verdict"
  | "invalid_verdict"
  | "invalid_confidence"
  | "missing_rationale"
  | "missing_merged_value";

export interface LlmOutputParseFailure {
  readonly ok: false;
  readonly reason: LlmOutputParseErrorReason;
  readonly raw: string;
  readonly message: string;
}

export interface LlmOutputParseSuccess {
  readonly ok: true;
  readonly output: LlmMergeOutput;
}

export type LlmOutputParseResult =
  | LlmOutputParseSuccess
  | LlmOutputParseFailure;

const VALID_VERDICTS = new Set(["ours", "theirs", "merge", "escalate"]);

/**
 * 解析 LLM 返回的原始字符串为 LlmMergeOutput。
 *
 * 验证规则:
 *   1. 必须是合法 JSON(允许前后空白 / ```json 代码块包裹)
 *   2. verdict ∈ {ours, theirs, merge, escalate}
 *   3. confidence ∈ [0, 1]
 *   4. rationale 必须是非空字符串
 *   5. verdict='merge' 时 mergedValue 必填
 *
 * 任何不满足都返回 failure,调用方据此降级。
 */
export function parseLlmMergeOutput(raw: string): LlmOutputParseResult {
  const trimmed = stripCodeFence(raw).trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "empty_response",
      raw,
      message: "LLM returned empty response",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      reason: "invalid_json",
      raw,
      message: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      reason: "invalid_json",
      raw,
      message: "LLM output is not a JSON object",
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (!("verdict" in obj)) {
    return {
      ok: false,
      reason: "missing_verdict",
      raw,
      message: "Missing 'verdict' field",
    };
  }
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict)) {
    return {
      ok: false,
      reason: "invalid_verdict",
      raw,
      message: `Invalid verdict: ${JSON.stringify(verdict)}`,
    };
  }

  if (!("confidence" in obj)) {
    return {
      ok: false,
      reason: "invalid_confidence",
      raw,
      message: "Missing 'confidence' field",
    };
  }
  const confidence = obj.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      ok: false,
      reason: "invalid_confidence",
      raw,
      message: `Invalid confidence (must be number in [0,1]): ${JSON.stringify(confidence)}`,
    };
  }

  if (!("rationale" in obj) || typeof obj.rationale !== "string") {
    return {
      ok: false,
      reason: "missing_rationale",
      raw,
      message: "Missing or non-string 'rationale'",
    };
  }
  const rationale = (obj.rationale as string).trim();
  if (rationale.length === 0) {
    return {
      ok: false,
      reason: "missing_rationale",
      raw,
      message: "Empty 'rationale'",
    };
  }

  if (verdict === "merge" && !("mergedValue" in obj)) {
    return {
      ok: false,
      reason: "missing_merged_value",
      raw,
      message: "verdict='merge' requires 'mergedValue'",
    };
  }

  return {
    ok: true,
    output: {
      verdict: verdict as LlmMergeOutput["verdict"],
      confidence,
      rationale,
      ...("mergedValue" in obj ? { mergedValue: obj.mergedValue } : {}),
    },
  };
}

/**
 * 剥离 markdown 代码块包裹(```json ... ``` 或 ``` ... ```)。
 *
 * LLM 经常无视"只返回 JSON"指令,这里做防御性剥离。
 */
function stripCodeFence(text: string): string {
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return match && match[1] ? match[1] : text;
}
