# Example: Claude Code MCP Integration

Wire Co-Engram into Claude Code via MCP. This is the realistic integration most users will want.

## One-Liner

```bash
claude mcp add co-engram \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory \
  -e CO_ENGRAM_MAINTENANCE=1 \
  --scope user \
  -- co-engram-mcp
```

Restart Claude Code. Done.

## Step-by-Step

### 1. Install the MCP server

```bash
npm install -g @co-engram/claude-code
```

Or use `npx` to skip the install step (see below).

### 2. Initialize the data repo

```bash
mkdir -p ~/team-memory
cd ~/team-memory
git init
echo "# Team Memory" > README.md
git add . && git commit -m "init"
```

### 3. Wire into Claude Code

```bash
claude mcp add co-engram \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory \
  -e CO_ENGRAM_DEFAULT_CREATED_BY=$USER \
  -e CO_ENGRAM_MAINTENANCE=1 \
  --scope user \
  -- co-engram-mcp
```

### 4. Verify

```bash
claude mcp list
# Should show: co-engram ... ✓ Connected
```

Then in a new Claude Code session:

```
/mcp
```

Should show:

```
co-engram: ✓ Connected
  Tools: 22
```

## Files

- [`mcp-config.json`](./mcp-config.json) — the exact JSON to drop into `~/.claude.json` manually (alternative to `claude mcp add`)
- [`.env.example`](./.env.example) — environment variables reference

## npx Variant (Zero Install)

Skip step 1. Replace step 3's `-- co-engram-mcp` with:

```bash
claude mcp add co-engram \
  -e CO_ENGRAM_DATA_ROOT=$HOME/team-memory \
  -e CO_ENGRAM_MAINTENANCE=1 \
  --scope user \
  -- npx -y @co-engram/claude-code
```

## Project-Scoped (Team Shared)

Drop a `.mcp.json` in your project root and commit it:

```json
{
  "mcpServers": {
    "co-engram": {
      "command": "npx",
      "args": ["-y", "@co-engram/claude-code"],
      "env": {
        "CO_ENGRAM_DATA_ROOT": "${workspaceFolder}/.team-memory",
        "CO_ENGRAM_MAINTENANCE": "1"
      }
    }
  }
}
```

Anyone cloning the repo gets Co-Engram automatically.
