/**
 * OpenClaw Plugin API 最小化类型定义
 *
 * 不直接 import openclaw 包（避免版本耦合），
 * 只定义我们需要用到的子集签名。
 *
 * host 在自己的 openclaw 项目里通过 definePluginEntry(api => ...)
 * 把真实的 OpenClawPluginApi 传给 registerCoEngramTools。
 *
 * @module @co-engram/openclaw
 */

import type {
  MaintenanceConfig,
  ProposalEngineConfig,
  AuditRotationConfig,
  Language,
  PromptSignalSnapshot,
  NecessityEvaluator,
} from "@co-engram/core";

/**
 * JSON Schema 片段（OpenClaw tool parameters 接受 plain JSON Schema object）
 */
export type JsonSchemaObject = {
  readonly type?: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [key: string]: unknown;
};

/**
 * AgentTool.execute 的返回结构（最小化）
 */
export interface ToolExecuteResult {
  readonly content: ReadonlyArray<{
    readonly type: "text" | "json";
    readonly text?: string;
    readonly data?: unknown;
  }>;
  readonly details?: Record<string, unknown>;
}

/**
 * AnyAgentTool 最小子集（OpenClaw 期望的 tool shape）
 */
export interface OpenClawToolDescriptor {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolExecuteResult>;
}

/**
 * api.registerTool 的最小签名（AnyAgentTool | Factory 都支持，这里简化）
 */
export type RegisterToolFn = (
  tool: OpenClawToolDescriptor,
  opts?: { readonly name?: string },
) => void;

/**
 * 可选的下轮注入 hook（OpenClaw 真实 API 子集）
 *
 * 用于 M3b:会话开始时把候选提示注入下一轮 agent context。
 * 如果 host 不支持,省略即可——plugin 会跳过自动注入。
 */
export interface PluginNextTurnInjectionInput {
  readonly sessionKey: string;
  readonly text: string;
  readonly placement?: "prepend_context" | "append_context";
  readonly idempotencyKey?: string;
}

export interface PluginNextTurnInjectionResult {
  readonly enqueued: boolean;
  readonly id?: string;
  readonly sessionKey: string;
}

export type EnqueueNextTurnInjectionFn = (
  injection: PluginNextTurnInjectionInput,
) => Promise<PluginNextTurnInjectionResult>;

/**
 * 可选的 session hook(OpenClaw registerHook 子集)
 *
 * 用于 M3b:监听 session 'new' 事件以触发候选提示注入。
 */
export type SessionHookHandler = (event: {
  readonly type: "session";
  readonly action: string;
  readonly sessionKey: string;
  readonly context?: Readonly<Record<string, unknown>>;
}) => Promise<void> | void;

export type RegisterHookFn = (
  events: "session" | readonly string[],
  handler: SessionHookHandler,
  opts?: {
    readonly name: string;
    readonly description?: string;
    readonly entry?: unknown;
  },
) => void;

/**
 * Memory capability 注册参数
 *
 * 对应 OpenClaw `api.registerMemoryCapability({...})` 的子集。
 * co-engram 目前只用 promptBuilder 字段;flushPlanResolver/runtime 留空
 * (维护引擎自带定时器,不依赖 OpenClaw runtime 钩子)。
 */
export interface MemoryPromptBuilderParams {
  readonly availableTools: ReadonlySet<string>;
  readonly citationsMode?: "off" | "compact" | "full";
}

export type MemoryPromptBuilder = (
  params: MemoryPromptBuilderParams,
) => readonly string[];

export interface MemoryCapabilityRegistration {
  readonly promptBuilder?: MemoryPromptBuilder;
  readonly flushPlanResolver?: unknown;
  readonly runtime?: unknown;
  readonly publicArtifacts?: unknown;
}

export type RegisterMemoryCapabilityFn = (
  capability: MemoryCapabilityRegistration,
) => void;

/**
 * before_prompt_build hook 事件
 *
 * OpenClaw 在 prompt 组装前触发,允许插件追加 system prompt 段。
 * 用于在 workspace MEMORY.md 之后追加 co-engram 的实际记忆内容。
 */
