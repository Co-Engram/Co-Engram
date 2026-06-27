/**
 * Frontmatter 字段分类 + 单字段合并规则
 *
 * 字段语义分类见 spec §4.2。每种分类有独立的合并规则。
 * updatedAt_arbitrated 字段不在此处处理(由 arbitration.ts 接管)。
 *
 * @module @co-engram/core/merge
 */

export type FieldClass =
  | "immutable"
  | "additive"
  | "max"
  | "updatedAt_arbitrated"
  | "recomputed"
  | "legacy_derived";

const IMMUTABLE_FIELDS = new Set(["id", "createdAt", "createdBy"]);
const ADDITIVE_FIELDS = new Set([
  "retrievalCount",
  "effectiveRetrievals",
  "failedUses",
  "reinforcementScore",
  "evidenceCount",
]);
const MAX_FIELDS = new Set([
  "updatedAt",
  "lastRetrievedAt",
  "lastEffectiveAt",
  "version",
]);
const RECOMPUTED_FIELDS = new Set(["contentHash", "contentSize"]);
const LEGACY_DERIVED_FIELDS = new Set([
  "outgoingSynapseCount",
  "incomingSynapseCount",
  "activeContradictionCount",
]);

export function classifyField(fieldName: string): FieldClass {
  if (IMMUTABLE_FIELDS.has(fieldName)) return "immutable";
  if (ADDITIVE_FIELDS.has(fieldName)) return "additive";
  if (MAX_FIELDS.has(fieldName)) return "max";
  if (RECOMPUTED_FIELDS.has(fieldName)) return "recomputed";
  if (LEGACY_DERIVED_FIELDS.has(fieldName)) return "legacy_derived";
  return "updatedAt_arbitrated";
}

export interface SimpleMergeResult {
  readonly value: unknown;
  readonly changed: boolean;
}

export class ImmutableViolationError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly base: unknown,
    public readonly ours: unknown,
    public readonly theirs: unknown,
  ) {
    super(
      `Immutable field "${fieldName}" was modified (base=${JSON.stringify(base)}, ours=${JSON.stringify(ours)}, theirs=${JSON.stringify(theirs)})`,
    );
    this.name = "ImmutableViolationError";
  }
}

export function mergeImmutableField(params: {
  base: unknown;
  ours: unknown;
  theirs: unknown;
  fieldName: string;
}): SimpleMergeResult {
  const { base, ours, theirs, fieldName } = params;
  if (ours !== base || theirs !== base) {
    throw new ImmutableViolationError(fieldName, base, ours, theirs);
  }
  return { value: base, changed: false };
}

export function mergeAdditiveField(params: {
  base: number | undefined;
  ours: number | undefined;
  theirs: number | undefined;
}): SimpleMergeResult {
  const base = params.base ?? 0;
  const ours = params.ours ?? 0;
  const theirs = params.theirs ?? 0;
  const value = ours + theirs - base;
  const changed = ours !== base || theirs !== base;
  return { value, changed };
}

export function mergeMaxField(params: {
  base: number | string;
  ours: number | string;
  theirs: number | string;
}): SimpleMergeResult {
  const { base, ours, theirs } = params;
  const value = ours > theirs ? ours : theirs;
  const changed = value !== base;
  return { value, changed };
}
