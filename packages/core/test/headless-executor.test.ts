import { describe, expect, it } from "vitest";

import {
  READONLY_ALLOWED_TOOLS,
  buildHeadlessArgs,
  buildHeadlessPrompt,
  createHeadlessExecutor,
  parseHeadlessReport,
} from "../src/maintenance/insight/headless-executor.js";
import { buildProtocol } from "../src/maintenance/insight/night-thinking.js";
import type { NightThinkingTask } from "../src/maintenance/insight/types.js";

const task: NightThinkingTask = {
  incubationId: "inc-test",
  question: "测试问题",
  seedDigests: [],
  dreamHistory: "",
  resourceHints: [],
  protocol: buildProtocol(),
};

describe("headless executor(受控联网 + 只读白名单 + web 申报面)", () => {
  it("只读白名单含 WebSearch/WebFetch/engram_audit_query,不含任何写工具", () => {
    expect(READONLY_ALLOWED_TOOLS).toContain("WebSearch");
    expect(READONLY_ALLOWED_TOOLS).toContain("WebFetch");
    expect(READONLY_ALLOWED_TOOLS).toContain("mcp__co-engram__engram_audit_query");
    for (const t of READONLY_ALLOWED_TOOLS) {
      expect(t).not.toMatch(/engram_create|engram_update|engram_delete|synapse_create|skill_create|engram_sync|ponder_report/);
    }
  });

  it("buildHeadlessArgs 默认拼只读白名单;readOnlyMcpServers 按 server 粒度追加,空名过滤", () => {
    const base = buildHeadlessArgs(task, 80);
    expect(base.join(",")).toContain("WebSearch");
    expect(base.join(",")).toContain("WebFetch");

    const extended = buildHeadlessArgs(task, 80, ["codegraph", "  ", ""]);
    const allowed = extended.join(",");
    expect(allowed).toContain("mcp__codegraph");
    // 空白名不会被拼成 "mcp__" 裸前缀
    expect(allowed).not.toMatch(/(^|,)mcp__(,|$)/);
  });

  it("buildHeadlessPrompt 携带受控联网边界与隐私条款(记忆原文不出域)", () => {
    const prompt = buildHeadlessPrompt(task);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("WebSearch / WebFetch");
    expect(prompt).toContain("never send raw memory content");
    // 协议锚点替换:headless 无 ponder_report 工具,改交最终 JSON
    expect(prompt).toContain("you have no ponder_report tool");
  });

  it("parseHeadlessReport 透传 resourcesUsed.web 申报面", () => {
    const raw = JSON.stringify({
      result: JSON.stringify({
        answer: "测试回答",
        insights: [],
        plan: [],
        trace: [],
        resourcesUsed: {
          engrams: [],
          skills: [],
          logs: [],
          web: [{ query: "agent os benchmark 2026", purpose: "external grounding" }],
        },
      }),
    });
    const report = parseHeadlessReport(raw);
    expect(report.resourcesUsed?.web?.[0]?.query).toBe("agent os benchmark 2026");
    expect(report.resourcesUsed?.web?.[0]?.purpose).toBe("external grounding");
  });
});

describe("headless executor 孤儿防护(超时/失败 kill 子进程)", () => {
  it("超时 → 子进程收到 SIGTERM,execute 以 timeout 错误 reject", async () => {
    const kills: string[] = [];
    const fakeChild = {
      kill: (sig?: string) => {
        kills.push(sig ?? "SIGTERM");
        return true;
      },
      killed: false,
      exitCode: null,
    };
    // 永不 settle 的 spawn + 挂 child 引用(defaultSpawn 同款契约)
    const spawned = new Promise<never>(() => {}) as never as Promise<{
      stdout: string; stderr: string; code: number | null;
    }> & { child: typeof fakeChild };
    spawned.child = fakeChild;
    const executor = createHeadlessExecutor({
      timeoutMs: 20,
      spawnFn: () => spawned,
    });
    await expect(executor.execute(task)).rejects.toThrow(/timeout/);
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("成功路径不 kill;fake spawnFn 无 child 引用不崩(兼容旧注入)", async () => {
    const inner = JSON.stringify({
      answer: "正常回答",
      insights: [],
      plan: [],
      trace: [],
    });
    const executor = createHeadlessExecutor({
      timeoutMs: 5_000,
      spawnFn: async () => ({
        stdout: JSON.stringify({ result: inner }),
        stderr: "",
        code: 0,
      }),
    });
    const report = await executor.execute(task);
    expect(report.answer).toBe("正常回答");
  });

  it("非零退出码 → 同样走 kill(此时已退出,no-op)且错误带退出码", async () => {
    const kills: string[] = [];
    const fakeChild = {
      kill: (sig?: string) => {
        kills.push(sig ?? "SIGTERM");
        return true;
      },
      killed: false,
      exitCode: 143, // 已退出 → kill 应被跳过
    };
    const executor = createHeadlessExecutor({
      spawnFn: async () => {
        const p = Promise.resolve({ stdout: "", stderr: "boom", code: 143 }) as never as Promise<{
          stdout: string; stderr: string; code: number | null;
        }> & { child: typeof fakeChild };
        p.child = fakeChild;
        return p;
      },
    });
    await expect(executor.execute(task)).rejects.toThrow(/exited 143/);
    expect(kills).toEqual([]); // exitCode !== null → 防护跳过
  });
});
