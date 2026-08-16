# Claude Code MCP Memory Integration Design

**Date:** 2026-06-21
**Status:** Spec — pending implementation
**Scope:** `@co-engram/claude-code-mcp` package, plus minor core refactor

## Context

The OpenClaw integration ([sibling spec](./2026-06-21-openclaw-memory-plugin-integration-design.md)) is complete: `kind: "memory"` plugin, `registerMemoryCapability.promptBuilder`, self-evolving prompt signals, 1317 tests green.

The Claude Code MCP package is **functionally behind**. Investigation found:

- **No system prompt injection.** MCP server never returns `serverInfo.instructions` — Claude Code has no idea when to call `engram_search`.
- **No dynamic prompts.** No `prompts/list` / `prompts/get`. User cannot manually trigger a structured recall via slash command.
- **No resources.** No `resources/list` / `resources/templates`. LLM cannot pull full engram content via URI reference.
- **No self-evolving signals.** `<dataRoot>/.co-engram/prompt-signals.json` is written by the maintenance engine but never read back by the MCP server.
- **Startup logging is minimal.** Only proposal-pending notifications; no stats / top tags banner.
- **Existing i18n + 25 native tools work fine** — that part of the integration is solid.

### Hard protocol constraints (verified by research)

1. **MCP has no "server-pushed → client-merged into system prompt" channel.** `instructions` is the only path into the LLM system prompt.
2. **`serverInfo.instructions` is static.** Read once during `initialize`. 2KB hard truncation. No mid-session refresh.
3. **The closest equivalent to `promptBuilder` is Claude Code's `UserPromptSubmit` hook + `mcp_tool` type** — returns `additionalContext` per turn. Requires user-side `~/.claude/hooks.json` config, not part of MCP.
4. **`SessionStart` hook is unreliable** — MCP server may not be connected when it fires.

### Why we are NOT implementing `memory_search` / `memory_get` wrappers

Unlike OpenClaw, where `memory_search` is a **protocol trigger** (the OpenClaw core sees this name and activates the memory plugin contract), in Claude Code / MCP the tool name has no protocol meaning. Adding `memory_search` alongside `engram_search` would only create LLM decision ambiguity ("which of these two similar tools do I pick?"). Claude Code users keep using `engram_search` directly.

## User decisions (confirmed)

| Decision point                           | Choice                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| Improvement scope                        | **C — full** (instructions + hook + prompts + resources)       |
| `memory_search` / `memory_get` wrappers  | **Not implemented** (Claude Code has no protocol use for them) |
| `prompts/list` registrations             | **3 prompts** (recall / stats / review-proposals)              |
| `UserPromptSubmit` hook default behavior | **Opt-in** (`co-engram init` asks, defaults to "no")           |

## Design

### Architecture overview

```
Claude Code ──initialize──→ MCP server
           ←──serverInfo.instructions (static, ≤2KB)
                                 base引导 + prompt-signals.json 快照
           ←──tools/list (14 of 25, filtered by profile)
           ←──prompts/list (3 new)
           ←──resources/templates + resources/list (new)

Claude Code ──UserPromptSubmit hook (if configured)──→ __coengram_session_prompt tool
           ←──additionalContext (dynamic)
                                 base + current signals + proposal reminder
```

### Tool exposure strategy (new — major design)

**Problem:** All 25 tools exposed to LLM = decision fatigue + token waste + noise from internal/admin tools the LLM should never call autonomously (`engram_archive`, `engram_recompute_importance`, `skill_invoke`, etc.).

**Solution:** Adapter-layer filtering. `@co-engram/core` keeps all 25 tool definitions unchanged. `@co-engram/claude-code-mcp` exposes a curated subset based on a **profile**. `@co-engram/openclaw` keeps its 27-tool manifest contract untouched.

**Profiles:**

| Profile              | Count | Tools                                                                                                                                         | Audience                                          |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `minimal`            | 8     | engram_search, engram_get, engram_create, engram_update, engram_list, synapse_create, engram_reinforce, engram_report_failure                 | Pure memory consumers; no maintenance involvement |
| `standard` (default) | 14    | minimal 8 + engram_delete, close_learning_loop, contradiction_resolve, engram_list_proposals, engram_accept_proposal, engram_dismiss_proposal | Mainstream developers                             |
| `full`               | 25    | All native tools                                                                                                                              | Debugging / co-engram contributors                |

**Hidden from all profiles (internal/admin only, 11 tools):**

