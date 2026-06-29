/**
 * engram_audit_query 工具(Task 3.3)
 *
 * 把 AuditLog 数据层暴露给 agent / 用户层。R14 实证 audit.jsonl 存了大量事件,
 * 但 query 方法只被 effectiveness-tracker 和 viewer/server 内部调用,
 * 挑剔用户想看"这个 engram 的修改历史"必须开 viewer 或读文件。
 *
 * 这是 K(observability 数据层存在但工具层不可达)的核心投影 —— Task 3.3 修复。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import type {
  AuditAction,
  AuditEntry,
} from "../observability/audit-log.js";

/**
 * Audit action 枚举(与 AuditLog 的 AuditAction 保持同步)
 *
 * 工具入参用 z.enum 限定,避免用户输入无效 action 时 audit.query 静默返回空。
 */
const AUDIT_ACTIONS = [
  // 状态变更
  "create",
  "update",
  "update_lifecycle",
  "reinforce",
  "report_failure",
  "forget",
  "restore",
  "sweep_to_trash",
  "restore_from_trash",
  "purge",
  "propose",
  "accept",
  "dismiss",
  // 有效性信号
  "retrieve_hit",
  "retrieve_effective",
  "retrieve_inconclusive",
  "contradicted",
  // proposal 过滤
  "noise_filtered",
  "necessity_rejected",
  // git merge driver
  "merge_resolved",
  "merge_backup_failed",
  "merge_conflict_escalated",
  "merge_llm_arbitrated",
  "merge_llm_arbitrated_escalated",
  "merge_llm_arbitrated_failed",
] as const satisfies readonly AuditAction[];

export const EngramAuditQueryInputSchema = z
  .object({
    engramId: z
      .string()
      .optional()
      .describe("按 engram id 过滤(返回这个 engram 的全部修改历史)"),
    action: z
      .enum(AUDIT_ACTIONS)
      .optional()
      .describe("按审计动作过滤(create/update/reinforce/contradicted/...)"),
    since: z
      .string()
      .optional()
      .describe("ISO8601 起始时间(包含),如 2024-01-01T00:00:00.000Z"),
    until: z
      .string()
      .optional()
      .describe("ISO8601 截止时间(不包含)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("返回上限(默认 100,最大 1000)"),
  })
  .strict();

export type EngramAuditQueryInput = z.infer<typeof EngramAuditQueryInputSchema>;

export interface EngramAuditQueryResult {
  /** 匹配的审计事件(时间正序) */
  readonly events: readonly AuditEntry[];
  /** 返回事件数(等于 events.length,显式列便于消费方不依赖 .length) */
  readonly count: number;
}

/**
 * engram_audit_query 工具
 *
 * 暴露 audit.jsonl 给 agent / 用户层。支持按 engramId / action / 时间范围 /
 * limit 过滤。返回 AuditEntry 数组(时间正序)。
 *
 * 设计:
 *   - 复用 AuditLog.query,不重写读取逻辑(单一真相源)
 *   - 默认 limit=100(AuditLog 内部默认 1000,工具层更保守避免淹没 agent)
 *   - 拒绝无 auditLog 的 ctx(明确报错,不静默返回空)
 */
export const engramAuditQueryTool: Tool<
  EngramAuditQueryInput,
  EngramAuditQueryResult
> = {
  name: "engram_audit_query",
  description: `查询 audit 审计日志(团队记忆的事件历史,audit.jsonl)。概念:{{concept:engram|userExplanation}}。

WHEN TO CALL:
- 用户问"这个 engram 的修改历史"(谁创建、谁 reinforce、是否被 contradicted)
- 调试某条记忆为何 importance 异常(看 reinforce / report_failure 事件序列)
- 复盘 proposal 处理(propose → accept/dismiss 链路)
- 排查 merge 冲突解决(merge_resolved / merge_conflict_escalated)

何时不调用:
- 想看 engram 当前状态(用 engram_get)
- 想看有效性统计(用 viewer web UI,effectivenessTracker 在那里有图表)

RETURNS: { events: AuditEvent[], count: number }。events 按时间正序;
每条含 ts / actor / action / engramId / metadata。`,
  inputSchema: EngramAuditQueryInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramAuditQueryInput>(
      EngramAuditQueryInputSchema,
      input,
    );
    if (!ctx.auditLog) {
      throw new Error(
        "engram_audit_query requires an auditLog — inject `auditLog` into ToolContext",
      );
    }
    const events = ctx.auditLog.query({
      engramId: parsed.engramId,
      action: parsed.action,
      since: parsed.since,
      until: parsed.until,
      limit: parsed.limit ?? 100,
    });
    return {
      events,
      count: events.length,
    };
  },
};
