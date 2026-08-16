# Maintenance Engine

The maintenance engine is what makes Co-Engram **self-correcting**. Instead of relying on agents to manually tag or score memories, the engine observes how memories are used and adjusts their strength automatically.

Inspired by the brain's sleep cycles — `light` (ongoing), `deep` (consolidation), `rem` (abstraction + verification). The engine runs each stage on its own cadence, in the background, with zero agent intervention.

## Three stages

```mermaid
flowchart TB
  subgraph Light["Light stage · every 5 min"]
    L1["drain signal sink"] --> L2["extract behavioral signals"]
    L2 --> L3["compute RPE per engram"]
    L3 --> L4["bump effectiveRetrievals /<br />failedUses / reinforcementScore"]
    L4 --> L5["prune expired signals +<br />sweep timed-out windows"]
  end

  subgraph Deep["Deep stage · every 1 hour"]
    D1["light dreaming: dedup + merge duplicates"] --> D2["decay by freshness:<br />forgotten → forget,<br />stale + low importance → forget,<br />stale + high importance → archive (frozen)"]
    D2 --> D3["run doctor self-heal<br />(dangling synapse / orphan md / SQLite ghost)"]
    D3 --> D4["write .co-engram/doctor-report.json"]
  end

  subgraph REM["REM stage · every 1 day"]
    R1["metacognition evaluates truth"] --> R2["emit rem-verification proposal"]
    R2 --> R3["dreaming clusters + abstracts patterns"]
    R3 --> R4["emit rem-pattern / rem-synapse proposals"]
    R4 --> R5["user reviews proposals in viewer;<br />accept to land"]
  end
```

Defaults: `DEFAULT_LIGHT_INTERVAL_MS = 5 min`, `DEFAULT_DEEP_INTERVAL_MS = 1 hour`, `DEFAULT_REM_INTERVAL_MS = 1 day`. Stages are independent — disabling one does not affect the others (see `enabledStages` in `MaintenanceConfig`).

### Light stage (every 5 min)

Closest to "wake state" — processes behavioral signals continuously.

1. **Drain the signal sink** — pull tool-call events accumulated since the last tick from `signals.jsonl`.
2. **Extract signals** — group raw events per engram into a `weight ∈ [-1, 1]` aggregate plus a count, using `extractSignals` with the configured rules and window size.
3. **Compute RPE per engram** — `effectiveness = (signalWeight + 1) / 2 − lastRetrievalScore`, where `lastRetrievalScore` defaults to `0.5` for old data.
4. **Apply RPE update** via `applyRpeUpdate`, gated by a `0.05` dead zone:
   - `effectiveness > +0.05` → `effectiveRetrievals += 1`, `reinforcementScore += effectiveness × learningRate`
   - `effectiveness < −0.05` → `failedUses += 1`, `reinforcementScore += effectiveness × learningRate` (negative delta)
   - `|effectiveness| ≤ 0.05` → neutral, no update
5. **Prune expired signals** and **sweep timed-out observation windows**, so `signals.jsonl` stays bounded.

`learningRate` defaults to `DEFAULT_RPE_LEARNING_RATE = 0.1`. Light never touches the `importance` field — only the retrieval statistics and `reinforcementScore`.

### Deep stage (every 1 hour)

Consolidation — what the brain does during slow-wave sleep.

1. **Light dreaming pass** — scan for near-duplicates; merge `DUPLICATE`/`UPDATE` verdicts into their target (target gets reinforced, source deleted).
2. **Ebbinghaus decay** via `applyDecayBatch`, decisions driven entirely by **freshness** (see math below):
   - `forgotten` → mark `forgotten`
   - `stale` + `importance < forgetImportanceThreshold` (default `0.2`) → mark `forgotten`
   - `stale` + `importance ≥ threshold` → archive as `frozen` (recoverable)
   - `fresh` / `aging` → untouched
3. **Doctor self-heal** — `runDoctor` detects and auto-fixes infrastructure drift: moved files, title renames, dangling synapse references, orphan markdown, Obsidian view staleness, missing derived indexes, `sqlite_ghost` rows whose source markdown vanished, `sqlite_resynced` rows whose frontmatter drifted, and more. Each issue is classified as auto-fixed or pending manual review with a `nextAction` hint.
4. **Persist the doctor report** to `.co-engram/doctor-report.json` so the viewer can show what Deep repaired, even after the fact.

