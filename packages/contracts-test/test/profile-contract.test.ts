import { describe, it, expect } from "vitest";
import * as CC from "@co-engram/claude-code";
import * as OC from "@co-engram/openclaw";
import type { ToolProfile } from "@co-engram/core";

const PROFILES: readonly ToolProfile[] = ["minimal", "standard", "full"];

describe("profile contract: claude-code-mcp ≡ openclaw-plugin", () => {
  it("claude-code-mcp exports PROFILE_TOOL_SETS", () => {
    expect(CC.PROFILE_TOOL_SETS).toBeDefined();
    for (const p of PROFILES) {
      expect(CC.PROFILE_TOOL_SETS[p]).toBeInstanceOf(Set);
    }
  });

  it("openclaw-plugin exports PROFILE_TOOL_SETS", () => {
    expect(OC.PROFILE_TOOL_SETS).toBeDefined();
    for (const p of PROFILES) {
      expect(OC.PROFILE_TOOL_SETS[p]).toBeInstanceOf(Set);
    }
  });

  it("both exports are reference-equal (single source via core)", () => {
    // 因为两宿主都从 @co-engram/core re-export,应是同一份对象引用
    for (const p of PROFILES) {
      expect(OC.PROFILE_TOOL_SETS[p]).toBe(CC.PROFILE_TOOL_SETS[p]);
    }
  });

  it("PROFILE_TOOL_COUNTS matches actual set size (no hardcoded drift)", () => {
    for (const p of PROFILES) {
      expect(CC.PROFILE_TOOL_COUNTS[p]).toBe(CC.PROFILE_TOOL_SETS[p].size);
      expect(OC.PROFILE_TOOL_COUNTS[p]).toBe(OC.PROFILE_TOOL_SETS[p].size);
    }
  });

  it("actual counts match observed real values (12/26/34)", () => {
    // 15 轮拉通分析的 R13 实证 + Task 3.2 / 3.3 调整 + AI-8 batch proposal + S1 skill CRUD:
    // minimal 12(含 engram_sync),
    // standard 26(Task 3.3 加 engram_audit_query;AI-8 加 batch proposal × 2;S1 加 skill CRUD × 5),
    // full 34(skill_invoke 是 P0 stub,Task 3.2 移出 full profile,
    //         Task 3.3 加 engram_audit_query,AI-8 加 batch proposal × 2;S1 补齐 skill CRUD × 5)
    expect(CC.PROFILE_TOOL_SETS.minimal.size).toBe(12);
    expect(CC.PROFILE_TOOL_SETS.standard.size).toBe(26);
    expect(CC.PROFILE_TOOL_SETS.full.size).toBe(34);
  });

  it("resolveProfile + filterToolsByProfile available from both hosts", () => {
    expect(typeof CC.resolveProfile).toBe("function");
    expect(typeof CC.filterToolsByProfile).toBe("function");
    expect(typeof OC.resolveProfile).toBe("function");
    expect(typeof OC.filterToolsByProfile).toBe("function");
  });
});
