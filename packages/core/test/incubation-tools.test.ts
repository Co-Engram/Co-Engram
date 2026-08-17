// ponder_* 工具(2026-08-17 重设计):注册/profile/fail-loud/agent 协议返回/
// report 回写/list 面/delete 转译
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { PROFILE_TOOL_SETS } from "../src/tools/tool-profile.js";
import { localizeToolDescription } from "../src/i18n/index.js";
import { en } from "../src/i18n/en.js";
import { zh } from "../src/i18n/zh.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let incubator: Incubator;
let ctx: ToolContext;

const stubEmbedder = async () => [1, 0, 0];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-ponder-tools-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo,
    embedder: stubEmbedder,
    auditLog: { append: () => {} } as never,
    dataRoot: tmpDir,
  });
  incubator = new Incubator({
    repository: repo,
    proposalEngine: engine,
    dataRoot: tmpDir,
  });
  ctx = { repository: repo, host: "claude-code-mcp", incubator };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const NAMES = [
  "ponder_create",
  "ponder_run",
  "ponder_list",
  "ponder_report",
  "ponder_delete",
] as const;

/** registry 包装层的 async 工具错误断言(不依赖 rejects 语义细节) */
async function assertRejects(fn: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  let err: unknown;
  try { await fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  if (pattern) expect((err as Error).message).toMatch(pattern);
}

describe("注册与 profile", () => {
  it("5 工具注册进 registry", () => {
    const registry = createToolRegistry();
    for (const n of NAMES) expect(registry.get(n)).toBeDefined();
    // 旧 incubation_* 工具不复存在(破坏性变更,随 2026-08-17 重设计移除)
    for (const n of ["incubation_create", "incubation_resolve", "incubation_conclude", "incubation_update", "incubation_pause"] as const) {
      expect(registry.get(n)).toBeUndefined();
    }
  });

  it("standard 与 full profile 含 5 工具,minimal 不含", () => {
    for (const n of NAMES) {
      expect(PROFILE_TOOL_SETS.standard.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.full.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.minimal.has(n)).toBe(false);
    }
  });

  it("i18n zh/en 两语言 agent 描述非空且宿主中立(不出现宿主名)", () => {
    for (const n of NAMES) {
      const z = zh[`tool.${n}.agent` as keyof typeof zh] as unknown as string;
      const e = en[`tool.${n}.agent` as keyof typeof en] as unknown as string;
      expect(z).toBeTruthy();
      expect(e).toBeTruthy();
      expect(z).not.toContain("Claude Code");
      expect(z).not.toContain("OpenClaw");
      expect(e).not.toContain("Claude Code");
      expect(e).not.toContain("OpenClaw");
    }
    expect(localizeToolDescription("ponder_create", "zh", "fallback", "agent")).toContain("沉思");
  });
});

describe("执行语义", () => {
  it("ctx 无 incubator → configError(fail-loud)", async () => {
    const registry = createToolRegistry();
    const bare: ToolContext = { repository: repo };
    // create/report 是同步 execute(同步 throw);run/delete 是 async(reject)
    expect(() => registry.get("ponder_create")!.execute({ question: "有效问题?" }, bare)).toThrow(/incubator/);
    await assertRejects(() => registry.get("ponder_run")!.execute({ id: "inc-x" }, bare), /incubator/);
    expect(() => registry.get("ponder_list")!.execute({}, bare)).toThrow(/incubator/);
    await assertRejects(() => registry.get("ponder_delete")!.execute({ id: "inc-x" }, bare), /incubator/);
  });

  it("ponder_create → queued;重复/空参数 VALIDATION", async () => {
    const registry = createToolRegistry();
    const r = (await registry.get("ponder_create")!.execute({ question: "沉思的问题?" }, ctx)) as {
      status: string;
    };
    expect(r.status).toBe("queued");
    // 旧参数(webResearchOptIn/schedule)已随联网/排程移除:strict schema 拒绝
    expect(() =>
      registry.get("ponder_create")!.execute({ question: "问题?", webResearchOptIn: true } as never, ctx),
    ).toThrow(/webResearchOptIn/);
  });

  it("ponder_run agent 模式:返回固化协议任务包(CONTEMPLATION PROTOCOL + ponder_report 回写指令)", async () => {
    const registry = createToolRegistry();
    const created = (await registry.get("ponder_create")!.execute({ question: "协议验证问题?" }, ctx)) as { id: string };
    const r = (await registry.get("ponder_run")!.execute({ id: created.id }, ctx)) as {
      mode: string;
      status: string;
      task: { protocol: string; question: string; resourceHints: readonly string[] };
    };
    expect(r.mode).toBe("agent");
    expect(r.status).toBe("thinking");
    expect(r.task.protocol).toContain("CONTEMPLATION PROTOCOL");
    expect(r.task.protocol).toContain("ponder_report");
    expect(r.task.protocol).toContain("LOCAL ONLY");
    // 联网线已移除:协议不含 WebSearch 字样
    expect(r.task.protocol).not.toContain("WebSearch");
    // 条目 thinking 中再 run → LOCK_BUSY
    await expect(registry.get("ponder_run")!.execute({ id: created.id }, ctx)).rejects.toThrow(/深思/);
  });

  it("ponder_report:洞察归 inspiration + 回写 done + answer 面", async () => {
    const registry = createToolRegistry();
    const a = repo.createEngram({
      title: "来源甲", content: "内容甲", kind: "fact", domainTags: ["域甲"], createdBy: "t",
    });
    const b = repo.createEngram({
      title: "来源乙", content: "内容乙", kind: "fact", domainTags: ["域乙"], createdBy: "t",
    });
    const created = (await registry.get("ponder_create")!.execute(
      { question: "回写验证问题?", seedEngramIds: [a.id, b.id] }, ctx)) as { id: string };
    await registry.get("ponder_run")!.execute({ id: created.id }, ctx);
    const r = (await registry.get("ponder_report")!.execute({
      incubationId: created.id,
      report: {
        answer: "执行现场生产的回答",
        insights: [{
          type: "theme", title: "跨域洞察", content: "内容", summary: "跨域洞察",
          sourceIds: [a.id, b.id], domainTags: ["测试"], reason: "cross",
        }],
        plan: [{ step: "plan1", capability: "engram_search" }],
        trace: [{ step: "s1", action: "engram_search", detail: "hit" }],
        resourcesUsed: { engrams: [a.id], skills: [], logs: [] },
      },
    }, ctx)) as { status: string; hasAnswer: boolean; rounds: number };
    expect(r.status).toBe("done");
    expect(r.hasAnswer).toBe(true);
    expect(r.rounds).toBe(1);
    const listed = (await registry.get("ponder_list")!.execute({}, ctx)) as {
      items: Array<{ id: string; status: string; answer?: string }>;
      limit: { max: number };
    };
    const item = listed.items.find((x) => x.id === created.id)!;
    expect(item.status).toBe("done");
    expect(item.answer).toBe("执行现场生产的回答");
    expect(listed.limit.max).toBe(50);
  });

  it("ponder_delete:thinking 中删除 → 可读错误;正常删除后 list 不含", async () => {
    const registry = createToolRegistry();
    const created = (await registry.get("ponder_create")!.execute({ question: "删除验证?" }, ctx)) as { id: string };
    await registry.get("ponder_run")!.execute({ id: created.id }, ctx); // thinking
    await assertRejects(() => registry.get("ponder_delete")!.execute({ id: created.id }, ctx), /深思/);
  });
});
