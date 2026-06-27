import { describe, it, expect } from "vitest";
import {
  classifySynapseField,
  mergeSynapseImmutableField,
  mergeSynapseUpdatedAtField,
  mergeSynapseMaxUpdatedAt,
  ImmutableSynapseViolationError,
  type SynapseFieldClass,
} from "./synapse-rules.js";

describe("classifySynapseField (spec §6.1)", () => {
  type Case = [string, SynapseFieldClass];
  const cases: Case[] = [
    ["id", "immutable"],
    ["from", "immutable"],
    ["to", "immutable"],
    ["kind", "immutable"],
    ["createdBy", "immutable"],
    ["createdAt", "immutable"],
    ["weight", "updatedAt_arbitration"],
    ["direction", "updatedAt_arbitration"],
    ["sourceSemantic", "updatedAt_arbitration"],
    ["targetSemantic", "updatedAt_arbitration"],
    ["updatedAt", "max_updatedAt"],
    ["evidence", "array_union"],
    ["retrievalWeight", "recomputed"],
    ["resolutionState", "state_machine"],
    ["unknownField", "passthrough"],
  ];

  for (const [field, expected] of cases) {
    it(`classifies ${field} as ${expected}`, () => {
      expect(classifySynapseField(field)).toBe(expected);
    });
  }
});

describe("mergeSynapseImmutableField", () => {
  it("returns base value when neither side changed", () => {
    expect(
      mergeSynapseImmutableField({
        base: "syn-001",
        ours: "syn-001",
        theirs: "syn-001",
        fieldName: "id",
      }),
    ).toBe("syn-001");
  });

  it("returns the changed value when only one side changed", () => {
    expect(
      mergeSynapseImmutableField({
        base: "syn-001",
        ours: "syn-002",
        theirs: "syn-001",
        fieldName: "id",
      }),
    ).toBe("syn-002");
  });

  it("throws ImmutableSynapseViolationError when both sides changed differently", () => {
    expect(() =>
      mergeSynapseImmutableField({
        base: "syn-001",
        ours: "syn-002",
        theirs: "syn-003",
        fieldName: "id",
      }),
    ).toThrow(ImmutableSynapseViolationError);
  });

  it("does not throw when both sides changed to the same value", () => {
    expect(
      mergeSynapseImmutableField({
        base: "syn-001",
        ours: "syn-002",
        theirs: "syn-002",
        fieldName: "id",
      }),
    ).toBe("syn-002");
  });
});

describe("mergeSynapseUpdatedAtField (spec §6.1 weight/direction)", () => {
  it("prefers the value from the side with newer updatedAt", () => {
    expect(
      mergeSynapseUpdatedAtField({
        base: 0.5,
        ours: 0.7,
        theirs: 0.9,
        oursUpdatedAt: "2026-06-01T00:00:00Z",
        theirsUpdatedAt: "2026-06-02T00:00:00Z",
      }),
    ).toEqual({ value: 0.9, winner: "theirs" });
  });

  it("returns escalate verdict when both sides diverged and updatedAt ties", () => {
    expect(
      mergeSynapseUpdatedAtField({
        base: "directional",
        ours: "bidirectional",
        theirs: "omnidirectional",
        oursUpdatedAt: "2026-06-01T00:00:00Z",
        theirsUpdatedAt: "2026-06-01T00:00:00Z",
      }),
    ).toEqual({ escalated: true });
  });

  it("takes ours when only ours changed (no arbitration needed)", () => {
    expect(
      mergeSynapseUpdatedAtField({
        base: "directional",
        ours: "bidirectional",
        theirs: "directional",
        oursUpdatedAt: "2026-06-01T00:00:00Z",
        theirsUpdatedAt: "2026-06-01T00:00:00Z",
      }),
    ).toEqual({ value: "bidirectional", winner: "ours" });
  });

  it("keeps base value when neither side changed", () => {
    expect(
      mergeSynapseUpdatedAtField({
        base: 0.5,
        ours: 0.5,
        theirs: 0.5,
        oursUpdatedAt: "2026-06-01T00:00:00Z",
        theirsUpdatedAt: "2026-06-02T00:00:00Z",
      }),
    ).toEqual({ value: 0.5, winner: null });
  });
});

describe("mergeSynapseMaxUpdatedAt", () => {
  it("returns max of ours/theirs updatedAt", () => {
    expect(
      mergeSynapseMaxUpdatedAt("2026-06-01T00:00:00Z", "2026-06-05T12:00:00Z"),
    ).toBe("2026-06-05T12:00:00Z");
  });

  it("handles equal timestamps", () => {
    expect(
      mergeSynapseMaxUpdatedAt("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z"),
    ).toBe("2026-06-01T00:00:00Z");
  });
});
