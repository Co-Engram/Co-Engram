/**
 * OpenClaw 插件注册入口
 *
 * 用户在 openclaw 项目里通过如下方式使用：
 *
 * ```ts
 * import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
 * import { registerCoEngramTools } from '@co-engram/openclaw'
 * import { join } from 'node:path'
 *
 * export default definePluginEntry({
 *   id: 'co-engram',
 *   name: 'Co-Engram',
 *   description: 'Team memory with neuroscience-inspired plasticity',
 *   register(api) {
 *     registerCoEngramTools(api, {
 *       dataRoot: join(process.env.HOME!, 'team-memory'),
 *     })
 *   },
 * })
 * ```
 *
 * @module @co-engram/openclaw
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import {
  EngramRepository,
  SearchOrchestrator,
  bootstrapRepositoryAndSearch,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  LlmNecessityEvaluator,
  DEFAULT_HASHER_EMBEDDER,
  type LlmClient,
  createToolRegistry,
  createDefaultSignalSink,
  wrapAllToolsWithSignalSink,
  wrapAllToolsWithErrorBoundary,
  localizeToolDescription,
  translatePrompt,
  pluralSuffix,
  resolveLanguage,
  readTeamMemoryConfig,
  scoringConfigToWeights,
  readPromptSignals,
  detectGitAuthor,
  collectDigestLines,
  resolveBootstrapDataRootSync,
  DEFAULT_LANGUAGE,
  pathOverviewFromTree,
  formatPathOverview,
  formatSkillCatalog,
  collectSkillCatalog,
  type ToolContext,
  type SignalSink,
  type MaintenanceConfig,
  type Language,
  type PromptSignalSnapshot,
  type NecessityEvaluator,
  type PathOverviewItem,
  DEFAULT_AUDIT_CONFIG,
  TeamEventStore,
  acquireProcessLock,
  verifyDerivedIntegrity,
  IndexOrchestrator,
  defaultCachePath,
  SkillRepository,
  Incubator,
  createHeadlessExecutor,
} from "@co-engram/core";
import type { CoEngramPluginConfig, CoEngramPluginHostApi } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * OpenClaw skills 目录(用于 skill 分发目标)
 */
const OPENCLAW_SKILLS_DIR = process.env.CO_ENGRAM_OPENCLAW_SKILLS_DIR ?? join(homedir(), ".openclaw", "skills");
import { adaptAllTools } from "./adapter.js";
import { startMaintenanceRuntime } from "./maintenance-runtime.js";
import { startViewerForOpenClaw, type ViewerRuntime } from "./viewer-loader.js";
import { createMemoryTools } from "./memory-tools.js";
import {
  createCoEngramPromptBuilder,
  type PromptSignals,
} from "./prompt-builder.js";
import { isListMemoryIntent } from "./list-intent-detector.js";
import {
  createOpenAiCompatibleLlmClient,
  loadOpenClawFallbackLlmConfig,
} from "./llm-client.js";
import {
  autoOnboardMergeDriver,
  findInstalledMergeDriverBundle,
} from "./auto-onboard.js";

/**
 * 构建 ToolContext（含 repository / searchOrchestrator / signalSink + 可选 observability）
 *
 * P4: 新增 signalSink 注入（默认 FileSignalSink 写入 dataRoot/.co-engram/signals.jsonl）。
 * M1: 新增 auditLog / effectivenessTracker / proposalEngine 注入。
 */
