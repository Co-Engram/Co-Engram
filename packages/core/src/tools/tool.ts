/**
 * 工具协议
 *
 * 统一的 Tool 接口，所有 Self-Editing Tool 都实现此接口。
 * host adapter（OpenClaw / MCP）只需把 Tool 包装为各自的工具调用格式。
 *
 * @module @co-engram/core/tools
 */

import type { ZodTypeAny } from "zod";

// re-export EngramToolError 契约(hyper-pattern 1 + 3 修复),
// 让工具层调用方从 ./tool.js 一站式 import 工厂函数与错误类。
export {
  EngramToolError,
  isEngramToolError,
  notFoundError,
  validationError,
  lockBusyError,
  llmUnavailableError,
  configError,
  internalError,
} from "./error-schema.js";
export { formatZodError, isZodErrorLike, serializeToolError } from "./zod-formatter.js";
import { formatZodError } from "./zod-formatter.js";

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
  readonly searchOrchestrator?: import("../retrieval/search-engine.js").SearchEngine;
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
   * Skill 仓储（可选，S1 起提供；skill_* 工具用它持久化程序性记忆）。
   * 宿主在 S4 注入；未注入时 skill_create/list/update 抛 CONFIG 错误。
   */
  readonly skillRepository?: import("../skill/skill-repository.js").SkillRepository;
  /**
   * 默认作者标识（可选，用于 engram_create 的 createdBy 回退）。
   *
   * 工具调用方未显式传 createdBy 时,工具会用此值;
   * 若此值也缺省,最终回退到 'unknown'。
   * MCP 适配器从 CO_ENGRAM_DEFAULT_CREATED_BY 环境变量或持久化配置读取;
   * OpenClaw 适配器从 plugin config.defaultCreatedBy 读取。
   */
  readonly defaultCreatedBy?: string;
  /**
   * LLM 客户端（可选，用于 engram_synthesize 等需要语义综合的工具）。
   *
   * host adapter 注入；claude-code-mcp 走 Anthropic API，
   * openclaw-plugin 走 OpenAI-compatible endpoint。
   * 不注入时，engram_synthesize 等工具会拒绝调用并给出明确错误。
   */
  readonly llmClient?: import("../observability/necessity-evaluator.js").LlmClient;
  /**
   * 标记仓库脏（记忆内容发生变化）。
   *
   * 写操作工具在成功执行后调用此回调。
   * 宿主在会话结束后据此判断是否需要 git commit。
   */
  markDirty?: () => void;
  /**
   * 宿主标识(P0-4:双宿主契约不一致修复)。
   *
   * 由 host adapter 在构造 ToolContext 时注入(claude-code-mcp 或 openclaw-plugin)。
   * 工具在 auditLog.append 时透传,让 AuditEntry.host 字段记录来源宿主,
   * 便于跨宿主行为审计与归因。未注入时 audit entry 的 host 字段为 undefined
   * (向后兼容:旧调用路径不强制要求)。
   */
  readonly host?: "claude-code-mcp" | "openclaw-plugin" | string;
}

/**
 * 统一 Tool 接口
 */
export interface Tool<I = unknown, O = unknown> extends ToolMeta {
  /** 执行工具，返回结果或抛错 */
  execute(input: I, ctx: ToolContext): Promise<O> | O;
}

/**
 * 校验并解析输入(host adapter 通常在 execute 前调用)。
 *
 * 校验失败时抛 EngramToolError(code="VALIDATION"),message 经 formatZodError
 * 翻译成自然语言,host adapter 捕获后可序列化 schema 字段给 LLM。
 */
export function validateInput<T>(schema: ZodTypeAny, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw formatZodError(result.error);
  }
  return result.data as T;
}
