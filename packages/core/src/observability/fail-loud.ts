/**
 * Fail-loud framework（hyper-pattern 1 修复）
 *
 * 把工具层的 "silent fallback / silent close / silent swallow" 全部改为
 * 结构化错误(EngramToolError),让 host adapter 能透传 actionable 信号给 LLM。
 *
 * 三件套:
 *   1. {@link wrapToolWithErrorBoundary} — 包装工具 execute,plain Error → EngramToolError
 *   2. {@link acquireLockOrThrow} — 显式 lock 获取,失败抛 LOCK_BUSY(不是 silent retry)
 *   3. {@link assertNever} — 穷举性检查,discriminated union 漏 case 时 fail-loud
 *
 * 设计哲学:与 wrapped.ts(signal sink)互补 ——
 *   - signal sink 是 fire-and-forget telemetry,失败不阻塞
 *   - fail-loud 是契约强制,失败必须 actionable 化
 * 两者可叠加:wrapAllToolsWithSignalSink(wrapAllToolsWithErrorBoundary(tools))
 *
 * @module @co-engram/core/observability
 */

import type { Tool, ToolContext } from "../tools/tool.js";
import {
  isEngramToolError,
  internalError,
  lockBusyError,
} from "../tools/error-schema.js";
import {
  acquireProcessLock,
  type ProcessLock,
  type ProcessLockOptions,
} from "../concurrency/process-lock.js";

/**
 * 包装工具 execute,catch 任何非 EngramToolError 的 throw 并转为 INTERNAL。
 *
 * - 已 EngramToolError 化的错误(NOT_FOUND / VALIDATION / LLM_UNAVAILABLE 等)
 *   原样透传,不破坏既有契约。
 * - 裸 Error / string / object throw → INTERNAL(带 cause 供 debug)。
 *
 * 这层 wrapper 保证:host adapter(register.ts / adapter.ts)的 catch 永远
 * 只看到 EngramToolError,序列化路径唯一化。
 */
export function wrapToolWithErrorBoundary<I, O>(
  tool: Tool<I, O>,
): Tool<I, O> {
  return {
    ...tool,
    async execute(input: I, ctx: ToolContext): Promise<O> {
      try {
        return await tool.execute(input, ctx);
      } catch (err) {
        if (isEngramToolError(err)) throw err;
        if (typeof err === "string") {
          throw internalError(
            `Tool '${tool.name}' threw string: ${err}`,
          );
        }
        if (err instanceof Error) {
          throw internalError(
            `Tool '${tool.name}' unexpected error: ${err.message}`,
            err,
          );
        }
        // object / number / null 等
        throw internalError(
          `Tool '${tool.name}' threw non-Error value: ${safeStringify(err)}`,
        );
      }
    },
  };
}

/**
 * 批量包装工具(对应 wrapAllToolsWithSignalSink)。
 *
 * 调用顺序(signal sink 在外层,error boundary 在内层):
 *   wrapAllToolsWithSignalSink(wrapAllToolsWithErrorBoundary(tools))
 *
 * 让 error boundary 先把裸 Error 转 EngramToolError,signal sink 看到的就是
 * 结构化错误,summarizeError 可以提取 code/message。
 */
export function wrapAllToolsWithErrorBoundary<I, O>(
  tools: readonly Tool<I, O>[],
): readonly Tool<I, O>[] {
  return tools.map((t) => wrapToolWithErrorBoundary(t));
}

/**
 * 显式获取 process lock,失败立即抛 LOCK_BUSY(不进 retry)。
 *
 * 与 {@link acquireProcessLock} 的区别:
 *   - acquireProcessLock 是 non-blocking,isHolder=false 时降级为 non-holder 继续运行
 *   - acquireLockOrThrow 是 strict —— 无法获取时直接 throw,让调用方决定(报错 / 重试 / 放弃)
 *
 * 用途:必须持有锁才能执行的场景(maintenance / batch operations / cross-host sync)。
 * 普通工具调用不需要(默认 ProcessLock 已保证后台任务互斥)。
 *
 * @throws EngramToolError code="LOCK_BUSY" — 当无法立即获取锁时
 */
export function acquireLockOrThrow(opts: ProcessLockOptions): ProcessLock {
  const lock = acquireProcessLock(opts);
  if (!lock.isHolder) {
    const resourceId =
      opts.lockPath ?? `${opts.dataRoot}/.co-engram/agent.lock`;
    lock.release();
    throw lockBusyError(resourceId);
  }
  return lock;
}

/**
 * 穷举性检查:discriminated union 漏 case 时 fail-loud。
 *
 * 用于 switch (x.kind) {...; default: assertNever(x, "MySwitch")}
 * TypeScript 编译期检查 union 完整性,运行期(意外漏 case 时)抛 INTERNAL 错误。
 *
 * @example
 *   switch (event.kind) {
 *     case "create": ...
 *     case "update": ...
 *     default: assertNever(event, "audit-loop")
 *   }
 */
export function assertNever(value: never, context: string): never {
  throw internalError(
    `Exhaustiveness check failed in ${context}: unexpected value ${safeStringify(value)}`,
  );
}

/**
 * 安全 stringify:循环引用 / BigInt / 含函数对象时不抛错。
 *
 * 仅用于 error message,不是通用序列化。
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, replacerValue) => {
      if (typeof replacerValue === "bigint") {
        return `[BigInt:${replacerValue.toString()}]`;
      }
      if (typeof replacerValue === "function") {
        return "[Function]";
      }
      if (typeof replacerValue === "undefined") {
        return "[undefined]";
      }
      return replacerValue as unknown;
    });
  } catch {
    return String(value);
  }
}
