# Tool Reference

Co-Engram exposes 29 native tools. All are accessible via MCP (`mcp__co-engram__<name>`) or the OpenClaw plugin API. Under `@co-engram/openclaw`, two additional wrappers (`memory_search`, `memory_get`) are registered for OpenClaw's memory plugin contract — they call into `engram_search` / `engram_get` internally.

This page lists every native tool with its required inputs. Optional fields are omitted for brevity — see the Zod schema in source for the full surface.

## Tool profiles

Tools are grouped into three profiles so LLM token cost scales with what you actually need. Set via `CO_ENGRAM_TOOLS_PROFILE` env var (Claude Code MCP) or plugin config (OpenClaw). The counts below are computed from source via `PROFILE_TOOL_COUNTS` and asserted by contract tests, so they cannot silently drift.

| Profile   | Count | Audience                                                                            |
| --------- | ----- | ----------------------------------------------------------------------------------- |
| `minimal` | 12    | Read/write core only — chat agents that just recall + record.                       |
| `standard`| 19    | Default. Adds repository health (`engram_doctor`, `engram_list_paths`, `engram_audit_query`) + proposals + verification. |
| `full`    | 29    | Everything, including contradiction arbitration, evolution lineage, and skill introspection. |

`skill_invoke` exists in source but is **experimental** — it is not in any profile by default because the skill body execution is a P0 stub. Use `skill_get` (read-only metadata) which is in `full`.

## Engrams

### `engram_create`

Create a new engram. With `dedupe: true` (default), duplicate content strengthens the existing engram instead of creating a new one.

**Required inputs:**

- `title: string` (1-200 chars)
- `content: string` (Markdown)
- `kind: "observation" | "fact" | "pattern" | "procedure" | "hypothesis"`
- `domainTags: string[]` (at least 1)

**Optional:**

- `createdBy: string` — if omitted, falls back to `ToolContext.defaultCreatedBy`. Resolution chain: explicit caller value → `CO_ENGRAM_DEFAULT_CREATED_BY` env (MCP) or plugin config `defaultCreatedBy` (OpenClaw) → persisted team-memory config → **local git identity (`user.name` → `user.email`)** → `'unknown'`.

**Returns:**

```ts
{
  id: string,                         // the effective engram id (newly created or the dedup target)
  verdict: "NEW" | "DUPLICATE" | "UPDATE",
  targetId?: string,                  // set when verdict is DUPLICATE / UPDATE (the existing engram)
  reason?: string,                    // why the dedup verdict was chosen
  confidence?: number,                // dedup confidence in [0, 1]
  candidatesConsidered?: number       // how many existing engrams were compared
}
```

### `engram_get`

Read an engram by ID. Supports tiered disclosure — return only what the caller can afford.

**Required inputs:**

- `id: string`

**Key optional:**

- `tier: "catalog" | "digest" | "content" | "meta" | "synapses" | "auto"` (default `digest`)
- `contextBudget: { totalTokens: number }` — when `tier=auto`, picks the deepest tier that fits

**Returns:** the engram at the requested tier

### `engram_update`

Update mutable fields of an engram (title / content / importance / etc.).

**Required inputs:**

- `id: string`
- `updatedBy: string`

**Key optional:** `title`, `content`, `summary`, `kinds`, `domainTags`, `importance`, `confidence`, `decayHalfLifeDays`, `visibility`

**Effect:** bumps `updatedAt`, increments engram version.

### `engram_delete`

Permanently delete an engram and all its synapses. Irreversible (but Git history preserves it).

**Required inputs:** `id: string`

### `engram_search`

Full-text search with optional filters.

**Required inputs:**

- `query: string`

**Key optional:**

- `filter: { domainTags, kinds, status, freshness, emotionalValence, createdBy, createdAfter, createdBefore, minImportance }`
- `limit: number` (default 20, max 100)

**Returns:**

```ts
{
  results: Array<{
    id: string
    score: number
    title: string
    kind: string
    domainTags: string[]
  }>,
  total: number
}
```

Each result is self-describing — callers do not need a follow-up `engram_get` to render or reason about hits. The full engram body and remaining metadata (summary, importance, etc.) are still only available via `engram_get`.

### `engram_list`

List engrams by metadata filter (no full-text query) with cursor pagination.

**Required:** `limit: number` (1-500)

**Optional:** same `filter` as `engram_search`, `cursor: string | null` (opaque pagination token returned as `nextCursor` from the previous page; pass it verbatim to fetch the next page)

**Returns:**

