import { describe, it, expect } from "vitest";
import {
  CONCEPT_DICTIONARY,
  getConcept,
  formatScore,
} from "../../src/concepts/dictionary.js";

describe("CONCEPT_DICTIONARY", () => {
  it("contains all required concepts", () => {
    const required = [
      "engram",
      "synapse",
      "ltp",
      "ltd",
      "hebbian",
      "verification_status",
      "observation_window",
      "importance",
    ] as const;
    for (const id of required) {
      expect(CONCEPT_DICTIONARY[id], `concept ${id} missing`).toBeDefined();
    }
  });

  it("each concept has zh + en + userExplanation in both languages", () => {
    for (const [id, entry] of Object.entries(CONCEPT_DICTIONARY)) {
      expect(entry.zh, `${id}.zh`).toBeTruthy();
      expect(entry.en, `${id}.en`).toBeTruthy();
      expect(entry.userExplanation.zh, `${id}.userExplanation.zh`).toBeTruthy();
      expect(entry.userExplanation.en, `${id}.userExplanation.en`).toBeTruthy();
    }
  });

  it("getConcept returns same entry as direct access", () => {
    expect(getConcept("engram")).toBe(CONCEPT_DICTIONARY.engram);
  });
});

describe("formatScore", () => {
  it("maps [0,1] to 高/中/低 band in zh", () => {
    expect(formatScore(0.95, "zh")).toContain("高");
    expect(formatScore(0.5, "zh")).toContain("中");
    expect(formatScore(0.1, "zh")).toContain("低");
  });

  it("maps [0,1] to high/medium/low band in en", () => {
    expect(formatScore(0.95, "en")).toContain("high");
    expect(formatScore(0.5, "en")).toContain("medium");
    expect(formatScore(0.1, "en")).toContain("low");
  });

  it("rejects raw float dump in user-facing output", () => {
    const out = formatScore(0.7719155626908514, "zh");
    expect(out).not.toMatch(/0\.77191/);
  });

  it("keeps 2-decimal raw value for transparency", () => {
    expect(formatScore(0.7719155626908514, "zh")).toMatch(/0\.77/);
    expect(formatScore(0.5, "en")).toMatch(/0\.50/);
  });
});
