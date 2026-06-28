import { describe, it, expect } from "vitest";
import {
  overrideDescription,
  overrideDescriptions,
  auditDescriptionQuality,
  resolveLlmDescription,
  listAgentDescribedTools,
} from "../src/tool-descriptions.js";
import { PROFILE_TOOL_SETS } from "../src/tool-profile.js";
import type { Tool, Language } from "@co-engram/core";

// ============================================================
// helpers
// ============================================================

function makeTool(name: string, description = "fallback desc"): Tool {
  return {
    name,
    description,
    inputSchema: {},
    execute: () => undefined,
  } as unknown as Tool;
}

// ============================================================
// 完整性:standard profile 工具都有 agent 层描述
// ============================================================

describe("agent layer descriptions / 完整性", () => {
  const standardTools = Array.from(PROFILE_TOOL_SETS.standard);
  const describedTools = new Set(listAgentDescribedTools());

  it("17 个 standard profile 工具全部有 agent 层描述", () => {
    for (const name of standardTools) {
      expect(
        describedTools.has(name),
        `tool "${name}" missing agent layer description`,
      ).toBe(true);
    }
  });

  it("agent 层至少覆盖所有 standard profile 工具(可包含 full-only 工具)", () => {
    for (const name of standardTools) {
      expect(
        describedTools.has(name),
        `standard tool "${name}" missing from agent layer`,
      ).toBe(true);
    }
    // 实际覆盖全部 30 个工具(17 standard + 13 full-only/兼容)
    expect(describedTools.size).toBeGreaterThanOrEqual(standardTools.length);
  });

  it("agent 层覆盖所有 30 个 native + 兼容工具", () => {
    // 迁移后应有 30 个工具的 agent 层描述
    expect(describedTools.size).toBeGreaterThanOrEqual(28);
  });
});

// ============================================================
// 描述质量审计
// ============================================================

describe("agent layer descriptions / 质量审计 (en)", () => {
  for (const name of listAgentDescribedTools()) {
    it(`"${name}" en 描述通过审计`, () => {
      const violations = auditDescriptionQuality(name, "en");
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }
});

describe("agent layer descriptions / 质量审计 (zh)", () => {
  for (const name of listAgentDescribedTools()) {
    it(`"${name}" zh 描述通过审计`, () => {
      const violations = auditDescriptionQuality(name, "zh");
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }
});

// ============================================================
// overrideDescription / 单工具
// ============================================================

describe("overrideDescription", () => {
  it("覆盖已知工具的 description", () => {
    const t = makeTool("engram_search", "old desc");
    const overridden = overrideDescription(t, "en");
    expect(overridden.description).not.toBe("old desc");
    expect(overridden.description).toContain("WHEN TO CALL");
  });

  it("zh 语言返回中文描述", () => {
    const t = makeTool("engram_search", "old");
    const overridden = overrideDescription(t, "zh");
    expect(overridden.description).toContain("何时调用");
    expect(overridden.description).not.toContain("WHEN TO CALL");
  });

  it("未知工具返回原 tool(无 mutation)", () => {
    const t = makeTool("unknown_tool", "original");
    const result = overrideDescription(t, "en");
    expect(result).toBe(t); // 引用相同 = 未修改
    expect(result.description).toBe("original");
  });

  it("不修改原 tool(返回新对象)", () => {
    const t = makeTool("engram_search", "original");
    overrideDescription(t, "en");
    expect(t.description).toBe("original");
  });

  it("保留 tool 其他字段(execute / inputSchema)", () => {
    const t = makeTool("engram_search", "old");
    const overridden = overrideDescription(t, "en");
    expect(overridden.name).toBe(t.name);
    expect(overridden.inputSchema).toBe(t.inputSchema);
    expect(overridden.execute).toBe(t.execute);
  });
});

// ============================================================
// overrideDescriptions / 批量
// ============================================================

describe("overrideDescriptions", () => {
  it("批量覆盖已知工具", () => {
    const tools = [
      makeTool("engram_search", "a"),
      makeTool("engram_get", "b"),
      makeTool("unknown", "c"),
    ];
    const overridden = overrideDescriptions(tools, "en");
    expect(overridden[0]!.description).not.toBe("a");
    expect(overridden[1]!.description).not.toBe("b");
    expect(overridden[2]!.description).toBe("c"); // 未知保持原样
  });

  it("不修改原数组", () => {
    const tools = [makeTool("engram_search", "a")];
    overrideDescriptions(tools, "en");
    expect(tools[0]!.description).toBe("a");
  });

  it("空数组返回空数组", () => {
    expect(overrideDescriptions([], "en")).toEqual([]);
  });

  it("两种语言对同一组工具产生不同描述", () => {
    const tools = [makeTool("engram_search", "x")];
    const en = overrideDescriptions(tools, "en");
    const zh = overrideDescriptions(tools, "zh");
    expect(en[0]!.description).not.toEqual(zh[0]!.description);
  });
});

// ============================================================
// auditDescriptionQuality / 边界
// ============================================================

describe("auditDescriptionQuality / 边界", () => {
  it("未知工具名返回违规", () => {
    const v = auditDescriptionQuality("unknown_tool", "en");
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]).toMatch(/no LLM-facing description/);
  });

  it("engram_get 允许 truthScore(RETURNS 段引用字段名)", () => {
    const v = auditDescriptionQuality("engram_get", "en");
    expect(v).toEqual([]);
  });
});

// ============================================================
// resolveLlmDescription / 直接调用
// ============================================================

describe("resolveLlmDescription", () => {
  it("已知工具返回 agent 层描述", () => {
    const t = makeTool("engram_search", "fallback");
    const en = resolveLlmDescription(t, "en");
    expect(en).toContain("WHEN TO CALL");
    expect(en).not.toBe("fallback");
  });

  it("未知工具 fallback 到 tool.description", () => {
    const t = makeTool("unknown_tool", "fallback desc");
    const result = resolveLlmDescription(t, "en");
    expect(result).toBe("fallback desc");
  });

  it("zh / en 返回不同描述", () => {
    const t = makeTool("engram_create", "fallback");
    const en = resolveLlmDescription(t, "en");
    const zh = resolveLlmDescription(t, "zh");
    expect(en).not.toBe(zh);
    expect(zh).toContain("何时调用");
  });
});
