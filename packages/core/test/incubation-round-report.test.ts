import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { NightThinkingReport } from "../src/maintenance/insight/types.js";

function makeIncubator(
  opts: { llmComplete?: (prompt: string) => Promise<string>; readableSources?: boolean } = {},
) {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-report-"));
  const incubator = new Incubator({
    repository: opts.readableSources
      ? ({
          // subgraphFor 用 readEngram 构造校验子图(12 个字段);
          // validate 用 exists(引用闭合)+ listDigestByVerificationStatus(查重)
          readEngram: (id: string) => ({
            id,
            title: `T-${id}`,
            summary: "s",
            domainTags: ["x"],
            kind: "observation",
            importance: 0.5,
            confidence: 0.5,
            verificationStatus: null,
            retrievalCount: 0,
            failedUses: 0,
            reinforcementScore: 0,
            updatedAt: "2026-08-01T00:00:00.000Z",
          }),
          exists: () => true,
          listDigestByVerificationStatus: () => [],
        } as never)
      : ({
          readEngram: () => {
            throw new Error("not found");
          },
        } as never),
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: () => undefined,
      setInsightClosureState: () => {},
    },
    dataRoot,
    ...(opts.llmComplete ? { llmClient: { complete: opts.llmComplete } as never } : {}),
    now: () => "2026-08-16T02:00:00.000Z",
  });
  return { incubator, dataRoot };
}

const reportOf = (insights: unknown[]): NightThinkingReport =>
  ({ insights, plan: [], trace: [] }) as NightThinkingReport;

/** PDCA(Phase1):report 仅接受激活 run(thinking 起);create 后直接开跑 */
function createRunning(
  incubator: Incubator,
  question = "测试问题ABC",
): ReturnType<Incubator["create"]> {
  const e = incubator.create({ question });
  incubator.acquireThinking(e.id, "test");
  return e;
}

describe("report() diagnosis 计数", () => {
  it("llmClient 缺失 → llmClientMissing=true,校验拒(引用缺失)计数", async () => {
    const { incubator } = makeIncubator();
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t", summary: "s", content: "c", sourceIds: ["missing-id"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    const diag = r.entry.timeline.at(-1)?.diagnosis;
    expect(diag).toMatchObject({ drafts: 1, dupVetoed: 0, validateRejected: 1, criticRejected: 0, llmClientMissing: true });
    // 逐条拒因落盘(2026-08-16 诊断可达性):title 前缀 + 引用闭合成因
    expect(diag?.rejectReasons?.[0]).toContain("[validate] t");
    expect(diag?.rejectReasons?.[0]).toContain("citation closure");
    expect(r.proposals).toBe(0);
  });

  it("有 llmClient 但 sourceIds 缺失 → validate 先拒,critic 不执行", async () => {
    let llmCalls = 0;
    const { incubator } = makeIncubator({
      llmComplete: async () => {
        llmCalls += 1;
        return '{"overall":0.9,"rationale":"x"}';
      },
    });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t2", summary: "s2", content: "c2", sourceIds: ["missing-id"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    expect(r.entry.timeline.at(-1)?.diagnosis?.validateRejected).toBe(1);
    expect(r.entry.timeline.at(-1)?.diagnosis?.llmClientMissing).toBe(false);
    // validate 拒后短路:critic 不被触达;有 llmClient 时仅 answer 综合产生 1 次调用
    expect(llmCalls).toBe(1);
  });

  it("llmClient 在 + validate 过 + critic 低分(0.1 < 0.6)→ criticRejected 计数,不出提案", async () => {
    const { incubator } = makeIncubator({
      readableSources: true,
      llmComplete: async () => '{"overall":0.1,"rationale":"weak"}',
    });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t3", summary: "s3", content: "c3", sourceIds: ["src-1", "src-2"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    const diag = r.entry.timeline.at(-1)?.diagnosis;
    expect(diag).toMatchObject({ drafts: 1, dupVetoed: 0, validateRejected: 0, criticRejected: 1, llmClientMissing: false });
    expect(diag?.rejectReasons?.[0]).toContain("[critic] t3");
    expect(diag?.rejectReasons?.[0]).toContain("0.10 < 0.6");
    expect(r.proposals).toBe(0);
  });

  it("llmClient 在 + validate 过 + critic 高分(0.9 ≥ 0.6)→ 提案成功,timeline 回写标题与 entityId", async () => {
    const { incubator } = makeIncubator({
      readableSources: true,
      llmComplete: async () => '{"overall":0.9,"rationale":"ok"}',
    });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "跨域共性主题", summary: "s4", content: "c4", sourceIds: ["src-1", "src-2"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    expect(r.proposals).toBe(1);
    const ev = r.entry.timeline.at(-1);
    expect(ev?.diagnosis).toEqual({ drafts: 1, dupVetoed: 0, validateRejected: 0, criticRejected: 0, criticUnparseable: 0, llmClientMissing: false });
    expect(ev?.summaries).toContain("跨域共性主题");
    expect(ev?.proposalEntityIds).toHaveLength(1);
  });

  it("空报告 drafts=0", async () => {
    const { incubator } = makeIncubator();
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "scheduled", actor: "test" });
    expect(r.entry.timeline.at(-1)?.diagnosis).toMatchObject({ drafts: 0, llmClientMissing: true });
  });
});

