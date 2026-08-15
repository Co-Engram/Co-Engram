#!/usr/bin/env node
/**
 * Co-Engram Daemon 入口
 *
 * 一个长驻进程,持有一份 ToolContext(repository / searchEngine / proposalEngine /
 * maintenance engine / auditLog / viewer / auto-memory watcher),通过 unix socket
 * 服务多个 Claude Code session 的 MCP 请求。
 *
 * 架构:
 *
 *   ┌─────────────────┐      stdio       ┌──────────────────┐
 *   │ Claude Code #1  │ ←──────────────→ │ thin-launcher #1 │
 *   └─────────────────┘                  └────────┬─────────┘
 *                                                  │ unix socket
 *   ┌─────────────────┐      stdio       ┌────────▼─────────┐
 *   │ Claude Code #2  │ ←──────────────→ │ thin-launcher #2 │
 *   └─────────────────┘                  └────────┬─────────┘
 *                                                  │ unix socket
 *                                       ┌──────────▼──────────┐
 *                                       │   daemon (this)     │
 *                                       │ ┌─────────────────┐ │
 *                                       │ │ ToolContext     │ │
 *                                       │ │ (shared state)  │ │
 *                                       │ └─────────────────┘ │
 *                                       │   McpServer #1      │
 *                                       │   McpServer #2      │
 *                                       └─────────────────────┘
 *
 * 与 mcp-server.ts main() 的差异:
 *   - mcp-server.ts main():一个进程 = 一个 session = 一份 ToolContext(stdio)
 *   - daemon-entry.ts:一个进程 = N 个 session 共享一份 ToolContext(socket)
 *
 * 每个 socket 连接创建独立的 McpServer 实例(独立的 session state:request id
 * counter 等),但底层 ToolContext 共享。这样既保留了 MCP 协议的 session 隔离,
 * 又消除了 repository / searchEngine 等重型资源的重复加载(50~100MB / 进程)。
 *
 * 与 mcp-server.ts 共享的 bootstrap 逻辑:目前以代码重复换取 daemon 模式的
 * 独立可演化性。未来 PR 可抽 `bootstrapRuntime()` 公共函数。重复内容:
 *   - dataRoot / config 加载
 *   - language / maintenance / proposal / audit / effectiveness 解析
 *   - LLM client / necessity evaluator 解析
 *   - createCoEngramMcpServer 调用
 *   - git pull / migrate / viewer / auto-memory watcher 启动
 *
 * 启动参数:
 *   - argv[2]:dataRoot 路径(必填,launcher spawn 时传入)
 *   - env:CO_ENGRAM_DAEMON_SOCKET_PATH(可选,override socket 路径)
 *   - env:CO_ENGRAM_DAEMON_IDLE_TIMEOUT_MS(可选,空闲超时,默认 30 分钟)
 *
 * 退出条件:
 *   - 所有 socket 连接断开 + 空闲超时(默认 30 min)→ graceful shutdown
 *   - SIGTERM / SIGINT → graceful shutdown(等待 in-flight 请求完成)
 *   - lockfile 丢失(被外部清理)→ shutdown
 *
 * @module @co-engram/claude-code/daemon
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { execSync } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoEngramMcpServer } from "../register.js";
import { startViewerServer, type ViewerRuntime } from "@co-engram/viewer";
import { resolveNecessityEvaluator, resolveLlmClient } from "../llm-client.js";
import { resolveProfile, PROFILE_TOOL_COUNTS } from "../tool-profile.js";
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
import {
  defaultDaemonLockPath,
  defaultSocketPath,
  hashDataRoot,
  writeDaemonLockfile,
  removeDaemonLockfile,
  DAEMON_PROTOCOL_VERSION,
} from "./protocol.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 解析默认 createdBy(git > config > env),与 mcp-server.ts 同款逻辑。
 *
 * 代码重复是有意为之:daemon 与 mcp-server 入口可独立演化,共享逻辑后续 PR 抽公共模块。
 */
function resolveDefaultCreatedBy(
  persistedConfig: { readonly defaultCreatedBy?: string } | undefined,
): string | undefined {
  const fromConfig =
    persistedConfig?.defaultCreatedBy &&
    persistedConfig.defaultCreatedBy.trim().length > 0
      ? persistedConfig.defaultCreatedBy.trim()
      : undefined;
  const fromEnv = process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
  const envValue =
    fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
  return detectGitAuthor() ?? fromConfig ?? envValue;
}

