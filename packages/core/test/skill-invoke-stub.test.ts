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

describe("experimental stub visibility (Task 3.2)", () => {
  it("skill_invoke not in full profile (until P1 implemented)", () => {
    expect(PROFILE_TOOL_SETS.full.has("skill_invoke")).toBe(false);
  });

  it("skill_get remains in full profile (read-only, no stub)", () => {
    expect(PROFILE_TOOL_SETS.full.has("skill_get")).toBe(true);
  });

  it("skill_invoke zh description contains experimental warning", () => {
    const desc = resolveLlmDescription(stubTool("skill_invoke"), "zh");
    expect(desc).toMatch(/experimental|实验性|stub|占位/i);
  });

  it("skill_invoke en description contains experimental warning", () => {
    const desc = resolveLlmDescription(stubTool("skill_invoke"), "en");
    expect(desc).toMatch(/experimental|实验性|stub|占位/i);
  });
});
