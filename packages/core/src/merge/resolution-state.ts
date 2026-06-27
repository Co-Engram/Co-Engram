/**
 * resolutionState state-machine merge (spec §6.3).
 *
 * Contradicts synapse three-phase lifecycle:
 *   pending → auto_resolved / escalated → contested → resolved
 *
 * Merge rules:
 *   1. ours == theirs → use either
 *   2. one side absent → use the one present
 *   3. phases differ → higher phase wins (closer to resolution)
 *   4. phases equal → higher priority status wins
 *      priority = { resolved: 4, escalated: 3, auto_resolved: 2, contested: 2, pending: 1 }
 *   5. on override: append loser's rationale as evidence for the winner
 *
 * @module @co-engram/core/merge
 */

import type {
  SynapseResolutionState,
  SynapseResolutionStatus,
} from "../types/synapse.js";

export const RESOLUTION_STATUS_PRIORITY: Record<
  SynapseResolutionStatus,
  number
> = {
  pending: 1,
  auto_resolved: 2,
  contested: 2,
  escalated: 3,
  resolved: 4,
};

export type ResolutionMergeStrategy =
  | "all-absent"
  | "one-side-absent"
  | "same-status"
  | "higher-phase"
  | "higher-priority-status"
  | "tie-keep-ours";

export interface LoserRationale {
  readonly fromStatus: SynapseResolutionStatus;
  readonly fromPhase: 1 | 2 | 3;
  readonly rationale: string;
}

export interface ResolutionMergeResult {
  readonly merged: SynapseResolutionState | undefined;
  readonly strategy: ResolutionMergeStrategy;
  /** Loser's rationale, surfaced so caller can append it as evidence. */
  readonly loserRationale: LoserRationale | null;
}

/**
 * Merge three resolutionState values per spec §6.3 state machine.
 *
 * `base`, `ours`, `theirs` may all be undefined (synapse may not have one).
 */
export function mergeResolutionState(params: {
  base?: SynapseResolutionState;
  ours?: SynapseResolutionState;
  theirs?: SynapseResolutionState;
}): ResolutionMergeResult {
  const { base, ours, theirs } = params;

  if (!ours && !theirs) {
    return {
      merged: base,
      strategy: "all-absent",
      loserRationale: null,
    };
  }

  if (ours && !theirs) {
    return { merged: ours, strategy: "one-side-absent", loserRationale: null };
  }
  if (theirs && !ours) {
    return {
      merged: theirs,
      strategy: "one-side-absent",
      loserRationale: null,
    };
  }

  // Both sides present — guaranteed by guards above
  const oursState = ours as SynapseResolutionState;
  const theirsState = theirs as SynapseResolutionState;

  if (
    oursState.status === theirsState.status &&
    oursState.phase === theirsState.phase
  ) {
    return {
      merged: oursState,
      strategy: "same-status",
      loserRationale: null,
    };
  }

  // Phases differ → higher phase wins
  if (oursState.phase !== theirsState.phase) {
    const oursWins = oursState.phase > theirsState.phase;
    const winner = oursWins ? oursState : theirsState;
    const loser = oursWins ? theirsState : oursState;
    return {
      merged: winner,
      strategy: "higher-phase",
      loserRationale: extractLoserRationale(loser),
    };
  }

  // Same phase → higher priority status wins
  const oursPriority = RESOLUTION_STATUS_PRIORITY[oursState.status];
  const theirsPriority = RESOLUTION_STATUS_PRIORITY[theirsState.status];
  if (oursPriority !== theirsPriority) {
    const oursWins = oursPriority > theirsPriority;
    const winner = oursWins ? oursState : theirsState;
    const loser = oursWins ? theirsState : oursState;
    return {
      merged: winner,
      strategy: "higher-priority-status",
      loserRationale: extractLoserRationale(loser),
    };
  }

  // Same phase + same priority (e.g. both 'contested' phase 3) → tie.
  // Deterministically keep ours; caller may escalate if they detect the tie.
  return {
    merged: oursState,
    strategy: "tie-keep-ours",
    loserRationale: extractLoserRationale(theirsState),
  };
}

function extractLoserRationale(
  loser: SynapseResolutionState,
): LoserRationale | null {
  if (!loser.rationale || loser.rationale.trim() === "") return null;
  return {
    fromStatus: loser.status,
    fromPhase: loser.phase,
    rationale: loser.rationale,
  };
}
