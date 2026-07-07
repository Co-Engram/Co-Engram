#!/usr/bin/env node
/**
 * Co-Engram MCP Server (stdio)
 *
 * Claude Code 集成方式：
 *
 * 1. 全局安装：
 *    ```
 *    npm install -g @co-engram/claude-code
 *    ```
 *
 * 2. Claude Code MCP 配置（`~/.config/claude-code/config.json` 或 GUI 配置）：
 *    ```json
 *    {
 *      "mcpServers": {
 *        "co-engram": {
 *          "command": "co-engram-mcp",
 *          "env": {
 *            "CO_ENGRAM_DATA_ROOT": "/home/your/team-memory",
 *            "CO_ENGRAM_MAINTENANCE": "1",
 *            "CO_ENGRAM_MAINTENANCE_ENABLED_STAGES": "light,deep,rem"
 *          }
 *        }
 *      }
 *    }
 *    ```
 *
 * 或直接运行：
 *    ```
 *    CO_ENGRAM_DATA_ROOT=/path/to/team-memory node dist/mcp-server.js
 *    ```
 *
 * 维护服务相关环境变量（全部可选）：
 *   CO_ENGRAM_MAINTENANCE=1                    启动自动维护（默认关闭）
 *   CO_ENGRAM_MAINTENANCE_ENABLED_STAGES       csv,如 "light,deep,rem"（默认三阶段全开）
 *   CO_ENGRAM_MAINTENANCE_LIGHT_INTERVAL_MS    light 阶段间隔（默认 5min）
 *   CO_ENGRAM_MAINTENANCE_DEEP_INTERVAL_MS     deep 阶段间隔（默认 1h）
 *   CO_ENGRAM_MAINTENANCE_REM_INTERVAL_MS      rem 阶段间隔（默认 7d）
 *   CO_ENGRAM_MAINTENANCE_LEARNING_RATE        RPE 学习率（默认 0.1）
 *   CO_ENGRAM_TRASH_ENABLED=1                  启用 trash sweep（默认关闭）
 *   CO_ENGRAM_TRASH_AFTER_DAYS=N               forgotten 后多少天移入回收站（默认 30）
 *   CO_ENGRAM_TRASH_PURGE_AFTER_DAYS=N         回收站多少天后物理删除（默认 365;0=永不）
 *
 * Observability 相关环境变量（全部可选,M1 新增）：
 *   CO_ENGRAM_AUDIT_ENABLED=0                  关闭审计日志（默认开启）
 *   CO_ENGRAM_EFFECTIVENESS_ENABLED=0          关闭有效性追踪（默认开启）
 *   CO_ENGRAM_PROPOSALS_ENABLED=1              启用候选提案机制（默认开启）
 *   CO_ENGRAM_PROPOSALS_THRESHOLD=N            触发阈值（默认 3）
 *   CO_ENGRAM_PROPOSALS_SIMILARITY=0.X         余弦相似度阈值（默认 0.75）
 *
 * Viewer 相关环境变量（M2 新增）：
 *   CO_ENGRAM_VIEWER_ENABLED=0                 关闭 web viewer（默认跟随 proposal engine）
 *   CO_ENGRAM_VIEWER_PORT=N                    端口(覆盖默认;Claude Code 默认 18799,OpenClaw 默认 18899)
 *   CO_ENGRAM_VIEWER_TOKEN=secret              可选 bearer token
 *
 * @module @co-engram/claude-code
 */

import { realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoEngramMcpServer } from "./register.js";
import { startViewerServer, type ViewerRuntime } from "@co-engram/viewer";
import { resolveNecessityEvaluator, resolveLlmClient } from "./llm-client.js";
import { resolveProfile, PROFILE_TOOL_COUNTS } from "./tool-profile.js";
import {
  parseLanguage,
  readTeamMemoryConfig,
  resolveLanguage,
  translatePrompt,
  pluralSuffix,
  writeTeamMemoryConfig,
  loadAndSelfHealConfig,
  normalizeConfig,
  detectGitAuthor,
  resolveBootstrapDataRoot,
  DEFAULT_LANGUAGE,
  type Language,
} from "@co-engram/core";
import type { MaintenanceConfig, ProposalEngineConfig } from "@co-engram/core";
import { commitFiles } from "@co-engram/core";

