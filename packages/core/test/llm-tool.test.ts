/**
 * AI-4 LlmTool 契约测试
 *
 * 验证:
 *   1. runLlmTool dryRun=true + 有 heuristic → 走 heuristic,绝不调 LLM
 *   2. runLlmTool dryRun=true + 无 heuristic → 抛错(透明失败,不伪装)
 *   3. runLlmTool dryRun=false + LLM 成功 → 走 LLM,返回 _llmToolPath='llm'
 *   4. runLlmTool dryRun=false + LLM 失败 + 有 heuristic → fallback
 *   5. runLlmTool dryRun=false + LLM 失败 + 无 heuristic → 透传错误
 *   6. LlmNecessityEvaluator 实现 LlmTool 契约,dryRun=true 不调 LLM
 */

import { describe, it, expect, vi } from "vitest";
import {
  LlmNecessityEvaluator,
  type NecessityInput,
  type LlmClient,
} from "../src/observability/necessity-evaluator.js";
import {
  runLlmTool,
  type LlmTool,
  type LlmToolOptions,
} from "../src/observability/llm-tool.js";

function makeInput(): NecessityInput {
  return {
    samples: [
      "we should really configure github actions for typescript ci",
      "please set up CI for the typescript project using github actions",
      "how do we configure github actions to run typescript ci",
    ],
    occurrences: 3,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-09T00:00:00.000Z",
    existingTitles: [],
  };
}

// ============================================================
// runLlmTool 路由表
// ============================================================

describe("runLlmTool · dryRun=true 绝不调 LLM", () => {
  it("dryRun=true + 有 heuristic → 走 heuristic,llmCallCount=0", async () => {
    const llmCallCount = { value: 0 };
    const heuristicCallCount = { value: 0 };
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-1",
      async executeWithLlm() {
        llmCallCount.value += 1;
        return { verdict: "llm" };
      },
      hasHeuristicFallback() {
        return true;
      },
      async executeHeuristic() {
        heuristicCallCount.value += 1;
        return { verdict: "heuristic" };
      },
    };

    const result = await runLlmTool(tool, makeInput(), { dryRun: true });

    expect(llmCallCount.value).toBe(0);
    expect(heuristicCallCount.value).toBe(1);
    expect(result.verdict).toBe("heuristic");
    expect(result._llmToolPath).toBe("heuristic");
  });

  it("dryRun=true + 无 heuristic → 抛错(透明失败)", async () => {
    const llmCallCount = { value: 0 };
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-2",
      async executeWithLlm() {
        llmCallCount.value += 1;
        return { verdict: "llm" };
      },
      hasHeuristicFallback() {
        return false;
      },
      async executeHeuristic() {
        throw new Error("no heuristic");
      },
    };

    await expect(
      runLlmTool(tool, makeInput(), { dryRun: true }),
    ).rejects.toThrow(/dryRun=true.*no heuristic fallback/);

    // 即使抛错,LLM 也不应被调用
    expect(llmCallCount.value).toBe(0);
  });
});

describe("runLlmTool · dryRun=false 路由", () => {
  it("LLM 成功 → 走 LLM,返回 _llmToolPath='llm'", async () => {
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-3",
      async executeWithLlm() {
        return { verdict: "llm" };
      },
      hasHeuristicFallback() {
        return true;
      },
      async executeHeuristic() {
        return { verdict: "heuristic" };
      },
    };

    const result = await runLlmTool(tool, makeInput(), {});

    expect(result.verdict).toBe("llm");
    expect(result._llmToolPath).toBe("llm");
  });

  it("LLM 失败 + 有 heuristic → fallback,_llmToolPath='heuristic-after-llm-fail'", async () => {
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-4",
      async executeWithLlm() {
        throw new Error("LLM timeout");
      },
      hasHeuristicFallback() {
        return true;
      },
      async executeHeuristic() {
        return { verdict: "heuristic" };
      },
    };

    const result = await runLlmTool(tool, makeInput(), {});

    expect(result.verdict).toBe("heuristic");
    expect(result._llmToolPath).toBe("heuristic-after-llm-fail");
    expect(result._llmToolError).toContain("LLM timeout");
  });

  it("LLM 失败 + 无 heuristic → 透传错误", async () => {
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-5",
      async executeWithLlm() {
        throw new Error("LLM unavailable");
      },
      hasHeuristicFallback() {
        return false;
      },
      async executeHeuristic() {
        throw new Error("no heuristic");
      },
    };

    await expect(runLlmTool(tool, makeInput(), {})).rejects.toThrow(
      /LLM unavailable/,
    );
  });
});

