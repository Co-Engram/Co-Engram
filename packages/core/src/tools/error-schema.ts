/**
 * 工具错误契约(hyper-pattern 1 + 3 修复)
 *
 * 所有 co-engram 工具抛出的错误必须使用 EngramToolError,
 * 不允许裸抛 Error / string / object。
 *
 * host adapter(claude-code-mcp / openclaw-plugin)捕获后转为宿主协议错误,
 * 但保留 schema 字段,供 LLM 理解 actionable 反馈。
 *
 * @module @co-engram/core/tools
 */

/**
 * 错误类型枚举。
 *
 * - NOT_FOUND:资源不存在(engram ID / proposal ID / 路径)
 * - LOCK_BUSY:写路径 lock 冲突(可重试)
 * - VALIDATION:输入校验失败(Zod schema)
 * - LLM_UNAVAILABLE:LLM 客户端不可用(synthesize / contradiction_resolve)
 * - CONFIG:配置错误(缺少必要 config 字段)
 * - INTERNAL:内部错误(bug / 状态不一致)
 */
export type EngramToolErrorCode =
  | "NOT_FOUND"
  | "LOCK_BUSY"
  | "VALIDATION"
  | "LLM_UNAVAILABLE"
  | "CONFIG"
  | "INTERNAL";

/**
 * 工具错误 schema(LLM 可读,host adapter 序列化给上层)。
 */
export interface EngramToolErrorSchema {
  readonly code: EngramToolErrorCode;
  /** 用户友好化的自然语言消息 */
  readonly message: string;
  /** 出错的资源 ID(engram / proposal / path) */
  readonly resourceId?: string;
  /** 是否可重试(LOCK_BUSY 默认 true,其他默认 false) */
  readonly retryable?: boolean;
  /** 建议的退避时间(LOCK_BUSY 用,毫秒) */
  readonly retryAfterMs?: number;
  /** actionable 引导("use engram_search to find") */
  readonly suggestion?: string;
  /** 原始错误(开发 debug 用,不暴露给用户) */
  readonly cause?: unknown;
}

/**
 * 工具错误类。
 *
 * 继承 Error 以兼容 try/catch 与 stack trace;
 * 额外携带 schema 字段(code / resourceId / suggestion 等),
 * 让 host adapter 与 LLM 能解析出 actionable 信号。
 */
export class EngramToolError extends Error {
  readonly code: EngramToolErrorCode;
  readonly resourceId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly suggestion?: string;
  override readonly cause?: unknown;

  constructor(schema: EngramToolErrorSchema) {
    super(schema.message);
    this.name = "EngramToolError";
    this.code = schema.code;
    this.resourceId = schema.resourceId;
    this.retryable = schema.retryable ?? defaultRetryable(schema.code);
    this.retryAfterMs = schema.retryAfterMs;
    this.suggestion = schema.suggestion;
    this.cause = schema.cause;
  }

  /** 转 plain object(供 host adapter 序列化给 LLM / MCP error response) */
  toJSON(): EngramToolErrorSchema {
    return {
      code: this.code,
      message: this.message,
      resourceId: this.resourceId,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      suggestion: this.suggestion,
    };
  }
}

/** LOCK_BUSY 默认可重试,其他默认不可重试 */
function defaultRetryable(code: EngramToolErrorCode): boolean {
  return code === "LOCK_BUSY";
}

/** 类型守卫:判断 unknown 是否为 EngramToolError */
export function isEngramToolError(err: unknown): err is EngramToolError {
  return err instanceof EngramToolError;
}

// ============================================================
// 工厂函数(语义化构造,统一消息风格)
// ============================================================

/**
 * NOT_FOUND 错误(默认带 search suggestion)。
 *
 * @param resource 资源类型("Engram" / "Proposal" / "Path")
 * @param resourceId 资源 ID
 * @param suggestion 可选自定义 suggestion;默认引导 engram_search
 */
export function notFoundError(
  resource: string,
  resourceId: string,
  suggestion?: string,
): EngramToolError {
  return new EngramToolError({
    code: "NOT_FOUND",
    message: `${resource} not found: ${resourceId}`,
    resourceId,
    suggestion:
      suggestion ??
      `Use engram_search to find the correct ID, or engram_list to browse recent entries.`,
  });
}

/**
 * VALIDATION 错误(从 Zod issue 或自定义消息构造)。
 *
 * @param message 用户友好消息
 * @param options 可选 `{ suggestion, resourceId }`
 */
export function validationError(
  message: string,
  options?: {
    readonly suggestion?: string;
    readonly resourceId?: string;
  },
): EngramToolError {
  return new EngramToolError({
    code: "VALIDATION",
    message,
    ...(options?.suggestion ? { suggestion: options.suggestion } : {}),
    ...(options?.resourceId ? { resourceId: options.resourceId } : {}),
  });
}

/**
 * LOCK_BUSY 错误(写路径 lock 冲突,默认可重试)。
 *
 * @param resourceId 被锁的资源标识(通常是 dataRoot 或 lock name)
 * @param retryAfterMs 建议的退避时间(默认 1000ms)
 */
export function lockBusyError(
  resourceId: string,
  retryAfterMs = 1000,
): EngramToolError {
  return new EngramToolError({
    code: "LOCK_BUSY",
    message: `Resource is locked by another process: ${resourceId}. Retry after ${retryAfterMs}ms.`,
    resourceId,
    retryable: true,
    retryAfterMs,
    suggestion: `Retry the same call after ${retryAfterMs}ms, or wait for the holding process to release the lock.`,
  });
}

/**
 * LLM_UNAVAILABLE 错误(synthesize / contradiction_resolve 等需要 LLM 的工具)。
 */
export function llmUnavailableError(
  toolName: string,
  hint?: string,
): EngramToolError {
  return new EngramToolError({
    code: "LLM_UNAVAILABLE",
    message: `LLM client is not available for tool ${toolName}.`,
    suggestion:
      hint ??
      `Configure llmClient in ToolContext, or call with dryRun=true to use heuristic fallback.`,
  });
}

/**
 * CONFIG 错误(缺少必要 config 字段)。
 */
export function configError(
  missingField: string,
  hint: string,
): EngramToolError {
  return new EngramToolError({
    code: "CONFIG",
    message: `Missing required config: ${missingField}. ${hint}`,
    resourceId: missingField,
    suggestion: hint,
  });
}

/**
 * INTERNAL 错误(bug / 状态不一致)。
 *
 * 仅供真正的"不应该发生"场景使用,不要用于业务层错误。
 */
export function internalError(
  message: string,
  cause?: unknown,
): EngramToolError {
  return new EngramToolError({
    code: "INTERNAL",
    message,
    cause,
    retryable: false,
  });
}
