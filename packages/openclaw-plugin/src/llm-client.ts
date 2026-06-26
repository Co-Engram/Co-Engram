/**
 * OpenAI-compatible LlmClient 适配器
 *
 * 把 co-engram core 的 LlmClient 抽象映射到一个 fetch POST `/chat/completions`。
 * 支持任何 OpenAI 兼容端点(OpenAI / Azure / 通义 / 智谱 / DeepSeek / 月之暗面 / 本地 ollama 等)。
 * 推理模型(Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2)通过 reasoning_content fallback 自动支持。
 *
 * 设计参考 flexmem shared/llm-call.ts:
 *   - 复用 OpenClaw native model config(若可用)作为 fallback
 *   - 失败时抛错,由 LlmNecessityEvaluator 决定是否 fallback 到规则版
 *
 * @module @co-engram/openclaw
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "@co-engram/core";
import type { NecessityLlmConfig } from "./types.js";

/**
 * 从 OpenClaw 全局配置(~/.openclaw/openclaw.json)读默认 LLM 配置
 *
 * 当用户未在 plugin config 显式配置 necessityLlm 时,作为 fallback。
 * 读 agents.defaults.model.primary 解析 provider,再取对应 provider 的 baseUrl + apiKey。
 */
export function loadOpenClawFallbackLlmConfig():
  | NecessityLlmConfig
  | undefined {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const cfgPath = join(home, ".openclaw", "openclaw.json");
    if (!existsSync(cfgPath)) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as any;
    const agentModel: string | undefined =
      raw?.agents?.defaults?.model?.primary;
    if (!agentModel) return undefined;

    const [providerKey, modelId] = agentModel.includes("/")
      ? agentModel.split("/", 2)
      : [undefined, agentModel];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providerCfg = providerKey
      ? raw?.models?.providers?.[providerKey]
      : (Object.values(raw?.models?.providers ?? {})[0] as any);
    if (!providerCfg) return undefined;

    const baseUrl: string | undefined = providerCfg.baseUrl;
    const apiKey: string | undefined = providerCfg.apiKey;
    if (!baseUrl || !apiKey) return undefined;

    return { endpoint: baseUrl, apiKey, model: modelId };
  } catch {
    return undefined;
  }
}

/**
 * 创建 OpenAI-compatible LlmClient
 *
 * 自动追加 `/chat/completions` 后缀。
 */
export function createOpenAiCompatibleLlmClient(
  cfg: NecessityLlmConfig,
): LlmClient {
  const endpoint = normalizeEndpoint(cfg.endpoint);

  return {
    async complete(prompt, opts = {}): Promise<string> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.headers ?? {}),
      };

      const body = {
        model: cfg.model,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 300,
        messages: [{ role: "user", content: prompt }],
      };

      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `LLM call failed (${resp.status}): ${text.slice(0, 200)}`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await resp.json()) as any;
      const choice = json?.choices?.[0];
      const message = choice?.message;
      const finishReason: string | undefined = choice?.finish_reason;

      // 1. 正式 content 优先
      const content: string | undefined = message?.content;
      if (content && content.trim().length > 0) return content.trim();

      // 2. reasoning 模型 fallback:content=null + reasoning_content 非空
      //    Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 等 reasoning 模型,
      //    reasoning 阶段就用光 max_tokens 时 content=null。
      //    reasoning_content 末尾常含 JSON 答案,交给 core 的 parseLlmVerdict 抽取。
      const reasoning: string | undefined = message?.reasoning_content;
      if (reasoning && reasoning.trim().length > 0) {
        return reasoning.trim();
      }

      // 3. 都为空:抛错带诊断,让 LlmNecessityEvaluator fallback 到规则版
      throw new Error(
        `LLM returned empty content (finish_reason=${finishReason ?? "unknown"})`,
      );
    },
  };
}

function normalizeEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}
