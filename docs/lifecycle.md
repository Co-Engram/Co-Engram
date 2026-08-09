# Entity Lifecycle

This page systematically walks through the full lifecycle of co-engram's three core entity types — **engram**, **synapse**, and **proposal** — from creation to destruction, and identifies which events trigger each transition under both the Claude Code and OpenClaw hosts.

> Recommended prereq: [Concepts](./concepts.md) and [Architecture](./architecture.md).

---

## 1. Big Picture

```
       User/LLM input                Tool calls
              │                       │
              ▼                       ▼
     ┌─────────────────┐     ┌──────────────────┐
     │  ProposalEngine │     │  MCP / plugin    │
     │  (passive)      │     │  tools (active)  │
     └────────┬────────┘     └────────┬─────────┘
              │                       │
              ▼                       ▼
        ┌──────────────────────────────────┐
        │     Engram                       │
        │   draft → active → frozen      │
        │                ↘ forgotten       │
        └──────────────┬───────────────────┘
                       │ synapse_create / auto
                       ▼
                ┌──────────────┐
                │   Synapse    │
                └──────────────┘
                       │
                       ▼  contradicts
              ┌──────────────────┐
              │ Arbitration flow │
              │ pending → ...    │
              │ → resolved       │
              └──────────────────┘

    Side-channel: ToolCallEvent → signal extraction → RPE → auto reinforce/decay
```

Relationship among the three:

- **engram** is knowledge itself (declarative memory)
- **synapse** is a typed connection between engrams (affects retrieval weighting)
- **proposal** is a not-yet-confirmed candidate engram, promoted to engram upon user approval

---

## 2. Engram Lifecycle

### 2.1 Status enum

`packages/core/src/types/engram.ts:42-46` defines four mutually exclusive states:

| Status      | Meaning                                                              | Default retrieval | File location        |
| ----------- | -------------------------------------------------------------------- | ----------------- | -------------------- |
| `draft`     | Created but not activated (reserved for future draft workflows)      | No                | Main dir             |
| `active`    | Default state, normal retrieval                                      | Yes               | Main dir             |
| `frozen`  | Excluded from default retrieval, fully recoverable                   | No                | Main dir             |
| `forgotten` | Removed from all default retrieval; moved to `.trash/` after 30 days | No                | Main dir → `.trash/` |

### 2.2 State transition diagram

```
        engram_create (new)
              │
              ▼
          ┌───────┐  engram_archive   ┌──────────┐
          │active │ ────────────────▶ │ frozen │
          └───┬───┘                   └────┬─────┘
              │                            │
              │ engram_forget              │ engram_restore
              ▼                            │
        ┌───────────┐                      │
        │ forgotten │ ◀────────────────────┘
        └─────┬─────┘
              │ 30-day trash sweep
              ▼
        ┌───────────┐  365 days later
        │  .trash/  │ ────────▶ physically purged
        └───────────┘
              │
              │ engram_restore (any time)
              ▼
          back to active
```

Transition tools (`packages/core/src/tools/engram-tools.ts`):

| Tool             | From → To                         | Notes                                                        |
| ---------------- | --------------------------------- | ------------------------------------------------------------ |
| `engram_create`  | (none) → `active`                 | New; if dedup hit, enters UPDATE/DUPLICATE branch (see §2.4) |
| `engram_archive` | `active`/`forgotten` → `frozen` | State change only, content untouched                         |
| `engram_forget`  | `active`/`frozen` → `forgotten` | Also marks freshness as `forgotten`                          |
| `engram_restore` | `frozen`/`forgotten` → `active` | If file is in `.trash/`, first physically moves it back      |
| `engram_delete`  | any → (purged)                    | Hard delete: content + metadata + linked synapses            |

### 2.3 Derived property `freshness`

`packages/core/src/lifecycle/freshness.ts` computes on the fly from `lastEffectiveAt`/`createdAt` + a halfLife derived from `importance` + `kind` (`halfLife = 50 × (importance+0.1)^1.5 × kindMultiplier`); not persisted:

| Time since lastEffectiveAt | freshness                              |
| -------------------------- | -------------------------------------- |
| ≤ 1 × halflife             | `fresh`                                |
| ≤ 2 ×                      | `aging`                                |
| ≤ 4 ×                      | `stale`                                |
| > 4 ×                      | `forgotten` (eligible for trash sweep) |