function getViewerToken(): string | undefined {
  const t = process.env.CO_ENGRAM_VIEWER_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

function getLanguageFromEnv(): Language | undefined {
  const raw = process.env.CO_ENGRAM_LANGUAGE;
  if (!raw) return undefined;
  return parseLanguage(raw);
}

async function main(): Promise<void> {
  const dataRoot = process.argv[2];
  if (!dataRoot) {
    process.stderr.write(
      `[co-engram-daemon] FATAL: missing dataRoot argument\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`[co-engram-daemon] starting (dataRoot=${dataRoot})\n`);

  // === bootstrap(dataRoot / config / language / maintenance / proposal)==
  // 与 mcp-server.ts main() 同款逻辑;daemon 与 mcp-server 是两个不同入口,
  // 共享 bootstrap 未来抽公共函数,当前先代码重复。
  if (process.env.CO_ENGRAM_DATA_ROOT) {
    process.stderr.write(
      `[co-engram-daemon] NOTE: env CO_ENGRAM_DATA_ROOT is deprecated; use 'co-engram config data-root <path>'.\n`,
    );
  }
  // daemon 直接用 argv[2] 作为 dataRoot,不走 resolveBootstrapDataRoot
  // (launcher spawn 前已解析过,这里信任)。但仍要跑 config 自愈。
  const {
    config: persistedConfig,
    event: configEvent,
    backupPath,
  } = await loadAndSelfHealConfig(dataRoot);
  if (configEvent === "created") {
    process.stderr.write(
      `[co-engram-daemon] config.json created with defaults\n`,
    );
  } else if (configEvent === "normalized") {
    process.stderr.write(`[co-engram-daemon] config.json normalized\n`);
  } else if (configEvent === "repaired") {
    process.stderr.write(
      `[co-engram-daemon] config.json repaired, backup at ${backupPath ?? "<unknown>"}\n`,
    );
  }

  const language = resolveLanguage(getLanguageFromEnv(), persistedConfig);
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
        // P0-1 REM 活动量累积阈值/防抖:0 是合法值(禁用/不防抖),必须 !== undefined 判空
        ...(persistedConfig.maintenance?.remActivityThreshold !== undefined
          ? {
              remActivityThreshold:
                persistedConfig.maintenance.remActivityThreshold,
            }
          : {}),
        ...(persistedConfig.maintenance?.remMinIntervalMs !== undefined
          ? { remMinIntervalMs: persistedConfig.maintenance.remMinIntervalMs }
          : {}),
        ...(persistedConfig.maintenance?.learningRate
          ? { learningRate: persistedConfig.maintenance.learningRate }
          : {}),
        ...(persistedConfig.maintenance?.trash
          ? { trash: persistedConfig.maintenance.trash }
          : {}),
      }
    : {};
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
          ? {
              minMessageLength: persistedConfig.proposals.minMessageLength,
            }
          : {}),
        ...(persistedConfig.proposals?.defaultDismissDays
          ? {
              defaultDismissDays: persistedConfig.proposals.defaultDismissDays,
            }
          : {}),
      }
    : undefined;
  const auditEnabled = persistedConfig.audit?.enabled ?? true;
  const effectivenessEnabled = persistedConfig.effectiveness?.enabled ?? true;

  const profileResult = resolveProfile({}, persistedConfig);
  if (profileResult.warned) {
    process.stderr.write(`[co-engram-daemon] ${profileResult.warned}\n`);
  }

  const defaultCreatedBy = resolveDefaultCreatedBy(persistedConfig);
  const necessityEvaluator = resolveNecessityEvaluator(
    persistedConfig.necessityLlm,
  );
  const llmClient = resolveLlmClient(persistedConfig.necessityLlm);

  // === 创建 McpServer + ToolContext(单实例) ===
  const {
    server: primaryServer,
    ctx,
    stopMaintenance,
    stopAuditRotation,
    proposalEngine,
    stopIndexWatcher,
    releaseProcessLock,
    processLock,
    registeredToolCount,
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

  // 标记 primary McpServer 已被 daemon 自己的 control channel 占用,不接受外部连接
  // 实际上我们只复用 ctx,primary server 不连接任何 transport(只是 bootstrap 副作用)
  // 这样 ctx / proposalEngine / maintenance 等都已就绪,后续 socket 连接复用同一 ctx
  void primaryServer;

  // === 启动时 git pull(同 mcp-server.ts) ===
  try {
    execSync("git pull --no-edit", {
      cwd: dataRoot,
      timeout: 30000,
      stdio: "pipe",
    });
    process.stderr.write(`[co-engram-daemon] git pull: synced\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !msg.includes("no tracking information") &&
      !msg.includes("No such remote") &&
      !msg.includes("could not read Username") &&
      !msg.includes("Could not resolve host") &&
      !msg.includes("Network is unreachable") &&
      !msg.includes("already up to date")
    ) {
      const short = msg.includes("\n") ? msg.split("\n")[0]! : msg;
      process.stderr.write(`[co-engram-daemon] git pull: ${short}\n`);
    }
  }

  // === 磁盘字段语言格式迁移(同 mcp-server.ts) ===
  if (persistedConfig.migratedToLanguage !== language) {
    const migrateResult = ctx.repository.migrateFormat(language);
    if (migrateResult.migrated > 0) {
      process.stderr.write(
        `[co-engram-daemon] Migrated ${migrateResult.migrated} file(s) to ${language} format\n`,
      );
    }
    const updatedConfig = normalizeConfig({
      ...persistedConfig,
      migratedToLanguage: language,
    });
    await writeTeamMemoryConfig(dataRoot, updatedConfig);
  }

  // === Viewer(同 mcp-server.ts,holder-only) ===
  // holder gating:viewer 绑定 known port 18899,只有 holder 启(non-holder
  // 启会 EADDRINUSE 重试到随机端口,客户端找不到)。daemon 启动时可能是
  // non-holder(已有别的 holder),后续 onGained 接管时必须启 viewer —— 否则
  // 会出现「daemon 是 holder 却没监听 18899」的静默故障(2026-07 实测,正是
  // viewer 网页打不开的根因:旧实现只检查启动时的 isHolder,缺 onGained)。
  const viewerEnabled = persistedConfig.viewer?.enabled ?? proposalEnabled;
  let viewerRuntime: ViewerRuntime | undefined;
  // 幂等闭包:viewerRuntime 已存在则跳过(避免重复启动占端口)。
  const startHolderViewer = async (): Promise<void> => {
    if (viewerRuntime) return;
    if (!viewerEnabled) return;
    try {
      viewerRuntime = await startViewerServer(ctx, {
        language,
        ...(getViewerToken() ? { token: getViewerToken() } : {}),
        ...(dataRoot ? { dataRoot } : {}),
      });
      process.stderr.write(
        `[co-engram-daemon] Viewer listening on http://127.0.0.1:${viewerRuntime.port}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[co-engram-daemon] Viewer failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (proposalEnabled) {
        process.stderr.write(
          `[co-engram-daemon] WARNING: proposal engine is enabled but viewer is down — Claude Code observe hook will silently no-op.\n`,
        );
      }
    }
  };
  // 失去 holder 锁时关 viewer,让新 holder 能绑同端口。顶层注册一次,
  // viewerRuntime 未启时 stop() 走可选链 noop,覆盖 holder 与 non-holder 两路。
  processLock.onLost(() => {
    viewerRuntime?.stop().catch(() => {
      // ignore — 关闭失败不阻塞失去锁流程
    });
    viewerRuntime = undefined;
  });
  if (processLock.isHolder) {
    // 启动时即是 holder:立即启 viewer(viewer 未启用时闭包内跳过)。
    await startHolderViewer();
  } else {
    // non-holder:viewer 由 holder 启动,本进程工具/hook 仍经 holder 的 viewer。
    // 若后续 holder 退出、本进程接管,靠 onGained 启 viewer
    // (修复点:旧实现缺此分支 → 接管后 18899 静默不监听)。
    if (proposalEnabled) {
      process.stderr.write(
        `[co-engram-daemon] NOTE: non-holder — viewer is started by the holder process; will start viewer if this daemon takes over the lock.\n`,
      );
    }
    processLock.onGained(() => {
      // fire-and-forget:onGained 签名 sync,async 启动不阻塞 retry 流程
      startHolderViewer().catch(() => {
        // ignore — 错误已在 startHolderViewer 内 stderr 提示
      });
    });
  }

  // === Auto-memory watcher(同 mcp-server.ts) ===
  let stopAutoMemoryWatcher: (() => void) | undefined;
  const autoMemorySyncConfig = persistedConfig.autoMemorySync;
  const autoMemorySyncEnabled =
    (process.env.CO_ENGRAM_AUTO_MEMORY_SYNC ??
      (autoMemorySyncConfig?.enabled === false ? "0" : "1")) !== "0";
  if (autoMemorySyncEnabled) {
    try {
      const { AutoMemoryWatcher, AutoMemorySyncEngine } =
        await import("../memory-sync/index.js");
      const homeDir = process.env.HOME ?? "";
      const projectsRoot =
        autoMemorySyncConfig?.projectsRoot ||
        process.env.CO_ENGRAM_CLAUDE_PROJECTS_ROOT ||
        (homeDir ? `${homeDir}/.claude/projects` : "");
      if (projectsRoot && ctx.proposalEngine) {
        const engine = new AutoMemorySyncEngine({
          proposalEngine: ctx.proposalEngine,
          defaultCreatedBy: defaultCreatedBy ?? "unknown",
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
          process.stderr.write(
            `[co-engram-daemon] auto-memory sync: watching ${projectsRoot}\n`,
          );
          stopAutoMemoryWatcher = () => watcher.stop();
        }
      }
    } catch (err) {
      process.stderr.write(
        `[co-engram-daemon] auto-memory sync: failed (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }

  // === Daemon 核心:unix socket server ===
  const socketPath =
    process.env.CO_ENGRAM_DAEMON_SOCKET_PATH ?? defaultSocketPath(dataRoot);
  const lockPath = defaultDaemonLockPath(dataRoot);
  const dataRootHash = hashDataRoot(dataRoot);

  // 清理可能的 stale socket 文件(上次 daemon crash 残留)
  const socketServer = createServer();

  // 活跃连接集合 + 空闲超时
  const connections = new Set<Socket>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleTimeoutMs = parseInt(
    process.env.CO_ENGRAM_DAEMON_IDLE_TIMEOUT_MS ??
      String(DEFAULT_IDLE_TIMEOUT_MS),
    10,
  );
  let shuttingDown = false;

  const armIdleTimer = (): void => {
    if (
      idleTimer !== null ||
      !Number.isFinite(idleTimeoutMs) ||
      idleTimeoutMs <= 0
    )
      return;
    idleTimer = setTimeout(() => {
      if (connections.size === 0 && !shuttingDown) {
        process.stderr.write(
          `[co-engram-daemon] idle timeout (${idleTimeoutMs}ms) — shutting down\n`,
        );
        void shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref();
  };
  const disarmIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /**
   * 每个 socket 连接:
   *   1. 加入 connections 集合(disarm idle timer)
   *   2. 创建独立 McpServer 实例 + StdioServerTransport(socket, socket)
   *   3. 注册所有工具到新 server(共享 ctx)
   *   4. 连接断开 → 从 connections 移除,若空 → arm idle timer
   *
   * McpServer 设计上不支持多 transport 共享(每次 connect 进入 started 状态),
   * 所以必须每连接一个 server 实例。但底层 ToolContext 完全共享 —— 真正的"daemon"
   * 语义(repository / searchEngine / maintenance 单例)。
   */
  socketServer.on("connection", async (socket: Socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    disarmIdleTimer();
    process.stderr.write(
      `[co-engram-daemon] client connected (active=${connections.size})\n`,
    );

    // 创建独立 McpServer,复用 ctx(真正的 daemon 共享)
    try {
      // 直接调 createCoEngramMcpServer 会再启一次 maintenance / fs.watch — 不是我们要的。
      // 我们需要只创建 McpServer 实例 + 注册工具,不重新 bootstrap runtime。
      // 由于 createCoEngramMcpServer 把两者耦合在一起,daemon 模式下我们直接重新注册:
      const { McpServer } =
        await import("@modelcontextprotocol/sdk/server/mcp.js");
      const {
        createToolRegistry,
        wrapAllToolsWithSignalSink,
        wrapAllToolsWithErrorBoundary,
        DEFAULT_LANGUAGE: DEFAULT_LANG,
        pathOverviewFromTree,
        collectSkillCatalog,
      } = await import("@co-engram/core");
      const { registerCoEngramTool, buildInstructionSessionState } =
        await import("../register.js");
      const { buildServerInstructions } = await import("../instructions.js");
      const { filterToolsByProfile } = await import("../tool-profile.js");
      const { registerMcpPrompts } = await import("../prompts.js");
      const { registerMcpResources } = await import("../resources.js");
      const lang = language ?? DEFAULT_LANG;
      // topTags 直接从 repository 实时计算(不从 prompt-signals.json 读缓存)
      const allEngrams = ctx.repository.listEngrams();
      const tagCounts: Record<string, number> = {};
      for (const e of allEngrams) {
        for (const tag of e.domainTags ?? []) {
          const t = tag.trim();
          if (t) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
        }
      }
      const topTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([t]) => t);
      // 团队技能清单(确定性注入,forgotten 已过滤;与 register.ts 装配对齐)
      const skills = ctx.skillRepository
        ? collectSkillCatalog(ctx.skillRepository, dataRoot)
        : [];
      const sessionState = buildInstructionSessionState(topTags, skills);
      const pathOverview = pathOverviewFromTree(
        ctx.repository.listPathTree(),
        2,
      );
      const instructions = buildServerInstructions(
        lang,
        profileResult.profile,
        sessionState,
        pathOverview,
      );

      const perConnServer = new McpServer(
        {
          name: persistedConfig.server?.name ?? "co-engram",
          version: persistedConfig.server?.version ?? "0.0.0",
        },
        {
          capabilities: { tools: {}, prompts: {}, resources: {} },
          instructions,
        },
      );

      // 注册工具,共享 ctx
      const registry = createToolRegistry();
      const errorBoundedTools = wrapAllToolsWithErrorBoundary(registry.list());
      const allWrappedTools = wrapAllToolsWithSignalSink(errorBoundedTools);
      const toolsToRegister = filterToolsByProfile(
        allWrappedTools,
        profileResult.profile,
      );
      for (const tool of toolsToRegister) {
        // localizeToolDescription 已在 registerCoEngramTool 内部调用
        registerCoEngramTool(perConnServer, tool, ctx, lang);
      }
      registerMcpPrompts(perConnServer, ctx, lang);
      registerMcpResources(perConnServer, ctx, lang);

      // socket 作为 stdio 传给 StdioServerTransport(完全接口兼容)
      const transport = new StdioServerTransport(socket, socket);
      await perConnServer.connect(transport);

      socket.on("close", () => {
        connections.delete(socket);
        process.stderr.write(
          `[co-engram-daemon] client disconnected (active=${connections.size})\n`,
        );
        if (connections.size === 0) {
          armIdleTimer();
        }
      });
      socket.on("error", () => {
        // socket 异常(ECONNRESET / EPIPE)→ 静默 close 处理已 cover
        connections.delete(socket);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        if (connections.size === 0) {
          armIdleTimer();
        }
      });
    } catch (err) {
      process.stderr.write(
        `[co-engram-daemon] failed to setup client connection: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      connections.delete(socket);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      if (connections.size === 0) {
        armIdleTimer();
      }
    }
  });

  // === 启动 socket server ===
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    socketServer.once("error", onError);
    socketServer.listen(socketPath, () => {
      socketServer.removeListener("error", onError);
      resolve();
    });
  });

  // 写 lockfile(launcher 通过此文件发现 daemon)
  const now = new Date().toISOString();
  writeDaemonLockfile(lockPath, {
    pid: process.pid,
    socketPath,
    dataRootHash,
    startedAt: now,
    heartbeatAt: now,
    version: DAEMON_PROTOCOL_VERSION,
  });

  // heartbeat:周期更新 lockfile(给 launcher 判 stale 用)
  const heartbeatInterval = setInterval(() => {
    try {
      writeDaemonLockfile(lockPath, {
        pid: process.pid,
        socketPath,
        dataRootHash,
        startedAt: now,
        heartbeatAt: new Date().toISOString(),
        version: DAEMON_PROTOCOL_VERSION,
      });
    } catch {
      // heartbeat 写失败不退出,launcher 会通过 pid + socket 双重判定
    }
  }, 30 * 1000);
  heartbeatInterval.unref();

  process.stderr.write(
    `[co-engram-daemon] listening on ${socketPath} (profile=${profileResult.profile}, ${registeredToolCount}/${PROFILE_TOOL_COUNTS.full} tools, idle timeout=${idleTimeoutMs}ms)\n`,
  );

  // === shutdown ===
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[co-engram-daemon] shutting down\n`);
    disarmIdleTimer();
    clearInterval(heartbeatInterval);
    try {
      await viewerRuntime?.stop();
    } catch {
      // ignore
    }
    try {
      stopMaintenance?.();
    } catch {
      // ignore
    }
    try {
      stopAuditRotation?.();
    } catch {
      // ignore
    }
    try {
      stopAutoMemoryWatcher?.();
    } catch {
      // ignore
    }
    try {
      stopIndexWatcher?.();
    } catch {
      // ignore
    }
    try {
      releaseProcessLock?.();
    } catch {
      // ignore
    }
    // 优雅关闭 socket server:等所有连接 close
    for (const socket of connections) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    try {
      await new Promise<void>((resolve) => {
        socketServer.close(() => resolve());
      });
    } catch {
      // ignore
    }
    removeDaemonLockfile(lockPath);
    // 删除 socket 文件(close 不会自动删)
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // 空闲 timer 启动条件:启动时若 0 连接就 arm(等待第一个 client)
  armIdleTimer();
}

// 仅当作为入口执行时启动 daemon
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error("Co-Engram daemon failed to start:", error);
    process.exit(1);
  });
}
