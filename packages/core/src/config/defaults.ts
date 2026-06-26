/**
 * 配置默认值
 *
 * @module @co-engram/core/config
 */

import type {
  AuditSectionConfig,
  EffectivenessSectionConfig,
  MaintenanceSectionConfig,
  ProposalsSectionConfig,
  ServerSectionConfig,
  ViewerSectionConfig,
} from "./types.js";
import type { TrashMaintenanceConfig } from "../maintenance/types.js";

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

/** Viewer 默认值 */
export const DEFAULT_VIEWER_CONFIG: Readonly<
  Required<Omit<ViewerSectionConfig, "url">>
> = {
  enabled: true,
  port: 18799,
};

/** Server 默认值 */
export const DEFAULT_SERVER_CONFIG: Readonly<Required<ServerSectionConfig>> = {
  name: "co-engram",
  version: "0.0.0",
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