### 2.4 Create branches: NEW / UPDATE / DUPLICATE

`engram_create` is not a simple "create new" — it runs a dedup check first (`dedup/merge.ts`):

- **NEW**: no similar engram → create new `active` engram
- **UPDATE**: similar engram exists, user content is supplemental → merge into existing engram, `version++`
- **DUPLICATE**: similar engram exists, content equivalent → don't create new; instead `engram_reinforce` the existing one (avoids redundancy)

This branch turns duplicate capture requests into reinforcement signals rather than spawning redundant memory.

### 2.5 `verificationStatus` state machine

`packages/core/src/verification/state-machine.ts:25-105`, strictly linear:

```
unverified → plausible → probable → verified

any non-terminal ──refuted──▶ (terminal, no return)
```

Upgrade conditions (`verification/upgrade.ts:10-12`):

| Target      | Required                                                   |
| ----------- | ---------------------------------------------------------- |
| `plausible` | `evidenceCount ≥ 1`                                        |
| `probable`  | `evidenceCount ≥ 2`, from ≥2 distinct domains              |
| `verified`  | `evidenceCount ≥ 3`, ≥2 domains, `ageDays ≥ stabilityDays` |

A successful upgrade also bumps `confidence` by +0.2 (capped at 0.95) via `applyConfidenceSignal(..., "verify")`; a refutation crashes it to ×0.3 (`upgrade.ts:416-421`).

Only one downgrade path exists: the REM-stage metacognition scan (`verification/metacognition.ts`) computes a truth score and, when `overall confidence < 0.30` and a `contradicts` synapse exists, **recommends** refutation. Refutation is no longer auto-applied — the maintenance engine emits a `rem-verification` proposal, and the status only changes once the user accepts it in the Proposals tab.

### 2.6 Auto-decay triggers

Three automatic paths push engrams toward `frozen`/`forgotten`:

1. **LTD thresholds** (`reinforcement/ltd.ts:96-97`): `failedUses ≥ 3 → shouldArchive`, `≥ 5 → shouldForget`. These are advisory flags returned to the caller, not auto-executed.
2. **Deep-stage decay** (`dreaming/decay.ts:55,90`): deep-sleep stage enforces `importance < forgetThreshold` check.
3. **Trash sweep** (`dreaming/trash.ts:131-190`): forgotten engrams whose file mtime is ≥30 days old are moved to `.trash/YYYY-MM/`; physically purged after 365 days.

---

## 3. Synapse Lifecycle

### 3.1 The 12 kinds (5 families)

`packages/core/src/types/synapse.ts:16-33`:

| Family         | Kind             | Semantics                               |
| -------------- | ---------------- | --------------------------------------- |
| **Structural** | `extends`        | A builds on B                           |
|                | `part_of`        | A is a component of B                   |
|                | `similar_to`     | A is semantically close to B            |
| **Causal**     | `depends_on`     | A requires B                            |
|                | `causes`         | A triggers or produces B                |
|                | `follows`        | A follows B temporally/logically        |
| **Evidential** | `derives_from`   | A is derived from B                     |
|                | `contradicts`    | A conflicts with B (enters arbitration) |
|                | `exemplifies`    | A is an instance of B                   |
| **Temporal**   | `supersedes`     | A replaces the older B                  |
|                | `consolidates`   | A merges/refines B's content            |
| **Modulatory** | `contextualizes` | A provides context for B                |

### 3.2 Retrieval-weighting side effects

When engram A is retrieved, its neighbors get Hebbian-style weighting (implemented in `engram_reinforce`, `tools/engram-tools.ts:604`):

- `extends` / `consolidates` neighbors: **positive boost** (extensions are reinforced together)
- `contradicts` neighbors: **suppressed** (avoids surfacing conflicting conclusions simultaneously)

### 3.3 Contradiction arbitration flow (`contradicts` only)

`packages/core/src/contradiction/` implements a 4-phase arbitration:

