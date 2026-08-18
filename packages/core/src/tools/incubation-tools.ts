/**
 * 沉思(Contemplation)工具面 —— ponder_*(2026-08-17 重设计)。
 *
 * 5 工具:create / run / list / report / delete。原 incubation_* 的
 * resolve / conclude / update / pause 随多轮梦境状态机一并移除(沉思 =
 * 提问即深思的一次性任务,三态 queued→thinking→done,无排程无仪式)。
 *
 * ponder_report 是 L2 agent 的**唯一写回路径**(经 incubator.report:机械
 * 校验 + 独立 critic → rem-insight 提案);ponder_run 的 agent 模式返回固化
 * 协议的结构化指令(盘点→plan→执行→answer→report),不依赖 agent 自觉。
 *
 * 文案红线:工具描述不出现宿主名(不绑定 Claude Code / OpenClaw)。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import {
  IncubationCreateInputSchema,
  IncubationDeleteInputSchema,
  IncubationListInputSchema,
  IncubationReportInputSchema,
  IncubationRunInputSchema,
} from "./schemas.js";
import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import {
  configError,
  EngramToolError,
  isEngramToolError,
  notFoundError,
} from "./error-schema.js";
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
      "Incubator is not injected into ToolContext — host adapter must wire it during bootstrap (contemplation unavailable in this deployment).",
    );
  }
  return ctx.incubator;
}

/**
 * list 工具的 timeline 摘要:轻量字段全保留,answer 仅最近 2 次全文
 * (agent 上下文预算;viewer 走域层取全文,不受此限)。
 */
function summarizeTimeline(
  tl: readonly IncubationTimelineEvent[],
): readonly IncubationTimelineEvent[] {
  const keepAnswerFrom = Math.max(0, tl.length - 2);
  return tl.map((t, i) => {
    const { answer, ...rest } = t;
    return i >= keepAnswerFrom ? t : rest;
  });
}

/**
 * 域层错误转译:incubator 域层抛裸 Error(不依赖工具契约),四类可预期
 * 失败按文案转成 EngramToolError,让 agent 拿到可读的 code/message 而非
 * 一律 INTERNAL;其余错误原样上抛(不吞未知失败)。
 */
function translateContemplationError(err: unknown, id: string): unknown {
  if (!(err instanceof Error) || isEngramToolError(err)) return err;
  const msg = err.message;
  if (/not found/.test(msg)) {
    return notFoundError(
      "Contemplation",
      id,
      "Use ponder_list to find the correct contemplation id.",
    );
  }
  if (/thinking|already/.test(msg)) {
    // LOCK_BUSY 是契约里唯一 retryable 语义的 code;thinking 锁随本次深思
    // 结束或 TTL 回收释放。
    return new EngramToolError({
      code: "LOCK_BUSY",
      message: `沉思 ${id} 正在深思中,结束后或 TTL 30min 回收后可重试`,
      resourceId: id,
      retryable: true,
      retryAfterMs: 30 * 60 * 1000,
      suggestion: "等本次深思结束(thinking TTL 30 分钟自动回收)后重试同一调用。",
    });
  }
  if (/limit reached/.test(msg)) {
    return new EngramToolError({
      code: "VALIDATION",
      message: msg,
      resourceId: id,
      suggestion: "用 ponder_delete 删除最老的已答条目后再提问。",
    });
  }
  if (/llmClient/.test(msg)) {
    return configError("llmClient", "llmClient 未注入,沉思执行不可用");
  }
  return err;
}

// ============================================================
// ponder_create
// ============================================================

export const incubationCreateTool: Tool<
  z.infer<typeof IncubationCreateInputSchema>,
  {
    id: string;
    status: string;
    question: string;
  }
> = {
  name: "ponder_create",
  description:
    "提出一个沉思问题:围绕它做一次全资源盘点式深度思考——调用全部记忆图谱、行为日志与技能库,纯本地只读执行,深思一次出一份报告(回答 + 洞察提案)。问题为自由文本(可比记忆更丰富);可选 seedEngramIds 指定重点记忆(留空自动全库检索)。创建后条目为 queued,配合 ponder_run 执行(对话场景当前会话现场执行;界面/异步场景走 auto)。条目上限 50。",
  inputSchema: IncubationCreateInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationCreateInputSchema>>(IncubationCreateInputSchema, input);
    try {
      const incubator = requireIncubator(ctx);
      const entry = incubator.create({
        question: parsed.question,
        ...(parsed.seedEngramIds ? { seedEngramIds: parsed.seedEngramIds } : {}),
      });
      return {
        id: entry.id,
        status: entry.status,
        question: entry.question,
      };
    } catch (err) {
      throw translateContemplationError(err, "");
    }
  },
};

