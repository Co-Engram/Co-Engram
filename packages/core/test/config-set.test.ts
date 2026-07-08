/**
 * config-set / setConfigField 单元测试（AI-3c）
 *
 * 覆盖：
 *   - type coercion：string / number / boolean / object
 *   - dotted path 写入（顶级 + 嵌套）
 *   - unknown key 拒绝
 *   - deprecated key 拒绝
 *   - 中间路径缺失 → CONFIG 错误
 *   - 不修改入参（immutability）
 */
import { describe, it, expect } from "vitest";
import {
  setConfigField,
  coerceValue,
  listWritableKeys,
  CONFIG_KEY_CATALOG,
  createDefaultConfig,
} from "../src/config/index.js";
import { isEngramToolError } from "../src/tools/error-schema.js";
import type { TeamMemoryConfig } from "../src/config/types.js";

describe("coerceValue", () => {
  it("boolean: 'true' / 'false' (case-insensitive)", () => {
    expect(coerceValue("boolean", "true")).toBe(true);
    expect(coerceValue("boolean", "FALSE")).toBe(false);
  });

  it("boolean: invalid → VALIDATION error", () => {
    try {
      coerceValue("boolean", "yes");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("number: parses int / float / negative", () => {
    expect(coerceValue("number", "42")).toBe(42);
    expect(coerceValue("number", "0.5")).toBe(0.5);
    expect(coerceValue("number", "-1")).toBe(-1);
    expect(coerceValue("number", "1e3")).toBe(1000);
  });

  it("number: non-numeric → VALIDATION error", () => {
    try {
      coerceValue("number", "abc");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("object: JSON object", () => {
    const parsed = coerceValue("object", '{"key":"value"}');
    expect(parsed).toEqual({ key: "value" });
  });

  it("object: JSON array", () => {
    const parsed = coerceValue("object", "[1,2,3]");
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("object: invalid JSON → VALIDATION error", () => {
    try {
      coerceValue("object", "{not json");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("object: scalar JSON (5) → VALIDATION error", () => {
    try {
      coerceValue("object", "5");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("string: passes through", () => {
    expect(coerceValue("string", "hello")).toBe("hello");
    // 字符串也接受 'true' / 数字字符串（不强制类型）
    expect(coerceValue("string", "42")).toBe("42");
  });
});

describe("setConfigField", () => {
  function baseConfig(): TeamMemoryConfig {
    return createDefaultConfig();
  }

  it("顶级 string 字段写入", () => {
    const { config, result } = setConfigField(
      baseConfig(),
      "language",
      "zh",
    );
    expect(config.language).toBe("zh");
    expect(result.key).toBe("language");
    expect(result.type).toBe("string");
    expect(result.newValue).toBe("zh");
    expect(result.previousValue).toBe("zh"); // createDefaultConfig 默认就是 zh
  });

  it("嵌套 dotted path 写入", () => {
    const { config, result } = setConfigField(
      baseConfig(),
      "audit.rotation.retentionDays",
      "180",
    );
    expect(config.audit?.rotation?.retentionDays).toBe(180);
    expect(result.newValue).toBe(180);
    expect(result.type).toBe("number");
  });

  it("necessityLlm.apiKey 写入（顶级 object 字段下的 string）", () => {
    const { config } = setConfigField(
      baseConfig(),
      "necessityLlm.apiKey",
      "sk-ant-test-key",
    );
    expect(config.necessityLlm?.apiKey).toBe("sk-ant-test-key");
  });

  it("maintenance.enabledStages 接受 JSON 数组", () => {
    const { config } = setConfigField(
      baseConfig(),
      "maintenance.enabledStages",
      '["light","deep"]',
    );
    expect(config.maintenance?.enabledStages).toEqual(["light", "deep"]);
  });

  it("不修改入参 config（immutability）", () => {
    const before = baseConfig();
    const beforeSnapshot = JSON.stringify(before);
    setConfigField(before, "language", "en");
    expect(JSON.stringify(before)).toBe(beforeSnapshot);
  });

  it("previousValue 捕获改前的值", () => {
    const cfg = baseConfig();
    // 先改一次
    const { config: cfg2 } = setConfigField(cfg, "language", "en");
    // 再改第二次,看 previousValue 是不是上次的 en
    const { result } = setConfigField(cfg2, "language", "zh");
    expect(result.previousValue).toBe("en");
    expect(result.newValue).toBe("zh");
  });

  it("unknown key → VALIDATION error 列出 valid keys", () => {
    try {
      setConfigField(baseConfig(), "nonsense.key", "v");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as { code: string; message: string; suggestion?: string };
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(/Unknown config key: 'nonsense\.key'/);
      expect(e.suggestion).toMatch(/Valid writable keys/);
      // suggestion 应该包含 language / audit 等已知 key
      expect(e.suggestion).toContain("language");
      expect(e.suggestion).toContain("audit.rotation.retentionDays");
    }
  });

  it("deprecated key (viewer.port) → VALIDATION error", () => {
    try {
      setConfigField(baseConfig(), "viewer.port", "8080");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isEngramToolError(err)).toBe(true);
      const e = err as { code: string; message: string };
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(/deprecated/);
      expect(e.message).toMatch(/viewer\.port/);
    }
  });

  it("boolean 类型校验失败 → VALIDATION error", () => {
    try {
      setConfigField(baseConfig(), "maintenance.enabled", "yes");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("number 类型校验失败 → VALIDATION error", () => {
    try {
      setConfigField(baseConfig(), "audit.rotation.retentionDays", "not-a-number");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("VALIDATION");
    }
  });

  it("intermediate path 缺失 → 自动创建（necessityLlm 不在 default config 里）", () => {
    const cfg = baseConfig();
    expect(cfg.necessityLlm).toBeUndefined();
    const { config } = setConfigField(cfg, "necessityLlm.model", "claude-test");
    expect(config.necessityLlm?.model).toBe("claude-test");
    // 同时保留 necessityLlm 中已设的其他字段（不存在的字段不破坏其他 key）
    const { config: cfg2 } = setConfigField(
      config,
      "necessityLlm.apiKey",
      "sk-test",
    );
    expect(cfg2.necessityLlm?.apiKey).toBe("sk-test");
    expect(cfg2.necessityLlm?.model).toBe("claude-test");
  });
});

describe("listWritableKeys", () => {
  it("返回非空 catalog 含已知 key", () => {
    const keys = listWritableKeys();
    expect(keys.length).toBeGreaterThan(20);
    const keyStrings = keys.map((k) => k.key);
    expect(keyStrings).toContain("language");
    expect(keyStrings).toContain("audit.rotation.retentionDays");
    expect(keyStrings).toContain("necessityLlm.apiKey");
  });

  it("viewer.port 标记为 deprecated", () => {
    const keys = listWritableKeys();
    const port = keys.find((k) => k.key === "viewer.port");
    expect(port?.deprecated).toBe(true);
  });

  it("非 deprecated key 不带 deprecated 标记", () => {
    const keys = listWritableKeys();
    const lang = keys.find((k) => k.key === "language");
    expect(lang?.deprecated).toBe(false);
  });
});

describe("CONFIG_KEY_CATALOG 完整性", () => {
  it("每个 entry 有 type 与 description", () => {
    for (const [key, meta] of Object.entries(CONFIG_KEY_CATALOG)) {
      expect(meta.type).toMatch(/^(string|number|boolean|object)$/);
      expect(meta.description.length).toBeGreaterThan(0);
      // 每个描述应该是非空字符串
      void key;
    }
  });
});
