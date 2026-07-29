import { describe, it, expect } from "vitest";
import { resolveLlmDescription } from "../src/tools/llm-descriptions.js";
import { PROFILE_TOOL_SETS } from "../src/tools/tool-profile.js";
import type { Tool } from "../src/tools/tool.js";

const stubTool = (name: string): Tool => ({
  name,
  description: "",
  inputSchema: {} as never,
  execute: () => {
    throw new Error("stub");
  },
});

describe("skill_invoke visibility (S3 已实现)", () => {
  it("skill_invoke 已在 standard + full profile(S3 实现,用于报告使用结果)", () => {
    expect(PROFILE_TOOL_SETS.standard.has("skill_invoke")).toBe(true);
    expect(PROFILE_TOOL_SETS.full.has("skill_invoke")).toBe(true);
  });

  it("skill_get remains in full profile (read-only, no stub)", () => {
    expect(PROFILE_TOOL_SETS.full.has("skill_get")).toBe(true);
  });

  it("skill_invoke zh description 明确语义(报告使用,不执行)", () => {
    const desc = resolveLlmDescription(stubTool("skill_invoke"), "zh");
    expect(desc).toMatch(/报告.*使用|不执行|记录.*结果/i);
  });

  it("skill_invoke en description 明确语义(report use, don't execute)", () => {
    const desc = resolveLlmDescription(stubTool("skill_invoke"), "en");
    expect(desc).toMatch(/report.*use|don't execute|only record/i);
  });
});