| Tool                           | Hidden because                                                    |
| ------------------------------ | ----------------------------------------------------------------- |
| `engram_archive`               | Maintenance engine `rem` stage auto-archives; user CLI for manual |
| `engram_restore`               | Dangerous recovery op; user CLI only                              |
| `engram_forget`                | Permanent delete; user CLI only                                   |
| `engram_recompute_importance`  | Maintenance engine `deep` stage                                   |
| `synapse_get` / `synapse_list` | LLM uses `engram_get(id, tier: 'synapses')` instead               |
| `synapse_delete`               | Graph mutation; user CLI                                          |
| `skill_get` / `skill_invoke`   | Skill framework is scaffolding-only in v1; no real capability yet |
| `upgrade_verification`         | Maintenance engine `rem` stage                                    |
| `get_evolution_lineage`        | Debugging/visualization only                                      |

The 11 hidden tools are still registered in core (`createToolRegistry()` returns all 25), just **not forwarded** to MCP `tools/list`. They remain accessible via CLI and OpenClaw adapter.

**Profile selection flow:**

1. **Default**: `standard` (14 tools)
2. **Env override**: `CO_ENGRAM_TOOLS_PROFILE=minimal|standard|full` takes precedence
3. **Persisted config**: `co-engram init` writes user choice to `<dataRoot>/.co-engram/config.json` under `toolsProfile` key (same file as `language` persistence)
4. **Resolution order**: env > persisted config > default

**`co-engram init` interactive prompt:**

```
? Tool exposure profile (affects how many tools LLM sees):
  ❯ standard — 14 tools (recommended, mainstream developers)
    minimal  — 8 tools (pure memory consumers)
    full     — 25 tools (debugging / co-engram contributors)
```

**Implementation:**

- New file `packages/claude-code-mcp/src/tool-profile.ts`:
  - `type ToolProfile = 'minimal' | 'standard' | 'full'`
  - `PROFILE_TOOL_SETS: Record<ToolProfile, ReadonlySet<string>>`
  - `resolveProfile(env, persistedConfig): ToolProfile`
  - `filterToolsByProfile(tools, profile): Tool[]`
- Modified `packages/claude-code-mcp/src/register.ts`:
  - Accept `profile` option, call `filterToolsByProfile` before MCP registration
- Modified `packages/claude-code-mcp/src/mcp-server.ts`:
  - Read env / persisted config, resolve profile, log chosen profile on startup
- Modified `packages/claude-code-mcp/src/cli.ts`:
  - Add profile question to `init` flow, persist to config.json

**OpenClaw unchanged:** `@co-engram/openclaw` does not read profile; manifest `contracts.tools` stays at 27 (25 native + 2 memory\_\* wrappers). Profile is a Claude Code MCP optimization only.

### Tool description quality (LLM-facing override)

**Problem (verified):** Current `tool.*` i18n values are written for developers, not LLMs. Examples from `packages/core/src/i18n/en.ts`:

- `tool.engram_search`: `"FTS full-text search (Chinese bigram + English word), with optional filters."` — LLM has no idea when to call this
- `tool.engram_reinforce`: `"Report an effective retrieval (LTP reinforcement + Hebbian neighbor boost). Updates effectiveRetrievals / reinforcementScore / importance (each += effectiveness × 0.02, clamped to [0,1]); neighbors get 50% boost (except contradicts)."` — implementation detail, irrelevant to LLM decision
- `tool.engram_create`: `"Create a new Engram (memory unit). Requires title / content / kind / domainTags / createdBy. Smart dedupe is on by default..."` — better, but still lacks "when to call" guidance

These descriptions work for OpenClaw's manifest contract (rigorous spec), but cripple Claude Code LLM decision quality.

**Solution:** Add an **LLM-facing description override** layer in `@co-engram/claude-code-mcp`. Core i18n stays unchanged (OpenClaw continues to use it). MCP adapter rewrites the `description` field of each registered tool with LLM-optimized text.

**New file:** `packages/claude-code-mcp/src/tool-descriptions.ts`

Structure: for each of the 14 `standard`-profile tools, provide an object:

```typescript
{
  en: `Search team memory for past decisions, preferences, project context.

WHEN TO CALL:
- User references past work ("we decided", "previously", "last time")
- User mentions preferences ("I prefer", "I always use")
- User asks about project history ("why does X exist", "who decided")
- Encountering a bug that may have been seen before

WHEN NOT TO CALL:
- Pure code questions unrelated to team history
- General programming knowledge
- Simple greetings

RETURNS: Top N engrams with title, summary, score, tags.
Use engram_get for full content on specific hits.`,
  zh: `...对应中文...`
}
```

**Quality bar for each description:**

