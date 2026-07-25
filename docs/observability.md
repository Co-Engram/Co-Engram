# Observability

Co-Engram ships with a three-component observability stack. All three are optional but on by default (except proposal engine) — disable any of them via host config.

## Components

| Component              | Purpose                                                                                | Default | Cost                         |
| ---------------------- | -------------------------------------------------------------------------------------- | ------- | ---------------------------- |
| `AuditLog`             | Append-only event log (state changes + effectiveness signals)                          | **on**  | ~200 bytes/event             |
| `EffectivenessTracker` | Open/close windows around `retrieve_hit` to measure whether the engram actually helped | **on**  | Negligible                   |
| `ProposalEngine`       | Watch conversations passively, propose engrams when topics recur                       | **off** | Hash-based embedder (no LLM) |

## Audit Log

Records state mutations + necessary events. Stored as JSONL at `$DATA_ROOT/.co-engram/audit.jsonl`. To keep this file focused on "things that changed memory", high-frequency observation events are not written here (see [Effectiveness Tracker](#effectiveness-tracker) for where their data lives).

### Tracked actions

**State changes:** `create`, `update`, `update_lifecycle`, `reinforce`, `report_failure`, `forget`, `restore`, `sweep_to_trash`, `restore_from_trash`, `purge`, `propose`, `accept`, `dismiss`

**Necessity rejection:** `necessity_rejected` (Layer 2 evaluator rejects — kept for tuning the rule set)

**Conflict markers:** `contradicted` (consumed by `EffectivenessTracker.effectiveness()`)

**Git merge driver events:** `merge_resolved` (driver auto-resolved a conflict), `merge_backup_failed` (loser-side backup failed to persist), `merge_conflict_escalated` (driver left a marker and escalated to human), `merge_llm_arbitrated` / `merge_llm_arbitrated_escalated` / `merge_llm_arbitrated_failed` (Phase 3 LLM arbiter outcomes)

**Maintenance triggers:** `maintenance_run` — written only when the `rem` or `daily` stage of the [maintenance engine](./maintenance-engine.md) finishes (`actor=system`, `metadata` carries `stage` / `durationMs` / `errorCount` / optional `errorMessage`). Light/deep are too frequent and are intentionally not audited. Query via `engram_audit_query({ action: "maintenance_run" })` to answer "did REM/daily actually run?".

**No longer written** (kept in the `AuditAction` enum only to read old logs):

- `noise_filtered` (Layer 1 prefilter rejects — every conversation message could produce one)
- `retrieve_hit` / `retrieve_effective` / `retrieve_inconclusive` (effectiveness now derived from `observation-windows.jsonl`)

### Querying

```typescript
import { AuditLog } from "@co-engram/core";

const audit = new AuditLog("/path/to/data-root");

// Last 100 events
const recent = audit.query({ limit: 100 });

// All reinforce events for a specific engram
const reinforces = audit.query({
  engramId: "01J...A",
  action: "reinforce",
});

// Derive effectiveness report
const report = audit.effectiveness("01J...A");
// → { hits: 5, effective: 4, inconclusive: 1, contradicted: 0, effectiveRate: 0.8 }
```

`effectiveRate` formula: `effective / (effective + inconclusive + contradicted)`. Returns `null` if `hits < 3` (statistical noise floor).

### Querying via the `engram_audit_query` tool

LLM agents that need "what happened to this engram?" without opening the viewer or reading JSONL directly can call the **`engram_audit_query`** tool (in `standard` and `full` profiles). It exposes the same `AuditLog.query()` filters — `engramId`, `action`, `since`, `until`, `limit` — and returns chronological events. See [Tool Reference](./tool-reference.md) for the full signature.

### Log Rotation (automatic cleanup)

`audit.jsonl` self-rotates by default via an **independent background `setInterval`** (default 24h check), fully decoupled from the [maintenance engine](./maintenance-engine.md) light/deep/rem stages — log management and memory-data maintenance are different concerns.

Retention runs along two axes:

**1. Action-value tiered retention (time axis)**

| Tier            | Default retention | Actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High-value**  | 365 days          | `create`, `update`, `update_lifecycle`, `importance_update`, `forget`, `restore`, `sweep_to_trash`, `restore_from_trash`, `purge`, `accept`, `dismiss`, `contradicted`, `merge_resolved`, `merge_backup_failed`, `merge_conflict_escalated`, `merge_llm_arbitrated`, `merge_llm_arbitrated_escalated`, `merge_llm_arbitrated_failed`, `learning_loop_success`, `learning_loop_partial`, `learning_loop_failure`, `maintenance_run` |
| **Low-value** (default) | 90 days   | `propose`, `reinforce`, `report_failure`, `retrieve_hit`, `retrieve_effective`, `retrieve_inconclusive`, `noise_filtered`, `necessity_rejected`                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Rationale: high-value = state mutations + user decisions + cross-process coordination + learning-loop closures. These are the core purpose of an audit log (tracing "why was this engram deleted/merged/accepted/dismissed?"). Low-value = high-frequency but low forensic interest (every tool call, every search hit) — individually useless for retrospectives.

**2. File-size hard cap (space axis)**

Even when no time threshold has tripped, exceeding `maxSizeMb` (default 50MB) forces tail-truncation — walk from the file's tail accumulating bytes until the budget is exhausted, **keeping the newest tail entries** (in production, `audit.append()` always writes new entries at the end, so the newest is at the bottom). This is a hard guard for `readFileSync`, preventing unbounded growth from OOM-killing the Node process.

**Safety guarantees**:

- **Corrupt-line preservation**: lines that fail JSON parse or have unparseable `ts` are **not silently dropped** — kept verbatim for `engram_audit_query` / human review.
- **Fail-soft**: any IO/JSON exception returns `droppedCount: 0` and does not throw or block business logic.
- **No audit-on-audit**: the rotation action itself does not write an audit entry (would be self-reinforcing noise).
- **Atomic write**: `tmp-${pid}-${ts}` temp file + `rename` — no half-flushed corruption.

### Configuration

In `$DATA_ROOT/.co-engram/config.json`:

```json
{
  "audit": {
    "enabled": true,
    "rotation": {
      "enabled": true,
      "retentionDays": 90,
      "highValueRetentionDays": 365,
      "maxSizeMb": 50,
      "intervalMs": 86400000
    }
  }
}
```

Field meanings:

| Field                     | Default    | Description                                                                                          |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `audit.enabled`           | `true`     | Master switch. `false` disables both audit writes and rotation                                       |
| `audit.rotation.enabled`  | `true`     | Rotation master switch. `false` fully disables auto-cleanup (audit.jsonl grows unbounded; testing / ops only) |
| `retentionDays`           | `90`       | Low-value action retention (days)                                                                    |
| `highValueRetentionDays`  | `365`      | High-value action retention (days)                                                                   |
| `maxSizeMb`               | `50`       | File-size hard cap (MB)                                                                              |
| `intervalMs`              | `86400000` | Rotation check interval (ms, default 24h). `≤ 0` disables                                            |

Host adapter config: both `@co-engram/claude-code`'s `CoEngramMcpServerConfig.auditRotationConfig` and `@co-engram/openclaw`'s `CoEngramPluginConfig.auditRotationConfig` accept the same shape; when omitted, values resolve from persisted config or fall back to defaults.

## Effectiveness Tracker

When `engram_search` hits an engram, the wrapped tool calls `effectivenessTracker.openWindow(...)`. The window length depends on the engram's kind:

| Kind           | Window |
| -------------- | ------ |
| observation    | 6h     |
| fact (default) | 24h    |
| pattern        | 48h    |
| procedure      | 48h    |
| hypothesis     | 7d     |

If `engram_reinforce` fires before deadline → window closes as `closed_by_reinforce`. If deadline passes → maintenance light stage sweeps it as `closed_by_timeout`. If `engram_report_failure` fires → window closes as `closed_by_failure` (excluded from the effectiveness denominator).

Window records are the source of truth for effectiveness stats — `EffectivenessTracker.effectiveness(engramId)` reads `observation-windows.jsonl` directly:

- `hits` = total window records for that engram
- `effective` = `closed_by_reinforce` count
- `inconclusive` = `closed_by_timeout` count
- `contradicted` = read from `audit.jsonl` (no window representation)

`audit.jsonl` no longer records `retrieve_hit` / `retrieve_effective` / `retrieve_inconclusive` because window records already cover them — writing them to audit would duplicate per-search events and drown out the state changes worth auditing.

This gives the system a feedback signal: engrams with low `effectiveRate` over many hits are candidates for archive/forget.

## Score Field Format

All numeric scores returned by tools (importance, reinforcementScore, lastRetrievalScore, FTS score, effectiveness) are wrapped in a `ScoreField` to keep presentation consistent and host-agnostic:

```ts
interface ScoreField {
  readonly raw: number;                       // 2 decimals (rounded), JSON-safe
  readonly band: "high" | "medium" | "low";   // language-neutral tier
}
```

**Band thresholds** (see `formatScoreField` in [`concepts/dictionary.ts`](../packages/core/src/concepts/dictionary.ts)):

| Band    | Range          |
| ------- | -------------- |
| `high`  | `raw ≥ 0.70`   |
| `medium`| `0.30 ≤ raw < 0.70` |
| `low`   | `raw < 0.30`   |

**Why two fields instead of one float:**

- `raw` is rounded to 2 decimals to prevent floating-point noise from leaking to the UI (e.g., `0.018000000000000002` becomes `0.02`).
- `band` is a language-neutral enum so the core stays host-agnostic — the viewer or host adapter localizes it (`高/中/低` in Chinese, `high/medium/low` in English) via the i18n dictionary, not by the core.

**Where it shows up:** `engram_get`, `engram_search`, `engram_reinforce`, `engram_report_failure`, and the viewer's effectiveness report all return `ScoreField` for any user-facing numeric.

For ad-hoc string formatting inside core (e.g., embedding a score in an audit reason), `formatScore(score, lang)` returns `"high(0.84)"` / `"高(0.84)"` directly.

## Proposal Engine

Watches conversation messages via `proposalEngine.observe({ role, content })`. Hash-based embedder produces a 128-dim L2-normalized vector. Vectors are clustered via cosine similarity (default `DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35`, tuned for hash embedder). When a cluster reaches the occurrence threshold (default `3`), the engine runs **two-layer filtering** to decide whether to promote it to a proposal.

### Proposal Sources

Conversation clustering is one of several ingest paths. Each proposal carries a `source` field so the UI/LLM can tell them apart:

| Source               | Origin                                                                 | Payload                                                            |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `conversation`       | `observe()` clustering (the path described above)                       | None — only sample quotes; LLM fills `title`/`content` at accept   |
| `auto-memory`        | Claude Code auto-memory `.md` files detected under the data root        | Full payload (title/content/kind/domainTags) — accept as-is        |
| `external-markdown`  | Any other bare `.md` written under the data root (watcher-detected)     | Full payload + `sourcePath`; LLM/rule-based extraction (see below) |
| `rem-verification` / `rem-pattern` / `rem-synapse` | REM stage output (see [maintenance engine](./maintenance-engine.md)) | Targeted payload; accept lands the change (no auto-apply)          |

`auto-memory` and `external-markdown` proposals carry a pre-filled payload, so they can be accepted verbatim or in bulk via `engram_accept_proposals_by_source` (LLM does not need to fill `title`/`content`). `conversation` proposals only carry sample quotes, so the LLM must concretize them per-item via `engram_accept_proposal`.

**External-markdown extraction:** when the watcher sees a `.md` file under the data root without usable frontmatter (missing `title` / `kind`), it no longer silently ignores it. The host extracts `title` / `kind` / `domainTags` and writes a pending proposal — using the injected `LlmClient` when available, or a rule-based fallback (`H1` / filename → `title`, `kind = observation`, `domainTags = ["imported"]`) when the LLM is absent or fails. Dropping any `.md` into the data root therefore surfaces a proposal in the "Memory Proposals" tab instead of being dropped on the floor.

### Two-Layer Filtering

To prevent mechanical repetition from being incorrectly submitted as proposals, the proposal engine sets a filter layer at the `observe()` entry and another at `maybePromoteToProposal()`.

```
conversation → observe()
                 │
                 ▼
   ┌─────────────────────────────────┐
   │ Layer 1: rule prefilter (free)  │  prefilterMessage() pure fn
   │   system_role / empty           │
   │   too_short (user≥30,           │
   │              assistant≥15)      │  → silently dropped (no audit
   │   trivial_pattern (>60%)        │     — Layer 1 is high-frequency)
   │   only_punct                    │
   │   low_density (<4 tokens)       │
   │   conversational_artifact       │
   └────────┬────────────────────────┘
            │ accepted
            ▼
   cluster + threshold check (default threshold=3)
            │
            ▼
   ┌─────────────────────────────────┐
   │ Layer 2: necessity evaluation   │  NecessityEvaluator.evaluate()
   │                                  │
   │   RuleBasedNecessityEvaluator    │  ← default, 6 rules
   │     few_unique_samples /         │     (zero LLM cost)
   │     high_repetition /            │
   │     too_short /                  │
   │     low_density /                │
   │     trivial_dominated /          │
   │     conversational_artifact      │
   │          ↓ fallback              │
   │   LlmNecessityEvaluator          │  ← optional, semantic judgment
   │     Repeatable + Transferable    │     failure/parse error → rules
   │     + Technical depth            │     → audit: necessity_rejected
   └────────┬────────────────────────┘
            │ necessary=true
            ▼
        Generate Proposal
        (with necessityReason + suggestedTitle)
```

#### Layer 1: Rule Prefilter (`prefilterMessage`)

| Rule              | Trigger                               | Purpose                                  |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| `system_role`     | role === 'system'                     | system messages not observed (by design) |
| `empty`           | length 0 after trim                   | empty content                            |
| `too_short`       | user < 30 chars; assistant < 15 chars | short confirmations / greetings          |
| `trivial_pattern` | trivial word ratio > 60%              | catches `ok ok ok done done` repetition  |
| `only_punct`      | punctuation/symbols only              | test input                               |
| `low_density`     | meaningful tokens < 4                 | stopword-heavy filler                    |
| `conversational_artifact` | conversational bookkeeping signals hit (tense-dominated / deictic refs / process signature / enumerated options / self-meta) | in-conversation process output that recurs but has zero long-term value |

The trivial word set covers English + Chinese (`ok / hello / 测试 / 好的`, 30+ entries) and uses token ratio to catch repetitive trivial phrases.

#### Layer 2: Necessity Evaluator (`NecessityEvaluator`)

**`RuleBasedNecessityEvaluator` (default, zero dependencies)** — once a cluster reaches threshold, evaluates samples to decide if it's worth proposing. Rules checked in order; any hit rejects:

| Rule                 | Trigger                        | Meaning                        |
| -------------------- | ------------------------------ | ------------------------------ |
| `no_samples`         | empty samples                  | defensive                      |
| `few_unique_samples` | unique < 2 and occurrences > 1 | identical (auto-retry / paste) |
| `high_repetition`    | uniqueRatio < 0.5              | mechanical copy-paste          |
| `too_short`          | avg length < 30 chars          | samples too short              |
| `low_density`        | avg meaningful tokens < 5      | low information density        |
| `trivial_dominated`  | 70%+ samples hit trivial       | dominated by trivial content   |
| `conversational_artifact` | ≥50% samples hit conversational-artifact signals (defense-in-depth — Layer 1 already filters these per-message) | process output that slipped past Layer 1 |

All pass → `necessary=true`, reason looks like `Passed 6 rule checks: 4 unique samples, avg 100 chars, 27.8 tokens`.

**`LlmNecessityEvaluator` (optional, semantic)** — when host injects a `LlmClient`, the LLM judges "is this worth saving as a team memory" using these criteria:

- **Repeatable**: this topic will recur across future conversations (not a one-off task)
- **Transferable**: the resolution/preference would be useful to other team members or future sessions
- **Technical depth**: contains non-trivial decisions, configurations, lessons, or rationale

LLM returns JSON `{ necessary, reason, suggestedTitle }`. On failure (network / timeout / non-JSON) it falls back to `RuleBasedNecessityEvaluator`, with reason prefixed `[llm-unavailable, rule-fallback] ...` or `[llm-parse-failed, rule-fallback] ...` — proposal engine stays always-available.

### Provider-Agnostic LLM Abstraction

core defines only the `LlmClient` interface (`complete(prompt, opts) → string`); concrete provider adapters are implemented by hosts:

| Host            | Adapter                           | Config fallback                                                                  |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| openclaw-plugin | `createOpenAiCompatibleLlmClient` | OpenAI-compatible `/chat/completions`, falls back to `~/.openclaw/openclaw.json` |
| claude-code-mcp | `createAnthropicLlmClient`        | Anthropic Messages API, falls back to env `ANTHROPIC_API_KEY`                    |

Adapters handle reasoning models (`Qwen3` / `DeepSeek-R1` / `DeepSeek-V4` / `GLM-5.2` / Claude w/ thinking) by falling back to `reasoning_content` / `thinking` blocks when `content` is empty — prevents truncation when `max_tokens` is exhausted by reasoning phase. `max_tokens` is sized to 1500 to leave headroom for the reasoning phase before content is emitted.

### Lifecycle

1. **Observe** (host responsibility): host calls `observe()` for each message
2. **Layer 1 prefilter**: rejects mechanical noise (silently dropped — Layer 1 fires per message, audit can't keep up)
3. **Cluster**: incremental centroid update
4. **Layer 2 evaluate**: ≥ threshold → necessity evaluation → `audit: necessity_rejected` or proceed
5. **Promote**: check dedup → write proposal (with `necessityReason` + optional `suggestedTitle`)
6. **Prompt**: session start → host injects `[co-engram] N candidates pending`
7. **Triage**: LLM/user calls `engram_list_proposals` → `engram_accept_proposal` or `engram_dismiss_proposal`

### Files

- `topic-clusters.jsonl` — cluster state (centroid, occurrences, samples)
- `proposals.jsonl` — pending/accepted/dismissed proposals (includes `necessityReason` / `suggestedTitle` fields)
- `audit.jsonl` — every `propose` / `accept` / `dismiss` / `necessity_rejected` / state change lands here

All three are derived state. Deleting them is safe — already-recorded engrams are untouched, and the engine will simply re-observe from scratch.

## Viewer

A loopback-only HTTP server for browsing the data repo in a browser. On the MCP host it is disabled by default — enable via `CO_ENGRAM_VIEWER_ENABLED=1`. The OpenClaw plugin enables it by default (opt-out); set `startViewer: false` in the plugin config to turn it off.

Default port: `18899` (unified across both hosts since 2026-07). Optional bearer token via `CO_ENGRAM_VIEWER_TOKEN`.

See [host-claude-code.md](./host-claude-code.md) and [host-openclaw.md](./host-openclaw.md) for setup details.

### Endpoints

| Method | Path                           | Purpose                                                                                                                                                                                                          |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                            | SPA (htmx + Alpine.js)                                                                                                                                                                                           |
| GET    | `/api/stats`                   | Total counts, by-kind/by-status breakdown, top tags                                                                                                                                                              |
| GET    | `/api/engrams`                 | List with optional `?kind=` / `?tag=` filters                                                                                                                                                                    |
| GET    | `/api/engrams/:id`             | Full engram detail                                                                                                                                                                                               |
| PATCH  | `/api/engrams/:id`             | Update title/content/importance/etc.                                                                                                                                                                             |
| DELETE | `/api/engrams/:id`             | Delete engram                                                                                                                                                                                                    |
| GET    | `/api/search?q=`               | FTS search                                                                                                                                                                                                       |
| GET    | `/api/graph`                   | Nodes + edges for graph view. Edges carry full metadata: `id`, `weight`, `evidenceCount`, `direction`, optional `resolutionStatus`. Nodes carry optional `slug` for human-friendly display.                      |
| GET    | `/api/proposals`               | Pending/all proposals                                                                                                                                                                                            |
| POST   | `/api/proposals/purge-accepted` | Bulk-delete `status=accepted` proposal records from `proposals.jsonl` to reclaim space. The engrams created at accept time are **kept**. Returns `{ ok, purgedCount, purgedIds }` (each purge also writes a `dismiss` audit entry with `metadata.purged=true`). |
| POST   | `/api/proposals/purge-dismissed` | Bulk-delete `status=dismissed` proposal records from `proposals.jsonl`. Returns `{ ok, purgedCount, purgedIds }` (same audit trail as purge-accepted). |
| GET    | `/api/audit`                   | Audit log with filters                                                                                                                                                                                           |
| GET    | `/api/effectiveness?engramId=` | Effectiveness report for one engram                                                                                                                                                                              |
| GET    | `/api/trash`                   | Trashed engrams                                                                                                                                                                                                  |
| GET    | `/api/path-tree?maxDepth=`     | Directory tree for progressive disclosure. Returns `{ enabled, root: { path, engramCount, children } }`.                                                                                                         |
| GET    | `/api/doctor?incremental=&rescan=` | Self-healing scan report. By default returns the persisted `.co-engram/doctor-report.json` written by the [maintenance](./maintenance-engine.md) deep stage (so the health tab can show "what deep fixed" even after auto-fix). `rescan=1` ignores the cache and re-runs the scan live; `incremental=1` restricts a live re-run to mtime-delta only. Returns `{ enabled, cached?, report: { startedAt, finishedAt, totalEngrams, totalSynapses, fixes, pendingManualReview } }`. |
| GET    | `/api/maintenance-state`       | Maintenance run state for the viewer's maintenance tab. Returns `{ enabled, state, intervals: { light, deep, rem } }` — `state` is the persisted `maintenance-state.json` (last-run timestamps per stage), `intervals` are the default stage intervals so the UI can compute "is a stage overdue / how long until next fire". Missing/corrupt file → empty state ("never run"). |
| GET    | `/api/merge-stats?windowDays=` | Merge-driver stats for the viewer's Merges tab. Aggregates `merge_*` audit actions over a window (default 7 days, clamped 1–365). Returns `{ enabled, stats, windowDays }`. Equivalent CLI: `co-engram stats [--window-days N] [--json]`. |
| GET    | `/api/merge-anomalies?windowDays=` | Merge-driver anomaly alerts (KPI thresholds from spec §13). Returns `{ enabled, anomalies, windowDays }`. Equivalent CLI: `co-engram anomalies [--window-days N] [--json]` (exits non-zero on critical). |

All `/api/*` endpoints require `Authorization: Bearer <token>` if a token is configured.

### Security

The viewer binds to `127.0.0.1` only — not exposed to the network. If you run co-engram on a shared host, set `CO_ENGRAM_VIEWER_TOKEN` to prevent other local users from accessing it.
