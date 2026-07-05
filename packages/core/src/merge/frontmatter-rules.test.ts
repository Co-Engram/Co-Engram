import { describe, it, expect } from "vitest";
import {
  classifyField,
  mergeImmutableField,
  mergeAdditiveField,
  mergeMaxField,
  ImmutableViolationError,
} from "./frontmatter-rules.js";

describe("classifyField", () => {
  it("classifies immutable fields", () => {
    expect(classifyField("id")).toBe("immutable");
    expect(classifyField("createdAt")).toBe("immutable");
    expect(classifyField("createdBy")).toBe("immutable");
  });

  it("classifies additive numeric fields", () => {
    expect(classifyField("retrievalCount")).toBe("additive");
    expect(classifyField("effectiveRetrievals")).toBe("additive");
    expect(classifyField("failedUses")).toBe("additive");
    expect(classifyField("reinforcementScore")).toBe("additive");
    expect(classifyField("evidenceCount")).toBe("additive");
  });

  it("classifies max fields", () => {
    expect(classifyField("updatedAt")).toBe("max");
    expect(classifyField("lastRetrievedAt")).toBe("max");
    expect(classifyField("lastEffectiveAt")).toBe("max");
    expect(classifyField("version")).toBe("max");
  });

  it("classifies updatedAt_arbitrated fields", () => {
    expect(classifyField("title")).toBe("updatedAt_arbitrated");
    expect(classifyField("summary")).toBe("updatedAt_arbitrated");
    expect(classifyField("kind")).toBe("updatedAt_arbitrated");
    expect(classifyField("kinds")).toBe("updatedAt_arbitrated");
    expect(classifyField("importance")).toBe("updatedAt_arbitrated");
    expect(classifyField("confidence")).toBe("updatedAt_arbitrated");
    expect(classifyField("decayHalfLifeDays")).toBe("updatedAt_arbitrated");
    expect(classifyField("visibility")).toBe("updatedAt_arbitrated");
    expect(classifyField("status")).toBe("updatedAt_arbitrated");
    expect(classifyField("forcedFreshness")).toBe("updatedAt_arbitrated");
    expect(classifyField("verificationStatus")).toBe("updatedAt_arbitrated");
    expect(classifyField("encodingContext")).toBe("updatedAt_arbitrated");
    expect(classifyField("perspective")).toBe("updatedAt_arbitrated");
    expect(classifyField("domainTags")).toBe("updatedAt_arbitrated");
    expect(classifyField("contextTags")).toBe("updatedAt_arbitrated");
    expect(classifyField("tags")).toBe("updatedAt_arbitrated");
  });

  it("classifies recomputed fields", () => {
    expect(classifyField("contentHash")).toBe("recomputed");
    expect(classifyField("contentSize")).toBe("recomputed");
  });

  it("classifies legacy derived fields", () => {
    expect(classifyField("outgoingSynapseCount")).toBe("legacy_derived");
    expect(classifyField("incomingSynapseCount")).toBe("legacy_derived");
    expect(classifyField("activeContradictionCount")).toBe("legacy_derived");
  });

  it("classifies unknown fields as updatedAt_arbitrated (safe default)", () => {
    expect(classifyField("customField")).toBe("updatedAt_arbitrated");
  });
});

describe("mergeImmutableField", () => {
  it("returns base when both sides match base", () => {
    const result = mergeImmutableField({
      base: "01HXXX",
      ours: "01HXXX",
      theirs: "01HXXX",
      fieldName: "id",
    });
    expect(result).toEqual({ value: "01HXXX", changed: false });
  });

  it("throws ImmutableViolationError when ours changed id", () => {
    expect(() =>
      mergeImmutableField({
        base: "01HXXX",
        ours: "01HYYY",
        theirs: "01HXXX",
        fieldName: "id",
      }),
    ).toThrow(ImmutableViolationError);
  });

  it("throws ImmutableViolationError when theirs changed createdAt", () => {
    expect(() =>
      mergeImmutableField({
        base: "2026-01-01T00:00:00Z",
        ours: "2026-01-01T00:00:00Z",
        theirs: "2026-02-01T00:00:00Z",
        fieldName: "createdAt",
      }),
    ).toThrow(ImmutableViolationError);
  });
});

describe("mergeAdditiveField", () => {
  it("sums both deltas when both sides incremented", () => {
    const result = mergeAdditiveField({ base: 5, ours: 7, theirs: 6 });
    expect(result).toEqual({ value: 8, changed: true });
  });

  it("returns ours unchanged when theirs did not change", () => {
    const result = mergeAdditiveField({ base: 5, ours: 7, theirs: 5 });
    expect(result).toEqual({ value: 7, changed: true });
  });

  it("returns theirs when ours did not change", () => {
    const result = mergeAdditiveField({ base: 5, ours: 5, theirs: 9 });
    expect(result).toEqual({ value: 9, changed: true });
  });

  it("returns base when neither side changed", () => {
    const result = mergeAdditiveField({ base: 5, ours: 5, theirs: 5 });
    expect(result).toEqual({ value: 5, changed: false });
  });

  it("handles missing values by treating undefined as 0", () => {
    const result = mergeAdditiveField({
      base: undefined as unknown as number,
      ours: 3,
      theirs: 4,
    });
    expect(result).toEqual({ value: 7, changed: true });
  });
});

describe("mergeMaxField", () => {
  it("picks larger numeric value", () => {
    const result = mergeMaxField({ base: 1, ours: 5, theirs: 9 });
    expect(result).toEqual({ value: 9, changed: true });
  });

  it("picks later ISO timestamp", () => {
    const result = mergeMaxField({
      base: "2026-01-01T00:00:00Z",
      ours: "2026-06-01T00:00:00Z",
      theirs: "2026-03-01T00:00:00Z",
    });
    expect(result).toEqual({ value: "2026-06-01T00:00:00Z", changed: true });
  });

  it("returns unchanged when both sides equal base", () => {
    const result = mergeMaxField({ base: 5, ours: 5, theirs: 5 });
    expect(result).toEqual({ value: 5, changed: false });
  });
});
