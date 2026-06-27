/**
 * LLM merge arbitrator (spec §5).
 *
 * 接受 LlmClient + confidence threshold,把 LlmMergeInput 翻译成一次 LLM 调用,
 * 解析输出,应用置信度阈值,失败一律降级到 escalate(留 marker)。
 *
 * 不重试(spec §5.5):失败就降级,backup + audit 兜底。
 *
 * @module @co-engram/core/merge
 */

import { createHash } from "node:crypto";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import type { AuditLog } from "../observability/audit-log.js";
import {
  parseLlmMergeOutput,
  type LlmMergeInput,
  type LlmMergeOutput,
  type LlmOutputParseFailure,
} from "./llm-contract.js";
import {
  LLM_MERGE_SYSTEM_PROMPT,
  buildLlmMergeUserPrompt,
} from "./llm-prompt.js";

/**
 * 默认置信度阈值(spec §5.5)。
 *
 * 低于此值的输出按 escalate 处理 —— 调用方应保留 marker,留给人工解决。
 */
export const DEFAULT_LLM_CONFIDENCE_THRESHOLD = 0.7;

/**
 * 默认超时(spec §5.5):15s,merge driver 必须 block 但不能拖死 git pull。
 */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;

/**
 * 默认 token 预算(spec §5.5):input < 1000, output < 200。
 */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 200;

export type LlmArbiterVerdict =
  | { readonly kind: "resolved"; readonly output: LlmMergeOutput }
  | { readonly kind: "escalated"; readonly reason: EscalationReason };

export type EscalationReason =
  | "llm_call_failed"
  | "parse_failed"
  | "low_confidence"
  | "verdict_escalate";

export interface LlmArbiterResult {
  /** 最终裁决(resolved=可执行,escalated=留 marker) */
  readonly verdict: LlmArbiterVerdict;
  /** 实际耗时(ms) */
  readonly latencyMs: number;
  /** LLM 原始返回(诊断用;escalated 时也可能有值) */
  readonly rawResponse?: string;
  /** 解析错误(parse_failed 时填) */
  readonly parseFailure?: LlmOutputParseFailure;
  /** prompt 哈希(短 SHA256,前 12 hex)—— 落 audit 用于 prompt drift 检测 */
  readonly promptHash: string;
}

export interface LlmArbiterConfig {
  readonly client: LlmClient;
  readonly confidenceThreshold?: number;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly auditLog?: AuditLog;
  /** 用于 audit 记录的 provider 名(如 'anthropic' / 'openai-compatible') */
  readonly providerName?: string;
}

/**
 * LLM 仲裁器 —— 把机械规则解决不了的冲突交给 LLM。
 *
 * 调用方:
 * ```ts
 * const arbiter = new LlmArbiter({ client, auditLog, providerName: 'anthropic' });
 * const result = await arbiter.arbitrate(input);
 * if (result.verdict.kind === 'resolved') {
 *   applyMerge(result.verdict.output);
 * } else {
 *   writeConflictMarkers();
 * }
 * ```
 */
export class LlmArbiter {
  private readonly client: LlmClient;
  private readonly confidenceThreshold: number;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;
  private readonly auditLog?: AuditLog;
  private readonly providerName?: string;

  constructor(config: LlmArbiterConfig) {
    this.client = config.client;
    this.confidenceThreshold =
      config.confidenceThreshold ?? DEFAULT_LLM_CONFIDENCE_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.maxOutputTokens =
      config.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS;
    this.temperature = config.temperature ?? 0.1;
    this.auditLog = config.auditLog;
    this.providerName = config.providerName;
  }

  async arbitrate(input: LlmMergeInput): Promise<LlmArbiterResult> {
    const userPrompt = buildLlmMergeUserPrompt(input);
    const fullPrompt = `${LLM_MERGE_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;
    const promptHash = hashPrompt(fullPrompt);

    const start = Date.now();
    let raw: string;
    try {
      raw = await this.client.complete(fullPrompt, {
        maxTokens: this.maxOutputTokens,
        temperature: this.temperature,
        timeoutMs: this.timeoutMs,
      });
    } catch (e) {
      const latencyMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      this.auditFailure(input, promptHash, latencyMs, undefined, msg);
      return {
        verdict: { kind: "escalated", reason: "llm_call_failed" },
        latencyMs,
        promptHash,
      };
    }
    const latencyMs = Date.now() - start;

    const parsed = parseLlmMergeOutput(raw);
    if (!parsed.ok) {
      this.auditFailure(
        input,
        promptHash,
        latencyMs,
        raw,
        `parse_failed: ${parsed.message}`,
      );
      return {
        verdict: { kind: "escalated", reason: "parse_failed" },
        latencyMs,
        rawResponse: raw,
        parseFailure: parsed,
        promptHash,
      };
    }

    const output = parsed.output;

    // LLM 自己选择 escalate —— 尊重它的判断,但仍是 escalate 结果
    if (output.verdict === "escalate") {
      this.auditSuccess(input, promptHash, latencyMs, output, true);
      return {
        verdict: { kind: "escalated", reason: "verdict_escalate" },
        latencyMs,
        rawResponse: raw,
        promptHash,
      };
    }

    // 置信度阈值检查 —— 低于阈值不执行,降级到 marker
    if (output.confidence < this.confidenceThreshold) {
      this.auditSuccess(input, promptHash, latencyMs, output, true, true);
      return {
        verdict: { kind: "escalated", reason: "low_confidence" },
        latencyMs,
        rawResponse: raw,
        promptHash,
      };
    }

    this.auditSuccess(input, promptHash, latencyMs, output, false);
    return {
      verdict: { kind: "resolved", output },
      latencyMs,
      rawResponse: raw,
      promptHash,
    };
  }

  private auditSuccess(
    input: LlmMergeInput,
    promptHash: string,
    latencyMs: number,
    output: LlmMergeOutput,
    escalated: boolean,
    lowConfidence = false,
  ): void {
    if (!this.auditLog) return;
    this.auditLog.append({
      actor: "system",
      action: escalated
        ? "merge_llm_arbitrated_escalated"
        : "merge_llm_arbitrated",
      metadata: {
        path: input.path,
        conflictType: input.conflictType,
        fieldName: input.fieldName,
        promptHash,
        verdict: output.verdict,
        confidence: output.confidence,
        rationale: output.rationale,
        latencyMs,
        provider: this.providerName,
        ...(lowConfidence ? { lowConfidence: true } : {}),
        ...(escalated ? { escalated: true } : {}),
      },
    });
  }

  private auditFailure(
    input: LlmMergeInput,
    promptHash: string,
    latencyMs: number,
    rawResponse: string | undefined,
    errorMessage: string,
  ): void {
    if (!this.auditLog) return;
    this.auditLog.append({
      actor: "system",
      action: "merge_llm_arbitrated_failed",
      metadata: {
        path: input.path,
        conflictType: input.conflictType,
        fieldName: input.fieldName,
        promptHash,
        latencyMs,
        provider: this.providerName,
        error: errorMessage,
        ...(rawResponse !== undefined
          ? { rawResponseLength: rawResponse.length }
          : {}),
      },
    });
  }
}

/**
 * 计算 prompt 短哈希(SHA256 前 12 hex 字符)。
 *
 * 用于 audit + 异常检测:若大量调用的 promptHash 突然变化,说明 prompt 漂移。
 */
function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}