// ============================================================
// ponder_run
// ============================================================

export const incubationRunTool: Tool<
  z.infer<typeof IncubationRunInputSchema>,
  | {
      readonly mode: "agent";
      readonly incubationId: string;
      readonly status: "thinking";
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
  name: "ponder_run",
  description:
    "执行一次深思。mode=agent(默认,对话入口):标记 thinking 并返回固化协议任务包 —— 你(当前会话 agent)按协议执行「能力盘点→全资源开采(记忆图谱/行为日志/技能库)→PLAN→只读执行→写回答→调 ponder_report 回写」,协议已固化在返回指令中,不依赖自觉。mode=auto(界面/CLI 异步任务):直接跑 headless 执行器(失败显式报错),同步返回结果。queued 与 done 条目均可执行(done = 再思一次,回灌全部过往深思史防重复);条目 thinking 中报错(TTL 30min 过期自动回收)。",
  inputSchema: IncubationRunInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationRunInputSchema>>(IncubationRunInputSchema, input);
    try {
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
      // agent 模式:直接抢 thinking 锁 —— 状态不可运行的报错由域层语义给出
      //(thinking 中 = LOCK_BUSY;不存在 = NOT_FOUND)。
      const actor = ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "agent-session";
      if (!incubator.acquireThinking(parsed.id, `agent:${actor}`)) {
        throw configError(
          "ponderRun",
          `沉思 ${parsed.id} 正在深思中 —— 30 分钟未回写自动回收。`,
        );
      }
      const task = await incubator.buildTask(parsed.id);
      return { mode: "agent", incubationId: parsed.id, status: "thinking", task };
    } catch (err) {
      throw translateContemplationError(err, parsed.id);
    }
  },
};

// ============================================================
// ponder_list
// ============================================================

export const incubationListTool: Tool<
  z.infer<typeof IncubationListInputSchema>,
  {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly question: string;
      readonly status: string;
      readonly rounds: number;
      readonly lastRunAt: string | null;
      /** 最新一次深思的回答 */
      readonly answer?: string;
      /** 深思时间线摘要(轻量字段全保留,answer 仅最近 2 次全文) */
      readonly timeline: readonly IncubationTimelineEvent[];
    }>;
    readonly total: number;
    readonly limit: { readonly total: number; readonly max: number; readonly warnAt: number };
  }
> = {
  name: "ponder_list",
  description:
    "列出沉思条目。返回 id/问题/状态(queued|thinking|done)/深思次数/最近深思时间/最新回答(answer)/深思时间线摘要(timeline,轻量字段全保留,answer 仅最近 2 次全文)/条目上限信息(limit:total/max/warnAt)。done 条目可经 ponder_run 再思;thinking 中不可删除。",
  inputSchema: IncubationListInputSchema,
  execute(input, ctx) {
    validateInput<z.infer<typeof IncubationListInputSchema>>(IncubationListInputSchema, input);
    const incubator = requireIncubator(ctx);
    const entries = incubator.list();
    return {
      items: entries.map((e) => ({
        id: e.id,
        question: e.question,
        status: e.status,
        rounds: e.rounds,
        lastRunAt: e.lastRunAt,
        ...(e.answer ? { answer: e.answer } : {}),
        timeline: summarizeTimeline(e.timeline),
      })),
      total: entries.length,
      limit: incubator.limitInfo(),
    };
  },
};

// ============================================================
// ponder_report —— L2 唯一写回路径
// ============================================================

