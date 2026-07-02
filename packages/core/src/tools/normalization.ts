/**
 * 输入规范化与校验管道(P0-3 / P1-72 / P1-78 修复)
 *
 * 单一抽象层,提供 validateInput 的强化版 parseAndNormalize:
 *   - `.strict()` 拒绝 unknown keys(P0-3 修复:Zod 默认 strip 让 filter 字段
 *     错写都被静默吞,导致调试困难)
 *   - ULID 字段 `.toUpperCase()` 规范化(P1-78 修复:ULID 规范本身大小写不
 *     敏感,但工具层未做规范化,小写输入会返回 INVALID_ID)
 *
 * 向后兼容:既有工具继续用 validateInput(schema, raw);新工具或修复后的
 * 工具改用 parseAndNormalize(schema, raw, { ulidFields: [...] })。
 *
 * @module @co-engram/core/tools
 */

import type { ZodTypeAny } from "zod";

/** ULID canonical 字符集(Crockford base32,大小写不敏感) */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 把任何 ULID-like 字符串规范化为 canonical 大写形式。
 *
 * 用于工具入口的 id / synapseId / fromId / toId 字段。
 * 输入不匹配 ULID 格式时返回原值(让下游 lookup 抛 INVALID_ID,不在此处校验)。
 */
export function normalizeUlid(input: string): string {
  const upper = input.toUpperCase();
  return upper;
}

/**
 * 强化版输入校验。
 *
 * 行为:
 *   1. 用 `schema.strict().safeParse(raw)`(拒绝 unknown keys)
 *   2. 对 `opts.ulidFields` 列出的字段做 `.toUpperCase()` 规范化
 *   3. 失败时抛与 validateInput 同样格式的错误(便于调用方统一捕获)
 *
 * 与 validateInput 的差异:
 *   - validateInput 默认 strip unknown keys(向后兼容,但隐藏 typo)
 *   - parseAndNormalize 强制 strict + 可选 ULID 规范化(显式安全)
 *
 * 建议新工具或修复后的工具用 parseAndNormalize;既有工具保持 validateInput。
 */
export function parseAndNormalize<T>(
  schema: ZodTypeAny,
  raw: unknown,
  options: {
    /** 需要做 ULID `.toUpperCase()` 规范化的字段名列表 */
    readonly ulidFields?: readonly string[];
  } = {},
): T {
  // 先做 ULID 规范化(如果 raw 是对象且有 ulidFields)
  const normalized: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : (raw as Record<string, unknown>);

  if (options.ulidFields && normalized && typeof normalized === "object") {
    for (const field of options.ulidFields) {
      const value = (normalized as Record<string, unknown>)[field];
      if (typeof value === "string") {
        (normalized as Record<string, unknown>)[field] =
          normalizeUlid(value);
      }
    }
  }

  const strictSchema = (schema as unknown as { strict: () => ZodTypeAny })
    .strict
    ? ((schema as unknown as { strict: () => ZodTypeAny }).strict() as ZodTypeAny)
    : schema;

  const result = strictSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid input: ${issues}`);
  }
  return result.data as T;
}
