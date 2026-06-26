# Example: Programmatic Core Usage

Use `@co-engram/core` directly — no host, no MCP, no plugin. Useful for batch scripts, custom UIs, or embedding in any TypeScript app.

## Run

```bash
# From this directory
npm install
npm run build

# Initialize data repo (first time only)
mkdir -p ~/team-memory-example && cd ~/team-memory-example && git init

# Run
DATA_ROOT=$HOME/team-memory-example npm start
```

Expected output:

```
Created engram: 01J...
Retrieved: TypeScript strict mode readonly gotcha
Reinforced. effectiveRetrievals: 1, reinforcementScore: 0.10
```

## What It Shows

- How to instantiate `EngramRepository`
- How to call `engramCreateTool.execute()` directly
- How to retrieve and reinforce
- How to clean up

## Files

- [`index.ts`](./index.ts) — the example script
- [`package.json`](./package.json) — single dependency: `@co-engram/core`
- [`tsconfig.json`](./tsconfig.json) — strict ESM TypeScript
