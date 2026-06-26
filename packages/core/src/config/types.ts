/**
 * 配置类型定义
 *
 * dataRoot 内 `.co-engram/config.json` 的 schema。
 * 单一权威来源:env 仅保留 bootstrap 入口(DATA_ROOT)和敏感项(VIEWER_TOKEN),
 * 其他全部配置项以本文件中的 schema 为准。
 *
 * 子系统配置类型复用各模块已有的接口(maintenance/MaintenanceConfig 等),
 * 本文件仅补充 config.json 专用的"开关 + 调参"包装。
 *
 * @module @co-engram/core/config
 */

import type { Language } from "../i18n/types.js";
import type {
  MaintenanceConfig as EngineMaintenanceConfig,
  MaintenanceStage,
  TrashMaintenanceConfig,
} from "../maintenance/types.js";

/**
 * Maintenance 子系统在 config.json 中的配置
 *
 * 在引擎用的 {@link EngineMaintenanceConfig} 基础上,加一个 `enabled` 开关字段。
 * `enabled=false` 时三阶段都不跑。
 */
export interface MaintenanceSectionConfig extends EngineMaintenanceConfig {
  /** 总开关(false 时三阶段都不跑;默认 true,遵循 low-friction-defaults) */
  readonly enabled?: boolean;
}

/**
 * Proposal Engine 配置(与 observability/proposal-engine 的 ProposalEngineConfig 对齐)
 */
export interface ProposalsSectionConfig {
  /** 启用候选记忆捕获(默认 true) */
  readonly enabled?: boolean;
  /** 归簇触发阈值 */
  readonly threshold?: number;
  /** 相似度阈值 (0,1] */
  readonly similarityThreshold?: number;
  /** 单个 cluster 保留的最大样本数 */
  readonly maxSamples?: number;
  /** 触发 observe 的最小消息长度(过滤短消息) */
  readonly minMessageLength?: number;
  /** dismiss 后多少天内不再提示 */
  readonly defaultDismissDays?: number;
}

/**
 * Audit 子系统在 config.json 中的配置
 */
export interface AuditSectionConfig {
  /** 启用审计日志(默认 true) */
  readonly enabled?: boolean;
}

/**
 * Effectiveness 子系统在 config.json 中的配置
 */
export interface EffectivenessSectionConfig {
  /** 启用有效性追踪(默认 true) */
  readonly enabled?: boolean;
}

/**
 * Viewer 子系统在 config.json 中的配置(不含 token)
 */
export interface ViewerSectionConfig {
  /** 启用 web viewer(默认跟随 proposal engine) */
  readonly enabled?: boolean;
  /** viewer 监听端口(默认 18799) */
  readonly port?: number;
  /** viewer 对外可达 URL */
  readonly url?: string;
}

/**
 * MCP server 协议身份
 */
export interface ServerSectionConfig {
  /** MCP server name(默认 'co-engram') */
  readonly name?: string;
  /** MCP server version(默认 '0.0.0') */
  readonly version?: string;
}

/**
 * team-memory 持久化配置形状
 *
 * 由 `co-engram init` 或自愈机制写入,启动时以本文件为单一权威。
 *
 * 顶级字段(非子系统调参)保持平铺:
 *   - `language` / `defaultCreatedBy` / `toolsProfile` / `migratedToLanguage`
 *
 * `desiredDataRoot` 是 viewer 写入的"下次启动 dataRoot redirect hint",
 * bootstrap 阶段读到时,把 dataRoot 切到该值;其他字段以 redirect 后的 dataRoot
 * 内 config.json 为准。
 */
export interface TeamMemoryConfig {
  /** schema 版本 */
  readonly version: 1;
  /** 工具描述、查看器 UI、提示词所用语言 */
  readonly language?: Language;
  /** 默认作者标识(git > config > env > 'unknown') */
  readonly defaultCreatedBy?: string;
  /** 创建时间 ISO */
  readonly createdAt?: string;
  /** 初始化工具版本 */
  readonly initializedBy?: string;
  /** 已迁移到的磁盘字段语言格式(避免重复 migrate) */
  readonly migratedToLanguage?: Language;
  /** Claude Code MCP 工具暴露 profile('minimal' | 'standard' | 'full') */
  readonly toolsProfile?: string;

  /**
   * 必要性评估 LLM 配置(可选)
   *
   * 配置后,proposal engine 在 cluster 晋升前会用 LLM 判断"是否值得固化为团队记忆",
   * 失败 fallback 到 RuleBasedNecessityEvaluator(规则版)。
   * 不配置时,根据 host 环境探测:
   *   - claude-code-mcp:从 env ANTHROPIC_API_KEY 自动构造
   *   - openclaw-plugin:从 ~/.openclaw/openclaw.json 自动构造
   * 探测失败时只走规则版,零 LLM 成本。
   */
  readonly necessityLlm?: {
    /** API key(env 优先) */
    readonly apiKey?: string;
    /** 模型名 */
    readonly model?: string;
    /** 可选自定义 endpoint */
    readonly endpoint?: string;
    /** 可选额外 headers */
    readonly headers?: Record<string, string>;
  };

  /**
   * 下次启动期望的数据根目录(viewer 写入)
   *
   * bootstrap 阶段若读到此字段,会把 dataRoot 切到该值。
   * **redirect 语义**:仅作为下次启动的 dataRoot hint,
   * 其他配置字段仍以 redirect 后的 dataRoot 内 config.json 为准。
   */
  readonly desiredDataRoot?: string;

  /** Maintenance 子系统配置 */
  readonly maintenance?: MaintenanceSectionConfig;
  /** Proposals 子系统配置 */
  readonly proposals?: ProposalsSectionConfig;
  /** Audit 子系统配置 */
  readonly audit?: AuditSectionConfig;
  /** Effectiveness 子系统配置 */
  readonly effectiveness?: EffectivenessSectionConfig;
  /** Viewer 子系统配置(不含 token) */
  readonly viewer?: ViewerSectionConfig;
  /** MCP server 协议身份 */
  readonly server?: ServerSectionConfig;
}

// Re-export 引擎用的子系统类型(供 main 等调用方使用)
export type {
  MaintenanceStage,
  TrashMaintenanceConfig,
} from "../maintenance/types.js";
