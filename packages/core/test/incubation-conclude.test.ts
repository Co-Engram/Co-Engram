import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import {
  NO_SURVIVOR_MARKER,
  synthesizeFinalAnswer,
} from "../src/maintenance/insight/night-thinking.js";
import type { NightThinkingReport } from "../src/maintenance/insight/types.js";

function makeIncubator(
  opts: {
    llmComplete?: (prompt: string) => Promise<string>;
    /** 模拟已被 accept 的提案 entityId(构造 normalize 翻转场景) */
    acceptedEntityId?: string;
    /** 审计收集器(断言 incubation_conclude 审计事件) */
    audit?: Array<{ actor: string; action: string; metadata?: Record<string, unknown> }>;
  } = {},
) {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-conclude-"));
  const incubator = new Incubator({
    repository: {} as never,
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: (entityId: string) =>
        entityId === opts.acceptedEntityId ? { status: "accepted" } : undefined,
    },
    dataRoot,
    ...(opts.llmComplete ? { llmClient: { complete: opts.llmComplete } as never } : {}),
    ...(opts.audit
      ? {
          auditLog: {
            append: (e: { actor: string; action: string; metadata?: Record<string, unknown> }) => {
              opts.audit!.push(e);
            },
          },
        }
      : {}),
  });
  return { incubator, dataRoot };
}

const reportOf = (insights: unknown[]): NightThinkingReport =>
  ({ insights, plan: [], trace: [], externalCalls: [] }) as NightThinkingReport;

/** 直改盘上 incubations.json(模拟并发写者/注入历史轮次;参考 round-report 测试手法) */
const patchDisk = (dataRoot: string, mutate: (x: Record<string, unknown>) => void) => {
  const path = join(dataRoot, ".co-engram", "incubations.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
  for (const x of raw) mutate(x);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
};

/** 注入一条含 accepted 提案的历史轮(normalize 翻转的 hasAccepted 前置) */
const injectAcceptedRound = (dataRoot: string) => {
  patchDisk(dataRoot, (x) => {
    x.rounds = 1;
    x.timeline = [
      {
        at: "2026-08-15T00:00:00.000Z",
        trigger: "manual",
        round: 1,
        summaries: [],
        proposalEntityIds: ["ent-acc"],
        externalCallCount: 0,
      },
    ];
  });
};

describe("conclude / updateSchedule", () => {
  it("llmClient 缺失 → conclude 抛错,状态不变", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    await expect(incubator.conclude(e.id)).rejects.toThrow(/llmClient/);
    expect(incubator.get(e.id)?.status).toBe("active");
    expect(incubator.get(e.id)?.finalAnswer).toBeUndefined();
  });

  it("conclude 成功 → finalAnswer + suggested-resolve + concludedAt;幂等可重复(两次 conclude 恰好两次 LLM 调用,重生成非缓存)", async () => {
    let llmCalls = 0;
    const { incubator } = makeIncubator({
      llmComplete: async () => {
        llmCalls += 1;
        return "最终回答:三步走。";
      },
    });
    const e = incubator.create({ question: "测试问题ABC" });
    const r1 = await incubator.conclude(e.id);
    expect(r1.finalAnswer).toBe("最终回答:三步走。");
    expect(r1.status).toBe("suggested-resolve");
    expect(r1.concludedAt).toBeTruthy();
    const r2 = await incubator.conclude(e.id);
    expect(r2.finalAnswer).toBe("最终回答:三步走。");
    expect(llmCalls).toBe(2);
  });

  it("conclude 后 resolve(answered=false) 回 active,再 conclude 仍可", async () => {
    const { incubator } = makeIncubator({ llmComplete: async () => "再次回答。" });
    const e = incubator.create({ question: "测试问题ABC" });
    await incubator.conclude(e.id);
    incubator.resolve(e.id, false);
    const r = await incubator.conclude(e.id);
    expect(r.status).toBe("suggested-resolve");
    expect(r.finalAnswer).toBe("再次回答。");
  });

  it("conclude LLM await 窗口内 acquireInFlight(锚点到期/手动开跑)→ 写前复查拒绝,盘上仍 in-flight", async () => {
    let incubatorRef!: Incubator;
    let entryId = "";
    const { incubator } = makeIncubator({
      llmComplete: async () => {
        // 模拟窗口内调度器合法拿锁开跑(此刻盘上 active → acquire 成功)
        incubatorRef.acquireInFlight(entryId, "scheduled-run");
        return "最终回答。";
      },
    });
    incubatorRef = incubator;
    const e = incubator.create({ question: "测试问题ABC" });
    entryId = e.id;
    await expect(incubator.conclude(e.id)).rejects.toThrow(/in-flight/);
    expect(incubator.get(e.id)?.status).toBe("in-flight");
  });

  it("conclude 成功 → 审计记 incubation_conclude(incubationId + finalAnswerPreview 截断 200)", async () => {
    const audit: Array<{ actor: string; action: string; metadata?: Record<string, unknown> }> = [];
    const { incubator } = makeIncubator({
      llmComplete: async () => "答".repeat(300),
      audit,
    });
    const e = incubator.create({ question: "测试问题ABC" });
    await incubator.conclude(e.id);
    const rec = audit.find((x) => x.action === "incubation_conclude");
    expect(rec).toBeDefined();
    expect(rec!.actor).toBe("user");
    expect(rec!.metadata!.incubationId).toBe(e.id);
    expect(rec!.metadata!.finalAnswerPreview).toBe("答".repeat(200));
  });

  it("updateSchedule 合法值落盘;in-flight 拒绝;非法值抛错", () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    expect(incubator.updateSchedule(e.id, "08:15").schedule).toBe("08:15");
    expect(() => incubator.updateSchedule(e.id, "8:15")).toThrow();
    incubator.acquireInFlight(e.id, "test");
    expect(() => incubator.updateSchedule(e.id, "09:00")).toThrow(/in-flight/);
  });

  it("create 非法 schedule 抛错(域层对称校验)", () => {
    const { incubator } = makeIncubator();
    expect(() => incubator.create({ question: "测试问题ABC", schedule: "9:30" })).toThrow();
  });
});