/**
 * 解析默认 createdBy 的完整 fallback 链
 *
 * git 身份(user.name → user.email)> 持久化 config > env CO_ENGRAM_DEFAULT_CREATED_BY > undefined。
 * git 优先:本地开发场景下 git 是最权威的身份源,避免 init 时一次性写入的 config 快照
 * (可能取自 $USER)和被意外注入的 env 覆盖真实身份。
 * 调用方传入 persistedConfig.defaultCreatedBy 作为中间层兜底。
 *
 * env CO_ENGRAM_DEFAULT_CREATED_BY 是仅存的配置 env 之一(无 git 环境逃生口);
 * 其他全部配置以 dataRoot 内 config.json 为权威(参见 @co-engram/core/config)。
 */
export function resolveDefaultCreatedBy(
  persistedConfig: { readonly defaultCreatedBy?: string } | undefined,
): string | undefined {
  const fromConfig =
    persistedConfig?.defaultCreatedBy &&
    persistedConfig.defaultCreatedBy.trim().length > 0
      ? persistedConfig.defaultCreatedBy.trim()
      : undefined;
  return (
    detectGitAuthor() ?? fromConfig ?? getDefaultCreatedByFromEnvInternal()
  );
}

/**
 * 读取 env CO_ENGRAM_DEFAULT_CREATED_BY 的值(内部 helper)
 *
 * env CO_ENGRAM_DEFAULT_CREATED_BY 是仅存的配置 env 之一(无 git 环境逃生口)。
 */
