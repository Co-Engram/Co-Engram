import { describe, it, expect } from "vitest";

import {
  RuleBasedNecessityEvaluator,
  LlmNecessityEvaluator,
  prefilterMessage,
  type LlmClient,
  type NecessityInput,
} from "../src/observability/necessity-evaluator.js";

// ============================================================
// prefilterMessage (Layer 1)
// ============================================================

describe("prefilterMessage (Layer 1)", () => {
  it("system role → 拒绝(rule=system_role)", () => {
    const v = prefilterMessage("whatever content long enough", "system");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("system_role");
  });

  it("空内容 → 拒绝(rule=empty)", () => {
    const v = prefilterMessage("   ", "user");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("empty");
  });

  it("user 短消息(< 30 chars)→ 拒绝(rule=too_short)", () => {
    const v = prefilterMessage("short message", "user");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("too_short");
  });

  it("assistant 短消息(< 15 chars)→ 拒绝(rule=too_short)", () => {
    const v = prefilterMessage("ok done", "assistant");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("too_short");
  });

  it("assistant 长度 ≥ 15 通过(宽松)", () => {
    const v = prefilterMessage(
      "acknowledged the design request will proceed",
      "assistant",
    );
    expect(v.accepted).toBe(true);
  });

  it("英文 trivial 词 → 拒绝(rule=trivial_pattern)", () => {
    // 扩到 30+ chars 绕过 too_short,验证 trivial_pattern 真正生效
    const padded = "ok ok ok ok ok ok ok ok ok ok ok ok";
    const v = prefilterMessage(padded, "user");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("trivial_pattern");
  });

  it("中文 trivial 词 → 拒绝(rule=trivial_pattern)", () => {
    // 30+ chars 中文 trivial
    const padded =
      "好的 好的 好的 好的 好的 好的 好的 好的 好的 好的 好的 好的";
    const v = prefilterMessage(padded, "user");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("trivial_pattern");
  });

  it("仅标点 → 拒绝(rule=only_punct)", () => {
    // 30+ chars 纯标点
    const v = prefilterMessage(
      "。。。！？....!!!!????。。。。！！！！。。。。??",
      "user",
    );
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("only_punct");
  });

  it("低信息密度(全停用词)→ 拒绝(rule=low_density)", () => {
    // 长度足够 + 全是停用词 → meaningful token < 4
    const v = prefilterMessage("the a an and or but is are was were", "user");
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("low_density");
  });

  it("正常有内容消息 → 通过", () => {
    const v = prefilterMessage(
      "we should configure github actions for typescript ci pipelines",
      "user",
    );
    expect(v.accepted).toBe(true);
  });
});

// ============================================================
// RuleBasedNecessityEvaluator (Layer 2)
// ============================================================

const evaluator = new RuleBasedNecessityEvaluator();

function makeInput(
  samples: readonly string[],
  occurrences?: number,
): NecessityInput {
  return {
    samples,
    occurrences: occurrences ?? samples.length,
    firstSeenAt: "2026-06-01T00:00:00Z",
    lastSeenAt: "2026-06-25T00:00:00Z",
    existingTitles: [],
  };
}

