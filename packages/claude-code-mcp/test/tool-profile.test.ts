import { describe, it, expect } from "vitest";
import {
  PROFILE_TOOL_SETS,
  PROFILE_TOOL_COUNTS,
  resolveProfile,
  filterToolsByProfile,
  type ToolProfile,
} from "../src/tool-profile.js";
import type { Tool } from "@co-engram/core";

// ============================================================
// helpers
// ============================================================

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: {},
    execute: () => undefined,
  } as unknown as Tool;
}

// S4 Task 2: 函数名保持历史兼容，实际返回 full profile 所有工具(32 个)
function makeAll25Tools(): readonly Tool[] {
  return [...Array.from(PROFILE_TOOL_SETS.full).map(makeTool)];
}

// ============================================================
// PROFILE_TOOL_SETS 完整性
// ============================================================

describe("PROFILE_TOOL_SETS / 三档 profile 工具数", () => {
  it("minimal = 12 (8 核心 + 3 proposal 处理 + engram_sync)", () => {
    expect(PROFILE_TOOL_SETS.minimal.size).toBe(12);
  });

  it("standard = 33 (S1 skill CRUD 5 + S3 skill_invoke + S5 skill compose 3 + skill_related_engram 3)", () => {
    expect(PROFILE_TOOL_SETS.standard.size).toBe(33);
  });

  it("full = 41 (含 S5 skill compose 3 + skill_related_engram 3,S3 skill_invoke)", () => {
    expect(PROFILE_TOOL_SETS.full.size).toBe(41);
  });

  // ============================================================
  // Task 5.1: PROFILE_TOOL_COUNTS regression guard(显式锁定)
  // ============================================================
  it("Task 5.1: PROFILE_TOOL_COUNTS 等于 .size(防硬编码漂移)", () => {
    expect(PROFILE_TOOL_COUNTS.minimal).toBe(PROFILE_TOOL_SETS.minimal.size);
    expect(PROFILE_TOOL_COUNTS.standard).toBe(PROFILE_TOOL_SETS.standard.size);
    expect(PROFILE_TOOL_COUNTS.full).toBe(PROFILE_TOOL_SETS.full.size);
  });

  it("Task 5.1: minimal 至少 11 个(防意外缩容)", () => {
    expect(PROFILE_TOOL_SETS.minimal.size).toBeGreaterThanOrEqual(11);
  });

  it("Task 5.1: standard 至少 17 个(防意外缩容)", () => {
    expect(PROFILE_TOOL_SETS.standard.size).toBeGreaterThanOrEqual(17);
  });

  it("Task 5.1: full 至少 28 个(防意外缩容)", () => {
    expect(PROFILE_TOOL_SETS.full.size).toBeGreaterThanOrEqual(28);
  });
});

describe("PROFILE_TOOL_SETS / 子集关系", () => {
  it("minimal ⊆ standard", () => {
    for (const t of PROFILE_TOOL_SETS.minimal) {
      expect(PROFILE_TOOL_SETS.standard.has(t)).toBe(true);
    }
  });

  it("standard ⊆ full", () => {
    for (const t of PROFILE_TOOL_SETS.standard) {
      expect(PROFILE_TOOL_SETS.full.has(t)).toBe(true);
    }
  });

  it("full 包含所有 native + 仓库健康工具(S3 起 skill_invoke 回归 full,报告使用结果)", () => {
    const managementTools = [
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "synapse_get",
      "synapse_list",
      "synapse_delete",
      "skill_get",
      "upgrade_verification",
      "get_evolution_lineage",
      "engram_doctor",
      "engram_list_paths",
    ];
    for (const t of managementTools) {
      expect(PROFILE_TOOL_SETS.full.has(t)).toBe(true);
    }
    // S3:skill_invoke 回归 full(报告 skill 使用结果,更新印迹)
    expect(PROFILE_TOOL_SETS.full.has("skill_invoke")).toBe(true);
  });

  it("standard 不包含管理类工具(skill CRUD + skill_invoke 现属 standard,非管理类)", () => {
    const managementTools = [
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "synapse_get",
      "synapse_list",
      "synapse_delete",
      "upgrade_verification",
      "get_evolution_lineage",
    ];
    for (const t of managementTools) {
      expect(PROFILE_TOOL_SETS.standard.has(t)).toBe(false);
    }
    // S4 Task 2 + S3: skill CRUD + skill_invoke 现属 standard profile
    expect(PROFILE_TOOL_SETS.standard.has("skill_get")).toBe(true);
    expect(PROFILE_TOOL_SETS.standard.has("skill_list")).toBe(true);
    expect(PROFILE_TOOL_SETS.standard.has("skill_create")).toBe(true);
    expect(PROFILE_TOOL_SETS.standard.has("skill_update")).toBe(true);
    expect(PROFILE_TOOL_SETS.standard.has("skill_delete")).toBe(true);
    expect(PROFILE_TOOL_SETS.standard.has("skill_invoke")).toBe(true);
  });
});

// ============================================================
// resolveProfile
// ============================================================

