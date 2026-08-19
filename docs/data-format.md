# Data Format

This document describes the layout of the Co-Engram data repository (`$CO_ENGRAM_DATA_ROOT`, default `~/team-memory`).

## Design Principles

Co-Engram's storage is built on three principles:

1. **One engram = one Markdown file.** Frontmatter holds the metadata, body holds the content. Content diffs stay clean in Git while metadata evolves.
2. **Stable IDs (ULID) are decoupled from paths.** Renaming a title, moving folders, or rewriting content never breaks synapse references. The path is derived from `domainTags + slug(title)` but the id is permanent.
3. **Per-edge synapse storage.** Each connection between two engrams is its own YAML file keyed by a deterministic hash. No duplicate edges, trivial dedupe, and pruning is a single file delete.

## Directory Layout

```
~/team-memory/                         # Git repo (user-owned, not part of co-engram)
├── <domainTags>/<slug>.md              # engram files, organized by domain
│   ├── engineering/
│   │   └── typescript/
│   │       └── strict-mode-gotcha.md
│   └── ops/
│       └── linux/
│           └── ssh-tunnel-bastion.md
├── synapses/                           # per-edge connection storage
│   ├── extends/
│   │   └── syn-<hash>.yaml
│   ├── contradicts/
│   │   └── syn-<hash>.yaml
│   ├── similar_to/
│   │   └── syn-<hash>.yaml
│   ├── derives_from/
│   │   └── syn-<hash>.yaml
│   └── consolidates/
│       └── syn-<hash>.yaml
├── skills/                             # procedural memory
│   └── <skill-id>.yaml
├── intentions/                         # pending intentions
│   └── <intention-id>.yaml
├── config/                             # repo-level config
│   └── co-engram.yaml
├── events/                             # team activity events (Git-tracked, 2026-08)
│   └── 2026-08-19/                     # partition by day (event ts, UTC)
│       └── <origin>.jsonl              # one file per author/machine — writer-isolated sharding
├── .trash/                             # memory recycle bin (opt-in, Git-tracked)
│   └── 2026-06/                        # partition by month (UTC)
│       └── <domainTags>/<slug>.md
└── .co-engram/                         # derived caches (gitignored)
    ├── engram-index.json               # {version, engrams: {ULID → entry}, lastRebuiltAt}
    ├── graph.json                      # synapse graph snapshot
    ├── audit.jsonl                     # append-only audit log
    ├── doctor-report.json              # last runDoctor() self-heal snapshot (written by deep stage)
    └── signals.jsonl                   # pending tool-call events (drained by light stage)
```

## Engram File Format

Each engram is a single `.md` file with YAML frontmatter and a Markdown body.

### `<domainTags>/<slug>.md`

```markdown
---
id: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
title: TypeScript strict mode readonly gotcha
slug: strict-mode-gotcha # optional; default = slugify(title)
domainTags:
  - engineering
  - typescript
kind: pattern
kinds:
  - pattern
tags:
  - gotcha
summary: Use Object.assign({}, ...parts) to merge readonly configs
importance: 0.62
confidence: 0.85
sourceType: firsthand
visibility: team
verificationStatus: unverified
status: active
createdBy: Yang Yang
createdAt: 2026-06-21T10:30:00.000Z
updatedBy: Yang Yang
updatedAt: 2026-06-21T11:45:00.000Z
version: 3
contentHash: sha256:...
contentSize: 412
retrievalCount: 12
effectiveRetrievals: 9
failedUses: 1
reinforcementScore: 0.42
lastRetrievalScore: 0.71
lastRetrievedAt: 2026-06-21T11:45:00.000Z
lastEffectiveAt: 2026-06-21T11:45:00.000Z
---

# TypeScript strict mode readonly gotcha

In TS strict mode, readonly fields cannot be directly assigned. Use the
`Object.assign({}, ...parts)` pattern to merge partial configs:

\`\`\`typescript
const merged = Object.assign({}, ...parts)
\`\`\`
```

**Frontmatter fields:**

