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
 * Audit 日志轮转配置
 *
 * 独立后台任务(独立 setInterval),与 maintenance 引擎完全解耦 ——
 * 日志管理与 engram 数据维护是不同概念的东西。
 *
 * 清理策略:
 *   - 按 action 价值分层:HIGH_VALUE_ACTIONS 走 highValueRetentionDays,
 *     其余走 retentionDays
 *   - 文件大小硬上限:即使时间窗未到,文件超过 maxSizeMb 也强制截断
 *     (保留尾部最新),防止 readFileSync 大文件爆内存
 *   - 损坏行保留:JSON parse 失败的行不擅自删除,交给人工处理
 */
export interface AuditRotationConfig {
  /** 总开关(默认 true,遵循 low-friction-defaults) */
  readonly enabled?: boolean;
  /**
   * 一般事件的保留期(天,默认 90)。
   * 适用:propose / reinforce / report_failure / importance_update /
   * retrieve_* / noise_filtered / necessity_rejected。
   */
  readonly retentionDays?: number;
  /**
   * 高价值事件的保留期(天,默认 365)。
   * 适用:create / update / update_lifecycle / forget / restore /
   * sweep_to_trash / restore_from_trash / purge / accept / dismiss /
   * contradicted / merge_* / learning_loop_*。
   */
  readonly highValueRetentionDays?: number;
  /**
   * 文件大小硬上限(MB,默认 50)。即使按时间窗未到,文件超过此值也强制
   * 截断(保留尾部最新),防止 readFileSync 大文件爆内存。
   */
  readonly maxSizeMb?: number;
  /**
   * 轮转检查间隔(毫秒,默认 24 小时)。独立后台 setInterval,不依赖
   * maintenance 引擎阶段。
   */
  readonly intervalMs?: number;
}

/**
 * Audit 子系统在 config.json 中的配置
 *
 * `enabled` 控制是否写 audit;rotation 字段控制过期清理(独立后台任务,
 * 与 maintenance 完全解耦 — 日志管理与 engram 数据维护是不同概念的东西)。
 */
export interface AuditSectionConfig {
  /** 启用审计日志(默认 true) */
  readonly enabled?: boolean;
  /**
   * 日志轮转配置。设为 false 完全关闭自动清理(audit.jsonl 无限增长,
   * 仅适合测试或主动运维的场景)。
   */
  readonly rotation?: AuditRotationConfig;
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
  /**
   * @deprecated 已废弃。两宿主(Claude Code / OpenClaw)共享同一 persisted config,
   * 若 viewer.port 在此设置会导致两宿主抢同一端口。改用 env `CO_ENGRAM_VIEWER_PORT`
   * 覆盖,或接受 host-specific 默认(Claude Code=18799,OpenClaw=18899)。
   * 此字段在 normalize 时会被丢弃。
   */
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
 * Reinforcement 子系统在 config.json 中的配置
 *
 * 与 `packages/core/src/reinforcement/config.ts` 的 `ReinforcementConfig` 对齐,
 * 但本接口所有字段可选(由 loader 用 DEFAULT_CONFIG 补齐)。
 *
 * 用户在 config.json 中只需写需要调整的字段,其余自动用 spec 6.2 默认值。
 */
export interface ReinforcementSectionConfig {
  /** Hebbian 邻居强化系数 ∈ [0,1](默认 0.5) */
  readonly hebbianRatio?: number;
  /** 触发 archive 建议的 failedUses 阈值(默认 3) */
  readonly archiveThreshold?: number;
  /** 触发 forget 建议的 failedUses 阈值(默认 5) */
  readonly forgetThreshold?: number;
}

/**
 * 三因子检索权重在 config.json 中的配置
 *
 * 与 `packages/core/src/retrieval/scoring.ts` 的 `FourFactorWeights` 对齐,
 * 字段名改用语义化命名(relevance/recency/importance/strength)以便用户理解。
 *
 * 用户在 config.json 中只需写需要调整的字段,其余自动用 spec 3.7 默认值
 * (α=0.5, β=0.2, γ=0.2, δ=0.1)。
 */
export interface ScoringSectionConfig {
  /** relevance 权重(语义/关键词匹配,默认 0.5) */
  readonly relevance?: number;
  /** recency 权重(艾宾浩斯衰退,默认 0.2) */
  readonly recency?: number;
  /** importance 权重(价值,默认 0.2) */
  readonly importance?: number;
  /** strength 权重(用户反馈累积 reinforcementScore,默认 0.1) */
  readonly strength?: number;
}

/**
 * 观察窗口覆盖(按 engram kind 分别配置)
 *
 * 与 `packages/core/src/observability/effectiveness-tracker.ts` 的
 * `DEFAULT_EFFECTIVENESS_WINDOWS` 对齐。值为毫秒。
 *
 * 用户在 config.json 中只需写需要调整的 kind,其余自动用默认值。
 */
export interface ObservationWindowSectionConfig {
  /** observation kind 窗口(默认 6h) */
  readonly observation?: number;
  /** fact kind 窗口(默认 24h) */
  readonly fact?: number;
  /** pattern kind 窗口(默认 48h) */
  readonly pattern?: number;
  /** procedure kind 窗口(默认 48h) */
  readonly procedure?: number;
  /** hypothesis kind 窗口(默认 7d) */
  readonly hypothesis?: number;
}

/**
 * Auto-memory 同步子系统配置(Claude Code MCP 专用)
 *
 * Claude Code 在 `~/.claude/projects/<encoded-cwd>/memory/*.md` 下维护一份
 * 自动记忆,本子系统把这份记忆同步为 co-engram engram(幂等,domainTag 标识来源)。
 *
 * 默认 true(遵循 low-friction-defaults)。OpenClaw 没有等价的"自动记忆写入器",
 * 该子系统在 OpenClaw host 下完全不启动(由 claude-code-mcp 在 main() 内决定)。
 */
export interface AutoMemorySyncSectionConfig {
  /**
   * 启用 auto-memory 同步(默认 true)
   *
   * 设为 false 完全禁用 watcher + 初始扫描,co-engram 不会读 Claude Code 的
   * memory 目录。env `CO_ENGRAM_AUTO_MEMORY_SYNC=0` 优先于本字段。
   */
  readonly enabled?: boolean;
  /**
   * Claude Code projects 根目录(默认 ~/.claude/projects)
   *
   * 通常不需要改,但用户可能用 CO_ENGRAM_CLAUDE_PROJECTS_ROOT 自定义位置。
   */
  readonly projectsRoot?: string;
  /** 文件变化去抖间隔(毫秒,默认 500) */
  readonly debounceMs?: number;
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
  /** Auto-memory 同步子系统配置(Claude Code MCP 专用,OpenClaw 忽略) */
  readonly autoMemorySync?: AutoMemorySyncSectionConfig;
  /** Reinforcement 子系统配置(LTP/LTD/Hebbian 参数,源码 DEFAULT_CONFIG) */
  readonly reinforcement?: ReinforcementSectionConfig;
  /** 三因子检索权重配置(源码 DEFAULT_WEIGHTS α=0.5 β=0.3 γ=0.2) */
  readonly search?: ScoringSectionConfig;
  /** 观察窗口覆盖(按 engram kind,源码 DEFAULT_EFFECTIVENESS_WINDOWS) */
  readonly observation?: ObservationWindowSectionConfig;
}

// Re-export 引擎用的子系统类型(供 main 等调用方使用)
export type {
  MaintenanceStage,
  TrashMaintenanceConfig,
} from "../maintenance/types.js";
