/**
 * 把 Co-Engram Tool 注册到 MCP McpServer
 *
 * @module @co-engram/claude-code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EngramRepository,
  SearchOrchestrator,
  bootstrapRepositoryAndSearch,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  createToolRegistry,
  createDefaultSignalSink,
  wrapAllToolsWithSignalSink,
  localizeToolDescription,
  collectDigestLines,
  DEFAULT_LANGUAGE,
  autoOnboardMergeDriver,
  resolveMergeDriverBundle,
  pathOverviewFromTree,
  type Language,
  type MaintenanceConfig,
  type ProposalEngineConfig,
  type AuditRotationConfig,
  type NecessityEvaluator,
  type LlmClient,
  type Tool,
  type ToolContext,
  DEFAULT_AUDIT_CONFIG,
} from "@co-engram/core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startMaintenanceRuntime } from "./maintenance-runtime.js";
import {
  filterToolsByProfile,
  resolveProfile,
  type ToolProfile,
} from "./tool-profile.js";
import {
  buildServerInstructions,
  type InstructionSessionState,
} from "./instructions.js";
import { registerMcpPrompts } from "./prompts.js";
import { registerMcpResources } from "./resources.js";

/** 会变更仓库文件状态的工具名（写操作 → markDirty）。 */
const WRITE_TOOL_NAMES = new Set([
  "engram_create",
  "engram_update",
  "engram_delete",
  "engram_forget",
  "engram_archive",
  "engram_restore",
  "engram_reinforce",
  "engram_report_failure",
  "engram_upgrade_verification",
  "synapse_create",
  "synapse_delete",
  "contradiction_resolve",
  "close_learning_loop",
  "engram_accept_proposal",
  "engram_synthesize",
]);

/**
 * MCP Server 配置
 */
export interface CoEngramMcpServerConfig {
  /** 数据仓库根路径 */
  readonly dataRoot: string;
  /** 服务名称 */
  readonly serverName?: string;
  /** 服务版本 */
  readonly serverVersion?: string;
  /** 工具描述、查看器 UI、提示词所用语言(默认 'en') */
  readonly language?: Language;
  /** 是否启动自动维护服务（默认 false,需宿主显式开启） */
  readonly startMaintenance?: boolean;
  /** 维护服务配置（light/deep/rem 间隔、learningRate 等），透传给 MaintenanceEngine */
  readonly maintenanceConfig?: MaintenanceConfig;
  /** 是否启用 audit log（默认 true——写入开销极低,保留以备后用） */
  readonly auditEnabled?: boolean;
  /**
   * Audit 日志轮转配置(独立后台任务,与 maintenance 完全解耦)。
   *
   * 不传时使用 DEFAULT_AUDIT_CONFIG.rotation(默认 enabled=true,
   * retentionDays=90, highValueRetentionDays=365, maxSizeMb=50,
   * intervalMs=24h)。
   *
   * auditEnabled=false 时本字段被忽略(无 auditLog 自然无 rotation)。
   */
  readonly auditRotationConfig?: AuditRotationConfig;
  /** 是否启用 effectiveness 追踪（默认 true） */
  readonly effectivenessEnabled?: boolean;
  /** 是否启用 proposal engine（默认 false,需显式开启） */
  readonly proposalEnabled?: boolean;
  /** proposal engine 配置（threshold/similarity 等） */
  readonly proposalConfig?: ProposalEngineConfig;
  /**
   * 工具暴露 profile(默认 'standard')
   *
   * 控制注册到 MCP 的工具数量:
   *   - minimal: 11 个(8 核心读写 + 3 proposal 处理,保证维护引擎产生的候选始终能闭环)
   *   - standard: 17 个(含学习回路 + contradiction + 自愈/路径树 + engram_synthesize)
   *   - full: 28 个(调试 / co-engram 二次开发,含实验性高级工具)
   *
   * 不指定时,从 env / persistedConfig 解析(见 mcp-server.ts)。
   */
  readonly profile?: ToolProfile;
  /**
   * 默认作者标识(可选,用于 engram_create / synapse_create 的 createdBy 回退)
   *
   * 工具调用方未显式传 createdBy 时,工具会用此值。
   * 不指定时,从 env CO_ENGRAM_DEFAULT_CREATED_BY / persistedConfig.defaultCreatedBy 解析(见 mcp-server.ts)。
   */
  readonly defaultCreatedBy?: string;
  /**
   * 必要性评估器(可选,proposal engine 在 cluster 晋升前调用)
   *
   * 不指定时,ProposalEngine 内部用 RuleBasedNecessityEvaluator 兜底(零 LLM 成本)。
   * host 用此字段注入 LlmNecessityEvaluator 做语义必要性判断。
   */
  readonly necessityEvaluator?: NecessityEvaluator;
  /**
   * LLM 客户端(可选,供 engram_synthesize 等需要直接调 LLM 的工具用)
   *
   * 不指定时,ctx.llmClient 为 undefined,engram_synthesize 会抛错带安装指引。
   * host 通常和 necessityEvaluator 共享同一份配置(mcp-server.ts 已实现)。
   */
  readonly llmClient?: LlmClient;
  /**
   * 是否在 MCP server 启动时自动 onboard git merge driver(默认 true)。
   *
   * 启用后,启动时会检测 dataRoot 所在 git repo,自动安装 merge driver
   * bundle / .gitattributes / .git/config(全部幂等)。
   *
   * 默认开启,匹配零手动步骤的 low-friction-defaults 原则。
   */
  readonly autoOnboardMergeDriver?: boolean;
}

