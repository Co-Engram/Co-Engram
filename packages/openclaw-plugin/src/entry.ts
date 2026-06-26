/**
 * OpenClaw 默认 plugin entry（开箱即用）
 *
 * 用户只需：
 *   1. 把 @co-engram/openclaw 安装到 openclaw 的 extensions 目录
 *   2. 在 openclaw config 里（可选）配置 plugins.entries.co-engram.config
 *
 * 不需要自己写 plugin-entry 文件。
 *
 * Loader 接受 plain object（含 register(api)），不强制走 definePluginEntry。
 * 参见 src/plugins/loader.ts:1384 resolvePluginModuleExport。
 *
 * ## OpenClaw low-friction 默认
 *
 * 与 @co-engram/core 的 DEFAULT_CONFIG(给保守主机用)不同,OpenClaw plugin
 * 默认开启常用功能:proposal engine / maintenance runtime / web viewer。
 * 用户可通过显式传 `false` 关闭任一项(low-friction-defaults 原则)。
 *
 * @module @co-engram/openclaw
 */

import { readFileSync, existsSync } from "node:fs";
import { join as joinPath } from "node:path";
import { registerCoEngramTools, startCoEngramViewer } from "./plugin-entry.js";
import {
  resolveLanguage,
  parseLanguage,
  type TeamMemoryConfig,
  type PromptSignalSnapshot,
} from "@co-engram/core";
import type { CoEngramPluginConfig, CoEngramPluginHostApi } from "./types.js";

/**
 * 从 api.pluginConfig（openclaw 配置文件 plugins.entries.co-engram.config）
 * 提取用户配置,转换成 CoEngramPluginConfig。
 */
function readUserConfig(
  pluginConfig: Record<string, unknown> | undefined,
): CoEngramPluginConfig {
  if (!pluginConfig) return {};
  const parts: CoEngramPluginConfig[] = [];

  if (typeof pluginConfig.dataRoot === "string") {
    parts.push({ dataRoot: pluginConfig.dataRoot });
  }
  if (typeof pluginConfig.enabled === "boolean") {
    parts.push({ enabled: pluginConfig.enabled });
  }
  if (typeof pluginConfig.defaultCreatedBy === "string") {
    parts.push({ defaultCreatedBy: pluginConfig.defaultCreatedBy });
  }
  if (typeof pluginConfig.language === "string") {
    parts.push({ language: parseLanguage(pluginConfig.language) });
  }
  if (typeof pluginConfig.startMaintenance === "boolean") {
    parts.push({ startMaintenance: pluginConfig.startMaintenance });
  }
  if (
    pluginConfig.maintenanceConfig &&
    typeof pluginConfig.maintenanceConfig === "object"
  ) {
    parts.push({
      maintenanceConfig:
        pluginConfig.maintenanceConfig as CoEngramPluginConfig["maintenanceConfig"],
    });
  }
  if (typeof pluginConfig.auditEnabled === "boolean") {
    parts.push({ auditEnabled: pluginConfig.auditEnabled });
  }
  if (typeof pluginConfig.effectivenessEnabled === "boolean") {
    parts.push({ effectivenessEnabled: pluginConfig.effectivenessEnabled });
  }
  if (typeof pluginConfig.proposalEnabled === "boolean") {
    parts.push({ proposalEnabled: pluginConfig.proposalEnabled });
  }
  if (
    pluginConfig.proposalConfig &&
    typeof pluginConfig.proposalConfig === "object"
  ) {
    parts.push({
      proposalConfig:
        pluginConfig.proposalConfig as CoEngramPluginConfig["proposalConfig"],
    });
  }
  if (typeof pluginConfig.startViewer === "boolean") {
    parts.push({ startViewer: pluginConfig.startViewer });
  }
  if (
    pluginConfig.viewerConfig &&
    typeof pluginConfig.viewerConfig === "object"
  ) {
    parts.push({
      viewerConfig:
        pluginConfig.viewerConfig as CoEngramPluginConfig["viewerConfig"],
    });
  }
  return Object.assign({}, ...parts);
}

/**
 * 同步读取 team-memory 持久化配置(JSON)
 *
 * OpenClaw 1.8+ 要求 register() 必须同步,所以这里用 readFileSync 替代
 * core 包的 async readTeamMemoryConfig。失败/缺失时返回 undefined。
 */
