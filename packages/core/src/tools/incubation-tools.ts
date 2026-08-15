/**
 * 夜思(Overnight Thinking)工具面 —— incubation_*(spec §四/§七)。
 *
 * 5 工具:create / run / list / resolve / report。incubation_report 是 L2
 * agent 的**唯一写回路径**(经 incubator.report:机械校验 + 独立 critic →
 * rem-insight 提案);incubation_run 的 agent 模式返回固化协议的结构化
 * 指令(盘点→plan→执行→按格式 report),不依赖 agent 自觉。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import {
  IncubationCreateInputSchema,
  IncubationListInputSchema,
  IncubationReportInputSchema,
  IncubationResolveInputSchema,
  IncubationRunInputSchema,
} from "./schemas.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import { configError } from "./error-schema.js";
import type { Incubator } from "../maintenance/insight/incubator.js";
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

// ============================================================
// incubation_create
// ============================================================

export const incubationCreateTool: Tool<
  z.infer<typeof IncubationCreateInputSchema>,
  { id: string; status: string; question: string; rounds: number }
> = {
  name: "incubation_create",
  description:
    "创建一个夜思(overnight thinking)孵化条目:睡前喂一个问题,夜里 Agent 替你深想,醒来收洞察。问题为自由文本(可比记忆更丰富);可选 seedEngramIds 指定种子记忆。webResearchOptIn 默认 false —— 联网调研需按条目显式开启,开启后问题摘要会发送至搜索引擎(创建前应向用户确认)。",
  inputSchema: IncubationCreateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationCreateInputSchema>>(IncubationCreateInputSchema, input);
    const incubator = requireIncubator(ctx);
    const entry = incubator.create({
      question: parsed.question,
      ...(parsed.seedEngramIds ? { seedEngramIds: parsed.seedEngramIds } : {}),
      webResearchOptIn: parsed.webResearchOptIn ?? false,
    });
    return {
      id: entry.id,
      status: entry.status,
      question: entry.question,
      rounds: entry.rounds,
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
      readonly lastHatchedAt: string | null;
      readonly timelineRounds: number;
    }>;
    readonly total: number;
  }
> = {
  name: "incubation_list",
  description:
    "列出夜思孵化条目(含 resolved/paused 荣誉记录)。返回 id/问题/状态(active|in-flight|suggested-resolve|resolved|paused)/轮数/联网 opt-in/最近孵化时间。",
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
        lastHatchedAt: e.lastHatchedAt,
        timelineRounds: e.timeline.length,
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

export const ALL_INCUBATION_TOOLS: readonly Tool[] = [
  incubationCreateTool,
  incubationRunTool,
  incubationListTool,
  incubationResolveTool,
  incubationReportTool,
];
