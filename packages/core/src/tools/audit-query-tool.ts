/**
 * engram_audit_query 工具(Task 3.3 + Task 3.4 cursor 分页)
 *
 * 把 AuditLog 数据层暴露给 agent / 用户层。R14 实证 audit.jsonl 存了大量事件,
 * 但 query 方法只被 effectiveness-tracker 和 viewer/server 内部调用,
 * 挑剔用户想看"这个 engram 的修改历史"必须开 viewer 或读文件。
 *
 * 这是 K(observability 数据层存在但工具层不可达)的核心投影 —— Task 3.3 修复。
 * Task 3.4 把 result shape 改成 `{ items, nextCursor }` cursor 分页,
 * 与 engram_list / engram_list_proposals 形态一致。
 *
 * cursor 实现:cursor 编码上一页 oldest entry 的 ts(ISO 时间戳)。
 * 下一页把它作为 `until`(exclusive)传入 AuditLog.query,得到更早的事件。
 * 这是稳定的,因为 audit.jsonl 是 append-only,新写入的 ts ≥ 当前最新 ts,
 * 不会插入到已分页的范围之间。
 *
 * 边界:同一毫秒内多条 entry(ms 精度碰撞)会被 cursor 一起 skip。
 * 生产环境 audit 写入频率远低于 1/ms,碰撞罕见;测试场景可通过确保
 * ts 单调递增(不同 ms)来规避。
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import type { Tool, ToolContext } from "./tool.js";
import { validateInput, configError } from "./tool.js";
import { notFoundError } from "./error-schema.js";
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
  // maintenance
  "maintenance_run",
  // skill 记忆系统
  "skill_create",
  "skill_update",
  "skill_delete",
  "skill_invoke",
  "skill_compose_add",
  "skill_compose_remove",
  "skill_related_engram_add",
  "skill_related_engram_remove",
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
    /**
     * 截止时间(不包含)。
     *
     * 内部用作 cursor 分页边界(下一页传入上一页 oldest.ts 作为 until)。
     * 调用方也可以显式传 until 来约束上界,与 cursor 互斥(cursor 优先)。
     */
    until: z
      .string()
      .optional()
      .describe("ISO8601 截止时间(不包含)。与 cursor 互斥;cursor 优先。"),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .describe("返回上限(必填,1-1000)。与 cursor 配合做翻页。"),
    cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        "分页 cursor(上一页返回的 nextCursor)。编码为上一页 oldest entry 的 ts;下一页返回更早的事件。",
      ),
  })
  .strict();

export type EngramAuditQueryInput = z.infer<typeof EngramAuditQueryInputSchema>;

export interface EngramAuditQueryResult {
  /** 匹配的审计事件(时间正序) */
  readonly items: readonly AuditEntry[];
  /**
   * 下一页 cursor(oldest entry 的 ts);null 表示无更多数据。
   *
   * 稳定性:audit.jsonl append-only + ts 单调递增 → 已分页范围不会被新写入侵入。
   */
  readonly nextCursor: string | null;
}

/**
 * engram_audit_query 工具
 *
 * 暴露 audit.jsonl 给 agent / 用户层。支持按 engramId / action / 时间范围 /
 * limit + cursor 过滤。返回 AuditEntry 数组(时间正序)+ 下一页 cursor。
 *
 * 设计:
 *   - 复用 AuditLog.query,不重写读取逻辑(单一真相源)
 *   - cursor 复用 `until` 边界机制(翻译层在工具内完成)
 *   - 拒绝无 auditLog 的 ctx(明确报错,不静默返回空)
 *   - limit+1 探测 hasMore,避免依赖 AuditLog 内部默认上限
 */
export const engramAuditQueryTool: Tool<
  EngramAuditQueryInput,
  EngramAuditQueryResult
> = {
  name: "engram_audit_query",
  description: `查询 audit 审计日志(audit.jsonl)。概念:{{concept:engram|userExplanation}}。

WHEN TO CALL:
- 用户问"这个 engram 的修改历史"(谁创建、谁 reinforce、是否被 contradicted)
- 调试某条记忆为何 importance 异常(看 reinforce / report_failure 事件序列)
- 复盘 proposal 处理(propose → accept/dismiss 链路)
- 排查 merge 冲突解决(merge_resolved / merge_conflict_escalated)

何时不调用:
- 想看 engram 当前状态(用 engram_get)
- 想看有效性统计(用 viewer web UI,effectivenessTracker 在那里有图表)

RETURNS: { items: AuditEvent[], nextCursor: string | null }。items 按时间正序;
每条含 ts / actor / action / engramId / metadata。limit 必填(1-1000);
翻页把 nextCursor 原样回传到下一页的 cursor 参数。`,
  inputSchema: EngramAuditQueryInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramAuditQueryInput>(
      EngramAuditQueryInputSchema,
      input,
    );
    if (!ctx.auditLog) {
      throw configError(
        "ctx.auditLog",
        "engram_audit_query requires an auditLog — host adapter must inject `auditLog` into ToolContext.",
      );
    }
    // AI-2 修复:不存在的 engramId 显式抛 NOT_FOUND,而不是静默返回空数组。
    // 旧实现:engramId 笔误 / 已 deleted / 已 sweep_to_trash 的 id 都让
    // audit.query 走默认过滤,返回 items=[],agent 把"空"当作"无修改历史"。
    // 修复后:对存在性明确发声,让调用方知道 id 本身就不对,引导修正。
    if (parsed.engramId && !ctx.repository.exists(parsed.engramId)) {
      throw notFoundError(
        "Engram",
        parsed.engramId,
        "engram_audit_query: this engramId does not exist in the repository. " +
          "Use engram_list or engram_search to find valid IDs, or omit engramId " +
          "to query across all engrams.",
      );
    }
    // cursor 优先于 until:cursor 编码了上一页 oldest entry 的 ts,
    // 作为下一页的 exclusive until 边界,得到 strictly older 的事件。
    const until = parsed.cursor ?? parsed.until;
    // 多取一条用于判断 hasMore,不依赖 AuditLog 内部 limit 兜底
    const fetchLimit = parsed.limit + 1;
    const events = ctx.auditLog.query({
      engramId: parsed.engramId,
      action: parsed.action,
      since: parsed.since,
      until,
      limit: fetchLimit,
    });
    if (events.length <= parsed.limit) {
      return { items: events, nextCursor: null };
    }
    // 多取到了一条 → 还有更老的事件。AuditLog.query 返回的是「最新 fetchLimit
    // 条按时间升序」,要保留最新 limit 条,必须切尾部。nextCursor = 本页最老
    // 的 entry(数组首位),下一页把它作为 exclusive until 边界。
    const items = events.slice(events.length - parsed.limit);
    const oldest = items[0]!;
    return { items, nextCursor: oldest.ts };
  },
};
