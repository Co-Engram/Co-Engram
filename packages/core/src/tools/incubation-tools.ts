/**
 * 夜思(Overnight Thinking)工具面 —— incubation_*(spec §四/§七)。
 *
 * 7 工具:create / run / list / resolve / report / conclude / update。
 * incubation_report 是 L2 agent 的**唯一写回路径**(经 incubator.report:
 * 机械校验 + 独立 critic → rem-insight 提案);incubation_run 的 agent 模式
 * 返回固化协议的结构化指令(盘点→plan→执行→按格式 report),不依赖 agent
 * 自觉。incubation_conclude 收束出 finalAnswer(仍由用户经 resolve 裁决);
 * incubation_update 改写每日排程时刻。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import {
  IncubationConcludeInputSchema,
  IncubationCreateInputSchema,
  IncubationListInputSchema,
  IncubationReportInputSchema,
  IncubationResolveInputSchema,
  IncubationRunInputSchema,
  IncubationUpdateInputSchema,
} from "./schemas.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import {
  configError,
  EngramToolError,
  isEngramToolError,
  notFoundError,
} from "./error-schema.js";
import { computeNextRunAt } from "../maintenance/insight/incubator.js";
import type {
  Incubator,
  IncubationTimelineEvent,
} from "../maintenance/insight/incubator.js";
import type { NightThinkingReport } from "../maintenance/insight/types.js";

/** ToolContext.incubator 的窄化 getter(未注入时 fail-loud) */
function requireIncubator(ctx: ToolContext): Incubator {
  if (!ctx.incubator) {
    throw configError(
      "ctx.incubator",
      "Incubator is not injected into ToolContext — host adapter must wire it during bootstrap (night-thinking unavailable in this deployment).",
    );
  }
  return ctx.incubator;
}

/**
 * list 工具的 timeline 摘要:轻量字段全保留,answerDraft 仅最近 2 轮全文
 * (agent 上下文预算;viewer 走域层取全文,不受此限)。
 */
function summarizeTimeline(
  tl: readonly IncubationTimelineEvent[],
): readonly IncubationTimelineEvent[] {
  const keepDraftFrom = Math.max(0, tl.length - 2);
  return tl.map((t, i) => {
    const { answerDraft, ...rest } = t;
    return i >= keepDraftFrom ? t : rest;
  });
}

/**
 * conclude/update 的域层错误转译:incubator 域层抛裸 Error(不依赖工具契约),
 * 三类可预期失败按文案转成 EngramToolError,让 agent 拿到可读的 code/message
 * 而非一律 INTERNAL;其余错误原样上抛(不吞未知失败)。
 */
function translateIncubationError(err: unknown, id: string): unknown {
  if (!(err instanceof Error) || isEngramToolError(err)) return err;
  const msg = err.message;
  if (/not found/.test(msg)) {
    return notFoundError(
      "Incubation",
      id,
      "Use incubation_list to find the correct incubation id.",
    );
  }
  if (/in-flight/.test(msg)) {
    // LOCK_BUSY 是契约里唯一 retryable 语义的 code;in-flight 锁随轮次结束或 TTL 回收释放。
    return new EngramToolError({
      code: "LOCK_BUSY",
      message: `incubation ${id} 本轮夜思进行中,结束后或 TTL 30min 回收后可重试`,
      resourceId: id,
      retryable: true,
      retryAfterMs: 30 * 60 * 1000,
      suggestion: "等本轮夜思结束(in-flight TTL 30 分钟自动回收)后重试同一调用。",
    });
  }
  if (/llmClient/.test(msg)) {
    return configError("llmClient", "llmClient 未注入,收束不可用");
  }
  return err;
}

// ============================================================
// incubation_create
// ============================================================

export const incubationCreateTool: Tool<
  z.infer<typeof IncubationCreateInputSchema>,
  {
    id: string;
    status: string;
    question: string;
    rounds: number;
    schedule: string;
    nextRunAt: string | null;
  }
> = {
  name: "incubation_create",
  description:
    "创建一个夜思(overnight thinking)孵化条目:睡前喂一个问题,夜里 Agent 替你深想,醒来收洞察。问题为自由文本(可比记忆更丰富);可选 seedEngramIds 指定种子记忆。webResearchOptIn 默认 false —— 联网调研需按条目显式开启,开启后问题摘要会发送至搜索引擎(创建前应向用户确认)。每日排程时刻 schedule 为 HH:mm(本地时间,默认 00:00),返回含下一轮预计时间 nextRunAt;suggested-resolve 态条目不自动跑轮(待用户裁决),nextRunAt 为提示性预计。",
  inputSchema: IncubationCreateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationCreateInputSchema>>(IncubationCreateInputSchema, input);
    const incubator = requireIncubator(ctx);
    const entry = incubator.create({
      question: parsed.question,
      ...(parsed.seedEngramIds ? { seedEngramIds: parsed.seedEngramIds } : {}),
      webResearchOptIn: parsed.webResearchOptIn ?? false,
      ...(parsed.schedule ? { schedule: parsed.schedule } : {}),
    });
    return {
      id: entry.id,
      status: entry.status,
      question: entry.question,
      rounds: entry.rounds,
      schedule: entry.schedule ?? "00:00",
      nextRunAt: computeNextRunAt(entry),
    };
  },
};

