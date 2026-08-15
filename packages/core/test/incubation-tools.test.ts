// incubation_* 工具:注册/profile/fail-loud/agent 协议返回/report 回写
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { PROFILE_TOOL_SETS } from "../src/tools/tool-profile.js";
import { isEngramToolError } from "../src/tools/error-schema.js";
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
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-incub-tools-"));
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
  "incubation_create",
  "incubation_run",
  "incubation_list",
  "incubation_resolve",
  "incubation_report",
] as const;

describe("注册与 profile", () => {
  it("5 工具注册进 registry", () => {
    const registry = createToolRegistry();
    for (const n of NAMES) expect(registry.get(n)).toBeDefined();
  });

  it("standard 与 full profile 含 5 工具,minimal 不含", () => {
    for (const n of NAMES) {
      expect(PROFILE_TOOL_SETS.standard.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.full.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.minimal.has(n)).toBe(false);
    }
  });

  it("i18n zh/en 两语言 agent 描述非空", () => {
    for (const n of NAMES) {
      expect(zh[`tool.${n}.agent` as keyof typeof zh]).toBeTruthy();
      expect(en[`tool.${n}.agent` as keyof typeof en]).toBeTruthy();
    }
    expect(
      localizeToolDescription("incubation_create", "zh", "fallback", "agent"),
    ).toContain("夜思");
  });
});

describe("执行语义", () => {
  it("ctx 无 incubator → configError(fail-loud)", () => {
    const registry = createToolRegistry();
    const bare: ToolContext = { repository: repo };
    for (const n of ["incubation_create", "incubation_list", "incubation_resolve"] as const) {
      try {
        registry.get(n)!.execute(
          n === "incubation_create"
            ? { question: "问题文本长度" }
            : n === "incubation_resolve"
              ? { id: "inc-x", answered: true }
              : {},
          bare,
        );
        expect.unreachable("should throw");
      } catch (e) {
        expect(isEngramToolError(e)).toBe(true);
      }
    }
  });

  it("run(agent 模式):acquire in-flight → 返回协议任务包(含问题/梦境史/protocol);重复 run 报错", async () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "夜思问题 Q" },
      ctx,
    ) as { id: string };
    const r = (await registry.get("incubation_run")!.execute(
      { id: created.id },
      ctx,
    )) as { mode: string; task: { question: string; protocol: string } };
    expect(r.mode).toBe("agent");
    expect(r.task.question).toBe("夜思问题 Q");
    expect(r.task.protocol).toContain("incubation_report");
    // 已 in-flight → 二次 run 报错
    await expect(
      registry.get("incubation_run")!.execute({ id: created.id }, ctx),
    ).rejects.toThrow();
  });

  it("report 回写:rounds+1、状态恢复 active、洞察走提案", async () => {
    const registry = createToolRegistry();
    const a = repo.createEngram({
      title: "A", content: "内容甲", kind: "fact",
      domainTags: ["域甲"], createdBy: "t",
    });
    const b = repo.createEngram({
      title: "B", content: "内容乙", kind: "fact",
      domainTags: ["域乙"], createdBy: "t",
    });
    const created = registry.get("incubation_create")!.execute(
      { question: "夜思测试问题", seedEngramIds: [a.id, b.id] },
      ctx,
    ) as { id: string };
    await registry.get("incubation_run")!.execute({ id: created.id }, ctx);
    const r = (await registry.get("incubation_report")!.execute(
      {
        incubationId: created.id,
        report: {
          insights: [
            {
              type: "theme",
              title: "夜思主题一",
              content: "结构说明文字",
              summary: "夜思主题一",
              sourceIds: [a.id, b.id],
              domainTags: ["夜思"],
              reason: "跨域共性",
            },
          ],
          plan: [{ step: "盘点", capability: "skills" }],
          trace: [],
          externalCalls: [],
        },
      },
      ctx,
    )) as { rounds: number; status: string; proposals: number };
    // 无 llmClient → critic fail-closed → proposals=0,但轮次推进、状态恢复
    expect(r.rounds).toBe(1);
    expect(r.status).toBe("active");
    expect(r.proposals).toBe(0);
  });

  it("list/resolve 正常工作", () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "问题文本再长一点" },
      ctx,
    ) as { id: string };
    const list = registry.get("incubation_list")!.execute({}, ctx) as {
      total: number;
    };
    expect(list.total).toBe(1);
    const resolved = registry.get("incubation_resolve")!.execute(
      { id: created.id, answered: true },
      ctx,
    ) as { status: string };
    expect(resolved.status).toBe("resolved");
  });
});
