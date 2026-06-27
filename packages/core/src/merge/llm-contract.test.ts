import { describe, it, expect } from "vitest";
import { parseLlmMergeOutput, type LlmMergeInput } from "./llm-contract.js";
import {
  LLM_MERGE_SYSTEM_PROMPT,
  buildLlmMergeUserPrompt,
} from "./llm-prompt.js";

describe("parseLlmMergeOutput", () => {
  it("parses a well-formed verdict=ours output", () => {
    const raw = JSON.stringify({
      verdict: "ours",
      rationale: "ours has more recent edits",
      confidence: 0.9,
    });
    const result = parseLlmMergeOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.verdict).toBe("ours");
      expect(result.output.confidence).toBe(0.9);
      expect(result.output.rationale).toBe("ours has more recent edits");
      expect(result.output.mergedValue).toBeUndefined();
    }
  });

  it("parses verdict=merge with mergedValue", () => {
    const raw = JSON.stringify({
      verdict: "merge",
      mergedValue: ["a", "b", "c"],
      rationale: "union of both tag sets",
      confidence: 0.85,
    });
    const result = parseLlmMergeOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.verdict).toBe("merge");
      expect(result.output.mergedValue).toEqual(["a", "b", "c"]);
    }
  });

  it("strips ```json code fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        verdict: "theirs",
        rationale: "ok",
        confidence: 0.7,
      }) +
      "\n```";
    const result = parseLlmMergeOutput(raw);
    expect(result.ok).toBe(true);
  });

  it("strips bare ``` fences", () => {
    const raw =
      "```\n" +
      JSON.stringify({
        verdict: "escalate",
        rationale: "unclear",
        confidence: 0.3,
      }) +
      "\n```";
    const result = parseLlmMergeOutput(raw);
    expect(result.ok).toBe(true);
  });

  it("trims leading/trailing whitespace", () => {
    const raw =
      "\n\n  " +
      JSON.stringify({
        verdict: "ours",
        rationale: "ok",
        confidence: 1,
      }) +
      "  \n";
    const result = parseLlmMergeOutput(raw);
    expect(result.ok).toBe(true);
  });

  it("fails with empty_response for blank input", () => {
    const result = parseLlmMergeOutput("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_response");
  });

  it("fails with empty_response for whitespace-only input", () => {
    const result = parseLlmMergeOutput("   \n\n  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_response");
  });

  it("fails with invalid_json for malformed JSON", () => {
    const result = parseLlmMergeOutput("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  it("fails with invalid_json when LLM returns a non-object JSON value", () => {
    const result = parseLlmMergeOutput(JSON.stringify("just a string"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  it("fails with missing_verdict when verdict absent", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({ rationale: "ok", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_verdict");
  });

  it("fails with invalid_verdict for unknown verdict string", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "both",
        rationale: "ok",
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_verdict");
  });

  it("fails with invalid_confidence for missing field", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({ verdict: "ours", rationale: "ok" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_confidence");
  });

  it("fails with invalid_confidence for out-of-range value", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "ours",
        rationale: "ok",
        confidence: 1.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_confidence");
  });

  it("fails with invalid_confidence for NaN", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "ours",
        rationale: "ok",
        confidence: "high",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_confidence");
  });

  it("fails with missing_rationale when absent", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({ verdict: "ours", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_rationale");
  });

  it("fails with missing_rationale when empty after trim", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "ours",
        rationale: "   ",
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_rationale");
  });

  it("fails with missing_merged_value when verdict=merge but no mergedValue", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "merge",
        rationale: "synthesized",
        confidence: 0.8,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_merged_value");
  });

  it("accepts confidence=0 (boundary)", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "escalate",
        rationale: "no idea",
        confidence: 0,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts confidence=1 (boundary)", () => {
    const result = parseLlmMergeOutput(
      JSON.stringify({
        verdict: "ours",
        rationale: "certain",
        confidence: 1,
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("LLM prompt template", () => {
  const sampleInput: LlmMergeInput = {
    conflictType: "engram_frontmatter",
    path: "engrams/AIOS/decision.md",
    fieldName: "domainTags",
    base: ["AIOS"],
    ours: ["AIOS", "performance"],
    theirs: ["AIOS", "security"],
    meta: {
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
      oursUpdatedBy: "alice",
      theirsUpdatedBy: "bob",
    },
  };

  it("system prompt is a non-empty stable string", () => {
    expect(LLM_MERGE_SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain("verdict");
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain('"ours"');
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain('"theirs"');
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain('"merge"');
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain('"escalate"');
    expect(LLM_MERGE_SYSTEM_PROMPT).toContain("confidence");
  });

  it("user prompt includes conflictType, path, and field name", () => {
    const prompt = buildLlmMergeUserPrompt(sampleInput);
    expect(prompt).toContain("engram_frontmatter");
    expect(prompt).toContain("engrams/AIOS/decision.md");
    expect(prompt).toContain("domainTags");
  });

  it("user prompt includes serialized base/ours/theirs values", () => {
    const prompt = buildLlmMergeUserPrompt(sampleInput);
    expect(prompt).toContain('["AIOS"]');
    expect(prompt).toContain('["AIOS","performance"]');
    expect(prompt).toContain('["AIOS","security"]');
  });

  it("user prompt includes meta (updatedBy / updatedAt)", () => {
    const prompt = buildLlmMergeUserPrompt(sampleInput);
    expect(prompt).toContain("alice");
    expect(prompt).toContain("bob");
    expect(prompt).toContain("2026-06-01T00:00:00Z");
    expect(prompt).toContain("2026-06-02T00:00:00Z");
  });

  it("omits Field: line when fieldName absent", () => {
    const prompt = buildLlmMergeUserPrompt({
      ...sampleInput,
      fieldName: undefined,
    });
    expect(prompt).not.toContain("Field:");
  });

  it("handles string values without extra quoting", () => {
    const prompt = buildLlmMergeUserPrompt({
      ...sampleInput,
      base: "hello",
      ours: "world",
      theirs: "moon",
    });
    expect(prompt).toContain("BASE (common ancestor): hello\n");
    expect(prompt).toContain("OURS (alice at");
    expect(prompt).toContain(": world\n");
  });

  it("handles undefined values gracefully", () => {
    const prompt = buildLlmMergeUserPrompt({
      ...sampleInput,
      base: undefined,
    });
    expect(prompt).toContain("<undefined>");
  });

  it("ends with a clear instruction to return JSON", () => {
    const prompt = buildLlmMergeUserPrompt(sampleInput);
    expect(prompt).toMatch(/Decide and return JSON\.?\s*$/);
  });
});