1. **Starts with one-line summary** — what it does, in plain language
2. **WHEN TO CALL section** — 3-5 concrete trigger patterns (quoted user phrases work well)
3. **WHEN NOT TO CALL section** — 2-3 anti-patterns to prevent over-calling
4. **RETURNS section** — what the result looks like, so LLM knows what to do next
5. **No implementation detail** — no algorithm names, no formula, no internal field names (`effectiveRetrievals`, `RPE`, etc.)
6. **Length** — 150-300 chars per description; longer than current but still token-cheap

**Coverage:** Only the 14 standard-profile tools need override. Hidden tools (archive/restore/forget/recompute/synapse*\*/skill*\*/upgrade_verification/get_evolution_lineage) keep core description since they're not exposed to LLM anyway. `full` profile users (debugging) see the original developer-facing descriptions.

**i18n:** Both `en` and `zh` versions required. New keys added under `packages/claude-code-mcp/src/tool-descriptions.ts` (local to this package, not in core — core i18n stays focused on tool spec, not LLM coaxing).

**Integration:**

- `packages/claude-code-mcp/src/register.ts`: after `filterToolsByProfile`, map each tool through `overrideDescription(tool, language)` before passing to MCP server
- `localizeToolDescription()` in core continues to be the fallback for tools not in the override map

**Expected effect:** LLM `engram_search` invocation rate on relevant queries should jump from near-zero (current, because description is opaque) to majority of qualifying user queries.

### Component design

#### 1. `serverInfo.instructions` (static, MVP layer)

**File:** `packages/claude-code-mcp/src/instructions.ts` (new)

- Read once at server startup.
- Content layers (same as OpenClaw promptBuilder):
  1. `prompt.memory.section_header`
  2. `prompt.memory.when_to_search`
  3. `prompt.memory.when_not_to_search`
  4. `prompt.memory.reading_results`
  5. (conditional) `prompt.memory.frequent_topics` — from `signals.topTags`
  6. (conditional) `prompt.memory.low_confidence_topics` — from `signals.lowConfidenceTopics`
- Read `<dataRoot>/.co-engram/prompt-signals.json` via `readPromptSignals()`. If missing/corrupt, skip layers 5-6.
- **Hard 2KB budget.** Truncation priority (highest to lowest, drop later items first when budget tight): 1 (header) → 2 (when_to_search) → 3 (when_not_to_search) → 4 (reading_results) → 5 (frequent_topics) → 6 (low_confidence_topics). Never partially cut a translation key — drop whole keys.
- i18n: reuse `translatePrompt(language, 'prompt.memory.*')` from `@co-engram/core` (same dictionary OpenClaw uses).
- Return `string` (newlines between sections).

**Why static is acceptable:** signals snapshot refreshes every 5 min via maintenance light stage. Claude Code restart picks up the new snapshot. For per-turn refresh, see component 2.

#### 2. `__coengram_session_prompt` tool (dynamic, hook-driven)

**File:** `packages/claude-code-mcp/src/session-prompt-tool.ts` (new)

- **Not exposed in `tools/list`** — registered via direct MCP server tool registration with `_`-prefix convention so LLM never sees it. Hook config explicitly names it.
- Inputs:
  - `userQuery?: string` (optional, the current user prompt — used to filter relevant engrams, but **no heavy search**; just tag-matching to highlight relevant top tags)
- Output: `string` (injected into `additionalContext` by the hook)
- Internally:
  - Re-read `prompt-signals.json` (cheap, fs cache)
  - Call `proposalEngine.listPending()` for dynamic proposal count
  - Build prompt via **shared** `buildCoEngramMemoryPrompt` (refactored to `@co-engram/core/prompt-builder`)
- If `userQuery` provided AND any `lowConfidenceTopic` appears as a whole-word substring (case-insensitive) in the query, prepend a one-line "this query touches a shaky area (matched: <tag>), verify before citing" note. Match rule: split both on whitespace/punctuation, check tag-set intersection.

#### 3. `prompts/list` + `prompts/get` (3 prompts)

**File:** `packages/claude-code-mcp/src/prompts.ts` (new)

| Prompt name                  | Args                                                          | Returns                                                                      | Purpose                                              |
| ---------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `co-engram-recall`           | `query: string` (required), `maxResults?: number` (default 5) | Markdown: top N engrams with title + summary + score + engram id             | User-facing "search and summarize" via slash command |
| `co-engram-stats`            | (none)                                                        | Markdown: total count, top tags, low-confidence topics, proposal count       | "State of memory" overview                           |
| `co-engram-review-proposals` | (none)                                                        | Markdown: list of pending proposals with title + similarity + sample message | Quick triage of implicit-capture candidates          |

