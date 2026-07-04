import { describe, it, expect } from "vitest";
import {
  buildCoEngramMemoryPrompt,
  createCoEngramPromptBuilder,
} from "../src/prompt-builder.js";
import {
  EMPTY_PROMPT_SIGNALS,
  type PromptSignalSnapshot,
} from "@co-engram/core";

/**
 * OpenClaw adapter 测试
 *
 * 纯函数(buildCoEngramMemoryPrompt)的覆盖在 @co-engram/core/test/prompt-builder.test.ts。
 * 这里只验证 OpenClaw 特有的 adapter 行为:
 *   - re-export 正常工作(向后兼容)
 *   - createCoEngramPromptBuilder 工厂接受 OpenClaw 协议类型
 *   - OpenClaw params 被正确适配为 core 的 BuildPromptInput
 */

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

describe("OpenClaw adapter / re-export 完整性", () => {
  it("buildCoEngramMemoryPrompt 可正常调用(从 core re-export)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    // base section 至少 4 行(section_header + when_to_search +
    // when_not_to_search + reading_results);visibilityRisk 等条件段额外加。
    // 精确结构契约由 @co-engram/core/test/prompt-builder.test.ts 固化,
    // 这里只验证 adapter re-export 不丢内容。
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it("memory_search 已注册时返回非空 section(OpenClaw 协议)", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_search"]),
      language: "en",
    });
    expect(lines.length).toBeGreaterThan(0);
  });

  it("memory_get 单独注册也触发注入", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["memory_get"]),
      language: "en",
    });
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it("未注册任何 memory 工具时返回空", () => {
    const lines = buildCoEngramMemoryPrompt({
      availableTools: makeTools(["other_tool"]),
      language: "en",
    });
    expect(lines).toEqual([]);
  });
});

describe("OpenClaw adapter / createCoEngramPromptBuilder", () => {
  it("返回符合 MemoryPromptBuilder 协议的函数", () => {
    const builder = createCoEngramPromptBuilder({ language: "en" });
    expect(typeof builder).toBe("function");
    const lines = builder({ availableTools: makeTools(["memory_search"]) });
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("闭包注入 language + signals", () => {
    const builder = createCoEngramPromptBuilder({
      language: "zh",
      signals: makeSnapshot({ topTags: ["调试"] }),
    });
    const lines = builder({ availableTools: makeTools(["memory_search"]) });
    expect(lines.some((l) => l.includes("调试"))).toBe(true);
  });

  it("proposalCountProvider 动态调用", () => {
    let callCount = 0;
    const builder = createCoEngramPromptBuilder({
      language: "en",
      proposalCountProvider: () => {
        callCount += 1;
        return 2;
      },
    });
    const lines = builder({ availableTools: makeTools(["memory_search"]) });
    expect(callCount).toBe(1);
    // proposalCount=2 应注入至少 1 行 proposal_reminder,触发"待审核"提示。
    // 用 includes 检查内容存在,而不是硬编码精确行数(避免和 core 契约重复)。
    expect(lines.some((l) => l.includes("2"))).toBe(true);
  });

  it("proposalCountProvider 返回 0 不注入", () => {
    // 对照 baseline(无 provider)与 provider=0 的输出:proposalCount=0 时
    // 不应注入 proposal_reminder 段,所以两者应严格相等。
    const params = { availableTools: makeTools(["memory_search"]) };
    const baselineBuilder = createCoEngramPromptBuilder({ language: "en" });
    const zeroBuilder = createCoEngramPromptBuilder({
      language: "en",
      proposalCountProvider: () => 0,
    });
    expect(zeroBuilder(params)).toEqual(baselineBuilder(params));
  });

  it("工具未注册时 builder 返回空", () => {
    const builder = createCoEngramPromptBuilder({
      language: "en",
      signals: makeSnapshot({ topTags: ["x"] }),
      proposalCountProvider: () => 10,
    });
    const lines = builder({ availableTools: makeTools(["other_tool"]) });
    expect(lines).toEqual([]);
  });

  it("OpenClaw citationsMode 透传到 core(目前实现忽略,不报错)", () => {
    const builder = createCoEngramPromptBuilder({ language: "en" });
    const off = builder({
      availableTools: makeTools(["memory_search"]),
      citationsMode: "off",
    });
    const full = builder({
      availableTools: makeTools(["memory_search"]),
      citationsMode: "full",
    });
    expect(off).toEqual(full);
  });

  it("builder 每次调用都重新执行 proposalCountProvider", () => {
    let n = 0;
    const builder = createCoEngramPromptBuilder({
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
