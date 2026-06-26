/**
 * 工具包装层：行为信号收集（P4 A.2）
 *
 * 在 Tool.execute 前后插入 SignalSink.append,自动捕获工具调用事件,
 * 不依赖 agent 主动上报。
 *
 * 工作流：
 *   1. host 创建 ToolContext 时注入 sessionId + signalSink
 *   2. 调 wrapToolWithSignalSink(tool) 得到包装版本
 *   3. 包装版本在 execute 前后 append ToolCallEvent
 *
 * 关键：append 是 fire-and-forget；失败不阻塞工具执行本身。
 *
 * @module @co-engram/core/tools
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolCallEvent } from "../signals/types.js";

/**
 * 包装一个工具：自动收集行为信号
 *
 * @param tool 原始工具
 * @returns 包装后的工具（接口相同）
 */
export function wrapToolWithSignalSink<I, O>(tool: Tool<I, O>): Tool<I, O> {
  return {
    ...tool,
    async execute(input: I, ctx: ToolContext): Promise<O> {
      const startedAt = Date.now();
      let result: O;
      let error: unknown;
      let retrievedEngramIds: readonly string[] | undefined;

      try {
        result = await tool.execute(input, ctx);
        retrievedEngramIds = extractEngramIds(tool.name, input, result);
        return result;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        // 即使出错也记录事件（失败也是信号）
        if (ctx.signalSink) {
          const event: ToolCallEvent = {
            toolName: tool.name,
            input: sanitizeInput(input),
            outputSummary: error
              ? `error: ${summarizeError(error)}`
              : summarizeResult(result!),
            retrievedEngramIds,
            sessionId: ctx.sessionId ?? randomUUID(),
            at: startedAt,
          };
          // fire-and-forget：失败不阻塞工具调用本身
          try {
            ctx.signalSink.append(event);
          } catch {
            // intentional no-op
          }
        }
      }
    },
  };
}

/**
 * 批量包装工具注册表里的所有工具
 */
export function wrapAllToolsWithSignalSink<I, O>(
  tools: readonly Tool<I, O>[],
): readonly Tool<I, O>[] {
  return tools.map((t) => wrapToolWithSignalSink(t));
}

// ============================================================
// 工具特定的输出解析
// ============================================================

/**
 * 从工具调用结果中提取涉及的 engram id 列表
 *
 * 不同工具的输出结构不同：
 *   - engram_get / engram_create：直接返回 EngramView / { id }
 *   - engram_search / engram_list：返回 { hits: [{ id }] } 或 [{ id }]
 *   - synapse_create：返回 { id }（synapse id，不是 engram id）
 *   - 其他：无
 */
function extractEngramIds<I, O>(
  toolName: string,
  input: I,
  result: O,
): readonly string[] | undefined {
  if (result === null || result === undefined) return undefined;

  // engram_get / engram_update：input.id 即为 engram id
  if (toolName === "engram_get" || toolName === "engram_update") {
    const id = (input as { id?: unknown })?.id;
    return typeof id === "string" ? [id] : undefined;
  }

  // engram_create：result.id 即为新建 engram id
  if (toolName === "engram_create") {
    const id = (result as { id?: unknown })?.id;
    return typeof id === "string" ? [id] : undefined;
  }

  // engram_search / engram_list：result.hits[].id 或 result[].id
  if (toolName === "engram_search" || toolName === "engram_list") {
    if (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result)
    ) {
      const hits = (result as { hits?: unknown }).hits;
      if (Array.isArray(hits)) {
        const ids = hits
          .map((h) => (h as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string");
        return ids.length > 0 ? ids : undefined;
      }
    }
    if (Array.isArray(result)) {
      const ids = result
        .map((r) => (r as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string");
      return ids.length > 0 ? ids : undefined;
    }
    return undefined;
  }

  // 其他工具：不提取 engram id
  return undefined;
}

/**
 * 简化 input（去掉可能的 binary / 大字段,只保留可序列化部分）
 */
function sanitizeInput<I>(input: I): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object") {
    return { value: input };
  }
  // 只保留顶层 string / number / boolean 字段；嵌套对象/array 保留引用但不深拷
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") {
      // 截断长字符串（避免 signals.jsonl 膨胀）
      sanitized[k] = v.length > 500 ? v.slice(0, 500) + "..." : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      sanitized[k] = v;
    } else if (Array.isArray(v)) {
      // 数组只保留 length
      sanitized[k] = `<array:${v.length}>`;
    } else if (v !== null && typeof v === "object") {
      sanitized[k] = "<object>";
    }
  }
  return sanitized;
}

function summarizeResult<O>(result: O): string {
  if (result === null || result === undefined) return "null";
  if (typeof result === "string") {
    return result.length > 200 ? result.slice(0, 200) + "..." : result;
  }
  if (typeof result !== "object") return String(result);
  // 对象：取前几个 key 的概要
  const keys = Object.keys(result as object);
  if (keys.length === 0) return "{}";
  // 如果有 hits 字段，重点摘要
  const hits = (result as { hits?: unknown[] }).hits;
  if (Array.isArray(hits)) {
    return `{hits: ${hits.length}}`;
  }
  // 否则只返回 key 列表
  return `{${keys.slice(0, 5).join(",")}}`;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
