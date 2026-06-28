# Changelog

All notable changes to Co-Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`defaultCreatedBy` now auto-detects from local git config (`@co-engram/core`, `@co-engram/claude-code`, `@co-engram/openclaw`)**: new `detectGitAuthor()` helper reads `git config user.name` (preferred) then `user.email`. Both MCP and OpenClaw hosts use it as the last fallback before `'unknown'` / `'openclaw'`, so new engrams/synapses get attributed to your git identity with zero config. Resolution chain: caller-provided `createdBy` → `CO_ENGRAM_DEFAULT_CREATED_BY` env (MCP) / plugin config `defaultCreatedBy` (OpenClaw) → persisted team-memory config → **git `user.name` → `user.email`** → `'unknown'`. The `co-engram init` CLI also uses git identity when `--created-by` and `CO_ENGRAM_DEFAULT_CREATED_BY` are both unset (replacing the previous `$USER` fallback). Gracefully degrades when git is missing, the binary times out (2s), or both configs are empty — returns `undefined` without throwing.
- **Default language flipped to `zh` (`@co-engram/core`)**: `DEFAULT_LANGUAGE` is now `'zh'` (was `'en'`). Chinese teams get a Chinese viewer UI, Chinese tool descriptions, and Chinese prompt sections out of the box; international teams set `CO_ENGRAM_LANGUAGE=en` or `language: 'en'` in `.co-engram/config.json`. `parseLanguage` now falls back to `'zh'` for unrecognized values.
- **Bilingual disk format for engram + synapse files (`@co-engram/core`)**: when `language='zh'`, engram files are written with body on top and Chinese-keyed YAML frontmatter below an HTML comment marker (`<!-- co-engram-meta:zh -->`), and synapse YAML files use Chinese top-level + nested keys (`标题` / `类型` / `证据[].描述` etc.). Enum values (`fact`, `active`, `extends`, …) stay English so the TypeScript literal unions keep working. The old English top-frontmatter format is read forever — parser auto-detects via `__语言: zh` marker, HTML comment, or top `---`.
- **Auto-migration on first launch (`@co-engram/core`)**: `EngramRepository.migrateFormat(targetLanguage)` rewrites all engram + synapse files to the target format. Both host adapters (`@co-engram/claude-code-mcp`, `@co-engram/openclaw`) call this on startup when `TeamMemoryConfig.migratedToLanguage !== language`. Migration is idempotent — files already in the target format are skipped. `migratedToLanguage` is persisted to `.co-engram/config.json` after migration.

### Added

