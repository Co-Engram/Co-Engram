# Co-Engram × DeepSeek Harness (dsh)

Co-Engram ships a native Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): all 42 memory tools registered as native dsh tools (bare names, e.g. `engram_search`), plus a `memory:co-engram` system-prompt section whose signals (top tags / skill catalog / path overview / pending proposals) are re-evaluated on every prompt assembly.

## Install

```bash
# One-time: point co-engram at your data repo (shared across hosts)
npm install -g @co-engram/claude-code
mkdir -p $HOME/team-memory && cd $HOME/team-memory && git init
co-engram config data-root $HOME/team-memory

# Install the plugin into a dsh profile
dsh plugin --profile <name> add @co-engram/dsh
```

The package declares a `dsh.bundle` patch, so installation activates the plugin as a profile layer automatically — no manual `cordis.patch.yml` editing. Restart the profile (or reload the plugin) and the boot log shows:

```
[co-engram] dsh plugin active: 12 engrams, 42 tools registered (host=dsh-plugin)
```

## Configuration

All fields optional; defaults follow the low-friction philosophy (maintenance and proposals on, viewer follows the proposal engine).

| Field | Default | Description |
|---|---|---|
| `language` | `en` | Tool descriptions & prompt language (`zh` for Chinese) |
| `startMaintenance` | `true` | Background maintenance runtime (light/deep/REM stages) |
| `maintenanceConfig` | stage defaults | Maintenance tuning (intervals, learning rate, trash) |
| `auditEnabled` | `true` | Audit log (cross-host entries carry `host=dsh-plugin`) |
| `auditRotationConfig` | built-in defaults | Audit log rotation |
| `effectivenessEnabled` | `true` | Effectiveness tracking |
| `proposalEnabled` | `true` | Implicit-capture proposal engine |
| `proposalConfig` | built-in defaults | Proposal thresholds |
| `autoOnboardMergeDriver` | `true` | Auto-install the git merge driver into the data repo (idempotent) |
| `startViewer` | follows `proposalEnabled` | Web viewer (holder-gated, default port 18899) |
| `viewerToken` | — | Viewer auth token |
| `defaultCreatedBy` | git author | Fallback creator for write operations |

`dataRoot` is **not** a plugin field: all hosts share `~/.co-engram/config.json`, managed by `co-engram config data-root <path>`.

## Coexistence with other hosts

The plugin takes the same process lock as the Claude Code (MCP) and OpenClaw hosts. Whichever process is the holder runs background maintenance, audit rotation, file watching and the viewer; the others serve tool calls only. Run dsh and Claude Code against the same data repo simultaneously — that is the designed mode.

## Native plugin vs MCP bridge

dsh's official `@deepseek-ai/dsh-mcp-client` can also bridge the co-engram MCP server (`mcp__co-engram__*` tool names). Prefer the native plugin:

| | MCP bridge | native plugin |
|---|---|---|
| Tool names | `mcp__co-engram__*` | bare `engram_*` |
| Prompt guidance | MCP server instructions are not bridged by dsh — top tags / skills / path overview are lost | native dynamic section, re-evaluated per assembly |
| Claude Code hooks | the MCP entry auto-installs Claude Code hooks on your machine | no host-specific side effects |
| Prompts / resources MCP capabilities | not consumed by dsh | not applicable (native integration) |

## Not included in v0.1 (by design)

- `necessityLlm` / LLM-backed `engram_synthesize` client — the proposal engine falls back to the rule-based necessity evaluator; wire an LLM client in a later release.
- Startup-time `git pull` and language-format migration (host-entry rituals of the MCP path) — the repository watcher picks up external changes; run `git pull` in the data repo when syncing across machines.

## Troubleshooting

- **`Viewer failed to start: EADDRINUSE ... 18899`** — another holder (e.g. a Claude Code session) already runs the viewer. This is benign: tool service is unaffected; open the existing viewer instead.
- **Plugin loads but no tools** — check `dsh --profile <name> --dump-config` for the `co-engram` row and the boot log for the `[co-engram] dsh plugin active` banner.
