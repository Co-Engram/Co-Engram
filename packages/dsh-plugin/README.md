# @co-engram/dsh

English | [中文](README.zh.md)

[Co-Engram](https://github.com/Co-Engram/Co-Engram) team memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a native Cordis plugin.

- **40 memory tools on `ctx.tools`** with bare names (`engram_search`, `engram_create`, …) — same tool set as the Claude Code host.
- **Dynamic `memory:co-engram` prompt section** (order 120): top tags, skill catalog, path overview and pending-proposal count are re-evaluated at **every** prompt assembly — write a memory and the next message already reflects it.
- **Process-lock coexistence**: shares the same dataRoot with the Claude Code (MCP) and OpenClaw hosts; background maintenance and the web viewer run on a single elected holder.

## Install

```bash
dsh plugin --profile <name> add @co-engram/dsh
```

That's it — the package declares a `dsh.bundle` patch, so the plugin is activated as a profile layer with zero manual `cordis.patch.yml` editing. Point co-engram at your data repo once (shared with other hosts):

```bash
npm install -g @co-engram/claude-code   # provides the `co-engram` CLI
co-engram config data-root $HOME/team-memory
```

## Config (all optional)

```yaml
- id: co-engram
  name: '@co-engram/dsh'
  config:
    language: en            # or zh — tool descriptions & prompt language
    startMaintenance: true  # background reinforce/forget/consolidate
    proposalEnabled: true   # implicit-capture proposal engine
    startViewer: true       # web viewer (default: follows proposalEnabled, holder-gated, port 18899)
    defaultCreatedBy: ''    # fallback creator (default: git author)
```

See [docs/host-dsh.md](../../docs/host-dsh.md) for the full reference.

## This plugin vs the MCP bridge

| | MCP bridge (`dsh-mcp-client`) | this plugin |
|---|---|---|
| Tool names | `mcp__co-engram__*` | bare `engram_*` |
| Prompt guidance | server instructions are **not bridged** — signals lost | native dynamic section, per-assembly |
| Claude Code hooks side effect | yes (auto-installs into `~/.claude/settings.json`) | no |

## License

MIT