Implementation:

- Each prompt returns `GetPromptResult` with `messages: [{ role: 'user', content: { type: 'text', text: ... } }]`
- Text content is the structured markdown
- i18n: new keys required in `packages/core/src/i18n/{en,zh}.ts`:
  - `prompt.memory.commands.recall_title`
  - `prompt.memory.commands.recall_empty` (when no hits)
  - `prompt.memory.commands.stats_title`
  - `prompt.memory.commands.review_title`
  - `prompt.memory.commands.review_empty` (when no pending proposals)
  - Shared with OpenClaw if it later adds equivalent slash commands (future-proof)

#### 4. `resources/list` + `resources/templates`

**File:** `packages/claude-code-mcp/src/resources.ts` (new)

- **Templates:**
  - `engram:///{id}` — returns full engram (content + meta merged as markdown)
  - Description: "Full content + metadata of a single engram by ID"
- **Static list (`resources/list`):**
  - Returns the 10 most recently updated engrams as `engram:///<id>` resources
  - Each with `name` (title), `description` (summary), `uri`
- LLM can reference via `@engram://testing/2026-06-21/foo` — Claude Code resolves via `resources/read`
- Security: no validation at registration time; non-existent id returns MCP error on read (protocol-standard behavior)

#### 5. Shared prompt builder refactor

**Move:** `packages/openclaw-plugin/src/prompt-builder.ts` → `packages/core/src/prompt-builder/`

- New module: `@co-engram/core/prompt-builder`
- Exports: `buildCoEngramMemoryPrompt`, `createCoEngramPromptBuilder`, types
- `@co-engram/openclaw` re-exports from core (one-line barrel, no breaking change for existing OpenClaw plugin users)
- `@co-engram/claude-code-mcp` imports from core directly

**Rationale:** instructions (static) and session-prompt-tool (dynamic) both need the same prompt assembly logic. Without sharing, we'd duplicate ~150 LOC and risk drift.

#### 6. `co-engram init` hook opt-in

**File:** `packages/claude-code-mcp/src/cli.ts` (modified)

- New interactive question (after existing data-root setup):
  > "Configure Claude Code's `UserPromptSubmit` hook to enable per-turn dynamic memory injection? (y/N)"
- Default: **N** (non-invasive)
- If `y`:
  1. Locate `~/.claude/hooks.json` (create if missing)
  2. Merge — only modify `UserPromptSubmit` entries that reference this MCP server; preserve everything else
  3. Show diff to user, require final confirmation
  4. Write file
  5. Inform user they need to restart Claude Code for the hook to take effect
- Hook config written:
  ```json
  {
    "hooks": {
      "UserPromptSubmit": [
        {
          "hooks": [
            {
              "type": "mcp_tool",
              "server_name": "co-engram",
              "tool_name": "__coengram_session_prompt",
              "result_key": "additionalContext"
            }
          ]
        }
      ]
    }
  }
  ```
- Server name detection: read from the active MCP client config (or default to `co-engram`).

#### 7. Startup logging extension

**File:** `packages/claude-code-mcp/src/mcp-server.ts` (modified)

- After `initialize`, send a `notifications/logging` message with:
  - Total engram count
  - Top 3 tags (from prompt-signals.json if available)
  - Pending proposal count
  - Hook configuration status (detected via heuristic — check `~/.claude/hooks.json` for `__coengram_session_prompt` reference)
- i18n via `translatePrompt`

## File changes summary

| Type       | Path                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New module | `packages/core/src/prompt-builder/{index,types,builder}.ts` (moved logic)                                                                                                   |
| Modified   | `packages/openclaw-plugin/src/prompt-builder.ts` → thin re-export from core (existing tests stay green; tests focus on OpenClaw adapter concerns, not pure prompt assembly) |
| New        | `packages/claude-code-mcp/src/instructions.ts`                                                                                                                              |
| New        | `packages/claude-code-mcp/src/prompts.ts`                                                                                                                                   |
| New        | `packages/claude-code-mcp/src/resources.ts`                                                                                                                                 |
| New        | `packages/claude-code-mcp/src/session-prompt-tool.ts`                                                                                                                       |
| New        | `packages/claude-code-mcp/src/tool-profile.ts` (profile definitions + filtering)                                                                                            |
| New        | `packages/claude-code-mcp/src/tool-descriptions.ts` (LLM-facing description overrides for 14 standard tools, en+zh)                                                         |
| Modified   | `packages/claude-code-mcp/src/mcp-server.ts` (register new capabilities + extended logging + profile resolution)                                                            |
| Modified   | `packages/claude-code-mcp/src/register.ts` (apply profile filter before MCP registration)                                                                                   |
| Modified   | `packages/claude-code-mcp/src/cli.ts` (init hook opt-in + profile question + persist to config.json)                                                                        |
| Modified   | `packages/claude-code-mcp/src/index.ts` (export new modules)                                                                                                                |
| New tests  | `packages/claude-code-mcp/test/{instructions,prompts,resources,session-prompt-tool,hook-init,tool-profile,tool-descriptions}.test.ts`                                       |
| New tests  | `packages/core/test/prompt-builder.test.ts` (pure-function unit tests moved here)                                                                                           |
| Modified   | `packages/core/src/i18n/{en,zh}.ts` (add `prompt.memory.commands.*` keys)                                                                                                   |
| Docs       | `docs/host-claude-code.md`, `README.md`, `README.zh.md`, `CHANGELOG.md`                                                                                                  |