export function createCoEngramContext(
  config: CoEngramPluginConfig = {},
): ToolContext {
  // dataRoot 解析优先级:
  //   1. config.dataRoot 显式传入(测试 / 程序化注入用,正常运行不会走这里)
  //   2. bootstrap resolver 读 ~/.co-engram/config.json(单一权威入口,由 CLI 管理)
  // 不再支持 desiredDataRoot redirect(已废弃)。
  const { dataRoot: resolvedDataRoot, warnings } =
    resolveBootstrapDataRootSync();
  for (const w of warnings) {
    process.stderr.write(`[co-engram] ${w}\n`);
  }

  // 解析 defaultCreatedBy:首选本机 git 身份(user.name > user.email),
  // 其次 plugin config.defaultCreatedBy(用户显式配置的团队默认,如 "AIOS团队"),
  // 都没有时留 undefined(由 core 工具层兜底 "unknown")。
  //
  // git 优先的理由(2026-07 修复):createdBy 是「人类责任归属」字段,
  // 当前操作者的 git 身份是最权威的来源。团队默认(config.defaultCreatedBy)
  // 只在 git 不可用 / 未配置时兜底。这与 claude-code-mcp 的 resolveDefaultCreatedBy
  // 对齐(git > config > env),让双宿主行为对称。
  const userSpecifiedCreatedBy =
    typeof config.defaultCreatedBy === "string"
      ? config.defaultCreatedBy
      : undefined;
  const gitAuthor = detectGitAuthor();
  const fullConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    dataRoot: config.dataRoot ?? resolvedDataRoot,
    ...((gitAuthor ?? userSpecifiedCreatedBy)
      ? { defaultCreatedBy: gitAuthor ?? userSpecifiedCreatedBy }
      : {}),
  };

  if (!existsSync(fullConfig.dataRoot)) {
    mkdirSync(fullConfig.dataRoot, { recursive: true });
  }

  // M6:同步读 team-memory config 的 search.scoring(createCoEngramContext 是
  // sync,不能 await readTeamMemoryConfig;config.json 小文件 readFileSync 可接受)。
  // 让运维在 team-memory/config.json 调 search.scoring 真正生效。
  let teamSearch:
    | {
        relevance?: number;
        recency?: number;
        importance?: number;
        strength?: number;
        hotness?: number;
        hotnessHalfLifeDays?: number;
      }
    | undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(fullConfig.dataRoot, ".co-engram", "config.json"),
        "utf8",
      ),
    ) as { search?: typeof teamSearch };
    teamSearch = parsed.search;
  } catch {
    // config.json 不存在或损坏 → 用 DEFAULT_WEIGHTS 兜底(各引擎自带)
    teamSearch = undefined;
  }

  // Task 2.3:统一通过 bootstrap 装配 repository + searchEngine。
  // 默认走 sqlite 派生索引(WAL + FTS5);CO_ENGRAM_SEARCH_ENGINE=memory 显式 opt-out
  // 回进程内 FTS;sqlite 在当前环境不可用时(Node 版本边界 / 文件系统错误)自动
  // fallback 回 memory,host 仍能启动。
  const { repository, searchEngine: searchOrchestrator } =
    bootstrapRepositoryAndSearch({
      dataRoot: fullConfig.dataRoot,
      ...(fullConfig.language ? { language: fullConfig.language } : {}),
      ...(teamSearch
        ? { scoringWeights: scoringConfigToWeights(teamSearch) }
        : {}),
      // P0-2:hotness 半衰期从 search.scoring 透传(缺省 7 天,引擎自带默认)
      ...(teamSearch?.hotnessHalfLifeDays
        ? { scoringHotnessHalfLifeDays: teamSearch.hotnessHalfLifeDays }
        : {}),
    });

  // AI-2 派生层完整性自检:启动时把"源 markdown vs 派生索引(digest/graph/index)的
  // 静默不一致"变成可见 warning。read-only,不修复;status=warning/critical 时
  // 通过 console.warn 输出(OpenClaw 插件无 stderr 直通)。
  try {
    const report = verifyDerivedIntegrity(fullConfig.dataRoot);
    if (report.status !== "ok") {
      for (const issue of report.issues) {
        // eslint-disable-next-line no-console
        console.warn(
          `[co-engram] integrity ${report.status}: ${issue.kind} — ${issue.message}`,
        );
      }
    }
  } catch {
    // verifyDerivedIntegrity 自身异常不应阻塞启动
  }

  // 启动迁移:首次启动或语言切换时,把所有文件重写为目标格式。
  // 迁移是幂等的(已是目标格式则跳过),因此每次启动都跑也无副作用。
  if (fullConfig.language) {
    const migrateResult = repository.migrateFormat(fullConfig.language);
    if (migrateResult.migrated > 0 || migrateResult.errors.length > 0) {
      // OpenClaw 插件无 stderr 直通,通过 console.warn 输出诊断
      // eslint-disable-next-line no-console
      console.warn(
        `[co-engram] Migration to ${fullConfig.language}: migrated=${migrateResult.migrated} skipped=${migrateResult.skipped} errors=${migrateResult.errors.length}`,
      );
    }
  }

  // SQLite 模式 build 是 no-op(write-through 已维护);memory 模式 build 真正生效
  // P0: 启动时从现有数据构建索引;P1 改为增量
  rebuildSearchIndex(searchOrchestrator, repository);

  // P4: 创建 signal sink（默认 FileSignalSink,写 dataRoot/.co-engram/signals.jsonl）
  const signalSink = createDefaultSignalSink(fullConfig.dataRoot);

  // S4 Task 3: 创建 SkillRepository(用于 skill_* 工具 + proposal skill hook)
  const skillRepository = new SkillRepository(fullConfig.dataRoot);

  // M1: 按需构造 observability
  const auditLog = fullConfig.auditEnabled
    ? new AuditLog(fullConfig.dataRoot)
    : undefined;
  // 团队动态事件出口(2026-08-19,与 claude-code-mcp register.ts 同款装配):
  // 高价值动作双写 events/ 分片随 git 同步;visibilityLookup 走 SQLite 单查,
  // indexDb 缺失时不装配 → TeamEventStore 宁缺勿漏(private 不可判定就不落盘)。
  const teamEventsConfig = fullConfig.auditTeamEvents;
  const teamEventStore =
    auditLog && teamEventsConfig?.enabled !== false
      ? new TeamEventStore(fullConfig.dataRoot, {
          origin: detectGitAuthor() ?? "unknown",
          ...(teamEventsConfig?.retentionDays
            ? { retentionDays: teamEventsConfig.retentionDays }
            : {}),
          ...(repository.indexDb
            ? {
                visibilityLookup: (engramId: string): string | undefined => {
                  const row = repository.indexDb!.prepare(
                    "SELECT visibility FROM engrams WHERE id = ?",
                  ).get(engramId) as { visibility: string } | undefined;
                  return row?.visibility;
                },
              }
            : {}),
        })
      : undefined;
  if (auditLog && teamEventStore) {
    auditLog.setTeamEventRecorder(teamEventStore);
  }
  const effectivenessTracker =
    fullConfig.effectivenessEnabled && auditLog
      ? new EffectivenessTracker(fullConfig.dataRoot, auditLog)
      : undefined;
  // LLM client 只构造一次,共享给 ProposalEngine(包装成 NecessityEvaluator)
  // 和 ToolContext(供 engram_synthesize 直接用)
  const llmClient = resolveLlmClient(config);
  const necessityEvaluator = resolveNecessityEvaluator(config, llmClient);
  const proposalEngine =
    fullConfig.proposalEnabled && auditLog
      ? new ProposalEngine({
          repository,
          embedder: DEFAULT_HASHER_EMBEDDER,
          auditLog,
          dataRoot: fullConfig.dataRoot,
          // H7 归因:proposal 审计 accept 决策带宿主标识,跨宿主可追溯
          host: "openclaw-plugin",
          ...(config.proposalConfig ? { config: config.proposalConfig } : {}),
          ...(necessityEvaluator ? { necessityEvaluator } : {}),
          // S4 Task 3: 注入 skillRepository(供 proposal skill hook 用)
          skillRepository,
          // 默认创建者(host 解析的 git author:detectGitAuthor > config),
          // accept 兜底用它而非机器标签
          ...(fullConfig.defaultCreatedBy
            ? { defaultCreatedBy: fullConfig.defaultCreatedBy }
            : {}),
          // 动态解析器:每次读 git,改 user.name 无需重启即生效
          resolveCreatedBy: () => detectGitAuthor() ?? userSpecifiedCreatedBy,
        })
      : undefined;

  const ctx: ToolContext = {
    repository,
    searchOrchestrator,
    signalSink,
    // P0-4:双宿主契约不一致修复——OpenClaw 侧注入 host 标识,
    // 透传到 audit entry,让跨宿主行为审计能区分来源。
    host: "openclaw-plugin",
    ...(auditLog ? { auditLog } : {}),
    ...(effectivenessTracker ? { effectivenessTracker } : {}),
    ...(proposalEngine ? { proposalEngine } : {}),
    // S4 Task 3: 注入 skillRepository(供 skill_* 工具使用)
    ...(skillRepository ? { skillRepository } : {}),
    ...(fullConfig.defaultCreatedBy
      ? { defaultCreatedBy: fullConfig.defaultCreatedBy }
      : {}),
    // 动态解析器:每次读 git,改 user.name 无需重启即生效
    resolveCreatedBy: () => detectGitAuthor() ?? userSpecifiedCreatedBy,
    ...(llmClient ? { llmClient } : {}),
    // 沉思孵化器(2026-08-17 重设计):M3 —— openclaw 接入 L2 headless 执行器
    //(与 claude-code-mcp 同款,实现收敛在 core);L2 失败显式报错,仅环境无
    // claude CLI(ENOENT)时降级 L1(审计标注)。
    ...(proposalEngine
      ? {
          incubator: new Incubator({
            repository,
            proposalEngine,
            dataRoot: fullConfig.dataRoot,
            ...(auditLog ? { auditLog } : {}),
            ...(llmClient ? { llmClient } : {}),
            executor: createHeadlessExecutor(),
            // PDCA(Phase1):引擎侧调用流水快照(同进程 sink;flush+snapshot
            // 不消费 drain 队列)
            signalEvidence: signalSink,
            ...(fullConfig.maintenanceConfig?.remInsight?.repairRounds
              ? {
                  repairRoundLimit:
                    fullConfig.maintenanceConfig.remInsight.repairRounds,
                }
              : {}),
          }),
        }
      : {}),
  };
  // 启动恢复(2026-08-19):固化超时 in-flight 深思条目的 TTL 收束。
  // 宿主进程死亡时一切进程内超时失效(timer 随进程消失),条目悬挂且
  // 零审计;每次装配时扫描一次,恢复有痕。幂等,无可恢复时零写盘。
  ctx.incubator?.recoverStale();
  return ctx;
}

