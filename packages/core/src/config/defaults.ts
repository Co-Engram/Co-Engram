/**
 * 配置默认值
 *
 * @module @co-engram/core/config
 */

import type {
  AuditSectionConfig,
  AutoMemorySyncSectionConfig,
  EffectivenessSectionConfig,
  MaintenanceSectionConfig,
  ObservationWindowSectionConfig,
  ProposalsSectionConfig,
  ReinforcementSectionConfig,
  ScoringSectionConfig,
  ServerSectionConfig,
  ViewerSectionConfig,
} from "./types.js";
import type { TrashMaintenanceConfig } from "../maintenance/types.js";
import { DEFAULT_CONFIG as DEFAULT_REINFORCEMENT_ENGINE_CONFIG } from "../reinforcement/config.js";
import { DEFAULT_WEIGHTS } from "../retrieval/scoring.js";
import { DEFAULT_EFFECTIVENESS_WINDOWS } from "../observability/effectiveness-tracker.js";

/**
 * Maintenance 默认值
 *
 * 间隔对齐 dreaming scheduler 的三阶段:light=5min, deep=1h, rem=7d。
 * 学习率 0.1 来自 RPE 经验值。
 *
 * `enabled` 默认 true:遵循 low-friction-defaults(开箱即用)。
 *   - 新仓库或 maintenance 段完全缺失时,自动启用。
 *   - 老仓库若 config.json 已显式写 `enabled: false`,normalize 阶段尊重不动。
 *   - 想禁用:在 config.json 写 `maintenance.enabled: false`。
 */
export const DEFAULT_MAINTENANCE_CONFIG: Readonly<
  Required<
    Omit<
      MaintenanceSectionConfig,
      "enabled" | "enabledStages" | "rules" | "trash"
    >
  >
> & {
  readonly enabled: boolean;
  readonly enabledStages: readonly ("light" | "deep" | "rem")[];
} = {
  enabled: true,
  enabledStages: ["light", "deep", "rem"],
  lightIntervalMs: 5 * 60 * 1000,
  deepIntervalMs: 60 * 60 * 1000,
  remIntervalMs: 7 * 24 * 60 * 60 * 1000,
  signalPruneAgeMs: 7 * 24 * 60 * 60 * 1000,
  learningRate: 0.1,
  windowSize: 10,
};

/** Proposals 默认值 */
export const DEFAULT_PROPOSALS_CONFIG: Readonly<
  Required<ProposalsSectionConfig>
> = {
  enabled: true,
  threshold: 3,
  similarityThreshold: 0.65,
  maxSamples: 8,
  minMessageLength: 16,
  defaultDismissDays: 7,
};

/** Audit 默认值 */
export const DEFAULT_AUDIT_CONFIG: Readonly<Required<AuditSectionConfig>> = {
  enabled: true,
};

/** Effectiveness 默认值 */
export const DEFAULT_EFFECTIVENESS_CONFIG: Readonly<
  Required<EffectivenessSectionConfig>
> = {
  enabled: true,
};

/** Viewer 默认值(port 已废弃,默认值由 viewer 按 hostType 决定) */
export const DEFAULT_VIEWER_CONFIG: Readonly<
  Required<Omit<ViewerSectionConfig, "url" | "port">>
> = {
  enabled: true,
};

/** Server 默认值 */
export const DEFAULT_SERVER_CONFIG: Readonly<Required<ServerSectionConfig>> = {
  name: "co-engram",
  version: "0.0.0",
};

/**
 * Auto-memory 同步默认值
 *
 * `enabled` 默认 true(遵循 low-friction-defaults):Claude Code 用户开箱即用,
 * 不需要手动启用。`projectsRoot` 留空 → 由 claude-code-mcp 用 `~/.claude/projects`
 * 解析(本字段允许 viewer / 用户显式 override)。`debounceMs` 500ms 足够吸收
 * Claude Code 写 MEMORY.md 时连续多次 change 事件。
 */
export const DEFAULT_AUTO_MEMORY_SYNC_CONFIG: Readonly<
  Required<Omit<AutoMemorySyncSectionConfig, "projectsRoot">>
> = {
  enabled: true,
  debounceMs: 500,
};

/**
 * Trash 默认值
 *
 * `enabled` 默认 true:遵循 low-friction-defaults。
 *   - 新仓库或 trash 段缺失时,自动启用 trash sweep。
 *   - 老仓库若 config.json 已显式写 `trash.enabled: false`,normalize 阶段尊重不动。
 *   - 想禁用:在 config.json 写 `maintenance.trash.enabled: false`。
 *
 * trash sweep 是非破坏:遗忘后 30 天才进 trash,365 天后才物理删除,
 * 期间可 restore,安全边界足够默认开启。
 */
export const DEFAULT_TRASH_CONFIG: Readonly<Required<TrashMaintenanceConfig>> =
  {
    enabled: true,
    afterDays: 30,
    purgeAfterDays: 365,
  };

/**
 * Reinforcement 默认值(从源码 DEFAULT_CONFIG 单一来源派生)
 *
 * 避免在 config 层重复硬编码 0.02/0.03/0.5/3/1.5。源码改默认值时,
 * config 层自动跟随。
 */
export const DEFAULT_REINFORCEMENT_SECTION: Readonly<
  Required<ReinforcementSectionConfig>
> = {
  ltpGain: DEFAULT_REINFORCEMENT_ENGINE_CONFIG.ltpGain,
  ltdPenalty: DEFAULT_REINFORCEMENT_ENGINE_CONFIG.ltdPenalty,
  hebbianRatio: DEFAULT_REINFORCEMENT_ENGINE_CONFIG.hebbianRatio,
  failureThreshold: DEFAULT_REINFORCEMENT_ENGINE_CONFIG.failureThreshold,
  failureEscalation: DEFAULT_REINFORCEMENT_ENGINE_CONFIG.failureEscalation,
};

/**
 * 三因子检索权重默认值(从源码 DEFAULT_WEIGHTS 派生)
 *
 * 字段名映射:relevance ← alpha, recency ← beta, importance ← gamma。
 * 源码改默认值时,config 层自动跟随。
 */
export const DEFAULT_SEARCH_SECTION: Readonly<Required<ScoringSectionConfig>> = {
  relevance: DEFAULT_WEIGHTS.alpha,
  recency: DEFAULT_WEIGHTS.beta,
  importance: DEFAULT_WEIGHTS.gamma,
};

/**
 * 观察窗口默认值(从源码 DEFAULT_EFFECTIVENESS_WINDOWS 单一来源派生)
 *
 * 5 种 engram kind 各自的窗口长度(毫秒)。源码改默认值时,config 层自动跟随。
 */
export const DEFAULT_OBSERVATION_SECTION: Readonly<
  Required<ObservationWindowSectionConfig>
> = {
  observation: DEFAULT_EFFECTIVENESS_WINDOWS.observation,
  fact: DEFAULT_EFFECTIVENESS_WINDOWS.fact,
  pattern: DEFAULT_EFFECTIVENESS_WINDOWS.pattern,
  procedure: DEFAULT_EFFECTIVENESS_WINDOWS.procedure,
  hypothesis: DEFAULT_EFFECTIVENESS_WINDOWS.hypothesis,
};
