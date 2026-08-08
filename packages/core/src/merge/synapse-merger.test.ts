import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { mergeSynapseFile, mergeSynapseFileAsync } from "./synapse-merger.js";
import { LlmArbiter } from "./llm-arbiter.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { computeSynapseId } from "../types/synapse-id.js";
import type { EngramId, Synapse, SynapseEvidence } from "../types/synapse.js";

const SYN_ID = computeSynapseId(
  "01HENG001" as EngramId,
  "01HENG002" as EngramId,
  "causes",
);
const SYN_CONTRA_ID = computeSynapseId(
  "01HENG001" as EngramId,
  "01HENG002" as EngramId,
  "contradicts",
);

function synapseRaw(
  id: string,
  updatedAt: string,
  overrides: Partial<Synapse> & { evidence?: SynapseEvidence[] } = {},
): string {
  const base: Synapse = {
    id: id as Synapse["id"],
    from: "01HENG001" as EngramId,
    to: "01HENG002" as EngramId,
    kind: "causes",
    weight: 0.5,
    direction: "directional",
    evidence: [],
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    ...overrides,
  };
  // Synapse files are pure YAML (no frontmatter delimiters).
  return stringify(base, { lineWidth: 0 });
}

describe("mergeSynapseFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synapse-merger-"));
    mkdirSync(join(dir, "synapses"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges weight by updatedAt arbitration", () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-02T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z", { weight: 0.9 });

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.weight).toBe(0.9); // theirs has newer updatedAt
  });

  it("unions evidence arrays (spec §6.2)", () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", {
      evidence: [
        { description: "base reason", addedBy: "alice", addedAt: "2026-06-01" },
      ],
    });
    const ours = synapseRaw(SYN_ID, "2026-06-02T00:00:00Z", {
      evidence: [
        { description: "base reason", addedBy: "alice", addedAt: "2026-06-01" },
        { description: "ours reason", addedBy: "bob", addedAt: "2026-06-02" },
      ],
    });
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z", {
      evidence: [
        { description: "base reason", addedBy: "alice", addedAt: "2026-06-01" },
        {
          description: "theirs reason",
          addedBy: "carol",
          addedAt: "2026-06-03",
        },
      ],
    });

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.evidence.map((e) => e.description).sort()).toEqual([
      "base reason",
      "ours reason",
      "theirs reason",
    ]);
  });

  it("sets updatedAt to max(ours, theirs)", () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z");
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z");
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z");

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.merged.updatedAt).toBe("2026-06-05T00:00:00Z");
  });

  it("escalates with markers when immutable field divergently edited", () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", {
      kind: "causes",
    });
    const ours = synapseRaw(SYN_ID, "2026-06-02T00:00:00Z", {
      kind: "depends_on",
    });
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z", {
      kind: "follows",
    });

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.escalated).toBe(true);
    expect(result.mergedContent).toContain("<<<<<<<");
  });

  it("escalates when updatedAt ties and both sides diverged on weight", () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.9 });

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.escalated).toBe(true);
  });

  it("merges resolutionState via state machine (higher phase wins)", () => {
    const base = synapseRaw(SYN_CONTRA_ID, "2026-06-01T00:00:00Z", {
      kind: "contradicts",
      resolutionState: { status: "pending", phase: 1 },
    });
    const ours = synapseRaw(SYN_CONTRA_ID, "2026-06-02T00:00:00Z", {
      kind: "contradicts",
      resolutionState: {
        status: "auto_resolved",
        phase: 1,
        verdict: "keep_new",
        rationale: "auto",
      },
    });
    const theirs = synapseRaw(SYN_CONTRA_ID, "2026-06-03T00:00:00Z", {
      kind: "contradicts",
      resolutionState: {
        status: "escalated",
        phase: 2,
        escalatedTo: "bob",
      },
    });

    const result = mergeSynapseFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.resolutionState?.status).toBe("escalated");
    expect(result.merged.resolutionState?.phase).toBe(2);
  });

  it("throws on unparseable base file", () => {
    const broken = "not: a: valid: yaml: :::";
    const valid = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z");
    expect(() =>
      mergeSynapseFile({ baseRaw: broken, oursRaw: valid, theirsRaw: valid }),
    ).toThrow();
  });
});

describe("mergeSynapseFileAsync (LLM Layer B)", () => {
  function makeLlmClientReturning(raw: string): LlmClient {
    return { complete: vi.fn().mockResolvedValue(raw) };
  }

  it("resolves updatedAt-tied weight conflict via LLM", async () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.9 });

    // LLM picks theirs (high confidence)
    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "theirs",
        rationale: "theirs has more support",
        confidence: 0.85,
      }),
    );
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.weight).toBe(0.9);
    expect(result.strategy).toContain("llm:");
  });

  it("resolves via LLM merge verdict with custom value", async () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.9 });

    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "merge",
        mergedValue: 0.8,
        rationale: "average",
        confidence: 0.9,
      }),
    );
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.weight).toBe(0.8);
  });

  it("preserves escalate when LLM confidence below threshold", async () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.9 });

    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "ours",
        rationale: "guess",
        confidence: 0.3,
      }),
    );
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(true);
  });

  it("does NOT invoke LLM for immutable field escalate (spec §6.4)", async () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", {
      kind: "causes" as const,
    });
    const ours = synapseRaw(SYN_ID, "2026-06-02T00:00:00Z", {
      kind: "depends_on" as const,
    });
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z", {
      kind: "follows" as const,
    });

    const client: LlmClient = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          verdict: "ours",
          rationale: "x",
          confidence: 0.95,
        }),
      ),
    };
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(true);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("preserves escalate when LLM call fails", async () => {
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-05T00:00:00Z", { weight: 0.9 });

    const client: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(true);
  });

  it("returns Layer A outcome when not escalated", async () => {
    // Clean merge: weight different updatedAt → no escalate
    const base = synapseRaw(SYN_ID, "2026-06-01T00:00:00Z", { weight: 0.5 });
    const ours = synapseRaw(SYN_ID, "2026-06-02T00:00:00Z", { weight: 0.7 });
    const theirs = synapseRaw(SYN_ID, "2026-06-03T00:00:00Z", { weight: 0.9 });

    const client = makeLlmClientReturning(
      JSON.stringify({
        verdict: "theirs",
        rationale: "x",
        confidence: 0.9,
      }),
    );
    const arbiter = new LlmArbiter({ client });

    const result = await mergeSynapseFileAsync({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      arbiter,
      path: "synapses/causes/syn-x.yaml",
    });
    expect(result.escalated).toBe(false);
    expect(result.merged.weight).toBe(0.9); // theirs has newer updatedAt
    expect(client.complete).not.toHaveBeenCalled();
  });
});