| Field                                                 | Type                | Description                                                                  |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `id`                                                  | ULID string         | 26-char stable identifier (Crockford base32, time-sortable)                  |
| `title`                                               | string              | Human-readable title                                                         |
| `slug`                                                | string (optional)   | URL-safe path component; defaults to slugify(title)                          |
| `domainTags`                                          | string[] (optional) | Domain hierarchy; defaults to inference from path                            |
| `kind`                                                | enum                | One of `observation` / `fact` / `pattern` / `procedure` / `hypothesis`       |
| `kinds`                                               | enum[] (optional)   | Additional secondary kinds                                                   |
| `tags`                                                | string[]            | Free-form context tags                                                       |
| `summary`                                             | string              | One-line summary                                                             |
| `importance`                                          | number `[0, 1]`     | Composite importance score                                                   |
| `confidence`                                          | number `[0, 1]`     | Initial value derived from `sourceType`; then dynamically adjusted by feedback signals (effective use +0.05, failure −0.05, refute ×0.3, verify +0.2 capped at 0.95) |
| `sourceType`                                          | enum                | `firsthand` / `secondhand` / `inferred`; affects default confidence          |
| `status`                                              | enum                | `draft` / `active` / `frozen` / `forgotten`                                |
| `verificationStatus`                                  | enum                | `unverified` / `plausible` / `verified` / `refuted`                          |
| `forcedFreshness`                                     | enum (optional)     | Override derived freshness (written by lifecycle tools)                      |
| `retrievalCount`, `effectiveRetrievals`, `failedUses` | integer             | Three-signal plasticity counters                                             |
| `reinforcementScore`                                  | number              | Accumulated RPE-driven reinforcement                                         |
| `lastEffectiveAt`                                     | ISO timestamp       | Last time this engram was used effectively                                   |
| `contentHash`                                         | string              | SHA-256 hash of body content (for change detection)                          |

The first `# heading` line in the body is optional but recommended — some viewers use it as a preview.

### Chinese mode (`language='zh'`)

When the repository's `language` is `'zh'` (the default since 0.2.0), engram files flip to **body on top, Chinese-keyed YAML below an HTML comment marker**. The body is unchanged; only the frontmatter block moves and its keys are localized.

```markdown
# TypeScript strict mode readonly gotcha

In TS strict mode, readonly fields cannot be directly assigned. Use the
`Object.assign({}, ...parts)` pattern to merge partial configs:

\`\`\`typescript
const merged = Object.assign({}, ...parts)
\`\`\`

## <!-- co-engram-meta:zh -->

标识: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
标题: TypeScript strict mode readonly gotcha
别名: strict-mode-gotcha
领域标签:

- engineering
- typescript
  类型: pattern
  标签:
- gotcha
  摘要: Use Object.assign({}, ...parts) to merge readonly configs
  重要性: 0.62
  置信度: 0.85
  来源类型: firsthand
  可见性: team
  验证状态: unverified
  状态: active
  创建者: claude-code
  创建时间: 2026-06-21T10:30:00.000Z
  更新者: claude-code
  更新时间: 2026-06-21T11:45:00.000Z
  版本: 3
  \_\_语言: zh

---
```

**What changes vs English mode:**

- Body is above the frontmatter (humans see content first when opening the file)
- Frontmatter is opened by `<!-- co-engram-meta:zh -->` (HTML comment — invisible in rendered Markdown) and uses Chinese keys (`标识` / `标题` / `类型` / `领域标签` / `创建时间` / `重要性` …)
- A reserved `__语言: zh` field marks the file's language authoritatively; the parser uses it to skip heuristic detection
- **Enum values stay English** (`类型: pattern`, not `类型: 模式`) — they are TypeScript literal-union types and the runtime compares them with `===`. Translating them would break the type system
- User-defined values (`标签`, `领域标签`, `创建者`, `摘要` text, body content) are not translated

The parser accepts both formats transparently. Old English-mode files in a Chinese repo get rewritten by the first-launch migration (see below).

