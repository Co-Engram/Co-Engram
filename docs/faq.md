# FAQ & Troubleshooting

## Common Issues

### Q: `claude mcp list` shows `✗ Failed to connect` for co-engram

The MCP server crashed on startup. Run it directly to see the error:

```bash
CO_ENGRAM_DATA_ROOT=$HOME/team-memory co-engram-mcp
```

Common causes:

- **Node version < 22** — check with `node --version`. MCP SDK requires Node 22+.
- **`CO_ENGRAM_DATA_ROOT` is relative** — must be an absolute path (e.g. `/home/you/team-memory`, not `~/team-memory` in some shells)
- **Data directory not a Git repo** — `cd ~/team-memory && git init`
- **Missing dependencies** (source build) — run `pnpm install` at repo root

### Q: `/mcp` shows 0 tools despite connection success

The OpenClaw manifest's `contracts.tools` array is missing tool names. If you built from source, verify `packages/openclaw-plugin/openclaw.plugin.json` lists all 29 entries (27 native + 2 `memory_*` wrappers). The loader silently drops undeclared tools. A manifest-sync test in `packages/openclaw-plugin/test/adapter.test.ts` guards this against drift.

### Q: A tool call returns `MCP error -32602: Tool <name> not found`

**First check whether your current profile exposes that tool.** The three profiles are defined in [`packages/claude-code-mcp/src/tool-profile.ts`](../packages/claude-code-mcp/src/tool-profile.ts) (`PROFILE_TOOL_SETS`):

| Profile              | Tools | Includes                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`            | 11    | engram_search / engram_get / engram_create / engram_update / engram_list / synapse_create / engram_reinforce / engram_report_failure / **engram_list_proposals / engram_accept_proposal / engram_dismiss_proposal** (proposal triage is included so the maintenance engine's auto-generated candidates can always be closed-loop handled) |
| `standard` (default) | 16    | everything in minimal + engram_delete / close_learning_loop / contradiction_resolve / engram_doctor / engram_list_paths                                                                                                                                                                                                                   |
| `full`               | 27    | all native tools                                                                                                                                                                                                                                                                                                                          |

`engram_list_paths` / `engram_doctor` are only available in standard and above; same for `close_learning_loop` / `contradiction_resolve`. **The proposal triad (`engram_list_proposals` / `engram_accept_proposal` / `engram_dismiss_proposal`) is exposed in every profile as of 2026-06** — by design, so candidates the maintenance engine auto-generates can always be triaged regardless of profile, preventing the "visible but unactionable" contradiction.

If you're on `minimal` profile and an instruction told you to call `engram_doctor` / `engram_list_paths` / `close_learning_loop` (which are filtered out), the server correctly returns "Tool not found" — this is expected, not a bug.

**Fix path**:

```bash
# Check current profile
cat ~/team-memory/.co-engram/config.json | grep toolsProfile

# Switch to standard (edit the config, or use the viewer config panel),
# then restart the MCP server
```

Or open the viewer config panel, change "Tools profile" to standard / full, and click the "Restart now" button.

### Q: Created an engram but `engram_search` doesn't find it

If you're running a recent version (≥ 1.x), `engram_create` automatically calls `invalidateSearchIndex` after every write, so new engrams show up in search immediately — no manual rebuild needed.

If you're on an older version, or if the search index looks corrupted, force a rebuild:

```bash
# Delete the derived cache — co-engram rebuilds it on next access
rm -rf ~/team-memory/.co-engram/