const DEFAULT_SERVER_NAME = "co-engram";
const DEFAULT_SERVER_VERSION = "0.0.0";

/**
 * 创建 MCP Server 并注册所有 Co-Engram 工具
 *
 * P4 新增：
 *   - 工具通过 wrapAllToolsWithSignalSink 包装,自动 append ToolCallEvent
 *   - 可选 startMaintenance=true 时启动 MaintenanceEngine（默认 false）
 *
 * @param config 配置
 * @returns server + ctx + 可选的 maintenance stop 函数
 */
export function createCoEngramMcpServer(config: CoEngramMcpServerConfig): {
  server: McpServer;
  ctx: ToolContext;
  /** 实际注册到 MCP 的工具 profile(供 logging / 调试) */
  readonly profile: ToolProfile;
  /** 实际注册的工具数 */
  readonly registeredToolCount: number;
  /** 启动时 dataRoot 不存在被自动创建的情形下为 true(供首次运行提示) */
  readonly dataRootAutoCreated?: boolean;
  /** proposal engine 引用（如果启用），用于 system prompt 注入 */
  readonly proposalEngine?: ProposalEngine;
  /** audit log 引用（如果启用），用于 viewer */
  readonly auditLog?: AuditLog;
  /** effectiveness tracker 引用（如果启用），用于 viewer + maintenance */
  readonly effectivenessTracker?: EffectivenessTracker;
  readonly stopMaintenance?: () => void;
  /**
   * 关闭 audit 日志轮转后台任务(可选,进程退出时 OS 自动回收;
   * 与 stopMaintenance 解耦 — 日志管理与 maintenance 是不同概念的东西)
   */
  readonly stopAuditRotation?: () => void;
  /**
   * 关闭跨进程 index watcher(可选,进程退出时 OS 自动回收;
   * 主要用于测试隔离 / 显式资源管理)
   */
  readonly stopIndexWatcher?: () => void;
} {
  let dataRootAutoCreated = false;
  if (!existsSync(config.dataRoot)) {
    mkdirSync(config.dataRoot, { recursive: true });
    dataRootAutoCreated = true;
  }

  const { repository, searchEngine: searchOrchestrator } =
    bootstrapRepositoryAndSearch({
      dataRoot: config.dataRoot,
      ...(config.language ? { language: config.language } : {}),
    });
  // SQLite 模式 build 是 no-op(write-through 已维护);memory 模式 build 真正生效
  rebuildSearchIndex(searchOrchestrator, repository);

  const signalSink = createDefaultSignalSink(config.dataRoot);

  // M1: 构造 observability 三件套（按需）
  const auditEnabled = config.auditEnabled !== false; // 默认 true
  const auditLog = auditEnabled ? new AuditLog(config.dataRoot) : undefined;
  const effectivenessEnabled = config.effectivenessEnabled !== false; // 默认 true
  const effectivenessTracker =
    effectivenessEnabled && auditLog
      ? new EffectivenessTracker(config.dataRoot, auditLog)
      : undefined;
  const proposalEngine =
    config.proposalEnabled !== false && auditLog
      ? new ProposalEngine({
          repository,
          embedder: DEFAULT_HASHER_EMBEDDER,
          auditLog,
          dataRoot: config.dataRoot,
          config: {
            // hash-based embedder 必须配套更低阈值,详见 DEFAULT_HASHER_SIMILARITY_THRESHOLD 注释。
            // 用户在 proposalConfig 里显式给的值优先。
            similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD,
            ...config.proposalConfig,
          },
          ...(config.necessityEvaluator
            ? { necessityEvaluator: config.necessityEvaluator }
            : {}),
        })
      : undefined;

  const ctx: ToolContext = {
    repository,
    searchOrchestrator,
    signalSink,
    // P0-4:双宿主契约不一致修复——MCP 侧注入 host 标识,
    // 透传到 audit entry,让跨宿主行为审计能区分来源。
    host: "claude-code-mcp",
    ...(auditLog ? { auditLog } : {}),
    ...(effectivenessTracker ? { effectivenessTracker } : {}),
    ...(proposalEngine ? { proposalEngine } : {}),
    ...(config.defaultCreatedBy
      ? { defaultCreatedBy: config.defaultCreatedBy }
      : {}),
    ...(config.llmClient ? { llmClient: config.llmClient } : {}),
  };

  const language = config.language ?? DEFAULT_LANGUAGE;
  const profile = config.profile ?? resolveProfile({}).profile;
  const sessionState = buildInstructionSessionState(
    ctx.repository.listEngrams().length,
    ctx.proposalEngine?.listPending().length ?? 0,
    config.dataRoot,
  );
  const pathOverview = pathOverviewFromTree(
    ctx.repository.listPathTree(),
    1,
  );
  const instructions = buildServerInstructions(
    language,
    profile,
    sessionState,
    pathOverview,
  );

  const server = new McpServer(
    {
      name: config.serverName ?? DEFAULT_SERVER_NAME,
      version: config.serverVersion ?? DEFAULT_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
      instructions,
    },
  );

  const registry = createToolRegistry();
  const allWrappedTools = wrapAllToolsWithSignalSink(registry.list());
  const toolsToRegister = filterToolsByProfile(allWrappedTools, profile);
  for (const tool of toolsToRegister) {
    registerCoEngramTool(server, tool, ctx, language);
  }

  registerMcpPrompts(server, ctx, language);
  registerMcpResources(server, ctx, language);

  let stopMaintenance: (() => void) | undefined;
  if (config.startMaintenance === true && ctx.signalSink) {
    const runtime = startMaintenanceRuntime(
      {
        repository: ctx.repository,
        signalSink: ctx.signalSink,
        dataRoot: config.dataRoot,
        ...(effectivenessTracker ? { effectivenessTracker } : {}),
        ...(ctx.llmClient ? { llmClient: ctx.llmClient } : {}),
      },
      config.maintenanceConfig ?? {},
    );
    stopMaintenance = runtime.stop;
  }

  // Audit 日志轮转:独立后台 setInterval,与 maintenance 引擎完全解耦。
  // 触发频率(默认 24h)与 maintenance 阶段无关 —— 日志管理自成体系。
  // auditEnabled=false 时无 auditLog,自然跳过 rotation。
  let stopAuditRotation: (() => void) | undefined;
  if (auditLog) {
    const rotationConfig = {
      ...DEFAULT_AUDIT_CONFIG.rotation,
      ...(config.auditRotationConfig ?? {}),
    };
    if (rotationConfig.enabled !== false) {
      stopAuditRotation = auditLog.startAutoRotation({
        retentionDays: rotationConfig.retentionDays!,
        highValueRetentionDays: rotationConfig.highValueRetentionDays!,
        maxSizeMb: rotationConfig.maxSizeMb!,
        intervalMs: rotationConfig.intervalMs!,
      });
    }
  }

  // 启动跨进程 index watcher — 多 host adapter(MCP / OpenClaw plugin)共享
  // 同一 dataRoot 时,确保各进程的 indexCache 在外部写入后立即失效。
  // mtime 兜底已内置在 getIndex 中,watcher 提供更实时的失效触发。
  // listener:watcher 触发时同步重建 SearchOrchestrator 的 ftsIndex,
  // 否则跨进程写入后,本进程 search 还是查旧索引(P0 缺陷)。
  //
  // 信任边界(安全关键):externalMarkdownHook 必须在 startWatching 之前设置,
  // 否则首次扫描会漏掉已存在的未授权 .md。hook 把 watcher 发现的外部 .md 转成
  // pending proposal(等用户审批),而非直接落库 —— 防止"拷贝恶意 .md → 进团队
  // 记忆库"的攻击面。git pull 来源由 post-merge hook 走 runDoctor 可信路径处理。
  if (proposalEngine) {
    ctx.repository.setExternalMarkdownHook(
      proposalEngine.createExternalMarkdownHook(),
    );
  }
  ctx.repository.startWatching();
  ctx.repository.addInvalidateListener(() => {
    rebuildSearchIndex(searchOrchestrator, repository);
  });

  // P2.7: 自动 onboard git merge driver(默认开启,匹配零手动步骤原则)
  //
  // MCP server 启动时同样检测 dataRoot 所在 git repo,自动装好 merge driver。
  // 失败不阻塞 server —— 通过 stderr 输出诊断信息即可。
  if (config.autoOnboardMergeDriver !== false) {
    const bundleSource = findInstalledMergeDriverBundle();
    if (bundleSource) {
      const result = autoOnboardMergeDriver({
        dataRoot: config.dataRoot,
        bundleSourcePath: bundleSource,
      });
      if (result.attempted && result.error) {
        process.stderr.write(
          `[co-engram] Auto-onboard merge driver failed: ${result.error}\n`,
        );
      } else if (result.attempted && result.bundleUpgraded) {
        process.stderr.write(
          `[co-engram] Merge driver installed in ${result.repoRoot}\n`,
        );
      }
    } else {
      process.stderr.write(
        `[co-engram] Auto-onboard skipped: merge-driver bundle not found\n`,
      );
    }
  }

  return {
    server,
    ctx,
    /** 注册到 MCP 的工具 profile(供 logging / 调试) */
    profile,
    /** 实际注册的工具数 */
    registeredToolCount: toolsToRegister.length,
    ...(dataRootAutoCreated ? { dataRootAutoCreated } : {}),
    ...(proposalEngine ? { proposalEngine } : {}),
    ...(auditLog ? { auditLog } : {}),
    ...(effectivenessTracker ? { effectivenessTracker } : {}),
    ...(stopMaintenance ? { stopMaintenance } : {}),
    ...(stopAuditRotation ? { stopAuditRotation } : {}),
    stopIndexWatcher: () => ctx.repository.stopWatching(),
  };
}

