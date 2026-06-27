/**
 * LLM merge arbitration prompt template (spec §5.4).
 *
 * 模板输入:LlmMergeInput
 * 模板输出:string —— 直接传给 LlmClient.complete()
 *
 * 设计:
 *   - 系统提示稳定(可缓存);变量塞进 user 段以便 prompt cache 复用前缀
 *   - 输出格式严格 JSON,parser (parseLlmMergeOutput) 会剥离 ```json 包裹
 *   - 中性英文,避免 host i18n 干扰 verdict
 *
 * @module @co-engram/core/merge
 */

import type { LlmMergeInput } from "./llm-contract.js";

/**
 * 系统提示稳定,适合 prompt cache。LlmClient 调用方应作为 system prompt 传入。
 */
export const LLM_MERGE_SYSTEM_PROMPT = `You are a merge arbitrator for co-engram team memory files.

Your job: given BASE / OURS / THEIRS snapshots of a single field or content block,
decide how to resolve the conflict and return strict JSON.

Verdict semantics:
- "ours"     — take OURS as-is
- "theirs"   — take THEIRS as-is
- "merge"    — synthesize; provide mergedValue (must include both sides' intent)
- "escalate" — cannot decide confidently (low confidence or semantic incoherence)

Rules:
- Preserve both sides' intent when possible (prefer "merge" over picking a side).
- "escalate" if low confidence or the two sides are semantically incompatible.
- Never invent facts not present in either side.
- Never include markdown / code fences / prose outside the JSON object.

Return exactly this JSON shape (no other text):
{
  "verdict": "ours" | "theirs" | "merge" | "escalate",
  "mergedValue": <any> // required only when verdict === "merge"
  "rationale": "<one short sentence>",
  "confidence": 0.0
}`;

/**
 * 构造 LLM 调用的 user prompt。
 *
 * 与 system prompt 分离,让 prompt cache 能复用 system 部分(spec §5.5)。
 */
export function buildLlmMergeUserPrompt(input: LlmMergeInput): string {
  const fieldNameLine = input.fieldName ? `Field: ${input.fieldName}\n` : "";
  return `Conflict type: ${input.conflictType}
${fieldNameLine}Path: ${input.path}

BASE (common ancestor): ${safeStringify(input.base)}
OURS (${input.meta.oursUpdatedBy} at ${input.meta.oursUpdatedAt}): ${safeStringify(input.ours)}
THEIRS (${input.meta.theirsUpdatedBy} at ${input.meta.theirsUpdatedAt}): ${safeStringify(input.theirs)}

Decide and return JSON.`;
}

/**
 * 安全序列化:避免 undefined / BigInt / 循环引用导致 JSON.stringify 抛错。
 * 字符串值直接返回(让 prompt 更短、更可读)。
 */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "<undefined>";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
