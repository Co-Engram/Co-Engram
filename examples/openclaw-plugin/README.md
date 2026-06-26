# Example: OpenClaw Plugin Integration

Install Co-Engram as an OpenClaw plugin.

## Install

### Option A: npm install (recommended)

```bash
# Inside OpenClaw extensions directory
cd ~/.openclaw/extensions/
npm install @co-engram/openclaw
```

### Option B: Build from source

```bash
git clone https://github.com/co-engram/co-engram.git
cd co-engram
pnpm install && pnpm -r build

# Copy built artifacts to OpenClaw extensions
mkdir -p ~/.openclaw/extensions/co-engram
cp -r packages/openclaw-plugin/dist ~/.openclaw/extensions/co-engram/
cp packages/openclaw-plugin/package.json ~/.openclaw/extensions/co-engram/
cp packages/openclaw-plugin/openclaw.plugin.json ~/.openclaw/extensions/co-engram/

# Plus @co-engram/core and runtime deps (zod, yaml)
mkdir -p ~/.openclaw/extensions/co-engram/node_modules/@co-engram
cp -r packages/core/dist ~/.openclaw/extensions/co-engram/node_modules/@co-engram/core/
cp packages/core/package.json ~/.openclaw/extensions/co-engram/node_modules/@co-engram/core/
# Then install zod + yaml inside the plugin directory
cd ~/.openclaw/extensions/co-engram && npm install zod yaml
```

## Configure

Add the plugin to your OpenClaw config (`~/.openclaw/config.yaml`):

```yaml
plugins:
  entries:
    co-engram:
      enabled: true
      config:
        dataRoot: /home/your/team-memory
        defaultCreatedBy: openclaw
        startMaintenance: true
        maintenanceConfig:
          enabledStages: [light, deep, rem]
          learningRate: 0.1
```

The full config schema is in [`openclaw.config.json`](./openclaw.config.json).

## Verify

```bash
# Check plugin loaded
openclaw plugins list

# Check tools registered (use --runtime for actual runtime load)
openclaw plugins inspect co-engram --runtime --json
```

Expected:

```json
{
  "plugin": {
    "id": "co-engram",
    "status": "loaded",
    "activated": true,
    "toolNames": ["engram_create", "engram_get", ...]
  }
}
```

## Files

- [`openclaw.config.json`](./openclaw.config.json) — the config block to drop into your OpenClaw config

## Troubleshooting

See [docs/host-openclaw.md → Troubleshooting](../../docs/host-openclaw.md#troubleshooting).
