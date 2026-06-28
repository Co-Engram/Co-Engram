import { describe, it, expect } from "vitest";
import {
  LlmPatternAbstraction,
  LocalHeuristicPatternAbstraction,
  type AbstractionInput,
  type LlmClient,
} from "@co-engram/core";

/**
 * 构造一个 fake AbstractionInput(无需真正读 engram 仓库)
 */
function makeInput(titles: readonly string[]): AbstractionInput {
  return {
    engrams: titles.map((title, i) => ({
      id: `01J0000000000000000000000${i.toString().padStart(2, "0")}` as `${string}`,
      title,
      summary: `${title} summary`,
      content: `${title} body content with shared tokens like memory and pattern`,
      domainTags: ["testing"],
    })),
  };
}

describe("LlmPatternAbstraction", () => {
  it("LLM 成功时返回 LLM 综合的 pattern", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return JSON.stringify({
          title: "Shared lesson: memory consolidation pattern",
          summary: "Multiple memories point to the same underlying principle.",
          content:
            "# Memory consolidation pattern\n\nWhen multiple specific memories share structure, synthesize higher-order pattern.",
          domainTags: ["memory", "pattern", "consolidation"],
          confidence: 0.92,
          reason: "All 3 sources describe the same meta-principle.",
        });
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(
      makeInput(["Memory A", "Memory B", "Memory C"]),
    );

    expect(out.title).toBe("Shared lesson: memory consolidation pattern");
    expect(out.confidence).toBe(0.92);
    expect(out.reason).toContain("meta-principle");
    expect(out.content).toContain("Memory consolidation pattern");
  });

  it("LLM 调用抛错时 fallback 到 LocalHeuristic", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        throw new Error("Network down");
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(
      makeInput(["Memory A", "Memory B", "Memory C"]),
    );

    // LocalHeuristic 输出 title 以 "Pattern:" 开头
    expect(out.title.startsWith("Pattern:")).toBe(true);
    // confidence 在 [0,1] 范围
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });

  it("LLM 返回非 JSON 时 fallback 到 LocalHeuristic", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return "Sorry, I cannot help with that.";
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(
      makeInput(["Memory A", "Memory B"]),
    );

    expect(out.title.startsWith("Pattern:")).toBe(true);
  });

  it("LLM 返回空字符串时 fallback 到 LocalHeuristic", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return "";
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(makeInput(["A", "B"]));

    expect(out.title.startsWith("Pattern:")).toBe(true);
  });

  it("LLM 返回部分缺失字段(title 空)时 fallback", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return JSON.stringify({
          title: "   ", // 空白
          content: "x",
          summary: "y",
          confidence: 0.8,
        });
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(makeInput(["A", "B"]));

    expect(out.title.startsWith("Pattern:")).toBe(true);
  });

  it("LLM 返回 markdown-fenced JSON 时能正确解析", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return "```json\n" +
          JSON.stringify({
            title: "Fenced pattern",
            content: "Body",
            summary: "Sum",
            confidence: 0.7,
            reason: "ok",
          }) +
          "\n```";
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(makeInput(["A", "B"]));

    expect(out.title).toBe("Fenced pattern");
    expect(out.confidence).toBe(0.7);
  });

  it("空 cluster 直接走 fallback,不调 LLM", async () => {
    let called = false;
    const fakeClient: LlmClient = {
      async complete() {
        called = true;
        return "should not be called";
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract({ engrams: [] });

    expect(called).toBe(false);
    expect(out.title).toBe("Pattern: <empty>");
    expect(out.confidence).toBe(0);
  });

  it("LLM confidence 超出 [0,1] 时按 fallback 规则归一化到 0.5", async () => {
    const fakeClient: LlmClient = {
      async complete() {
        return JSON.stringify({
          title: "Valid title",
          content: "Valid content",
          summary: "Sum",
          confidence: 99, // 越界
        });
      },
    };

    const provider = new LlmPatternAbstraction(fakeClient);
    const out = await provider.abstract(makeInput(["A", "B"]));

    expect(out.title).toBe("Valid title");
    expect(out.confidence).toBe(0.5); // parseSynthesisOutput 归一化
  });
});

describe("LlmPatternAbstraction vs LocalHeuristicPatternAbstraction 契约一致性", () => {
  it("两者实现同一 PatternAbstractionProvider 接口", () => {
    // 类型层面:都是 PatternAbstractionProvider
    const llm = new LlmPatternAbstraction({ async complete() { return ""; } });
    const heuristic = new LocalHeuristicPatternAbstraction();

    // 都有 abstract 方法
    expect(typeof llm.abstract).toBe("function");
    expect(typeof heuristic.abstract).toBe("function");
  });
});