- **Claude Code auto-memory → co-engram sync (`@co-engram/claude-code`)**: when Claude Code writes new `user` / `feedback` / `project` / `reference` / `pattern` memories under `~/.claude/projects/<encoded-cwd>/memory/*.md`, the MCP server now watches that directory and mirrors every memory into the team repo as an engram — no manual `engram_create` needed. On by default (low-friction). Each mirror carries `domainTag` `claude-code-auto-memory` + `encodingContext` `claude-code-auto-memory:<slug>` for idempotency: edits to the source memory update the engram's content (preserving reinforcement/decay stats), and renames map cleanly. The `MEMORY.md` index file is intentionally skipped. Disable with `CO_ENGRAM_AUTO_MEMORY_SYNC=0` or `autoMemorySync.enabled=false` in `.co-engram/config.json`. OpenClaw has no equivalent auto-memory writer, so the watcher is claude-code-mcp only.
- **Per-edge synapse storage (`@co-engram/core`)**: each synapse is now a first-class entity with its own file at `synapses/{kind}/syn-{hash}.yaml`, keyed by a deterministic hash of `(from, to, kind, direction)`. Duplicate edges are idempotent (evidence merges into the existing file); pruning a stale edge is a single file delete.
- **Single-file engram storage with ULID stable IDs (`@co-engram/core`)**: each engram is one Markdown file at `<domainTags>/<slug>.md` with YAML frontmatter and body. The engram ID is a ULID that is decoupled from the file path, so renames, moves, and rewrites never break synapse references. Content diffs stay clean in Git while metadata evolves independently.
- **Self-healing `engram_doctor` scan (`@co-engram/core`)**: detects moved files, renamed titles, orphan markdown, and dangling references; auto-fixes what it safely can (moved files / renamed titles / missing files) and reports the rest (slug conflicts / orphan markdown / dangling synapses) for manual review.
- **Progressive directory disclosure via `engram_list_paths` (`@co-engram/core`)**: returns the directory tree of the data root with cumulative `engramCount` per subtree, so an LLM can see where work is concentrated before deciding to search.
- **OpenClaw memory plugin integration (`@co-engram/openclaw`)**: Co-Engram is now a primary `kind: "memory"` plugin, mutually exclusive with `memory-core`. Adds two host-compatible wrappers (`memory_search`, `memory_get`) that hide Co-Engram internal terminology and expose a simplified schema (`query`/`maxResults`/`minScore`, `id`). Full tool count under `@co-engram/openclaw` is now 29 (27 native + 2 `memory_*`).
- **Self-evolving prompt section via `registerMemoryCapability.promptBuilder`**: every turn the plugin injects a "## Memory Recall (co-engram)" section into the agent system prompt with three layers: (1) base guidance on when to call/skip `memory_search` and how to read `truthScore`, (2) proposal count reminder when the proposal engine has pending candidates, (3) signals from `<dataRoot>/.co-engram/prompt-signals.json`.
- **Prompt signals cache (`@co-engram/core`)**: new `prompt-signals` module (`computePromptSignals` / `readPromptSignals` / `writePromptSignals`) with a `PromptSignalSnapshot` type. The maintenance `light` stage now computes the snapshot and persists it every 5 minutes (skipped when `dataRoot` is unset).
- **RPE-driven `lowConfidenceTopics`**: tags whose engrams have `confidence < 0.4` AND `retrievalCount ≥ 2` are surfaced to the LLM as "verify before citing". This is the first RPE feedback signal that actually reaches the prompt layer.
- **i18n for memory tools and prompt section**: 8 new `prompt.memory.*` translation keys (`section_header`, `when_to_search`, `when_not_to_search`, `reading_results`, `proposal_reminder`, `frequent_topics`, `missed_topics`, `low_confidence_topics`) plus `tool.memory_search` / `tool.memory_get` descriptions, with full `en` and `zh` dictionaries.
- **LLM-friendly bilingual descriptions for repository-health tools (`@co-engram/claude-code`)**: `engram_doctor` and `engram_list_paths` are now covered by `LLM_TOOL_DESCRIPTIONS`, giving them the structured `WHEN TO CALL / WHEN NOT TO CALL / RETURNS` format in English plus a full Chinese mirror. The full profile (`PROFILE_TOOL_COUNTS.full`) now counts these tools, bringing the total from 25 → 27. The audit gate (`auditDescriptionQuality`) blocks developer jargon (`FTS`, `Hebbian`, `RPE`, `reinforcementScore`, …) from leaking into LLM-visible descriptions.
- **First-run onboarding hints in MCP startup (`@co-engram/claude-code`)**: when the data root is empty or freshly created, the server emits actionable stderr hints instead of a bare `Loaded 0 engrams` line. New `dataRootAutoCreated` flag on `createCoEngramMcpServer` result signals when the directory was auto-mkdir'd, so hosts can surface the right "run `co-engram init` next" nudge.
- **Profile warning lists valid values (`@co-engram/claude-code`)**: unknown `CO_ENGRAM_TOOLS_PROFILE` values now produce `Unknown CO_ENGRAM_TOOLS_PROFILE="bogus" (valid: minimal | standard | full), falling back to "standard"` instead of the previous terse message, so users can self-recover without consulting docs.
- **Shared LLM descriptions across hosts (`@co-engram/core`)**: `LLM_TOOL_DESCRIPTIONS`, `resolveLlmDescription`, `overrideDescription`, and `auditDescriptionQuality` moved from `@co-engram/claude-code-mcp/src/tool-descriptions.ts` to `@co-engram/core/src/tools/llm-descriptions.ts`. The OpenClaw adapter now resolves through the same two-tier lookup (LLM dict → core i18n fallback) as MCP, so Claude Code users and OpenClaw users see identical structured "WHEN TO CALL / RETURNS" descriptions for the 16 covered tools. The MCP package re-exports the symbols for backwards compatibility.
- **Doctor report and repository-health tool errors are now English (international-friendly)**: `engram_doctor` issue messages (`moved_file`, `missing_file`, `dangling_synapse`, `orphan_markdown`, `title_changed`, `slug_conflict`) and the `engram_doctor` / `engram_list_paths` repository-missing error messages are now English, consistent with the rest of the storage layer. The LLM reads `issues[].message` to explain findings to the user; English messages avoid confusing international users. Default `tool.description` strings in the doctor/list_paths modules are also English; LLM-friendly overrides in `LLM_TOOL_DESCRIPTIONS` remain bilingual.
- **Tests**: 69 new tests across `prompt-signals` (11), `prompt-builder` (26), `memory-tools` (32). Plus 245 storage tests across `synapse-id` / `slugify` / `engram-store` / `synapse-store` / `engram-index` / `repository` / `doctor-tools` and 15 new MCP/OpenClaw end-to-end tests verifying `engram_doctor` + `engram_list_paths` work through the host adapters, that their descriptions localize correctly under both `language=en` and `language=zh`, that `dataRootAutoCreated` is reported correctly, and that error/issue messages are English. OpenClaw i18n tests updated to assert the new LLM-friendly description resolution.
- **Manual stdio smoke script (`@co-engram/claude-code`)**: `packages/claude-code-mcp/test/manual/mcp-smoke-user-flow.mjs` spawns a real `co-engram-mcp` subprocess, connects via `StdioClientTransport`, and walks through a realistic user workflow (create without `createdBy`, search, reinforce, synapse, doctor, close_learning_loop, list_paths). Exposes the bug class "MCP tool returns `isError=true` but client `JSON.parse`s the error message as if it were content" via the new `callToolOrThrow` helper — this is exactly the failure mode Claude Code would see if an LLM tries to call a tool outside the active profile.

