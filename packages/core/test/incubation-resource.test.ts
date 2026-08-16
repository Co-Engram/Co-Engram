// resourceHints(行为日志/状态文件盘点)与协议 RESOURCE MANDATE(spec §六全资源)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Incubator } from "../src/maintenance/insight/incubator.js";
import {
  buildProtocol,
  collectResourceHints,
  NIGHT_THINKING_PROTOCOL,
} from "../src/maintenance/insight/night-thinking.js";

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
    expect(NIGHT_THINKING_PROTOCOL).toContain("RESOURCE MANDATE");
    expect(NIGHT_THINKING_PROTOCOL).toContain("Do NOT limit yourself to the seed digests");
    expect(NIGHT_THINKING_PROTOCOL).toContain("skill_list");
    expect(NIGHT_THINKING_PROTOCOL).toContain("task.resourceHints");
  });

  it("协议含 EVIDENCE ANCHORING 硬门(sourceIds 只认记忆库 engram id)", () => {
    // 2026-08-16 机制缺陷修复:全资源盘点的证据(codegraph/日志/web)不是
    // 合法 sourceIds,引用闭合只认 repo engram —— 协议必须显式引导 LLM 锚定
    expect(NIGHT_THINKING_PROTOCOL).toContain("EVIDENCE ANCHORING");
    expect(NIGHT_THINKING_PROTOCOL).toContain("real engram ids from the memory repo");
    expect(NIGHT_THINKING_PROTOCOL).toContain("NOT valid sourceIds");
    expect(NIGHT_THINKING_PROTOCOL).toContain("rejected by\n   the citation gate");
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

  it("buildProtocol 输出仍含隐私开关", () => {
    expect(buildProtocol(false)).toContain("DISABLED");
    expect(buildProtocol(true)).toContain("ALLOWED");
  });
});