// ============================================================
// incubation_run
// ============================================================

export const incubationRunTool: Tool<
  z.infer<typeof IncubationRunInputSchema>,
  | {
      readonly mode: "agent";
      readonly incubationId: string;
      readonly status: "in-flight";
      readonly task: import("../maintenance/insight/types.js").NightThinkingTask;
    }
  | {
      readonly mode: "auto";
      readonly incubationId: string;
      readonly status: "done";
      readonly level: "L1" | "L2";
      readonly proposals: number;
      readonly cycleVetoed: boolean;
      readonly rounds: number;
    }
> = {
  name: "incubation_run",
  description:
    "立即执行一轮夜思。mode=agent(默认,对话入口):标记 in-flight 并返回固化协议任务包 —— 你(当前会话 agent)按协议执行「能力盘点→PLAN→只读执行→调 incubation_report 回写」,协议已固化在返回指令中,不依赖自觉。mode=auto(viewer/CLI 异步任务与日调度):直接跑 L2 headless 执行器,不可用自动降级 L1 单次远距类比,同步返回结果。条目已 in-flight 时报错(TTL 30min 过期自动回收)。",
  inputSchema: IncubationRunInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationRunInputSchema>>(IncubationRunInputSchema, input);
    const incubator = requireIncubator(ctx);
    if ((parsed.mode ?? "agent") === "auto") {
      const r = await incubator.incubateOnce(parsed.id, "manual");
      return {
        mode: "auto",
        incubationId: parsed.id,
        status: "done",
        level: r.level,
        proposals: r.proposals,
        cycleVetoed: r.cycleVetoed,
        rounds: r.entry.rounds,
      };
    }
    const actor = ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "agent-session";
    if (!incubator.acquireInFlight(parsed.id, `agent:${actor}`)) {
      throw configError(
        "incubationRun",
        `incubation ${parsed.id} 已在执行中(in-flight)—— 30 分钟未回写自动回收。`,
      );
    }
    const task = incubator.buildTask(parsed.id);
    return { mode: "agent", incubationId: parsed.id, status: "in-flight", task };
  },
};

// ============================================================
// incubation_list
// ============================================================

export const incubationListTool: Tool<
  z.infer<typeof IncubationListInputSchema>,
  {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly question: string;
      readonly status: string;
      readonly rounds: number;
      readonly webResearchOptIn: boolean;
      readonly schedule: string;
      readonly lastHatchedAt: string | null;
      readonly nextRunAt: string | null;
      readonly timelineRounds: number;
      /**
       * 梦境时间线摘要:轻量字段(含空转诊断 diagnosis)全保留,
       * answerDraft 仅最近 2 轮全文(agent 上下文预算;viewer 走域层取全文)
       */
      readonly timeline: readonly IncubationTimelineEvent[];
      /** 收束产物(incubation_conclude);未收束条目无此字段 */
      readonly finalAnswer?: string;
    }>;
    readonly total: number;
  }
> = {
  name: "incubation_list",
  description:
    "列出夜思孵化条目(含 resolved/paused 荣誉记录)。返回 id/问题/状态(active|in-flight|suggested-resolve|resolved|paused)/轮数/联网 opt-in/排程时刻与下一轮预计时间(schedule/nextRunAt)/最近孵化时间/梦境时间线摘要(timeline,轻量字段全保留,answerDraft 仅最近 2 轮)/收束后的最终回答(finalAnswer,未收束无此字段)。suggested-resolve 态条目不自动跑轮(待用户裁决),nextRunAt 为提示性预计。",
  inputSchema: IncubationListInputSchema,
  execute(input, ctx) {
    validateInput<z.infer<typeof IncubationListInputSchema>>(IncubationListInputSchema, input);
    const entries = requireIncubator(ctx).list();
    return {
      items: entries.map((e) => ({
        id: e.id,
        question: e.question,
        status: e.status,
        rounds: e.rounds,
        webResearchOptIn: e.webResearchOptIn,
        schedule: e.schedule ?? "00:00",
        lastHatchedAt: e.lastHatchedAt,
        nextRunAt: computeNextRunAt(e),
        timelineRounds: e.timeline.length,
        timeline: summarizeTimeline(e.timeline),
        ...(e.finalAnswer ? { finalAnswer: e.finalAnswer } : {}),
      })),
      total: entries.length,
    };
  },
};

