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
