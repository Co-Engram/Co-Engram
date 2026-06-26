import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileSignalSink,
  MemorySignalSink,
  createDefaultSignalSink,
  resetFileSignalSink,
  type ToolCallEvent,
} from "../src/signals/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-signals-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(
  overrides: Partial<ToolCallEvent> & { toolName: string },
): ToolCallEvent {
  return {
    input: {},
    sessionId: "sess-1",
    at: Date.now(),
    ...overrides,
  };
}

// ============================================================
// MemorySignalSink
// ============================================================

describe("MemorySignalSink", () => {
  it("append + drain：取出并清空", () => {
    const sink = new MemorySignalSink();
    const e1 = makeEvent({ toolName: "engram_get", input: { id: "a" } });
    const e2 = makeEvent({ toolName: "engram_search", input: { query: "x" } });

    sink.append(e1);
    sink.append(e2);
    expect(sink.size).toBe(2);

    const drained = sink.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toBe(e1);
    expect(drained[1]).toBe(e2);
    expect(sink.size).toBe(0);
  });

  it("drain 空缓冲 → []", () => {
    const sink = new MemorySignalSink();
    expect(sink.drain()).toEqual([]);
  });

  it("prune 保留新事件，删除旧事件", async () => {
    const sink = new MemorySignalSink();
    const now = Date.now();
    const old = makeEvent({
      toolName: "engram_get",
      at: now - 10 * 24 * 3600_000,
    }); // 10天前
    const recent = makeEvent({
      toolName: "engram_get",
      at: now - 1 * 3600_000,
    }); // 1小时前

    sink.append(old);
    sink.append(recent);

    await sink.prune(7 * 24 * 3600_000); // 保留 7 天
    const remaining = sink.peek();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(recent);
  });

  it("peek 不消费缓冲", () => {
    const sink = new MemorySignalSink();
    sink.append(makeEvent({ toolName: "engram_get" }));
    expect(sink.peek()).toHaveLength(1);
    expect(sink.size).toBe(1);
  });
});

// ============================================================
// FileSignalSink
// ============================================================