describe("report() answer(不降级,失败报错)", () => {
  it("llmClient 缺失 → answerError,无草稿", async () => {
    const { incubator } = makeIncubator();
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const last = r.entry.timeline.at(-1);
    expect(last?.answer).toBeUndefined();
    expect(last?.answerError).toBe("llmClient unavailable");
  });

  it("综合成功 → answer 为 LLM 输出", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "阶段结论:方向 A 成立。" });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(r.entry.timeline.at(-1)?.answer).toBe("阶段结论:方向 A 成立。");
  });

  it("综合调用失败 → answerError 含原因,不生成伪草稿", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => { throw new Error("boom"); } });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const last = r.entry.timeline.at(-1);
    expect(last?.answer).toBeUndefined();
    expect(last?.answerError).toContain("boom");
  });

  it("空输出 → answerError", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "   " });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(r.entry.timeline.at(-1)?.answerError).toBeTruthy();
  });
});

describe("report() 综合输入契约(证据面 / 梦境史 / 截断)", () => {
  it("第 1 轮 prompt 含 question、(no previous rounds) 与 (none survived this round) 空态占位", async () => {
    const prompts: string[] = [];
    const { incubator } = makeIncubator({
      llmComplete: async (prompt) => {
        prompts.push(prompt);
        return "阶段结论。";
      },
    });
    const e = createRunning(incubator, "如何让知识自然生长?");
    await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Question");
    expect(prompts[0]).toContain("如何让知识自然生长?");
    expect(prompts[0]).toContain("(no previous sessions)");
    expect(prompts[0]).toContain("(none survived this round)");
  });

  it("成案草稿以「标题 — 摘要」渲染(- 前缀);第 2 轮 prompt 累积第 1 轮梦境史", async () => {
    const prompts: string[] = [];
    const { incubator } = makeIncubator({
      readableSources: true,
      llmComplete: async (prompt) => {
        prompts.push(prompt);
        // critic 调用返回评分 JSON;综合调用(WORKING ANSWER DRAFT)返回草稿文本
        if (prompt.includes("independent critic")) {
          return '{"overall":0.9,"rationale":"ok"}';
        }
        return "阶段结论。";
      },
    });
    const e = createRunning(incubator, "如何让知识自然生长?");
    // 第 1 轮:1 条草稿通过 validate + critic → 成案
    const r1 = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "跨域共性主题", summary: "两域共享结构", content: "c", sourceIds: ["src-1", "src-2"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    expect(r1.proposals).toBe(1);
    const synth1 = prompts.find((p) => p.includes("writing the ANSWER"));
    expect(synth1).toBeDefined();
    // 证据面 = 「标题 — 摘要」(不再是纯 title),以 "- " 前缀成行
    expect(synth1).toContain("- 跨域共性主题 — 两域共享结构");
    // timeline.summaries 契约不变:仍只存 title(Jaccard 语料不动)
    expect(r1.entry.timeline.at(-1)?.summaries).toEqual(["跨域共性主题"]);

    // 第 2 轮:零成案 → 综合看到第 1 轮梦境史(dreamHistoryFor 生效)+ 空态占位
    prompts.length = 0;
    incubator.acquireThinking(e.id, "test");
    await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "scheduled", actor: "test" });
    const synth2 = prompts.find((p) => p.includes("writing the ANSWER"));
    expect(synth2).toBeDefined();
    expect(synth2).toContain("Session 1(manual): 跨域共性主题");
    expect(synth2).not.toContain("(no previous sessions)");
    expect(synth2).toContain("(none survived this round)");
  });

  it("综合输出 5000 字符 → answer 截断至 4000", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "结".repeat(5000) });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(r.entry.timeline.at(-1)?.answer).toHaveLength(4000);
  });
});

