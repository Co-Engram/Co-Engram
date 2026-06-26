#!/usr/bin/env node
/**
 * Co-Engram CLI: `co-engram init`
 *
 * 初始化 team-memory 仓库,让用户选择语言(中文/英文)并写入持久化配置。
 *
 * 用法:
 *   co-engram init                              # 交互式
 *   co-engram init --path ~/team-memory --language zh
 *   co-engram init --language en --created-by alice
 *   co-engram init --help
 *
 * @module @co-engram/claude-code
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  writeTeamMemoryConfig,
  parseLanguage,
  detectGitAuthor,
  t,
  type Language,
} from "@co-engram/core";
import { resolveDefaultCreatedBy } from "./mcp-server.js";

interface CliArgs {
  readonly command: string;
  readonly path?: string;
  readonly language?: Language;
  readonly createdBy?: string;
  readonly noGit: boolean;
  readonly force: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  let path: string | undefined;
  let language: Language | undefined;
  let createdBy: string | undefined;
  let noGit = false;
  let force = false;
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
    } else if (arg === "--path") {
      path = args[i + 1];
      i++;
    } else if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length);
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
    }
  }
  return { command, path, language, createdBy, noGit, force, help };
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
  // 启动时先用英文,完成语言选择后切换
  let language: Language = args.language ?? "en";

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || args.command === "help" || args.command === "--help") {
    showHelp(args.language);
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

  // 未知命令
  process.stderr.write(`Unknown command: ${args.command}\n\n`);
  showHelp();
  process.exit(1);
}

// 仅当 cli.js 作为入口时才运行,避免被其他模块 import 时副作用执行。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(
      `co-engram CLI error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
