# Contributing to Co-Engram

Thanks for your interest in contributing! This document covers setup, workflow, and conventions.

## Development Setup

### Prerequisites

- **Node.js 22+** (`node --version`)
- **pnpm 10+** (`npm install -g pnpm`)
- **Git**

### First-Time Setup

```bash
git clone https://github.com/co-engram/co-engram.git
cd co-engram
pnpm install
pnpm -r build
pnpm -r test
```

If the test suite passes across all packages, you're ready.

### Repository Structure

```
co-engram/
├── packages/
│   ├── core/              # Host-agnostic memory engine
│   ├── claude-code-mcp/   # MCP server adapter
│   ├── openclaw-plugin/   # OpenClaw plugin adapter
│   └── e2e/               # Cross-host integration tests
├── docs/                  # Documentation
├── examples/              # Runnable examples
└── .github/               # CI, issue templates
```

See [docs/architecture.md](./docs/architecture.md) for the layered design.

## Development Workflow

### Running Tests

```bash
# All tests across all packages
pnpm -r test

# Specific package
pnpm --filter @co-engram/core test

# Watch mode (core only)
pnpm --filter @co-engram/core test -- --watch

# Single test file
pnpm --filter @co-engram/core exec vitest run test/signals-extract.test.ts
```

### Building

```bash
pnpm -r build
```

Build outputs go to `packages/*/dist/`. TypeScript project references handle cross-package dependencies.

### Type Checking

```bash
pnpm -r typecheck
```

### Formatting

We use Prettier:

```bash
pnpm format          # write
pnpm format:check    # check only
```

## Coding Standards

### TypeScript

- **Strict mode** — no `any`, prefer `unknown` with type narrowing
- **ESM only** — `"type": "module"` in all package.json
- **No `@ts-nocheck`** — fix the types instead
- **External boundaries use Zod** — tool inputs, config files, YAML loading

### File Organization

- **Tests are colocated** — `foo.ts` and `foo.test.ts` live next to each other
- **One concept per file** — split files around 700 LOC
- **Barrels for public APIs** — `index.ts` re-exports, no deep imports from outside the package

### Comments

- **Default to no comments.** Code should explain itself through naming.
- **When commenting, explain _why_, not _what_.** The `what` is in the code.
- **No multi-paragraph docstrings.** One short line max per function.

### Naming

- **American English spelling** — `color` not `colour`, `behavior` not `behaviour`
- **camelCase for variables/functions**, **PascalCase for types/classes**
- Constants: `SCREAMING_SNAKE_CASE` for module-level, `camelCase` for locals

## Architectural Rules

These are hard constraints, not preferences:

1. **Core has zero host dependencies.** `@co-engram/core` must not import `@modelcontextprotocol/sdk`, `openclaw`, or any host-specific package. If you need host types, put them in the adapter.
2. **Adapters contain no business logic.** If logic is reusable, it goes in core. Adapters only translate protocols.
3. **Data repo is separate.** Don't import from `~/team-memory/` at compile time. The data repo is runtime state.
4. **No global mutable state.** Per-instance stubs in tests; injected dependencies in production.

See [docs/design-rationale.md](./docs/design-rationale.md) for the _why_ behind these rules.

## Adding a New Tool

1. **Define the tool** in the appropriate file under `packages/core/src/tools/`:

   ```typescript
   export const myNewTool: Tool<MyInput, MyOutput> = {
     name: 'my_new',
     description: '...',
     parameters: myInputSchema,
     async execute(input, ctx) { ... }
   }
   ```

2. **Register** in `packages/core/src/tools/registry.ts`:

   ```typescript
   // Add to the relevant family array (e.g. ALL_ENGRAM_TOOLS in engram-tools.ts),
   // then ensure it's spread into createToolRegistry():
   export function createToolRegistry(): ToolRegistry {
     const tools = makeToolMap([
       ...ALL_ENGRAM_TOOLS,
       ...ALL_SYNAPSE_TOOLS,
       ...ALL_SKILL_TOOLS,
       ...ALL_PROPOSAL_TOOLS,
       ...ALL_DOCTOR_TOOLS,
     ]);
     return {
       /* ... */
     };
   }
   ```

3. **Declare** in `packages/openclaw-plugin/openclaw.plugin.json` under `contracts.tools`:

   ```json
   "contracts": { "tools": [..., "my_new"] }
   ```

4. **Test** — add `my-new.test.ts` next to the implementation.

5. **Document** — add to [docs/tool-reference.md](./docs/tool-reference.md).

## Commit Conventions

We use conventional-ish commits (not strictly enforced):

```
feat(co-engram): add new signal extraction rule
fix(co-engram): handle empty domainTags in engram_create
test(co-engram): add metacognition edge case
docs(co-engram): update tool reference
refactor(co-engram): extract RPE formula helper
```

Keep commits **atomic** — one logical change per commit. Commit messages should be concise and explain the _why_ if non-obvious.

## Pull Request Process

1. **Fork & branch** — create a feature branch from `main`
2. **Write tests first** (TDD encouraged, not required) — tests must pass before review
3. **Update docs** if behavior changed
4. **Run the full suite** locally:
   ```bash
   pnpm -r build && pnpm -r test && pnpm -r typecheck
   ```
5. **Open PR** against `main` using the PR template
6. **Respond to review** — be patient, be kind

### PR Template

See [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md). Required sections:

- **Summary** — what changed and why
- **Tests** — which tests cover this
- **Breaking changes** — if any

### Review Criteria

Reviewers will check:

- [ ] Tests pass and cover the change
- [ ] No architectural violations (core dependencies, etc.)
- [ ] Docs updated if behavior changed
- [ ] No sensitive data (paths, credentials) in code or commits
- [ ] CHANGELOG updated for user-facing changes

## Reporting Bugs

Use the [bug report template](https://github.com/co-engram/co-engram/issues/new?template=bug_report.yml). Include:

- Co-Engram version
- Node version
- Host (Claude Code / OpenClaw / custom)
- Reproduction steps
- Expected vs actual behavior

## Suggesting Features

Use the [feature request template](https://github.com/co-engram/co-engram/issues/new?template=feature_request.yml). Explain:

- The use case
- Why existing tools don't cover it
- Possible implementation (optional)

## Security Reports

**Do not open public issues for security vulnerabilities.** See [SECURITY.md](./SECURITY.md).

## Code of Conduct

Participation in this project is governed by the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Be excellent to each other.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