```ts
{
  items: Array<{ id: string, title: string, kind: EngramKind, domainTags: string[] }>,
  nextCursor: string | null  // null when no more results
}
```

Items are sorted by `importance DESC, updatedAt DESC, id ASC` for stable pagination. Pass the returned `nextCursor` to the next call's `cursor` parameter to continue.

### `engram_reinforce`

Report a successful use (LTP — long-term potentiation). Bumps `effectiveRetrievals`, updates `reinforcementScore` and `importance`. Neighbors connected via `extends`/`consolidates` get 50% of the boost.

**Required inputs:**

- `id: string`

**Optional:** `effectiveness: number [0, 1]` (default 1), `note: string`

### `engram_report_failure`

Report a failed use (LTD — long-term depression). Bumps `failedUses`, decrements `importance`. Triggers archive suggestion at 3 failures, forget suggestion at 5.

**Required inputs:**

- `id: string`
- `reason: string`

**Optional:** `context: string`

### `engram_archive`

Move an engram out of default retrieval but keep it recoverable. Excluded from search unless `filter.status` includes `archived`.

**Required inputs:** `id: string` | **Optional:** `reason: string`

### `engram_restore`

Reverse `archive` or `forget`. Returns the engram to active retrieval.

**Required inputs:** `id: string` | **Optional:** `reason: string`

### `engram_forget`

Active retrieval-induced forgetting (RIF). File preserved in Git but excluded from all default retrieval.

**Required inputs:**

- `id: string`
- `reason: string`

### `engram_recompute_importance`

Recalculate the multi-dimensional importance (personal/team/project/network/temporal). Network = synapse graph degree, temporal = Ebbinghaus decay. Writes the composite back to `engram.importance`.

**Required inputs:** `id: string`

**Optional:** `overrides: { personal, team, project }`, `persist: boolean` (default true), `updatedBy: string`

## Synapses

### `synapse_create`

Create a typed connection between two engrams. Updates both engrams' in/out caches.

**Required inputs:**

- `from: string` (engram ID)
- `to: string` (engram ID)
- `kind: SynapseKind` (see [concepts.md](./concepts.md))

**Optional:**

- `createdBy: string` — same fallback rules as `engram_create.createdBy`.
- `weight: number [0, 1]` (default 0.5)
- `direction: "directional" | "bidirectional"` (default `directional`)
- `evidence: Evidence[]`
- `sourceSemantic`, `targetSemantic` — optional semantic role labels on each endpoint, used by the retrieval orchestrator to weight traversals

### `synapse_get`

Read a single synapse.

**Required inputs:**

- `from: string`
- `synapseId: string`

### `synapse_list`

List all synapses for an engram.

**Required inputs:**

- `engramId: string`

**Optional:** `direction: "outgoing" | "incoming" | "both"` (default `both`)

### `synapse_delete`

Delete a synapse. Updates both engrams' caches.

**Required inputs:**

- `from: string`
- `synapseId: string`

## Skills

### `skill_get`

Read skill metadata.

**Required inputs:** `id: string`

### `skill_invoke` (experimental — not in any default profile)

Invoke a skill (procedural memory). The skill body is a template; the engine resolves template variables against `args` and returns the rendered steps.

> **⚠️ Experimental:** This tool's `execute` currently returns a `[P0 stub]` placeholder — the template resolution is not yet implemented. It is intentionally excluded from `minimal` / `standard` / `full` profiles to prevent the LLM from calling it and mistaking the stub string for a real result. To opt in for prototyping, build a custom profile that adds `skill_invoke` explicitly.

**Required inputs:**

- `id: string`

**Optional:** `args: Record<string, unknown>`

**Returns:**

```ts
{
  skillId: string,
  resolved: boolean,                  // were all template variables satisfied by args?
  steps?: Array<{ description: string }>,  // rendered steps (when resolved)
  missing?: string[]                 // unbound variable names (when not resolved)
}
```

## Learning Loop

### `close_learning_loop`

Close the dopamine learning loop — feed back the outcome of using an engram.

**Required inputs:**

- `engramId: string`
- `outcome: "success" | "failure" | "partial"`
- `reportedBy: string`

**Optional:** `effectiveness: number [0, 1]`, `reason: string`

**Effect:** success → LTP + Hebbian neighbor boost; failure → LTD + degradation threshold check.

**Returns:**

```ts
{
  engramId: string,
  outcome: "success" | "failure" | "partial",
  importance: number,                 // post-update composite importance
  importanceDelta: number,            // change applied this call
  hebbianTriggered: boolean,          // did the success branch fire neighbor LTP?
  provenanceTriggered: boolean,       // did the failure branch check provenance decay?
  shouldArchive: boolean,             // failure crossed the archive threshold
  shouldForget: boolean               // failure crossed the forget threshold
}
```