describe("FileSignalSink", () => {
  it("append + flush → 文件存在且包含 JSON", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const sink = new FileSignalSink({ filePath, flushThreshold: 1 });
    sink.append(makeEvent({ toolName: "engram_get", input: { id: "x" } }));

    await sink.flush();
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8").trim();
    expect(content).toContain('"toolName":"engram_get"');
    expect(content).toContain('"id":"x"');
  });

  it("未达 flushThreshold 时不自动写入文件", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const sink = new FileSignalSink({ filePath, flushThreshold: 3 });

    sink.append(makeEvent({ toolName: "a" }));
    sink.append(makeEvent({ toolName: "b" }));
    // 此时 buffer.length = 2 < threshold = 3，文件不存在
    expect(existsSync(filePath)).toBe(false);

    await sink.flush(); // 手动 flush
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("drain 返回文件中的事件并清空", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const sink = new FileSignalSink({ filePath, flushThreshold: 10 });

    sink.append(makeEvent({ toolName: "a", input: { x: 1 }, sessionId: "s1" }));
    sink.append(makeEvent({ toolName: "b", input: { y: 2 }, sessionId: "s2" }));
    await sink.flush();

    const drained = sink.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]!.toolName).toBe("a");
    expect(drained[1]!.toolName).toBe("b");

    // drain 后文件应被清空
    const drained2 = sink.drain();
    expect(drained2).toEqual([]);
  });

  it("drain 不存在的文件 → []", () => {
    const filePath = join(tmpDir, "nope.jsonl");
    const sink = new FileSignalSink({ filePath });
    expect(sink.drain()).toEqual([]);
  });

  it("drain 容忍损坏行", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    // 写入一行损坏数据 + 一行合法数据
    writeFileSync(
      filePath,
      "not-a-json\n" + JSON.stringify(makeEvent({ toolName: "a" })) + "\n",
      "utf8",
    );

    const sink = new FileSignalSink({ filePath });
    const drained = sink.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.toolName).toBe("a");
  });

  it("prune 保留近期事件、删除旧事件", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const now = Date.now();
    const sink = new FileSignalSink({ filePath, flushThreshold: 100 });

    sink.append(makeEvent({ toolName: "old", at: now - 10 * 24 * 3600_000 }));
    sink.append(makeEvent({ toolName: "recent", at: now - 1 * 3600_000 }));
    await sink.flush();

    await sink.prune(7 * 24 * 3600_000);

    const remaining = sink.drain();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.toolName).toBe("recent");
  });

  it("createDefaultSignalSink 工厂：路径位于 .co-engram/ 子目录", () => {
    const sink = createDefaultSignalSink(tmpDir);
    expect(sink).toBeInstanceOf(FileSignalSink);
    // 验证内部 filePath —— 与 audit.jsonl / proposals.jsonl 同一目录
    const internal = sink as unknown as { filePath: string };
    expect(internal.filePath).toBe(join(tmpDir, ".co-engram", "signals.jsonl"));
  });

  it("createDefaultSignalSink 迁移：legacy <dataRoot>/signals.jsonl → <dataRoot>/.co-engram/signals.jsonl", () => {
    // 1. 模拟老路径已有数据(0.x 版本遗留)
    const legacyPath = join(tmpDir, "signals.jsonl");
    const eventPayload =
      JSON.stringify(makeEvent({ toolName: "legacy" })) + "\n";
    writeFileSync(legacyPath, eventPayload, "utf8");

    // 2. 创建 sink —— 应触发自动迁移
    const sink = createDefaultSignalSink(tmpDir);
    void sink; // 仅验证副作用

    // 3. 老路径不再存在,新路径包含原数据
    expect(existsSync(legacyPath)).toBe(false);
    const newPath = join(tmpDir, ".co-engram", "signals.jsonl");
    expect(existsSync(newPath)).toBe(true);
    const migrated = readFileSync(newPath, "utf8");
    expect(migrated).toContain('"toolName":"legacy"');

    // 4. 新 sink 应能 drain 出迁移过来的事件
    const sink2 = createDefaultSignalSink(tmpDir);
    const drained = sink2.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.toolName).toBe("legacy");
  });

  it("createDefaultSignalSink 迁移：新路径已存在时不覆盖(用户已在 .co-engram/ 写过)", () => {
    // 老路径 + 新路径都有数据 → 不能让 rename 覆盖用户的最新数据
    const legacyPath = join(tmpDir, "signals.jsonl");
    const newPath = join(tmpDir, ".co-engram", "signals.jsonl");
    writeFileSync(
      legacyPath,
      JSON.stringify(makeEvent({ toolName: "legacy" })) + "\n",
      "utf8",
    );
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    writeFileSync(
      newPath,
      JSON.stringify(makeEvent({ toolName: "new-data" })) + "\n",
      "utf8",
    );

    createDefaultSignalSink(tmpDir);

    // 新路径内容仍是用户最新写入的 new-data,不被 legacy 覆盖
    const content = readFileSync(newPath, "utf8");
    expect(content).toContain('"toolName":"new-data"');
    expect(content).not.toContain('"toolName":"legacy"');
    // 老路径保留(迁移失败时 no-op,运维可手动合并)
    expect(existsSync(legacyPath)).toBe(true);
  });

  it("createDefaultSignalSink 迁移：无 legacy 文件时 no-op", () => {
    // 干净环境 → 不应有迁移副作用
    const sink = createDefaultSignalSink(tmpDir);
    void sink;
    // 新路径在首次 append/flush 之前可能不存在(构造函数不预创建)
    // 这里只验证老路径不会被无中生有地创建
    expect(existsSync(join(tmpDir, "signals.jsonl"))).toBe(false);
  });

  it("resetFileSignalSink：清空文件", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const sink = new FileSignalSink({ filePath, flushThreshold: 1 });
    sink.append(makeEvent({ toolName: "a" }));
    await sink.flush();
    expect(existsSync(filePath)).toBe(true);

    resetFileSignalSink(sink);
    expect(existsSync(filePath)).toBe(false);
  });

  it("多事件累积：JSONL 每行一个 JSON", async () => {
    const filePath = join(tmpDir, "signals.jsonl");
    const sink = new FileSignalSink({ filePath, flushThreshold: 100 });

    for (let i = 0; i < 5; i++) {
      sink.append(makeEvent({ toolName: `t${i}`, input: { i } }));
    }
    await sink.flush();

    const content = readFileSync(filePath, "utf8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as ToolCallEvent;
      expect(parsed.toolName).toMatch(/^t\d$/);
    }
  });

  it("EventEmitter 不泄漏:多个 sink 共享单例 exit handler", () => {
    // 回归:之前每个 sink 构造时都 process.once('beforeExit'/'exit'),
    // 创建 N 个 sink = 2N listeners,超过 maxListeners=10 → 警告。
    // 修复后:模块级单 Set 跟踪 sinks,只注册一次 exit handler。
    const baseline = process.listenerCount("beforeExit");
    const baselineExit = process.listenerCount("exit");

    const sinks: FileSignalSink[] = [];
    for (let i = 0; i < 15; i++) {
      sinks.push(new FileSignalSink({ filePath: join(tmpDir, `s${i}.jsonl`) }));
    }

    // 关键回归:listener 数不应随 sink 数线性增长
    // 全局 handler 只注册一次,可能由本测试之前任一用例触发,所以
    // 最终 listener 数应 ≤ baseline + 1(不能 > baseline + 1)
    expect(process.listenerCount("beforeExit")).toBeLessThanOrEqual(
      baseline + 1,
    );
    expect(process.listenerCount("exit")).toBeLessThanOrEqual(baselineExit + 1);

    // 再加 50 个,listener 数完全不变(已注册过了)
    const midBeforeExit = process.listenerCount("beforeExit");
    const midExit = process.listenerCount("exit");
    for (let i = 15; i < 65; i++) {
      sinks.push(new FileSignalSink({ filePath: join(tmpDir, `s${i}.jsonl`) }));
    }
    expect(process.listenerCount("beforeExit")).toBe(midBeforeExit);
    expect(process.listenerCount("exit")).toBe(midExit);

    // dispose 后 sink 不再被引用(模拟主动清理)
    for (const sink of sinks) {
      sink.dispose?.();
    }
  });
});
