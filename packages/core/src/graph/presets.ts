/**
 * Graph View 八大场景预设（spec §12.7，P3 4.7.1）
 *
 * 把 spec 中描述的 8 个典型场景封装为 GraphFilter 工厂函数 + 预设表。
 * 宿主层可以直接查表应用，无需重复构造 filter。
 *
 * 8 个场景：
 *   1. knowledge_exploration：选定 engram + 1-2 阶邻居
 *   2. domain_overview：按 domain 过滤全部
 *   3. hub_identification：Top-N 高入度节点
 *   4. contradictions：只显示 contradicts
 *   5. orphans：孤立知识
 *   6. lineage：沿 derives_from/consolidates/supersedes 追溯
 *   7. contributor：按 createdBy 着色（filter 限制）
 *   8. temporal：时间轴 + freshness
 *
 * @module @co-engram/core/graph
 */

import type { EngramKind, EngramFreshness } from "../types/engram.js";
import type { SynapseKind } from "../types/synapse.js";
import type { GraphFilter } from "./snapshot.js";

/** 场景预设 ID（spec §12.7） */
export type ScenePresetId =
  | "knowledge_exploration"
  | "domain_overview"
  | "hub_identification"
  | "contradictions"
  | "orphans"
  | "lineage"
  | "contributor"
  | "temporal";

/** 血统 synapse kinds（与 lineage 模块一致） */
const LINEAGE_SYNAPSE_KINDS: readonly SynapseKind[] = [
  "derives_from",
  "consolidates",
  "supersedes",
];

// ============================================================
// 场景 1：knowledge_exploration
// ============================================================

export interface KnowledgeExplorationOptions {
  /** 起始 engramId（可选；若提供则只看这个 engram + 邻居） */
  readonly seedEngramId?: string;
  /** 邻居深度（默认 2） */
  readonly depth?: number;
  /** 最小 importance（默认 0.0 = 全部） */
  readonly minImportance?: number;
}

/**
 * 场景 1：知识探索
 *
 * 默认：显示所有 importance ≥ 0 的节点（即全部）。
 * seedEngramId 提供时由宿主层负责 BFS 邻居查询（spec §12.7 场景 1）。
 */
export function knowledgeExploration(
  options: KnowledgeExplorationOptions = {},
): GraphFilter {
  return {
    minImportance: options.minImportance ?? 0,
  };
}

// ============================================================
// 场景 2：domain_overview
// ============================================================

export interface DomainOverviewOptions {
  /** domain tag（至少匹配一个） */
  readonly domainTags: readonly string[];
  /** 限制 kind（可选） */
  readonly kinds?: readonly EngramKind[];
}

/**
 * 场景 2：领域全景
 *
 * 过滤 domain → 显示领域所有 engram，用于领域审计、识别 hub 节点。
 */
export function domainOverview(options: DomainOverviewOptions): GraphFilter {
  return {
    domainTags: options.domainTags,
    kinds: options.kinds,
  };
}

// ============================================================
// 场景 3：hub_identification
// ============================================================

export const DEFAULT_HUB_MIN_INCOMING = 10;

export interface HubIdentificationOptions {
  /** 最小入度（默认 10） */
  readonly minIncoming?: number;
}

/**
 * 场景 3：Hub 识别
 *
 * 注意：minIncoming 是动态派生字段，GraphFilter 没有直接对应字段。
 * 宿主层应在 buildGraphSnapshot 后用 nodes.filter(n => n.incomingCount >= N)
 * 做二次过滤。
 *
 * 这里返回的 filter 不做硬性节点过滤，只通过 stats 标识 isHub。
 */
export function hubIdentification(
  options: HubIdentificationOptions = {},
): GraphFilter & { readonly minIncoming: number } {
  const minIncoming = options.minIncoming ?? DEFAULT_HUB_MIN_INCOMING;
  return {
    minIncoming,
  };
}

// ============================================================
// 场景 4：contradictions（已有预设）
// ============================================================

/**
 * 场景 4：矛盾检测
 *
 * 只显示 contradicts 边 + 相关节点（preset 4.4 多视角保留）
 */
export function contradictions(): GraphFilter {
  return {
    contradictionsOnly: true,
  };
}

// ============================================================
// 场景 5：orphans（已有预设）
// ============================================================

/**
 * 场景 5：孤立知识发现
 *
 * 只显示无任何 synapse 连接的节点。
 */
