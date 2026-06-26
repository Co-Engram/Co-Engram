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

## Proposal Engine

Watches conversation messages via `proposalEngine.observe({ role, content })`. Hash-based embedder produces a 128-dim L2-normalized vector. Vectors are clustered via cosine similarity (default `DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35`, tuned for hash embedder). When a cluster reaches the occurrence threshold (default `3`), the engine runs **two-layer filtering** to decide whether to promote it to a proposal.

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
   └────────┬────────────────────────┘
            │ accepted
            ▼
   cluster + threshold check (default threshold=3)
            │
            ▼
   ┌─────────────────────────────────┐
   │ Layer 2: necessity evaluation   │  NecessityEvaluator.evaluate()
   │                                  │
   │   RuleBasedNecessityEvaluator    │  ← default, 5 rules
   │     few_unique_samples /         │     (zero LLM cost)
   │     high_repetition /            │
   │     too_short /                  │
   │     low_density /                │
   │     trivial_dominated            │
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

All pass → `necessary=true`, reason looks like `Passed 5 rule checks: 4 unique samples, avg 100 chars, 27.8 tokens`.

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

A loopback-only HTTP server for browsing the data repo in a browser. Disabled by default — enable via `CO_ENGRAM_VIEWER_ENABLED=1` (MCP) or `startViewer: true` (OpenClaw plugin).

Default port: `18799`. Optional bearer token via `CO_ENGRAM_VIEWER_TOKEN`.

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
| GET    | `/api/audit`                   | Audit log with filters                                                                                                                                                                                           |
| GET    | `/api/effectiveness?engramId=` | Effectiveness report for one engram                                                                                                                                                                              |
| GET    | `/api/trash`                   | Trashed engrams                                                                                                                                                                                                  |
| GET    | `/api/path-tree?maxDepth=`     | Directory tree for progressive disclosure. Returns `{ enabled, root: { path, engramCount, children } }`.                                                                                                         |
| GET    | `/api/doctor?incremental=`     | Trigger a self-healing scan and return the report. `incremental=1` for mtime-delta scan only. Returns `{ enabled, report: { startedAt, finishedAt, totalEngrams, totalSynapses, fixes, pendingManualReview } }`. |

All `/api/*` endpoints require `Authorization: Bearer <token>` if a token is configured.

### Security

The viewer binds to `127.0.0.1` only — not exposed to the network. If you run co-engram on a shared host, set `CO_ENGRAM_VIEWER_TOKEN` to prevent other local users from accessing it.