export interface BeforePromptBuildEvent {
  readonly prompt: string;
  readonly messages?: readonly unknown[];
}

export interface BeforePromptBuildResult {
  /** 追加到 base system prompt 末尾(workspace MEMORY.md / promptBuilder 段之后) */
  readonly appendSystemContext?: string;
  /** 前置到 base system prompt 开头 */
  readonly prependSystemContext?: string;
}

export type BeforePromptBuildHandler = (
  event: BeforePromptBuildEvent,
) => Promise<BeforePromptBuildResult | void> | BeforePromptBuildResult | void;

/**
 * OpenClaw Plugin API 子集
 *
 * 实际 OpenClawPluginApi 有更多方法,但 co-engram 只需要 registerTool;
 * enqueueNextTurnInjection / registerHook 可选(用于 M3b system prompt 注入)。
 */
export interface CoEngramPluginHostApi {
  readonly registerTool: RegisterToolFn;
  /** 可选:用于 M3b 候选提示注入 */
  readonly enqueueNextTurnInjection?: EnqueueNextTurnInjectionFn;
  /** 可选:用于监听 session 生命周期事件 */
  readonly registerHook?: RegisterHookFn;
  /** 可选:声明 memory capability(OpenClaw 主要记忆插件需要,触发 memory section 注入) */
  readonly registerMemoryCapability?: RegisterMemoryCapabilityFn;
  /** 可选:注册 plugin hook(OpenClaw api.on 子集) */
  readonly on?: (
    event: "before_prompt_build",
    handler: BeforePromptBuildHandler,
  ) => void;
  /** 可选:注册 additive memory prompt supplement(非 exclusive,不依赖 slot) */
  readonly registerMemoryPromptSupplement?: (
    builder: (params: {
      availableTools: Set<string>;
      citationsMode?: "off" | "compact" | "full";
    }) => string[],
  ) => void;
  /** 可选:plugin config(由 OpenClaw 默认 entry 透传) */
  readonly pluginConfig?: Record<string, unknown>;
}

/**
 * 插件配置（来自 openclaw.plugin.json 的 configSchema）
 *
 * 注意:`dataRoot` 字段已废弃 —— 统一用 `co-engram config data-root <path>` CLI
 * 命令修改 dataRoot(写入 ~/.co-engram/config.json)。这里保留字段定义是为了
 * 向后兼容(老代码可能仍传),但 createCoEngramContext 会忽略它并输出 deprecation 警告。
 */
