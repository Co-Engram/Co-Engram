import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { NightThinkingReport } from "../src/maintenance/insight/types.js";

function makeIncubator(opts: { llmComplete?: () => Promise<string> } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-report-"));
  const incubator = new Incubator({
    repository: {
      readEngram: () => {
        throw new Error("not found");
      },
    } as never,
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
    const { incubator } = makeIncubator({
      llmComplete: async () => '{"overall":0.1,"rationale":"weak"}',
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
  });

  it("空报告 drafts=0", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    const r = await incubator.report({ incubationId: e.id, report: reportOf([]), trigger: "scheduled", actor: "test" });
    expect(r.entry.timeline.at(-1)?.diagnosis).toMatchObject({ drafts: 0, llmClientMissing: true });
  });
});
