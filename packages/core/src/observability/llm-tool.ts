/**
 * LLM 工具契约(AI-4 hyper-pattern 4 第一砖)
 *
 * 10 轮挑剔用户 loop 测试发现 6 hyper-pattern,其中 hyper-pattern 4 是
 * "resource coordination missing":多个 LLM 工具各自实现 dryRun / fallback,
 * 没有统一契约,行为漂移(如 engram_synthesize 的 dryRun=true 仍然调 LLM;
 * LlmNecessityEvaluator 的 fallback 散落在 evaluate 方法内)。
 *
 * 本模块抽象出 LlmTool 契约:任何依赖外部 LLM 的工具必须实现这个接口,
 * 让 dryRun / fallback 行为统一可控。
 *
 * 设计原则:
 *   - dryRun=true + 有 heuristic → 强制走 heuristic,绝不调 LLM
 *   - dryRun=true + 无 heuristic → 抛错(让用户显式知道,而非伪装成功)
 *   - LLM 调用失败 + 有 heuristic → 自动 fallback
 *   - LLM 调用失败 + 无 heuristic → 透传错误
 *
 * @module @co-engram/core/observability
 */

import { configError } from "../tools/error-schema.js";

/**
 * LLM 工具执行选项
 */
export interface LlmToolOptions {
  /**
   * 干跑模式:不调 LLM,只走 heuristic(若有);若无 heuristic,抛错
   */
  readonly dryRun?: boolean;
  /**
   * 最大 token数(透传给 LlmClient)
   */
  readonly maxTokens?: number;
  /**
   * 采样温度(透传给 LlmClient)
   */
  readonly temperature?: number;
  /**
   * 超时毫秒(透传给 LlmClient)
   */
  readonly timeoutMs?: number;
}

/**
 * LLM 工具契约
 *
 * 实现者必须:
 *   1. 声明是否有 heuristic 等价物(纯规则版,无外部 LLM 调用)
 *   2. 若有,实现 executeHeuristic(行为与 executeWithLlm 等价,只是质量更糙)
 *   3. 不在 executeWithLlm 内部 catch LLM 错误(由 runLlmTool helper 统一处理)
 *
 * 实现者不应:
 *   - 在 executeWithLlm 里走 fallback(违反"单一职责",helper 已包好)
 *   - 让 executeHeuristic 调任何外部 LLM(违反"dryRun 绝不调 LLM"硬约束)
 *
 * 通用模板参数:
 *   - TInput:工具输入(如 NecessityInput)
 *   - TOutput:工具输出(如 NecessityVerdict)
 */
export interface LlmTool<TInput, TOutput> {
  /** 工具名(用于错误信息 / 审计日志) */
  readonly name: string;

  /**
   * 调 LLM 的执行路径
   *
   * 失败时直接 throw,不做 fallback(由 runLlmTool helper 决定)
   */
  executeWithLlm(input: TInput, opts: LlmToolOptions): Promise<TOutput>;

  /**
   * 是否有 heuristic 等价物(纯规则版,无 LLM 调用)
   *
   * false 时 executeHeuristic 可以抛 "no heuristic" 错误,不会被调用
   */
  hasHeuristicFallback(): boolean;

  /**
   * Heuristic 执行路径(纯规则版)
   *
   * 契约:
   *   - 绝不调外部 LLM
   *   - 行为应与 executeWithLlm 在"成功路径"上语义等价(只是质量更糙)
   *   - 若工具无 heuristic 版,抛 "no heuristic fallback for <name>" 错误
   */
  executeHeuristic(input: TInput, opts: LlmToolOptions): Promise<TOutput>;
}

/**
 * 统一执行入口:按 dryRun / fallback 契约路由
 *
 * 路由表:
 *   - dryRun=true + 有 heuristic → executeHeuristic
 *   - dryRun=true + 无 heuristic → throw(dryRun 要求不调 LLM,但无替代路径)
 *   - dryRun=false/undefined + 有 heuristic → executeWithLlm,失败 fallback 到 heuristic
 *   - dryRun=false/undefined + 无 heuristic → executeWithLlm,失败透传
 *
 * @returns 工具输出 + 元数据(用了哪条路径,便于审计 / 调试)
 */
export async function runLlmTool<TInput, TOutput>(
  tool: LlmTool<TInput, TOutput>,
  input: TInput,
  opts: LlmToolOptions = {},
): Promise<
  TOutput & {
    /** 实际走的路径(供审计日志 / 用户透明) */
    readonly _llmToolPath: "llm" | "heuristic" | "heuristic-after-llm-fail";
    /** LLM 错误信息(仅 heuristic-after-llm-fail 路径填) */
    readonly _llmToolError?: string;
  }
> {
  // 路径 1:dryRun=true → 绝不调 LLM
  if (opts.dryRun === true) {
    if (!tool.hasHeuristicFallback()) {
      throw configError(
        "llmClient",
        `dryRun=true requested but tool "${tool.name}" has no heuristic fallback. ` +
          `Either configure an LLM client and remove dryRun, or implement executeHeuristic.`,
      );
    }
    const result = (await tool.executeHeuristic(input, opts)) as unknown as {
      [k: string]: unknown;
    };
    return {
      ...result,
      _llmToolPath: "heuristic",
    } as TOutput & {
      readonly _llmToolPath: "llm" | "heuristic" | "heuristic-after-llm-fail";
      readonly _llmToolError?: string;
    };
  }

  // 路径 2:正常流程,先 LLM
  try {
    const result = (await tool.executeWithLlm(input, opts)) as unknown as {
      [k: string]: unknown;
    };
    return {
      ...result,
      _llmToolPath: "llm",
    } as TOutput & {
      readonly _llmToolPath: "llm" | "heuristic" | "heuristic-after-llm-fail";
      readonly _llmToolError?: string;
    };
  } catch (err) {
    if (!tool.hasHeuristicFallback()) throw err;
    // 路径 3:LLM 失败 + 有 heuristic → fallback
    const result = (await tool.executeHeuristic(input, opts)) as unknown as {
      [k: string]: unknown;
    };
    return {
      ...result,
      _llmToolPath: "heuristic-after-llm-fail",
      _llmToolError: err instanceof Error ? err.message : String(err),
    } as TOutput & {
      readonly _llmToolPath: "llm" | "heuristic" | "heuristic-after-llm-fail";
      readonly _llmToolError?: string;
    };
  }
}