function getDefaultCreatedByFromEnvInternal(): string | undefined {
  const raw = process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * 读取 env CO_ENGRAM_VIEWER_TOKEN 的值(内部 helper)
 *
 * 敏感信息,不进 config.json,只能由 env 提供。
 */
function getViewerTokenInternal(): string | undefined {
  const t = process.env.CO_ENGRAM_VIEWER_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

/**
 * 解析 env CO_ENGRAM_LANGUAGE(内部 helper)
 *
 * 仍允许 env 覆盖持久化配置(向后兼容,用于 CI 临时实验)。
 */
function getLanguageFromEnvInternal(): Language | undefined {
  const raw = process.env.CO_ENGRAM_LANGUAGE;
  if (!raw) return undefined;
  return parseLanguage(raw);
}

/**
 * 本地化 buildProposalPrompt(系统提示注入文本)
 *
 * 默认英文。
 */
export function buildLocalizedProposalPrompt(
  count: number,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const plural = pluralSuffix(language, count);
  return translatePrompt(language, "prompt.proposal_prompt", { count, plural });
}

async function main(): Promise<void> {
  // === 阶段 1:bootstrap dataRoot 解析(单一权威入口) ===
  // 从 ~/.co-engram/config.json 读取 dataRoot;文件不存在/损坏时 fallback 到默认。
  // 不再支持 env CO_ENGRAM_DATA_ROOT / desiredDataRoot redirect(已废弃,统一由
  // `co-engram config data-root <path>` CLI 命令修改)。
  if (process.env.CO_ENGRAM_DATA_ROOT) {
    process.stderr.write(
      `[co-engram] NOTE: env CO_ENGRAM_DATA_ROOT is deprecated and ignored. Use 'co-engram config data-root <path>' to change dataRoot.\n`,
    );
  }
  const { dataRoot, warnings } = await resolveBootstrapDataRoot();
  for (const w of warnings) {
    process.stderr.write(`[co-engram] ${w}\n`);
  }

  // === 阶段 2:加载权威 config(自愈 + 迁移) ===
  // 这之后完全以 persistedConfig 为权威,不再读 env(除 DATA_ROOT/VIEWER_TOKEN/DEFAULT_CREATED_BY)。
  const {
    config: persistedConfig,
    event: configEvent,
    backupPath,
  } = await loadAndSelfHealConfig(dataRoot);
  if (configEvent === "created") {
    process.stderr.write(
      `[co-engram] config.json not found at ${dataRoot}, created with defaults\n`,
    );
  } else if (configEvent === "normalized") {
    process.stderr.write(
      `[co-engram] config.json normalized (legacy fields migrated / missing fields filled)\n`,
    );
  } else if (configEvent === "repaired") {
    process.stderr.write(
      `[co-engram] config.json was corrupt, backed up to ${backupPath ?? "<unknown>"} and rewritten with defaults\n`,
    );
  }

  // === 阶段 3:从 config 解析运行时参数 ===
  // language 仍允许 env 覆盖(向后兼容 CO_ENGRAM_LANGUAGE),其他全部以 config 为准。
  const language = resolveLanguage(
    getLanguageFromEnvInternal(),
    persistedConfig,
  );
  const maintenanceEnabled = persistedConfig.maintenance?.enabled ?? true;
  const maintenanceConfig = maintenanceEnabled
    ? {
        ...(persistedConfig.maintenance?.enabledStages
          ? { enabledStages: persistedConfig.maintenance.enabledStages }
          : {}),
        ...(persistedConfig.maintenance?.lightIntervalMs
          ? { lightIntervalMs: persistedConfig.maintenance.lightIntervalMs }
          : {}),
        ...(persistedConfig.maintenance?.deepIntervalMs
          ? { deepIntervalMs: persistedConfig.maintenance.deepIntervalMs }
          : {}),
        ...(persistedConfig.maintenance?.remIntervalMs
          ? { remIntervalMs: persistedConfig.maintenance.remIntervalMs }
          : {}),
        ...(persistedConfig.maintenance?.learningRate
          ? { learningRate: persistedConfig.maintenance.learningRate }
          : {}),
        ...(persistedConfig.maintenance?.trash
          ? { trash: persistedConfig.maintenance.trash }
          : {}),
      }
    : {};
  // low-friction-defaults:默认 enabled=true,但尊重用户显式 false,只 stderr 提示一次
  if (maintenanceEnabled === false) {
    process.stderr.write(
      `[co-engram] NOTE: maintenance disabled by config.json (default is enabled)\n`,
    );
  }
  if (
    maintenanceEnabled &&
    persistedConfig.maintenance?.trash?.enabled === false
  ) {
    process.stderr.write(
      `[co-engram] NOTE: trash sweep disabled by config (default changed to enabled; edit config.json to re-enable)\n`,
    );
  }
  const proposalEnabled = persistedConfig.proposals?.enabled ?? true;
  const proposalConfig = proposalEnabled
    ? {
        ...(persistedConfig.proposals?.threshold
          ? { threshold: persistedConfig.proposals.threshold }
          : {}),
        ...(persistedConfig.proposals?.similarityThreshold
          ? {
              similarityThreshold:
                persistedConfig.proposals.similarityThreshold,
            }
          : {}),
        ...(persistedConfig.proposals?.maxSamples
          ? { maxSamples: persistedConfig.proposals.maxSamples }
          : {}),
        ...(persistedConfig.proposals?.minMessageLength
          ? { minMessageLength: persistedConfig.proposals.minMessageLength }
          : {}),
        ...(persistedConfig.proposals?.defaultDismissDays
          ? { defaultDismissDays: persistedConfig.proposals.defaultDismissDays }
          : {}),
      }
    : undefined;
  const auditEnabled = persistedConfig.audit?.enabled ?? true;
  const effectivenessEnabled = persistedConfig.effectiveness?.enabled ?? true;

  // 工具 profile:仅看 config(env 废除)
  const profileResult = resolveProfile({}, persistedConfig);
  if (profileResult.warned) {
    process.stderr.write(`[co-engram] ${profileResult.warned}\n`);
  }

  // 默认 createdBy:git > config > env CO_ENGRAM_DEFAULT_CREATED_BY(保留 env 作为无 git 环境逃生口)
  const defaultCreatedBy = resolveDefaultCreatedBy(persistedConfig);

  // 必要性评估器:用 Claude Code 环境的 ANTHROPIC_API_KEY 调 Claude
  // 没配 key 时返回 undefined,ProposalEngine 内部用 RuleBasedNecessityEvaluator 兜底
  const necessityEvaluator = resolveNecessityEvaluator(
    persistedConfig.necessityLlm,
  );
  // 原始 LlmClient:供 engram_synthesize 等需要直接调 LLM 的工具用
  // 与 necessityEvaluator 共享同一份配置,避免重复建连
  const llmClient = resolveLlmClient(persistedConfig.necessityLlm);

  const {
    server,
    ctx,
    stopMaintenance,
    stopAuditRotation,
    proposalEngine,
    registeredToolCount,
    dataRootAutoCreated,
    stopIndexWatcher,
  } = createCoEngramMcpServer({
    dataRoot,
    serverName: persistedConfig.server?.name ?? "co-engram",
    serverVersion: persistedConfig.server?.version ?? "0.0.0",
    language,
    startMaintenance: maintenanceEnabled,
    maintenanceConfig,
    auditEnabled,
    auditRotationConfig: persistedConfig.audit?.rotation,
    effectivenessEnabled,
    proposalEnabled,
    proposalConfig,
    profile: profileResult.profile,
    ...(defaultCreatedBy ? { defaultCreatedBy } : {}),
    ...(necessityEvaluator ? { necessityEvaluator } : {}),
    ...(llmClient ? { llmClient } : {}),
  });

  // 会话级 dirty flag:写工具调用后置位,shutdown 时据此判断是否 auto-commit
  let sessionDirty = false;
  ctx.markDirty = () => {
    sessionDirty = true;
  };

  // 启动时 git pull:拉取远端其他主机的变更,merge driver 自动解决冲突
  try {
    execSync("git pull --no-edit", {
      cwd: dataRoot,
      timeout: 30000,
      stdio: "pipe",
    });
    process.stderr.write(`[co-engram] git pull: synced\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 无远端配置 / 无网络 / 无追踪分支 → 静默,不是错误
    if (
      !msg.includes("no tracking information") &&
      !msg.includes("No such remote") &&
      !msg.includes("could not read Username") &&
      !msg.includes("Could not resolve host") &&
      !msg.includes("Network is unreachable") &&
      !msg.includes("already up to date")
    ) {
      const short = msg.includes("\n") ? msg.split("\n")[0]! : msg;
      process.stderr.write(`[co-engram] git pull: ${short}\n`);
    }
  }

  // === 阶段 4:磁盘字段语言格式迁移 ===
  // 若 config.migratedToLanguage 与当前 language 不一致,重写所有 engram/synapse 文件。
  // 写回 config 时用 normalize 保护(避免迁移期间丢失嵌套字段)。
  if (persistedConfig.migratedToLanguage !== language) {
    const migrateResult = ctx.repository.migrateFormat(language);
    if (migrateResult.migrated > 0) {
      process.stderr.write(
        `[co-engram] Migrated ${migrateResult.migrated} file(s) to ${language === "zh" ? "Chinese (中文 / 底部 frontmatter)" : "English (英文 / 顶部 frontmatter)"} format; skipped ${migrateResult.skipped} already-target\n`,
      );
    }
    if (migrateResult.errors.length > 0) {
      process.stderr.write(
        `[co-engram] Migration encountered ${migrateResult.errors.length} error(s):\n${migrateResult.errors.map((e) => `  - ${e}`).join("\n")}\n`,
      );
    }
    const updatedConfig = normalizeConfig({
      ...persistedConfig,
      migratedToLanguage: language,
    });
    await writeTeamMemoryConfig(dataRoot, updatedConfig);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 启动 logging:工具 profile + 数据状态 + 首次运行提示
  try {
    if (dataRootAutoCreated) {
      process.stderr.write(
        `[co-engram] Initialized new data repo at ${dataRoot} (no engrams yet — run "co-engram init" to pick a language and configure maintenance)\n`,
      );
    }
    const engramCount = ctx.repository.listEngrams().length;
    process.stderr.write(
      `[co-engram] Loaded ${engramCount} engrams, profile=${profileResult.profile} (${registeredToolCount}/${PROFILE_TOOL_COUNTS.full} tools visible to LLM)\n`,
    );
    if (engramCount === 0 && !dataRootAutoCreated) {
      process.stderr.write(
        `[co-engram] No memories yet — the LLM will start capturing once you discuss decisions, preferences, or lessons learned.\n`,
      );
    }
  } catch {
    // ignore logging failure
  }

  // M3b: 会话开始时注入候选提示（如果有 pending proposals）
  if (proposalEngine) {
    try {
      const pending = proposalEngine.listPending();
      if (pending.length > 0) {
        const message = buildLocalizedProposalPrompt(pending.length, language);
        await server.sendLoggingMessage({ level: "info", data: message });
      }
    } catch {
      // 提示失败不阻塞 server
    }
  }

  // M2: 启动 viewer HTTP server。
  // 默认行为:跟随 proposal engine(proposal 开 → viewer 也开,因为 observe hook 需要 HTTP 通路)。
  // config.viewer?.enabled 可显式覆盖(true 强制开 / false 强制关)。
  // VIEWER_TOKEN 仍由 env 提供(敏感信息不进 config.json)。
  // 端口:不再读 persistedConfig.viewer.port(已废弃,避免两宿主共享 persisted config 时冲突)。
  // 由 viewer 内部按 hostType 决定默认(Claude Code=18799),或 env CO_ENGRAM_VIEWER_PORT 覆盖。
  const viewerEnabled = persistedConfig.viewer?.enabled ?? proposalEnabled;
  let viewerRuntime: ViewerRuntime | undefined;
  if (viewerEnabled) {
    try {
      viewerRuntime = await startViewerServer(ctx, {
        language,
        ...(getViewerTokenInternal()
          ? { token: getViewerTokenInternal() }
          : {}),
        ...(dataRoot ? { dataRoot } : {}),
      });
      process.stderr.write(
        `[co-engram] Viewer listening on http://127.0.0.1:${viewerRuntime.port}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[co-engram] Viewer failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (proposalEnabled) {
        process.stderr.write(
          `[co-engram] WARNING: proposal engine is enabled but viewer is down — Claude Code observe hook will silently no-op. Consider retrying viewer start.\n`,
        );
      }
    }
  } else if (proposalEnabled) {
    process.stderr.write(
      `[co-engram] NOTE: viewer is disabled but proposal engine is enabled — Claude Code observe hook will NOT be able to reach the engine (OpenClaw in-process path still works).\n`,
    );
  }

  // M3d: proposal engine 启用时,自动 patch Claude Code settings.json 挂 hook
  //
  // 必须放在 viewer 启动之后,以便把真实 viewer URL(可能非默认端口)写进
  // settings.json 的 env 块,hook 子进程才能找到 viewer。
  // 幂等:已是期望状态则跳过。失败只 stderr 提示,不阻塞 MCP server 启动。
  if (proposalEngine) {
    try {
      const { ensureClaudeCodeHooksInstalled, DEFAULT_VIEWER_URL } =
        await import("./hooks/installer.js");
      const viewerUrl = viewerRuntime
        ? `http://127.0.0.1:${viewerRuntime.port}`
        : DEFAULT_VIEWER_URL;
      ensureClaudeCodeHooksInstalled({ viewerUrl });
    } catch (err) {
      process.stderr.write(
        `[co-engram] hook auto-install skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Feature 3: Claude Code auto-memory → co-engram proposal 同步
  //
  // Claude Code 在 `~/.claude/projects/<encoded-cwd>/memory/*.md` 维护一份自动记忆
  // (user/feedback/project/reference/pattern 类型)。本 watcher 把这份记忆同步为
  // co-engram **proposal**(候选提案),让 co-engram 不必等用户手动调 engram_create
  // 就能感知 Claude Code 已捕获的偏好与决策;同时,proposal 必须经 engram_accept_proposal
  // 主动审批才落库为 engram,避免未审核内容直接污染检索池。
  //
  // 设计说明:
  //   - 默认 true(low-friction-defaults);config.autoMemorySync.enabled=false 或
  //     env CO_ENGRAM_AUTO_MEMORY_SYNC=0 可关闭
  //   - 幂等:entityId = `am:<slug>`(由 ProposalEngine.proposeAutoMemory 维护),
  //     slug 重复且 payload 未变化时 no-change;payload 变化时 upsert
  //   - **仅在 Claude Code MCP 启动**:OpenClaw 没有"自动记忆写入器"的等价物,
  //     该 watcher 不在 openclaw-plugin 内启动(见 CLAUDE.md 双场景一致性规则)
  //   - 失败不阻塞 MCP server 启动(projectsRoot 不存在时 enabled=false)
  let stopAutoMemoryWatcher: (() => void) | undefined;
  const autoMemorySyncConfig = persistedConfig.autoMemorySync;
  const autoMemorySyncEnabled =
    (process.env.CO_ENGRAM_AUTO_MEMORY_SYNC ??
      (autoMemorySyncConfig?.enabled === false ? "0" : "1")) !== "0";
  if (autoMemorySyncEnabled) {
    try {
      const { AutoMemoryWatcher, AutoMemorySyncEngine } = await import(
        "./memory-sync/index.js"
      );
      const homeDir = process.env.HOME ?? "";
      const projectsRoot =
        autoMemorySyncConfig?.projectsRoot ||
        process.env.CO_ENGRAM_CLAUDE_PROJECTS_ROOT ||
        (homeDir ? `${homeDir}/.claude/projects` : "");
      if (projectsRoot) {
        if (!ctx.proposalEngine) {
          process.stderr.write(
            `[co-engram] auto-memory sync: disabled (ProposalEngine not available in ToolContext)\n`,
          );
        } else {
          const engine = new AutoMemorySyncEngine({
            proposalEngine: ctx.proposalEngine,
            defaultCreatedBy: defaultCreatedBy ?? "claude-code-auto-memory",
            log: (msg) => process.stderr.write(`${msg}\n`),
          });
          const watcher = new AutoMemoryWatcher({
            projectsRoot,
            engine,
            debounceMs: autoMemorySyncConfig?.debounceMs,
            log: (msg) => process.stderr.write(`${msg}\n`),
          });
          const startResult = watcher.start();
          if (startResult.enabled) {
            const stats = startResult.initialSync;
            process.stderr.write(
              `[co-engram] auto-memory sync: watching ${projectsRoot}` +
                (stats
                  ? ` (initial: ${stats.files} files, ${stats.proposed} proposed, ${stats.updated} updated)`
                  : "") +
                `\n`,
            );
            stopAutoMemoryWatcher = () => watcher.stop();
          } else {
            process.stderr.write(
              `[co-engram] auto-memory sync: disabled (${startResult.reason ?? "unknown reason"})\n`,
            );
          }
        }
      } else {
        process.stderr.write(
          `[co-engram] auto-memory sync: disabled (cannot resolve projectsRoot — set HOME or CO_ENGRAM_CLAUDE_PROJECTS_ROOT)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[co-engram] auto-memory sync: failed to start (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  } else {
    process.stderr.write(
      `[co-engram] auto-memory sync: disabled by config\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await viewerRuntime?.stop();
    } catch {
      // ignore
    }
    try {
      stopMaintenance?.();
    } catch {
      // ignore — maintenance 清理失败不阻塞退出
    }
    try {
      stopAuditRotation?.();
    } catch {
      // ignore — audit rotation 关闭失败不阻塞退出
    }
    try {
      stopAutoMemoryWatcher?.();
    } catch {
      // ignore — auto-memory watcher 关闭失败不阻塞退出
    }
    try {
      stopIndexWatcher?.();
    } catch {
      // ignore — watcher 关闭失败不阻塞退出
    }
    try {
      await server.close();
    } catch {
      // ignore
    }
    // auto-commit:会话结束后若记忆有变化,自动 git commit + push
    if (sessionDirty) {
      const forceExit = setTimeout(() => process.exit(0), 60000);
      forceExit.unref();
      try {
        const result = commitFiles({
          repoPath: dataRoot,
          files: [],
          message: "co-engram(auto): session changes",
        });
        if (result.commitHash) {
          process.stderr.write(
            `[co-engram] auto-commit: ${result.commitHash.slice(0, 7)} (${result.filesChanged} files)\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `[co-engram] auto-commit failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      try {
        execSync("git push", { cwd: dataRoot, timeout: 30000, stdio: "pipe" });
        process.stderr.write(`[co-engram] auto-push: ok\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const short = msg.includes("\n") ? msg.split("\n")[0]! : msg;
        process.stderr.write(`[co-engram] auto-push: ${short}\n`);
      }
      clearTimeout(forceExit);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// 仅当 mcp-server.js 作为入口时才启动 MCP server。
// cli.js 会 import 本模块的工具函数(如 getDefaultCreatedByFromEnv),
// 必须避免在那种情况下副作用启动 server。
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error("Co-Engram MCP server failed to start:", error);
    process.exit(1);
  });
}
