/**
 * fail-loud framework 单元测试（AI-1）
 *
 * 覆盖：
 *   - wrapToolWithErrorBoundary：plain Error / string / object / EngramToolError 透传
 *   - wrapAllToolsWithErrorBoundary：批量包装
 *   - acquireLockOrThrow：non-holder 抛 LOCK_BUSY / holder 正常返回
 *   - assertNever：抛 INTERNAL
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wrapToolWithErrorBoundary,
  wrapAllToolsWithErrorBoundary,
  acquireLockOrThrow,
  assertNever,
} from "../src/observability/fail-loud.js";
import {
  EngramToolError,
  notFoundError,
  internalError,
  isEngramToolError,
} from "../src/tools/error-schema.js";
import type { Tool, ToolContext } from "../src/tools/tool.js";

function makeTool<I, O>(
  name: string,
  impl: (input: I, ctx: ToolContext) => Promise<O> | O,
): Tool<I, O> {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: {
      safeParse: () => ({ success: true, data: undefined as unknown }),
    } as never,
    execute: impl,
  };
}

const fakeCtx = {} as ToolContext;

describe("wrapToolWithErrorBoundary", () => {
  it("透传成功结果", async () => {
    const tool = makeTool("ok", async () => "success");
    const wrapped = wrapToolWithErrorBoundary(tool);
    const result = await wrapped.execute(undefined as never, fakeCtx);
    expect(result).toBe("success");
  });

  it("透传 EngramToolError（不包装）", async () => {
    const original = notFoundError("Engram", "01ABC");
    const tool = makeTool("notfound", async () => {
      throw original;
    });
    const wrapped = wrapToolWithErrorBoundary(tool);
    try {
      await wrapped.execute(undefined as never, fakeCtx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBe(original); // 同一对象引用
      expect(isEngramToolError(err)).toBe(true);
      expect((err as EngramToolError).code).toBe("NOT_FOUND");
    }
  });

  it("plain Error → INTERNAL 包装", async () => {
    const tool = makeTool("buggy", async () => {
      throw new Error("boom");
    });
    const wrapped = wrapToolWithErrorBoundary(tool);
    try {
      await wrapped.execute(undefined as never, fakeCtx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as EngramToolError;
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toMatch(/Tool 'buggy' unexpected error: boom/);
      expect(e.cause).toBeInstanceOf(Error);
      expect((e.cause as Error).message).toBe("boom");
    }
  });

  it("string throw → INTERNAL", async () => {
    const tool = makeTool("stringThrow", async () => {
      throw "raw string";
    });
    const wrapped = wrapToolWithErrorBoundary(tool);
    try {
      await wrapped.execute(undefined as never, fakeCtx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as EngramToolError;
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toMatch(/threw string: raw string/);
    }
  });

  it("non-Error throw（object）→ INTERNAL", async () => {
    const tool = makeTool("objThrow", async () => {
      throw { code: 42, custom: true };
    });
    const wrapped = wrapToolWithErrorBoundary(tool);
    try {
      await wrapped.execute(undefined as never, fakeCtx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as EngramToolError;
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toMatch(/threw non-Error value/);
      expect(e.message).toMatch(/custom/);
    }
  });

  it("保留 tool 元信息（name/description/schema）", () => {
    const tool = makeTool("meta", async () => "ok");
    const wrapped = wrapToolWithErrorBoundary(tool);
    expect(wrapped.name).toBe("meta");
    expect(wrapped.description).toBe("test tool meta");
    expect(wrapped.inputSchema).toBe(tool.inputSchema);
  });
});

describe("wrapAllToolsWithErrorBoundary", () => {
  it("批量包装所有工具", async () => {
    const tools = [
      makeTool("a", async () => "a"),
      makeTool("b", async () => {
        throw new Error("b");
      }),
    ];
    const wrapped = wrapAllToolsWithErrorBoundary(tools);
    expect(wrapped.length).toBe(2);
    expect(await wrapped[0]!.execute(undefined as never, fakeCtx)).toBe("a");
    try {
      await wrapped[1]!.execute(undefined as never, fakeCtx);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      expect((err as EngramToolError).code).toBe("INTERNAL");
    }
  });

  it("空数组透传", () => {
    const wrapped = wrapAllToolsWithErrorBoundary([]);
    expect(wrapped.length).toBe(0);
  });
});

describe("acquireLockOrThrow", () => {
  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), "co-engram-fail-loud-"));
  }

  it("无竞争 → 返回 holder lock", () => {
    const dir = makeTmp();
    try {
      const lock = acquireLockOrThrow({
        dataRoot: dir,
        host: "test",
      });
      expect(lock.isHolder).toBe(true);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已有 holder → 抛 LOCK_BUSY", () => {
    const dir = makeTmp();
    try {
      // 先占一个
      const holder = acquireLockOrThrow({ dataRoot: dir, host: "first" });
      expect(holder.isHolder).toBe(true);

      // 第二个进程尝试 → 应抛
      try {
        acquireLockOrThrow({
          dataRoot: dir,
          host: "second",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(isEngramToolError(err)).toBe(true);
        const e = err as EngramToolError;
        expect(e.code).toBe("LOCK_BUSY");
        expect(e.retryable).toBe(true);
        expect(e.retryAfterMs).toBeGreaterThan(0);
        expect(e.resourceId).toContain("agent.lock");
        expect(e.message).toMatch(/locked by another process/);
      }
      holder.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("自定义 lockPath 在错误中体现", () => {
    const dir = makeTmp();
    const customLockPath = join(dir, "custom.lock");
    try {
      const holder = acquireLockOrThrow({
        dataRoot: dir,
        host: "first",
        lockPath: customLockPath,
      });
      try {
        acquireLockOrThrow({
          dataRoot: dir,
          host: "second",
          lockPath: customLockPath,
        });
        throw new Error("should have thrown");
      } catch (err) {
        const e = err as EngramToolError;
        expect(e.code).toBe("LOCK_BUSY");
        expect(e.resourceId).toBe(customLockPath);
      }
      holder.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertNever", () => {
  it("永远抛 INTERNAL", () => {
    // 用 unknown 强制调用,模拟漏 case
    const value: never = "unexpected" as never;
    try {
      assertNever(value, "test-switch");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as EngramToolError;
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toMatch(/Exhaustiveness check failed in test-switch/);
      expect(e.message).toContain("unexpected");
    }
  });
});

describe("fail-loud 与 signal sink 叠加（集成）", () => {
  it("wrapAllToolsWithErrorBoundary 在内层,signal sink 看到的永远是 EngramToolError", async () => {
    // 模拟 host adapter 的组合顺序
    const { wrapToolWithSignalSink } = await import("../src/tools/wrapped.js");
    const sink: unknown[] = [];
    const ctxWithSink = {
      ...fakeCtx,
      signalSink: { append: (e: unknown) => sink.push(e) },
    } as ToolContext;

    const tool = makeTool("buggy", async () => {
      throw new Error("inner bug");
    });
    // 错误边界在内层
    const bounded = wrapToolWithErrorBoundary(tool);
    // signal sink 在外层
    const wrapped = wrapToolWithSignalSink(bounded);

    try {
      await wrapped.execute(undefined as never, ctxWithSink);
      throw new Error("should have thrown");
    } catch (err) {
      // 外层最终看到 EngramToolError
      expect(isEngramToolError(err)).toBe(true);
      expect((err as EngramToolError).code).toBe("INTERNAL");
    }
    // signal sink 也记录了(包括 error summary)
    expect(sink.length).toBe(1);
    const event = sink[0] as { outputSummary: string };
    expect(event.outputSummary).toMatch(/error:/);
  });
});
