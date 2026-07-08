/**
 * Zod error → 用户友好消息 formatter(hyper-pattern 3 修复)
 *
 * 把 Zod 内部字段(inclusive/exact/code/path)翻译成自然语言,让挑剔用户能看懂。
 *
 * 例:
 *   - too_small + path=["limit"] + minimum=0 + inclusive=false + exact=false
 *     → "limit: value must be greater than 0"
 *   - too_big + path=["limit"] + maximum=500 + inclusive=true + exact=false
 *     → "limit: value must be at most 500"
 *   - invalid_type + path=["createdBy"] + expected="string" + received="number"
 *     → "createdBy: expected string, received number"
 *
 * @module @co-engram/core/tools
 */

import type { ZodError } from "zod";
import { validationError, type EngramToolError } from "./error-schema.js";

/**
 * Zod issue 的最小子集(兼容 Zod 3 / 4 不同 issue shape)。
 *
 * Zod 4 把 `inclusive / exact / code` 等暴露为 issue 顶层字段,
 * 而 Zod 3 嵌在 message 里。本 formatter 只关心这些常见字段,缺失字段按
 * undefined 处理,fallback 到 message 原文。
 */
interface ZodIssueLike {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
  // 数值边界(too_small / too_big)
  readonly minimum?: number;
  readonly maximum?: number;
  readonly inclusive?: boolean;
  readonly exact?: boolean;
  // 类型不符(invalid_type)
  readonly expected?: string;
  readonly received?: string;
  // 枚举(invalid_enum_value / invalid_union_discriminator)
  readonly options?: readonly unknown[];
  // 字面量(invalid_literal)
  readonly expectedLiteral?: unknown;
  // 未识别键(unrecognized_keys)
  readonly keys?: readonly string[];
  // 字符串格式(invalid_string)
  readonly validation?: string | { readonly startsWith?: string; readonly endsWith?: string; readonly includes?: string };
}

/**
 * 把单个 Zod issue 翻译成自然语言。
 *
 * 优先匹配 code,缺失字段 fallback 到 issue.message 原文。
 */
function formatIssue(issue: ZodIssueLike): string {
  const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  switch (issue.code) {
    case "invalid_type": {
      const exp = issue.expected ?? "unknown";
      const rec = issue.received ?? "unknown";
      return `${field}: expected ${exp}, received ${rec}`;
    }
    case "too_small": {
      const min = issue.minimum;
      if (typeof min === "number") {
        if (issue.inclusive === false) {
          return `${field}: value must be greater than ${min}`;
        }
        return `${field}: value must be at least ${min}`;
      }
      return `${field}: ${issue.message}`;
    }
    case "too_big": {
      const max = issue.maximum;
      if (typeof max === "number") {
        if (issue.inclusive === false) {
          return `${field}: value must be less than ${max}`;
        }
        return `${field}: value must be at most ${max}`;
      }
      return `${field}: ${issue.message}`;
    }
    case "invalid_string": {
      const v = issue.validation;
      if (typeof v === "string") {
        return `${field}: string must match ${v}`;
      }
      if (v && typeof v === "object") {
        if (v.startsWith !== undefined) {
          return `${field}: string must start with "${v.startsWith}"`;
        }
        if (v.endsWith !== undefined) {
          return `${field}: string must end with "${v.endsWith}"`;
        }
        if (v.includes !== undefined) {
          return `${field}: string must include "${v.includes}"`;
        }
      }
      return `${field}: ${issue.message}`;
    }
    case "invalid_enum_value": {
      const opts = issue.options ?? [];
      const optsStr = opts.map((o) => String(o)).join(", ");
      return `${field}: value must be one of [${optsStr}]`;
    }
    case "invalid_union_discriminator": {
      const opts = issue.options ?? [];
      const optsStr = opts.map((o) => String(o)).join(", ");
      return `${field}: discriminator must be one of [${optsStr}]`;
    }
    case "invalid_literal": {
      const lit = issue.expectedLiteral;
      return `${field}: value must equal ${JSON.stringify(lit)}`;
    }
    case "unrecognized_keys": {
      const keys = issue.keys ?? [];
      return `${field}: unrecognized keys [${keys.join(", ")}] — remove them or check for typos`;
    }
    case "invalid_date":
      return `${field}: expected a valid Date`;
    case "not_finite":
      return `${field}: value must be a finite number (received Infinity or NaN)`;
    case "custom":
      return `${field}: ${issue.message}`;
    default:
      // Fallback:Zod 4 有新 code(如 invalid_intersection),保留原文但加 field 前缀
      return `${field}: ${issue.message}`;
  }
}

/**
 * 把 path 转成 dotted field name(供 resourceId 用)。
 *
 * ["filter", "domainTags", 0] → "filter.domainTags[0]"
 */