describe("resolveProfile / env 优先级", () => {
  it("CO_ENGRAM_TOOLS_PROFILE 优先", () => {
    const r = resolveProfile(
      { CO_ENGRAM_TOOLS_PROFILE: "minimal" },
      { toolsProfile: "full" },
    );
    expect(r.profile).toBe("minimal");
    expect(r.source).toBe("env");
  });

  it("COA_ENGRAM_TOOLS_PROFILE 别名也工作", () => {
    const r = resolveProfile({ COA_ENGRAM_TOOLS_PROFILE: "full" });
    expect(r.profile).toBe("full");
    expect(r.source).toBe("env");
  });

  it("CO_ENGRAM 优先于 COA_ENGRAM", () => {
    const r = resolveProfile({
      CO_ENGRAM_TOOLS_PROFILE: "standard",
      COA_ENGRAM_TOOLS_PROFILE: "minimal",
    });
    expect(r.profile).toBe("standard");
  });

  it("env 空字符串降级到 persisted", () => {
    const r = resolveProfile(
      { CO_ENGRAM_TOOLS_PROFILE: "" },
      { toolsProfile: "minimal" },
    );
    expect(r.profile).toBe("minimal");
    expect(r.source).toBe("persisted");
  });

  it("env 不存在时使用 persistedConfig", () => {
    const r = resolveProfile({}, { toolsProfile: "minimal" });
    expect(r.profile).toBe("minimal");
    expect(r.source).toBe("persisted");
  });

  it("env 和 persisted 都无时用默认 standard", () => {
    const r = resolveProfile({});
    expect(r.profile).toBe("standard");
    expect(r.source).toBe("default");
  });

  it("未知 env 值降级到 standard + 带警告", () => {
    const r = resolveProfile({ CO_ENGRAM_TOOLS_PROFILE: "bogus" });
    expect(r.profile).toBe("standard");
    expect(r.source).toBe("env");
    expect(r.warned).toMatch(/Unknown.*bogus/);
  });

  it("警告列出了合法值,帮用户 self-recover", () => {
    const r = resolveProfile({ CO_ENGRAM_TOOLS_PROFILE: "bogus" });
    expect(r.warned).toMatch(/minimal/);
    expect(r.warned).toMatch(/standard/);
    expect(r.warned).toMatch(/full/);
  });

  it("未知 persistedConfig 值降级到 standard(无警告)", () => {
    const r = resolveProfile({}, { toolsProfile: "bogus" });
    expect(r.profile).toBe("standard");
    expect(r.source).toBe("default");
    expect(r.warned).toBeUndefined();
  });
});

// ============================================================
// filterToolsByProfile
// ============================================================

describe("filterToolsByProfile / 过滤行为", () => {
  it("full 不过滤(返回原数组)", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "full");
    expect(filtered.length).toBe(41); // full profile 不过滤 = PROFILE_TOOL_SETS.full.size
    expect(filtered).toBe(all); // 直接返回原引用
  });

  it("minimal 过滤到 12 个", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "minimal");
    expect(filtered.length).toBe(12);
  });

  it("standard 过滤到 33 个(S5 含 skill compose 3 + skill_related_engram 3)", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "standard");
    expect(filtered.length).toBe(33);
  });

  it("minimal 不含 engram_delete", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "minimal");
    expect(filtered.find((t) => t.name === "engram_delete")).toBeUndefined();
  });

  it("standard 含 engram_delete", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "standard");
    expect(filtered.find((t) => t.name === "engram_delete")).toBeDefined();
  });

  it("standard 不含管理类工具(archive/restore/forget/...;S4 Task 2: skill CRUD 现属 standard)", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "standard");
    const hidden = [
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "synapse_get",
      "synapse_list",
      "synapse_delete",
      "upgrade_verification",
      "get_evolution_lineage",
    ];
    for (const h of hidden) {
      expect(filtered.find((t) => t.name === h)).toBeUndefined();
    }
    // S4 Task 2: 确认 skill CRUD 工具现在确实出现在 standard 过滤结果中
    expect(filtered.find((t) => t.name === "skill_get")).toBeDefined();
    expect(filtered.find((t) => t.name === "skill_list")).toBeDefined();
    expect(filtered.find((t) => t.name === "skill_create")).toBeDefined();
    expect(filtered.find((t) => t.name === "skill_update")).toBeDefined();
    expect(filtered.find((t) => t.name === "skill_delete")).toBeDefined();
  });

  it("空工具列表不抛错", () => {
    const filtered = filterToolsByProfile([], "standard");
    expect(filtered).toEqual([]);
  });

  it("不修改输入数组", () => {
    const all = makeAll25Tools();
    const originalLength = all.length;
    filterToolsByProfile(all, "minimal");
    expect(all.length).toBe(originalLength);
  });
});

// ============================================================
// 类型导出验证(编译期保证)
// ============================================================

describe("type exports", () => {
  it("ToolProfile 类型可使用", () => {
    const p: ToolProfile = "minimal";
    expect(PROFILE_TOOL_SETS[p]).toBeDefined();
  });
});