### `contradiction_resolve`

Manually arbitrate a `contradicts` synapse.

**Required inputs:**

- `fromId: string`
- `synapseId: string`
- `verdict: "keep_new" | "keep_old" | "merge" | "archive"`
- `rationale: string` (1-1000 chars)
- `resolvedBy: string`

### `upgrade_verification`

Upgrade (or downgrade to `refuted`) an engram's verification status.

**Required inputs:**

- `engramId: string`
- `newStatus: "unverified" | "plausible" | "probable" | "verified" | "refuted"`
- `evidenceDescription: string` (1-1000 chars)
- `verifiedBy: string`

**Optional:** `confidence: number [0, 1]`, `evidenceDomainTags: string[]`, `force: boolean` (skip state-machine guards)

### `get_evolution_lineage`

Trace the evolution DAG of an engram — ancestors (via `derives_from` / `consolidates` / `supersedes`) and descendants.

**Required inputs:** `engramId: string`

**Optional:** `direction: "ancestors" | "descendants" | "both"` (default `both`), `maxDepth: number` (default 10, max 20), `kinds: SynapseKind[]` filter

**Returns:** `{ nodes: Engram[], edges: Synapse[] }`

## Memory Proposals

The proposal engine observes conversations passively. When a topic is mentioned multiple times but no matching engram exists, it generates a _candidate proposal_ pending user/LLM decision.

