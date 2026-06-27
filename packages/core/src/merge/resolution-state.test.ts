import { describe, it, expect } from "vitest";
import {
  mergeResolutionState,
  RESOLUTION_STATUS_PRIORITY,
} from "./resolution-state.js";
import type {
  SynapseResolutionState,
  SynapseResolutionStatus,
} from "../types/synapse.js";

function rs(
  status: SynapseResolutionStatus,
  phase: 1 | 2 | 3,
  extra: Partial<SynapseResolutionState> = {},
): SynapseResolutionState {
  return { status, phase, ...extra };
}

describe("RESOLUTION_STATUS_PRIORITY (spec §6.3)", () => {
  it("ranks resolved highest", () => {
    expect(RESOLUTION_STATUS_PRIORITY.resolved).toBe(4);
  });

  it("ranks escalated above auto_resolved/contested", () => {
    expect(RESOLUTION_STATUS_PRIORITY.escalated).toBeGreaterThan(
      RESOLUTION_STATUS_PRIORITY.auto_resolved,
    );
    expect(RESOLUTION_STATUS_PRIORITY.escalated).toBeGreaterThan(
      RESOLUTION_STATUS_PRIORITY.contested,
    );
  });

  it("ranks pending lowest", () => {
    expect(RESOLUTION_STATUS_PRIORITY.pending).toBe(1);
  });
});

describe("mergeResolutionState (spec §6.3)", () => {
  it("uses either side when both equal", () => {
    const a = rs("auto_resolved", 1, { verdict: "keep_new" });
    const result = mergeResolutionState({
      base: a,
      ours: a,
      theirs: a,
    });
    expect(result).toEqual({
      merged: a,
      strategy: "same-status",
      loserRationale: null,
    });
  });

  it("uses whichever side is present when one is absent", () => {
    const base = undefined;
    const ours = rs("auto_resolved", 1, { verdict: "keep_new" });
    const result = mergeResolutionState({
      base,
      ours,
      theirs: undefined,
    });
    expect(result.merged).toEqual(ours);
    expect(result.strategy).toBe("one-side-absent");
  });

  it("uses theirs when ours is absent", () => {
    const theirs = rs("escalated", 2, { escalatedTo: "alice" });
    const result = mergeResolutionState({
      base: undefined,
      ours: undefined,
      theirs,
    });
    expect(result.merged).toEqual(theirs);
  });

  it("prefers higher phase when phases differ", () => {
    const ours = rs("auto_resolved", 1);
    const theirs = rs("escalated", 2);
    const result = mergeResolutionState({
      base: rs("pending", 1),
      ours,
      theirs,
    });
    expect(result.merged).toEqual(theirs);
    expect(result.strategy).toBe("higher-phase");
  });

  it("prefers higher-priority status when phases tie", () => {
    const ours = rs("auto_resolved", 2);
    const theirs = rs("escalated", 2);
    const result = mergeResolutionState({
      base: rs("pending", 1),
      ours,
      theirs,
    });
    expect(result.merged).toEqual(theirs); // escalated > auto_resolved
    expect(result.strategy).toBe("higher-priority-status");
  });

  it("appends loser rationale as evidence when overriding", () => {
    const ours = rs("auto_resolved", 1, {
      verdict: "keep_new",
      rationale: "ours reason",
    });
    const theirs = rs("escalated", 2, {
      rationale: "their reason",
      escalatedTo: "bob",
    });
    const result = mergeResolutionState({
      base: rs("pending", 1),
      ours,
      theirs,
    });
    expect(result.merged.status).toBe("escalated");
    expect(result.loserRationale).not.toBeNull();
    expect(result.loserRationale?.rationale).toBe("ours reason");
    expect(result.loserRationale?.fromPhase).toBe(1);
    expect(result.loserRationale?.fromStatus).toBe("auto_resolved");
  });

  it("returns same-status when both sides converged on identical status+phase", () => {
    // Both sides independently reached 'contested' phase 3 — semantically
    // identical, no conflict to break.
    const ours = rs("contested", 3, { rationale: "ours contested" });
    const theirs = rs("contested", 3, { rationale: "theirs contested" });
    const result = mergeResolutionState({
      base: rs("pending", 1),
      ours,
      theirs,
    });
    expect(result.merged).toEqual(ours);
    expect(result.strategy).toBe("same-status");
  });

  it("tie-keep-ours when same priority but different status (both phase 3, contested vs auto_resolved)", () => {
    // contested priority=2, auto_resolved priority=2 — tie
    const ours = rs("contested", 3, { rationale: "ours contested" });
    const theirs = rs("auto_resolved", 3, { rationale: "theirs auto" });
    const result = mergeResolutionState({
      base: rs("pending", 1),
      ours,
      theirs,
    });
    expect(result.merged).toEqual(ours);
    expect(result.strategy).toBe("tie-keep-ours");
  });

  it("returns null merged when all sides absent", () => {
    const result = mergeResolutionState({
      base: undefined,
      ours: undefined,
      theirs: undefined,
    });
    expect(result.merged).toBeUndefined();
    expect(result.strategy).toBe("all-absent");
  });
});