// ============================================================
// LlmNecessityEvaluator 实现 LlmTool 契约
// ============================================================

describe("LlmNecessityEvaluator 实现 LlmTool 契约", () => {
  it("hasHeuristicFallback() === true", () => {
    const eval_ = new LlmNecessityEvaluator({
      async complete() {
        return '{"necessary": true}';
      },
    });
    expect(eval_.hasHeuristicFallback()).toBe(true);
  });

  it("executeHeuristic 不调 LLM,返回规则版裁决", async () => {
    const completeSpy = vi.fn().mockResolvedValue('{"necessary": true}');
    const client: LlmClient = { complete: completeSpy };
    const eval_ = new LlmNecessityEvaluator(client);

    const result = await eval_.executeHeuristic(makeInput(), {});

    // LLM 不应被调用
    expect(completeSpy).not.toHaveBeenCalled();
    // 应返回规则版裁决(有 reason 字段)
    expect(result).toHaveProperty("necessary");
    expect(result).toHaveProperty("reason");
  });

  it("executeWithLlm 调用 LlmClient.complete", async () => {
    const completeSpy = vi
      .fn()
      .mockResolvedValue(
        '{"necessary": true, "reason": "LLM verdict", "suggestedTitle": "CI for TS"}',
      );
    const client: LlmClient = { complete: completeSpy };
    const eval_ = new LlmNecessityEvaluator(client);

    const result = await eval_.executeWithLlm(makeInput(), {});

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(result.necessary).toBe(true);
    expect(result.suggestedTitle).toBe("CI for TS");
  });

  it("通过 runLlmTool 调用 + dryRun=true → LLM 不被调用", async () => {
    const completeSpy = vi.fn().mockResolvedValue('{"necessary": true}');
    const client: LlmClient = { complete: completeSpy };
    const eval_ = new LlmNecessityEvaluator(client);

    const result = await runLlmTool(eval_, makeInput(), { dryRun: true });

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result._llmToolPath).toBe("heuristic");
  });

  it("通过 runLlmTool 调用 + LLM 失败 → fallback 到规则", async () => {
    const completeSpy = vi.fn().mockRejectedValue(new Error("network down"));
    const client: LlmClient = { complete: completeSpy };
    const eval_ = new LlmNecessityEvaluator(client);

    const result = await runLlmTool(eval_, makeInput(), {});

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(result._llmToolPath).toBe("heuristic-after-llm-fail");
    expect(result._llmToolError).toContain("network down");
    // 应有规则版的必要(reason 字段非空)
    expect(result.reason).toBeTruthy();
  });

  it("executeWithLlm 透传 opts.maxTokens/temperature/timeoutMs", async () => {
    const completeSpy = vi.fn().mockResolvedValue('{"necessary": true}');
    const client: LlmClient = { complete: completeSpy };
    const eval_ = new LlmNecessityEvaluator(client);

    const opts: LlmToolOptions = {
      maxTokens: 200,
      temperature: 0.5,
      timeoutMs: 5000,
    };
    await eval_.executeWithLlm(makeInput(), opts);

    expect(completeSpy).toHaveBeenCalledWith(expect.any(String), {
      maxTokens: 200,
      temperature: 0.5,
      timeoutMs: 5000,
    });
  });
});

// ============================================================
// 边界用例
// ============================================================

describe("runLlmTool · 边界", () => {
  it("opts 不传 → 默认走 LLM 路径", async () => {
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "test-tool-6",
      async executeWithLlm() {
        return { verdict: "llm" };
      },
      hasHeuristicFallback() {
        return true;
      },
      async executeHeuristic() {
        return { verdict: "heuristic" };
      },
    };

    const result = await runLlmTool(tool, makeInput());

    expect(result._llmToolPath).toBe("llm");
  });

  it("name 字段在错误信息中(便于排查)", async () => {
    const tool: LlmTool<NecessityInput, { verdict: string }> = {
      name: "my-custom-llm-tool",
      async executeWithLlm() {
        return { verdict: "llm" };
      },
      hasHeuristicFallback() {
        return false;
      },
      async executeHeuristic() {
        throw new Error("no heuristic");
      },
    };

    await expect(
      runLlmTool(tool, makeInput(), { dryRun: true }),
    ).rejects.toThrow(/my-custom-llm-tool/);
  });
});
