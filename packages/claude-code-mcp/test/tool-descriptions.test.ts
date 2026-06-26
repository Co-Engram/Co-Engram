import { describe, it, expect } from "vitest";
import {
  LLM_TOOL_DESCRIPTIONS,
  overrideDescription,
  overrideDescriptions,
  auditDescriptionQuality,
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
// 完整性:16 个 standard 工具都有描述
// ============================================================

describe("LLM_TOOL_DESCRIPTIONS / 完整性", () => {
  const standardTools = Array.from(PROFILE_TOOL_SETS.standard);

  it("16 个 standard profile 工具全部有 LLM 描述", () => {
    for (const name of standardTools) {
      expect(
        LLM_TOOL_DESCRIPTIONS[name],
        `tool "${name}" missing`,
      ).toBeDefined();
    }
  });

  it("每个描述同时有 en 和 zh", () => {
    for (const [name, entry] of Object.entries(LLM_TOOL_DESCRIPTIONS)) {
      expect(entry.en.length, `${name}.en`).toBeGreaterThan(100);
      expect(entry.zh.length, `${name}.zh`).toBeGreaterThan(50);
    }
  });

  it("LLM_TOOL_DESCRIPTIONS 至少覆盖所有 standard profile 工具(可包含 full-only 工具)", () => {
    const dictKeys = new Set(Object.keys(LLM_TOOL_DESCRIPTIONS));
    for (const name of standardTools) {
      expect(
        dictKeys.has(name),
        `standard tool "${name}" missing from dict`,
      ).toBe(true);
    }
    // 字典可以包含 standard 之外的 full-only 工具(如 engram_doctor)
    expect(Object.keys(LLM_TOOL_DESCRIPTIONS).length).toBeGreaterThanOrEqual(
      standardTools.length,
    );
  });
});

// ============================================================
// 描述质量审计
// ============================================================

describe("LLM_TOOL_DESCRIPTIONS / 质量审计 (en)", () => {
  for (const name of Object.keys(LLM_TOOL_DESCRIPTIONS)) {
    it(`"${name}" en 描述通过审计`, () => {
      const violations = auditDescriptionQuality(name, "en");
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }
});

describe("LLM_TOOL_DESCRIPTIONS / 质量审计 (zh)", () => {
  for (const name of Object.keys(LLM_TOOL_DESCRIPTIONS)) {
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
