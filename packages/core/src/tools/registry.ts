/**
 * 工具注册表
 *
 * 集中管理所有 Self-Editing Tools。
 * host adapter 调用 createToolRegistry() 获取所有工具，
 * 然后包装为各自的工具调用格式（MCP inputSchema / OpenClaw tool descriptor）。
 *
 * @module @co-engram/core/tools
 */

import type { Tool } from "./tool.js";
import { ALL_ENGRAM_TOOLS } from "./engram-tools.js";
import { ALL_SYNAPSE_TOOLS } from "./synapse-tools.js";
import { ALL_SKILL_TOOLS } from "./skill-tools.js";
import { ALL_PROPOSAL_TOOLS } from "./proposal-tools.js";
import { ALL_DOCTOR_TOOLS } from "./doctor-tools.js";
import { ALL_SYNTHESIZE_TOOLS } from "./synthesize-tools.js";
import { ALL_SYNC_TOOLS } from "./sync-tools.js";
import { ALL_INCUBATION_TOOLS } from "./incubation-tools.js";
import { engramAuditQueryTool } from "./audit-query-tool.js";

/**
 * 工具注册表
 */
export interface ToolRegistry {
  /** 按名查工具 */
  get(name: string): Tool | undefined;
  /** 列出所有工具 */
  list(): readonly Tool[];
  /** 按命名空间筛选（engram / synapse / skill / proposal） */
  listByNamespace(
    namespace: "engram" | "synapse" | "skill" | "proposal",
  ): readonly Tool[];
}

/**
 * 创建默认工具注册表（含所有 P0 工具）
 */
export function createToolRegistry(): ToolRegistry {
  const all: readonly Tool[] = [
    ...ALL_ENGRAM_TOOLS,
    ...ALL_SYNAPSE_TOOLS,
    ...ALL_SKILL_TOOLS,
    ...ALL_PROPOSAL_TOOLS,
    ...ALL_DOCTOR_TOOLS,
    ...ALL_SYNTHESIZE_TOOLS,
    ...ALL_SYNC_TOOLS,
    ...ALL_INCUBATION_TOOLS,
    engramAuditQueryTool,
  ];
  const map = new Map<string, Tool>(all.map((t) => [t.name, t]));

  return {
    get(name) {
      return map.get(name);
    },
    list() {
      return all;
    },
    listByNamespace(namespace) {
      return all.filter((t) => t.name.startsWith(`${namespace}_`));
    },
  };
}

/**
 * 默认 registry 单例（host 可直接 import）
 */
export const defaultRegistry: ToolRegistry = createToolRegistry();