```
   synapse_create(kind='contradicts')
              │
              ▼
        ┌─────────┐
        │ pending │ ── LLM arbiter ──┐
        └─────────┘                   │
              │                       │
       ┌──────┴──────┐                │
       │             │                │
       ▼             ▼                ▼
┌────────────┐  ┌──────────┐    ┌──────────────┐
│auto_resolved│ │escalated │ ─7d▶│  contested  │
└────────────┘  └────┬─────┘    └──────┬───────┘
                     │ manualResolve    │
                     │ (contradiction_resolve) │
                     ▼                   ▼
                ┌──────────┐       ┌──────────┐
                │ resolved │ ◀─────│ resolved │
                └──────────┘       └──────────┘
```

Verdicts (`auto-degrade.ts:60-67`):

| verdict    | Side effect                                     |
| ---------- | ----------------------------------------------- |
| `keep_new` | Old engram marked `refuted` + loser `confidence ×0.3`  |
| `keep_old` | New engram marked `refuted` + loser `confidence ×0.3`  |
| `merge`    | Content merged into the keeper; synapse deleted |
| `archive`  | Newer side marked `frozen`                    |

**Special side effects**: creating a `contradicts` synapse also (`synapse-tools.ts:82-94`):

- Writes two `contradicted` audit log entries
- Triggers a `-0.8` behavioral signal (LTD pressure on the related engrams)

### 3.4 Create / delete tools

| Tool                           | Effect                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `synapse_create`               | Manual create; `contradicts` enters arbitration                                |
| `synapse_delete`               | Delete the synapse (does NOT undo side effects — refuted engrams stay refuted) |
| `synapse_get` / `synapse_list` | Read-only                                                                      |
| `contradiction_resolve`        | Manual end of phase-2 arbitration                                              |

> **Note**: All synapses are currently created via explicit `synapse_create`. The maintenance engine's dreaming (abstraction) stage produces _new engrams_ but does not auto-connect existing ones.

---

## 4. Proposal Pipeline

### 4.1 Trigger sources

| Host            | Trigger point                                                                        | Implementation                                        |
| --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Claude Code** | `UserPromptSubmit` / `Stop` hooks invoke `observe.py`, which POSTs to `/api/observe` | `claude-code-mcp/src/hooks/installer.ts:6,70,119-139` |
| **OpenClaw**    | Plugin subscribes directly to `llm_input` / `llm_output` events                      | `openclaw-plugin/src/plugin-entry.ts:284-303`         |

Both ultimately call `proposalEngine.observe({role, message})` (role is `user` or `assistant`).

### 4.2 Three-stage pipeline

`packages/core/src/observability/proposal-engine.ts`:

```
1. observe(message)
   ├── Filter system messages and short ones (<20 chars)
   ├── Embed via DEFAULT_HASHER_EMBEDDER (256-dim hash + CJK bigram tokenizer)
   └── findBestMatch: cosine ≥ DEFAULT_HASHER_SIMILARITY_THRESHOLD (0.35) = same topic

2. Cluster phase
   ├── Hit existing cluster → join and update centroid
   └── Else → newCluster

3. maybePromoteToProposal (when occurrences ≥ threshold, default 3)
   ├── hasSimilarEngram: keyword substring match; ≥2 hits = skip (avoid dupes)
   └── Generate proposal; persist to .co-engram/proposals.jsonl
```

**Why hash embedder needs a lower threshold (0.35 vs 0.75 for LLM embeddings):**
The default hasher uses 256-dim feature hashing with character bigrams for CJK
runs. Realistic cosine values for natural-language paraphrases are 0.15-0.40
(because hash embedder captures lexical, not semantic, similarity). The LLM
embedding threshold of 0.75 is unreachable for the hasher — proposals would
never form. `DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35` was chosen to accept
paraphrases of the same technical topic while rejecting off-topic overlap
(which typically scores 0.0-0.10).

**Why CJK text needs bigram tokenization:**
`normalize()` splits on whitespace, but Chinese has no inter-word spaces —
`"我们以后所有"` would be one giant token. Even worse, that one-token hash
collides with other random Chinese text, producing near-zero cosine similarity
for any pair of Chinese sentences. The fix: detect CJK character runs in
`tokenizeForEmbedding()` and emit character bigrams (`我们`, `们以`, `以后`,
…). This is the standard zero-cost technique for Chinese text search without
a word segmenter.

### 4.3 Proposal states

`pending | accepted | dismissed` (proposal-engine.ts:68):

| State       | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `pending`   | Awaiting approval                                                   |
| `accepted`  | Promoted to engram via `engram_accept_proposal`                     |
| `dismissed` | Rejected; **permanently** silenced by default (not re-promoted). Set `dismissDays > 0` for time-limited suppression that re-activates after N days. |