// ============================================================
// incubation_resolve
// ============================================================

export const incubationResolveTool: Tool<
  z.infer<typeof IncubationResolveInputSchema>,
  { id: string; status: string }
> = {
  name: "incubation_resolve",
  description:
    "夜思 resolve 仪式:accept 洞察后条目进入 suggested-resolve;问用户「是否回答了你的问题」—— 是则 resolved(梦境时间线归档保留),否则继续 active 孵化。",
  inputSchema: IncubationResolveInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationResolveInputSchema>>(IncubationResolveInputSchema, input);
    const updated = requireIncubator(ctx).resolve(parsed.id, parsed.answered);
    return { id: updated.id, status: updated.status };
  },
};

// ============================================================
// incubation_report —— L2 唯一写回路径
// ============================================================

export const incubationReportTool: Tool<
  z.infer<typeof IncubationReportInputSchema>,
  {
    readonly incubationId: string;
    readonly proposals: number;
    readonly cycleVetoed: boolean;
    readonly rounds: number;
    readonly status: string;
    readonly note?: string;
  }
> = {
  name: "incubation_report",
  description:
    "夜思回写(L2 agent 的唯一写回路径):把一轮夜思的结构化产出(洞察 insights/计划 plan/轨迹 trace/外部调用 externalCalls)写回。每条洞察即时走机械校验 + 独立 critic → rem-insight 提案(不直接创建记忆,用户 accept 才落盘);轮次+1、写入时间线;重复洞察(与梦境史 Jaccard ≥ 0.65)本轮作废,连续 2 轮全撞自动 paused。",
  inputSchema: IncubationReportInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationReportInputSchema>>(IncubationReportInputSchema, input);
    const actor = ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "agent-session";
    const r = await requireIncubator(ctx).report({
      incubationId: parsed.incubationId,
      // 夜思产出统一归灵感模式(mode 由系统填充,agent 不自报)
      report: {
        ...parsed.report,
        insights: parsed.report.insights.map((d) => ({
          ...d,
          mode: "inspiration" as const,
        })),
      } as NightThinkingReport,
      trigger: "manual",
      actor,
    });
    const last = r.entry.timeline.at(-1);
    return {
      incubationId: parsed.incubationId,
      proposals: r.proposals,
      cycleVetoed: r.cycleVetoed,
      rounds: r.entry.rounds,
      status: r.entry.status,
      ...(last?.note ? { note: last.note } : {}),
    };
  },
};

// ============================================================
// incubation_conclude —— 收束(综合全部梦境时间线出最终回答)
// ============================================================

export const incubationConcludeTool: Tool<
  z.infer<typeof IncubationConcludeInputSchema>,
  { id: string; status: string; finalAnswer: string; concludedAt: string }
> = {
  name: "incubation_conclude",
  description:
    "收束夜思条目:综合全部梦境时间线生成最终回答(finalAnswer)并置 suggested-resolve。幂等可重复(重生成并覆盖);已 resolved/paused 的条目收束会保留原状态,仅重生成 finalAnswer。llmClient 未注入时报错。收束不自动 accept 任何提案;是否已回答仍由用户经 incubation_resolve 裁决。",
  inputSchema: IncubationConcludeInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationConcludeInputSchema>>(IncubationConcludeInputSchema, input);
    try {
      const e = await requireIncubator(ctx).conclude(parsed.id);
      return { id: e.id, status: e.status, finalAnswer: e.finalAnswer ?? "", concludedAt: e.concludedAt ?? "" };
    } catch (err) {
      throw translateIncubationError(err, parsed.id);
    }
  },
};

// ============================================================
// incubation_update —— 改写每日排程时刻
// ============================================================

export const incubationUpdateTool: Tool<
  z.infer<typeof IncubationUpdateInputSchema>,
  { id: string; schedule: string; nextRunAt: string | null }
> = {
  name: "incubation_update",
  description:
    "改写夜思条目的每日排程时刻(HH:mm 本地时间,默认 00:00)。仅非 in-flight 态可改。",
  inputSchema: IncubationUpdateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationUpdateInputSchema>>(IncubationUpdateInputSchema, input);
    try {
      const e = requireIncubator(ctx).updateSchedule(parsed.id, parsed.schedule);
      return { id: e.id, schedule: e.schedule ?? "00:00", nextRunAt: computeNextRunAt(e) };
    } catch (err) {
      throw translateIncubationError(err, parsed.id);
    }
  },
};

export const ALL_INCUBATION_TOOLS: readonly Tool[] = [
  incubationCreateTool,
  incubationRunTool,
  incubationListTool,
  incubationResolveTool,
  incubationReportTool,
  incubationConcludeTool,
  incubationUpdateTool,
];
