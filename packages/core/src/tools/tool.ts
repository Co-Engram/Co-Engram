/**
 * 工具协议
 *
 * 统一的 Tool 接口，所有 Self-Editing Tool 都实现此接口。
 * host adapter（OpenClaw / MCP）只需把 Tool 包装为各自的工具调用格式。
 *
 * @module @co-engram/core/tools
 */

import type { ZodTypeAny } from "zod";

/**
 * 工具元信息（可暴露给 host 用于注册）
 */
export interface ToolMeta {
  /** 工具名（snake_case，宿主中立） */
  readonly name: string;
  /** 工具描述（host 可展示给 LLM） */
  readonly description: string;
  /** 输入 schema（JSON Schema 友好，host 可直接转 MCP inputSchema） */
  readonly inputSchema: ZodTypeAny;
}

/**
 * 工具执行上下文
 *
 * 包含 repository / index / graph 等运行时依赖，
 * 由 host 在调用时注入（依赖注入，避免工具直接 new）。
 */
export interface ToolContext {
  readonly repository: import("../storage/repository.js").EngramRepository;
  readonly indexOrchestrator?: import("../index/orchestrator.js").IndexOrchestrator;
  readonly searchOrchestrator?: import("../retrieval/orchestrator.js").SearchOrchestrator;
  readonly graphTraverser?: import("../graph/traverse.js").GraphTraverser;
  /**
   * 当前会话 id（用于 behavioral signals 追踪）。
   *
   * 宿主每次工具调用注入新 UUID；维护引擎用 sliding window 替代会话边界。
   */
  readonly sessionId?: string;
  /**
   * 信号收集器（行为追踪）。
   *
   * 如果注入，tools/wrapped.ts 包装的工具会自动 append ToolCallEvent；
   * 否则工具正常运行（不影响功能）。
   */
  readonly signalSink?: import("../signals/types.js").SignalSink;
  /**
   * 审计日志（可选，状态变更 + 有效性信号）。
   *
   * 如果注入，工具会在 create/update/reinforce/report_failure 等关键路径
   * 自动 append 审计事件；否则不记录。
   */
  readonly auditLog?: import("../observability/audit-log.js").AuditLog;
  /**
   * 有效性追踪器（可选）。
   *
   * engram_search 命中时 openWindow；engram_reinforce 时 closeAsEffective；
   * engram_report_failure 时 closeAsFailure。
   */
  readonly effectivenessTracker?: import("../observability/effectiveness-tracker.js").EffectivenessTracker;
  /**
   * 候选提案引擎（可选，用于 engram_list_proposals 等工具）。
   */
  readonly proposalEngine?: import("../observability/proposal-engine.js").ProposalEngine;
  /**
   * 默认作者标识（可选，用于 engram_create 的 createdBy 回退）。
   *
   * 工具调用方未显式传 createdBy 时,工具会用此值;
   * 若此值也缺省,最终回退到 'unknown'。
   * MCP 适配器从 CO_ENGRAM_DEFAULT_CREATED_BY 环境变量或持久化配置读取;
   * OpenClaw 适配器从 plugin config.defaultCreatedBy 读取。
   */
  readonly defaultCreatedBy?: string;
}

/**
 * 统一 Tool 接口
 */
export interface Tool<I = unknown, O = unknown> extends ToolMeta {
  /** 执行工具，返回结果或抛错 */
  execute(input: I, ctx: ToolContext): Promise<O> | O;
}

/**
 * 校验并解析输入（host adapter 通常在 execute 前调用）
 */
export function validateInput<T>(schema: ZodTypeAny, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid input: ${issues}`);
  }
  return result.data as T;
}