describe("report() 写前重读合并(并发与用户裁决保留)", () => {
  const overwriteDisk = (dataRoot: string, mutate: (x: { id: string; status: string }) => void) => {
    // 模拟轮中(report 挂起在综合 await 时)其他写者直接改盘
    const path = join(dataRoot, ".co-engram", "incubations.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; status: string }>;
    for (const x of raw) mutate(x);
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
  };

  it("轮中并发抢跑(改盘 status=thinking)→ 落盘 done(report 完成即 done),timeline 仍追加本轮", async () => {
    const { incubator, dataRoot } = makeIncubator({
      llmComplete: async () => {
        overwriteDisk(dataRoot, (x) => {
          x.status = "thinking";
        });
        return "阶段结论:本轮完成。";
      },
    });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const onDisk = incubator.get(e.id)!;
    // 单次执行语义:report 写回即 done(思考瞬态不残留)
    expect(onDisk.status).toBe("done");
    expect(r.entry.status).toBe("done");
    expect(onDisk.rounds).toBe(1); // 轮次与 timeline 仍推进
    expect(onDisk.timeline).toHaveLength(1);
    expect(onDisk.timeline.at(-1)?.answer).toBe("阶段结论:本轮完成。");
  });

  it("轮中条目被并发删除 → 放弃写入,不复活条目", async () => {
    const { incubator, dataRoot } = makeIncubator({
      llmComplete: async () => {
        writeFileSync(join(dataRoot, ".co-engram", "incubations.json"), "[]\n", "utf8");
        return "阶段结论。";
      },
    });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(incubator.get(e.id)).toBeUndefined(); // 未复活已删条目
    expect(r.entry.rounds).toBe(1); // 仍返回本轮计算结果
  });
});

describe("report() 执行语境落盘与综合注入(2026-08-16 机制缺陷修复)", () => {
  it("trace 摘要落 timeline 并注入 answer 综合输入;资源申报假 id 清洗", async () => {
    const prompts: string[] = [];
    const { incubator } = makeIncubator({
      llmComplete: async (p: string) => {
        prompts.push(p);
        return "阶段结论。";
      },
    });
    const e = createRunning(incubator, "测试问题ABC");
    const report = {
      insights: [{ mode: "inspiration", type: "theme", title: "t9", summary: "s9", content: "c9", sourceIds: ["missing-id"], domainTags: [], reason: "r" }],
      plan: [],
      trace: [
        { step: "survey", action: "engram_search", detail: "co-engram 相关记忆 21 条" },
        { step: "verify", action: "codegraph_explore", detail: "audit rotation 实现核实" },
      ],
      resourcesUsed: { engrams: ["missing-id"], skills: [], logs: [] },
    } as unknown as NightThinkingReport;
    const r = await incubator.report({ incubationId: e.id, report, trigger: "scheduled", actor: "test" });
    // timeline:轨迹摘要(截断格式)+ 拒因
    const last = r.entry.timeline.at(-1);
    expect(last?.trace).toEqual([
      "survey: engram_search — co-engram 相关记忆 21 条",
      "verify: codegraph_explore — audit rotation 实现核实",
    ]);
    expect(last?.diagnosis?.rejectReasons?.[0]).toContain("[validate] t9");
    // 依据清洗:编造 engram id(missing-id 不在库)→ 不落 resourcesUsed
    expect(last?.resourcesUsed).toBeUndefined();
    // answer 综合输入:轨迹 / 拒因两节都要在
    const synth = prompts.at(-1)!;
    expect(synth).toContain("## This round's execution trace");
    expect(synth).toContain("engram_search — co-engram 相关记忆 21 条");
    expect(synth).toContain("## This round's rejection reasons");
    expect(synth).toContain("[validate] t9");
  });

  it("零拒因零轨迹 → 两个可选字段均省略(旧 JSON 形状不变)", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "阶段结论。" });
    const e = createRunning(incubator, "测试问题ABC");
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const last = r.entry.timeline.at(-1);
    expect(last?.trace).toBeUndefined();
    expect(last?.diagnosis && "rejectReasons" in last.diagnosis).toBe(false);
  });
});
