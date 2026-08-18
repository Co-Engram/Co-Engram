/**
 * dsh 宿主组装编排
 *
 * 方案 B:从 claude-code-mcp register.ts 裁剪复制(跨宿主第三份,openclaw 已示范
 * 同模式),差异:
 *   - host 标识统一 "dsh-plugin"(ProcessLock / ToolContext / audit 来源可区分)
 *   - 无 McpServer 构建与 MCP prompts/resources 注册
 *   - 无 daemon 分支 / Claude Code hooks auto-install / 启动期 git pull / 语言迁移
 *   - 第一版不带 necessityLlm / llmClient(ProposalEngine 内部 RuleBased 兜底,
 *     engram_synthesize 无 LLM 时降级;README 注明)
 *
 * @module @co-engram/dsh
 */
import {
  bootstrapRepositoryAndSearch,
  acquireProcessLock,
  verifyDerivedIntegrity,
  createDefaultSignalSink,
  SkillRepository,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  Incubator,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  DEFAULT_AUDIT_CONFIG,
  detectGitAuthor,
  createToolRegistry,
  wrapAllToolsWithErrorBoundary,
  resolveBootstrapDataRoot,
  resolveMergeDriverBundle,
  autoOnboardMergeDriver,
  collectDigestLines,
  resolveProfile,
  filterToolsByProfile,
  type Language,
  type MaintenanceConfig,
  type ProposalEngineConfig,
  type AuditRotationConfig,
  type ProcessLock,
  type SearchOrchestrator,
  type EngramRepository,
  type Tool,
  type ToolContext,
} from "@co-engram/core";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHeadlessExecutor } from "./headless-executor.js";
import { startMaintenanceRuntime } from "./maintenance-runtime.js";

/** dsh 插件配置(cordis.yml 的 config 节,宽容解析) */
export interface DshPluginConfig {
  readonly language?: Language;
  readonly defaultCreatedBy?: string;
  readonly startMaintenance?: boolean;
  readonly maintenanceConfig?: MaintenanceConfig;
  readonly auditEnabled?: boolean;
  readonly auditRotationConfig?: AuditRotationConfig;
  readonly effectivenessEnabled?: boolean;
  readonly proposalEnabled?: boolean;
  readonly proposalConfig?: ProposalEngineConfig;
  readonly autoOnboardMergeDriver?: boolean;
  /** 仅测试注入 dataRoot 用;生产路径走 resolveBootstrapDataRoot() */
  readonly dataRootOverrideForTest?: string;
}

/** 组装产物:index.ts 消费 */
export interface DshRuntime {
  readonly ctx: ToolContext;
  readonly tools: readonly Tool[];
  readonly language: Language;
  readonly dataRoot: string;
  readonly processLock: ProcessLock;
  readonly stop: () => void;
}

/**
 * 定位已安装的 merge-driver bundle
 *
 * 复制自 claude-code-mcp register.ts:755(core exports 只声明 import 条件,
 * 需显式 conditions 解析)。
 */
function findInstalledMergeDriverBundle(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const opts = { conditions: ["import", "default"] } as unknown as Parameters<
      typeof require.resolve
    >[1];
    const typesEntryPath = require.resolve("@co-engram/core/types", opts);
    const coreDistDir = typesEntryPath.replace(/\/types\/[^/]+$/, "");
    return resolveMergeDriverBundle(coreDistDir);
  } catch {
    return null;
  }
}

/**
 * 重建搜索索引(复制自 register.ts:782,跨宿主契约一致)
 *
 * SQLite 模式 build() 是 no-op 且 collectDigestLines N+1 会拖慢启动,
 * 走 SqliteSearchEngineAdapter 时跳过;memory 模式仍全量。
 */
function rebuildSearchIndex(
  search: SearchOrchestrator | import("@co-engram/core").SearchEngine,
  repo: EngramRepository,
): void {
  const isSqliteEngine =
    typeof search === "object" &&
    search !== null &&
    search.constructor &&
    search.constructor.name === "SqliteSearchEngineAdapter";
  if (isSqliteEngine) {
    return;
  }
  search.build(collectDigestLines(repo));
}

