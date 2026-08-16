// 宿主模型复用:未显式配置时自动跟随 ANTHROPIC_* env(通用性)
import { afterEach, describe, expect, it } from "vitest";
import { loadClaudeCodeFallbackLlmConfig } from "../src/llm-client.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_BASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEachSave();
function beforeEachSave() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadClaudeCodeFallbackLlmConfig(宿主 env 复用)", () => {
  it("无任何凭据 → undefined(降级规则版)", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(loadClaudeCodeFallbackLlmConfig()).toBeUndefined();
  });

  it("宿主 env:model/endpoint/token 全跟随(如 GLM 网关宿主)", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-123";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example/api/anthropic";
    process.env.ANTHROPIC_MODEL = "glm-5.3";
    const cfg = loadClaudeCodeFallbackLlmConfig()!;
    expect(cfg.model).toBe("glm-5.3");
    expect(cfg.endpoint).toBe("https://gateway.example/api/anthropic");
    expect(cfg.authToken).toBe("tok-123");
  });

  it("宿主只配 ANTHROPIC_DEFAULT_HAIKU_MODEL 时作为模型来源", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-1";
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-5.3[1m]";
    expect(loadClaudeCodeFallbackLlmConfig()!.model).toBe("glm-5.3[1m]");
  });

  it("显式 persistedConfig 优先于宿主 env", () => {
    process.env.ANTHROPIC_MODEL = "host-model";
    const cfg = loadClaudeCodeFallbackLlmConfig({
      apiKey: "sk-2",
      model: "explicit-model",
    })!;
    expect(cfg.model).toBe("explicit-model");
  });

  it("env 都缺 → 硬编码默认端点与模型(向后兼容)", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = loadClaudeCodeFallbackLlmConfig({ apiKey: "sk-3" })!;
    expect(cfg.model).toBe("claude-haiku-4-5-20251001");
    expect(cfg.endpoint).toBeUndefined();
  });
});

describe("model 后缀规范化(宿主窗口标记)", () => {
  it.each(["glm-5.3[1m]", "claude-opus-4-8[128k]", "m-x[500km]", "q-9[2m]"])(
    "%s 发送前剥除窗口后缀",
    (m) => {
      expect(m.replace(/\[[a-zA-Z0-9]+\]$/, "")).not.toContain("[");
    },
  );
});
