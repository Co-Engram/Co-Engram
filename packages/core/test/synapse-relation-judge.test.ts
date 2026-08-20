import { describe, it, expect } from "vitest";
import {
  buildRelationJudgePrompt,
  parseRelationJudgeOutput,
  judgeRelationPairs,
  RELATION_JUDGE_BATCH_SIZE,
  type RelationJudgePair,
} from "../src/dreaming/synapse-relation-judge.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";

/**
 * 反思判断层(2026-08 反思落地)单测:prompt 构建 / 输出解析(容错与拒绝)/
 * 批量判断(分批 + 按批降级)。
 */

const pair = (i: number): RelationJudgePair => ({
  aId: `01A${i}`,
  bId: `01B${i}`,
  aTitle: `甲${i}`,
  bTitle: `乙${i}`,
  aText: `甲${i} 的摘要内容`,
  bText: `乙${i} 的摘要内容`,
});

describe("buildRelationJudgePrompt", () => {
  it("含两端标识与 title、12 kind 定义、严格 JSON 指令、reverse 说明", () => {
    const p = buildRelationJudgePrompt([pair(0), pair(1)]);
    expect(p).toContain("01A0");
    expect(p).toContain("乙1");
    expect(p).toContain("causes");
    expect(p).toContain("supersedes");
    expect(p).toContain("consolidates");
    expect(p).toContain("none");
    expect(p).toContain("reverse");
    expect(p).toContain('"judgments"');
  });
});

describe("parseRelationJudgeOutput", () => {
  it("合法 JSON → verdicts(index/kind/confidence/reason)", () => {
    const v = parseRelationJudgeOutput(
      `{"judgments":[{"index":0,"kind":"causes","confidence":0.8,"reason":"甲导致乙"}]}`,
      1,
    );
    expect(v).toEqual([
      { kind: "causes", confidence: 0.8, reason: "甲导致乙" },
    ]);
  });

  it("reverse: true 透传(有向关系方向修正)", () => {
    const v = parseRelationJudgeOutput(
      `{"judgments":[{"index":0,"kind":"supersedes","confidence":0.7,"reason":"r","reverse":true}]}`,
      1,
    );
    expect(v?.[0]?.reverse).toBe(true);
  });

  it("```json 围栏与前后杂文容错", () => {
    const v = parseRelationJudgeOutput(
      '好的,结果如下:\n```json\n{"judgments":[{"index":0,"kind":"follows","confidence":0.6,"reason":"时序"}]}\n```',
      1,
    );
    expect(v?.[0]?.kind).toBe("follows");
  });

  it("非法 JSON → undefined(整体拒绝,不部分采纳)", () => {
    expect(parseRelationJudgeOutput("not json at all", 1)).toBeUndefined();
  });

  it("index 越界 → undefined(防错位配对)", () => {
    const v = parseRelationJudgeOutput(
      `{"judgments":[{"index":5,"kind":"causes","confidence":0.8,"reason":"r"}]}`,
      1,
    );
    expect(v).toBeUndefined();
  });

  it("未知 kind → undefined", () => {
    const v = parseRelationJudgeOutput(
      `{"judgments":[{"index":0,"kind":"related_to","confidence":0.8,"reason":"r"}]}`,
      1,
    );
    expect(v).toBeUndefined();
  });

  it("confidence 越界 clamp 到 [0,1]", () => {
    const v = parseRelationJudgeOutput(
      `{"judgments":[{"index":0,"kind":"causes","confidence":1.7,"reason":"r"}]}`,
      1,
    );
    expect(v?.[0]?.confidence).toBe(1);
  });
});

describe("judgeRelationPairs", () => {
  /** 按 prompt 实际对数生成 judgments 的 mock(prompt 内每对有一行 `[i] from`) */
  const replyFor = (kind: string, confidence: number) => (prompt: string) => {
    const count = (prompt.match(/\[\d+\] from/g) ?? []).length;
    return `{"judgments":[${Array.from(
      { length: count },
      (_, i) =>
        `{"index":${i},"kind":"${kind}","confidence":${confidence},"reason":"mock 判断"}`,
    ).join(",")}]}`;
  };

  it("正常返回与输入等长的 verdicts", async () => {
    const okClient: LlmClient = {
      complete: async (p) => replyFor("depends_on", 0.9)(p),
    };
    const out = await judgeRelationPairs(okClient, [pair(0), pair(1)]);
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("depends_on");
    expect(out[1]?.kind).toBe("depends_on");
  });

  it("分批:超过批上限时多次调用 complete", async () => {
    let calls = 0;
    const counting: LlmClient = {
      complete: async (p) => {
        calls += 1;
        return replyFor("similar_to", 0.5)(p);
      },
    };
    const pairs = Array.from(
      { length: RELATION_JUDGE_BATCH_SIZE + 3 },
      (_, i) => pair(i),
    );
    const out = await judgeRelationPairs(counting, pairs);
    expect(calls).toBe(2);
    expect(out.every((v) => v?.kind === "similar_to")).toBe(true);
    expect(out).toHaveLength(RELATION_JUDGE_BATCH_SIZE + 3);
  });

  it("按批降级:失败批为 undefined 位,其余批照常", async () => {
    let call = 0;
    const flaky: LlmClient = {
      complete: async () => {
        call += 1;
        if (call === 1) throw new Error("LLM down");
        return `{"judgments":[{"index":0,"kind":"causes","confidence":0.7,"reason":"因果"}]}`;
      },
    };
    const pairs = Array.from(
      { length: RELATION_JUDGE_BATCH_SIZE + 1 },
      (_, i) => pair(i),
    );
    const out = await judgeRelationPairs(flaky, pairs);
    expect(out[0]).toBeUndefined(); // 第一批失败
    expect(out[RELATION_JUDGE_BATCH_SIZE]?.kind).toBe("causes"); // 第二批正常
  });
});
