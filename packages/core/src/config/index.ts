/**
 * 配置加载与自愈
 *
 * 本模块是 co-engram 配置的**单一权威入口**。
 *
 * 设计:
 *   - dataRoot 内 `.co-engram/config.json` 是配置的权威来源
 *   - env 仅保留 `CO_ENGRAM_DATA_ROOT`(bootstrap 引导,无法自举)和 `CO_ENGRAM_VIEWER_TOKEN`(敏感)
 *   - 字段缺失时用默认值补齐并立即写回(自愈)
 *   - 旧字段(`desiredAuditEnabled` 等)在加载时迁移到嵌套字段
 *   - JSON 损坏时备份原文件后写默认配置,绝不静默覆盖用户数据
 *
 * @module @co-engram/core/config
 */

import type { TeamMemoryConfig } from "./types.js";
import {
  DEFAULT_AUDIT_CONFIG,
  DEFAULT_EFFECTIVENESS_CONFIG,
  DEFAULT_MAINTENANCE_CONFIG,
  DEFAULT_PROPOSALS_CONFIG,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_TRASH_CONFIG,
  DEFAULT_VIEWER_CONFIG,
} from "./defaults.js";

export type {
  TeamMemoryConfig,
  MaintenanceSectionConfig,
  ProposalsSectionConfig,
  AuditSectionConfig,
  EffectivenessSectionConfig,
  ViewerSectionConfig,
  ServerSectionConfig,
} from "./types.js";
export type {
  MaintenanceConfig,
  MaintenanceStage,
  TrashMaintenanceConfig,
} from "../maintenance/types.js";
export type { ProposalEngineConfig } from "../observability/proposal-engine.js";

/** config 文件名(放在 dataRoot/.co-engram/ 下) */
export const TEAM_MEMORY_CONFIG_FILENAME = "config.json";

/**
 * 自愈默认 config(用于首次创建 / 文件损坏时重建)
 *
 * 注意:`createdAt` 留空,由调用方按当前时间填入。
 */
export function createDefaultConfig(): TeamMemoryConfig {
  return {
    version: 1,
    language: "zh",
    maintenance: {
      ...DEFAULT_MAINTENANCE_CONFIG,
      trash: { ...DEFAULT_TRASH_CONFIG },
    },
    proposals: { ...DEFAULT_PROPOSALS_CONFIG },
    audit: { ...DEFAULT_AUDIT_CONFIG },
    effectiveness: { ...DEFAULT_EFFECTIVENESS_CONFIG },
    viewer: { ...DEFAULT_VIEWER_CONFIG },
    server: { ...DEFAULT_SERVER_CONFIG },
  };
}

/**
 * 用默认值补齐缺失的子系统字段
 */
function fillDefaults(raw: Readonly<TeamMemoryConfig>): TeamMemoryConfig {
  const maintenance = {
    ...DEFAULT_MAINTENANCE_CONFIG,
    ...(raw.maintenance ?? {}),
    trash: {
      ...DEFAULT_TRASH_CONFIG,
      ...(raw.maintenance?.trash ?? {}),
    },
  };

  return {
    ...raw,
    maintenance,
    audit: { ...DEFAULT_AUDIT_CONFIG, ...(raw.audit ?? {}) },
    proposals: { ...DEFAULT_PROPOSALS_CONFIG, ...(raw.proposals ?? {}) },
    effectiveness: {
      ...DEFAULT_EFFECTIVENESS_CONFIG,
      ...(raw.effectiveness ?? {}),
    },
    viewer: { ...DEFAULT_VIEWER_CONFIG, ...(raw.viewer ?? {}) },
    server: { ...DEFAULT_SERVER_CONFIG, ...(raw.server ?? {}) },
  };
}

/**
 * 检测 raw config 是否需要规范化(字段缺失)
 */
function needsNormalize(raw: Readonly<TeamMemoryConfig>): boolean {
  if (raw.maintenance === undefined) return true;
  if (raw.proposals === undefined) return true;
  if (raw.audit === undefined) return true;
  if (raw.effectiveness === undefined) return true;
  if (raw.viewer === undefined) return true;
  if (raw.server === undefined) return true;
  if (raw.maintenance?.trash === undefined) return true;
  return false;
}

/**
 * 规范化 config:补默认值
 *
 * 输入是 readTeamMemoryConfig 的原始解析结果(可能缺字段),
 * 输出保证完整:所有子系统字段齐全。
 *
 * 幂等:对已规范化的 config 调用此函数,返回值结构等价。
 */
export function normalizeConfig(
  raw: Readonly<TeamMemoryConfig> | undefined,
): TeamMemoryConfig {
  const base = raw ?? createDefaultConfig();
  return fillDefaults(base);
}

// --- 读写原语 ---

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf-8");
}

