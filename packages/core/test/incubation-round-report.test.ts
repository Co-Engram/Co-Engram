import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { NightThinkingReport } from "../src/maintenance/insight/types.js";

function makeIncubator(
  opts: { llmComplete?: () => Promise<string>; readableSources?: boolean } = {},
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
    },
    dataRoot,
    ...(opts.llmComplete ? { llmClient: { complete: opts.llmComplete } as never } : {}),
    now: () => "2026-08-16T02:00:00.000Z",
  });
  return { incubator };
}

const reportOf = (insights: unknown[]): NightThinkingReport =>
  ({ insights, plan: [], trace: [], externalCalls: [] }) as NightThinkingReport;

describe("report() diagnosis 计数", () => {
  it("llmClient 缺失 → llmClientMissing=true,校验拒(引用缺失)计数", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t", summary: "s", content: "c", sourceIds: ["missing-id"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    const diag = r.entry.timeline.at(-1)?.diagnosis;
    expect(diag).toEqual({ drafts: 1, dupVetoed: 0, validateRejected: 1, criticRejected: 0, llmClientMissing: true });
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
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t2", summary: "s2", content: "c2", sourceIds: ["missing-id"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    expect(r.entry.timeline.at(-1)?.diagnosis?.validateRejected).toBe(1);
    expect(r.entry.timeline.at(-1)?.diagnosis?.llmClientMissing).toBe(false);
    // validate 拒后短路:critic 不被触达;有 llmClient 时仅 answerDraft 综合产生 1 次调用
    expect(llmCalls).toBe(1);
  });

  it("llmClient 在 + validate 过 + critic 低分(0.1 < 0.6)→ criticRejected 计数,不出提案", async () => {
    const { incubator } = makeIncubator({
      readableSources: true,
      llmComplete: async () => '{"overall":0.1,"rationale":"weak"}',
    });
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "t3", summary: "s3", content: "c3", sourceIds: ["src-1", "src-2"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    const diag = r.entry.timeline.at(-1)?.diagnosis;
    expect(diag).toEqual({ drafts: 1, dupVetoed: 0, validateRejected: 0, criticRejected: 1, llmClientMissing: false });
    expect(r.proposals).toBe(0);
  });

  it("llmClient 在 + validate 过 + critic 高分(0.9 ≥ 0.6)→ 提案成功,timeline 回写标题与 entityId", async () => {
    const { incubator } = makeIncubator({
      readableSources: true,
      llmComplete: async () => '{"overall":0.9,"rationale":"ok"}',
    });
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({
      incubationId: e.id,
      report: reportOf([{ mode: "inspiration", type: "theme", title: "跨域共性主题", summary: "s4", content: "c4", sourceIds: ["src-1", "src-2"], domainTags: [], reason: "r" }]),
      trigger: "manual",
      actor: "test",
    });
    expect(r.proposals).toBe(1);
    const ev = r.entry.timeline.at(-1);
    expect(ev?.diagnosis).toEqual({ drafts: 1, dupVetoed: 0, validateRejected: 0, criticRejected: 0, llmClientMissing: false });
    expect(ev?.summaries).toContain("跨域共性主题");
    expect(ev?.proposalEntityIds).toHaveLength(1);
  });

  it("空报告 drafts=0", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "scheduled", actor: "test" });
    expect(r.entry.timeline.at(-1)?.diagnosis).toMatchObject({ drafts: 0, llmClientMissing: true });
  });
});

describe("report() answerDraft(不降级,失败报错)", () => {
  it("llmClient 缺失 → answerDraftError,无草稿", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const last = r.entry.timeline.at(-1);
    expect(last?.answerDraft).toBeUndefined();
    expect(last?.answerDraftError).toBe("llmClient unavailable");
  });

  it("综合成功 → answerDraft 为 LLM 输出", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "阶段结论:方向 A 成立。" });
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(r.entry.timeline.at(-1)?.answerDraft).toBe("阶段结论:方向 A 成立。");
  });

  it("综合调用失败 → answerDraftError 含原因,不生成伪草稿", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => { throw new Error("boom"); } });
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    const last = r.entry.timeline.at(-1);
    expect(last?.answerDraft).toBeUndefined();
    expect(last?.answerDraftError).toContain("boom");
  });

  it("空输出 → answerDraftError", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "   " });
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "manual", actor: "test" });
    expect(r.entry.timeline.at(-1)?.answerDraftError).toBeTruthy();
  });
});
