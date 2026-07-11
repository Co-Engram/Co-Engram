import { describe, it, expect } from "vitest";
import {
  buildCoEngramMemoryPrompt,
  createPromptBuilder,
} from "../src/prompt-builder/index.js";
import {
  EMPTY_PROMPT_SIGNALS,
  type PromptSignalSnapshot,
} from "../src/prompt-signals/index.js";

// visibilityRisk section 是常驻段(基线 +11 行:空行 + 标题 + 空 + guidance + 空
// + 5 个列表项 + 空 + template + 空 + principle),所有"基础行数"断言都 +11。
// exclusivity section 也是常驻段(基线 +2 行:title + rule),所有"基础行数"断言再 +2。

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
    expect(lines.length).toBe(17);
  });

  it("engram_get 单独注册也触发注入", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["engram_get"]),
      language: "en",
    });
    expect(lines.length).toBe(17);
  });
});

describe("buildCoEngramMemoryPrompt / 基础 section(无 signals/proposals)", () => {
  it("英文基础段含 17 行(4 基础 + 11 visibilityRisk + 2 exclusivity)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    expect(lines.length).toBe(17);
  });

  it("中文基础段同样 17 行,但内容不同", () => {
    const enLines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    const zhLines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    expect(zhLines.length).toBe(17);
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

  it("exclusivity section 常驻注入(声明唯一记忆入口,zh/en 都有)", () => {
    const en = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    const zh = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    expect(en.some((l) => l.includes("Exclusive memory store"))).toBe(true);
    expect(en.some((l) => l.includes("memory write path"))).toBe(true);
    expect(zh.some((l) => l.includes("唯一记忆系统"))).toBe(true);
    expect(zh.some((l) => l.includes("唯一"))).toBe(true);
    expect(zh.some((l) => l.includes("engram_create"))).toBe(true);
  });
});

// ============================================================
// signals 条件注入
// ============================================================

describe("buildCoEngramMemoryPrompt / signals 注入", () => {
  it("空 signals(全空数组)只输出基础 17 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({
        topTags: [],
        lowConfidenceTopics: [],
        missedTopics: [],
      }),
    });
    expect(lines.length).toBe(17);
  });

  it("topTags 非空时增加 1 行(frequent_topics)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ topTags: ["api", "design"] }),
    });
    expect(lines.length).toBe(18);
    expect(lines.some((l) => l.includes("api") && l.includes("design"))).toBe(
      true,
    );
  });

  it("lowConfidenceTopics 非空时增加 1 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ lowConfidenceTopics: ["risky-topic"] }),
    });
    expect(lines.length).toBe(18);
    expect(lines.some((l) => l.includes("risky-topic"))).toBe(true);
  });

  it("missedTopics 非空时增加 1 行", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      signals: makeSnapshot({ missedTopics: ["missed-one"] }),
    });
    expect(lines.length).toBe(18);
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
    expect(lines.length).toBe(20);
  });

  it("signals=undefined 跳过 signals section", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(17);
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
    expect(lines.length).toBe(17);
  });

  it("proposalCount>0 注入提醒", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      proposalCount: 3,
    });
    expect(lines.length).toBe(18);
  });

  it("未传 proposalCount 默认 0", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(17);
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
    expect(lines.length).toBe(18);
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
    expect(lines.length).toBe(18);
  });

  it("proposalCountProvider 返回 0 不注入", () => {
    const builder = createPromptBuilder({
      language: "en",
      proposalCountProvider: () => 0,
    });
    const lines = builder({
      availableTools: makeTools(["memory_search"]),
    });
    expect(lines.length).toBe(17);
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

// ============================================================
// 可见性风险识别 section(Task 5)
// ============================================================

describe("buildCoEngramMemoryPrompt / 可见性风险识别 section", () => {
  it("包含可见性风险识别 section 标题(zh)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    const joined = lines.join("\n");
    expect(joined).toMatch(/可见性风险识别|Visibility Risk Recognition/);
  });

  it("包含可见性风险识别 section 标题(en)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    const joined = lines.join("\n");
    expect(joined).toMatch(/可见性风险识别|Visibility Risk Recognition/);
  });

  it("包含凭据风险信号示例(ghp_)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    expect(lines.join("\n")).toContain("ghp_");
  });

  it("包含宁可多问 / over-ask 原则", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    });
    expect(lines.join("\n")).toMatch(/宁可多问|over-ask/);
  });

  it("包含 5 类风险信号(credentials / personal / internal / sensitive / paths)", () => {
    const zhLines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
    }).join("\n");
    expect(zhLines).toMatch(/凭据/);
    expect(zhLines).toMatch(/个人身份/);
    expect(zhLines).toMatch(/内部/);
    expect(zhLines).toMatch(/敏感/);
    expect(zhLines).toMatch(/绝对路径|用户名/);
  });

  it("visibilityRisk section 在 base 之后、signals 之前", () => {
    // 用 signals 触发额外段,确认 visibilityRisk 出现在 signals 段之前
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "zh",
      signals: makeSnapshot({ topTags: ["MARKER_TAG_XYZ"] }),
    });
    const joined = lines.join("\n");
    const riskIdx = joined.search(/可见性风险识别/);
    const tagIdx = joined.indexOf("MARKER_TAG_XYZ");
    expect(riskIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeGreaterThan(riskIdx);
  });
});