/**
 * 把单个 Co-Engram Tool 注册到 McpServer
 *
 * @param language 工具描述本地化语言(默认英文)
 */
export function registerCoEngramTool(
  server: McpServer,
  tool: Tool,
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): void {
  const inputSchema = extractZodShape(tool);
  const description = resolveToolDescription(tool, language);
  server.registerTool(
    tool.name,
    {
      description,
      ...(inputSchema ? { inputSchema } : {}),
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await tool.execute(args, ctx);
        if (WRITE_TOOL_NAMES.has(tool.name)) {
          ctx.markDirty?.();
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result as Record<string, unknown>,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * 解析工具描述(LLM-facing agent 层)
 *
 * 优先级:
 * 1. i18n 字典 `tool.<name>.agent`(原 LLM_TOOL_DESCRIPTIONS 已迁移至此,单一真相源)
 * 2. core i18n 字典 `tool.<name>`(legacy user 层 fallback)
 * 3. tool.description 原值(最终 fallback)
 *
 * 三层拆分背景:agent 层用于 LLM 决策(user/agent/technical 三层分离)。
 */
function resolveToolDescription(tool: Tool, language: Language): string {
  return localizeToolDescription(
    tool.name,
    language,
    tool.description,
    "agent",
  );
}

/**
 * 从 Tool 中提取 Zod shape（用于 MCP inputSchema）
 *
 * 如果 tool.inputSchema 是 ZodObject，返回其 .shape；
 * 否则返回 undefined（MCP SDK 接受 undefined 表示任意输入）
 *
 * 返回类型用 `any` 是因为 MCP SDK 的 ZodRawShapeCompat 是
 * `Record<string, z3.ZodTypeAny | z4.$ZodType>`，而我们跨 zod 版本无法精确对齐。
 * 运行时 MCP SDK 会用 safeParse 自己校验。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractZodShape(tool: Tool): Record<string, any> | undefined {
  const schema = tool.inputSchema as unknown as {
    _def?: { shape?: () => Record<string, unknown> };
    shape?: Record<string, unknown>;
  };
  try {
    if (schema && typeof schema._def?.shape === "function") {
      return schema._def.shape() as Record<string, unknown> as Record<
        string,
        any
      >;
    }
    if (schema && schema.shape) {
      return schema.shape as Record<string, unknown> as Record<string, any>;
    }
  } catch {
    // 忽略，fallback 到 undefined
  }
  return undefined;
}

/**
 * 装配 instructions 的 session-fresh 状态
 *
 * - totalEngrams / pendingProposals 由调用方从 in-memory repository/proposalEngine 取
 * - topTags / lowConfidenceTopics / missedTopics 从 prompt-signals.json 读
 *   (light stage 周期性生成;首次启动或文件缺失时降级为空数组)
 */
function buildInstructionSessionState(
  totalEngrams: number,
  pendingProposals: number,
  dataRoot: string,
): InstructionSessionState {
  const signals = readPromptSignalsSync(dataRoot);
  return {
    totalEngrams,
    pendingProposals,
    topTags: signals?.topTags ?? [],
    lowConfidenceTopics: signals?.lowConfidenceTopics ?? [],
    missedTopics: signals?.missedTopics ?? [],
  };
}

/**
 * 同步读取 prompt-signals.json(失败返回 undefined)
 *
 * 用 readFileSync 是因为 createCoEngramMcpServer 是 sync 函数,
 * 而 MCP server 构造时就需要 instructions。
 * 文件通常 <2KB,sync 读取开销可忽略。
 */
function readPromptSignalsSync(dataRoot: string):
  | {
      readonly topTags: readonly string[];
      readonly lowConfidenceTopics: readonly string[];
      readonly missedTopics: readonly string[];
    }
  | undefined {
  try {
    const path = join(dataRoot, ".co-engram", "prompt-signals.json");
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content) as {
      version?: number;
      topTags?: unknown;
      lowConfidenceTopics?: unknown;
      missedTopics?: unknown;
    };
    if (parsed.version !== 1) return undefined;
    return {
      topTags: toStringArray(parsed.topTags),
      lowConfidenceTopics: toStringArray(parsed.lowConfidenceTopics),
      missedTopics: toStringArray(parsed.missedTopics),
    };
  } catch {
    return undefined;
  }
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * 自动定位已安装的 `@co-engram/core` 中的 merge-driver bundle。
 *
 * 通过 `createRequire` 解析 `@co-engram/core/types` 子路径,exports 字段已暴露。
 * 该子路径只能 import 不能 require,所以显式传 `conditions: ['import','default']`。
 *
 * 失败(如 bundle 未构建 / 解析不到)返回 null,不抛错 —— auto-onboard 按跳过处理。
 */
function findInstalledMergeDriverBundle(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // @co-engram/core 的 exports 只声明 import 条件,默认 require.resolve 走 require 条件会失败。
    // 显式传 conditions 让 resolver 接受 import-only 入口。
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
 * 重建搜索索引
 *
 * 用 collectDigestLines 取真实 DigestLine[],让三因子打分能用真实 importance /
 * retrievalCount 等字段(之前的 stub 实现把这些字段全部
 * 默认成 0.5/0,导致 importance 因子对排名完全无贡献)。
 *
 * SearchEngine 接口实现:
 * - memory(SearchOrchestrator):真正重建 ftsIndex
 * - sqlite(SqliteSearchEngineAdapter):no-op,write-through 已维护索引
 */
export function rebuildSearchIndex(
  search: SearchOrchestrator | import("@co-engram/core").SearchEngine,
  repo: EngramRepository,
): void {
  // SQLite 模式下 build() 是 no-op(write-through 已维护 FTS 索引)。
  // 但 collectDigestLines 会 N+1 readEngram × assembleEngram(扫 synapses/ 目录),
  // 1000 engram 规模下让 plugin 启动卡 12+ 分钟(2026-07 cold-start 修复)。
  // 走 SqliteSearchEngineAdapter 时跳过 digest 计算;memory 模式仍走全量。
  // 同样的修复已在 openclaw-plugin/plugin-entry.ts 应用(跨宿主契约一致)。
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