### 4.4 Accept / Dismiss

| Tool                      | Behavior                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `engram_accept_proposal`  | Calls `repository.createEngram` to create an `active` engram; `kind` is caller-specified (default `fact`); the originating cluster is removed |
| `engram_dismiss_proposal` | **Permanent dismiss** by default (`dismissedUntil` unset); pass `dismissDays > 0` for an N-day cooldown that re-activates after expiry         |

### 4.5 Kind inference

Proposals themselves have no `kind`. When promoted, the approver (user or LLM) passes it explicitly. The viewer's drawer editor offers a dropdown; if omitted, defaults to `fact`.

### 4.6 External-markdown proposals

Besides the conversation cluster pipeline (§4.1–4.2), any bare `.md` file written under `dataRoot` is picked up by the watcher and turned into a pending proposal. The extractor runs in two tiers: when an LLM client is available it extracts `title` / `kind` / `domainTags` / `summary` intelligently; otherwise it falls back to a rule-based pass (H1 or filename → `title`, `kind = observation`, `domainTags = ["imported"]`). So dropping any `.md` into `dataRoot` now surfaces a proposal in the Proposals tab instead of being silently ignored. These carry `source: "external-markdown"` and can be accepted in bulk via `engram_accept_proposals_by_source`.

Already-valid engrams that are tracked by the team git repo — e.g. pulled in via `engram_sync` or a plain `git pull` — **skip the proposal queue entirely** and are indexed directly during the scan. The post-merge hook is the primary index-sync path, but this acts as a defense-in-depth fallback when it isn't installed. Only genuinely untracked files (bare markdown, files dropped in from outside the repo) become proposals, preserving the anti-poisoning review gate.

---

## 5. Signals, RPE, and the Maintenance Engine

### 5.1 Behavioral signal extraction

`packages/core/src/signals/extract.ts:365`, six rules producing weights in `[-1, 1]`:

| Rule                        | Weight   | Trigger                                                              |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| `contradicts_created`       | **-0.8** | A new `contradicts` synapse targets this engram                      |
| `get_then_immediate_search` | **-0.7** | Retrieval is immediately followed by another retrieval (wrong match) |
| `get_then_action`           | **+0.8** | Retrieval followed by file edit / bash / commit                      |
| `repeated_get`              | **+0.6** | Same engram retrieved ≥2 times within a window                       |
| `user_correction`           | **-0.4** | User message contains correction words ("no", "wrong", "actually")   |
| `get_no_resimilar_search`   | **+0.4** | Retrieval not followed by a similar search (good enough)             |

### 5.2 RPE reinforcement learning

`packages/core/src/signals/rpe.ts:44-90`, neuroscience-style RPE (Reward Prediction Error):

```
actual    = (signalSum + 1) / 2     # normalized to [0, 1]
expected  = lastRetrievalScore ?? 0.5
rpe       = actual - expected
```

Application rules:

- `|rpe| ≤ 0.05`: dead zone, no action
- `rpe > 0.05` (exceeded expectation): `effectiveRetrievals++`, `reinforcementScore += rpe × 0.1`
- `rpe < -0.05` (below expectation): `failedUses++`

### 5.3 Three maintenance stages

`packages/core/src/maintenance/engine.ts`:

| Stage     | Default frequency | Main actions                                                                                                    |
| --------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Light** | 5 min             | Extract signals → compute RPE → update engram `reinforcementScore`/`failedUses` → refresh `prompt-signals.json` |
| **Deep**  | 1 hr              | Trigger dreaming (deep): decay check + abstraction of new engrams                                               |
| **REM**   | 1 day             | Trigger dreaming (rem): metacognition scan emits `rem-verification` / `rem-pattern` proposals (user accepts to land) |

Stage timing and thresholds can be overridden via env vars or config.

---

## 6. Tool → Lifecycle Mapping (standard profile subset)

> For full signatures see [Tool Reference](./tool-reference.md).

