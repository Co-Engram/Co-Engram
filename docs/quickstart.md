# Quickstart (Deep Dive)

This is the extended quickstart. For the 3-command version, see the main [README](../README.md).

## Prerequisites

- **Node.js 22+** — check with `node --version`
- **Git** — for the data repository
- **pnpm** — only needed for source builds; npm users can skip
- A host that supports MCP (Claude Code, Cursor, Continue.dev, ...) or OpenClaw

## Step 1: Install the MCP Server

Two options, pick one:

### Option A: Global install (recommended)

```bash
npm install -g @co-engram/claude-code
```

This puts the `co-engram-mcp` binary on your PATH. Startup is fast since the package is already on disk.

### Option B: Zero-install via npx

No install needed. `npx -y @co-engram/claude-code` fetches the package on each cold start (~2s penalty first run).

## Step 2: Initialize the Data Repository

Co-Engram stores all memory in a **separate** Git repository. This is a hard design choice — see [design-rationale.md](./design-rationale.md) for why.

**Recommended: use `co-engram init` (interactive, with language selection)**

```bash
co-engram init
# → prompts for path (default: ~/team-memory)
# → prompts for language (English / 简体中文) — controls tool descriptions, viewer UI, and system prompts
# → writes .co-engram/config.json (persisted language choice)
```

Or non-interactive:

```bash
co-engram init --path ~/team-memory --language zh --created-by alice
```

**Manual alternative** (skips `co-engram init`):

```bash
mkdir -p ~/team-memory
cd ~/team-memory
git init
echo "# Team Memory" > README.md
git add README.md
git -c user.email="$(git config user.email || echo memory@local)" \
    -c user.name="$(git config user.name || echo Local)" \
    commit -m "init team-memory"
```

The directory will be populated automatically on first `engram_create`.

### Language selection — why it matters

The language you pick in `co-engram init` controls:

- **Tool descriptions** — what the LLM sees when listing available tools (`/mcp` in Claude Code)
- **Viewer UI strings** — buttons, tab labels, loading messages
- **System prompt injections** — the "3 memory candidates pending" notice

Choice is persisted to `~/team-memory/.co-engram/config.json`. Both hosts (Claude Code + OpenClaw) honor it.

**Override at runtime** via env or manifest:

```bash
# MCP: env var wins over persisted config
claude mcp add co-engram -e CO_ENGRAM_LANGUAGE=zh ...

# OpenClaw: manifest field wins over persisted config
# plugins.entries.co-engram.config.language: zh
```

## Step 3: Wire into Claude Code

```bash
claude mcp add co-engram \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory \
  -e CO_ENGRAM_DEFAULT_CREATED_BY=$USER \
  -e CO_ENGRAM_MAINTENANCE=1 \
  --scope user \
  -- co-engram-mcp
```

Verify:

```bash
claude mcp list
# co-engram: ... ✓ Connected

claude mcp get co-engram
# Shows env vars, command, scope
```

## Step 4: Smoke Test in a New Claude Code Session

Open a new Claude Code session (the current one won't pick up newly added MCP servers):

```
/mcp
```

You should see:

```
co-engram: ✓ Connected
  Tools: 16    # standard profile by default; 11 (minimal) or 27 (full) if you set CO_ENGRAM_TOOLS_PROFILE
```

The MCP server also writes a startup line to stderr (visible in `claude mcp logs co-engram`):

```
[co-engram] Loaded 0 engrams, profile=standard (16/27 tools visible to LLM)
[co-engram] No memories yet — the LLM will start capturing once you discuss decisions, preferences, or lessons learned.
```

If you skipped `co-engram init` and the data root doesn't exist yet, the first line will be:

```
[co-engram] Initialized new data repo at /home/$USER/team-memory (no engrams yet — run "co-engram init" to pick a language and configure maintenance)
```

Then try creating a memory:

> Use co-engram to create an engram with title "First memory", content "Co-Engram is now wired up", kind observation, domainTags ["test"].

The agent should call `mcp__co-engram__engram_create` and return an engram ID. Verify it landed:

```bash
# Files are stored at <domainTags>/<slug>.md inside the data root
find ~/team-memory -name "*.md" -not -path "*/.co-engram/*" -not -path "*/.trash/*"
```

You should see a single Markdown file per engram, with YAML frontmatter (id, title, kind, etc.) and a Markdown body.

## Step 5: Search It Back

In the same session:

> Use co-engram to search for memories about "Co-Engram".

The agent should call `engram_search` and find the engram you just created.

## Troubleshooting

### `claude mcp list` shows `✗ Failed to connect`

The MCP server crashed on startup. Debug:

```bash
CO_ENGRAM_DATA_ROOT=$HOME/team-memory co-engram-mcp
```

Run the binary directly — you'll see stderr. Common causes:

- **Node version too old** — needs Node 22+
- **`CO_ENGRAM_DATA_ROOT` not set or not absolute** — must be an absolute path
- **Data directory not a Git repo** — run `git init` inside it

### `/mcp` shows 0 tools despite `✓ Connected`

The manifest is missing `contracts.tools` entries. This shouldn't happen if you installed from npm — if building from source, verify `packages/openclaw-plugin/openclaw.plugin.json` lists all 29 tools (27 native + 2 `memory_*` wrappers). The OpenClaw loader silently drops undeclared tools.

### Tools registered but calls return errors

Check the data repo permissions:

```bash
ls -la ~/team-memory
# Should be writable by the user running Claude Code
```

### Maintenance engine isn't running

Set `CO_ENGRAM_MAINTENANCE=1` and check logs:

```bash
# Run the server in foreground with verbose logging
CO_ENGRAM_DATA_ROOT=$HOME/team-memory CO_ENGRAM_MAINTENANCE=1 co-engram-mcp
```

Look for `[maintenance]` log lines every 5 minutes (light stage default).

## Next Steps

- Read [concepts.md](./concepts.md) to learn what engrams, synapses, and skills are
- Read [tool-reference.md](./tool-reference.md) for the full tool catalog
- Read [maintenance-engine.md](./maintenance-engine.md) to understand the self-maintenance loop
