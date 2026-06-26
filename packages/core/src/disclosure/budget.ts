/**
 * Context Window 预算管理
 *
 * 用于 adaptiveDisclosure 的预算跟踪：每个 tier 升级都要消耗 token，
 * 一旦超出预算就停留在当前层。
 *
 * P1 简化策略：
 *   - 中文按 1 char ≈ 1 token 估算
 *   - 英文/数字按 ~4 char ≈ 1 token 估算
 *   - 结构化字段（id/title/tags）额外计入 ~10 token 的 wrapper 开销
 *
 * 后续可换成准确的 tokenizer（如 tiktoken / @anthropic-ai/tokenizer）。
 *
 * @module @co-engram/core/disclosure
 */

/** CJK 字符检测（包含常见汉字扩展区） */
const CJK_REGEX = /[㐀-鿿豈-﫿\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]/u;

/**
 * 估算字符串消耗的 token 数（向上取整）
 *
 * - 中文字符：1 char ≈ 1 token
 * - 其他字符（含空格标点）：4 char ≈ 1 token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 创建预算
 *
 * @param totalTokens - 总预算（如 4096 / 32768 / 128000）
 * @param reserved - 已被其他内容占用（系统提示词、历史对话）
 */
export function createBudget(totalTokens: number, reserved = 0): ContextBudget {
  if (totalTokens < 0) {
    throw new Error(`totalTokens must be >= 0, got ${totalTokens}`);
  }
  if (reserved < 0 || reserved > totalTokens) {
    throw new Error(`reserved must be in [0, totalTokens], got ${reserved}`);
  }
  return {
    totalTokens,
    reserved,
    remaining: totalTokens - reserved,
  };
}

/**
 * 消耗一定 token，返回新预算（不修改原对象）
 *
 * remaining 不会变负，最低为 0
 */
export function consume(budget: ContextBudget, tokens: number): ContextBudget {
  if (tokens < 0) {
    throw new Error(`tokens to consume must be >= 0, got ${tokens}`);
  }
  const remaining = Math.max(0, budget.remaining - tokens);
  return { ...budget, remaining };
}

/**
 * 判断预算是否够用
 */
export function hasBudget(budget: ContextBudget, tokens: number): boolean {
  return budget.remaining >= tokens;
}

/**
 * 预算耗尽
 */
export function isExhausted(budget: ContextBudget): boolean {
  return budget.remaining <= 0;
}

/**
 * 预算使用率 [0,1]
 */
export function utilization(budget: ContextBudget): number {
  if (budget.totalTokens <= 0) return 0;
  const used = budget.totalTokens - budget.remaining;
  return used / budget.totalTokens;
}

/** 重新导出类型，避免调用方跨包 import */
export type { ContextBudget } from "../types/disclosure.js";
import type { ContextBudget } from "../types/disclosure.js";
