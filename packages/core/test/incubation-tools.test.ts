// incubation_* 工具:注册/profile/fail-loud/agent 协议返回/report 回写 +
// T6(conclude/update 工具、create/list 的 schedule/nextRunAt/timeline/finalAnswer 面)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator, computeNextRunAt } from "../src/maintenance/insight/incubator.js";
import type {
  IncubationEntry,
  IncubationTimelineEvent,
} from "../src/maintenance/insight/incubator.js";
import { IncubationUpdateInputSchema } from "../src/tools/schemas.js";
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

// ============================================================
// T6:incubation_conclude / incubation_update + schedule 面
// (conclude 依赖 llmClient,真实 Incubator 无法直跑 → 最小 fake;
//  其余用例同样以 fake 隔离工具层透传语义,不重复测域层)
// ============================================================

/** 最小完整 entry 桩(满足 IncubationEntry 形状;override 覆盖关键字段) */
function mkEntry(overrides: Partial<IncubationEntry> = {}): IncubationEntry {
  return {
    id: "inc-t6",
    question: "T6 问题",
    seedEngramIds: [],
    status: "active",
    rounds: 2,
    webResearchOptIn: false,
    schedule: "00:00",
    createdAt: "2026-08-16T00:00:00.000Z",
    lastHatchedAt: null,
    timeline: [],
    ...overrides,
  };
}

describe("T6:conclude / update 工具与 schedule 面", () => {
  it("incubation_conclude / incubation_update 注册进 registry 且 standard/full 可见、minimal 不可见", () => {
    const registry = createToolRegistry();
    for (const n of ["incubation_conclude", "incubation_update"] as const) {
      expect(registry.get(n)).toBeDefined();
      expect(PROFILE_TOOL_SETS.standard.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.full.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.minimal.has(n)).toBe(false);
    }
  });

  it("conclude:走 incubator.conclude,返回 id/status/finalAnswer/concludedAt", async () => {
    const concluded = mkEntry({
      id: "inc-done",
      status: "suggested-resolve",
      finalAnswer: "综合全部梦境的最终回答",
      concludedAt: "2026-08-16T01:23:45.000Z",
    });
    const calls: string[] = [];
    const fake = {
      conclude: async (id: string) => {
        calls.push(id);
        return concluded;
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const r = (await registry.get("incubation_conclude")!.execute(
      { id: "inc-done" },
      { ...ctx, incubator: fake },
    )) as {
      id: string;
      status: string;
      finalAnswer: string;
      concludedAt: string;
    };
    expect(calls).toEqual(["inc-done"]);
    expect(r).toEqual({
      id: "inc-done",
      status: "suggested-resolve",
      finalAnswer: "综合全部梦境的最终回答",
      concludedAt: "2026-08-16T01:23:45.000Z",
    });
  });

  it("update:走 incubator.updateSchedule,返回 id/schedule/nextRunAt", () => {
    const updated = mkEntry({ id: "inc-upd", schedule: "07:00" });
    const calls: Array<[string, string]> = [];
    const fake = {
      updateSchedule: (id: string, schedule: string) => {
        calls.push([id, schedule]);
        return updated;
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const r = registry.get("incubation_update")!.execute(
      { id: "inc-upd", schedule: "07:00" },
      { ...ctx, incubator: fake },
    ) as { id: string; schedule: string; nextRunAt: string | null };
    expect(calls).toEqual([["inc-upd", "07:00"]]);
    expect(r.id).toBe("inc-upd");
    expect(r.schedule).toBe("07:00");
    expect(r.nextRunAt).toBe(computeNextRunAt(updated));
  });

  it("schema:update 非法 schedule(99:00 / 24:00)safeParse 失败,合法 07:00 通过", () => {
    expect(
      IncubationUpdateInputSchema.safeParse({ id: "inc-x", schedule: "99:00" }).success,
    ).toBe(false);
    expect(
      IncubationUpdateInputSchema.safeParse({ id: "inc-x", schedule: "24:00" }).success,
    ).toBe(false);
    expect(
      IncubationUpdateInputSchema.safeParse({ id: "inc-x", schedule: "07:00" }).success,
    ).toBe(true);
  });

  it("create:入参透传 schedule(fake 捕获断言),返回 schedule 与 nextRunAt", () => {
    const created = mkEntry({ id: "inc-new", schedule: "07:00" });
    const createCalls: unknown[] = [];
    const fake = {
      create: (input: unknown) => {
        createCalls.push(input);
        return created;
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const r = registry.get("incubation_create")!.execute(
      { question: "排程透传问题文本", schedule: "07:00" },
      { ...ctx, incubator: fake },
    ) as { schedule: string; nextRunAt: string | null };
    // T1 质量评审追加:schema 宣告的 schedule 字段必须透传给 incubator.create,不许静默丢弃
    expect(createCalls).toEqual([
      { question: "排程透传问题文本", webResearchOptIn: false, schedule: "07:00" },
    ]);
    expect(r.schedule).toBe("07:00");
    expect(r.nextRunAt).toBe(computeNextRunAt(created));
  });

  it("list:条目含 schedule / nextRunAt / timeline(含 diagnosis)/ finalAnswer?", () => {
    const timeline: IncubationTimelineEvent[] = [
      {
        at: "2026-08-15T00:05:00.000Z",
        trigger: "scheduled",
        round: 1,
        summaries: ["洞察甲"],
        proposalEntityIds: [],
        externalCallCount: 0,
        diagnosis: {
          drafts: 1,
          dupVetoed: 0,
          validateRejected: 0,
          criticRejected: 1,
          llmClientMissing: true,
        },
        answerDraft: "阶段性回答草稿",
      },
    ];
    const entries = [
      mkEntry({ id: "inc-a", schedule: "07:00", timeline }),
      mkEntry({ id: "inc-b", status: "suggested-resolve", finalAnswer: "已收束" }),
    ];
    const fake = { list: () => entries } as unknown as Incubator;
    const registry = createToolRegistry();
    const r = registry.get("incubation_list")!.execute({}, { ...ctx, incubator: fake }) as {
      items: ReadonlyArray<{
        id: string;
        schedule: string;
        nextRunAt: string | null;
        timeline: readonly IncubationTimelineEvent[];
        finalAnswer?: string;
      }>;
      total: number;
    };
    expect(r.total).toBe(2);
    const a = r.items.find((i) => i.id === "inc-a")!;
    const b = r.items.find((i) => i.id === "inc-b")!;
    expect(a.schedule).toBe("07:00");
    expect(a.nextRunAt).toBe(computeNextRunAt(entries[0]!));
    expect(a.timeline).toEqual(timeline);
    expect("finalAnswer" in a).toBe(false);
    expect(b.schedule).toBe("00:00"); // 缺省回落
    expect(b.nextRunAt).toBe(computeNextRunAt(entries[1]!));
    expect(b.finalAnswer).toBe("已收束");
  });
});
