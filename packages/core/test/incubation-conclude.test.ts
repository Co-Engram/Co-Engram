import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import { synthesizeFinalAnswer } from "../src/maintenance/insight/night-thinking.js";

function makeIncubator(llmComplete?: () => Promise<string>) {
  const dataRoot = mkdtempSync(join(tmpdir(), "inc-conclude-"));
  const incubator = new Incubator({
    repository: {} as never,
    proposalEngine: {
      proposeInsight: () => true,
      listAll: () => [],
      findProposalByEntityId: () => undefined,
    },
    dataRoot,
    ...(llmComplete ? { llmClient: { complete: llmComplete } as never } : {}),
  });
  return { incubator };
}

describe("conclude / updateSchedule", () => {
  it("llmClient 缺失 → conclude 抛错,状态不变", async () => {
    const { incubator } = makeIncubator();
    const e = incubator.create({ question: "测试问题ABC" });
    await expect(incubator.conclude(e.id)).rejects.toThrow(/llmClient/);
    expect(incubator.get(e.id)?.status).toBe("active");
    expect(incubator.get(e.id)?.finalAnswer).toBeUndefined();
  });

  it("conclude 成功 → finalAnswer + suggested-resolve + concludedAt;幂等可重复", async () => {
    const { incubator } = makeIncubator(async () => "最终回答:三步走。");
    const e = incubator.create({ question: "测试问题ABC" });
    const r1 = await incubator.conclude(e.id);
    expect(r1.finalAnswer).toBe("最终回答:三步走。");
    expect(r1.status).toBe("suggested-resolve");
    expect(r1.concludedAt).toBeTruthy();
    const r2 = await incubator.conclude(e.id);
    expect(r2.finalAnswer).toBe("最终回答:三步走。");
  });

  it("conclude 后 resolve(answered=false) 回 active,再 conclude 仍可", async () => {
    const { incubator } = makeIncubator(async () => "再次回答。");
    const e = incubator.create({ question: "测试问题ABC" });
    await incubator.conclude(e.id);
    incubator.resolve(e.id, false);
    const r = await incubator.conclude(e.id);
    expect(r.status).toBe("suggested-resolve");
    expect(r.finalAnswer).toBe("再次回答。");
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
    await synthesizeFinalAnswer(llm, "问题", "- Round 1(manual): (no insight survived validation)");
    expect(captured).toContain("MANDATORY: no insight survived");
    const mixed =
      "- Round 1(manual): 洞察甲 [accepted]\n" +
      "- Round 2(scheduled): (no insight survived validation)";
    await synthesizeFinalAnswer(llm, "问题", mixed);
    expect(captured).not.toContain("MANDATORY");
    expect(captured).toContain("Synthesize the accumulated");
  });

  it("空输出 → 抛错(不降级)", async () => {
    const llm = { complete: async () => "   " } as never;
    await expect(synthesizeFinalAnswer(llm, "问题", "")).rejects.toThrow(/empty final answer/);
  });
});
