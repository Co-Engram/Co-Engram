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

function task(webResearchOptIn = false): NightThinkingTask {
  return {
    incubationId: "inc-test",
    question: "如何让团队记忆自进化?",
    seedDigests: [
      { id: "01A", title: "记忆A", summary: "摘要甲内容较长", domainTags: ["域甲"] },
      { id: "01B", title: "记忆B", summary: "摘要乙内容不同", domainTags: ["域乙"] },
    ],
    dreamHistory: "Round 1: 探索了 X",
    webResearchOptIn,
    resourceHints: [],
    protocol: "NIGHT-THINKING PROTOCOL: ... call the tool `incubation_report` exactly once ...",
  };
}

describe("buildHeadlessArgs(隐私硬约束)", () => {
  it("默认不含 WebSearch/写工具;只读白名单 + json 输出", () => {
    const args = buildHeadlessArgs(task(false), 30);
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

  it("webResearchOptIn=true → 允许 WebSearch/WebFetch", () => {
    const allowed = buildHeadlessArgs(task(true), 30).join(" ").split("--allowedTools ")[1]!;
    expect(allowed).toContain("WebSearch");
    expect(allowed).toContain("WebFetch");
  });
});

describe("buildHeadlessPrompt(脱敏)", () => {
  it("含问题/种子摘要/梦境史/隐私边界;不含 allowedTools 之外的指令污染", () => {
    const p = buildHeadlessPrompt(task(true));
    expect(p).toContain("如何让团队记忆自进化?");
    expect(p).toContain("摘要甲内容较长");
    expect(p).toContain("Round 1: 探索了 X");
    expect(p).toContain("ALLOWED");
    expect(p.toLowerCase()).toContain("never send raw memory content");
  });

  it("webResearchOptIn=false → 明示禁止联网", () => {
    const p = buildHeadlessPrompt(task(false));
    expect(p).toContain("DISABLED");
    expect(p).toContain("Do NOT make any network call");
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
  it("剥 result 包裹 + ```json 围栏 → NightThinkingReport", () => {
    const inner = JSON.stringify({
      insights: [],
      plan: [{ step: "s", capability: "c" }],
      trace: [],
      externalCalls: [{ tool: "WebSearch", purpose: "p", at: "2026-08-15T00:00:00Z" }],
    });
    const raw = JSON.stringify({ type: "result", result: "```json\n" + inner + "\n```" });
    const r = parseHeadlessReport(raw);
    expect(r.plan).toHaveLength(1);
    expect(r.externalCalls).toHaveLength(1);
  });

  it("垃圾输出 → 抛错(上层降级 L1)", () => {
    expect(() => parseHeadlessReport("no json here")).toThrow();
    expect(() => parseHeadlessReport(JSON.stringify({ type: "result", result: "{not-json" }))).toThrow();
  });
});

describe("createHeadlessExecutor", () => {
  it("spawnFn 收到 -p <prompt> + flags;正常解析回写", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const report = {
      insights: [],
      plan: [],
      trace: [],
      externalCalls: [],
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