describe("resumedAt:用户显式续孵不被 suggested-resolve 建议翻转覆盖", () => {
  it("hasAccepted 场景:get() 读回 suggested-resolve(自动翻转存在锁定)", () => {
    const { incubator, dataRoot } = makeIncubator({ acceptedEntityId: "ent-acc" });
    const e = incubator.create({ question: "测试问题ABC" });
    injectAcceptedRound(dataRoot);
    expect(incubator.get(e.id)?.status).toBe("suggested-resolve");
  });

  it("resolve(false) → resumedAt 生效,get() 读回 active(用户裁决主权,核心断言)", () => {
    const { incubator, dataRoot } = makeIncubator({ acceptedEntityId: "ent-acc" });
    const e = incubator.create({ question: "测试问题ABC" });
    injectAcceptedRound(dataRoot);
    expect(incubator.get(e.id)?.status).toBe("suggested-resolve");
    const r = incubator.resolve(e.id, false);
    expect(r.status).toBe("active");
    expect(r.resumedAt).toBeTruthy();
    expect(incubator.get(e.id)?.status).toBe("active");
  });

  it("带 resumedAt 跑一轮 report() → 盘上清除标记;hasAccepted 仍真 → 读回再变 suggested-resolve(清除-重武装闭环)", async () => {
    const { incubator, dataRoot } = makeIncubator({ acceptedEntityId: "ent-acc" });
    const e = incubator.create({ question: "测试问题ABC" });
    injectAcceptedRound(dataRoot);
    incubator.resolve(e.id, false);
    expect(incubator.get(e.id)?.status).toBe("active");
    await incubator.report({
      incubationId: e.id,
      report: reportOf([]),
      trigger: "manual",
      actor: "test",
    });
    const raw = JSON.parse(
      readFileSync(join(dataRoot, ".co-engram", "incubations.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect("resumedAt" in raw[0]!).toBe(false); // 盘上标记已清除
    expect(incubator.get(e.id)?.status).toBe("suggested-resolve"); // 建议重新武装
  });
});

describe("NO_SURVIVOR_MARKER 生产端-消费端集成", () => {
  it("真实走 reportOf([]) 一轮(零存活)→ conclude 捕获 prompt 含 MANDATORY + 标记(锁 dreamHistoryFor→synthesizeFinalAnswer 契约)", async () => {
    let finalPrompt = "";
    const { incubator } = makeIncubator({
      llmComplete: async (prompt) => {
        if (prompt.includes("FINAL ANSWER")) finalPrompt = prompt;
        return "回答。";
      },
    });
    const e = incubator.create({ question: "测试问题ABC" });
    // 零存活轮:dreamHistoryFor 用 NO_SURVIVOR_MARKER 渲染该轮
    await incubator.report({
      incubationId: e.id,
      report: reportOf([]),
      trigger: "manual",
      actor: "test",
    });
    await incubator.conclude(e.id);
    expect(finalPrompt).toContain(NO_SURVIVOR_MARKER);
    expect(finalPrompt).toContain("MANDATORY: no insight survived");
  });
});

describe("synthesizeFinalAnswer 诚实性分支", () => {
  it("空历史/全零存活 → 空态指令;混合历史(部分轮成案)→ 综合指令", async () => {
    let captured = "";
    const llm = {
      complete: async (prompt: string) => {
        captured = prompt;
        return "回答内容。";
      },
    } as never;
    expect(await synthesizeFinalAnswer(llm, "问题", "")).toBe("回答内容。");
    expect(captured).toContain("MANDATORY: no insight survived");
    await synthesizeFinalAnswer(llm, "问题", `- Round 1(manual): ${NO_SURVIVOR_MARKER}`);
    expect(captured).toContain("MANDATORY: no insight survived");
    const mixed =
      `- Round 1(manual): 洞察甲 [accepted]\n` +
      `- Round 2(scheduled): ${NO_SURVIVOR_MARKER}`;
    await synthesizeFinalAnswer(llm, "问题", mixed);
    expect(captured).not.toContain("MANDATORY");
    expect(captured).toContain("Synthesize the accumulated");
  });

  it("空输出 → 抛错(不降级)", async () => {
    const llm = { complete: async () => "   " } as never;
    await expect(synthesizeFinalAnswer(llm, "问题", "")).rejects.toThrow(/empty final answer/);
  });
});
