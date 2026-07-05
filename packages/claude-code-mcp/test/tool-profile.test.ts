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

  it("standard = 19 (Task 3.3 加 engram_audit_query 后)", () => {
    expect(PROFILE_TOOL_SETS.standard.size).toBe(19);
  });

  it("full = 28 (Task 3.2 移除 skill_invoke,Task 3.3 加 engram_audit_query,Task 4c 移除 engram_recompute_importance)", () => {
    expect(PROFILE_TOOL_SETS.full.size).toBe(28);
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

  it("full 包含所有 native + 仓库健康工具(含管理类,Task 3.2 后不含 skill_invoke)", () => {
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
    // Task 3.2:skill_invoke 移出 full profile(标 experimental stub)
    expect(PROFILE_TOOL_SETS.full.has("skill_invoke")).toBe(false);
  });

  it("standard 不包含管理类工具", () => {
    const managementTools = [
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "synapse_get",
      "synapse_list",
      "synapse_delete",
      "skill_get",
      "skill_invoke",
      "upgrade_verification",
      "get_evolution_lineage",
    ];
    for (const t of managementTools) {
      expect(PROFILE_TOOL_SETS.standard.has(t)).toBe(false);
    }
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
    expect(filtered.length).toBe(28);
    expect(filtered).toBe(all); // 直接返回原引用
  });

  it("minimal 过滤到 12 个", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "minimal");
    expect(filtered.length).toBe(12);
  });

  it("standard 过滤到 19 个(Task 3.3 加 engram_audit_query 后)", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "standard");
    expect(filtered.length).toBe(19);
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

  it("standard 不含管理类工具(archive/restore/forget/...)", () => {
    const all = makeAll25Tools();
    const filtered = filterToolsByProfile(all, "standard");
    const hidden = [
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "synapse_get",
      "synapse_list",
      "synapse_delete",
      "skill_get",
      "skill_invoke",
      "upgrade_verification",
      "get_evolution_lineage",
    ];
    for (const h of hidden) {
      expect(filtered.find((t) => t.name === h)).toBeUndefined();
    }
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