### Derived Synapses Segment (Obsidian integration)

Every engram `.md` file may carry a derived body segment at the end, regenerated whenever a touching synapse changes (and by `engram_doctor`). It lets you open the data root as an Obsidian vault and see the memory network in graph view without a custom plugin.

```markdown
<!-- co-engram-derived:synapses -->
## Synapses (derived)

- → [[strict-mode-gotcha|TypeScript strict mode readonly gotcha · extends]]
- ← [[object-merge-pattern|Object.assign merge pattern · similar_to]]
```

- The segment opens with the `<!-- co-engram-derived:synapses -->` marker (invisible in rendered Markdown) followed by the `## Synapses (derived)` heading, then one bullet per resolved edge.
- The wikilink **target is the file name** (without `.md`), not the ULID — Obsidian resolves it natively. The display text is `<title> · <kind>` so the graph stays human-readable.
- `→` denotes outgoing edges (this engram is `from`); `←` denotes incoming edges (this engram is `to`). `contradicts` edges are pinned to the top of the segment as a warning.
- The segment is **only written when at least one edge resolves** — engrams with no synapses keep a clean body.
- The authoritative source is `synapses/*.yaml`. This body segment is a denormalized view: it is stripped and rebuilt on every synapse mutation and by `engram_doctor`. Filename drift (a manual rename outside co-engram) breaks the wikilinks until the next rebuild.
- The `aliases` frontmatter field is **not** injected. Historical `aliases` values are stripped on the next serialize (a one-shot warning is logged), because the bottom frontmatter in Chinese-mode files is invisible to Obsidian — filename-based wikilinks replace the earlier ULID + `aliases` scheme.

## Synapse File Format

Each synapse is one YAML file at `synapses/<kind>/syn-<hash>.yaml`. The hash is `syn-` + first 16 hex chars of `SHA-256("|"-joined)`, where the joined string is `${a}|${b}|${kind}` and `[a, b]` are the two endpoints:

- For `bidirectional` edges, endpoints are sorted (`a ≤ b`) so `(A, B, kind)` and `(B, A, kind)` produce the same file — that's what makes symmetric edges idempotent.
- For `directional` edges, order is preserved (`a = from`, `b = to`).

`direction` is **not** part of the hash input; two edges with the same endpoints + kind but different directions collapse to a single file. This means each `(from, to, kind)` triple has at most one synapse file.

```yaml
id: syn-a1b2c3d4e5f6a7b8
from: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
to: 01J7TRY9F8G7H6J5K4L3M2N1O0P
kind: extends
weight: 0.8
direction: directional # or "bidirectional"
evidence:
  - description: Both cover TS strict-mode patterns
    addedBy: claude-code
    confidence: 0.9
    addedAt: 2026-06-21T10:35:00.000Z
resolutionState:
  status: pending # pending / resolved / escalated
createdBy: Yang Yang
createdAt: 2026-06-21T10:35:00.000Z
updatedAt: 2026-06-21T10:35:00.000Z
retrievalWeight: 0.8
```

**Synapse kinds (12 across 5 families):**

| Family         | Kind             | Semantics                                       |
| -------------- | ---------------- | ----------------------------------------------- |
| **structural** | `extends`        | A is a generalization / superset of B           |
|                | `part_of`        | A is a component of B                           |
|                | `similar_to`     | A and B cover the same topic differently        |
| **causal**     | `depends_on`     | A requires B                                    |
|                | `causes`         | A produces B                                    |
|                | `follows`        | A precedes B sequentially                       |
| **evidential** | `derives_from`   | A is derived from B (evidence chain)            |
|                | `contradicts`    | A and B disagree (triggers metacognition check) |
|                | `exemplifies`    | A is a concrete instance of B                   |
| **temporal**   | `supersedes`     | A replaces B (newer version)                    |
|                | `consolidates`   | A reinforces / merges into B                    |
| **modulatory** | `contextualizes` | A provides context for B                        |

**Direction:** `directional` (from → to) or `bidirectional` (symmetric). `contradicts` is typically `bidirectional`.

