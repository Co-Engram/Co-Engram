/**
 * engram_search 取用归因测试(2026-08-22)
 *
 * 背景:沉思(L2 headless)协议强制多角度全图谱检索,若计入取用会把全库
 * lastRetrievedAt 批量刷新 —— 冷却榜(topCooling)失真、hotness 被沉思足迹
 * 偏置、effectiveness 被无人 reinforce 的 inconclusive 观察窗稀释。
 *
 * 修复:ToolContext.retrievalAttribution="contemplation"(headless executor
 * spawn 注入 CO_ENGRAM_CONTEMPLATION_SESSION=1,三宿主 ctx 构造读取)时,
 * engram_search 命中跳过 bumpRetrievalStats 与 openWindow;默认(work)行为
 * 不变。signals 工具调用流不受影响(由 wrapped.ts 外层记录,不经此分支)。
 */
import { describe, it, expect } from "vitest";
import { engramSearchTool } from "../src/tools/engram-tools.js";
import { wrapAllToolsWithSignalSink } from "../src/tools/wrapped.js";
import { MemorySignalSink } from "../src/signals/file-sink.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { SimpleSearchResult } from "../src/retrieval/orchestrator.js";

function makeCtx(
  attribution?: "work" | "contemplation",
): ToolContext & {
  readonly _bumped: string[];
  readonly _windows: string[];
} {
  const bumped: string[] = [];
  const windows: string[] = [];
  const ctx = {
    repository: {
      bumpRetrievalStats(id: string) {
        bumped.push(id);
      },
    },
    searchOrchestrator: {
      search(): SimpleSearchResult[] {
        return [
          {
            id: "01JTESTENGRAID1",
            score: 0.9,
            entry: {
              id: "01JTESTENGRAID1",
              title: "某条记忆",
              kind: "fact",
              domainTags: ["co-engram"],
            },
            matchReason: [],
          },
        ];
      },
    },
    effectivenessTracker: {
      openWindow(input: { engramId: string }) {
        windows.push(input.engramId);
      },
    },
    ...(attribution ? { retrievalAttribution: attribution } : {}),
  } as unknown as ToolContext;
  return Object.assign(ctx, { _bumped: bumped, _windows: windows });
}

/** 等 setImmediate 一拍:engram_search 的 bump/openWindow 是 fire-and-forget */
const flush = () =>
  new Promise<void>((resolve) => setImmediate(() => resolve()));

describe("engram_search 取用归因", () => {
  const input = { query: "测试查询", limit: 5 };

  it("默认(work/缺省):命中后 bump retrieval stats + 开观察窗(行为不变)", async () => {
    const ctx = makeCtx();
    const result = await engramSearchTool.execute(input, ctx);
    await flush();
    expect(result.total).toBe(1);
    expect(result.results[0]!.id).toBe("01JTESTENGRAID1");
    expect(ctx._bumped).toEqual(["01JTESTENGRAID1"]);
    expect(ctx._windows).toEqual(["01JTESTENGRAID1"]);
  });

  it('attribution="work" 显式传入:与默认一致', async () => {
    const ctx = makeCtx("work");
    await engramSearchTool.execute(input, ctx);
    await flush();
    expect(ctx._bumped.length).toBe(1);
    expect(ctx._windows.length).toBe(1);
  });

  it('attribution="contemplation":跳过 bump 与观察窗,检索结果不受影响', async () => {
    const ctx = makeCtx("contemplation");
    const result = await engramSearchTool.execute(input, ctx);
    await flush();
    // 结果完整返回(L2 的引用闭合闸依赖这些 id)
    expect(result.total).toBe(1);
    expect(result.results[0]!.id).toBe("01JTESTENGRAID1");
    expect(result.results[0]!.matchReason).toEqual([]);
    // 取用副作用为零
    expect(ctx._bumped).toEqual([]);
    expect(ctx._windows).toEqual([]);
  });

  it('attribution="contemplation":signalSink 行为日志照记(沉思足迹仍可溯,声明验证)', async () => {
    // 归因只拦「取用副作用」(bump/观察窗);wrapped 层的工具调用流与归因无关,
    // 沉思的检索在 signals.jsonl 仍完整记录 —— 用真实 wrapAllToolsWithSignalSink 验证
    const sink = new MemorySignalSink();
    const base = makeCtx("contemplation");
    const ctx = { ...base, signalSink: sink } as unknown as ToolContext;
    const [wrapped] = wrapAllToolsWithSignalSink([engramSearchTool]);
    await wrapped!.execute(input, ctx);
    await flush();
    const events = sink.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.toolName).toBe("engram_search");
    expect(base._bumped).toEqual([]); // 同时确认副作用拦截未被 wrapped 层绕过
  });
});
