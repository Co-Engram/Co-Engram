import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { EngramRepository } from "../src/storage/repository.js";
import {
  wrapToolWithSignalSink,
  wrapAllToolsWithSignalSink,
  type Tool,
  type ToolContext,
} from "../src/tools/index.js";
import { MemorySignalSink } from "../src/signals/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-wrapped-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 测试用 mock 工具
// ============================================================

function makeEchoTool(name: string): Tool<{ msg: string }, { echoed: string }> {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: z.object({ msg: z.string() }),
    execute: async (input) => ({ echoed: input.msg }),
  };
}

function makeThrowingTool(name: string): Tool<{ msg: string }, never> {
  return {
    name,
    description: `mock ${name} that always throws`,
    inputSchema: z.object({ msg: z.string() }),
    execute: async () => {
      throw new Error("intentional failure");
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repository: repo,
    ...overrides,
  };
}

// ============================================================
// wrapToolWithSignalSink
// ============================================================

describe("wrapToolWithSignalSink", () => {
  it("execute 后 sink 收到 ToolCallEvent", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("mock_echo"));
    const ctx = makeCtx({ sessionId: "s1", signalSink: sink });

    await wrapped.execute({ msg: "hello" }, ctx);

    const events = sink.drain();
    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("mock_echo");
    expect(events[0]!.sessionId).toBe("s1");
    expect(events[0]!.input).toEqual({ msg: "hello" });
  });

  it("at 字段是触发时间（毫秒）", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("t"));
    const ctx = makeCtx({ signalSink: sink });

    const before = Date.now();
    await wrapped.execute({ msg: "x" }, ctx);
    const after = Date.now();

    const events = sink.drain();
    expect(events[0]!.at).toBeGreaterThanOrEqual(before);
    expect(events[0]!.at).toBeLessThanOrEqual(after);
  });

  it("工具抛错时仍记录事件（失败也是信号）", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeThrowingTool("boom"));
    const ctx = makeCtx({ signalSink: sink });

    await expect(wrapped.execute({ msg: "x" }, ctx)).rejects.toThrow(
      "intentional failure",
    );

    const events = sink.drain();
    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("boom");
    expect(events[0]!.outputSummary).toContain("error");
    expect(events[0]!.outputSummary).toContain("intentional failure");
  });

  it("未注入 signalSink 时正常运行（不影响功能）", async () => {
    const wrapped = wrapToolWithSignalSink(makeEchoTool("no_sink"));
    const ctx = makeCtx();

    const result = await wrapped.execute({ msg: "x" }, ctx);
    expect(result).toEqual({ echoed: "x" });
  });

  it("未注入 sessionId 时自动生成 UUID", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("auto_uuid"));
    const ctx = makeCtx({ signalSink: sink });

    await wrapped.execute({ msg: "x" }, ctx);
    const event = sink.drain()[0]!;
    expect(event.sessionId).toBeTruthy();
    expect(typeof event.sessionId).toBe("string");
    expect(event.sessionId.length).toBeGreaterThan(10);
  });

  it("多次调用 sessionId 各自独立（如果 ctx.sessionId 不同）", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("multi"));
    const ctx1 = makeCtx({ sessionId: "A", signalSink: sink });
    const ctx2 = makeCtx({ sessionId: "B", signalSink: sink });

    await wrapped.execute({ msg: "x" }, ctx1);
    await wrapped.execute({ msg: "y" }, ctx2);

    const events = sink.drain();
    expect(events[0]!.sessionId).toBe("A");
    expect(events[1]!.sessionId).toBe("B");
  });

  it("工具结果字段保持原样（不被 wrapper 改变）", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("intact"));
    const ctx = makeCtx({ signalSink: sink });

    const result = await wrapped.execute({ msg: "payload" }, ctx);
    expect(result).toEqual({ echoed: "payload" });
  });

  it("工具元信息（name/description/inputSchema）保留", () => {
    const wrapped = wrapToolWithSignalSink(makeEchoTool("meta_test"));
    expect(wrapped.name).toBe("meta_test");
    expect(wrapped.description).toBe("mock meta_test");
    expect(wrapped.inputSchema).toBeDefined();
  });

  it("input 长字符串自动截断", async () => {
    const sink = new MemorySignalSink();
    const wrapped = wrapToolWithSignalSink(makeEchoTool("trunc"));
    const ctx = makeCtx({ signalSink: sink });

    const longMsg = "a".repeat(800);
    await wrapped.execute({ msg: longMsg }, ctx);

    const event = sink.drain()[0]!;
    expect((event.input.msg as string).length).toBeLessThan(600);
    expect(event.input.msg as string).toContain("...");
  });

  it("outputSummary 包含 hits 摘要", async () => {
    const sink = new MemorySignalSink();
    const mockTool: Tool<{ q: string }, { hits: Array<{ id: string }> }> = {
      name: "engram_search",
      description: "mock",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({
        hits: [{ id: "a" }, { id: "b" }, { id: "c" }],
      }),
    };
    const wrapped = wrapToolWithSignalSink(mockTool);
    const ctx = makeCtx({ signalSink: sink });

    await wrapped.execute({ q: "x" }, ctx);
    const event = sink.drain()[0]!;
    expect(event.outputSummary).toBe("{hits: 3}");
    expect(event.retrievedEngramIds).toEqual(["a", "b", "c"]);
  });

  it("engram_get 的 retrievedEngramIds 来自 input.id", async () => {
    const sink = new MemorySignalSink();
    const mockTool: Tool<{ id: string }, { id: string; title: string }> = {
      name: "engram_get",
      description: "mock",
      inputSchema: z.object({ id: z.string() }),
      execute: async (input) => ({ id: input.id, title: "x" }),
    };
    const wrapped = wrapToolWithSignalSink(mockTool);
    const ctx = makeCtx({ signalSink: sink });

    await wrapped.execute({ id: "eng-42" }, ctx);
    const event = sink.drain()[0]!;
    expect(event.retrievedEngramIds).toEqual(["eng-42"]);
  });
});

// ============================================================
// wrapAllToolsWithSignalSink
// ============================================================

describe("wrapAllToolsWithSignalSink", () => {
  it("批量包装：每个都被包", async () => {
    const sink = new MemorySignalSink();
    const tools = [makeEchoTool("t1"), makeEchoTool("t2"), makeEchoTool("t3")];
    const wrapped = wrapAllToolsWithSignalSink(tools);
    expect(wrapped).toHaveLength(3);
    const ctx = makeCtx({ signalSink: sink });

    for (const t of wrapped) {
      await t.execute({ msg: "x" }, ctx);
    }

    const events = sink.drain();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.toolName)).toEqual(["t1", "t2", "t3"]);
  });

  it("空数组 → 空数组", () => {
    expect(wrapAllToolsWithSignalSink([])).toEqual([]);
  });

  it("原工具不被修改", async () => {
    const original = makeEchoTool("orig");
    const wrapped = wrapAllToolsWithSignalSink([original]);
    const sink = new MemorySignalSink();
    const ctx = makeCtx({ signalSink: sink });

    // 调用 wrapped 应该不影响 original
    await wrapped[0]!.execute({ msg: "x" }, ctx);
    await original.execute({ msg: "y" }, makeCtx());

    const events = sink.drain();
    expect(events).toHaveLength(1); // 只有 wrapped 调用产生事件
    expect(events[0]!.input).toEqual({ msg: "x" });
  });
});