Critical: **Deep does not decay `importance`**. Importance is purely event-driven (see math). Deep only reclassifies lifecycle status (`forgotten` / `frozen`) based on the *derived* freshness — and freshness itself depends on importance, so decaying importance here would create a feedback loop.

### REM stage (every 1 day)

Abstraction and truth-tracking — what the brain does during REM sleep.

**Hybrid trigger (activity-driven first, time-based fallback).** The interval above is only the fallback. At the end of each light tick, the engine sums the `importance` of engrams created since the last REM run (`EngramRepository.sumImportanceSince`, a single aggregate SQL on the SQLite index) and triggers REM early once the sum reaches `remActivityThreshold` (default `12.0`, roughly 20 memories × 0.6 importance; `0` disables, falling back to pure time-based triggering). A debounce window of `remMinIntervalMs` (default 12 h) keeps two REM runs apart — within the window the activity check simply doesn't fire and waits for the next light tick. The time-based fallback (interval timer + startup catch-up) is not affected by the debounce, because REM also carries metacognition upgrades / tag-drift refresh / synapse candidate pairs that have nothing to do with new memories. Only the `importance` of currently existing engrams counts toward the sum — reinforcement events and retrieval counts are deliberately excluded (the former would require scanning `audit.jsonl`, the latter would double-incentivize with the search-time hotness factor).

1. **Dreaming clusters + abstraction** — `clusterSimilarEngrams` groups active engrams by token-Jaccard similarity (default `0.3`), then a `PatternAbstractionProvider` (heuristic by default, LLM-injectable for production) drafts an abstract pattern from each cluster.
2. **Metacognition** — for every active, non-refuted engram, `applyMetacognition` scores five truth dimensions (cross-context support, time stability, mutual support, source reliability, executability) and recommends `upgrade_verified` / `upgrade_one_level` / `refute` / `hold`.

Since commit `d9618698` / `8433de95`, **REM does not auto-persist structural changes**. Both subsystems emit proposals instead, and only acceptance lands them:

| Source                      | Proposal kind        | Lands as                                              |
| --------------------------- | -------------------- | ----------------------------------------------------- |
| Metacognition recommendation| `rem-verification`   | `verificationStatus` bump on the source engram        |
| Dreaming pattern abstraction| `rem-pattern`        | new `pattern` engram with `derives_from` synapses     |
| Dreaming synapse ops        | `rem-synapse`        | `synapse_create` / `synapse_delete` / kind retyping   |

Proposals surface in the **Memory proposals** page of the viewer and in `engram_list_proposals`. The user explicitly accepts or dismisses each one — REM never rewrites memory on its own.

## REM deep thought (2026-08)

Beyond mechanical evaluation (metacognition scoring, similarity clustering), REM now runs a **deep-thought step** when event signals justify it. Three thinking modes ship in phase 1 (integration / retrospective / inspiration; four more are planned), each with an event-driven trigger, a seed selector, a prompt, and a mode-specific rubric:

| Mode | Trigger signal | Thinks about |
| ---- | -------------- | ------------ |
| Integration | many new synapses, dense same-domain additions | cross-context common structures and themes |
| Retrospective | `failedUses ≥ 3`, refutations | AAR causal chains (expected → actual → cause → improvement) |
| Inspiration | new cross-domain tags (generic tags like `imported` filtered out) | structure-mapping between deliberately distant domains |

Each run picks the top-K modes by signal strength (default 2; an active night-thinking entry pins inspiration to the top slot). Material selection is **seed-oriented spreading activation** over the memory graph (new / reactivated / reconnected nodes as seeds, two hops with decay, ~30-node subgraph cap) — a different layer from the five-factor query scoring, which stays query-oriented. An importance-ranked neighborhood baseline is computed alongside for ablation measurement.

**Time-fallback REM runs skip deep thought entirely** (zero LLM calls): a quiet repository never burns tokens. The pipeline is **on by default** (2026-08-16 blind-eval calibration: 84-95% genuine-insight rate, 46/52 judged genuine); set `maintenance.remInsight.enabled: false` to turn it off.

