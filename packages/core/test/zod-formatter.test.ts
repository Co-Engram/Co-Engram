/**
 * zod-formatter 单元测试
 *
 * hyper-pattern 3 验证:Zod 内部字段(inclusive/exact/code/path)被翻译成自然语言,
 * 让挑剔用户能看懂。
 */
import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import {
  formatZodError,
  isZodErrorLike,
  serializeToolError,
} from "../src/tools/zod-formatter.js";
import {
  EngramToolError,
  notFoundError,
  internalError,
} from "../src/tools/error-schema.js";

describe("formatZodError", () => {
  function parse<T>(schema: z.ZodTypeAny, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw formatZodError(result.error);
    }
    return result.data as T;
  }

  it("too_small + inclusive=false → 'greater than'", () => {
    const schema = z.object({ limit: z.number().int().positive() });
    try {
      parse(schema, { limit: 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EngramToolError);
      const e = err as EngramToolError;
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(/limit: value must be greater than 0/);
      expect(e.resourceId).toBe("limit");
      expect(e.suggestion).toMatch(/numeric bounds/);
    }
  });

  it("too_big + inclusive=true → 'at most'", () => {
    const schema = z.object({ limit: z.number().int().positive().max(500) });
    try {
      parse(schema, { limit: 1000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EngramToolError);
      const e = err as EngramToolError;
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(/limit: value must be at most 500/);
    }
  });

  it("invalid_type → 'expected X, received Y'", () => {
    const schema = z.object({ createdBy: z.string() });
    try {
      parse(schema, { createdBy: 42 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as EngramToolError;
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(/createdBy: expected string, received number/);
      expect(e.suggestion).toMatch(/expected type/);
    }
  });

  it("invalid_enum_value → 'must be one of [..]'", () => {
    const schema = z.object({
      verdict: z.enum(["keep_new", "keep_old", "merge", "archive"]),
    });
    try {
      parse(schema, { verdict: "lolcat" });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as EngramToolError;
      expect(e.message).toMatch(/verdict: value must be one of \[keep_new/);
    }
  });

  it("unrecognized_keys → 'unrecognized keys [..]'", () => {
    const schema = z
      .object({ name: z.string() })
      .strict();
    try {
      parse(schema, { name: "x", extra: "y" });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as EngramToolError;
      expect(e.message).toMatch(/unrecognized keys \[extra\]/);
      expect(e.suggestion).toMatch(/strict/);
    }
  });

  it("nested path → dotted resourceId", () => {
    const schema = z.object({
      filter: z.object({ domainTags: z.array(z.string()).min(1) }),
    });
    try {
      parse(schema, { filter: { domainTags: [] } });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as EngramToolError;
      expect(e.resourceId).toMatch(/filter\.domainTags/);
    }
  });

  it("multiple issues → joined with '; '", () => {
    const schema = z.object({
      a: z.number().positive(),
      b: z.string(),
    });
    try {
      parse(schema, { a: -1, b: 42 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as EngramToolError;
      // 两个 issue 用 "; " 连接,顺序为 schema 字段顺序
      expect(e.message).toMatch(/a:.*; b:/);
      expect(e.message).toMatch(/a: value must be greater than 0/);
      expect(e.message).toMatch(/b: expected string, received number/);
    }
  });
});

describe("isZodErrorLike", () => {
  it("true for ZodError", () => {
    const schema = z.number();
    const result = schema.safeParse("not a number");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isZodErrorLike(result.error)).toBe(true);
    }
  });

  it("false for plain Error", () => {
    expect(isZodErrorLike(new Error("plain"))).toBe(false);
  });

  it("false for non-error values", () => {
    expect(isZodErrorLike("string")).toBe(false);
    expect(isZodErrorLike(null)).toBe(false);
    expect(isZodErrorLike(undefined)).toBe(false);
  });
});

describe("serializeToolError", () => {
  it("serializes EngramToolError with all fields", () => {
    const err = notFoundError("Engram", "01ABC123", "Use search");
    const payload = serializeToolError(err);
    expect(payload.text).toMatch(/Error \[NOT_FOUND\]: Engram not found: 01ABC123/);
    expect(payload.text).toMatch(/Suggestion: Use search/);
    expect(payload.fields.code).toBe("NOT_FOUND");
    expect(payload.fields.resourceId).toBe("01ABC123");
    expect(payload.fields.suggestion).toBe("Use search");
  });

  it("serializes ZodError via formatZodError", () => {
    const schema = z.object({ limit: z.number().int().positive() });
    const result = schema.safeParse({ limit: -1 });
    if (!result.success) {
      const payload = serializeToolError(result.error);
      expect(payload.fields.code).toBe("VALIDATION");
      expect(payload.text).toMatch(/limit: value must be greater than 0/);
    }
  });

  it("serializes plain Error as INTERNAL", () => {
    const payload = serializeToolError(new Error("boom"));
    expect(payload.fields.code).toBe("INTERNAL");
    expect(payload.text).toMatch(/Error \[INTERNAL\]: boom/);
  });

  it("serializes string thrown as INTERNAL", () => {
    const payload = serializeToolError("string thrown");
    expect(payload.fields.code).toBe("INTERNAL");
    expect(payload.text).toMatch(/Error \[INTERNAL\]: string thrown/);
  });

  it("preserves retryable + retryAfterMs for LOCK_BUSY", () => {
    const err = internalError("test");
    const payload = serializeToolError(err);
    expect(payload.fields.code).toBe("INTERNAL");
    expect(payload.fields.retryable).toBe(false);
  });
});