| Tool                      | Entity affected | Lifecycle effect                                                                                |
| ------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `engram_search`           | engram          | bumpRetrievalStats + opens effectiveness window                                                 |
| `engram_get`              | —               | Read-only (adaptive disclosure tier)                                                            |
| `engram_list`             | —               | Read-only                                                                                       |
| `engram_list_paths`       | —               | Read-only directory tree                                                                        |
| `engram_create`           | engram          | NEW → `active` / DUPLICATE → reinforce / UPDATE → merge                                         |
| `engram_update`           | engram          | Field mutation, `version++`                                                                     |
| `engram_reinforce`        | engram          | LTP: `effectiveRetrievals++`, `importance += eff × 0.02` (×`min(1, confidence×2)`, so confidence<0.5 is suppressed), Hebbian neighbor boost |
| `engram_report_failure`   | engram          | LTD: `failedUses++`, `importance -= 0.03` (×`1+max(0,(0.5-confidence)×2)`, so confidence<0.5 decays faster; ×1.5 when escalated); returns `shouldArchive/Forget` |
| `engram_delete`           | engram          | Hard delete (content + meta + linked synapses)                                                  |
| `synapse_create`          | synapse         | Create edge; `contradicts` triggers arbitration + audit + negative signal                       |
| `close_learning_loop`     | engram          | success → LTP + Hebbian; failure → LTD; partial → scaled LTP                                    |
| `contradiction_resolve`   | synapse         | Manual end of phase-2 → `resolved`                                                              |
| `engram_list_proposals`   | —               | Read pending proposals                                                                          |
| `engram_accept_proposal`  | engram          | proposal → `active` engram                                                                      |
| `engram_dismiss_proposal` | proposal        | **Permanent dismiss** by default (dismissedUntil unset); `dismissDays > 0` enables N-day cooldown |
| `engram_doctor`           | (index)         | Self-heal: slug/index/move fixes                                                                |

**Full-profile-only mutators**: `engram_archive`, `engram_restore`, `engram_forget`, `synapse_get/list/delete`, `skill_*`, `upgrade_verification`, `get_evolution_lineage`. These are typically triggered by the maintenance engine or CLI, not exposed to the everyday LLM.

---

## 7. Host Integration Differences

### 7.1 Claude Code (MCP server)

```
┌──────────────┐  UserPromptSubmit    ┌─────────────┐
│ Claude Code  │ ──────────────────▶  │ observe.py  │
│              │  Stop                │ (hooks)     │
└──────────────┘ ──────────────────▶  └──────┬──────┘
                       ▼                     │
                  settings.json              │ POST /api/observe
                  (auto-injected)            ▼
                                          ┌──────────────────────┐
                                          │ viewer /api/observe  │
                                          └──────────┬───────────┘
                                                     │
                                                     ▼
                                          ┌──────────────────┐
                                          │ proposalEngine   │
                                          │   .observe()     │
                                          └──────────────────┘
```

- **Auto-enable**: when the proposal engine is on, the viewer starts automatically (`mcp-server.ts:431`)
- **Session injection**: on MCP server start, queries `proposalEngine.listPending()`; if any pending, injects a system-prompt notice via instructions (`mcp-server.ts:418-420`) so the LLM is reminded to call `engram_accept_proposal` / `engram_dismiss_proposal` when appropriate
- **Failure tolerance**: if the viewer is unreachable, the hook silently no-ops (Claude Code keeps working)

### 7.2 OpenClaw (plugin)

```
┌──────────────────┐  session.new event    ┌──────────────────┐
│  OpenClaw agent  │ ───────────────────▶  │ enqueueNextTurn  │
│                  │                       │ Injection        │
│                  │  llm_input event      │  (pending notice)│
│                  │ ───────────────────▶  └──────────────────┘
│                  │  llm_output event            │
│                  │                       ┌──────────────────┐
│                  │                       │ proposalEngine   │
│                  │  tool-call events     │   .observe()     │
│                  │ ───────────────────▶  └──────────────────┘
└──────────────────┘
        │
        │ Each tool call wrapped via wrapAllToolsWithSignalSink
        ▼
┌──────────────────┐  signalSink.jsonl   ┌──────────────────┐
│  Maintenance     │ ──────────────────▶ │ RPE updates      │
│  Engine          │                      │ engram scores    │
└──────────────────┘                      └──────────────────┘
```

Main differences:

