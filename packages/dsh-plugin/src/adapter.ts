/**
 * core Tool → dsh ToolDefinition 适配
 *
 * 工具名用裸名(dsh 原生无前缀;同名冲突由 dsh 注册表 fail-loud)。
 * 直接构造 plain ToolDefinition(mcp-client 同款方式),不经 defineTool 工厂
 * —— 运行时零宿主依赖,对齐 openclaw-plugin 的最小接口惯例。
 *
 * @module @co-engram/dsh
 */
import {
  localizeToolDescription,
  serializeToolError,
  DEFAULT_LANGUAGE,
  type Language,
  type Tool,
  type ToolContext,
} from "@co-engram/core";
import type { z } from "zod";
import { zodShapeToParameterSpec } from "./schema.js";

/**
 * dsh ToolDefinition 的最小构造面(结构性兼容 @deepseek-ai/dsh-tools)。
 * output.schema 用 { type: 'json' }(dsh 的 unconstrained lossless JSON);
 * render 把 JSON 投影为 text 块。
 */
export interface DshToolLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: { readonly type: "json" };
    readonly render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: "text"; text: string }>;
  };
  readonly execute: (
    args: unknown,
    exec: { signal: AbortSignal },
  ) => Promise<unknown>;
}

/** 提取 zod shape(与 claude-code-mcp register.ts 的 extractZodShape 同源逻辑) */
function extractZodShape(
  tool: Tool,
): Record<string, z.ZodTypeAny> | undefined {
  const schema = tool.inputSchema as unknown as {
    _def?: { shape?: () => Record<string, z.ZodTypeAny> };
    shape?: Record<string, z.ZodTypeAny>;
  };
  try {
    if (schema && typeof schema._def?.shape === "function") {
      return schema._def.shape();
    }
    if (schema && schema.shape) return schema.shape;
  } catch {
    /* fallback 到空参数 */
  }
  return undefined;
}

/** 工具结果 → dsh ContentBlock[](JSON pretty 统一投影,渲染规则增强后置) */
export function renderToolResult(
  data: unknown,
): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

/** 单工具适配 */
export function adaptToolToDefinition(
  tool: Tool,
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): DshToolLike {
  const shape = extractZodShape(tool);
  const parameters = shape ? zodShapeToParameterSpec(shape) : {};
  const description = localizeToolDescription(
    tool.name,
    language,
    tool.description,
    "agent",
  );
  return {
    name: tool.name,
    description,
    parameters,
    output: {
      schema: { type: "json" },
      render: (_args, value) => renderToolResult(value),
    },
    async execute(args, _exec) {
      try {
        const result = await tool.execute(args ?? {}, ctx);
        // lossless 净化:core 工具返回的 TS 对象可含 undefined 可选字段
        // (如 engram_get tier=meta 的 updatedBy/encodingContext 等)。
        // MCP 路径经 JSON.stringify 静默剥离;dsh 对 execute 返回值逐项做
        // lossless JSON 校验,undefined 直接违规(Code Mode 子调用即报
        // "value is not lossless JSON")。JSON round-trip 剥 undefined/函数,
        // Date→ISO 字符串,对"意为 JSON"的工具返回语义无损。
        return JSON.parse(JSON.stringify(result ?? null));
      } catch (error) {
        // 结构化错误字段(code/resourceId/suggestion/retryable)序列化进 message,
        // 让 LLM 拿到 actionable 文本决定是否重试。
        throw new Error(serializeToolError(error).text);
      }
    },
  };
}

/** 批量适配(输入应为 error-bounded + profile 过滤后的工具序列) */
export function adaptAllTools(
  tools: readonly Tool[],
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): readonly DshToolLike[] {
  return tools.map((t) => adaptToolToDefinition(t, ctx, language));
}