### Changed

- `openclaw.plugin.json` now declares `"kind": "memory"` and adds `memory_search` / `memory_get` to `contracts.tools`.
- Maintenance engine `light` stage writes `prompt-signals.json` when `dataRoot` is provided, and reports `promptSignalsUpdated: boolean` in `MaintenanceReport`.
- Both `createCoEngramMcpServer` (`@co-engram/claude-code`) and `createCoEngramContext` (`@co-engram/openclaw`) now construct the single-file `EngramRepository` and inject it into `ToolContext.repository`.
- Viewer `GET /api/graph` now returns edges with full metadata (`id`, `weight`, `evidenceCount`, `direction`, optional `resolutionStatus`) and nodes with optional `slug` for human-friendly display instead of raw IDs.
- `EngramRepository.listEngramIndex()` is now public, exposing the complete index entries (slug / domainTags / mtime / contentHash) for external tools and the viewer.

### Added

- Viewer endpoint `GET /api/path-tree?maxDepth=` — renders the `listPathTree()` directory tree for progressive disclosure. Returns `{ enabled: false, root: null }` when the repository is unavailable, so callers can degrade gracefully.
- Viewer endpoint `GET /api/doctor?incremental=` — runs a self-healing scan on demand and returns the report (started/finished timestamps, total counts, auto-fixes applied, items pending manual review). Same `enabled` flag pattern.

### Fixed

