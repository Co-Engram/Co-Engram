import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOpenAiCompatibleLlmClient,
  loadOpenClawFallbackLlmConfig,
} from "../src/llm-client.js";

// 模拟 OpenAI 兼容端点的 Response 对象
function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("createOpenAiCompatibleLlmClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("content 字段非空 → 直接返回 trimmed content", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "gpt-4o-mini",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [
          { finish_reason: "stop", message: { content: "  hello world  " } },
        ],
      }),
    );

    const result = await client.complete("hi");
    expect(result).toBe("hello world");
  });

  it("DeepSeek-V4 风格:content=null + reasoning_content 非空 → fallback 返回 reasoning", async () => {
    // DeepSeek-V4 推理模型 max_tokens 不够时:reasoning 阶段用光预算,
    // content=null,reasoning_content 末尾常含 JSON 答案
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.deepseek.com/v1",
      apiKey: "k",
      model: "deepseek-v4",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [
          {
            finish_reason: "length",
            message: {
              content: null,
              reasoning_content:
                '分析样本后,我认为这是一个值得保存的决策。\n{"necessary": true, "reason": "recurring CI decision", "suggestedTitle": "TS CI"}',
            },
          },
        ],
      }),
    );

    const result = await client.complete("hi");
    expect(result).toContain('"necessary": true');
    expect(result).toContain("recurring CI decision");
  });

  it("GLM-5.2 风格:content=null + reasoning_content 非空 → fallback 返回 reasoning", async () => {
    // 智谱 GLM-5.2 通过 OpenAI 兼容端点暴露思考过程,字段名沿用 reasoning_content
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "k",
      model: "glm-5.2",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [
          {
            finish_reason: "length",
            message: {
              content: null,
              reasoning_content:
                '样本都是关于状态管理决策。\n{"necessary": true, "reason": "状态库选型", "suggestedTitle": "Zustand"}',
            },
          },
        ],
      }),
    );

    const result = await client.complete("hi");
    expect(result).toContain('"necessary": true');
    expect(result).toContain("状态库选型");
  });

  it('Qwen3 风格:content="" + reasoning_content 非空 → fallback', async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "k",
      model: "qwen3-235b-a22b",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [
          {
            finish_reason: "length",
            message: { content: "", reasoning_content: "pure reasoning text" },
          },
        ],
      }),
    );

    const result = await client.complete("hi");
    expect(result).toBe("pure reasoning text");
  });

  it("content + reasoning_content 都为空 → 抛错带 finish_reason 诊断", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "glm-5.2",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [
          {
            finish_reason: "length",
            message: { content: null, reasoning_content: null },
          },
        ],
      }),
    );

    await expect(client.complete("hi")).rejects.toThrow(
      /empty content.*finish_reason=length/,
    );
  });

  it("HTTP 4xx/5xx → 抛错带状态码和响应片段", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1",
      apiKey: "invalid",
      model: "glm-5.2",
    });
    fetchMock.mockResolvedValue(
      makeResponse({ error: "invalid api key" }, false, 401),
    );

    await expect(client.complete("hi")).rejects.toThrow(/401.*invalid api key/);
  });

  it("endpoint 自动追加 /chat/completions", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      }),
    );

    await client.complete("hi");
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("endpoint 已含 /chat/completions → 不重复追加", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1/chat/completions",
      apiKey: "k",
      model: "m",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      }),
    );

    await client.complete("hi");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("请求体含 Authorization Bearer + 配置的 model + 透传 opts", async () => {
    const client = createOpenAiCompatibleLlmClient({
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-secret",
      model: "glm-5.2",
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      }),
    );

    await client.complete("eval prompt", {
      maxTokens: 2000,
      temperature: 0.2,
      timeoutMs: 5_000,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    const body = JSON.parse(init!.body as string);
    expect(headers.Authorization).toBe("Bearer sk-secret");
    expect(body.model).toBe("glm-5.2");
    expect(body.max_tokens).toBe(2000);
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([{ role: "user", content: "eval prompt" }]);
  });
});

describe("loadOpenClawFallbackLlmConfig", () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    tmpHome = mkdtempSync(join(tmpdir(), "co-engram-llm-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevUserProfile !== undefined)
      process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("文件不存在 → 返回 undefined", () => {
    expect(loadOpenClawFallbackLlmConfig()).toBeUndefined();
  });

  it("配置含 provider/model 路径 → 解析 baseUrl + apiKey + model", () => {
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { model: { primary: "dashscope/qwen3-235b-a22b" } },
        },
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              apiKey: "sk-test-123",
            },
          },
        },
      }),
    );

    const cfg = loadOpenClawFallbackLlmConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.endpoint).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(cfg!.apiKey).toBe("sk-test-123");
    expect(cfg!.model).toBe("qwen3-235b-a22b");
  });

  it("primary 无 provider 前缀 → 取第一个 provider 兜底", () => {
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: { primary: "glm-5.2" } } },
        models: {
          providers: {
            zhipu: {
              baseUrl: "https://open.bigmodel.cn/api/paas/v4",
              apiKey: "zhipu-k",
            },
          },
        },
      }),
    );

    const cfg = loadOpenClawFallbackLlmConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.endpoint).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(cfg!.apiKey).toBe("zhipu-k");
    expect(cfg!.model).toBe("glm-5.2");
  });

  it("agents.defaults.model.primary 缺失 → 返回 undefined", () => {
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      JSON.stringify({ models: { providers: {} } }),
    );
    expect(loadOpenClawFallbackLlmConfig()).toBeUndefined();
  });

  it("provider 配置缺 baseUrl/apiKey → 返回 undefined", () => {
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: { primary: "zhipu/glm-5.2" } } },
        models: { providers: { zhipu: { baseUrl: "https://x" } } },
      }),
    );
    expect(loadOpenClawFallbackLlmConfig()).toBeUndefined();
  });

  it("JSON 解析失败 → 返回 undefined 不抛错", () => {
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      "{ not valid json",
    );
    expect(loadOpenClawFallbackLlmConfig()).toBeUndefined();
  });
});