function readTeamMemoryConfigSync(
  dataRoot: string,
): TeamMemoryConfig | undefined {
  const path = joinPath(dataRoot, ".co-engram", "config.json");
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TeamMemoryConfig;
    if (parsed && typeof parsed === "object" && parsed.version === 1)
      return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同步读取 prompt signals 缓存(JSON)
 */
function readPromptSignalsSync(
  dataRoot: string,
): PromptSignalSnapshot | undefined {
  const path = joinPath(dataRoot, ".co-engram", "prompt-signals.json");
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as PromptSignalSnapshot;
    if (parsed && typeof parsed === "object" && parsed.version === 1)
      return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同步解析配置语言
 */
function resolveConfigLanguageSync(
  userConfig: CoEngramPluginConfig,
): CoEngramPluginConfig {
  if (userConfig.language) return userConfig;
  const dataRoot =
    userConfig.dataRoot ?? `${process.env.HOME ?? "/tmp"}/team-memory`;
  const persisted = readTeamMemoryConfigSync(dataRoot);
  if (persisted?.language) {
    return { ...userConfig, language: resolveLanguage(undefined, persisted) };
  }
  return userConfig;
}

const entry = {
  id: "co-engram",
  name: "Co-Engram",
  description:
    "Team memory with neuroscience-inspired plasticity. Self-editing tools for engrams / synapses / skills.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        default: true,
        description: "Enable or disable Co-Engram tool registration.",
      },
      dataRoot: {
        type: "string",
        description:
          "Absolute path to the team-memory repository (default: $HOME/team-memory).",
      },
      defaultCreatedBy: {
        type: "string",
        description: "Default creator identifier when not specified on writes.",
      },
      language: {
        type: "string",
        enum: ["en", "zh"],
        default: "en",
        description:
          "Language for tool descriptions, viewer UI, and system prompts. Falls back to team-memory persisted config if unset.",
      },
      startMaintenance: {
        type: "boolean",
        default: true,
        description:
          "Start the auto-maintenance engine (light/deep/rem stages). On by default for low-friction onboarding.",
      },
      maintenanceConfig: {
        type: "object",
        additionalProperties: true,
        description:
          "Maintenance engine config (lightIntervalMs / deepIntervalMs / remIntervalMs / learningRate / enabledStages).",
      },
      auditEnabled: {
        type: "boolean",
        default: true,
        description: "Enable audit log (.co-engram/audit.jsonl).",
      },
      effectivenessEnabled: {
        type: "boolean",
        default: true,
        description:
          "Enable effectiveness tracking (retrieve_hit → effective/inconclusive).",
      },
      proposalEnabled: {
        type: "boolean",
        default: true,
        description:
          "Enable implicit memory proposal engine (on by default for low-friction onboarding).",
      },
      proposalConfig: {
        type: "object",
        additionalProperties: true,
        description:
          "Proposal engine config (threshold / similarityThreshold / maxSamples / defaultDismissDays / minMessageLength).",
      },
      startViewer: {
        type: "boolean",
        default: true,
        description:
          "Start the web viewer HTTP server (on by default for low-friction onboarding; configured port via viewerConfig.port).",
      },
      viewerConfig: {
        type: "object",
        additionalProperties: true,
        description:
          "Viewer config (port / token). Default port 18799 unless overridden by openclaw.json.",
      },
    },
  },
  register(
    api: CoEngramPluginHostApi & { pluginConfig?: Record<string, unknown> },
  ) {
    const baseConfig = readUserConfig(api.pluginConfig);
    // OpenClaw low-friction 默认:proposal/maintenance/viewer 默认全开,
    // 仅当用户显式传 false 时才关闭。参考 claude code mcp 的默认行为并对齐到
    // "常用功能开箱即用"。其他主机(MCP server 等)仍走 DEFAULT_CONFIG 保守默认。
    // 注意:openclaw 用 openclaw.plugin.json 的 configSchema 做默认值填充,
    // 那里也必须 default: true,否则会被填成 false 覆盖此处的 low-friction 默认。
    const openclawDefaults: CoEngramPluginConfig = {
      proposalEnabled: baseConfig.proposalEnabled !== false,
      startMaintenance: baseConfig.startMaintenance !== false,
      startViewer: baseConfig.startViewer !== false,
    };
    const mergedConfig: CoEngramPluginConfig = {
      ...openclawDefaults,
      ...baseConfig,
    };
    const userConfig = resolveConfigLanguageSync(mergedConfig);
    const dataRootForSignals =
      userConfig.dataRoot ?? `${process.env.HOME ?? "/tmp"}/team-memory`;
    const promptSignals = readPromptSignalsSync(dataRootForSignals);
    const ctx = registerCoEngramTools(api, {
      ...userConfig,
      ...(promptSignals ? { promptSignals } : {}),
    });
    if (userConfig.startViewer === true) {
      void startCoEngramViewer(ctx, userConfig);
    }
  },
};

export default entry;