- `engram_doctor` and `engram_list_paths` no longer throw when called through the MCP server or the OpenClaw plugin — the host adapters now inject the repository by default.
- `EngramRepository.listPathTree()` now returns root node with `path: '/'` (was empty string), matching POSIX path conventions and making the output friendlier for LLM consumption.
- **`CO_ENGRAM_DEFAULT_CREATED_BY` environment variable is now actually read** (previously documented but silently ignored). The MCP server resolves `createdBy` default with priority: env `CO_ENGRAM_DEFAULT_CREATED_BY` > `team-memory.json` persisted config's `defaultCreatedBy` > fallback to `'unknown'`. As part of the same fix, `engram_create` / `synapse_create` `createdBy` field changed from required to optional, with the resolved default injected through `ToolContext.defaultCreatedBy`. The OpenClaw adapter already had this wiring through its config schema (`defaultCreatedBy`, default `'openclaw'`); it now correctly forwards the value into `ToolContext`. Dedupe `UPDATE` path also uses the resolved value as `mergedBy`. New helper `getDefaultCreatedByFromEnv()` is exported from `@co-engram/claude-code` for host integrators.
- **`invalidateSearchIndex` is no longer a no-op** — previously after `engram_create` / `engram_update` / `engram_delete`, the in-memory `SearchOrchestrator` index was stale (a startup snapshot), so the LLM would immediately search for a just-created engram and get zero hits, falsely concluding the write failed. The function now rebuilds the index from `repository.listEngrams()` on every write. Cost is O(N) per write (acceptable for N < 10k); a future release will switch to incremental updates.
- **`standard` tool profile now includes `engram_doctor` and `engram_list_paths`** (count 14 → 16). Previously these were locked to `full` profile despite being core user-facing features (self-healing scan + progressive directory disclosure). The LLM under default profile can now call them directly without reconfiguring.

## [0.1.0] - 2026-06-21

### Summary

First public release. 22 tools, 1039 tests, 18k LOC of non-test TypeScript. Stable core with Claude Code (MCP) and OpenClaw (plugin) adapters. Automatic maintenance engine (light/deep/rem stages).

### Added

- **Core (`@co-engram/core`)**: engram lifecycle (create/get/update/delete/search/list/reinforce/report_failure/archive/restore/forget/recompute_importance), synapse graph (create/get/list/delete), skills (get/invoke), learning loop (close_learning_loop/contradiction_resolve/upgrade_verification/get_evolution_lineage)
- **Retrieval**: in-memory full-text search (CJK bigram + English word tokenizers) over a `digest.jsonl` catalog, graph traversal via synapse edges, multi-factor scoring (relevance/recency/importance/reinforcement)
- **Maintenance engine**: `light` stage (RPE-based reinforcement), `deep` stage (consolidation + Ebbinghaus decay), `rem` stage (metacognition with 5-dimension truth scoring)
- **Signals**: `FileSignalSink` (JSONL), 6 behavioral extraction rules, RPE computation
- **Verification**: 5-dimension metacognition (cross-context/time-stable/mutually-supported/source-reliable/executable), state machine with `force` override
- **Claude Code adapter (`@co-engram/claude-code`)**: MCP server with stdio transport, env-var-based maintenance config
- **OpenClaw adapter (`@co-engram/openclaw`)**: plugin SDK entry, manifest config schema, `contracts.tools` declaration for all 22 tools
- **E2E tests (`@co-engram/e2e`)**: dual-host consistency, maintenance scenarios, signal persistence
- **Documentation**: bilingual README (English + 中文), 10 deep-dive docs, 3 runnable examples
- **Community**: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, GitHub Actions CI, issue/PR templates

### Known Limitations

- `skill_invoke` is a framework only — concrete template execution (tool-sequences, prompt-templates) lands in a future release
- REM abstraction stage uses LocalHeuristic only — LLM-driven abstraction is planned but optional
- No Web UI — use Git/GitHub to browse the data repo
- No auto-generated tool reference from TSDoc — hand-written `docs/tool-reference.md` instead

### Breaking Changes

None (first release).

[Unreleased]: https://github.com/co-engram/co-engram/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/co-engram/co-engram/releases/tag/v0.1.0
