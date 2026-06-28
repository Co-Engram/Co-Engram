#!/usr/bin/env node
/**
 * Co-Engram CLI
 *
 * 子命令:
 *   co-engram init                              # 交互式初始化 team-memory
 *   co-engram config data-root                  # 显示当前 dataRoot
 *   co-engram config data-root <path>           # 设置 dataRoot(单一权威入口)
 *   co-engram config data-root --reset          # 重置为默认 $HOME/team-memory
 *   co-engram config data-root <path> --force   # 强制接管非空目录
 *   co-engram post-merge                        # git post-merge 钩子(自动检测)
 *   co-engram stats / anomalies                 # 统计/异常检测
 *   co-engram install-post-merge-hook           # 安装 git hook
 *   co-engram uninstall-post-merge-hook         # 卸载 git hook
 *   co-engram hook-status                       # 查询 git hook 状态
 *
 * @module @co-engram/claude-code
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  writeTeamMemoryConfig,
  parseLanguage,
  detectGitAuthor,
  t,
  installPostMergeHook,
  uninstallPostMergeHook,
  getPostMergeHookStatus,
  runPostMergeCheck,
  computeMergeStats,
  formatMergeStatsAsText,
  detectAnomalies,
  formatAnomaliesAsText,
  AuditLog,
  findDataRoot,
  resolveBootstrapDataRootSync,
  readBootstrapDataRootSync,
  writeBootstrapDataRoot,
  getBootstrapConfigPath,
  getDefaultDataRoot,
  applyDataRootChange,
  DEFAULT_LANGUAGE,
  type Language,
} from "@co-engram/core";
import { resolveDefaultCreatedBy } from "./mcp-server.js";

interface CliArgs {
  readonly command: string;
  readonly subcommand?: string;
  readonly positional?: string;
  readonly path?: string;
  readonly cwd?: string;
  readonly language?: Language;
  readonly createdBy?: string;
  readonly windowDays?: number;
  readonly json: boolean;
  readonly noGit: boolean;
  readonly force: boolean;
  readonly reset: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  let subcommand: string | undefined;
  let positional: string | undefined;
  let path: string | undefined;
  let cwd: string | undefined;
  let language: Language | undefined;
  let createdBy: string | undefined;
  let windowDays: number | undefined;
  let json = false;
  let noGit = false;
  let force = false;
  let reset = false;
  let help = false;

  // 同时支持 `--flag VALUE` 与 `--flag=VALUE` 两种语法。
  // 用户经常自然地用 `--path=/foo`(尤其是从 npm scripts / docker CMD 里调用),
  // 旧实现只识别空格分隔 → 静默丢弃参数 → falling through 到 interactive 提示。
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--no-git") {
      noGit = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--path") {
      path = args[i + 1];
      i++;
    } else if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length);
    } else if (arg === "--cwd") {
      cwd = args[i + 1];
      i++;
    } else if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
    } else if (arg === "--window-days") {
      windowDays = Number(args[i + 1]);
      i++;
    } else if (arg.startsWith("--window-days=")) {
      windowDays = Number(arg.slice("--window-days=".length));
    } else if (arg === "--language") {
      language = parseLanguage(args[i + 1]);
      i++;
    } else if (arg.startsWith("--language=")) {
      language = parseLanguage(arg.slice("--language=".length));
    } else if (arg === "--created-by") {
      createdBy = args[i + 1];
      i++;
    } else if (arg.startsWith("--created-by=")) {
      createdBy = arg.slice("--created-by=".length);
    } else if (!arg.startsWith("-")) {
      // 位置参数:第一个非 flag 是 subcommand,第二个是 positional
      // 用于 `co-engram config data-root <path>`
      if (!subcommand) {
        subcommand = arg;
      } else if (positional === undefined) {
        positional = arg;
      }
    }
  }
  return {
    command,
    subcommand,
    positional,
    path,
    cwd,
    language,
    createdBy,
    windowDays,
    json,
    noGit,
    force,
    reset,
    help,
  };
}

function showHelp(language: Language = "en"): void {
  const lines = [
    t(language, "cli.init.help_title"),
    t(language, "cli.init.help_usage"),
    "",
    t(language, "cli.init.help_path"),
    t(language, "cli.init.help_language"),
    t(language, "cli.init.help_created_by"),
    t(language, "cli.init.help_no_git"),
    t(language, "cli.init.help_force"),
    t(language, "cli.init.help_help"),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return await new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function initTeamMemory(args: CliArgs): Promise<void> {
  let language: Language = args.language ?? DEFAULT_LANGUAGE;

  process.stdout.write(t(language, "cli.init.welcome") + "\n\n");

  // 是否需要任何交互式问题(只要 path/language 都给了就不交互;createdBy 可走默认值)
  const needsPath = !args.path;
  const needsLanguage = !args.language;
  const interactive = needsPath || needsLanguage;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    // 1. 询问路径
    const defaultPath = `${process.env.HOME ?? "/tmp"}/team-memory`;
    const targetPath = needsPath
      ? (await ask(
          rl!,
          `${t(language, "cli.init.data_root_prompt")} (${t(language, "cli.init.data_root_default")}) `,
        )) || defaultPath
      : (args.path as string);

    // 2. 选择语言
    if (needsLanguage) {
      process.stdout.write(
        "\n" + t(language, "cli.init.language_prompt") + "\n",
      );
      process.stdout.write(
        `  1. ${t(language, "cli.init.language_option_en")}\n`,
      );
      process.stdout.write(
        `  2. ${t(language, "cli.init.language_option_zh")}\n`,
      );
      const choice = await ask(rl!, "> ");
      if (choice === "1" || choice.toLowerCase() === "en") {
        language = "en";
      } else if (choice === "2" || choice.toLowerCase() === "zh") {
        language = "zh";
      } else {
        process.stdout.write(t("en", "cli.init.invalid_language") + "\n");
        language = "en";
      }
      process.stdout.write(t(language, "cli.init.language_set_env") + "\n\n");
    }

    // 3. 默认作者(--created-by > git user.name/email > env CO_ENGRAM_DEFAULT_CREATED_BY > $USER > 'unknown';无需交互)
    //    注:resolveDefaultCreatedBy 的 fallback 链是 git > config > env;
    //    CLI init 场景没有 config,所以 git 优先,env 次之。
    const createdBy =
      args.createdBy ??
      resolveDefaultCreatedBy(undefined) ??
      process.env.USER ??
      "unknown";

    // 4. 创建目录
    if (existsSync(targetPath)) {
      process.stdout.write(t(language, "cli.init.dir_exists") + "\n");
    } else {
      mkdirSync(targetPath, { recursive: true });
      process.stdout.write(t(language, "cli.init.dir_created") + "\n");
    }

    // 5. git init
    if (!args.noGit) {
      const isGitRepo = existsSync(`${targetPath}/.git`);
      if (isGitRepo) {
        process.stdout.write(t(language, "cli.init.git_skipped") + "\n");
      } else {
        try {
          execSync("git init", { cwd: targetPath, stdio: "ignore" });
          process.stdout.write(t(language, "cli.init.git_initialized") + "\n");
        } catch {
          // git 不可用,跳过
        }
      }
    }

    // 6. 写入 .co-engram/config.json
    const configPath = `${targetPath}/.co-engram/config.json`;
    if (existsSync(configPath) && !args.force) {
      process.stdout.write(
        `Config exists at ${configPath}, skipping (use --force to overwrite).\n`,
      );
    } else {
      await writeTeamMemoryConfig(targetPath, {
        version: 1,
        language,
        defaultCreatedBy: createdBy,
        createdAt: new Date().toISOString(),
        initializedBy: "co-engram-cli@0.1.0",
      });
      process.stdout.write(
        t(language, "cli.init.config_written", { path: configPath }) + "\n",
      );
    }

    // 7. 后续步骤
    process.stdout.write("\n" + t(language, "cli.init.next_steps") + "\n");
    process.stdout.write(
      t(language, "cli.init.next_step_mcp", { path: targetPath }) + "\n",
    );
    process.stdout.write(
      t(language, "cli.init.next_step_openclaw", { path: targetPath }) + "\n",
    );
    process.stdout.write("\n" + t(language, "cli.init.done") + "\n");
  } finally {
    rl?.close();
  }
}

/**
 * `co-engram config` 命令入口
 *
 * 子命令:
 *   - `data-root`             显示当前 dataRoot
 *   - `data-root <path>`      设置 dataRoot(写入 ~/.co-engram/config.json)
 *   - `data-root --reset`     重置为默认 $HOME/team-memory
 *   - `data-root <path> --force`  强制接管非空目录
 */