async function defaultWriteFile(path: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function defaultBackupFile(
  path: string,
  backupPath: string,
): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(path, backupPath);
}

async function fileExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/**
 * config.json 在 dataRoot 内的完整路径
 */
export function resolveConfigPath(dataRoot: string): string {
  return joinPath(dataRoot, ".co-engram", TEAM_MEMORY_CONFIG_FILENAME);
}

/**
 * 读取 config(原始,不做迁移)
 *
 * 文件不存在或 JSON 解析失败时返回 undefined。
 * 想要"自愈 + 完整 config"请用 {@link loadAndSelfHealConfig}。
 */
export async function readTeamMemoryConfig(
  dataRoot: string,
  fsRead?: (path: string) => Promise<string>,
): Promise<TeamMemoryConfig | undefined> {
  const path = resolveConfigPath(dataRoot);
  try {
    const content = fsRead ? await fsRead(path) : await defaultReadFile(path);
    const parsed = JSON.parse(content) as TeamMemoryConfig;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写入 config(完整覆盖)
 */
export async function writeTeamMemoryConfig(
  dataRoot: string,
  config: TeamMemoryConfig,
  fsWrite?: (path: string, content: string) => Promise<void>,
): Promise<void> {
  const path = resolveConfigPath(dataRoot);
  const content = JSON.stringify(config, null, 2) + "\n";
  if (fsWrite) {
    await fsWrite(path, content);
    return;
  }
  await defaultWriteFile(path, content);
}

/**
 * 加载结果:包含最终 config 以及加载过程中发生的事件(供调用方决策日志)
 */
export interface LoadResult {
  /** 规范化后的完整 config(子系统字段齐全) */
  readonly config: TeamMemoryConfig;
  /**
   * 加载事件:
   *   - `created`:文件不存在,新建了默认 config
   *   - `normalized`:文件存在但字段缺失或有旧字段,迁移后写回
   *   - `repaired`:文件存在但 JSON 损坏,备份后重建默认 config
   *   - `loaded`:文件存在且完整,未触发写回
   */
  readonly event: "created" | "normalized" | "repaired" | "loaded";
  /** 损坏时的备份路径(仅 event='repaired' 时存在) */
  readonly backupPath?: string;
}

/**
 * 加载 config 并自愈
 *
 * 行为:
 *   1. 文件不存在 → 写入默认 config,返回 `{ event: 'created' }`
 *   2. 文件存在但 JSON 损坏 → 备份为 `config.json.broken.<ts>` 后写默认,返回 `{ event: 'repaired', backupPath }`
 *   3. 文件存在且合法但字段缺失/有旧字段 → 规范化后写回,返回 `{ event: 'normalized' }`
 *   4. 文件存在且完整 → 直接返回,返回 `{ event: 'loaded' }`
 */
export async function loadAndSelfHealConfig(
  dataRoot: string,
): Promise<LoadResult> {
  const path = resolveConfigPath(dataRoot);
  const exists = await fileExists(path);

  if (!exists) {
    const config = createDefaultConfig();
    await writeTeamMemoryConfig(dataRoot, config);
    return { config, event: "created" };
  }

  let raw: TeamMemoryConfig | undefined;
  let parseFailed = false;
  try {
    const content = await defaultReadFile(path);
    const parsed = JSON.parse(content) as TeamMemoryConfig;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      raw = parsed;
    } else {
      parseFailed = true;
    }
  } catch {
    parseFailed = true;
  }

  if (parseFailed || raw === undefined) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${path}.broken.${ts}`;
    try {
      await defaultBackupFile(path, backupPath);
    } catch {
      // 备份失败不阻塞,继续写默认
    }
    const config = createDefaultConfig();
    await writeTeamMemoryConfig(dataRoot, config);
    return { config, event: "repaired", backupPath };
  }

  if (!needsNormalize(raw)) {
    return { config: raw, event: "loaded" };
  }

  const normalized = normalizeConfig(raw);
  await writeTeamMemoryConfig(dataRoot, normalized);
  return { config: normalized, event: "normalized" };
}

/**
 * 仅把 `desiredDataRoot` 一个字段写入 config.json(用于 viewer redirect hint)
 *
 * 不修改其他字段(viewer 切 dataRoot 时不破坏现有 config)。
 */
export async function setDesiredDataRoot(
  dataRoot: string,
  desiredDataRoot: string | undefined,
): Promise<void> {
  const current = await readTeamMemoryConfig(dataRoot);
  const base = current ?? createDefaultConfig();
  const next: TeamMemoryConfig = desiredDataRoot
    ? { ...base, desiredDataRoot }
    : (() => {
        const { desiredDataRoot: _drop, ...rest } = base;
        void _drop;
        return rest as TeamMemoryConfig;
      })();
  await writeTeamMemoryConfig(dataRoot, next);
}
