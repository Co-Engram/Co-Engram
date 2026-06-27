/**
 * Evidence union algorithm (spec §6.2).
 *
 * Evidence is append-only — both sides' additions should be preserved.
 *
 * Dedupe key: `${description}::${addedBy}`. When the same person adds the
 * same description multiple times, keep the entry with the latest addedAt.
 *
 * Contradictory evidence ("because X" vs "because not X") produces
 * DIFFERENT keys, so both are preserved — caller (LLM arbiter) decides.
 *
 * @module @co-engram/core/merge
 */

import type { SynapseEvidence } from "../types/synapse.js";

/**
 * Compute the dedupe key for an evidence entry.
 *
 * Spec §6.4 edge case: if addedBy is missing (legacy data), the key
 * degenerates to `${description}::` so we still dedupe by description alone.
 */
export function evidenceKey(e: SynapseEvidence): string {
  return `${e.description}::${e.addedBy ?? ""}`;
}

/**
 * Diff `next` against `prev` by evidence key, returning only entries
 * that are new (not present in prev, or present but with older addedAt).
 */
function diffByDescAndAuthor(
  next: readonly SynapseEvidence[],
  prev: readonly SynapseEvidence[],
): readonly SynapseEvidence[] {
  const prevMap = new Map<string, SynapseEvidence>();
  for (const e of prev) prevMap.set(evidenceKey(e), e);
  const added: SynapseEvidence[] = [];
  for (const e of next) {
    const existing = prevMap.get(evidenceKey(e));
    if (!existing) {
      added.push(e);
    } else if (
      (e.addedAt ?? "") > (existing.addedAt ?? "") &&
      // Don't emit if value is otherwise identical (avoid no-op writes)
      !evidenceEqual(e, existing)
    ) {
      added.push(e);
    }
  }
  return added;
}

function evidenceEqual(a: SynapseEvidence, b: SynapseEvidence): boolean {
  return (
    a.description === b.description &&
    a.addedBy === b.addedBy &&
    a.addedAt === b.addedAt &&
    a.source === b.source &&
    a.confidence === b.confidence
  );
}

/**
 * Merge three evidence arrays via spec §6.2 union algorithm:
 *
 *   1. Compute oursAdded = diffByDescAndAuthor(ours, base)
 *   2. Compute theirsAdded = diffByDescAndAuthor(theirs, base)
 *   3. all = [...base, ...oursAdded, ...theirsAdded]
 *   4. dedupe: same key → keep latest addedAt
 */
export function mergeEvidence(params: {
  base: readonly SynapseEvidence[];
  ours: readonly SynapseEvidence[];
  theirs: readonly SynapseEvidence[];
}): SynapseEvidence[] {
  const { base, ours, theirs } = params;
  const oursAdded = diffByDescAndAuthor(ours, base);
  const theirsAdded = diffByDescAndAuthor(theirs, base);
  const all = [...base, ...oursAdded, ...theirsAdded];

  const byKey = new Map<string, SynapseEvidence>();
  for (const e of all) {
    const key = evidenceKey(e);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
      continue;
    }
    // Same key → keep entry with newer addedAt (or first-seen if tie)
    if ((e.addedAt ?? "") > (existing.addedAt ?? "")) {
      byKey.set(key, e);
    }
  }
  // Sort for stable output: by addedAt ascending, then description, then key.
  // This decouples result order from input order (spec §6.4 — field-order
  // differences between serializers must not produce false conflicts).
  return Array.from(byKey.values()).sort((a, b) => {
    const byTime = (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
    if (byTime !== 0) return byTime;
    return evidenceKey(a).localeCompare(evidenceKey(b));
  });
}