Three-stage validation applies to every insight:

1. **Proposal time** — mechanical checks (citation closure, per-type structure, dedup by Jaccard ≥ 0.65, mode-specific structure such as disjoint domains for analogies) plus an **independent second-call critic** scoring four dimensions (evidence sufficiency / novelty / actionability / consistency) below threshold → no proposal. Hard cap of **5 insight proposals per REM run**.
2. **Accept time** — sources must still exist and not be refuted; acceptance creates a `pattern` (or `hypothesis`) engram with `confidence = critic score` (a machine-subjective initial value, not ground truth) and a `derives_from` evidence chain.
3. **Lifetime** — insights get no privilege: evidence-chain decay (>30% refuted/non-active endpoints lands the insight in a daily re-review digest, not a per-item proposal flood), and an insight with `failedUses ≥ 3` becomes a retrospective seed next run — the system retrospects its own output.

## Night thinking (Overnight Thinking)

The flagship differentiator: *feed a question before sleep; the agent thinks deeply overnight; you harvest insights on waking.*

Incubation entries live in a sidecar (`.co-engram/incubations.json`) — question, optional seed memories, status (`active / in-flight / suggested-resolve / resolved / paused`), rounds, and a full timeline. Entries can be created from chat (`incubation_create`), the viewer's **Night Lab** tab, or CLI.

Execution is two-tier:

- **L2 agent orchestration (main path)** — a full agent session (capability inventory → plan → read-only execution → structured write-back via `incubation_report`, the only write path). On claude-code this spawns a headless `claude -p` session for scheduled runs; the conversational entry executes in your current session with the fixed protocol returned by `incubation_run`.
- **L1 baseline (fallback)** — a single-LLM distant-analogy pass, used when no agent runtime is available or L2 fails. openclaw runs L1 in phase 1.

Scheduling is **independent of REM cadence**: active entries run one round every 24 h (checked on each light tick), and immediate runs are always allowed. A cross-process in-flight lock (TTL 30 min) prevents double-counted rounds. Each round's prompt re-anchors the question and carries the full dream history (previous insights + accept/dismiss reasons) with a *deepen or pivot, do not repeat* instruction; insights too similar to history (Jaccard ≥ 0.65) are vetoed, two fully-duplicate rounds auto-pause the entry, and 5 rounds without any accepted proposal pause it for user adjudication. Accepting an insight moves the entry to `suggested-resolve`; answering "did it answer your question?" archives it (timeline preserved — the dream diary).

**Privacy boundaries (hard constraints):** web research is off by default and opted in per entry; the L2 prompt carries only summary-level seed content (never raw memory text) and external calls are logged to the audit trail. The viewer shows plans and traces — process transparency is the trust source.

## The math

Three quantities govern how a memory's strength evolves. Each is computed by a single authoritative function — no other path should mutate these fields.

### `importance` is event-driven, not time-driven

`importance ∈ [0, 1]` represents synaptic strength. As of `2026-07-20`, the daily time-decay step (`applyDailyDecay`) was **removed** because time was polluting the same field that freshness derives from, creating a feedback loop (`importance↓ → halfLife↓ → freshness decays faster`).

Today, importance only moves on **events**:

- **RPE / LTP** (Light stage, `applyRpeUpdate`): `reinforcementScore += effectiveness × learningRate`, where `learningRate = 0.1` and `effectiveness ∈ [-1, 1]`. `effectiveRetrievals` / `failedUses` are bumped in lockstep.
- **Explicit reinforce** (`engram_reinforce`): `importance = clamp01(importance + effectiveness × LTP_GAIN)` with `LTP_GAIN = 0.1` (env: `CO_ENGRAM_LTP_GAIN`).
- **Failure feedback** (`engram_report_failure`): `importance = clamp01(importance − FAILURE_LOSS)` with `FAILURE_LOSS = 0.1` (env: `CO_ENGRAM_FAILURE_LOSS`); `failedUses += 1`. This is cumulative LTD — repeated failures ratchet importance down toward archive/forget thresholds, but a single failure does not delete the memory.