async function runConfigCommand(args: CliArgs): Promise<void> {
  const sub = args.subcommand;
  if (sub !== "data-root") {
    process.stderr.write(
      `Unknown 'config' subcommand: ${sub ?? "(none)"}\n` +
        `Available: config data-root [path] [--reset] [--force]\n`,
    );
    process.exit(1);
  }
  await runConfigDataRoot(args);
}

/**
 * `co-engram config data-root` 子命令实现
 */
async function runConfigDataRoot(args: CliArgs): Promise<void> {
  const bootstrapPath = getBootstrapConfigPath();
  const currentDataRoot = readBootstrapDataRootSync() ?? getDefaultDataRoot();

  // --reset:清除持久化值,回退到默认
  if (args.reset) {
    await writeBootstrapDataRoot(getDefaultDataRoot());
    process.stdout.write(
      `[co-engram] data-root reset to default: ${getDefaultDataRoot()}\n` +
        `  bootstrap config: ${bootstrapPath}\n` +
        `  Restart co-engram (or run 'openclaw gateway restart') for the change to take effect.\n`,
    );
    return;
  }

  // 无 positional:显示当前值
  if (args.positional === undefined) {
    process.stdout.write(
      `[co-engram] current data-root: ${currentDataRoot}\n` +
        `  bootstrap config: ${bootstrapPath}\n` +
        `  Change it with: co-engram config data-root <new-path>\n`,
    );
    return;
  }

  // 设置新值
  const rawPath = args.positional;
  // 解析为绝对路径(相对路径基于 cwd)
  const newPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);

  if (newPath === currentDataRoot) {
    process.stdout.write(
      `[co-engram] data-root unchanged: ${currentDataRoot}\n`,
    );
    return;
  }

  // 共享验证 + 初始化 + 写 bootstrap 逻辑(与 viewer UI 共用)
  const result = await applyDataRootChange(rawPath, {
    force: args.force,
    createdBy: args.createdBy,
    language: args.language,
  });

  if (!result.ok) {
    if (result.reason === "non-engram") {
      process.stderr.write(
        `[co-engram] Refusing to set data-root to ${newPath}\n` +
          `  Directory exists but is not a co-engram warehouse (no .co-engram/config.json).\n` +
          `  It may contain unrelated user data.\n\n` +
          `  Options:\n` +
          `    1. Pick a different path\n` +
          `    2. Backup/clear this directory first\n` +
          `    3. Force takeover with: co-engram config data-root ${newPath} --force\n`,
      );
    } else {
      process.stderr.write(`[co-engram] ${result.error}\n`);
    }
    process.exit(1);
  }

  if (result.initialized) {
    process.stdout.write(
      `[co-engram] Initialized new team-memory warehouse at ${result.dataRoot}\n`,
    );
  } else if (result.classification === "engram-warehouse") {
    process.stdout.write(
      `[co-engram] Existing warehouse detected at ${result.dataRoot}, switching data-root.\n`,
    );
  }

  process.stdout.write(
    `[co-engram] data-root set to: ${result.dataRoot}\n` +
      `  bootstrap config: ${bootstrapPath}\n` +
      `  Previous value:   ${currentDataRoot}\n\n` +
      `  Restart co-engram for the change to take effect:\n` +
      `    - Claude Code: restart Claude Code (MCP server will pick up new path)\n` +
      `    - OpenClaw:    run 'openclaw gateway restart'\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || args.command === "help" || args.command === "--help") {
    showHelp(args.language);
    return;
  }

  if (args.command === "config") {
    try {
      await runConfigCommand(args);
    } catch (err) {
      process.stderr.write(
        `co-engram config failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "init") {
    try {
      await initTeamMemory(args);
    } catch (err) {
      process.stderr.write(
        `co-engram init failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "post-merge") {
    try {
      const result = await runPostMergeCheck({
        cwd: args.cwd ?? process.cwd(),
      });
      if (!result.dataRoot) {
        // 不在 team-memory 仓库内 — 静默退出
        return;
      }
      if (result.error) {
        process.stderr.write(
          `[co-engram] post-merge check error: ${result.error}\n`,
        );
        return;
      }
      process.stdout.write(
        `[co-engram] post-merge: ${result.inconsistencies} inconsistency(s)` +
          ` (${result.autoFixed} auto-fixed, ${result.escalated} escalated)` +
          ` in ${result.durationMs}ms\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[co-engram] post-merge failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return;
  }

  if (args.command === "install-post-merge-hook") {
    try {
      const result = installPostMergeHook({
        repoRoot: args.cwd ?? process.cwd(),
      });
      process.stdout.write(
        `[co-engram] post-merge hook installed at ${result.hookPath}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[co-engram] install failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "uninstall-post-merge-hook") {
    const result = uninstallPostMergeHook({
      repoRoot: args.cwd ?? process.cwd(),
    });
    if (result.removed) {
      process.stdout.write(`[co-engram] post-merge hook removed\n`);
    } else {
      process.stdout.write(`[co-engram] no co-engram-managed hook to remove\n`);
    }
    return;
  }

  if (args.command === "hook-status") {
    const status = getPostMergeHookStatus({
      repoRoot: args.cwd ?? process.cwd(),
    });
    if (!status.installed) {
      process.stdout.write(`[co-engram] post-merge hook: not installed\n`);
    } else {
      process.stdout.write(
        `[co-engram] post-merge hook: installed` +
          ` (${status.atPrimaryPath ? "primary" : "sidecar"} path)\n` +
          `  ${status.hookPath}\n`,
      );
    }
    return;
  }

  if (args.command === "stats") {
    // co-engram stats [--window-days N] [--cwd PATH] [--json]
    const cwd = args.cwd ?? process.cwd();
    const dataRoot = findDataRoot(cwd);
    if (!dataRoot) {
      process.stderr.write(
        `[co-engram] not inside a team-memory repository (no .co-engram marker up the tree)\n`,
      );
      process.exit(1);
    }
    const windowDays = args.windowDays ?? 7;
    const auditLog = new AuditLog(dataRoot);
    const stats = computeMergeStats({
      auditLog,
      windowMs: windowDays * 24 * 60 * 60 * 1000,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } else {
      process.stdout.write(formatMergeStatsAsText(stats));
    }
    return;
  }

  if (args.command === "anomalies") {
    // co-engram anomalies [--window-days N] [--cwd PATH] [--json]
    const cwd = args.cwd ?? process.cwd();
    const dataRoot = findDataRoot(cwd);
    if (!dataRoot) {
      process.stderr.write(
        `[co-engram] not inside a team-memory repository (no .co-engram marker up the tree)\n`,
      );
      process.exit(1);
    }
    const windowDays = args.windowDays ?? 7;
    const auditLog = new AuditLog(dataRoot);
    const stats = computeMergeStats({
      auditLog,
      windowMs: windowDays * 24 * 60 * 60 * 1000,
    });
    const anomalies = detectAnomalies(stats);
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ anomalies, windowDays }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(formatAnomaliesAsText(anomalies) + "\n");
      if (
        anomalies.some((a: { severity: string }) => a.severity === "critical")
      ) {
        process.exit(1);
      }
    }
    return;
  }

  // 未知命令
  process.stderr.write(`Unknown command: ${args.command}\n\n`);
  showHelp();
  process.exit(1);
}

// 仅当 cli.js 作为入口时才运行,避免被其他模块 import 时副作用执行。
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(
      `co-engram CLI error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
