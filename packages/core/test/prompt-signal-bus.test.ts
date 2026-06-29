/**
 * PromptSignalBus + invalidating cache 单元测试(Task 3.4 Phase A)
 *
 * 验证:
 *   - bus.emit(event) → 所有订阅者收到
 *   - cache 收到事件后标记 stale 并触发 debounced rebuild
 *   - rebuild 完成后 snapshot 引用变化、revision 递增
 *
 * 注意:此测试不验证端到端 wiring(close_learning_loop / synapse_create 等真实 emit 点);
 * 那部分在 Task 3.4 Phase B 实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PromptSignalBus,
  type PromptSignalEvent,
} from "../src/prompt-signals/event-bus.js";
import {
  PromptSignalCache,
  type PromptSignalCacheOptions,
} from "../src/prompt-signals/cache.js";
import { EMPTY_PROMPT_SIGNALS } from "../src/prompt-signals/types.js";

describe("PromptSignalBus", () => {
  it("emit delivers events to all subscribers", () => {
    const bus = new PromptSignalBus();
    const received: PromptSignalEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: "engram_created", engramId: "E1", at: "2024-01-01T00:00:00.000Z" });
    bus.emit({ type: "engram_verified", engramId: "E2", at: "2024-01-01T00:00:01.000Z" });

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe("engram_created");
    expect(received[1]!.type).toBe("engram_verified");
  });

  it("on() returns unsubscribe function that stops further delivery", () => {
    const bus = new PromptSignalBus();
    const received: PromptSignalEvent[] = [];
    const unsubscribe = bus.on((e) => received.push(e));

    bus.emit({ type: "engram_created", at: "t1" });
    unsubscribe();
    bus.emit({ type: "engram_updated", at: "t2" });

    expect(received).toHaveLength(1);
  });

  it("rejects unknown event types at compile time (TS nominal)", () => {
    const bus = new PromptSignalBus();
    // 有效 type 通过
    bus.emit({ type: "proposal_accepted", engramId: "P1", at: "t" });
    // @ts-expect-error invalid type
    bus.emit({ type: "unknown_event", at: "t" });
    expect(true).toBe(true);
  });
});

describe("PromptSignalCache (Task 3.4)", () => {
  let bus: PromptSignalBus;
  let rebuildMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new PromptSignalBus();
    rebuildMock = vi.fn(async () => ({
      ...EMPTY_PROMPT_SIGNALS,
      updatedAt: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCache(overrides: Partial<PromptSignalCacheOptions> = {}): PromptSignalCache {
    return new PromptSignalCache({
      bus,
      rebuild: rebuildMock,
      debounceMs: 0, // 立即触发,便于测试
      ...overrides,
    });
  }

  it("snapshot() returns EMPTY_PROMPT_SIGNALS by default before rebuild", () => {
    const cache = makeCache({ initialSnapshot: undefined });
    expect(cache.snapshot()).toBe(EMPTY_PROMPT_SIGNALS);
    expect(cache.getRevision()).toBe(0);
  });

  it("manual rebuild() invokes rebuild callback and increments revision", async () => {
    const cache = makeCache();
    await cache.rebuild();
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(cache.getRevision()).toBe(1);
    expect(cache.isStale()).toBe(false);
  });

  it("bus event marks cache stale and triggers debounced rebuild", async () => {
    vi.useFakeTimers();
    const cache = makeCache({ debounceMs: 50 });
    await cache.rebuild();
    expect(cache.getRevision()).toBe(1);

    bus.emit({ type: "engram_verified", engramId: "E1", at: "t" });
    expect(cache.isStale()).toBe(true);

    // 推进 fake timer 触发 debounced rebuild
    await vi.advanceTimersByTimeAsync(50);
    expect(cache.getRevision()).toBe(2);
    expect(cache.isStale()).toBe(false);
  });

  it("multiple events within debounce window collapse into single rebuild", async () => {
    vi.useFakeTimers();
    const cache = makeCache({ debounceMs: 50 });
    await cache.rebuild();
    expect(rebuildMock).toHaveBeenCalledTimes(1);

    bus.emit({ type: "engram_created", at: "t1" });
    bus.emit({ type: "engram_updated", at: "t2" });
    bus.emit({ type: "engram_reinforced", at: "t3" });

    await vi.advanceTimersByTimeAsync(50);
    // 3 个事件合并成 1 次 rebuild,不是 3 次
    expect(rebuildMock).toHaveBeenCalledTimes(2); // initial + 1 debounced
    expect(cache.getRevision()).toBe(2);
  });

  it("snapshot reference changes after rebuild (consumer can detect refresh)", async () => {
    const cache = makeCache();
    await cache.rebuild();
    const before = cache.snapshot();
    expect(before).not.toBe(EMPTY_PROMPT_SIGNALS); // rebuild 替换了引用
  });

  it("dispose() stops receiving bus events", async () => {
    vi.useFakeTimers();
    const cache = makeCache({ debounceMs: 50 });
    await cache.rebuild();
    const initialRevision = cache.getRevision();

    cache.dispose();
    bus.emit({ type: "engram_created", at: "t" });
    await vi.advanceTimersByTimeAsync(50);

    expect(cache.getRevision()).toBe(initialRevision); // 未触发 rebuild
  });

  it("rebuild failure keeps previous snapshot and clears stale flag", async () => {
    vi.useFakeTimers();
    const failingRebuild = vi.fn(async () => {
      throw new Error("disk full");
    });
    const cache = new PromptSignalCache({
      bus,
      rebuild: failingRebuild,
      debounceMs: 0,
    });
    await cache.rebuild(); // fails silently
    expect(cache.getRevision()).toBe(0); // 未递增
    expect(cache.isStale()).toBe(false); // 清掉 stale 标记,避免无限重试
  });
});
