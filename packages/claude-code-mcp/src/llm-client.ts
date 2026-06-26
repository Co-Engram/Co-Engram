/**
 * Anthropic LlmClient 适配器
 *
 * 把 co-engram core 的 LlmClient 抽象映射到 Anthropic Messages API。
 * Claude Code 环境天然有 ANTHROPIC_API_KEY,优先复用,无需用户额外配置。
 *
 * 设计与 openclaw-plugin/src/llm-client.ts 平行:
 *   - host 各自实现 provider 适配器,core 不绑定 provider
 *   - 失败时抛错,由 LlmNecessityEvaluator 决定是否 fallback 到规则版
 *
 * @module @co-engram/claude-code
 */

import {
  LlmNecessityEvaluator,
  type LlmClient,
  type NecessityEvaluator,
} from "@co-engram/core";

/**
 * Anthropic LLM 配置
 *
 * Claude Code 环境通常已通过 env 提供,无需用户手动配置。
 */
export interface AnthropicLlmConfig {
  /** API key(默认读 env ANTHROPIC_API_KEY) */
  readonly apiKey: string;
  /** 模型名(默认 'claude-haiku-4-5-20251001',便宜快) */
  readonly model: string;
  /** 可选自定义 endpoint(默认 https://api.anthropic.com) */
  readonly endpoint?: string;
  /** 可选额外 headers */
  readonly headers?: Record<string, string>;
}

const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 从 Claude Code 环境解析 Anthropic LLM 配置
 *
 * 优先级:
 *   1. 显式传入的 config(用户在 persistedConfig.necessityLlm 里配的)
 *   2. env ANTHROPIC_API_KEY + 默认 model
 *   3. undefined(让 ProposalEngine 用 RuleBasedNecessityEvaluator 兜底)
 *
 * 失败不抛错,返回 undefined,proposal engine 自然降级到规则版。
 */
export function loadClaudeCodeFallbackLlmConfig(
  explicit?: Partial<AnthropicLlmConfig>,
): AnthropicLlmConfig | undefined {
  const apiKey = explicit?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return undefined;

  return {
    apiKey: apiKey.trim(),
    model: explicit?.model ?? DEFAULT_ANTHROPIC_MODEL,
    ...(explicit?.endpoint ? { endpoint: explicit.endpoint } : {}),
    ...(explicit?.headers ? { headers: explicit.headers } : {}),
  };
}

/**
 * 创建 Anthropic Messages API 的 LlmClient
 *
 * 用 fetch 直接调用,避免引入 @anthropic-ai/sdk 依赖(claude-code-mcp
 * 已有 ANTHROPIC_API_KEY 环境,只需要薄薄一层 HTTP 适配)。
 */
export function createAnthropicLlmClient(cfg: AnthropicLlmConfig): LlmClient {
  const baseUrl = (cfg.endpoint ?? DEFAULT_ANTHROPIC_ENDPOINT).replace(
    /\/+$/,
    "",
  );

  return {
    async complete(prompt, opts = {}): Promise<string> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        ...(cfg.headers ?? {}),
      };

      const body = {
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 300,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        messages: [{ role: "user", content: prompt }],
      };

      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Anthropic call failed (${resp.status}): ${text.slice(0, 200)}`,
        );
      }

      // Anthropic Messages API 响应格式:
      //   { content: [{ type: 'text', text: '...' }], ... }
      //   thinking 模型会先输出 type='thinking' 块,再输出 type='text' 块
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await resp.json()) as any;
      const blocks: unknown = json?.content;
      const stopReason: string | undefined = json?.stop_reason;
      if (!Array.isArray(blocks))
        throw new Error("Anthropic returned no content blocks");

      // 1. 优先取 type='text' 块(最终答案)
      const text = blocks
        .filter(
          (b): b is { readonly type: "text"; readonly text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { readonly type?: unknown }).type === "text" &&
            typeof (b as { readonly text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("");
      if (text.trim().length > 0) return text.trim();

      // 2. fallback:thinking 模型 max_tokens 不够时,可能只有 type='thinking' 块
      //    把 thinking 内容当作 content 返回,core 的 parseLlmVerdict 会尝试抽 JSON
      const thinking = blocks
        .filter(
          (b): b is { readonly type: "thinking"; readonly thinking: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { readonly type?: unknown }).type === "thinking" &&
            typeof (b as { readonly thinking?: unknown }).thinking === "string",
        )
        .map((b) => b.thinking)
        .join("");
      if (thinking.trim().length > 0) return thinking.trim();

      // 3. 都为空:抛错带诊断,让 LlmNecessityEvaluator fallback 到规则版
      throw new Error(
        `Anthropic returned empty content (stop_reason=${stopReason ?? "unknown"})`,
      );
    },
  };
}

/**
 * 解析必要性评估器
 *
 * 优先级:
 *   1. persistedConfig.necessityLlm(用户在 config.json 里显式配置的 endpoint/key/model)
 *   2. env ANTHROPIC_API_KEY + 默认 model(claude-haiku-4-5)
 *   3. undefined → ProposalEngine 内部默认 RuleBasedNecessityEvaluator
 *
 * 失败不抛错,返回 undefined 让 ProposalEngine 用规则版兜底。
 *
 * @param explicitConfig 持久化配置中的 necessityLlm 字段(可选)
 */
export function resolveNecessityEvaluator(
  explicitConfig?: Partial<AnthropicLlmConfig>,
): NecessityEvaluator | undefined {
  const llmConfig = loadClaudeCodeFallbackLlmConfig(explicitConfig);
  if (!llmConfig) return undefined;

  try {
    const client = createAnthropicLlmClient(llmConfig);
    return new LlmNecessityEvaluator(client);
  } catch {
    // 配置错误不阻塞 MCP server 启动;规则版兜底
    return undefined;
  }
}
