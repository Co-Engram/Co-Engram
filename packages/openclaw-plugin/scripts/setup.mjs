#!/usr/bin/env node
/**
 * Co-Engram OpenClaw plugin 一键 setup
 *
 * 行为(idempotent,可重复跑):
 *   1. 读取 ~/.openclaw/openclaw.json(不存在则报错并指引 `openclaw onboard`)
 *   2. 在 plugins.entries.co-engram.config 下 merge 推荐默认值
 *      - 保留用户已显式设置的字段
 *      - 仅在缺失时填入推荐值
 *   3. 把 memory exclusive slot 设为 "co-engram"(自动让 memory-core 失效)
 *   4. 备份原文件到 <path>.bak.<timestamp>
 *   5. 默认 dry-run,需 --yes 才落盘;--restart 顺带 openclaw gateway restart
 *
 * 用法:
 *   pnpm --filter @co-engram/openclaw setup              # dry-run,只打印 diff
 *   pnpm --filter @co-engram/openclaw setup --yes        # 落盘
 *   pnpm --filter @co-engram/openclaw setup --yes --restart  # 落盘 + 重启
 *   npx @co-engram/openclaw setup --yes --restart        # 通过 bin
 *
 * @module @co-engram/openclaw/scripts/setup
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

/** 推荐默认配置(仅在用户未显式设置时写入) */
const RECOMMENDED_CONFIG = {
  language: "zh",
  startMaintenance: true,
  startViewer: true,
  auditEnabled: true,
};

const PLUGIN_ID = "co-engram";

function parseArgs(argv) {
  const flags = {
    yes: false,
    restart: false,
    configPath: OPENCLAW_CONFIG_PATH,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--restart") flags.restart = true;
    else if (arg.startsWith("--config="))
      flags.configPath = arg.slice("--config=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`co-engram openclaw setup

Usage:
  co-engram-openclaw-setup [options]

Options:
  --yes, -y        Apply changes (default: dry-run, only print diff)
  --restart        Run \`openclaw gateway restart\` after applying
  --config=<path>  Override openclaw.json path (default: ~/.openclaw/openclaw.json)
  --help, -h       Show this help

Recommended config written to plugins.entries.co-engram.config (only when missing):
${JSON.stringify(RECOMMENDED_CONFIG, null, 2)
  .split("\n")
  .map((l) => "  " + l)
  .join("\n")}
`);
}

function readConfig(path) {
  if (!existsSync(path)) {
    process.stderr.write(`[setup] Config not found: ${path}\n`);
    process.stderr.write(
      `[setup] Run \`openclaw onboard\` first to initialize OpenClaw.\n`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function deepMergeMissing(target, defaults) {
  const applied = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) {
      target[k] = v;
      applied[k] = { from: undefined, to: v };
    }
    // 已存在的值保留不动(包括 false / 0 / '')
  }
  return applied;
}

function applyChanges(config) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.slots ??= {};

  const entry = (config.plugins.entries[PLUGIN_ID] ??= { enabled: true });
  entry.enabled = entry.enabled !== false; // 默认 true,但保留显式 false
  const userConfig = (entry.config ??= {});

  const applied = deepMergeMissing(userConfig, RECOMMENDED_CONFIG);

  // memory exclusive slot → co-engram(让 memory-core 自动 disable)
  let slotChanged = false;
  if (config.plugins.slots.memory !== PLUGIN_ID) {
    slotChanged = {
      from: config.plugins.slots.memory,
      to: PLUGIN_ID,
    };
    config.plugins.slots.memory = PLUGIN_ID;
  }

  return { applied, slotChanged };
}

function findOpenclawCli() {
  // 优先找 co-claw bundled CLI
  const candidates = [
    "/opt/Co-Claw/resources/app-data/coclaw/openclaw.mjs",
    process.env.HOME + "/.coclaw/nodejs/bin/node", // 备用 node
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function restartGateway() {
  const cli = findOpenclawCli();
  if (!cli) {
    process.stderr.write(`[setup] openclaw CLI not found; skip restart\n`);
    return false;
  }
  process.stdout.write(`[setup] Restarting gateway via ${cli}\n`);
  const result = spawnSync("node", [cli, "gateway", "restart"], {
    stdio: "inherit",
    timeout: 30000,
  });
  return result.status === 0;
}

function main() {
  const flags = parseArgs(process.argv);
  const config = readConfig(flags.configPath);
  const before = JSON.stringify(config, null, 2);
  const { applied, slotChanged } = applyChanges(config);
  const after = JSON.stringify(config, null, 2);
  const changed = Object.keys(applied).length > 0 || slotChanged;

  if (!changed) {
    process.stdout.write(`[setup] Already up to date: ${flags.configPath}\n`);
    if (flags.restart) restartGateway();
    return;
  }

  process.stdout.write(`[setup] Planned changes to ${flags.configPath}:\n`);
  for (const [k, v] of Object.entries(applied)) {
    process.stdout.write(
      `  plugins.entries.${PLUGIN_ID}.config.${k}: <missing> → ${JSON.stringify(v.to)}\n`,
    );
  }
  if (slotChanged) {
    process.stdout.write(
      `  plugins.slots.memory: ${JSON.stringify(slotChanged.from)} → ${JSON.stringify(slotChanged.to)}\n`,
    );
  }

  if (!flags.yes) {
    process.stdout.write(
      `\n[setup] Dry-run only. Re-run with --yes to apply.\n`,
    );
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${flags.configPath}.bak.${ts}`;
  copyFileSync(flags.configPath, backup);
  process.stdout.write(`[setup] Backup: ${backup}\n`);

  writeFileSync(flags.configPath, after + "\n", "utf8");
  process.stdout.write(`[setup] Applied: ${flags.configPath}\n`);

  syncWorkspaceDeps();

  if (flags.restart) {
    restartGateway();
  } else {
    process.stdout.write(
      `\n[setup] Run \`openclaw gateway restart\` to load the new config.\n`,
    );
  }
}

/**
 * 调用同目录的 sync-deps.mjs,把 workspace 依赖从 pnpm symlink 替换为实拷贝
 *
 * 失败不抛错,只 stderr 提示——setup 仍算成功(用户可能从已发布 npm tarball 安装,
 * 此时无 symlink 需要处理)。
 */
function syncWorkspaceDeps() {
  const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "sync-deps.mjs",
  );
  if (!existsSync(scriptPath)) {
    process.stderr.write(
      `[setup] sync-deps.mjs not found at ${scriptPath}; skipping workspace dep sync\n`,
    );
    return false;
  }
  process.stdout.write(
    `[setup] Syncing workspace deps (pnpm symlink → real copy)\n`,
  );
  const result = spawnSync("node", [scriptPath], {
    stdio: "inherit",
    timeout: 60000,
  });
  return result.status === 0;
}

main();