function pathToField(path: readonly (string | number)[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((p, i) => {
      if (typeof p === "number") {
        return `[${p}]`;
      }
      return i === 0 ? String(p) : `.${p}`;
    })
    .join("");
}

/**
 * 把 ZodError 翻译成 EngramToolError(code="VALIDATION")。
 *
 * 多 issue 时合并为 "field1: msg1; field2: msg2",resourceId 取第一个 issue 的 path。
 *
 * @example
 * const err = formatZodError(zodErr);
 * throw err; // 抛 EngramToolError,可被 host adapter 序列化给 LLM
 */
export function formatZodError(error: ZodError): EngramToolError {
  const issues = (error.issues ?? []) as readonly ZodIssueLike[];
  if (issues.length === 0) {
    // ZodError 没有任何 issue 是异常情况,fallback 到通用消息
    return validationError("Input validation failed (no specific issues reported).");
  }

  const formatted = issues.map(formatIssue).join("; ");
  const firstIssue = issues[0];
  const resourceId =
    firstIssue && firstIssue.path.length > 0
      ? pathToField(firstIssue.path)
      : undefined;

  // suggestion:针对常见错误给 actionable 引导
  let suggestion: string | undefined;
  if (issues.some((i) => i.code === "too_small" || i.code === "too_big")) {
    suggestion =
      "Check the field's numeric bounds in the tool description and pass a value within the valid range.";
  } else if (issues.some((i) => i.code === "invalid_type")) {
    suggestion =
      "Check the field's expected type in the tool description and pass the correct JSON type.";
  } else if (issues.some((i) => i.code === "unrecognized_keys")) {
    suggestion =
      "The schema is strict. Remove unknown keys or check the tool description for the exact field list.";
  } else if (issues.some((i) => i.code === "invalid_enum_value")) {
    suggestion =
      "Check the tool description for the list of allowed enum values.";
  }

  return validationError(`Invalid input: ${formatted}`, {
    suggestion,
    resourceId,
  });
}

/**
 * 类型守卫:判断 unknown 是否为 ZodError(duck-type:有 issues 数组)。
 *
 * 用于 host adapter catch 块,区分 EngramToolError / ZodError / 普通 Error。
 */
export function isZodErrorLike(err: unknown): err is ZodError {
  return (
    err instanceof Error &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * 把任意 thrown 值序列化为 host adapter 友好的错误 payload。
 *
 * 三种情况:
 *   1. EngramToolError:直接 toJSON,保留 code/resourceId/suggestion/retryable
 *   2. ZodError(duck-type):经 formatZodError 转 VALIDATION 错误(防御性 —
 *      工具层若直接 throw ZodError 不走 validateInput,host 仍能格式化)
 *   3. 其他 Error / 非 Error:包成 INTERNAL,保留 message
 *
 * Host adapter 用法:
 *   ```ts
 *   catch (err) {
 *     const payload = serializeToolError(err);
 *     return { isError: true, content: [{ type: "text", text: payload.text }], ...payload.fields };
 *   }
 *   ```
 *
 * 返回 `text` 用于人类/LLM 阅读,`fields` 用于结构化字段透传。
 */
export function serializeToolError(err: unknown): {
  readonly text: string;
  readonly fields: import("./error-schema.js").EngramToolErrorSchema;
} {
  // 情况 1:已经是 EngramToolError — 直接序列化
  if (
    err instanceof Error &&
    (err as { code?: unknown }).code !== undefined &&
    typeof (err as { toJSON?: unknown }).toJSON === "function"
  ) {
    const engramErr = err as import("./error-schema.js").EngramToolError;
    const schema = engramErr.toJSON();
    const suggestionSuffix = schema.suggestion
      ? `\n\nSuggestion: ${schema.suggestion}`
      : "";
    const retrySuffix =
      schema.retryable && schema.retryAfterMs
        ? `\nRetryable: yes, retry after ${schema.retryAfterMs}ms.`
        : "";
    return {
      text: `Error [${schema.code}]: ${schema.message}${suggestionSuffix}${retrySuffix}`,
      fields: schema,
    };
  }
  // 情况 2:ZodError(duck-type) — 经 formatZodError 翻译
  if (isZodErrorLike(err)) {
    const formatted = formatZodError(err);
    const schema = formatted.toJSON();
    const suggestionSuffix = schema.suggestion
      ? `\n\nSuggestion: ${schema.suggestion}`
      : "";
    return {
      text: `Error [${schema.code}]: ${schema.message}${suggestionSuffix}`,
      fields: schema,
    };
  }
  // 情况 3:普通 Error / 字符串 / 其他 — INTERNAL
  const message = err instanceof Error ? err.message : String(err);
  return {
    text: `Error [INTERNAL]: ${message}`,
    fields: {
      code: "INTERNAL",
      message,
    },
  };
}
