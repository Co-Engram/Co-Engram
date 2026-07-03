import { describe, it, expect } from "vitest";
import { zh } from "../src/i18n/zh.js";
import { en } from "../src/i18n/en.js";

/**
 * i18n `.agent` 字段字符长度回归测试(Task 5)
 *
 * 背景:host adapter(claude-code-mcp / openclaw-plugin)把 `*.agent` 字段
 * 作为 LLM 工具描述注入。Claude Code / OpenClaw 等宿主与底层 LLM 对描述
 * 长度都有上限(经验阈值 ~800 字符,超限会被截断或拒收)。
 *
 * 该测试在所有 `.agent` key 上设硬上限 800,防止后续增量悄悄突破。
 * 若新增 `.agent` key,会自动被覆盖(无需手动登记)。
 */

const MAX_AGENT_LENGTH = 800;

/** 抓取所有形如 `*.agent` 的 key(并集 zh + en,避免漏登记) */
const agentKeys = Array.from(
  new Set([
    ...Object.keys(zh).filter((k) => k.endsWith(".agent")),
    ...Object.keys(en).filter((k) => k.endsWith(".agent")),
  ]),
).sort();

describe.each(agentKeys)("%s ≤ %d 字符", (key) => {
  it(`zh ≤ ${MAX_AGENT_LENGTH}`, () => {
    const value = (zh as Record<string, string>)[key];
    if (value === undefined) return; // 单语言缺失不算违规(由 i18n.test.ts 兜底)
    expect(value.length).toBeLessThanOrEqual(MAX_AGENT_LENGTH);
  });

  it(`en ≤ ${MAX_AGENT_LENGTH}`, () => {
    const value = (en as Record<string, string>)[key];
    if (value === undefined) return;
    expect(value.length).toBeLessThanOrEqual(MAX_AGENT_LENGTH);
  });
});

describe("i18n .agent key 覆盖完整性", () => {
  it("zh 与 en 的 .agent key 集合一致", () => {
    const zhKeys = new Set(Object.keys(zh).filter((k) => k.endsWith(".agent")));
    const enKeys = new Set(Object.keys(en).filter((k) => k.endsWith(".agent")));
    expect(zhKeys).toEqual(enKeys);
  });

  it(".agent key 数量 ≥ 30(回归下限,防止意外删除)", () => {
    expect(agentKeys.length).toBeGreaterThanOrEqual(30);
  });
});