/**
 * 解析原始 LlmClient(供 engram_synthesize 等需要直接调 LLM 的工具用)
 *
 * 优先级同 resolveNecessityEvaluator 的 2/3/4(注意:不读 config.necessityEvaluator
 * 实例——那是 NecessityEvaluator 包装,不是裸 client)。
 *
 * 与 resolveNecessityEvaluator 在同一份配置上建一次 client,然后两边共享。
 */
function resolveLlmClient(config: CoEngramPluginConfig): LlmClient | undefined {
  // 显式配置 + OpenClaw fallback
  const llmConfig = config.necessityLlm ?? loadOpenClawFallbackLlmConfig();
  if (!llmConfig) return undefined;

  try {
    return createOpenAiCompatibleLlmClient(llmConfig);
  } catch {
    return undefined;
  }
}

/**
 * 解析必要性评估器
 *
 * 优先级:
 *   1. config.necessityEvaluator(宿主直接注入实例)
 *   2. 复用调用方已构造的 llmClient(避免重复建连)
 *   3. 自行 resolveLlmClient(config)
 *   4. undefined → ProposalEngine 内部默认 RuleBasedNecessityEvaluator
 *
 * 失败(如配置不全)不抛错,返回 undefined 让 ProposalEngine 用规则版兜底。
 *
 * @param preBuiltClient 调用方已构造的 llmClient(优先用,避免重复建连)
 */
function resolveNecessityEvaluator(
  config: CoEngramPluginConfig,
  preBuiltClient?: LlmClient,
): NecessityEvaluator | undefined {
  // 1. 宿主直接注入
  if (config.necessityEvaluator) return config.necessityEvaluator;

  const client = preBuiltClient ?? resolveLlmClient(config);
  if (!client) return undefined;
  return new LlmNecessityEvaluator(client);
}

/**
 * 重建搜索索引(全量)
 *
 * 用 collectDigestLines 取真实 DigestLine[](含 importance /
 * retrievalCount / reinforcementScore 等),让 SearchOrchestrator 的三因子打分
 * (α·relevance + β·recency + γ·importance)能用真实数据,而不是全部默认 0.5。
 *
 * 这直接影响搜索质量:之前所有 engram importance 都被 stub 成 0.5,导致
 * importance 因子对排名无贡献,高重要性 engram 没法浮上来。
 */