export interface CoEngramPluginConfig {
  /** @deprecated 用 'co-engram config data-root <path>' CLI 命令替代 */
  readonly dataRoot?: string;
  /** 是否启用 */
  readonly enabled?: boolean;
  /** 默认创建者（写入操作时若未指定 createdBy，用此值） */
  readonly defaultCreatedBy?: string;
  /** 工具描述、查看器 UI、提示词所用语言(默认 'en') */
  readonly language?: Language;
  /**
   * 是否启动自动维护服务
   *
   * 默认 true(遵循 low-friction-defaults):light/deep/rem 三阶段自动跑,
   * 让记忆强化/遗忘/巩固开箱即用。设 false 可关闭。
   */
  readonly startMaintenance?: boolean;
  /** 维护服务配置（light/deep/rem 间隔、learningRate 等），透传给 MaintenanceEngine */
  readonly maintenanceConfig?: MaintenanceConfig;
  /** 是否启用 audit log（默认 true） */
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
  /**
   * 团队动态事件同步(2026-08-19)。启用时(默认),高价值动作除写本地
   * audit 外,另落 events/<日期>/<origin>.jsonl 分片随 git 同步——
   * 「各自 clone + sync」拓扑下,viewer「记忆动态」由此显示团队成员的
   * 操作流。private engram 的事件被过滤,不进同步目录。
   */
  readonly auditTeamEvents?: {
    enabled?: boolean;
    retentionDays?: number;
  };
  /** 是否启用 effectiveness 追踪（默认 true） */
  readonly effectivenessEnabled?: boolean;
  /** 是否启用 proposal engine（默认 true） */
  readonly proposalEnabled?: boolean;
  /** proposal engine 配置 */
  readonly proposalConfig?: ProposalEngineConfig;
  /**
   * 必要性评估 LLM 配置(可选)
   *
   * 配置后,proposal engine 在 cluster 晋升前会用 LLM 判断"是否值得固化为团队记忆",
   * 失败 fallback 到规则版(RuleBasedNecessityEvaluator)。
   * 不配置时只走规则版,零 LLM 成本。
   */
  readonly necessityLlm?: NecessityLlmConfig;
  /**
   * 可选:宿主直接注入 NecessityEvaluator 实例(优先级高于 necessityLlm 配置)
   *
   * 让 OpenClaw 等高级宿主可以用自己的 LLM 调用设施构造评估器,绕过本插件
   * 内置的 OpenAI-compatible fetch 实现。
   */
  readonly necessityEvaluator?: NecessityEvaluator;
  /** 是否启动 viewer HTTP server（默认 false,M4） */
  readonly startViewer?: boolean;
  /** viewer 配置（端口/token 等） */
  readonly viewerConfig?: ViewerConfig;
  /**
   * 是否在 plugin 启动时自动 onboard git merge driver(默认 true)。
   *
   * 启用后,启动时会检测 dataRoot 所在 git repo,自动安装 merge driver
   * bundle / .gitattributes / .git/config(全部幂等)。
   *
   * 关闭后,用户需手动运行 `co-engram git enable`(P2.6 CLI)。
   * 默认开启,匹配零手动步骤的 low-friction-defaults 原则。
   */
  readonly autoOnboardMergeDriver?: boolean;
  /** 预计算的 prompt signals（由 entry.ts 从 .co-engram/prompt-signals.json 读取并注入） */
  readonly promptSignals?: PromptSignalSnapshot;
}

/** Viewer 配置 */
export interface ViewerConfig {
  /** 端口(默认 18899,2026-07 起两宿主共用) */
  readonly port?: number;
  /** Bearer token(可选) */
  readonly token?: string;
}

/**
 * 必要性评估 LLM 配置
 *
 * 用于 LlmNecessityEvaluator — proposal 晋升前的"必要性"判断。
 * 失败 fallback 到规则版,所以配置不正确不会阻塞 proposal engine。
 */
export interface NecessityLlmConfig {
  /**
   * OpenAI-compatible chat completions endpoint
   *
   * 支持 OpenAI / Azure / 通义 / 智谱 / 本地 ollama 等。
   * 自动追加 `/chat/completions` 后缀。
   */
  readonly endpoint: string;
  /** API key */
  readonly apiKey: string;
  /** 模型名(如 'gpt-4o-mini' / 'qwen-turbo' / 'glm-4-flash') */
  readonly model: string;
  /** 可选额外 headers */
  readonly headers?: Record<string, string>;
}

/**
 * 默认配置
 *
 * - dataRoot / enabled / startMaintenance 有固定默认值（必填）
 * - defaultCreatedBy 不设硬编码默认值:留空时由 plugin-entry.ts 走
 *   `detectGitAuthor() ?? config.defaultCreatedBy ?? env` 回退链,
 *   避免把工具名('openclaw')当作人类作者写入 engram/synapse。
 * - maintenanceConfig 默认 undefined（交给 MaintenanceEngine 内置默认值）
 * - audit/effectiveness/proposal 默认 true
 */
export const DEFAULT_CONFIG: Required<
  Pick<
    CoEngramPluginConfig,
    "dataRoot" | "enabled" | "startMaintenance"
  >
> &
  Pick<CoEngramPluginConfig, "maintenanceConfig" | "defaultCreatedBy"> & {
    readonly auditEnabled: boolean;
    readonly effectivenessEnabled: boolean;
    readonly proposalEnabled: boolean;
  } = {
  dataRoot: `${process.env.HOME ?? "/tmp"}/team-memory`,
  enabled: true,
  startMaintenance: true,
  auditEnabled: true,
  effectivenessEnabled: true,
  proposalEnabled: true,
};