This is the "prompted candidates" hybrid: not fully automatic (you stay in control), not fully manual (the engine surfaces patterns you'd otherwise miss).

### `engram_list_proposals`

List pending memory candidates (topics seen ≥ N times but not recorded) with cursor pagination.

**Required:** `limit: number` (1-500)

**Optional:** `includeAll: boolean` (default `false` — only pending proposals returned; set `true` to also include accepted/dismissed history), `cursor: string | null` (opaque pagination token)

**Returns:**

```ts
{
  items: Array<{ entityId: string, occurrences: number, sampleQuotes: string[],
                 centroidExcerpt: string, firstSeenAt: string, lastSeenAt: string,
                 createdAt: string, status: "pending" | "accepted" | "dismissed",
                 source: "conversation" | "auto-memory" | "external-markdown",
                 /* auto-memory source carries proposedTitle/proposedContent/etc */ }>,
  nextCursor: string | null  // null when no more results
}
```

Items are sorted by `createdAt DESC, entityId ASC` for stable pagination. Each proposal includes sample quotes, occurrence count, and first/last seen timestamps — enough context to decide accept vs dismiss without re-reading the original conversation.

### `engram_accept_proposal`

Convert a proposal into a real engram.

**Required inputs:**

- `entityId: string` (the proposal's cluster id, returned by `engram_list_proposals`)
- `title: string`
- `content: string` (Markdown)
- `domainTags: string[]`

**Optional:** `kind: EngramKind` (default `fact`), `createdBy: string` — if omitted, falls back to `ctx.defaultCreatedBy` (MCP env `CO_ENGRAM_DEFAULT_CREATED_BY` / OpenClaw plugin config / local git identity) → `'unknown'`. Same resolution chain as `engram_create`.

**Effect:** creates the engram, removes the cluster, appends `accept` to audit log.

### `engram_dismiss_proposal`

Reject a proposal temporarily (default 30 days, then it can re-appear if the topic resurfaces).

**Required inputs:** `entityId: string`

**Optional:** `reason: string`, `dismissDays: number` (default 30)

**Effect:** marks proposal `dismissed`, records reason for future meta-learning.

## Repository health (in `standard` profile)

These tools help an LLM (or a human) inspect the physical layout of the memory repo and self-heal common drift (moved files, renamed titles, orphan markdown). They use the `engram-index.json` cache for fast incremental scans, and are part of the `standard` tool profile — no need to switch to `full` to use them.

### `engram_audit_query`

Query the audit log (team-memory's event history, `audit.jsonl`) with cursor pagination. Surfaces the data that `AuditLog.query` already exposes internally so an agent or user can answer "what happened to this engram?" without opening the viewer or reading the file directly.

**Required:** `limit: number` (1-1000)

**Optional inputs:**

- `engramId: string` — filter to one engram's full history
- `action: AuditAction` — filter by event type (`create`, `update`, `update_lifecycle`, `reinforce`, `report_failure`, `forget`, `restore`, `sweep_to_trash`, `restore_from_trash`, `purge`, `propose`, `accept`, `dismiss`, `retrieve_hit`, `retrieve_effective`, `retrieve_inconclusive`, `contradicted`, `noise_filtered`, `necessity_rejected`, `merge_resolved`, `merge_backup_failed`, `merge_conflict_escalated`, `merge_llm_arbitrated`, `merge_llm_arbitrated_escalated`, `merge_llm_arbitrated_failed`)
- `since: string` (ISO 8601, inclusive), `until: string` (ISO 8601, exclusive)
- `cursor: string | null` — opaque pagination token (encodes the oldest entry's `ts` from the previous page; pass it verbatim to fetch strictly older events). Mutually exclusive with `until` (cursor wins).

**Returns:**

```ts
{
  items: Array<{
    ts: string,          // ISO 8601 timestamp
    actor: "user" | "system" | "llm-arbiter",
    action: AuditAction,
    engramId?: string,
    metadata: Record<string, unknown>
  }>,
  nextCursor: string | null  // null when no more results
}
```

Events are returned in chronological order (newest N within the filter, ascending within the page). Common use cases: "who reinforced this and when?", "why did this engram's importance jump?", "what was the verdict on the last merge conflict?"

### `engram_doctor`

Run a self-healing scan over the data root and report issues. Automatically fixes moved files (updates index), title changes (re-slugifies and renames), and missing files (cleans index entries). Reports dangling synapses and orphan markdown for manual review.

**Optional:** `incremental: boolean` (default `false` — full scan)

**Returns:**

```
{
  startedAt, finishedAt,
  totalEngrams, totalSynapses,
  autoFixesApplied, pendingManualReview,
  issues: [{ kind, stableId?, path?, message, autoFixed }]
}
```

`issues[].kind` is one of:

| kind               | autoFixed | meaning                                                                                                                                                                                                                                                       |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moved_file`       | ✅        | File path changed; index re-pointed.                                                                                                                                                                                                                          |
| `title_changed`    | ✅        | Title changed; file renamed via re-slugification.                                                                                                                                                                                                             |
| `missing_file`     | ✅        | Index entry pointed to a file that's gone; entry cleared.                                                                                                                                                                                                     |
| `slug_conflict`    | ⚠️        | New slug would collide with another file; kept old slug. Resolve manually.                                                                                                                                                                                    |
| `orphan_markdown`  | ⚠️        | Markdown file without frontmatter. Conventional repo docs (`README.md` / `LICENSE.md` / `CONTRIBUTING.md` / `CHANGELOG.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md`, case-insensitive) are exempt. For other files: delete or add frontmatter with a stable id. |
| `dangling_synapse` | ⚠️        | Synapse references an engram that no longer exists; clean up manually or restore the engram.                                                                                                                                                                  |
| `duplicate_id`     | ⚠️        | Two engram files share the same ULID. Manually assign a new ULID to one of them.                                                                                                                                                                              |
| `duplicate_engram` | ⚠️        | Two engrams have very similar titles/content; consider consolidating with a `consolidates` synapse.                                                                                                                                                           |

All `message` strings are English (international-friendly). The tool description seen by the LLM is bilingual via `LLM_TOOL_DESCRIPTIONS`.

### `engram_list_paths`

List the physical directory tree of the data root for progressive disclosure. Each node carries an `engramCount` (cumulative count for that subtree). Useful for an LLM to see where work is concentrated before deciding to search.

**Optional:** `maxDepth: number` (1-10, default 5)

**Returns:** `{ root: { path: '/', engramCount, children: [...] } }`

## Common Patterns

### Create + reinforce (happy path)

```
engram_create(...) → { id }
# ... use the engram in a real task ...
engram_reinforce({ id, effectiveness: 0.9 })
```

### Search → contradiction → resolve

```
engram_search({ query: "X" }) → [a, b]
# notice a and b contradict
synapse_create({ from: a.id, to: b.id, kind: "contradicts", ... })
contradiction_resolve({ fromId: a.id, synapseId: ..., verdict: "keep_new", ... })
```

### Verify a hypothesis

```
engram_create({ kind: "hypothesis", ... })
# ... gather evidence over time ...
upgrade_verification({ engramId, newStatus: "verified", evidenceDescription: "..." })
```

### Triage memory proposals

```
engram_list_proposals() → [{ entityId, occurrences, sampleQuotes, ... }, ...]
# review the samples
engram_accept_proposal({ entityId, title, content, domainTags, createdBy })
# or
engram_dismiss_proposal({ entityId, reason: "already covered by ..." })
```
