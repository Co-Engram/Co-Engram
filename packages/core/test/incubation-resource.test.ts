// resourceHints(行为日志/状态文件盘点)与协议 RESOURCE MANDATE(spec §六全资源)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import {
  buildProtocol,
  collectResourceHints,
  CONTEMPLATION_PROTOCOL,
} from "../src/maintenance/insight/night-thinking.js";
import { insightLanguageDirective } from "../src/maintenance/insight/modes.js";

describe("resourceHints 与协议 Resource mandate", () => {
  it("collectResourceHints 只返回存在的文件", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "inc-res-"));
    const dir = join(dataRoot, ".co-engram");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "signals.jsonl"), "[]");
    const hints = collectResourceHints(dataRoot);
    expect(hints).toEqual([join(dir, "signals.jsonl")]);
  });

  it("协议含 RESOURCE MANDATE(全记忆/日志/技能三指令)", () => {
    expect(CONTEMPLATION_PROTOCOL).toContain("RESOURCE MANDATE");
    expect(CONTEMPLATION_PROTOCOL).toContain("Do NOT limit yourself to the seed digests");
    expect(CONTEMPLATION_PROTOCOL).toContain("skill_list");
    expect(CONTEMPLATION_PROTOCOL).toContain("task.resourceHints");
  });

  it("协议含 EVIDENCE ANCHORING 硬门 + resourcesUsed 申报(依据区契约)", () => {
    // 2026-08-16 机制缺陷修复:全资源盘点的证据(codegraph/日志)不是
    // 合法 sourceIds,引用闭合只认 repo engram —— 协议必须显式引导 LLM 锚定
    expect(CONTEMPLATION_PROTOCOL).toContain("EVIDENCE ANCHORING");
    expect(CONTEMPLATION_PROTOCOL).toContain("real engram ids from the memory repo");
    expect(CONTEMPLATION_PROTOCOL).toContain("NOT valid sourceIds");
    expect(CONTEMPLATION_PROTOCOL).toContain("rejected by the citation gate");
    // 2026-08-17:资源申报(「依据」区)+ 受控联网边界 + 回答在执行现场生产
    expect(CONTEMPLATION_PROTOCOL).toContain("resourcesUsed");
    expect(CONTEMPLATION_PROTOCOL).toContain("Web research");
    expect(CONTEMPLATION_PROTOCOL).toContain("never send raw memory content");
    expect(CONTEMPLATION_PROTOCOL).toContain("ANSWER —");
    // web 申报面(依据区第四面):{query, purpose}
    expect(CONTEMPLATION_PROTOCOL).toContain("\"web\":");
  });

  it("buildTask 携带 resourceHints", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "inc-res2-"));
    const dir = join(dataRoot, ".co-engram");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "maintenance-state.json"), "{}");
    const incubator = new Incubator({
      repository: {} as never,
      proposalEngine: { proposeInsight: () => true, listAll: () => [], findProposalByEntityId: () => undefined },
      dataRoot,
    });
    const e = incubator.create({ question: "测试问题ABC" });
    expect(incubator.buildTask(e.id).resourceHints).toEqual([join(dir, "maintenance-state.json")]);
  });

  it("buildProtocol 无参输出完整协议(2026-08-17 起纯本地,无联网开关);2026-08-18 起追加洞察语言指令", () => {
    // 协议主体不变 + 语言指令后缀(默认 zh;L2 无头会话此前无语言约束,洞察落英文)
    expect(buildProtocol()).toBe(CONTEMPLATION_PROTOCOL + "\n" + insightLanguageDirective("zh"));
    expect(buildProtocol("en")).toBe(CONTEMPLATION_PROTOCOL + "\n" + insightLanguageDirective("en"));
  });
});