### Chinese mode (`language='zh'`)

Synapse files in a Chinese repo use Chinese top-level keys and Chinese keys inside `证据[]` / `裁决状态`:

```yaml
标识: syn-a1b2c3d4e5f6a7b8
起点: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
终点: 01J7TRY9F8G7H6J5K4L3M2N1O0P
类型: extends
权重: 0.8
方向: directional
证据:
  - 描述: Both cover TS strict-mode patterns
    添加者: claude-code
    置信度: 0.9
    添加时间: 2026-06-21T10:35:00.000Z
创建者: claude-code
创建时间: 2026-06-21T10:35:00.000Z
更新时间: 2026-06-21T10:35:00.000Z
检索权重: 0.8
__语言: zh
```

Enum values stay English (`类型: extends`, `方向: directional`) for the same reason as engrams.

## ID Format

Engram IDs are **ULID** (Universally Unique Lexicographically Sortable Identifier):

- 26 characters, base32 Crockford encoding
- Prefix: 48-bit timestamp (milliseconds since Unix epoch)
- Suffix: 80-bit randomness

Properties:

- Globally unique (no coordination needed)
- Sortable by creation time (efficient time-range queries)
- Compact (26 chars vs 36 for UUID)
- **Decoupled from file path** — renames and moves don't change the id

Example: `01J6XQK5P7R2V8Y3M4N6ZH0WQT`

Synapse IDs are deterministic hashes: `syn-` + first 16 hex chars of `SHA-256("|"-joined endpoints + kind)`. For `bidirectional` edges, endpoints are sorted before hashing so the same pair produces the same id regardless of order; for `directional` edges, the order is preserved.

## Cache Directory (`.co-engram/`)

The `.co-engram/` directory is **derived** — fully rebuildable from the engram files + synapse files source of truth. It is gitignored.

### `engram-index.json`

Top-level shape: `{ version: 1, engrams: { ULID → entry }, lastRebuiltAt: ISO }`. Each entry has:

| Field                     | Type            | Description                                             |
| ------------------------- | --------------- | ------------------------------------------------------- |
| `id`                      | ULID            | Stable engram id                                        |
| `path`                    | string          | Relative path (changes on move)                         |
| `title`                   | string          | Current frontmatter title                               |
| `slug`                    | string          | Slug (from frontmatter or derived)                      |
| `slugLocked`              | boolean         | Did frontmatter pin the slug?                           |
| `domainTags`              | string[]        | Locked or inferred from path                            |
| `domainTagsLocked`        | boolean         | Did frontmatter pin domainTags?                         |
| `tags`                    | string[]        | Free-form context tags                                  |
| `kind`                    | enum            | Primary kind                                            |
| `verificationStatus`      | enum (optional) | If set on frontmatter                                   |
| `createdAt` / `updatedAt` | ISO timestamp   | Frontmatter values                                      |
| `mtime`                   | number          | File mtime (epoch ms) — drives doctor incremental scans |
| `contentHash`             | string          | Body SHA-256 — triggers search-index rebuild on change  |

Used for:

- Fast id → path lookup (no directory scan)
- `engram_doctor` incremental scans (mtime + contentHash comparison)
- `engram_list_paths` tree view
- The viewer UI

Rebuilt automatically on `createEngram` / `updateEngram` / `deleteEngram`. Run `engram_doctor` to rebuild manually if files are edited externally.

### Full-text search index (in-memory)

Co-Engram does **not** persist a FTS database. On every search the retrieval orchestrator builds an in-memory inverted index over engram content + titles + tags. This keeps the data layer a pure source-of-truth (no derived DB to sync) at the cost of a small per-search build cost. For large repos (10k+ engrams) the maintenance engine can pre-warm the index — see [maintenance-engine.md](./maintenance-engine.md).

Tokenization: ASCII words lowercased; CJK text split into overlapping bigrams so Chinese / Japanese / Korean queries match.

### `graph.json`

