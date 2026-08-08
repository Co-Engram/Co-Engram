/**
 * Synapse field classification and simple merge rules (spec §6.1).
 *
 * Field classes:
 *   - immutable            : id/from/to/kind/createdBy/createdAt — identity
 *   - updatedAt_arbitration: weight/direction/sourceSemantic/targetSemantic
 *   - max_updatedAt        : updatedAt itself
 *   - array_union          : evidence (handled in evidence-union.ts)
 *   - state_machine        : resolutionState (handled in resolution-state.ts)
 *   - passthrough          : unknown fields — keep base if unchanged, else ours
 *
 * @module @co-engram/core/merge
 */

export type SynapseFieldClass =
  | "immutable"
  | "updatedAt_arbitration"
  | "max_updatedAt"
  | "array_union"
  | "state_machine"
  | "passthrough";

const IMMUTABLE_SYNASPSE_FIELDS = new Set([
  "id",
  "from",
  "to",
  "kind",
  "createdBy",
  "createdAt",
]);

const UPDATED_AT_ARBITRATION_FIELDS = new Set([
  "weight",
  "direction",
  "sourceSemantic",
  "targetSemantic",
]);

export function classifySynapseField(fieldName: string): SynapseFieldClass {
  if (IMMUTABLE_SYNASPSE_FIELDS.has(fieldName)) return "immutable";
  if (UPDATED_AT_ARBITRATION_FIELDS.has(fieldName))
    return "updatedAt_arbitration";
  if (fieldName === "updatedAt") return "max_updatedAt";
  if (fieldName === "evidence") return "array_union";
  if (fieldName === "resolutionState") return "state_machine";
  return "passthrough";
}

/** Thrown when an immutable synapse field is divergently edited by both sides. */
export class ImmutableSynapseViolationError extends Error {
  readonly fieldName: string;
  readonly ours: unknown;
  readonly theirs: unknown;
  readonly base: unknown;

  constructor(params: {
    fieldName: string;
    base: unknown;
    ours: unknown;
    theirs: unknown;
  }) {
    super(
      `Immutable synapse field "${params.fieldName}" divergently edited: ours=${JSON.stringify(params.ours)} theirs=${JSON.stringify(params.theirs)} base=${JSON.stringify(params.base)}`,
    );
    this.name = "ImmutableSynapseViolationError";
    this.fieldName = params.fieldName;
    this.ours = params.ours;
    this.theirs = params.theirs;
    this.base = params.base;
  }
}

/**
 * Merge an immutable synapse field.
 *
 * - base == ours == theirs → base
 * - one side changed → that side's value
 * - both sides changed to the same value → that value
 * - both sides changed differently → throw ImmutableSynapseViolationError
 */
export function mergeSynapseImmutableField<T>(params: {
  base: T;
  ours: T;
  theirs: T;
  fieldName: string;
}): T {
  const { base, ours, theirs, fieldName } = params;
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  throw new ImmutableSynapseViolationError({
    fieldName,
    base,
    ours,
    theirs,
  });
}

/**
 * Merge a field whose value is chosen by updatedAt arbitration.
 *
 * Returns:
 *   - { value, winner } on clean arbitration (winner is 'ours' | 'theirs')
 *   - { value, winner: null } when neither side changed
 *   - { escalated: true } when updatedAt ties (caller should escalate)
 */
export function mergeSynapseUpdatedAtField<T>(params: {
  base: T;
  ours: T;
  theirs: T;
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
}): { value: T; winner: "ours" | "theirs" | null } | { escalated: true } {
  const { base, ours, theirs, oursUpdatedAt, theirsUpdatedAt } = params;
  if (ours === theirs) return { value: ours, winner: null };
  if (base === ours && base === theirs) return { value: base, winner: null };
  // Only one side changed → take it without arbitration
  if (base === ours) return { value: theirs, winner: "theirs" };
  if (base === theirs) return { value: ours, winner: "ours" };
  // Both sides changed differently → arbitrate by updatedAt
  if (oursUpdatedAt === theirsUpdatedAt) return { escalated: true };
  return oursUpdatedAt > theirsUpdatedAt
    ? { value: ours, winner: "ours" }
    : { value: theirs, winner: "theirs" };
}

/** max(ours, theirs) for ISO timestamps (lexicographic compare works for UTC). */
export function mergeSynapseMaxUpdatedAt(
  oursUpdatedAt: string,
  theirsUpdatedAt: string,
): string {
  return oursUpdatedAt >= theirsUpdatedAt ? oursUpdatedAt : theirsUpdatedAt;
}
