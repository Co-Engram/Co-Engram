/**
 * Driver-side LLM client bootstrap (spec §5.1).
 *
 * 问题:host (claude-code-mcp / openclaw-plugin) 启动时已经构造了 LlmClient 实例,
 * 但 git merge driver 是 git 直接 spawn 的独立进程,host 无法注入对象引用。
 *
 * 解决:host 把 LLM 配置(endpoint / apiKey / model)序列化到
 * `~/.co-engram/llm-config.json`,driver 启动时读出来用 fetch 构造 HTTP client。
 *
 * 协议选 OpenAI-compatible(/chat/completions) —— 最通用:
 *   - OpenAI / Azure / 通义 / 智谱 / DeepSeek / 月之暗面 / ollama 原生支持
 *   - Anthropic 也有 OpenAI 兼容端点(https://api.anthropic.com/v1/openai/v1)
 *
 * @module @co-engram/core/merge
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { internalError } from "../tools/error-schema.js";

/**
 * LLM 配置(序列化形式)。
 *
 * host 启动时写入,driver 启动时读出。
 * 字段命名与 host 端 NecessityLlmConfig 对齐,便于 host 直接序列化。
 */
export interface LlmClientConfig {
  /** OpenAI-compatible chat completions endpoint(完整 URL) */
  readonly endpoint: string;
  /** API key(Bearer token) */
  readonly apiKey: string;
  /** 模型名(如 'glm-5.2' / 'claude-sonnet-4-6' / 'gpt-5.5') */
  readonly model: string;
  /** 额外 headers(可选) */
  readonly headers?: Readonly<Record<string, string>>;
  /** 写入时间(ISO)——driver 用于 staleness 检查 */
  readonly writtenAt: string;
  /** 写入者( host 名,用于诊断) */
  readonly writtenBy?: string;
}

/** 文件名(相对于 dataRoot/.co-engram/) */
const CONFIG_FILENAME = "llm-config.json";

/**
 * 解析 config 文件路径。
 *
 * 优先级:
 *   1. `$CO_ENGRAM_LLM_CONFIG`(绝对路径,测试用)
 *   2. `$HOME/.co-engram/llm-config.json`(默认)
 *   3. 退化:OS tmpdir(不推荐,仅当 HOME 缺失时)
 */
export function resolveLlmConfigPath(): string {
  const override = process.env.CO_ENGRAM_LLM_CONFIG;
  if (override) return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  if (home) return join(home, ".co-engram", CONFIG_FILENAME);
  return join(tmpdir(), ".co-engram", CONFIG_FILENAME);
}

/**
 * 写 LLM 配置到磁盘(host 启动时调用)。
 *
 * 不抛错 —— 写失败只警告,host 不应因 LLM 配置写盘失败而崩溃。
 */
export function writeLlmClientConfig(
  config: Omit<LlmClientConfig, "writtenAt">,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const path = resolveLlmConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    const full: LlmClientConfig = {
      ...config,
      writtenAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(full, null, 2), "utf8");
    return { ok: true, path };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 读 LLM 配置(driver 启动时调用)。
 *
 * 不抛错 —— 读失败/文件缺失都返回 undefined,driver 退化为 no-LLM 模式。
 */
export function readLlmClientConfig(): LlmClientConfig | undefined {
  try {
    const path = resolveLlmConfigPath();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LlmClientConfig>;
    if (
      typeof parsed.endpoint !== "string" ||
      typeof parsed.apiKey !== "string" ||
      typeof parsed.model !== "string"
    ) {
      return undefined;
    }
    return parsed as LlmClientConfig;
  } catch {
    return undefined;
  }
}

/**
 * 删除 LLM 配置(uninstall 时调用)。
 *
 * 用于 host 完全卸载 merge driver 时清理敏感数据。
 * 失败不抛错,只返回 status。
 */
export function clearLlmClientConfig():
  | { ok: true; path: string }
  | { ok: false; error: string } {
  try {
    const path = resolveLlmConfigPath();
    if (!existsSync(path)) return { ok: true, path };
    rmSync(path, { force: true });
    return { ok: true, path };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 把任意 endpoint 规范化为完整 chat completions URL。
 *
 * - 已是 /chat/completions 结尾 → 不变
 * - 是 base URL(如 https://api.openai.com/v1)→ 自动追加 /chat/completions
 */
function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * 创建 OpenAI-compatible HTTP LlmClient(基于 fetch)。
 *
 * 任何抛错都让调用方(LlmArbiter)捕获并降级到 escalate。
 */
export function createHttpLlmClient(config: LlmClientConfig): LlmClient {
  const endpoint = normalizeEndpoint(config.endpoint);
  return {
    async complete(prompt, opts = {}): Promise<string> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.headers ?? {}),
      };

      const body = {
        model: config.model,
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
        throw internalError(
          `LLM call failed (${resp.status}): ${text.slice(0, 200)}`,
        );
      }

      const json = (await resp.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
          };
        }>;
      };

      const choice = json.choices?.[0]?.message;
      // reasoning 模型 fallback:某些 endpoint 把内容塞到 reasoning_content
      const content = choice?.content ?? choice?.reasoning_content ?? "";
      if (!content) {
        throw internalError("LLM returned empty content");
      }
      return content;
    },
  };
}

/**
 * Driver 启动时的便捷入口:读 config + 构造 client。
 *
 * 失败返回 null,driver 退化为 no-LLM 模式(机械规则解决不了的冲突 → marker)。
 */
export function createDriverLlmClient(): {
  client: LlmClient;
  config: LlmClientConfig;
} | null {
  const config = readLlmClientConfig();
  if (!config) return null;
  try {
    return { client: createHttpLlmClient(config), config };
  } catch {
    return null;
  }
}
