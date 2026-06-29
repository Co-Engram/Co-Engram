import { describe, it, expect } from "vitest";
import { resolveLlmDescription } from "../src/tools/llm-descriptions.js";
import { CONCEPT_DICTIONARY } from "../src/concepts/dictionary.js";
import type { Tool } from "../src/tools/tool.js";

const stubTool = (name: string): Tool => ({
  name,
  description: "",
  inputSchema: {} as never,
  execute: () => {
    throw new Error("stub");
  },
});

describe("tool descriptions reference CONCEPT_DICTIONARY", () => {
  it("placeholders are expanded — no literal {{concept:...}} in resolved output", () => {
    for (const lang of ["zh", "en"] as const) {
      const desc = resolveLlmDescription(stubTool("engram_get"), lang);
      expect(desc, `lang=${lang}`).not.toContain("{{concept:");
    }
  });

  it("engram_get agent description contains user-level engram explanation from dictionary", () => {
    const desc = resolveLlmDescription(stubTool("engram_get"), "zh");
    const dictionaryPhrase = CONCEPT_DICTIONARY.engram.userExplanation.zh;
    const signaturePhrase = dictionaryPhrase.slice(0, 10);
    expect(desc).toContain(signaturePhrase);
  });

  it("engram_get description rejects forbidden implementation terms", () => {
    const desc = resolveLlmDescription(stubTool("engram_get"), "zh");
    expect(desc).not.toContain("reinforcementScore");
    expect(desc).not.toContain("effectiveRetrievals");
    expect(desc).not.toContain("failedUses");
  });

  it("synapse_create description documents contradicts side effect (audit + resolution)", () => {
    const descZh = resolveLlmDescription(stubTool("synapse_create"), "zh");
    const descEn = resolveLlmDescription(stubTool("synapse_create"), "en");
    expect(descZh).toContain("contradicts");
    expect(descEn.toLowerCase()).toContain("contradicts");
  });
});

describe("runtime FORBIDDEN_TERMS check (Task 3.1)", () => {
  const forbiddenTool = (forbiddenText: string): Tool => ({
    name: "_test_forbidden",
    description: forbiddenText,
    inputSchema: {} as never,
    execute: () => {
      throw new Error("stub");
    },
  });

  it("throws on forbidden term in strict mode", () => {
    expect(() =>
      resolveLlmDescription(
        forbiddenTool("uses FTS internally"),
        "zh",
        undefined,
        { failMode: "strict" },
      ),
    ).toThrow(/forbidden term/);
  });

  it("warns but does not throw in warn mode", () => {
    const warns: string[] = [];
    const result = resolveLlmDescription(
      forbiddenTool("uses FTS internally"),
      "zh",
      undefined,
      { failMode: "warn", onWarn: (m) => warns.push(m) },
    );
    expect(result).toContain("[⚠ description violates]");
    expect(warns.length).toBeGreaterThan(0);
  });

  it("default failMode is warn (does not break existing callers)", () => {
    // No options passed — defaults to warn, so a forbidden description is flagged, not thrown
    const result = resolveLlmDescription(
      forbiddenTool("uses FTS internally"),
      "zh",
    );
    expect(result).toContain("[⚠ description violates]");
  });

  it("passes through clean descriptions unchanged (no flag marker)", () => {
    const desc = resolveLlmDescription(stubTool("engram_get"), "zh");
    expect(desc).not.toContain("[⚠ description violates]");
  });

  it("detects all FORBIDDEN_TERMS (FTS, LTP, Hebbian, RPE, etc.) in strict mode", () => {
    for (const term of ["FTS", "LTP", "Hebbian", "RPE"]) {
      expect(() =>
        resolveLlmDescription(
          forbiddenTool(`description with ${term}`),
          "zh",
          undefined,
          { failMode: "strict" },
        ),
      ).toThrow(/forbidden term/);
    }
  });

  it("truthScore is allowed in engram_get description (field name exception)", () => {
    // engram_get references truthScore as a field name; this is the documented exception
    const desc = resolveLlmDescription(stubTool("engram_get"), "zh");
    // Should not be flagged even if truthScore appears
    expect(desc).not.toContain("[⚠ description violates]");
  });
});