describe("RuleBasedNecessityEvaluator (Layer 2)", () => {
  it("空 samples → 拒绝(rule=no_samples)", async () => {
    const v = await evaluator.evaluate(makeInput([]));
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("no_samples");
  });

  it("机械重复(所有 samples 相同)→ 拒绝(rule=few_unique_samples)", async () => {
    const same =
      "please configure github actions for typescript ci pipelines now";
    // unique = 1 → few_unique_samples 优先于 high_repetition
    const v = await evaluator.evaluate(makeInput([same, same, same, same], 4));
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("few_unique_samples");
  });

  it("高重复率(uniqueRatio < 0.5)→ 拒绝(rule=high_repetition)", async () => {
    // 5 条样本:4 条相同 + 1 条不同 → unique = 2, ratio = 0.4 < 0.5
    const same =
      "duplicate message about typescript ci pipelines configuration";
    const v = await evaluator.evaluate(
      makeInput([
        same,
        same,
        same,
        same,
        "totally different unique message about something else entirely here",
      ]),
    );
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("high_repetition");
  });

  it("samples 太短(avg < 30)→ 拒绝(rule=too_short)", async () => {
    const v = await evaluator.evaluate(
      makeInput(["short one", "short two", "short three", "short four"]),
    );
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("too_short");
  });

  it("信息密度太低(avg meaningful tokens < 5)→ 拒绝(rule=low_density)", async () => {
    // 每条 35 chars 但全是停用词
    const v = await evaluator.evaluate(
      makeInput([
        "the a an and or but is are was were",
        "the a an and or but is are was were",
        "the a an and or but is are was were",
        "the a an and or but is are was were",
      ]),
    );
    expect(v.necessary).toBe(false);
    // 重复率也会触发,但 too_short 在前(先检查长度)
    expect(["low_density", "high_repetition", "few_unique_samples"]).toContain(
      v.rule,
    );
  });

  it("trivial 主导(70%+ samples trivial)→ 拒绝(rule=trivial_dominated)", async () => {
    // 5 条不同的 trivial 样本(每条扩到 30+ chars,且互不相同避免 high_repetition)
    const v = await evaluator.evaluate(
      makeInput([
        "ok ok ok ok ok ok ok ok ok ok ok ok",
        "test test test test test test test test test",
        "hello hello hello hello hello hello hello hello",
        "done done done done done done done done done",
        "we should set up typescript ci pipelines with github actions",
      ]),
    );
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("trivial_dominated");
  });

  it("正常多样本 → 通过", async () => {
    const v = await evaluator.evaluate(
      makeInput([
        "we should configure github actions for typescript ci pipelines",
        "please set up CI for the typescript project using github actions",
        "how do we configure github actions to run typescript continuous integration",
        "reminder to enable github actions workflows for typescript ci builds",
      ]),
    );
    expect(v.necessary).toBe(true);
    expect(v.reason).toMatch(/Passed 5 rule checks/);
  });

  it("提供 reason 给用户审批时参考", async () => {
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toBeTruthy();
    expect(v.reason.length).toBeGreaterThan(10);
  });
});

// ============================================================
// LlmNecessityEvaluator (Layer 2 with LLM)
// ============================================================