export const incubationReportTool: Tool<
  z.infer<typeof IncubationReportInputSchema>,
  {
    readonly incubationId: string;
    readonly proposals: number;
    readonly cycleVetoed: boolean;
    readonly rounds: number;
    readonly status: string;
    readonly hasAnswer: boolean;
    readonly note?: string;
    /** PDCA:repairing 时非空 —— 修复目标(资源类型+描述+成因),修复后全量重报 */
    readonly openGaps?: ReadonlyArray<{
      readonly resourceType: string;
      readonly description: string;
      readonly necessity: string;
      readonly reason?: string;
    }>;
    /** PDCA:本次是否 degraded 终束(预算触顶;提案隔离,审批面置顶未闭合清单) */
    readonly degraded?: boolean;
    /** PDCA:本次 report 的修复轮序(主报告 = 0) */
    readonly repairRound?: number;
    readonly nextAction?: string;
  }
> = {
  name: "ponder_report",
  description:
    "沉思回写(L2 agent 的唯一写回路径):把一次深思的结构化产出写回——回答 answer(执行现场生产,主体交付物)/洞察 insights/计划 plan/轨迹 trace/资源使用申报 resourcesUsed/需求清单 requirements(逐条声明资源需求与闭合状态)。闭合校验引擎事实化:closed 的 engrams/skills 条目用本次 run 的调用流水复核(evidence.ids 必须真实调用过),瞒报或零盘点整单拒绝。有未闭合缺口时返回 openGaps 并保持 repairing —— 修复开采后全量重报;重报同一缺口两次会强制升级为逻辑必需,预算耗尽则以 degraded 终束(洞察提案隔离)。每条洞察即时走机械校验 + 独立 critic → rem-insight 提案;重复洞察(与深思史 Jaccard ≥ 0.65)本次作废。",
  inputSchema: IncubationReportInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationReportInputSchema>>(IncubationReportInputSchema, input);
    const actor = ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "agent-session";
    const r = await requireIncubator(ctx).report({
      incubationId: parsed.incubationId,
      // 沉思产出统一归灵感模式(mode 由系统填充,agent 不自报)
      report: {
        ...parsed.report,
        insights: parsed.report.insights.map((d) => ({
          ...d,
          mode: "inspiration" as const,
        })),
      } as NightThinkingReport,
      trigger: "manual",
      actor,
      level: "L2",
    });
    const last = r.entry.timeline.at(-1);
    return {
      incubationId: parsed.incubationId,
      proposals: r.proposals,
      cycleVetoed: r.cycleVetoed,
      rounds: r.entry.rounds,
      status: r.entry.status,
      hasAnswer: !!r.entry.answer,
      ...(last?.note ? { note: last.note } : {}),
      ...(r.openGaps.length
        ? {
            openGaps: r.openGaps.map((g) => ({
              resourceType: g.resourceType,
              description: g.description,
              necessity: g.necessity,
              ...(g.reason ? { reason: g.reason } : {}),
            })),
          }
        : {}),
      ...(r.repairRound > 0 || r.degraded ? { repairRound: r.repairRound } : {}),
      ...(r.degraded ? { degraded: true } : {}),
      ...(r.entry.status === "repairing"
        ? {
            nextAction:
              "run NOT finalized: mine the resources behind each open gap, then call ponder_report AGAIN with a FULL updated report (requirements list re-declared in full; closed items keep their evidence ids)",
          }
        : r.degraded
          ? { nextAction: "run finalized as degraded (repair budget exhausted) — insight proposals are quarantined from the default approval queue" }
          : undefined),
    };
  },
};

// ============================================================
// ponder_delete —— 删除条目(生命周期终点)
// ============================================================

export const incubationDeleteTool: Tool<
  z.infer<typeof IncubationDeleteInputSchema>,
  { id: string }
> = {
  name: "ponder_delete",
  description:
    "删除沉思条目本体(生命周期终点;仅非 thinking 态可删)。已产出的 rem-insight 提案与审计记录保留 —— 提案走各自 accept/dismiss 裁决流,不受删除影响;深思历史(timeline)随条目一并移除,不可恢复。",
  inputSchema: IncubationDeleteInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<z.infer<typeof IncubationDeleteInputSchema>>(IncubationDeleteInputSchema, input);
    try {
      requireIncubator(ctx).delete(parsed.id);
      return { id: parsed.id };
    } catch (err) {
      throw translateContemplationError(err, parsed.id);
    }
  },
};

export const ALL_PONDER_TOOLS: readonly Tool[] = [
  incubationCreateTool,
  incubationRunTool,
  incubationListTool,
  incubationReportTool,
  incubationDeleteTool,
];