export function rebuildSearchIndex(
  search: SearchOrchestrator | import("@co-engram/core").SearchEngine,
  repo: EngramRepository,
): void {
  // SQLite 模式下 build() 是 no-op(write-through 已维护 FTS 索引)。
  // 但 collectDigestLines 会 N+1 readEngram × assembleEngram(扫 synapses/ 目录),
  // 1000 engram 规模下让 plugin 启动卡 12+ 分钟(2026-07 cold-start 修复)。
  // 走 SqliteSearchEngineAdapter 时跳过 digest 计算;memory 模式仍走全量。
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

/**
 * 渲染 co-engram 记忆库 catalog 为可直接消费的 markdown 列表
 *
 * 用于 before_prompt_build hook 的 appendSystemContext:
 * 当用户问"我有哪些记忆 / 列出记忆"时,直接把 catalog 内容塞 system prompt
 * 末尾——agent 拿到现成答案,不需要再调任何工具。
 *
 * 设计权衡:
 *   - 早期版本只给"短引导 + 工具调用指令",但 agent(Qwen 等)在长 prompt
 *     下注意力丢失,继续按习惯调 read workspace/memory/*.md(stock 残留)
 *   - 现在直接给前 N 条 catalog,agent 拿到现成列表即回答;catalog 没显示
 *     的部分通过 "调 engram_list 翻页" 引导
 *   - prompt cache 失效可接受:列举意图只占少量 prompt,且用户问"我有
 *     哪些记忆"本就期待看到实际内容
 *
 * 与 workspace MEMORY.md 共存:workspace MEMORY.md 是个人/项目笔记,
 * co-engram 是团队系统化记忆;两者职责不同,agent 可同时引用。
 *
 * 记忆库为空返回 null(不注入)。
 */
function renderMemoryCatalogMarkdown(
  ctx: ToolContext,
  _language: Language,
): string | null {
  const entries = ctx.repository.listEngrams();
  if (entries.length === 0) return null;

  // 按 title 排序,限长避免撑爆 prompt
  const sorted = [...entries].sort((a, b) =>
    a.title.localeCompare(b.title, "zh-CN"),
  );
  const LIMIT = 30;
  const limited = sorted.slice(0, LIMIT);

  const lines: string[] = [];
  lines.push(
    `## co-engram 团队记忆(共 ${entries.length} 条,展示前 ${limited.length} 条)`,
  );
  lines.push("");
  lines.push(
    '用户问"我有哪些记忆 / 列出记忆"——以下就是答案,直接基于此列表回答。',
  );
  lines.push(
    "注意:workspace/memory/ 下的日期文件是 stock memory-core 残留,不要调 read 工具去读它们。",
  );
  lines.push("");

  for (let i = 0; i < limited.length; i++) {
    const e = limited[i]!;
    const tags =
      e.domainTags.length > 0 ? e.domainTags.join(", ") : "(无 tags)";
    lines.push(`${i + 1}. **${e.title}** \`${e.kind}\``);
    lines.push(`   - id: \`${e.id}\``);
    lines.push(`   - tags: ${tags}`);
  }

  if (entries.length > LIMIT) {
    lines.push("");
    lines.push(
      `(还有 ${entries.length - LIMIT} 条未展示;调 \`engram_list\` 工具查看完整分页列表)`,
    );
  }

  lines.push("");
  lines.push("**后续操作:**");
  lines.push("- 看某条细节 → 调 `engram_get(id)`");
  lines.push('- 按关键词找 → 调 `engram_search(query="关键词")`');

  return lines.join("\n");
}

/**
 * 注册所有 Co-Engram 工具到 OpenClaw 插件 API
 *
 * P4 新增：
 *   - 工具通过 wrapAllToolsWithSignalSink 包装,自动 append ToolCallEvent
 *   - 可选 startMaintenance=true 时启动 MaintenanceEngine（默认 false,需宿主显式开启）
 *
 * M3b 新增:
 *   - 如果 ctx.proposalEngine 存在 + api 提供 registerHook + enqueueNextTurnInjection,
 *     注册 session 'new' hook,在会话开始时把候选提示注入下一轮 agent context
 *
 * @param api OpenClaw 插件 API（只需暴露 registerTool）
 * @param config 配置（数据根路径等）
 * @returns ctx + 可选的 maintenance stop 函数
 */
export function registerCoEngramTools(
  api: CoEngramPluginHostApi,
  config: CoEngramPluginConfig = {},
): ToolContext & {
  readonly stopMaintenance?: () => void;
  /**
   * 关闭 audit 日志轮转后台任务(可选,进程退出时 OS 自动回收;
   * 与 stopMaintenance 解耦 — 日志管理与 maintenance 是不同概念的东西)
   */
  readonly stopAuditRotation?: () => void;
  /** 关闭跨进程 index watcher(主要用于插件卸载 / 测试隔离) */
  readonly stopIndexWatcher?: () => void;
  /**
   * 释放进程锁 + 停止 holder 后台任务(maintenance / audit rotation /
   * index watcher)。
   *
   * 仅 holder 释放时才会真正停止后台任务 + 删除 lockfile;non-holder 调用
   * 是 no-op。进程退出时 OS 自动回收 interval,但显式释放能让下个 session
   * 更快接管(不必等 staleMs)。
   */
  readonly releaseProcessLock?: () => void;
  readonly language?: Language;
  readonly promptSignals?: PromptSignals;
} {
  if (config.enabled === false) {
    // 禁用时不注册任何工具
    return createCoEngramContext(config);
  }

  const ctx = createCoEngramContext(config);

  // 进程锁:同一 dataRoot 上多个 host adapter 进程(OpenClaw gateway plugin /
  // Claude Code mcp-server)只允许第一个(holder)启动 maintenance / audit
  // rotation / fs.watch / external markdown hook 等共享型后台任务。non-holder
  // 跳过这些任务但仍正常服务工具调用 + hook 回调。
  //
  // 设计权衡:non-holder 跳过 holder-only 后台任务(maintenance / rotation / watcher /
  // viewer)。后续若 holder 退出、本进程经 onGained 接管,会补启动这些任务(见下方
  // onLost / onGained 注册),不再停摆到下个新进程启动(light/deep 间隔大,mtime fallback
  // 兜底 search 正确性)。
  const effectiveDataRoot = config.dataRoot ?? DEFAULT_CONFIG.dataRoot;
  const processLock = acquireProcessLock({
    dataRoot: effectiveDataRoot,
    host: "openclaw-plugin",
  });
  const language = config.language ?? DEFAULT_LANGUAGE;
  const registry = createToolRegistry();
  // AI-1 fail-loud:先包错误边界,再包 signal sink(与 claude-code-mcp 对齐)
  const errorBoundedTools = wrapAllToolsWithErrorBoundary(registry.list());
  // P4: 包装工具以自动收集行为信号
  const wrappedTools = wrapAllToolsWithSignalSink(errorBoundedTools);
  const descriptors = adaptAllTools(wrappedTools, ctx, language);

  for (const desc of descriptors) {
    api.registerTool(desc, { name: desc.name });
  }

  // 注册 OpenClaw 兼容的 memory_search / memory_get 工具
  // 触发 OpenClaw 核心的 memory section 系统提示注入
  const memoryTools = createMemoryTools(ctx, language);
  for (const tool of memoryTools) {
    api.registerTool(tool, { name: tool.name });
  }

  // 注册 memory capability(promptBuilder)
  const repository = ctx.repository;
  // co-engram 作为 kind: "memory" 主要插件,提供引导文字
  if (api.registerMemoryCapability) {
    const proposalEngine = ctx.proposalEngine;
    const promptBuilder = createCoEngramPromptBuilder({
      language,
      signals: config.promptSignals,
      proposalCountProvider: () => proposalEngine?.listPending().length ?? 0,
      pathOverviewProvider: () =>
        pathOverviewFromTree(repository.listPathTree(), 2),
      // 团队技能清单(确定性注入):实时读 SKILL.md description,forgotten 已过滤
      ...(ctx.skillRepository
        ? {
            skillsProvider: () =>
              collectSkillCatalog(ctx.skillRepository!, effectiveDataRoot),
          }
        : {}),
    });
    api.registerMemoryCapability({ promptBuilder });
    // 兜底:registerMemoryCapability 是 exclusive slot,某些 coclaw 版本不调它。
    // registerMemoryPromptSupplement 是 additive,buildMemoryPromptSection 会合并。
    if (api.registerMemoryPromptSupplement) {
      api.registerMemoryPromptSupplement((params) => [
        ...promptBuilder({ availableTools: new Set(params.availableTools), citationsMode: params.citationsMode }),
      ]);
    }
  }

  // 注册 before_prompt_build hook:列举意图兜底
  //
  // 背景:OpenClaw core 无条件把 ~/.openclaw/workspace/MEMORY.md 注入到
  // base system prompt。workspace/memory/ 目录里有 stock memory-core 残留
  // 的日期文件,agent 习惯调 read 工具去读它们(ENOENT 失败)。
  //
  // 这个 hook 检测 prompt 是否为"我有哪些记忆 / 列出所有记忆"等列举意图,
  // 是则通过 appendSystemContext 把 co-engram 实际记忆列表(catalog)以
  // markdown 形式直接注入到 base system prompt 末尾——agent 拿到现成答案,
  // 不需要再调 read 工具去访问 workspace/memory/。
  //
  // 与 workspace MEMORY.md 共存:MEMORY.md 是个人/项目笔记,co-engram 是
  // 团队系统化记忆,两者职责不同。其他场景不触发,避免污染 prompt cache。
  if (api.on) {
    api.on("before_prompt_build", (event) => {
      try {
        const parts: string[] = [];

        // 1. 每个 prompt 都注入 pathOverview + topTags + skillCatalog(cache-stable,不破坏 prompt cache)。
        // openclaw 的 registerMemoryCapability 被 contextEngine="lossless-claw" 短路(attempt.ts:1363),
        // promptBuilder 从不被调用。appendSystemContext 是唯一可靠的 cache-stable 注入通道。
        const overview = formatPathOverview(
          pathOverviewFromTree(repository.listPathTree(), 2),
          language,
        );
        if (overview) parts.push(overview);

        // 团队技能清单(确定性注入,与 promptBuilder 共用 collectSkillCatalog:
        // 实时读 SKILL.md description + forgotten 过滤;内容随 SKILL.md 变化才变,cache-stable)
        if (ctx.skillRepository) {
          const skillCatalog = formatSkillCatalog(
            collectSkillCatalog(ctx.skillRepository, effectiveDataRoot),
            language,
          );
          if (skillCatalog) parts.push(skillCatalog);
        }

        const topTags = config.promptSignals?.topTags ?? [];
        if (topTags.length > 0) {
          parts.push(
            translatePrompt(
              language,
              "prompt.memory.frequent_topics",
              { tags: topTags.join(", ") },
            ),
          );
        }

        // 2. 列举意图时额外注入 catalog(现成答案)
        if (isListMemoryIntent(event.prompt ?? "")) {
          const catalog = renderMemoryCatalogMarkdown(ctx, language);
          if (catalog) parts.push(catalog);
        }

        if (parts.length === 0) return;
        return { appendSystemContext: parts.join("\n\n") };
      } catch {
        return;
      }
    });
  }

  // P4 + M1: 启动 maintenance runtime(默认开启,遵循 low-friction-defaults)
  // holder gating:non-holder 跳过 maintenance / rotation / watcher 等共享型
  // 后台任务,避免多 host adapter 进程叠加烧 CPU / fs.watch 链式响应
  let stopMaintenance: (() => void) | undefined;
  if (
    config.startMaintenance !== false &&
    ctx.signalSink &&
    processLock.isHolder
  ) {
    const runtime = startMaintenanceRuntime(
      {
        repository: ctx.repository,
        signalSink: ctx.signalSink,
        ...(ctx.effectivenessTracker
          ? { effectivenessTracker: ctx.effectivenessTracker }
          : {}),
        // dataRoot 用于 light stage 写 prompt-signals.json(自进化提示词)
        dataRoot: config.dataRoot ?? DEFAULT_CONFIG.dataRoot,
        ...(ctx.llmClient ? { llmClient: ctx.llmClient } : {}),
        ...(ctx.proposalEngine ? { proposalEngine: ctx.proposalEngine } : {}),
        // S4 Task 3: 注入 skillRepository(供 maintenance engine skill retention 衰退用)
        ...(ctx.skillRepository ? { skillRepository: ctx.skillRepository } : {}),
        // 夜思独立日调度(锚点时刻制,spec §四):light tick 触发;
        // active 条目每日 schedule 时刻一轮(默认 00:00),错过补跑
        ...(ctx.incubator ? { incubator: ctx.incubator } : {}),
      },
      config.maintenanceConfig ?? {},
    );
    stopMaintenance = runtime.stop;
  }

  // Audit 日志轮转:独立后台 setInterval,与 maintenance 引擎完全解耦。
  // 触发频率(默认 24h)与 maintenance 阶段无关 —— 日志管理自成体系。
  // auditEnabled=false 时无 auditLog,自然跳过 rotation。
  // holder gating 同上(non-holder 不跑 rotation)。
  let stopAuditRotation: (() => void) | undefined;
  if (ctx.auditLog && processLock.isHolder) {
    const rotationConfig = {
      ...DEFAULT_AUDIT_CONFIG.rotation,
      ...(config.auditRotationConfig ?? {}),
    };
    if (rotationConfig.enabled !== false) {
      stopAuditRotation = ctx.auditLog.startAutoRotation({
        retentionDays: rotationConfig.retentionDays!,
        highValueRetentionDays: rotationConfig.highValueRetentionDays!,
        maxSizeMb: rotationConfig.maxSizeMb!,
        intervalMs: rotationConfig.intervalMs!,
      });
    }
  }

  // viewer holder gating(对齐 claude-code mcp-server.ts / daemon-entry.ts):
  // viewer 绑定 known port 18899,是 dataRoot 维度单一资源。只有 holder 启 viewer;
  // non-holder 启会 EADDRINUSE 重试到随机端口,而 observe hook / 客户端固定访问 18899
  // 会找不到。openclaw 与 claude-code 共享同一 dataRoot 时,无论哪个宿主是 holder,
  // 其 viewer 都在 18899 服务所有客户端;non-holder 接管时经下方 onGained 补启。
  let viewerStop: (() => Promise<void>) | undefined;
  const startHolderViewer = (): void => {
    if (viewerStop) return; // 幂等:已启动则跳过(避免重复占端口)
    if (config.startViewer === false) return; // opt-out:默认开启,对齐 maintenance(startMaintenance !== false)/ claude-code(viewer.enabled ?? proposalEnabled)/ configSchema default:true
    void startCoEngramViewer(ctx, {
      ...config,
      dataRoot: effectiveDataRoot,
    }).then((r) => {
      if (r.stopViewer) viewerStop = r.stopViewer;
    });
  };
  if (processLock.isHolder) {
    startHolderViewer();
  }

  // 注册 onLost:失去锁时停止 holder-only 任务(maintenance / rotation / watcher / viewer)。
  // 注册是无条件的:non-holder 时 stop 函数都是 undefined,回调是 no-op。
  // viewer 同为 holder-only 资源:失锁时关闭,让新 holder 能绑同端口 18899。
  processLock.onLost(() => {
    try {
      ctx.repository.stopWatching();
    } catch {
      // ignore — 未启动 watcher 时 stopWatching 抛错容忍
    }
    stopMaintenance?.();
    stopAuditRotation?.();
    viewerStop?.();
    viewerStop = undefined;
  });

  // 注册 onGained:non-holder 通过 retry take over 成为 holder 时,补启动此前跳过的
  // holder-only 任务(maintenance / audit rotation / external markdown watcher / viewer)。
  // 与 mcp-server.ts / daemon-entry.ts 的 onGained viewer 启动对称 — 否则旧 holder 退出后,
  // 本进程接管锁但 viewer 等任务停摆(light/deep 间隔大,可接受短时间停摆,但能补就补)。
  processLock.onGained(() => {
    startHolderViewer();
    if (
      stopMaintenance === undefined &&
      config.startMaintenance !== false &&
      ctx.signalSink
    ) {
      const runtime = startMaintenanceRuntime(
        {
          repository: ctx.repository,
          signalSink: ctx.signalSink,
          ...(ctx.effectivenessTracker
            ? { effectivenessTracker: ctx.effectivenessTracker }
            : {}),
          dataRoot: config.dataRoot ?? DEFAULT_CONFIG.dataRoot,
          ...(ctx.llmClient ? { llmClient: ctx.llmClient } : {}),
          ...(ctx.proposalEngine ? { proposalEngine: ctx.proposalEngine } : {}),
          // S4 Task 3: 注入 skillRepository(供 maintenance engine skill retention 衰退用)
          ...(ctx.skillRepository ? { skillRepository: ctx.skillRepository } : {}),
          // 夜思独立日调度(锚点时刻制,spec §四):light tick 触发;
          // active 条目每日 schedule 时刻一轮(默认 00:00),错过补跑
          ...(ctx.incubator ? { incubator: ctx.incubator } : {}),
        },
        config.maintenanceConfig ?? {},
      );
      stopMaintenance = runtime.stop;
    }
    if (stopAuditRotation === undefined && ctx.auditLog) {
      const rotationConfig = {
        ...DEFAULT_AUDIT_CONFIG.rotation,
        ...(config.auditRotationConfig ?? {}),
      };
      if (rotationConfig.enabled !== false) {
        stopAuditRotation = ctx.auditLog.startAutoRotation({
          retentionDays: rotationConfig.retentionDays!,
          highValueRetentionDays: rotationConfig.highValueRetentionDays!,
          maxSizeMb: rotationConfig.maxSizeMb!,
          intervalMs: rotationConfig.intervalMs!,
        });
      }
    }
    if (ctx.proposalEngine) {
      ctx.repository.setExternalMarkdownHook(
        ctx.proposalEngine.createExternalMarkdownHook({
          ...(ctx.llmClient ? { llmClient: ctx.llmClient } : {}),
        }),
      );
      // S4 Task 3: 注入 skill hook(参照 externalMarkdownHook 模式)
      ctx.repository.setSkillHook(ctx.proposalEngine.createSkillHook());
    }
    ctx.repository.startWatching();
    ctx.repository.addInvalidateListener(() => {
      if (ctx.searchOrchestrator) {
        rebuildSearchIndex(ctx.searchOrchestrator, ctx.repository);
      }
    });
    // .yaml 外部修改(git pull / Edit)→ debounce 重建 graph.json + SQLite synapse 表。
    // 解决 index-no-truth:原版 .yaml watcher 只清 synapseCache,派生层长期陈旧。
    ctx.repository.addSynapseChangeListener(() => {
      try {
        const cachePath = defaultCachePath(ctx.repository.rootPath);
        const orchestrator = new IndexOrchestrator(ctx.repository, cachePath);
        orchestrator.rebuildSynapseLayer();
      } catch {
        // listener 异常不阻塞 repository 主流程;下次 .yaml 变化再次触发
      }
    });
  });

  // P2.7: 自动 onboard git merge driver(默认开启,匹配零手动步骤原则)
  //
  // 启动时检测 dataRoot 所在 git repo,自动装好 merge driver bundle /
  // .gitattributes / .git/config。这样用户 clone 团队记忆仓库后第一次启动
  // co-engram 就立刻具备结构化 merge 能力,不需要手动跑 `co-engram git enable`。
  //
  // 失败不阻塞 plugin —— 通过 stderr 输出诊断信息即可。
  if (config.autoOnboardMergeDriver !== false) {
    const bundleSource = findInstalledMergeDriverBundle();
    if (bundleSource) {
      const dataRoot = config.dataRoot ?? DEFAULT_CONFIG.dataRoot;
      const result = autoOnboardMergeDriver({
        dataRoot,
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

  // M3b: 可选 system prompt 注入（需 proposal engine + host 支持）
  if (ctx.proposalEngine && api.registerHook && api.enqueueNextTurnInjection) {
    const proposalEngine = ctx.proposalEngine;
    const enqueue = api.enqueueNextTurnInjection;
    api.registerHook(
      "session",
      async (event) => {
        if (event.action !== "new") return;
        try {
          const pending = proposalEngine.listPending();
          if (pending.length === 0) return;
          const text = buildProposalPrompt(pending.length, language);
          await enqueue({
            sessionKey: event.sessionKey,
            text,
            placement: "prepend_context",
            idempotencyKey: `co-engram-proposals-${event.sessionKey}`,
          });
        } catch {
          // 注入失败不阻塞会话
        }
      },
      { name: "co-engram-session-inject" },
    );
  }

  // M3c: 对话流自动观察(需 proposal engine + host 提供 registerHook)
  //
  // 监听 OpenClaw 的 llm_input / llm_output 事件,把用户输入和 assistant 输出
  // 喂给 proposalEngine.observe(),驱动跨会话的话题聚类和 proposal 生成。
  //
  // 设计:
  //   - llm_input.prompt → role: 'user'
  //   - llm_output.assistantTexts → role: 'assistant'(多段拼接)
  //   - observe 内部已做长度过滤和 embedder 异常吞掉,这里只需 fire-and-forget
  //   - 事件类型用 unknown 窄化,避免把 OpenClaw 的全部 hook 类型拉进 co-engram 类型定义
  if (ctx.proposalEngine && api.registerHook) {
    const proposalEngine = ctx.proposalEngine;
    // OpenClaw registerHook 要求 opts.name(否则抛"hook registration missing name"),
    // 必须提供唯一 name 让 hook 真正注册到 registry。
    api.registerHook(
      ["llm_input", "llm_output"],
      async (event) => {
        try {
          const e = event as unknown as {
            readonly runId?: string;
            readonly prompt?: string;
            readonly assistantTexts?: readonly string[];
          };
          if (typeof e.prompt === "string" && e.prompt.trim().length > 0) {
            void proposalEngine.observe({ role: "user", content: e.prompt });
          }
          if (Array.isArray(e.assistantTexts) && e.assistantTexts.length > 0) {
            const content = e.assistantTexts
              .filter((s) => typeof s === "string" && s.length > 0)
              .join("\n\n");
            if (content.trim().length > 0) {
              void proposalEngine.observe({ role: "assistant", content });
            }
          }
        } catch {
          // observe 失败不能影响 OpenClaw 主流程
        }
      },
      { name: "co-engram-observe-llm" },
    );
  }

  // 启动跨进程 index watcher — OpenClaw plugin 与外部 MCP server / 其他 host
  // 共享同一 dataRoot 时,确保各进程的 indexCache 在外部写入后立即失效。
  // listener:watcher 触发时同步重建 SearchOrchestrator 的 ftsIndex,
  // 否则 plugin 进程写入后,mcp 进程的 search 还是查旧索引(P0 缺陷)。
  //
  // 信任边界(安全关键):externalMarkdownHook 必须在 startWatching 之前设置。
  // hook 把 watcher 发现的"未授权来源 .md"(用户拷贝、IDE 写入等)转成 pending
  // proposal 等用户审批,而非直接落库 —— 防止恶意/误植 .md 通过文件系统投毒
  // 进入团队记忆库。git pull 来源由 post-merge hook 走 runDoctor 可信路径处理。
  //
  // holder gating:non-holder 不启动 watcher / hook / invalidate listener。
  // non-holder 的 search 通过 mtime fallback(getIndex 内置)兜底正确性。
  if (processLock.isHolder) {
    if (ctx.proposalEngine) {
      ctx.repository.setExternalMarkdownHook(
        ctx.proposalEngine.createExternalMarkdownHook({
          ...(ctx.llmClient ? { llmClient: ctx.llmClient } : {}),
        }),
      );
      // S4 Task 3: 注入 skill hook(参照 externalMarkdownHook 模式)
      ctx.repository.setSkillHook(ctx.proposalEngine.createSkillHook());
    }
    ctx.repository.startWatching();
    ctx.repository.addInvalidateListener(() => {
      if (ctx.searchOrchestrator) {
        rebuildSearchIndex(ctx.searchOrchestrator, ctx.repository);
      }
    });
    // .yaml 外部修改(git pull / Edit)→ debounce 重建 graph.json + SQLite synapse 表。
    // 解决 index-no-truth:原版 .yaml watcher 只清 synapseCache,派生层长期陈旧。
    ctx.repository.addSynapseChangeListener(() => {
      try {
        const cachePath = defaultCachePath(ctx.repository.rootPath);
        const orchestrator = new IndexOrchestrator(ctx.repository, cachePath);
        orchestrator.rebuildSynapseLayer();
      } catch {
        // listener 异常不阻塞 repository 主流程;下次 .yaml 变化再次触发
      }
    });
  }

  // 注:viewer 已在上方 holder gating 处(startHolderViewer)随 isHolder / onGained
  // 自动拉起,此处 return 块不再重复启动。

  return {
    ...ctx,
    stopMaintenance,
    ...(stopAuditRotation ? { stopAuditRotation } : {}),
    stopIndexWatcher: () => ctx.repository.stopWatching(),
    releaseProcessLock: (): void => {
      try {
        ctx.repository.stopWatching();
      } catch {
        // ignore — 未启动 watcher 时 stopWatching noop / 抛错都容忍
      }
      stopMaintenance?.();
      stopAuditRotation?.();
      processLock.release();
    },
    language,
  };
}

/**
 * 异步启动 viewer
 *
 * 与 registerCoEngramTools 分离,因为 viewer 启动是异步的且需要 @co-engram/claude-code。
 * 失败不抛到外层,只记 stderr——plugin 仍正常工作。
 *
 * @returns stop 函数;viewer 未启动时返回 undefined
 */
let viewerRuntime: {
  readonly stopViewer?: () => Promise<void>;
  readonly viewerPort?: number;
} | null = null;

export async function startCoEngramViewer(
  ctx: ToolContext & { readonly language?: Language },
  config: CoEngramPluginConfig = {},
): Promise<{
  readonly stopViewer?: () => Promise<void>;
  readonly viewerPort?: number;
}> {
  if (config.startViewer === false) return {}; // opt-out:默认开启(对齐 startHolderViewer)
  if (viewerRuntime) {
    process.stderr.write(
      `[co-engram] Viewer already running on port ${viewerRuntime.viewerPort ?? "?"}, skipping duplicate startup\n`,
    );
    return viewerRuntime;
  }
  try {
    const language = ctx.language ?? config.language ?? DEFAULT_LANGUAGE;
    // P3-fixup: 透传 dataRoot,让 viewer 能读取 persisted config
    // 否则 viewer 只看到 viewerConfig{port,token},/api/config 的 persisted/runtime
    // maintenanceEnabled/viewerEnabled 全部读不到。
    const dataRoot =
      config.dataRoot ?? `${process.env.HOME ?? "/tmp"}/team-memory`;
    const runtime: ViewerRuntime = await startViewerForOpenClaw(ctx, {
      ...config.viewerConfig,
      ...(dataRoot ? { dataRoot } : {}),
      language,
      hostType: "openclaw-plugin",
    });
    process.stderr.write(
      `[co-engram] Viewer listening on http://127.0.0.1:${runtime.port}\n`,
    );
    const result = {
      stopViewer: async () => {
        await runtime.stop();
        viewerRuntime = null;
      },
      viewerPort: runtime.port,
    };
    viewerRuntime = result;
    return result;
  } catch (err) {
    process.stderr.write(
      `[co-engram] Viewer failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {};
  }
}

/**
 * 构造候选提示文本（OpenClaw 注入用）
 *
 * 与 MCP 侧保持一致,均走 i18n 字典。
 */
export function buildProposalPrompt(
  count: number,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const plural = pluralSuffix(language, count);
  return translatePrompt(language, "prompt.proposal_prompt", { count, plural });
}

/**
 * 仅供测试/独立使用：构建一个内存中的 ctx + 注册结果
 */
export function createCoEngramTools(config: CoEngramPluginConfig = {}) {
  const ctx = createCoEngramContext(config);
  const registry = createToolRegistry();
  const errorBoundedTools = wrapAllToolsWithErrorBoundary(registry.list());
  const wrappedTools = wrapAllToolsWithSignalSink(errorBoundedTools);
  return {
    ctx,
    tools: adaptAllTools(wrappedTools, ctx),
    rebuild: () => {
      if (ctx.searchOrchestrator) {
        rebuildSearchIndex(ctx.searchOrchestrator, ctx.repository);
      }
    },
  };
}

export { DEFAULT_CONFIG };