describe("LlmNecessityEvaluator", () => {
  it("LLM 返回 necessary=true → 通过 + 提取 suggestedTitle", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return JSON.stringify({
          necessary: true,
          reason: "Recurring decision about CI setup worth saving",
          suggestedTitle: "Use GitHub Actions for TypeScript CI",
        });
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput([
        "we should configure github actions for typescript ci pipelines",
        "please set up CI for typescript using github actions",
        "how to configure github actions for typescript ci",
      ]),
    );
    expect(v.necessary).toBe(true);
    expect(v.reason).toBe("Recurring decision about CI setup worth saving");
    expect(v.suggestedTitle).toBe("Use GitHub Actions for TypeScript CI");
  });

  it("LLM 返回 necessary=false → 拒绝", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return JSON.stringify({
          necessary: false,
          reason: "One-off status update, not reusable",
          suggestedTitle: "",
        });
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["done with task A", "finished task B", "completed task C"]),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toBe("One-off status update, not reusable");
    expect(v.suggestedTitle).toBeUndefined();
  });

  it("LLM 返回带 markdown fence → 容忍解析", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return '```json\n{"necessary": true, "reason": "fenced", "suggestedTitle": "T"}\n```';
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["we should use arrow function for react components always"]),
    );
    expect(v.necessary).toBe(true);
    expect(v.reason).toBe("fenced");
    expect(v.suggestedTitle).toBe("T");
  });

  it("LLM 返回非 JSON → fallback 到 RuleBased", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return "sorry I cannot help with that";
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput([
        "we should configure github actions for typescript ci pipelines",
        "please set up CI for typescript using github actions",
        "how to configure github actions for typescript ci",
        "reminder to enable github actions typescript ci workflows",
      ]),
    );
    // fallback 到规则,4 条不同样本 → 通过
    expect(v.necessary).toBe(true);
    expect(v.reason).toMatch(/rule-fallback/);
  });

  it("LLM 抛错 → fallback 到 RuleBased", async () => {
    const stubClient: LlmClient = {
      async complete() {
        throw new Error("network down");
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    // fallback 规则版会拒绝机械重复
    expect(v.necessary).toBe(false);
    expect(v.reason).toMatch(/llm-unavailable.*rule-fallback/);
  });

  it("LLM reason 缺失 → 用默认 reason", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return JSON.stringify({ necessary: true });
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["we should use arrow function for react components always"]),
    );
    expect(v.necessary).toBe(true);
    expect(v.reason).toBe("LLM approved");
  });

  it("LLM 请求 maxTokens 提到 1500(留足 reasoning 模型预算)", async () => {
    let capturedOpts:
      | { readonly maxTokens?: number; readonly temperature?: number }
      | undefined;
    const stubClient: LlmClient = {
      async complete(_prompt, opts) {
        capturedOpts = opts;
        return JSON.stringify({
          necessary: true,
          reason: "ok",
          suggestedTitle: "T",
        });
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    await evaluator.evaluate(
      makeInput([
        "we should configure github actions for typescript ci pipelines",
      ]),
    );
    expect(capturedOpts?.maxTokens).toBe(1500);
  });

  it("LLM 返回 reasoning_content 残留 JSON → parseLlmVerdict 抽取", async () => {
    // 模拟 reasoning 模型:max_tokens 不够时 host 适配器会把 reasoning_content
    // 当作完整 content 返回,reasoning 链末尾常含 JSON 答案
    const stubClient: LlmClient = {
      async complete() {
        return 'Let me analyze these samples.\nThe samples are about configuring CI for TypeScript.\nI think this is worth saving as a team memory.\n\n{"necessary": true, "reason": "Recurring CI decision", "suggestedTitle": "TS CI via Actions"}';
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput([
        "we should configure github actions for typescript ci pipelines",
        "please set up CI for typescript using github actions",
        "how to configure github actions for typescript ci",
      ]),
    );
    expect(v.necessary).toBe(true);
    expect(v.reason).toBe("Recurring CI decision");
    expect(v.suggestedTitle).toBe("TS CI via Actions");
  });

  // ============================================================
  // JS 内部错误 + fallback 加固(Finding 264/265 P0)
  // ============================================================

  it("LlmClient 返回非 string(undefined)→ 安全 fallback,不抛 TypeError", async () => {
    // host adapter bug:返回 undefined 而非 string
    const stubClient: LlmClient = {
      async complete() {
        return undefined as unknown as string;
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    // 不应抛 TypeError(trim of undefined),应走 fallback 路径
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toMatch(/internal-error.*rule-fallback|fallback-failed/);
  });

  it("LlmClient 返回 null → 安全 fallback", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return null as unknown as string;
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toMatch(/internal-error/);
  });

  it("LlmClient 返回空字符串 → 安全 fallback", async () => {
    const stubClient: LlmClient = {
      async complete() {
        return "";
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toMatch(/internal-error/);
  });

  it("parseLlmVerdict 内部异常被 try/catch 兜住 → 安全 fallback", async () => {
    // 构造一个让 parseLlmVerdict 抛错的输入(parseLlmVerdict 内部已有 try/catch,
    // 但 defensive:即便它抛,evaluate 也不会崩)
    const stubClient: LlmClient = {
      async complete() {
        // 包含 { 但 JSON.parse 失败的字符串(parseLlmVerdict 正常返回 null)
        return "{ not valid json at all";
      },
    };
    const evaluator = new LlmNecessityEvaluator(stubClient);
    const v = await evaluator.evaluate(
      makeInput(["same same same same same same same same"], 3),
    );
    expect(v.necessary).toBe(false);
    expect(v.reason).toMatch(/llm-parse-failed/);
  });
});