Snapshot of the synapse graph for fast traversal. Rebuilt on every `synapse_create` / `synapse_delete`.

### `audit.jsonl`

Audit log of state changes and effectiveness signals. Used by the viewer, maintenance engine, and meta-learning. Entries are appended; the file self-rotates by action-value tier (default 90d low-value / 365d high-value) + 50MB file-size hard cap, so it does not grow unbounded. See [Observability → Log Rotation](./observability.md#log-rotation-automatic-cleanup) for the full retention policy and config keys.

Each line is one `AuditEntry`:

```json
{"ts":"2026-06-21T10:30:00.000Z","actor":"user","action":"create","engramId":"01J...A"}
{"ts":"2026-06-21T10:31:00.000Z","actor":"system","action":"retrieve_hit","engramId":"01J...A","query":"adb","score":0.82}
{"ts":"2026-06-21T11:00:00.000Z","actor":"system","action":"retrieve_effective","engramId":"01J...A","query":"adb"}
```

Tracked actions: `create`, `update`, `update_lifecycle`, `reinforce`, `report_failure`, `forget`, `restore`, `sweep_to_trash`, `restore_from_trash`, `purge`, `propose`, `accept`, `dismiss`, `retrieve_hit`, `retrieve_effective`, `retrieve_inconclusive`, `contradicted`.

Approximate size: 200 bytes/event. With default rotation the file stays bounded at ~50MB worst-case (size cap), typically much smaller.

### `events/<day>/<origin>.jsonl`

Team activity events (2026-08). `audit.jsonl` is machine-local (gitignored), so in the clone-per-person + git sync topology the viewer's "Memory Activity" feed would otherwise only show local events. High-value actions (`create`, `update`, `reinforce`, `contradicted`, `accept`, `skill_create`, `skill_update`) are therefore dual-written into day-partitioned shards that **are** committed with the repo:

- **Writer isolation**: each file is written by exactly one author/machine (`<origin>` = git `user.name`, falling back to `user.email`), so git merges never conflict — no union driver needed.
- **Privacy**: events for `visibility: private` engrams never enter `events/` (they stay in the local audit only); metadata is whitelist-projected and clipped to 80 chars, content bodies are never carried in full.
- **Dedup**: every event carries a globally unique `eventId`; the viewer merges `audit.jsonl ∪ events/` and dedups local dual-writes by `action|engramId|ts`.
- **Retention**: day directories older than `audit.teamEvents.retentionDays` (default 14) are deleted whole; future-dated directories (clock skew) are never touched.

Each line is one `TeamEvent`:

```json
{"schemaVersion":1,"eventId":"0f4c…","origin":"alice","ts":"2026-08-19T10:00:00.000Z","actor":"user","action":"create","engramId":"01J...A","metadata":{"createdBy":"alice","title":"deploy port contract"}}
```

Disable with `audit.teamEvents.enabled: false` in the repo config.

### `doctor-report.json`

Persisted snapshot of the most recent `runDoctor()` self-heal scan. The maintenance engine's **deep** stage runs `runDoctor()` (detecting dangling synapses, orphan markdown, SQLite ghosts — auto-fixing where safe) and writes the resulting `DoctorReport` here so the viewer's health panel can show "what deep just fixed" even after auto-fix. The `/api/doctor` endpoint prefers this cached file; pass `?rescan=1` to force a fresh doctor run instead of reading the cache.

Shape: `{ startedAt, finishedAt, issues: DoctorIssue[], fixes: DoctorIssue[], pendingManualReview: DoctorIssue[] }`. Writing is best-effort — if it fails, deep maintenance continues without blocking.

### `signals.jsonl` (inside `.co-engram/`)

JSON Lines file collecting `ToolCallEvent`s. Drained every light stage. Pruned to 7-day retention.

> Historical note: 0.x versions wrote this file at the repo root (`<dataRoot>/signals.jsonl`), separate from other state files. As of 1.x it lives under `.co-engram/`; on first sink creation, if the legacy path is present, it is auto-migrated to the new location (existing new-path files are never overwritten).

Example line:

```json
{
  "toolName": "engram_get",
  "input": { "id": "01J..." },
  "retrievedEngramIds": ["01J..."],
  "sessionId": "abc",
  "at": 1718956300000
}
```

## Trash Directory (`.trash/`)

When the deep maintenance stage runs with `CO_ENGRAM_TRASH_ENABLED=1`, forgotten engrams are moved here instead of being deleted outright. The structure mirrors the main tree:

```
.trash/
└── 2026-06/                                    # YYYY-MM partition (UTC)
    └── engineering/typescript/
        └── old-deprecated-api.md
```

**Behavior:**

- Engrams enter `.trash/` only when `status=forgotten` AND the engram file mtime is older than `CO_ENGRAM_TRASH_AFTER_DAYS` (default 30).
- The ULID is preserved, so `engram_restore` can find and move the file back.
- Synapses pointing into `.trash/` are NOT cascaded — they remain as dangling references and auto-heal on restore.
- Partitions older than `CO_ENGRAM_TRASH_PURGE_AFTER_DAYS` (default 365) are physically deleted on the next sweep. Set to `0` to disable purge entirely.

**Git tracking:**

`.trash/` is part of the data repo (not gitignored). The sweep uses `git mv` when possible so history is preserved across the move. This means team members synchronizing via Git see the same trash state.

## Config File (`config/co-engram.yaml`)

Repo-level configuration, applied in addition to env vars / plugin config:

```yaml
defaultCreatedBy: claude-code
defaultVisibility: team
maintenance:
  learningRate: 0.1
  enabledStages: [light, deep, rem]
```

Env vars and plugin config take precedence over this file.

> Note: the decay half-life is no longer a config key — it is derived live from `importance` + `kind` (`BASE_HALFLIFE_DAYS × (importance + 0.1)^1.5 × kindMultiplier`), so `defaultDecayHalfLifeDays` is no longer accepted.

### `.co-engram/config.json` — team memory config

Distinct from the user-authored `config/co-engram.yaml` above, `.co-engram/config.json` is a host-managed file written by the first-run `co-engram init` flow and updated on host startup. It captures the team's chosen `language` and the disk-format migration state:

```json
{
  "version": 1,
  "language": "zh",
  "migratedToLanguage": "zh"
}
```

- `language` — the canonical language for tool descriptions, prompt sections, and **disk format** (English vs Chinese YAML keys)
- `migratedToLanguage` — the language all engram + synapse files have already been migrated to. When this differs from `language` at host startup, the host runs `repository.migrateFormat(language)` to rewrite all files to the target format, then sets `migratedToLanguage = language` and writes the file back. This makes switching languages a one-shot migration rather than a per-file branch

The migration rewrites every file (parsed and re-serialized in the target format) but is idempotent: files already in the target format are detected via the `__语言` marker or top-frontmatter signature and skipped. Recommendation: commit a Git checkpoint before flipping `language`, so the format change is one reviewable diff.

## Git Hygiene

Because the data repo is a Git repo, commits accumulate fast. Best practices:

### Commit Message Convention

Co-Engram uses conventional-commit-style messages:

```
feat(engram): create 01J...A "TypeScript strict mode gotcha"
update(engram): bump 01J...A importance 0.6 → 0.7
archive(engram): 01J...B "superseded by 01J...C"
create(synapse): 01J...A --extends--> 01J...C
```

### Large Repo Management

After thousands of engrams, consider:

- **Shallow clones** for CI: `git clone --depth 1`
- **Git LFS** if content includes many large Markdown files with embedded images
- **Periodic archive sweeps**: `engram_list({ filter: { status: [frozen] }, limit: 500 })` then bulk forget (cursor-paginate if more than 500 frozen)

## Backup Strategy

The data repo **is** the backup. Standard Git workflows apply:

- Push to a private remote (GitHub, GitLab, Gitea)
- Tag releases: `git tag memory-snapshot-2026-06-21`
- Clone to a new machine to replicate memory

No special tooling needed — that's the point.