# Restart the MCP server (or run /mcp reload in Claude Code) so the
# in-memory FTS index is rebuilt from the refreshed digest.jsonl
```

If search still misses obvious keyword matches after a rebuild, double-check that your query terms actually appear in the engram's **content** (not just attached files or comments). The FTS index covers `title + summary + domainTags + contextTags`; `summary` defaults to the first 200 chars of `content` when not provided explicitly, so very long engrams whose key terms only appear past that window may not surface — provide an explicit `summary` argument in that case.

### Q: Maintenance engine logs are missing

Check that maintenance is actually enabled:

```bash
claude mcp get co-engram
# Verify CO_ENGRAM_MAINTENANCE=1 is in the env list
```

If missing, re-add the server with the env var:

```bash
claude mcp remove co-engram -s user
claude mcp add co-engram -e CO_ENGRAM_MAINTENANCE=1 ... -- co-engram-mcp
```

Maintenance logs go to stderr with `[maintenance]` prefix.

### Q: I changed "data root / audit / proposals / maintenance" in the viewer config panel, but it didn't take effect after restart

**Fixed (from this version):** PUT `/api/config` now writes the full config to **both** the runtime dataRoot and the bootstrap path (`env CO_ENGRAM_DATA_ROOT` or `$HOME/team-memory`). On restart, the bootstrap is read — regardless of whether the runtime path has diverged, the latest value is picked up.

**Manual restart still required:** These `desired*` fields are defined as "next-startup effective" — running instances cannot hot-swap them. Two ways to restart:

1. **"Restart now" button in the viewer** (appears after saving config panel): triggers `POST /api/restart`, the server exits gracefully (exit code 0), and the parent process (typically Claude Code) auto-restarts. Hover tooltip explains the impact (brief MCP tool disconnect, browser auto-refresh, no data loss).
2. **Manually restart Claude Code / MCP server**: same effect.

If the page doesn't recover within 30s after clicking the button, your parent process has no supervision — check whether Claude Code is managing this MCP server, or run `claude mcp restart co-engram` manually.

### Q: `engram_create` returns `status: "DUPLICATE"` when I expected `"NEW"`

The dedup logic found an existing engram with very similar content (cosine similarity > threshold). With `dedupe: true` (default), duplicates reinforce the original instead of creating a new one.

To force creation:

```
engram_create({ ..., dedupe: false })
```

Or modify the content enough to break similarity.

### Q: Reinforcement score is stuck at 0

Check the signal sink has events:

```bash
wc -l ~/team-memory/.co-engram/signals.jsonl
```

If 0, the agent isn't generating `ToolCallEvent`s. This happens when:

- The adapter doesn't inject `signalSink` into `ToolContext` (MCP and OpenClaw adapters do this automatically)
- The agent isn't actually calling co-engram tools (verify with `/mcp` showing tool calls)

If the file has events but scores don't update, the light stage may not be running. See [maintenance-engine.md](./maintenance-engine.md#troubleshooting).

### Q: My data repo has grown huge

Check what's taking space:

```bash
du -sh ~/team-memory/*
du -sh ~/team-memory/.co-engram/
du -sh ~/team-memory/.trash/ 2>/dev/null
```

If `.co-engram/` is huge, delete it — it's a rebuildable cache.

If the engram tree is huge, enable the trash sweep so forgotten engrams are quarantined:

```bash
# In your MCP env:
CO_ENGRAM_TRASH_ENABLED=1
CO_ENGRAM_TRASH_AFTER_DAYS=30         # move to .trash/ after 30 days forgotten
CO_ENGRAM_TRASH_PURGE_AFTER_DAYS=365  # physically delete after 1 year in trash
```

Forgotten engrams will then migrate to `.trash/YYYY-MM/` on the next deep maintenance cycle, keeping the active tree lean. Restoring is always possible via `engram_restore` — it will find the engram in `.trash/` automatically.

For extreme scale (>100k engrams), consider Git LFS or splitting into multiple data repos by domain.

### Q: I want to permanently delete a memory right now

You have three options, in order of caution:

1. **Forget (default):** call `engram_forget` — the engram stays on disk (Git-tracked) but is excluded from retrieval.
2. **Trash (recovery window):** enable `CO_ENGRAM_TRASH_ENABLED=1` — forgotten engrams move to `.trash/YYYY-MM/` after `CO_ENGRAM_TRASH_AFTER_DAYS`, and are purged after `CO_ENGRAM_TRASH_PURGE_AFTER_DAYS`.
3. **Immediate delete:** call `engram_delete` — removes the engram file and cleans up dangling synapses. Not recoverable except via Git history.

### Q: Can I use multiple data repos?

Yes. Each MCP server instance points at one `CO_ENGRAM_DATA_ROOT`. Run multiple servers with different names:

```bash
claude mcp add co-engram-work \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory-work \
  -- co-engram-mcp

claude mcp add co-engram-personal \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory-personal \
  -- co-engram-mcp
```

Tools will be namespaced as `mcp__co-engram-work__*` and `mcp__co-engram-personal__*`.

### Q: Can I sync my team-memory repo across machines?

Yes — it's a standard Git repo. Push to a private remote, clone elsewhere:

```bash
# On machine A
cd ~/team-memory
git remote add origin git@github.com:you/team-memory.git
git push -u origin main

# On machine B
git clone git@github.com:you/team-memory.git ~/team-memory
```

The `.co-engram/` cache will rebuild automatically on first search.

### Q: Does Co-Engram work offline?

Yes. All operations are local:

- FTS index is an in-memory inverted index built from `digest.jsonl` on every search
- LLM necessity evaluation is **optional** — when no provider is configured, the proposal engine uses the rule-based evaluator (zero LLM calls)
- Other LLM-driven features (REM abstraction) are planned but also optional — the engine skips them when no provider is configured

### Q: Why didn't my conversation generate a proposal?

The proposal engine uses **two-layer filtering** to suppress mechanical noise. Your conversation might have been rejected by one of the layers:

1. **Layer 1 prefilter** (zero-cost rules) rejects:
   - system role messages (not observed by design)
   - empty / punctuation-only content
   - short messages (user < 30 chars, assistant < 15 chars)
   - trivial-dominated content (> 60% trivial words, e.g. `ok ok ok`)
   - low information density (< 4 meaningful tokens after stopword removal)

2. **Layer 2 necessity evaluation** (before cluster promotion) rejects:
   - identical samples (5 retries of the same text)
   - high repetition (uniqueRatio < 0.5)
   - too-short samples (avg < 30 chars)
   - low-density samples (avg < 5 tokens)
   - 70%+ trivial samples

3. **Clustering failure**: hash embedder splits differently-worded samples into multiple clusters, none reaching `threshold=3`. Use more similar wording (shared keyword structure).

**Debug**: check `necessity_rejected` events in `~/team-memory/.co-engram/audit.jsonl`:

```bash
grep '"necessity_rejected"' ~/team-memory/.co-engram/audit.jsonl | tail -10
```

Each event carries `rule` + `reason` showing which rule rejected and why. Layer 1 prefilters (`noise_filtered`) are silently dropped — they fire per message and never reach audit. See [observability two-layer filtering](./observability.md#proposal-engine).

### Q: A proposal's `necessityReason` says `[llm-unavailable, rule-fallback]` — what does it mean?

The LLM evaluator was called but failed, and fell back to the rule-based evaluator. Common causes:

- The model configured in `~/.openclaw/openclaw.json` is a reasoning model (Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 etc.) and exhausted `max_tokens` in the reasoning phase, leaving `content` empty → upgrade to the latest version (the adapter falls back to `reasoning_content`)
- API key invalid / endpoint unreachable → test the endpoint directly with curl
- LLM didn't return valid JSON → switch to a model that reliably outputs JSON

The rule-based fallback keeps the proposal engine always-available, but you lose the LLM's semantic judgment and `suggestedTitle` draft.

### Q: How do I completely reset?

```bash
# Stop the MCP server (restart Claude Code after)
claude mcp remove co-engram -s user

# Delete data
rm -rf ~/team-memory/

# Uninstall
npm uninstall -g @co-engram/claude-code
```

## Performance

### Slow `engram_search`

For data repos >10k engrams:

- Allow the in-memory index to warm up — the first search after startup rebuilds it from `digest.jsonl` (~100ms per 1k engrams)
- Use `filter.domainTags` to narrow the search space
- Reduce `limit` (default 20 is usually enough)

### Slow maintenance runs

REM stage can be slow on large repos (it scores every engram). If it takes >30s:

- Reduce `CO_ENGRAM_MAINTENANCE_REM_INTERVAL_MS` (less frequent but same cost)
- Or disable REM: `CO_ENGRAM_MAINTENANCE_ENABLED_STAGES=light,deep`

## Getting Help

- [GitHub Issues](https://github.com/co-engram/co-engram/issues) — bug reports, feature requests
- [GitHub Discussions](https://github.com/co-engram/co-engram/discussions) — questions, usage help
- [SECURITY.md](../SECURITY.md) — for security-sensitive reports

When filing an issue, include:

- Co-Engram version (`npm list -g @co-engram/claude-code`)
- Node version (`node --version`)
- Host (Claude Code / OpenClaw / custom)
- Data repo size (`find ~/team-memory -name "*.md" -not -path "*/.co-engram/*" -not -path "*/.trash/*" | wc -l`)
- Relevant logs (run `co-engram-mcp` in foreground to capture stderr)
