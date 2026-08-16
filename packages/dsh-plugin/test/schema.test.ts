import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodShapeToParameterSpec } from "../src/schema.js";

describe("zodShapeToParameterSpec", () => {
  it("标量:string/integer/number/boolean + required + description", () => {
    const spec = zodShapeToParameterSpec({
      q: z.string().describe("查询词"),
      limit: z.number().int().describe("返回上限"),
      score: z.number(),
      fresh: z.boolean(),
    });
    expect(spec.q).toEqual({ type: "string", required: true, description: "查询词" });
    expect(spec.limit).toEqual({ type: "integer", required: true, description: "返回上限" });
    expect(spec.score).toEqual({ type: "number", required: true });
    expect(spec.fresh).toEqual({ type: "boolean", required: true });
  });

  it("enum → enum 数组", () => {
    const spec = zodShapeToParameterSpec({
      kind: z.enum(["observation", "pattern"]).describe("记忆类型"),
    });
    expect(spec.kind).toEqual({
      type: "string",
      required: true,
      enum: ["observation", "pattern"],
      description: "记忆类型",
    });
  });

  it("literal → 单值 enum", () => {
    const spec = zodShapeToParameterSpec({ mode: z.literal("team") });
    expect(spec.mode).toEqual({ type: "string", required: true, enum: ["team"] });
  });

  it("optional/default → 无 required,保留 description", () => {
    const spec = zodShapeToParameterSpec({
      tag: z.string().optional().describe("标签"),
      n: z.number().default(5),
    });
    expect(spec.tag).toEqual({ type: "string", description: "标签" });
    expect(spec.n).toEqual({ type: "number" });
  });

  it("嵌套 object → object spec(additionalProperties false,内部 required 递归)", () => {
    const spec = zodShapeToParameterSpec({
      filter: z.object({ domain: z.string(), minScore: z.number().optional() }),
    });
    expect(spec.filter).toEqual({
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        domain: { type: "string", required: true },
        minScore: { type: "number" },
      },
    });
  });

  it("数组 → array spec(元素递归)", () => {
    const spec = zodShapeToParameterSpec({
      tags: z.array(z.string()),
      scores: z.array(z.number().int()),
    });
    expect(spec.tags).toEqual({ type: "array", required: true, items: { type: "string" } });
    expect(spec.scores).toEqual({ type: "array", required: true, items: { type: "integer" } });
  });

  it("不支持的类型(record/union)→ json fallback(必填保留 required)", () => {
    const spec = zodShapeToParameterSpec({
      meta: z.record(z.string()),
      either: z.union([z.string(), z.number()]),
      lazy: z.lazy(() => z.string()),
      extra: z.record(z.string()).optional().describe("可选元数据"),
    });
    expect(spec.meta).toEqual({ type: "json", required: true });
    expect(spec.either).toEqual({ type: "json", required: true });
    expect(spec.lazy).toEqual({ type: "json", required: true });
    expect(spec.extra).toEqual({ type: "json", description: "可选元数据" });
  });

  it("真实工具注册表全量转换:每个属性都有 type 且不抛异常", { timeout: 30_000 }, async () => {
    const { createToolRegistry } = await import("@co-engram/core");
    const tools = createToolRegistry().list();
    expect(tools.length).toBeGreaterThan(30);
    for (const tool of tools) {
      const schema = tool.inputSchema as unknown as {
        _def?: { shape?: () => Record<string, z.ZodTypeAny> };
        shape?: Record<string, z.ZodTypeAny>;
      };
      const shape =
        typeof schema._def?.shape === "function" ? schema._def.shape() : schema.shape;
      if (!shape) continue;
      const spec = zodShapeToParameterSpec(shape);
      for (const [k, v] of Object.entries(spec)) {
        expect(typeof k).toBe("string");
        expect(v).toHaveProperty("type");
      }
    }
  });
});