export function orphans(): GraphFilter {
  return {
    orphansOnly: true,
  };
}

// ============================================================
// 场景 6：lineage（P3 4.6 + 4.7 集成）
// ============================================================

export interface LineageSceneOptions {
  /** 限制血统 synapse kind（默认全部三种） */
  readonly kinds?: readonly SynapseKind[];
  /** 隐藏 contradicts（默认 true） */
  readonly hideContradicts?: boolean;
}

/**
 * 场景 6：进化血统可视化
 *
 * 只保留血统边（derives_from/consolidates/supersedes）+ 相关节点。
 *
 * 注意：具体从哪个 engram 开始追溯由宿主层调用 lineage.getEvolutionLineage 决定。
 * 本 filter 应用于整个仓库时，展示所有血统关系。
 */
export function lineage(options: LineageSceneOptions = {}): GraphFilter {
  return {
    synapseKinds: options.kinds ?? LINEAGE_SYNAPSE_KINDS,
    hideContradicts: options.hideContradicts ?? true,
  };
}

// ============================================================
// 场景 7：contributor
// ============================================================

export interface ContributorOptions {
  /** 限定创建者（至少匹配一个） */
  readonly createdBy: readonly string[];
}

/**
 * 场景 7：贡献者视图
 *
 * 按 createdBy 过滤（UI 层负责按 createdBy 着色）
 */
export function contributor(options: ContributorOptions): GraphFilter {
  return {
    createdBy: options.createdBy,
  };
}

// ============================================================
// 场景 8：temporal
// ============================================================

export interface TemporalOptions {
  /** createdAt 起始（ISO） */
  readonly createdAfter?: string;
  /** createdAt 结束（ISO） */
  readonly createdBefore?: string;
  /** 限定 freshness（如 ['stale', 'aging']） */
  readonly freshness?: readonly EngramFreshness[];
}

/**
 * 场景 8：时效分析
 *
 * 时间范围 + freshness 过滤（UI 层负责时间轴布局）
 */
export function temporal(options: TemporalOptions = {}): GraphFilter {
  return {
    createdAfter: options.createdAfter,
    createdBefore: options.createdBefore,
    freshness: options.freshness,
  };
}

// ============================================================
// 预设表（spec §12.7 完整列表）
// ============================================================

export interface ScenePresetMeta {
  readonly id: ScenePresetId;
  readonly label: string;
  readonly description: string;
  readonly requiresInput: readonly string[];
}

export const SCENE_PRESETS: ReadonlyArray<ScenePresetMeta> = [
  {
    id: "knowledge_exploration",
    label: "知识探索",
    description: "选定 engram → 展开 1-2 阶邻居，发现关联知识",
    requiresInput: ["seedEngramId?"],
  },
  {
    id: "domain_overview",
    label: "领域全景",
    description: "过滤 domain → 显示领域所有 engram，用于领域审计、识别 hub",
    requiresInput: ["domainTags"],
  },
  {
    id: "hub_identification",
    label: "Hub 识别",
    description: "按 incomingSynapseCount 排序 Top-N，发现团队核心引用条目",
    requiresInput: [],
  },
  {
    id: "contradictions",
    label: "矛盾检测",
    description: "只显示 contradicts 边，触发 Contradiction Resolution",
    requiresInput: [],
  },
  {
    id: "orphans",
    label: "孤立知识发现",
    description: '过滤 orphans，发现"沉淀但未利用"的知识',
    requiresInput: [],
  },
  {
    id: "lineage",
    label: "进化血统",
    description: "沿 derives_from/consolidates/supersedes 追溯知识演化路径",
    requiresInput: ["seedEngramId?"],
  },
  {
    id: "contributor",
    label: "贡献者视图",
    description: "按 createdBy 过滤，分析团队知识贡献分布、识别 silo",
    requiresInput: ["createdBy"],
  },
  {
    id: "temporal",
    label: "时效分析",
    description: "时间轴 + freshness 颜色，发现过时知识集群、规划归档",
    requiresInput: ["createdAfter?", "createdBefore?"],
  },
];

/**
 * 按 ID 查找预设
 */
export function findScenePreset(
  id: ScenePresetId,
): ScenePresetMeta | undefined {
  return SCENE_PRESETS.find((p) => p.id === id);
}

/**
 * 列出所有预设 ID（稳定排序）
 */
export function listScenePresetIds(): readonly ScenePresetId[] {
  return SCENE_PRESETS.map((p) => p.id);
}