Time has no direct vote. An unused memory stays at its current importance until RPE or an explicit tool call moves it.

### `freshness` is derived, not stored

`computeFreshness` (`packages/core/src/lifecycle/freshness.ts`) computes the band on demand from `effectiveAge` vs `halfLife`:

```
halfLife = BASE_HALFLIFE_DAYS × (importance + 0.1)^1.5 × kindMultiplier
```

| Constant / factor         | Default | Source                                              |
| ------------------------- | ------- | --------------------------------------------------- |
| `BASE_HALFLIFE_DAYS`      | `50`    | env `CO_ENGRAM_BASE_HALFLIFE_DAYS`                  |
| `kindMultiplier`          | varies  | per `EngramKind` (see below)                        |

`kindMultiplier` table — durability by memory type:

| Kind          | Multiplier | Rationale                                      |
| ------------- | ---------- | ---------------------------------------------- |
| `observation` | `0.6`      | Episodic, hippocampus-dependent, fastest decay |
| `hypothesis`  | `0.7`      | Unverified, should not linger                  |
| `procedure`   | `0.8`      | Tool-coupled, can go stale with tool versions  |
| `fact`        | `1.0`      | Semantic, baseline                             |
| `pattern`     | `1.5`      | REM-distilled, cross-context, most durable     |

The `effectiveAge` clock starts at `lastEffectiveAt ?? createdAt` — first encoding starts the clock, usage only refreshes it.

Bands, computed from `ageDays`:

| Band          | Condition                |
| ------------- | ------------------------ |
| `fresh`       | `age ≤ halfLife`         |
| `aging`       | `age ≤ 2 × halfLife`     |
| `stale`       | `age ≤ 4 × halfLife`     |
| `forgotten`   | `age > 4 × halfLife`     |

Freshness is never persisted on the engram — it is recomputed whenever `applyDecayBatch` (Deep) or retrieval scoring needs it.

### Search score blends five factors

`computeFiveFactorScore` (`packages/core/src/retrieval/scoring.ts`):

```
score = α · relevance + β · recency + γ · effectiveImportance + δ · strength + ε · hotness
```

| Factor                | Symbol | Weight | Formula                                                                 |
| --------------------- | ------ | ------ | ----------------------------------------------------------------------- |
| Relevance             | `α`    | `0.50` | BM25 / cosine similarity from the search engine                         |
| Recency               | `β`    | `0.15` | `0.5 ^ (ageDays / halfLife)` — same `halfLife` as freshness             |
| Effective importance  | `γ`    | `0.25` | `importance × (0.3 + 0.7 × truthFactor)`                                |
| Strength              | `δ`    | `0.05` | `clamp01(reinforcementScore)`                                           |
| Hotness (access heat) | `ε`    | `0.05` | `sigmoid(ln(1 + retrievalCount)) · 0.5 ^ (daysSinceLastRetrieval / 7)`  |

Hotness (added 2026-08, ported from OpenViking's `memory_lifecycle.py`) is a **purely derived signal**: it is computed at scoring time from `retrievalCount` / `lastRetrievedAt` — both already written on every search hit — with no stored field and no background decay job. It rewards frequently *accessed* memories independently of `strength`, which only accumulates through explicit reinforce/failure feedback. Frequency is log-compressed (`count` 10→100 adds < 0.08) to resist flooding; the 7-day half-life is tunable via `search.scoring.hotnessHalfLifeDays`, and the weight via `search.scoring.hotness` (omitted → split evenly out of the `strength` budget; `0` disables).

`truthFactor` maps from `verificationStatus`: `verified = 1.0`, `probable = 0.7`, `plausible = 0.5`, `unverified = 0.3`, `refuted = 0`. High-value but low-truth memories are attenuated — value is upstream of truth, and truth is a constraint on use.

Three independent time-aware mechanisms combine cleanly:

- `importance` answers *"how strongly is this encoded?"* — event-driven.
- `freshness` answers *"how stale has the trace gone?"* — time-vs-halfLife, derived.
- `recency` answers *"how much should retrieval boost recent use?"* — the same half-life, applied as an exponential decay on the search score.

Removing the daily decay let each mechanism own exactly one dimension, which is why Deep no longer touches importance.