/** 组装 dsh 宿主运行时 */
export async function createDshRuntime(
  config: DshPluginConfig,
): Promise<DshRuntime> {
  // dataRoot:测试注入 > resolveBootstrapDataRoot(~/.co-engram/config.json 权威)
  const dataRoot =
    config.dataRootOverrideForTest ??
    (await resolveBootstrapDataRoot()).dataRoot;
  if (!existsSync(dataRoot)) {
    mkdirSync(dataRoot, { recursive: true });
  }

  // 进程锁:与 claude-code-mcp / openclaw-plugin 共用 dataRoot 时,
  // 后台任务(maintenance/rotation/watcher/viewer)仅 holder 启动
  const processLock = acquireProcessLock({ dataRoot, host: "dsh-plugin" });

  const { repository, searchEngine } = bootstrapRepositoryAndSearch({ dataRoot });
  rebuildSearchIndex(searchEngine, repository);

  // 完整性自检:只告警不阻塞(register.ts:283 同款)
  try {
    const report = verifyDerivedIntegrity(dataRoot);
    if (report.status !== "ok") {
      for (const issue of report.issues) {
        process.stderr.write(
          `[co-engram] integrity ${report.status}: ${issue.kind} — ${issue.message}\n`,
        );
      }
    }
  } catch {
    // 自检异常不阻塞启动,fail-loud 由工具调用保证
  }

  const signalSink = createDefaultSignalSink(dataRoot);
  const skillRepository = new SkillRepository(dataRoot);

  const auditEnabled = config.auditEnabled !== false;
  const auditLog = auditEnabled ? new AuditLog(dataRoot) : undefined;
  const effectivenessTracker =
    config.effectivenessEnabled !== false && auditLog
      ? new EffectivenessTracker(dataRoot, auditLog)
      : undefined;
  const proposalEngine =
    config.proposalEnabled !== false && auditLog
      ? new ProposalEngine({
          repository,
          embedder: DEFAULT_HASHER_EMBEDDER,
          auditLog,
          dataRoot,
          // H7 归因:proposal 审计 accept 决策带宿主标识,跨宿主可追溯
          host: "dsh-plugin",
          config: {
            // hash-based embedder 必须配套更低阈值(见 core 内常量注释)
            similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD,
            ...(config.proposalConfig ?? {}),
          },
          skillRepository,
          ...(config.defaultCreatedBy
            ? { defaultCreatedBy: config.defaultCreatedBy }
            : {}),
          resolveCreatedBy: () => detectGitAuthor() ?? config.defaultCreatedBy,
        })
      : undefined;
  const incubator = proposalEngine
    ? new Incubator({
        repository,
        proposalEngine,
        dataRoot,
        ...(auditLog ? { auditLog } : {}),
        executor: createHeadlessExecutor(),
        // 注:incubator 不再接 processLock —— incubations.json 走 RMW 短临界区
        // 锁(2026-08-19 修复:holder-only 落盘让 non-holder 假成功)
        // PDCA(Phase1):引擎侧调用流水快照(同进程 sink;flush+snapshot
        // 不消费 drain 队列)
        signalEvidence: signalSink,
      })
    : undefined;

  const ctx: ToolContext = {
    repository,
    searchOrchestrator: searchEngine,
    signalSink,
    // 双宿主契约:audit entry 区分来源(host 标识透传)
    host: "dsh-plugin",
    ...(auditLog ? { auditLog } : {}),
    ...(effectivenessTracker ? { effectivenessTracker } : {}),
    ...(proposalEngine ? { proposalEngine } : {}),
    ...(skillRepository ? { skillRepository } : {}),
    ...(config.defaultCreatedBy
      ? { defaultCreatedBy: config.defaultCreatedBy }
      : {}),
    resolveCreatedBy: () => detectGitAuthor() ?? config.defaultCreatedBy,
    ...(incubator ? { incubator } : {}),
  };

  const language = config.language ?? "en";
  const profile = resolveProfile({}).profile;
  const errorBounded = wrapAllToolsWithErrorBoundary(createToolRegistry().list());
  const tools = filterToolsByProfile(errorBounded, profile);

  // holder-only 任务 + onLost/onGained 完整状态转移(register.ts:427-517 同款)
  let stopMaintenance: (() => void) | undefined;
  let stopAuditRotation: (() => void) | undefined;
  processLock.onLost(() => {
    try {
      ctx.repository.stopWatching();
    } catch {
      // ignore — 未启动 watcher 时 stopWatching 抛错容忍
    }
    stopMaintenance?.();
    stopAuditRotation?.();
  });
  const startHolderTasks = (): void => {
    if (
      stopMaintenance === undefined &&
      config.startMaintenance === true &&
      ctx.signalSink
    ) {
      const runtime = startMaintenanceRuntime(
        {
          repository: ctx.repository,
          signalSink: ctx.signalSink,
          dataRoot,
          ...(effectivenessTracker ? { effectivenessTracker } : {}),
          ...(ctx.proposalEngine ? { proposalEngine: ctx.proposalEngine } : {}),
          ...(skillRepository ? { skillRepository } : {}),
          ...(incubator ? { incubator } : {}),
        },
        config.maintenanceConfig ?? {},
      );
      stopMaintenance = runtime.stop;
    }
    if (stopAuditRotation === undefined && auditLog) {
      const rc = {
        ...DEFAULT_AUDIT_CONFIG.rotation,
        ...(config.auditRotationConfig ?? {}),
      };
      if (rc.enabled !== false) {
        stopAuditRotation = auditLog.startAutoRotation({
          retentionDays: rc.retentionDays!,
          highValueRetentionDays: rc.highValueRetentionDays!,
          maxSizeMb: rc.maxSizeMb!,
          intervalMs: rc.intervalMs!,
        });
      }
    }
    if (proposalEngine) {
      ctx.repository.setExternalMarkdownHook(
        proposalEngine.createExternalMarkdownHook({}),
      );
      ctx.repository.setSkillHook(proposalEngine.createSkillHook());
    }
    ctx.repository.startWatching();
  };
  if (processLock.isHolder) {
    startHolderTasks();
  } else {
    processLock.onGained(startHolderTasks);
  }

  // merge driver auto-onboard(幂等,失败不阻塞)
  if (config.autoOnboardMergeDriver !== false) {
    const bundleSource = findInstalledMergeDriverBundle();
    if (bundleSource) {
      const result = autoOnboardMergeDriver({
        dataRoot,
        bundleSourcePath: bundleSource,
      });
      if (result.attempted && result.error) {
        process.stderr.write(
          `[co-engram] Auto-onboard merge driver failed: ${result.error}\n`,
        );
      }
    }
  }

  return {
    ctx,
    tools,
    language,
    dataRoot,
    processLock,
    stop: (): void => {
      try {
        ctx.repository.stopWatching();
      } catch {
        // ignore
      }
      stopMaintenance?.();
      stopAuditRotation?.();
      processLock.release();
    },
  };
}
