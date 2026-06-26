# Migration Guide

How to upgrade Co-Engram across versions, and what breaks when.

## Versioning Policy

Co-Engram follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.x → 2.x): breaking changes to the tool API, data format, or config schema
- **MINOR** (0.1.x → 0.2.x): new features, new tools, backward-compatible changes
- **PATCH** (0.1.0 → 0.1.1): bug fixes only

While at `0.x`, **minor bumps may include breaking changes**. Pin to exact versions in production:

```bash
npm install @co-engram/core@0.1.0  # exact
# not
npm install @co-engram/core@^0.1.0  # may pull 0.2.0 with breaking changes
```

## Data Format Compatibility

The engram file format (single `.md` with YAML frontmatter + Markdown body, plus per-edge synapse YAML) is designed to be forward-compatible:

- **New YAML fields** are additive — old code ignores unknown fields
- **Removed YAML fields** leave orphan data — new code ignores them
- **Renamed YAML fields** require a migration script (we'll provide one)

If a future version changes the YAML schema incompatibly, the release notes will include a migration command.

## Upgrading

### Upgrade the MCP server (Claude Code)

```bash
npm update -g @co-engram/claude-code
# or
npm install -g @co-engram/claude-code@latest

# Restart Claude Code to pick up the new server
```

Your data repo is untouched. Existing engrams continue to work.

### Upgrade the OpenClaw plugin

```bash
cd ~/.openclaw/extensions/co-engram
npm update @co-engram/openclaw
# Restart OpenClaw gateway
```

### Upgrade `@co-engram/core` (embedded usage)

```bash
npm install @co-engram/core@latest
# Check CHANGELOG for breaking changes
pnpm test  # run your test suite
```

## Self-Healing

Co-Engram ships a self-healing tool that handles most drift automatically:

```bash
# Via MCP / OpenClaw tool call
engram_doctor({ incremental: false })
```

`engram_doctor` detects and auto-fixes:

- **Moved files** — path changed; index re-pointed
- **Renamed titles** — file renamed via re-slugification
- **Missing files** — index entry pointed to a deleted file; entry cleared

It reports (but does not auto-fix):

- `slug_conflict` — new slug would collide with another file
- `orphan_markdown` — Markdown file without frontmatter
- `dangling_synapse` — synapse references a missing engram

Run `engram_doctor` after any manual file operations (moves, renames, deletes) to keep the cache in sync.

## Breaking Change Policy

When a breaking change is unavoidable:

1. **Announce in CHANGELOG.md** at least one minor version before
2. **Provide a migration script** (automated if possible, documented if not)
3. **Keep old behavior working** with a deprecation warning for at least 3 months
4. **Bump MAJOR version** when the old behavior is removed

## Version Compatibility Matrix

| Core version | MCP adapter | OpenClaw adapter | Data format |
| ------------ | ----------- | ---------------- | ----------- |
| 0.1.x        | 0.1.x       | 0.1.x            | stable      |

Older adapters may work with newer core (forward compat), but we don't test it. Newer adapters may not work with older core.

## Rollback

If an upgrade breaks something:

```bash
# Pin to previous version
npm install -g @co-engram/claude-code@0.1.0

# Data repo is untouched — no rollback needed there
# Restart Claude Code
```

If the upgrade wrote new-format data that old version can't read, file an issue. We'll provide a downgrade migration.

## Reporting Issues

If an upgrade breaks your workflow:

1. Check [CHANGELOG.md](../CHANGELOG.md) for documented changes
2. Check [existing issues](https://github.com/co-engram/co-engram/issues)
3. File a new issue with: old version, new version, error message, data repo size (`find ~/team-memory -type f | wc -l`)
