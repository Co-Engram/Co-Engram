# Design Rationale

This document explains the _why_ behind Co-Engram's key design choices. If you're considering forking or contributing, read this first.

## 1. Why One File per Engram?

Each engram is a single Markdown file at `<domainTags>/<slug>.md` with YAML frontmatter and a Markdown body. The engram has a ULID that is decoupled from the file path.

**The alternative** some memory systems use: split each memory into separate content / metadata / edges files.

**Why we don't:**

- **Content and metadata co-evolve in practice.** When a teammate rewrites a memory, they almost always update both the body and the title/summary together. Forcing them to edit separate files for content, metadata, and edges breaks the flow. YAML frontmatter keeps the structured fields adjacent to the prose so a single edit covers both.
- **Stable IDs handle the rename problem.** The historic reason to separate files was that renaming a memory would orphan references. A ULID decoupled from the file path solves this at the identity layer — renames, moves, and rewrites preserve all synapse references without any file gymnastics.
- **Per-edge synapse files handle the relationship problem.** Connections between memories live as their own files at `synapses/<kind>/syn-<hash>.yaml`, keyed by a deterministic hash. No duplicate edges, trivial dedupe, and pruning is a single file delete.
- **Tiered reads still work.** `engram_get` with `tier=digest` returns only frontmatter fields; the body is loaded lazily only for `tier=content`. Same I/O savings as a separate-file layout, without the multi-file overhead.
- **Clean diffs in Git.** YAML frontmatter changes show up as a compact block at the top of the file; body changes show up as Markdown diffs below. Reviewers get a single unified view per engram per commit.

**Trade-off:** A single file means frontmatter and body share mtime. We accept this — the ULID is the canonical identity, not the file, and `engram_doctor` auto-heals path drift.

## 2. Why Host-Agnostic Core?

`@co-engram/core` has zero host dependencies. It doesn't import `@modelcontextprotocol/sdk`, doesn't import `openclaw`, doesn't know about Claude Code or any specific agent runtime.

**Why:**

- **Future-proofing.** Today's hosts are Claude Code and OpenClaw. Tomorrow's might be Cursor, Continue.dev, Aider, or something not invented yet. A host-agnostic core means we add a new adapter (small, ~400 LOC) instead of rewriting the engine.
- **Testability.** Core tests don't need to spin up MCP servers or OpenClaw gateways. They just call `engramCreate(...)` and assert. Result: a test suite of well over a thousand unit tests in core, running in a few seconds.
- **Embeddability.** You can use Co-Engram as a library in any TypeScript project, no agent required. Useful for batch maintenance scripts, custom UIs, data migration tools.
- **Clear ownership.** When a bug is "memory logic", it's in core. When it's "how Claude Code formats the tool call", it's in the adapter. No diffuse ownership.

**Trade-off:** Slightly more boilerplate. Each adapter must construct a `ToolContext` and dispatch. Worth it.

## 3. Why Neuroscience-Inpired?

Terms like engram, synapse, LTP, LTD, RPE, dreaming, REM are borrowed from neuroscience — not as metaphors, but as **structural models**.

**Why:**

- **The brain is the only working example.** We have exactly one system that demonstrably does long-term memory well: the human brain. Any novel memory architecture is a hypothesis; the brain is the reference implementation.
- **The vocabulary forces rigor.** Calling something `reinforcementScore` invites debate about what "reinforcement" means. Calling it `LTP_trace` forces you to actually model long-term potentiation — spike-timing dependence, decay curves, saturation.
- **It maps to testable predictions.** "RPE updates reinforcementScore" predicts that surprising successes boost memory more than expected ones. We can write a test that verifies this. "engram gets stronger when used" is too vague to test.

**Trade-off:** The vocabulary is unfamiliar to newcomers. We mitigate by documenting each term in [concepts.md](./concepts.md), and by keeping the tool names plain (`engram_create`, not `engram potentiator`).

## 4. Why Self-Maintenance (Not Manual Tagging)?

Most memory systems require the agent (or human) to manually score memories after use — "was this helpful? thumbs up/down". Co-Engram's maintenance engine extracts behavioral signals from the event stream and applies RPE automatically.

**Why:**

- **Agents won't self-report reliably.** Claude, GPT, Gemini — none of them reliably call `engram_reinforce(effectiveness=0.7)` after using a memory. They forget, they round to 0 or 1, they confabulate. Any system that depends on agent discipline has already failed.
- **Behavior is more honest than self-report.** If an agent retrieves an engram and then immediately searches for something else, the engram was wrong — regardless of what the agent says. If an agent retrieves an engram and then edits a file based on it, the engram was useful. Actions > words.
- **Humans won't do it either.** Requiring humans to tag memories is asking them to do unpaid data entry. They won't. The system has to work without them.

**Trade-off:** Behavioral signals are noisy. A single "wrong retrieval" might be a fluke. We mitigate with rolling windows and low learning rates (0.1 by default — takes ~10 signals to significantly shift a score).

## 5. Why a Separate Git Repo for Data?

The data repository (`~/team-memory/`) is intentionally separate from any code repository, including this one.

**Why:**

- **Memory is cross-project.** A pattern you learn in project A applies to project B. If memory lives inside project A's repo, project B can't see it. A standalone repo serves all projects.
- **Memory outlives projects.** Projects get archived, rewritten, abandoned. Memory should survive. A separate repo has its own lifecycle.
- **Git history is sacred.** Mixing memory churn (hundreds of commits/week) with code history makes `git log` for code useless. Separate repos keep both clean.
- **Access control.** A team might share a memory repo via a private Git remote, while keeping code repos separate. Or vice versa.

**Trade-off:** Users must remember to `git init` the data repo. We mitigate with the quickstart and `mkdir + git init` in step 2.

## 6. Why `contracts.tools` Manifest Declaration?

OpenClaw requires plugins to pre-declare every tool name in `openclaw.plugin.json`'s `contracts.tools` array. If a tool isn't declared, the loader silently drops it.

**Why:**

- **No hidden tools.** A plugin that quietly registers `delete_everything` is a security risk. Manifest declaration forces every tool to be visible at install time.
- **Deterministic control plane.** Discovery, validation, and setup planning work from metadata alone — without executing plugin code. This makes `openclaw plugins list` fast and safe.
- **Audit trail.** If a tool behaves badly, the manifest tells you exactly what was supposed to be registered. You can diff against actual runtime registration.

**Trade-off:** Adding a new tool requires editing two places (the tool definition + the manifest). IDE tooling could automate this in the future.

## 7. Why MCP for Claude Code (Not a Custom Hook)?

Claude Code supports several integration mechanisms: MCP servers, slash commands, hooks, CLAUDE.md files. We chose MCP.

**Why:**

- **MCP is the official standard.** Anthropic publishes and maintains MCP. Tools built on it survive Claude Code version upgrades. Custom hooks don't have that guarantee.
- **MCP is cross-host.** The same MCP server works with Cursor, Continue.dev, Codex — not just Claude Code. Our `@co-engram/claude-code` package is actually a general MCP server, despite the name.
- **MCP tools get schema validation.** Input/output is validated against JSON Schema. We already validate with Zod internally; MCP gives us an additional layer at the protocol boundary.
- **MCP is discoverable.** `/mcp` in Claude Code lists all tools. Users can see exactly what Co-Engram exposes, no documentation lookup required.

**Trade-off:** MCP has more overhead than a direct function call. For 27 tools in a session-scoped server, this is negligible — but it's not free.

## See Also

- [Architecture](./architecture.md) — the layer structure these decisions produce
- [Concepts](./concepts.md) — the vocabulary these decisions require