Total: ~10 new files, ~5 modified files.

## Verification

### Local verification

```bash
cd /home/10192021@zte.intra/AIOS/co-engram

# 1. Build + tests green
pnpm install
pnpm -r build
pnpm -r test
# Expected: 1317 + ~55 new tests = ~1372 passing, no regression

# 2. Profile filtering works
CO_ENGRAM_TOOLS_PROFILE=minimal co-engram-mcp &
# In Claude Code /mcp: should show 8 tools, not 25
CO_ENGRAM_TOOLS_PROFILE=full co-engram-mcp &
# Should show 25 tools

# 2. instructions content ≤2KB
pnpm --filter @co-engram/claude-code-mcp exec node -e "
  import('./dist/instructions.js').then(({ buildInstructions }) =>
    buildInstructions({ dataRoot: process.env.HOME + '/team-memory', language: 'en' })
      .then(s => console.log('len:', s.length, 'budget ok:', s.length <= 2000))
  )
"

# 3. Manual smoke test against real Claude Code
cd ~/team-memory
co-engram-mcp &
# In Claude Code: /mcp → co-engram should show 25 tools + 3 prompts + resources
# Type a query → if hook configured, should see additionalContext in transcript
```

### Integration proof

- Start MCP server with `CO_ENGRAM_DATA_ROOT=/tmp/test-memory`
- Connect via MCP inspector (npx @modelcontextprotocol/inspect)
- Verify:
  - `initialize` response contains `instructions` field ≤2KB
  - `prompts/list` returns 3 prompts
  - `prompts/get` with `co-engram-recall` + args returns markdown
  - `resources/list` returns engram URIs
  - `resources/templates` returns the `engram:///{id}` template
  - `tools/call __coengram_session_prompt` returns dynamic prompt string

### Hook integration proof (optional, requires real Claude Code)

- Run `co-engram init`, answer `y` to hook question
- Verify `~/.claude/hooks.json` contains the expected entry
- Start new Claude Code session, send a message
- Inspect transcript — `additionalContext` should appear with current signals

## Risks and mitigations

1. **`instructions` 2KB limit hit.** Truncation priority handles this; worst case = drop signals, keep base guidance only.
2. **`__coengram_session_prompt` leaks into `tools/list`.** Mitigated by underscore-prefix convention + explicit skip in tool registration loop. Add test asserting tool list does not contain it.
3. **Hook config breaks user's existing `~/.claude/hooks.json`.** Mitigated by merge-only semantics + diff confirmation + never overwriting unrelated keys. Add integration test with pre-existing hooks.
4. **Server name mismatch.** `co-engram init` writes `server_name: "co-engram"` but user's MCP config might use a different name. Mitigation: detect from `~/.config/claude-code/config.json` if available; fall back to `co-engram`; warn user if mismatch detected.
5. **`resources/list` returns stale data after writes.** Maintenance engine refreshes prompt-signals.json every 5 min; resources/list reads live from repository (always fresh). No issue.
6. **i18n drift between OpenClaw and Claude Code prompt sections.** Mitigated by shared `@co-engram/core/prompt-builder` — both hosts use the same `translatePrompt` dictionary.

## Open questions (defer to implementation)

1. Should `co-engram-review-proposals` prompt accept a `filter?: 'pending' | 'dismissed' | 'all'` arg? Default `'pending'`. (Probably yes; tiny cost.)
2. Should `resources/list` pagination be supported? (No — top 10 by `updatedAt` is enough for v1; add `?limit` later if needed.)
3. Should instructions include a "tools available" section listing `engram_search` / `engram_get`? (No — Claude Code already shows tool list; avoid duplication.)
