import { describe, it, expect } from "vitest";
import { mergeEvidence, evidenceKey } from "./evidence-union.js";
import type { SynapseEvidence } from "../types/synapse.js";

function ev(
  description: string,
  addedBy: string,
  addedAt: string,
  extra: Partial<SynapseEvidence> = {},
): SynapseEvidence {
  return { description, addedBy, addedAt, ...extra };
}

describe("evidenceKey", () => {
  it("uses description::addedBy as the dedupe key", () => {
    expect(evidenceKey(ev("reason A", "alice", "2026-06-01"))).toBe(
      "reason A::alice",
    );
  });

  it("falls back to description-only when addedBy is missing (legacy data)", () => {
    const e = ev("reason A", "", "2026-06-01") as SynapseEvidence & {
      addedBy: string;
    };
    (e as { addedBy: string }).addedBy = "";
    expect(evidenceKey(e)).toBe("reason A::");
  });
});

describe("mergeEvidence (spec §6.2)", () => {
  it("returns base when neither side added evidence", () => {
    const base = [ev("base reason", "alice", "2026-06-01")];
    const result = mergeEvidence({ base, ours: base, theirs: base });
    expect(result).toEqual(base);
  });

  it("unions evidence added by ours and theirs without duplicates", () => {
    const base = [ev("base", "alice", "2026-06-01")];
    const ours = [
      ev("base", "alice", "2026-06-01"),
      ev("ours-added", "bob", "2026-06-02"),
    ];
    const theirs = [
      ev("base", "alice", "2026-06-01"),
      ev("theirs-added", "carol", "2026-06-03"),
    ];
    const result = mergeEvidence({ base, ours, theirs });
    expect(result).toHaveLength(3);
    const descriptions = result.map((e) => e.description).sort();
    expect(descriptions).toEqual(["base", "ours-added", "theirs-added"]);
  });

  it("dedupes by description+addedBy when both sides add identical evidence", () => {
    const base: SynapseEvidence[] = [];
    const duplicate = ev("shared reason", "alice", "2026-06-02");
    const ours = [duplicate];
    const theirs = [duplicate];
    const result = mergeEvidence({ base, ours, theirs });
    expect(result).toEqual([duplicate]);
  });

  it("keeps both contradictory evidence (same key different description)", () => {
    // Spec §6.2: contradictory evidence (A: "因为 X", B: "因为 not X") → both kept
    // Triggers LLM arbitration downstream.
    const base: SynapseEvidence[] = [];
    const ours = [ev("because X is true", "alice", "2026-06-02")];
    const theirs = [ev("because X is false", "bob", "2026-06-03")];
    const result = mergeEvidence({ base, ours, theirs });
    expect(result).toHaveLength(2);
  });

  it("keeps the latest addedAt when same person adds same description twice", () => {
    const base: SynapseEvidence[] = [];
    const ours = [ev("dup reason", "alice", "2026-06-01")];
    const theirs = [ev("dup reason", "alice", "2026-06-05")];
    const result = mergeEvidence({ base, ours, theirs });
    expect(result).toEqual([ev("dup reason", "alice", "2026-06-05")]);
  });

  it("preserves optional fields (source, confidence) from non-duplicate entries", () => {
    const base: SynapseEvidence[] = [];
    const ours = [
      ev("with-meta", "alice", "2026-06-01", {
        source: "experiment-1",
        confidence: 0.8,
      }),
    ];
    const theirs: SynapseEvidence[] = [];
    const result = mergeEvidence({ base, ours, theirs });
    expect(result[0]?.source).toBe("experiment-1");
    expect(result[0]?.confidence).toBe(0.8);
  });

  it("handles all sides empty", () => {
    expect(mergeEvidence({ base: [], ours: [], theirs: [] })).toEqual([]);
  });

  it("is order-stable across input shuffling", () => {
    const a = ev("a", "alice", "2026-06-01");
    const b = ev("b", "bob", "2026-06-02");
    const r1 = mergeEvidence({ base: [], ours: [a, b], theirs: [] });
    const r2 = mergeEvidence({ base: [], ours: [b, a], theirs: [] });
    expect(r1).toEqual(r2);
  });
});
