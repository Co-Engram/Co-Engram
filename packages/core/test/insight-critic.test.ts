import { describe, expect, it } from "vitest";

import type { LlmClient } from "../src/observability/necessity-evaluator.js";
import { critique } from "../src/maintenance/insight/critic.js";
import type { InsightDraft, InsightSubgraph } from "../src/maintenance/insight/types.js";

const SUB: InsightSubgraph = {
  nodes: [
    { id: "01A", title: "A", summary: "s-a", domainTags: ["x"], kind: "fact", importance: 0.5, confidence: 0.5, verificationStatus: "unverified", retrievalCount: 1, failedUses: 0, reinforcementScore: 0, freshness: "", isSeed: true, activation: 0.5 },
    { id: "01B", title: "B", summary: "s-b", domainTags: ["y"], kind: "fact", importance: 0.5, confidence: 0.5, verificationStatus: "unverified", retrievalCount: 1, failedUses: 0, reinforcementScore: 0, freshness: "", isSeed: true, activation: 0.5 },
  ],
  edges: [],
  globalStats: {},
};

const DRAFT: InsightDraft = {
  mode: "integration",
  type: "theme",
  title: "T",
  content: "C",
  summary: "s",
  sourceIds: ["01A", "01B"],
  domainTags: ["x"],
  reason: "r",
};

function makeClient(reply: string | Error): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe("critique(独立第二次调用)", () => {
  it("合法 JSON → 解析成功,数值 clamp [0,1]", async () => {
    const llm = makeClient(
      JSON.stringify({
        evidenceSufficiency: 0.8,
        novelty: 0.7,
        actionability: 0.9,
        consistency: 1.7, // 越界 → clamp 1
        overall: 0.75,
        rationale: "ok",
      }),
    );
    const score = await critique(llm, DRAFT, SUB, "integration");
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(0.75);
    expect(score!.consistency).toBe(1);
    expect(score!.rationale).toBe("ok");
  });

  it("```json 围栏包裹 → 剥围栏解析", async () => {
    const llm = makeClient(
      "Here is my review:\n```json\n{\"evidenceSufficiency\":0.5,\"novelty\":0.5,\"actionability\":0.5,\"consistency\":0.5,\"overall\":0.5,\"rationale\":\"meh\"}\n```\nthanks",
    );
    const score = await critique(llm, DRAFT, SUB, "integration");
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(0.5);
  });

  // timeout 20s:critique 内部 3 次重试 + 2s/4s 退避(critic.ts),持续不可
  // 解析/抛错路径总耗时 6s+,超过 vitest 默认 5s —— 此前两用例稳定超时误红
  it("垃圾文本 → null(fail-closed,不出提案)", async () => {
    const llm = makeClient("I think this is quite good overall!");
    expect(await critique(llm, DRAFT, SUB, "integration")).toBeNull();
  }, 20_000);

  it("complete 抛错 → null", async () => {
    const llm = makeClient(new Error("boom"));
    expect(await critique(llm, DRAFT, SUB, "integration")).toBeNull();
  }, 20_000);

  it("首次解析失败 → 重试后成功(间歇性输出波动,2026-08-16)", async () => {
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        return call === 1 ? "垃圾非 JSON 回复" : JSON.stringify({ evidenceSufficiency: 0.7, novelty: 0.7, actionability: 0.7, consistency: 0.7, overall: 0.7, rationale: "r" });
      },
    } as never;
    const score = await critique(llm, DRAFT, SUB, "integration");
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(0.7);
    expect(call).toBe(2);
  });

  it("字符串数字容错:\"overall\": \"0.8\" → 0.8", async () => {
    const llm = makeClient(JSON.stringify({ evidenceSufficiency: "0.7", novelty: 0.7, actionability: 0.7, consistency: 0.7, overall: "0.8", rationale: "r" }));
    const score = await critique(llm, DRAFT, SUB, "integration");
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(0.8);
  });

  it("独立第二次调用:prompt 含草稿全文与来源摘要,含模式 rubric 与独立评审指令", async () => {
    const llm = makeClient(
      JSON.stringify({ evidenceSufficiency: 0.5, novelty: 0.5, actionability: 0.5, consistency: 0.5, overall: 0.5, rationale: "" }),
    );
    await critique(llm, DRAFT, SUB, "retrospective");
    const prompt = llm.prompts[0]!;
    expect(prompt).toContain("independent critic");
    expect(prompt).toContain("Candidate insight");
    expect(prompt).toContain(DRAFT.content);
    expect(prompt).toContain("s-a"); // 来源摘要可见
    expect(prompt).toContain("RETROSPECTIVE"); // 模式 rubric
  });
});

// ============================================================
// 评审理由语言约束(2026-08-18:criticRationale 进提案 payload 展示)
// ============================================================
describe("critique 语言指令", () => {
  it("缺省 zh:prompt 要求 rationale 用简体中文", async () => {
    const llm = makeClient(
      JSON.stringify({ evidenceSufficiency: 0.8, novelty: 0.7, actionability: 0.8, consistency: 0.8, overall: 0.8, rationale: "良好" }),
    );
    await critique(llm, DRAFT, SUB, "integration");
    expect(llm.prompts[0]).toContain("Simplified Chinese");
  });

  it("language=en:不注入中文指令", async () => {
    const llm = makeClient(
      JSON.stringify({ evidenceSufficiency: 0.8, novelty: 0.7, actionability: 0.8, consistency: 0.8, overall: 0.8, rationale: "good" }),
    );
    await critique(llm, DRAFT, SUB, "integration", "en");
    expect(llm.prompts[0]).not.toContain("Simplified Chinese");
  });
});
