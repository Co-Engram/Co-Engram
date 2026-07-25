# Core Concepts

This page defines the vocabulary you'll see across the codebase and documentation.

## Engram

The atomic unit of memory. Inspired by the neuroscientific term "engram" — the physical trace of a memory in the brain.

**Structure:**

- `id` — ULID, sortable by creation time
- `title` — short human-readable label
- `content` — Markdown body (the actual memory)
- `summary` — optional auto-generated digest
- `kind` — one of `observation` / `fact` / `pattern` / `procedure` / `hypothesis`
- `domainTags` — array of domains this engram is relevant to (e.g. `["backend", "rust"]`)
- `contextTags` — optional situational tags
- `importance` — float `[0, 1]`, composite of personal/team/project/network/temporal
- `confidence` — float `[0, 1]`, how sure we are this is true
- `verificationStatus` — `unverified` → `plausible` → `probable` → `verified` (or `refuted`)
- `visibility` — `public` / `team` / `private` / `restricted`
- `createdBy` / `createdAt` / `updatedBy` / `updatedAt`

**Storage:** single Markdown file at `<domainTags>/<slug>.md` (YAML frontmatter + body) — see [data-format.md](./data-format.md).

**Lifecycle:** create → reinforce/use → archive/forget/restore. See `engram_create`, `engram_archive`, `engram_forget`, `engram_restore`.

## Synapse

A typed, directional connection between two engrams. Named after the synaptic connections between neurons.

**Structure:**

- `from` / `to` — engram IDs
- `kind` — one of:
  - `extends` — A builds on B
  - `part_of` — A is a component of B
  - `similar_to` — A and B describe related phenomena
  - `depends_on` — A requires B
  - `causes` — A triggers B
  - `follows` — temporal sequence A → B
  - `derives_from` — A is derived from B (provenance)
  - `contradicts` — A and B conflict (triggers arbitration)
  - `exemplifies` — A is an example of B
  - `supersedes` — A replaces B
  - `consolidates` — A merges multiple Bs
  - `contextualizes` — A provides context for B
- `weight` — float `[0, 1]`
- `direction` — `directional` or `bidirectional`
- `evidence` — array of `{ description, source, confidence, addedBy }`

**Effect on retrieval:** when one engram is retrieved, its `extends`/`consolidates` neighbors get a relevance boost (Hebbian-like reinforcement). `contradicts` neighbors get suppressed.

## Skill

A **procedural** memory — "how to do something". Complementary to engrams (which are declarative — "what is true").

**Structure:**

- `id` — stable identifier
- `template` — tool sequence or prompt template
- `trigger` — when this skill should activate
- `args` — expected input shape

**Tools:** `skill_get` (read-only metadata, in `full` profile), `skill_invoke` (experimental — not in any default profile because template resolution is a P0 stub). Skills themselves are authored as YAML files under `skills/`.

## Signal

A behavioral observation extracted from tool-call events, used by the maintenance engine.

**Source events** (`ToolCallEvent`):

- `toolName` — e.g. `engram_get`
- `input` / `outputSummary`
- `retrievedEngramIds` — which engrams were touched
- `sessionId` / `at`

**Extracted signals** (`BehavioralSignal`):

- `engramId`
- `weight` — `[-1, 1]`, positive = useful, negative = harmful
- `source` — rule name (see below)

**Built-in rules** (in `signals/extract.ts`):
| Rule | Weight | Trigger |
|---|---|---|
| `repeated_get` | +0.6 | Same engram retrieved ≥2 times in a window |
| `get_followed_by_action` | +0.8 | Retrieval followed by file edit / bash / commit |
| `get_followed_by_no_search` | +0.4 | Retrieval wasn't followed by another search (good enough) |
| `get_then_immediate_search` | -0.7 | Retrieval immediately followed by another search (wrong match) |
| `user_correction` | -0.4 | User message contains correction words ("no", "wrong", "actually") |
| `contradicts_created` | -0.8 | A `contradicts` synapse was created against this engram |

## RPE (Reward Prediction Error)

The learning signal that updates `reinforcementScore`. Borrowed from neuroscience — dopamine neurons fire when actual reward exceeds expected.

**Formula:**

```
actual  = (clamp(signalWeight, -1, 1) + 1) / 2    // normalized to [0, 1]
rpe     = actual - expected                        // expected = retrievalScore at retrieval time
```

**Application:**

- `rpe > 0.05`: bump `effectiveRetrievals`, `reinforcementScore += rpe * learningRate`
- `rpe < -0.05`: bump `failedUses`, `reinforcementScore += rpe * learningRate`
- `|rpe| ≤ 0.05`: neutral, no update

**Learning rate** defaults to `0.1` — tunable via `CO_ENGRAM_MAINTENANCE_LEARNING_RATE`.

## Metacognition

A five-dimension truth scoring system that runs during the REM maintenance stage. Scores each engram and recommends whether to upgrade or refute its `verificationStatus`; the recommendation becomes a `rem-verification` proposal that only lands on disk after the user accepts it on the Proposals page (no longer auto-applied).

**Dimensions:**
| Dimension | Weight | What it measures |
|---|---|---|
| Cross-context stability | 0.30 | How many distinct domains this engram appears in |
| Time stability | 0.25 | How long since creation (saturates at 30 days) |
| Mutual support | 0.25 | Ratio of `extends`/`consolidates` to `contradicts` synapses |
| Source reliability | 0.20 | Trust score of the creator |
| Executable (procedure only) | gate | Whether the procedure has been successfully invoked |

**Decision thresholds:**

- `overall ≥ 0.85` + age ≥ 7 days → upgrade to `verified`
- `overall ≥ 0.70` → upgrade one level
- `overall < 0.30` + has `contradicts` → `refuted`
- otherwise → hold

## Verification Status State Machine

```
                   ┌──────────────────┐
                   │   unverified     │ ← default for new engrams
                   └────────┬─────────┘
                            │ upgrade
                            ▼
                   ┌──────────────────┐
                   │    plausible     │
                   └────────┬─────────┘
                            │ upgrade
                            ▼
                   ┌──────────────────┐
                   │    probable      │
                   └────────┬─────────┘
                            │ upgrade (with evidence)
                            ▼
                   ┌──────────────────┐
                   │    verified      │
                   └──────────────────┘

         (any state can transition to refuted via metacognition)
```

State machine is enforced — no skipping levels without `force: true` on `upgrade_verification`.

## See Also

- [Tool Reference](./tool-reference.md) — how to actually call these via MCP/plugin
- [Maintenance Engine](./maintenance-engine.md) — how signals, RPE, and metacognition are scheduled
- [Design Rationale](./design-rationale.md) — why these concepts are shaped this way
