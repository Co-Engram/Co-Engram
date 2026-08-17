// L2 headless 执行器:CLI 参数组装(授权白名单/隐私)、结果解析、失败路径
import { describe, expect, it } from "vitest";

import {
  buildHeadlessArgs,
  buildHeadlessPrompt,
  createHeadlessExecutor,
  parseHeadlessReport,
  READONLY_ALLOWED_TOOLS,
} from "../src/night-thinking/headless-executor.js";
import type { NightThinkingTask } from "@co-engram/core";

function task(): NightThinkingTask {
  return {
    incubationId: "inc-test",
    question: "如何让团队记忆自进化?",
    seedDigests: [
      { id: "01A", title: "记忆A", summary: "摘要甲内容较长", domainTags: ["域甲"] },
      { id: "01B", title: "记忆B", summary: "摘要乙内容不同", domainTags: ["域乙"] },
    ],
    dreamHistory: "Session 1: 探索了 X",
    resourceHints: [],
    protocol: "CONTEMPLATION PROTOCOL: ... call the tool `ponder_report` exactly once ...",
  };
}

describe("buildHeadlessArgs(隐私硬约束)", () => {
  it("默认不含 WebSearch/写工具;只读白名单 + json 输出", () => {
    const args = buildHeadlessArgs(task(), 30);
    const joined = args.join(" ");
    const allowed = joined.split("--allowedTools ")[1]!;
    for (const t of READONLY_ALLOWED_TOOLS) {
      expect(allowed).toContain(t);
    }
    expect(allowed).not.toContain("WebSearch");
    expect(allowed).not.toContain("engram_create");
    expect(allowed).not.toContain("engram_update");
    expect(allowed).not.toContain("incubation_report");
    expect(joined).toContain("--output-format json");
    expect(joined).toContain("--max-turns 30");
  });

  it("任何条目都不允许 WebFetch(2026-08-17 联网线移除,白名单恒定纯本地)", () => {
    const allowed = buildHeadlessArgs(task(), 30).join(" ").split("--allowedTools ")[1]!;
    expect(allowed).not.toContain("WebSearch");
    expect(allowed).not.toContain("WebFetch");
  });
});

describe("buildHeadlessPrompt(脱敏)", () => {
  it("含问题/种子摘要/深思史/本地只读边界;协议锚点替换为 headless 回答形态", () => {
    const p = buildHeadlessPrompt(task());
    expect(p).toContain("如何让团队记忆自进化?");
    expect(p).toContain("摘要甲内容较长");
    expect(p).toContain("Session 1: 探索了 X");
    expect(p).toContain("Previous thinking sessions");
    // 本地只读边界(2026-08-17:联网线移除,无 opt-in 分支)
    expect(p).toContain("LOCAL and READ-ONLY");
    expect(p).toContain("do not make any network call");
    // 协议锚点替换:ponder_report 工具调用指令 → headless final-answer JSON
    expect(p).not.toContain("call the tool `ponder_report` exactly once");
    expect(p).toContain("return the report object as your final answer");
    expect(p).toContain("resourcesUsed");
  });

  it("prompt 渲染 resourceHints 路径清单(节标题与协议措辞呼应)", () => {
    const prompt = buildHeadlessPrompt({
      ...task(),
      resourceHints: ["/tmp/x/.co-engram/signals.jsonl"],
    });
    expect(prompt).toContain("## Resource hints (task.resourceHints — local, read-only)");
    expect(prompt).toContain("/tmp/x/.co-engram/signals.jsonl");
  });

  it("无 resourceHints 时渲染占位行而非省略节(T7 评审)", () => {
    const prompt = buildHeadlessPrompt({ ...task(), resourceHints: [] });
    expect(prompt).toContain("## Resource hints");
    expect(prompt).toContain("(none in this environment");
  });
});

describe("parseHeadlessReport", () => {
  it("剥 result 包裹 + ```json 围栏 → NightThinkingReport(含 answer/resourcesUsed)", () => {
    const inner = JSON.stringify({
      answer: "执行现场回答",
      insights: [],
      plan: [{ step: "s", capability: "c" }],
      trace: [],
      resourcesUsed: { engrams: ["01A"], skills: ["技能甲"], logs: [] },
    });
    const raw = JSON.stringify({ type: "result", result: "```json\n" + inner + "\n```" });
    const r = parseHeadlessReport(raw);
    expect(r.plan).toHaveLength(1);
    expect(r.answer).toBe("执行现场回答");
    expect(r.resourcesUsed?.engrams).toEqual(["01A"]);
  });

  it("垃圾输出 → 抛错;answer 与 insights 双缺 → 抛错", () => {
    expect(() => parseHeadlessReport("no json here")).toThrow();
    expect(() => parseHeadlessReport(JSON.stringify({ type: "result", result: "{not-json" }))).toThrow();
    // 新契约:answer 是主体 —— insights 缺失容错为空数组,answer 保留;
    // 两者双缺才是坏报告
    const answerOnly = parseHeadlessReport(JSON.stringify({ type: "result", result: '{"answer":"只有回答"}' }));
    expect(answerOnly.answer).toBe("只有回答");
    expect(answerOnly.insights).toEqual([]);
    expect(() => parseHeadlessReport(JSON.stringify({ type: "result", result: '{"plan":[]}' }))).toThrow(/neither/);
  });
});

describe("createHeadlessExecutor", () => {
  it("spawnFn 收到 -p <prompt> + flags;正常解析回写", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const report = {
      answer: "回答",
      insights: [],
      plan: [],
      trace: [],
    };
    const exec = createHeadlessExecutor({
      spawnFn: async (cmd, args) => {
        calls.push({ cmd, args });
        return {
          stdout: JSON.stringify({ result: "```json\n" + JSON.stringify(report) + "\n```" }),
          stderr: "",
          code: 0,
        };
      },
    });
    const r = await exec.execute(task(false));
    expect(r.insights).toEqual([]);
    expect(calls[0]!.cmd).toBe("claude");
    expect(calls[0]!.args[0]).toBe("-p");
    expect(calls[0]!.args[1]).toContain("如何让团队记忆自进化?");
    expect(calls[0]!.args.join(" ")).toContain("--allowedTools");
  });

  it("非零退出码 → 抛错(Incubator 降级 L1)", async () => {
    const exec = createHeadlessExecutor({
      spawnFn: async () => ({ stdout: "", stderr: "boom", code: 1 }),
    });
    await expect(exec.execute(task(false))).rejects.toThrow("exited 1");
  });
});
