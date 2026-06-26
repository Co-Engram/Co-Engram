import { describe, it, expect } from "vitest";
import {
  buildCoEngramMemoryPrompt,
  createPromptBuilder,
} from "../src/prompt-builder/index.js";
import {
  EMPTY_PROMPT_SIGNALS,
  type PromptSignalSnapshot,
} from "../src/prompt-signals/index.js";

// ============================================================
// helpers
// ============================================================

function makeTools(tools: readonly string[]): Set<string> {
  return new Set(tools);
}

function makeSnapshot(
  overrides: Partial<PromptSignalSnapshot> = {},
): PromptSignalSnapshot {
  return {
    ...EMPTY_PROMPT_SIGNALS,
    ...overrides,
  };
}

// ============================================================
// buildCoEngramMemoryPrompt / 基础行为
// ============================================================

describe("buildCoEngramMemoryPrompt / 基础行为", () => {
  it("无任何 memory 工具时返回空", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["other_tool"]),
      language: "en",
    });
    expect(lines).toEqual([]);
  });

  it("memory_search 已注册时返回非空 section", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    expect(lines.length).toBeGreaterThan(0);
  });

  it("engram_search 已注册时也返回非空 section(host-agnostic 支持)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["engram_search"]),
      language: "en",
    });
    expect(lines.length).toBe(4);
  });

  it("engram_get 单独注册也触发注入", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["engram_get"]),
      language: "en",
    });
    expect(lines.length).toBe(4);
  });
});

describe("buildCoEngramMemoryPrompt / 基础 section(无 signals/proposals)", () => {
  it("英文基础段含 4 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    expect(lines.length).toBe(4);
  });

  it("中文基础段同样 4 行,但内容不同", () => {
    const enLines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    const zhLines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    expect(zhLines.length).toBe(4);
    expect(enLines).not.toEqual(zhLines);
  });

  it("默认语言为 zh", () => {
    const zhExplicit = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    const zhImplicit = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
    });
    expect(zhImplicit).toEqual(zhExplicit);
  });
});

// ============================================================
// signals 条件注入
// ============================================================

describe("buildCoEngramMemoryPrompt / signals 注入", () => {
  it("空 signals(全空数组)只输出基础 4 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({
        topTags: [],
        lowConfidenceTopics: [],
        missedTopics: [],
      }),
    });
    expect(lines.length).toBe(4);
  });

  it("topTags 非空时增加 1 行(frequent_topics)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ topTags: ["api", "design"] }),
    });
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("api") && l.includes("design"))).toBe(
      true,
    );
  });

  it("lowConfidenceTopics 非空时增加 1 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ lowConfidenceTopics: ["risky-topic"] }),
    });
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("risky-topic"))).toBe(true);
  });

  it("missedTopics 非空时增加 1 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ missedTopics: ["missed-one"] }),
    });
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("missed-one"))).toBe(true);
  });

  it("所有 signals 字段都填时增加 3 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({
        topTags: ["a"],
        lowConfidenceTopics: ["b"],
        missedTopics: ["c"],
      }),
    });
    expect(lines.length).toBe(7);
  });

  it("signals=undefined 跳过 signals section", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(4);
  });
});

// ============================================================
// proposal 提醒
// ============================================================

describe("buildCoEngramMemoryPrompt / proposal 提醒", () => {
  it("proposalCount=0 不注入提醒", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      proposalCount: 0,
    });
    expect(lines.length).toBe(4);
  });

  it("proposalCount>0 注入提醒", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      proposalCount: 3,
    });
    expect(lines.length).toBe(5);
  });

  it("未传 proposalCount 默认 0", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(4);
  });
});

// ============================================================
// createPromptBuilder factory
// ============================================================

describe("createPromptBuilder / 工厂闭包", () => {
  it("闭包注入 language + signals", () => {
    const builder = createPromptBuilder({
      language: "zh",
      signals: makeSnapshot({ topTags: ["调试"] }),
    });
    const lines = builder({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(5);
    expect(lines.some((l) => l.includes("调试"))).toBe(true);
  });

  it("proposalCountProvider 动态调用", () => {
    let callCount = 0;
    const builder = createPromptBuilder({
      language: "en",
      proposalCountProvider: () => {
        callCount += 1;
        return 2;
      },
    });
    const lines = builder({
      availableTools: makeTools(["memory_search"]),
    });
    expect(callCount).toBe(1);
    expect(lines.length).toBe(5);
  });

  it("proposalCountProvider 返回 0 不注入", () => {
    const builder = createPromptBuilder({
      language: "en",
      proposalCountProvider: () => 0,
    });
    const lines = builder({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(4);
  });

  it("工具未注册时 builder 返回空,即使 signals 非空", () => {
    const builder = createPromptBuilder({
      language: "en",
      signals: makeSnapshot({ topTags: ["x"] }),
      proposalCountProvider: () => 10,
    });
    const lines = builder({
      availableTools: makeTools(["other_tool"]),
    });
    expect(lines).toEqual([]);
  });

  it("builder 每次调用都重新执行 proposalCountProvider", () => {
    let n = 0;
    const builder = createPromptBuilder({
      language: "en",
      proposalCountProvider: () => {
        n += 1;
        return n;
      },
    });
    const params = { availableTools: makeTools(["memory_search"]) };
    const r1 = builder(params);
    const r2 = builder(params);
    expect(r1).not.toEqual(r2);
  });
});
