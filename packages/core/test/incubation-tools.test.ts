// incubation_* 工具:注册/profile/fail-loud/agent 协议返回/report 回写 +
// T6(conclude/update 工具、create/list 的 schedule/nextRunAt/timeline/finalAnswer 面)+
// T16(pause/delete 工具:暂停排程与条目删除,失败路径转译)
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
  "incubation_pause",
  "incubation_delete",
] as const;

describe("注册与 profile", () => {
  it("7 工具注册进 registry", () => {
    const registry = createToolRegistry();
    for (const n of NAMES) expect(registry.get(n)).toBeDefined();
  });

  it("standard 与 full profile 含 7 工具,minimal 不含", () => {
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

  it("report 回写:rounds+1、单次执行后待裁决(suggested-resolve)、洞察走提案", async () => {
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
    // 无 llmClient → critic fail-closed → proposals=0,但轮次推进、跑完待裁决
    expect(r.rounds).toBe(1);
    expect(r.status).toBe("suggested-resolve");
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

  it("list:timeline 摘要化 —— answerDraft 仅最近 2 轮,轻量字段与 timelineRounds 全保留", () => {
    const timeline: IncubationTimelineEvent[] = [1, 2, 3, 4].map((n) => ({
      at: `2026-08-1${n}T00:05:00.000Z`,
      trigger: "scheduled" as const,
      round: n,
      summaries: [`洞察${n}`],
      proposalEntityIds: [],
      externalCallCount: 0,
      answerDraft: `第${n}轮阶段草稿`,
    }));
    const fake = {
      list: () => [mkEntry({ id: "inc-sum", timeline })],
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const r = registry.get("incubation_list")!.execute({}, { ...ctx, incubator: fake }) as {
      items: ReadonlyArray<{
        id: string;
        timelineRounds: number;
        timeline: ReadonlyArray<Record<string, unknown>>;
      }>;
    };
    const item = r.items.find((i) => i.id === "inc-sum")!;
    expect(item.timelineRounds).toBe(4);
    expect(item.timeline).toHaveLength(4);
    // 前 2 轮:answerDraft 被裁(键不存在),轻量字段保留
    expect("answerDraft" in item.timeline[0]!).toBe(false);
    expect("answerDraft" in item.timeline[1]!).toBe(false);
    expect(item.timeline[0]!.round).toBe(1);
    expect(item.timeline[0]!.summaries).toEqual(["洞察1"]);
    // 最近 2 轮:answerDraft 全文保留
    expect(item.timeline[2]!.answerDraft).toBe("第3轮阶段草稿");
    expect(item.timeline[3]!.answerDraft).toBe("第4轮阶段草稿");
  });

  // ============================================================
  // 失败路径:域层裸 Error 经工具层转译为带 code 的 EngramToolError
  // (防三类可预期失败被宿主当 INTERNAL 上报)
  // ============================================================

  /** 捕获同步/异步抛错为值,便于断言错误字段 */
  async function captureErr(fn: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("conclude:id 不存在 → 转译为 NOT_FOUND(保留 id 提示)", async () => {
    const fake = {
      conclude: async () => {
        throw new Error("incubation inc-none not found");
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_conclude")!.execute({ id: "inc-none" }, { ...ctx, incubator: fake }),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; resourceId?: string };
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("inc-none");
    expect(e.resourceId).toBe("inc-none");
  });

  it("conclude:in-flight 拒绝 → 转译为可重试 LOCK_BUSY,message 带 TTL 提示", async () => {
    const fake = {
      conclude: async () => {
        throw new Error("incubation inc-busy in-flight — conclude after the round finishes");
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_conclude")!.execute({ id: "inc-busy" }, { ...ctx, incubator: fake }),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; retryable: boolean; message: string };
    expect(e.code).toBe("LOCK_BUSY");
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("TTL 30min");
  });

  it("conclude:llmClient 未注入 → 转译为 CONFIG,message 明示收束不可用", async () => {
    const fake = {
      conclude: async () => {
        throw new Error("conclude unavailable: no llmClient injected");
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_conclude")!.execute({ id: "inc-x" }, { ...ctx, incubator: fake }),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string };
    expect(e.code).toBe("CONFIG");
    expect(e.message).toContain("llmClient 未注入");
  });

  it("update:id 不存在 → 转译为 NOT_FOUND(保留 id 提示)", async () => {
    const fake = {
      updateSchedule: () => {
        throw new Error("incubation inc-none not found");
      },
    } as unknown as Incubator;
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_update")!.execute(
        { id: "inc-none", schedule: "07:00" },
        { ...ctx, incubator: fake },
      ),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; resourceId?: string };
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("inc-none");
    expect(e.resourceId).toBe("inc-none");
  });
});

// ============================================================
// T16:incubation_pause / incubation_delete
// (用真 Incubator 直跑:覆盖域层真实文案(not found / in-flight)
//  与落盘效果;失败路径断言转译后的 code/resourceId/retryable)
// ============================================================

describe("T16:pause / delete 工具", () => {
  /** 捕获同步/异步抛错为值(T6 同款,便于断言错误字段) */
  async function captureErr(fn: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("pause:创建条目 → pause → 返回 status=paused、nextRunAt=null;域层条目置 paused", () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 暂停这个问题" },
      ctx,
    ) as { id: string };
    const r = registry.get("incubation_pause")!.execute({ id: created.id }, ctx) as {
      id: string;
      status: string;
      nextRunAt: string | null;
    };
    expect(r.id).toBe(created.id);
    expect(r.status).toBe("paused");
    // paused 不再排程:computeNextRunAt 只认 active
    expect(r.nextRunAt).toBeNull();
    expect(incubator.get(created.id)!.status).toBe("paused");
  });

  it("pause:id 不存在 → 转译为 NOT_FOUND(保留 id 提示)", async () => {
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_pause")!.execute({ id: "inc-none" }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; resourceId?: string };
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("inc-none");
    expect(e.resourceId).toBe("inc-none");
  });

  it("delete:创建条目 → delete → 返回 { id };条目从 list 消失", () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 删除这个问题" },
      ctx,
    ) as { id: string };
    const r = registry.get("incubation_delete")!.execute({ id: created.id }, ctx) as {
      id: string;
    };
    expect(r).toEqual({ id: created.id });
    expect(incubator.get(created.id)).toBeUndefined();
    expect(incubator.list()).toHaveLength(0);
  });

  it("delete:id 不存在 → 转译为 NOT_FOUND(保留 id 提示)", async () => {
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_delete")!.execute({ id: "inc-none" }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; resourceId?: string };
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("inc-none");
    expect(e.resourceId).toBe("inc-none");
  });

  it("delete:in-flight 条目 → 转译为 LOCK_BUSY 且 retryable(域层文案含 in-flight)", async () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 删除进行中的条目" },
      ctx,
    ) as { id: string };
    expect(incubator.acquireInFlight(created.id, "test")).toBe(true);
    const err = await captureErr(() =>
      registry.get("incubation_delete")!.execute({ id: created.id }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; retryable: boolean; message: string };
    expect(e.code).toBe("LOCK_BUSY");
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("TTL 30min");
    // in-flight 拒删:条目本体保留
    expect(incubator.get(created.id)).toBeDefined();
  });
});

// ============================================================
// T16 补充:incubation_run 状态门禁与 pause 的 in-flight 语义
// (评审修复:paused/resolved 的 run 报错指向真因而非误导性的
//   「已在执行中」;not-found 经转译层补齐 NOT_FOUND 契约;
//   轮中 pause 合法,轮结束 releaseInFlight 不复活自动排程)
// ============================================================

describe("T16:incubation_run 状态门禁与 pause 的 in-flight 语义", () => {
  /** 捕获同步/异步抛错为值(T6/T16 同款,便于断言错误字段) */
  async function captureErr(fn: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("run(agent):paused 条目 → VALIDATION,message 含「已暂停」,suggestion 指引 resolve 恢复", async () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 paused 条目不可立即 run" },
      ctx,
    ) as { id: string };
    incubator.pause(created.id);
    const err = await captureErr(() =>
      registry.get("incubation_run")!.execute({ id: created.id }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as {
      code: string;
      message: string;
      resourceId?: string;
      suggestion?: string;
    };
    expect(e.code).toBe("VALIDATION");
    // 真因是 paused 生命周期,而非误导性的 in-flight 文案
    expect(e.message).toContain("已暂停");
    expect(e.message).not.toContain("in-flight");
    expect(e.suggestion).toContain("incubation_resolve");
    expect(e.resourceId).toBe(created.id);
  });

  it("run(agent):resolved 条目 → VALIDATION,message 含「已归档」", async () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 resolved 条目不可再跑" },
      ctx,
    ) as { id: string };
    incubator.resolve(created.id, true);
    const err = await captureErr(() =>
      registry.get("incubation_run")!.execute({ id: created.id }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; suggestion?: string };
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("已归档");
    expect(e.message).not.toContain("in-flight");
    expect(e.suggestion).toContain("重新播种");
  });

  it("run(agent):id 不存在 → 转译为 NOT_FOUND(错误契约对齐其余 incubation 工具)", async () => {
    const registry = createToolRegistry();
    const err = await captureErr(() =>
      registry.get("incubation_run")!.execute({ id: "inc-none" }, ctx),
    );
    expect(isEngramToolError(err)).toBe(true);
    const e = err as { code: string; message: string; resourceId?: string };
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("inc-none");
    expect(e.resourceId).toBe("inc-none");
  });

  it("pause:in-flight 轮中暂停合法;轮结束 releaseInFlight 不复活自动排程", () => {
    const registry = createToolRegistry();
    const created = registry.get("incubation_create")!.execute(
      { question: "T16 轮中暂停守护" },
      ctx,
    ) as { id: string };
    // 拿锁 → 条目置 in-flight(模拟一轮夜思进行中)
    expect(incubator.acquireInFlight(created.id, "test")).toBe(true);
    // 轮中暂停合法:pause 不查 in-flight(进行中的夜思轮不受影响)
    const r = registry.get("incubation_pause")!.execute({ id: created.id }, ctx) as {
      status: string;
    };
    expect(r.status).toBe("paused");
    // 模拟轮次结束回收:releaseInFlight 只翻 in-flight 态,不覆盖用户 paused 裁决
    incubator.releaseInFlight(created.id);
    expect(incubator.get(created.id)!.status).toBe("paused");
  });
});
