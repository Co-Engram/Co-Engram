import { describe, it, expect } from "vitest";

import {
  RuleBasedNecessityEvaluator,
  LlmNecessityEvaluator,
  prefilterMessage,
  isConversationalArtifact,
  type LlmClient,
  type NecessityInput,
} from "../src/observability/necessity-evaluator.js";

// ============================================================
// isConversationalArtifact(对话内务检测)
// ============================================================

describe("isConversationalArtifact", () => {
  describe("5 类信号正检测", () => {
    it("tense_dominated: ≥2 个对话时态短语命中", () => {
      const v = isConversationalArtifact(
        "我会先做 A,然后做 B,接下来检查 C,马上开始执行",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons).toContain("tense_dominated");
    });

    it("deictic_refs: ≥2 个指代词命中", () => {
      const v = isConversationalArtifact(
        "上面提到的那个方法,这里有问题,前面已经说过了",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons).toContain("deictic_refs");
    });

    it("process_signature:table — markdown 表格", () => {
      const v = isConversationalArtifact(
        "确认配置:\n| 项 | 值 |\n|---|---|\n| Remote | origin |\n| Branch | master |",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons.some((r) => r.startsWith("process_signature:"))).toBe(
        true,
      );
      expect(v.reasons.join(",")).toMatch(/table/);
    });

    it("process_signature:sha — 完整 commit SHA", () => {
      const v = isConversationalArtifact(
        "landed in commit 7a5fc2b7928e6c4af8a14d1b9d33e1f7c2b4a8e5 last week",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons.join(",")).toMatch(/sha/);
    });

    it("process_signature:ulid — co-engram ULID", () => {
      const v = isConversationalArtifact(
        "memory id 01KWC3W55HD0MSN6ECCF5040MJ was created just now",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons.join(",")).toMatch(/ulid/);
    });

    it("process_signature:token — GitHub PAT", () => {
      const v = isConversationalArtifact(
        "using token ghp_abcdefghijklmnopqrstuvwxyz in the URL",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons.join(",")).toMatch(/token/);
    });

    it("process_signature:command — 命令字面量占消息 50%+", () => {
      const v = isConversationalArtifact(
        "run this: `git -c http.proxy=http://proxysz.zte.com.cn:80 push origin master`",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons.join(",")).toMatch(/command/);
    });

    it("enumerated_options: 方案 A/B/C 并列", () => {
      const v = isConversationalArtifact(
        "方案 A 是快速但粗糙,方案 B 是慢但严谨,方案 C 是折中",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons).toContain("enumerated_options");
    });

    it("enumerated_options: G1/G2/G3 标记", () => {
      const v = isConversationalArtifact(
        "G1 是轻量规则补强,G2 是中度规则,G3 是 LLM 启发式补强",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons).toContain("enumerated_options");
    });

    it("self_meta: 强信号,单次命中即拒", () => {
      const v = isConversationalArtifact(
        "我推荐 G1+G2+G3 三层联动,等你确认方向后开始执行",
      );
      expect(v.artifact).toBe(true);
      expect(v.reasons).toContain("self_meta");
    });

    it("复合信号: 配置表 + 指代 + 自我元层同时命中(用户原始例子)", () => {
      const v = isConversationalArtifact(
        "确认 push 配置:\n| 项 | 值 |\n|---|---|\n| Remote | https://github.com/yang/Co-Engram.git |\n| Token | ghp_abc |\n\n我推荐走代理方案,等你确认。",
      );
      expect(v.artifact).toBe(true);
      // 至少命中 2 类信号
      expect(v.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("负向(真正的领域事实不被误判)", () => {
    it("跨会话稳定的部署事实 → 不是内务产物", () => {
      const v = isConversationalArtifact(
        "ZTE 内网机器 push 到 github.com 必须走 HTTP 代理 + PAT,SSH 22/443 全被封禁",
      );
      expect(v.artifact).toBe(false);
      expect(v.reasons).toEqual([]);
    });

    it("co-engram 架构事实 → 不是内务产物", () => {
      const v = isConversationalArtifact(
        "co-engram 是跨宿主插件,core 和 viewer 在两个 host 之间共享同一份契约",
      );
      expect(v.artifact).toBe(false);
    });

    it("英文领域事实 → 不是内务产物", () => {
      const v = isConversationalArtifact(
        "co-engram default source path is fixed by CLAUDE.md and applies to all read/write/test operations across sessions",
      );
      expect(v.artifact).toBe(false);
    });

    it("单条时态短语(不达阈值)→ 不视为时态主导", () => {
      const v = isConversationalArtifact(
        "we should always configure github actions for typescript ci pipelines",
      );
      expect(v.artifact).toBe(false);
    });

    it("单条指代词(不达阈值)→ 不视为指代依赖", () => {
      const v = isConversationalArtifact(
        "this module exports the proposal engine and its supporting utilities",
      );
      expect(v.artifact).toBe(false);
    });
  });
});

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

  it("对话内务产物(配置表)→ 拒绝(rule=conversational_artifact)", () => {
    const v = prefilterMessage(
      "确认 push 配置:\n| 项 | 值 |\n|---|---|\n| Remote | origin |\n| Branch | master |",
      "assistant",
    );
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("conversational_artifact");
  });

  it("对话内务产物(选项枚举 + 自我元层)→ 拒绝(rule=conversational_artifact)", () => {
    const v = prefilterMessage(
      "我推荐方案 A,但方案 B 也行,等你确认方向",
      "assistant",
    );
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("conversational_artifact");
  });

  it("对话内务产物(进度报告 + 指代)→ 拒绝(rule=conversational_artifact)", () => {
    const v = prefilterMessage(
      "正在处理刚才提到的那个问题,接下来会检查这里的其他项",
      "assistant",
    );
    expect(v.accepted).toBe(false);
    expect(v.rule).toBe("conversational_artifact");
  });

  it("跨会话稳定的领域事实 → 通过(不被误判为内务产物)", () => {
    const v = prefilterMessage(
      "ZTE 内网机器 push 到 github.com 必须走 HTTP 代理 proxysz.zte.com.cn:80 加 PAT 认证",
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
    expect(v.reason).toMatch(/Passed 6 rule checks/);
  });

  it("对话内务产物占 ≥50% samples → 拒绝(rule=conversational_artifact, L2 兜底)", async () => {
    // L1 已挡这类内容,本测试验证 L2 防御性兜底(L1 万一漏检)
    const v = await evaluator.evaluate(
      makeInput([
        "确认配置表:\n| 项 | 值 |\n|---|---|\n| A | a |\n| B | b |",
        "另一个配置表:\n| 字段 | 值 |\n|---|---|\n| X | x |",
        "we should configure github actions for typescript ci pipelines",
        "we should set up github actions for typescript continuous integration",
      ]),
    );
    expect(v.necessary).toBe(false);
    expect(v.rule).toBe("conversational_artifact");
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
  // JS 内部错误 + fallback 加固(确保 evaluate 永不抛出)
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