- **No file hooks**: does not depend on `observe.py`; all events are consumed in-process via the plugin SDK (`plugin-entry.ts:251-304`)
- **Tool-call interception**: `wrapAllToolsWithSignalSink` (`plugin-entry.ts:208`) wraps every tool call, automatically writing to `signals.jsonl` for the maintenance engine
- **Optional embedded maintenance**: when `startMaintenance: true` (`plugin-entry.ts:236`), the three-stage scheduler runs in-process; no external cron needed

### 7.3 Key differences table

| Aspect                 | Claude Code                                                  | OpenClaw                                 |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Event intake           | File hooks (python) + HTTP                                   | In-process event listeners               |
| Signal sink            | File (`.co-engram/signals.jsonl`) read by maintenance engine | Same (same path; both hosts share it)    |
| Maintenance scheduling | Built into MCP server startup                                | Optional in-process, or external trigger |
| Failure tolerance      | Viewer down → hook no-ops                                    | Plugin component failure → SDK handles   |
| Deployment unit        | Standalone `mcp-server` process                              | Inside openclaw agent process            |

---

## 8. Typical Scenario Walkthroughs

### 8.1 User expresses a preference (produces a proposal)

```
User says: "From now on, our project uses arrow functions, not the function keyword"
   │
   ▼  UserPromptSubmit hook
proposalEngine.observe({role:'user', message:'...'})
   │
   ▼  1st time: new cluster
   ▼  2nd time: joins the cluster
   ▼  3rd time: occurrences ≥ 3
maybePromoteToProposal → pending proposal
   │
   ▼  Next session starts
LLM receives system-prompt injection: "N pending proposals"
   │
   ▼  LLM calls engram_list_proposals / engram_accept_proposal
New engram is born: kind=pattern, status=active
```

### 8.2 LLM retrieval is inaccurate (auto-decay)

```
LLM calls engram_search("PostgreSQL config")
   │
   ▼  Returns engram X
LLM immediately calls engram_search("PG config password")   ← different keywords
   │
   ▼  Signal extraction: get_then_immediate_search (-0.7)
RPE: actual=0.15, expected=0.5, rpe=-0.35
   │
   ▼  failedUses += 1, importance -= 0.03
   ▼  When failedUses ≥ 3 → shouldArchive flag
   ▼  When failedUses ≥ 5 → shouldForget flag
Maintenance engine migrates state per the flags (archive/forget)
```

### 8.3 Contradiction discovered (arbitration flow)

```
User says: "We no longer use Redis; switched to Postgres"
   │
   ▼  LLM retrieves old engram "project uses Redis for cache"
LLM calls engram_create({title:'Switched to Postgres', content:'...'})
   │
   ▼  LLM calls synapse_create({from:new, to:old, kind:'contradicts'})
Enter pending state; LLM arbiter starts phase-1
   │
   ▼  If LLM can't decide → escalated (awaits owner)
   │
   ▼  User calls contradiction_resolve({verdict:'keep_new'})
Old engram marked refuted; synapse transitions to resolved
```

### 8.4 Maintenance engine cleanup (forgotten → trash)

```
engram_report_failure fires multiple times, failedUses ≥ 5
   │
   ▼  shouldForget flag returned
User / maintenance engine calls engram_forget
   │
   ▼  State forgotten, freshness forgotten
30 days later...
   │
   ▼  Deep-stage trash sweep
File moved to .trash/2026-06/
365 days later...
   │
   ▼  Physically purged
```

---

## 9. Related Documentation

- [Concepts](./concepts.md) — Entity definitions and fields
- [Architecture](./architecture.md) — Multi-layer design and data flow
- [Maintenance Engine](./maintenance-engine.md) — light/deep/rem stage details
- [Tool Reference](./tool-reference.md) — All 29 tools with full signatures
- [Claude Code Integration](./host-claude-code.md)
- [OpenClaw Integration](./host-openclaw.md)
- [Observability](./observability.md) — Audit log, viewer

---

## 10. Executable Documentation

The thresholds, enum counts, and pipeline timings in this document are pinned by
**executable doc tests** at [`packages/core/test/lifecycle-doc.test.ts`](../packages/core/test/lifecycle-doc.test.ts).
If any value drifts (e.g. `DEFAULT_FORGET_THRESHOLD` changes from 5 to something else,
or the AuditAction enum grows past 25 values), the test fails and forces a doc update.

Run with: `pnpm --filter @co-engram/core test test/lifecycle-doc.test.ts`
