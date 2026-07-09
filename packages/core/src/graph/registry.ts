/**
 * Synapse 类型注册表（12 种，5 族）
 *
 * 定义所有 Synapse kind 的元数据：族、方向、label 等。
 *
 * @module @co-engram/core/graph
 */

import type {
  SynapseDirection,
  SynapseFamily,
  SynapseKind,
} from "../types/synapse.js";
import { internalError } from "../tools/error-schema.js";

/** Synapse kind 元数据 */
export interface SynapseKindMeta {
  readonly kind: SynapseKind;
  readonly family: SynapseFamily;
  readonly label: string;
  readonly description: string;
  readonly defaultDirection: SynapseDirection;
  readonly defaultWeight: number;
}

/** 全部 12 种 Synapse kind 元数据 */
export const SYNAPSE_KIND_REGISTRY: Record<SynapseKind, SynapseKindMeta> = {
  // 结构族
  extends: {
    kind: "extends",
    family: "structural",
    label: "扩展",
    description: "A 是 B 的扩展（B 是更一般的概念）",
    defaultDirection: "directional",
    defaultWeight: 0.7,
  },
  part_of: {
    kind: "part_of",
    family: "structural",
    label: "组成",
    description: "A 是 B 的一部分",
    defaultDirection: "directional",
    defaultWeight: 0.7,
  },
  similar_to: {
    kind: "similar_to",
    family: "structural",
    label: "相似",
    description: "A 与 B 相似（语义或结构）",
    defaultDirection: "bidirectional",
    defaultWeight: 0.6,
  },
  // 因果族
  depends_on: {
    kind: "depends_on",
    family: "causal",
    label: "依赖",
    description: "A 依赖 B（B 是 A 的前提）",
    defaultDirection: "directional",
    defaultWeight: 0.8,
  },
  causes: {
    kind: "causes",
    family: "causal",
    label: "导致",
    description: "A 导致 B",
    defaultDirection: "directional",
    defaultWeight: 0.8,
  },
  follows: {
    kind: "follows",
    family: "causal",
    label: "顺承",
    description: "A 之后发生 B（序列记忆）",
    defaultDirection: "directional",
    defaultWeight: 0.6,
  },
  // 证据族
  derives_from: {
    kind: "derives_from",
    family: "evidential",
    label: "溯源",
    description: "A 源自 B",
    defaultDirection: "directional",
    defaultWeight: 0.7,
  },
  contradicts: {
    kind: "contradicts",
    family: "evidential",
    label: "矛盾",
    description: "A 与 B 矛盾",
    defaultDirection: "bidirectional",
    defaultWeight: 0.9, // 矛盾默认高权重以突出
  },
  exemplifies: {
    kind: "exemplifies",
    family: "evidential",
    label: "例证",
    description: "A 是 B 的例证",
    defaultDirection: "directional",
    defaultWeight: 0.5,
  },
  // 时间族
  supersedes: {
    kind: "supersedes",
    family: "temporal",
    label: "替代",
    description: "A 替代 B（B 已过时）",
    defaultDirection: "directional",
    defaultWeight: 0.8,
  },
  consolidates: {
    kind: "consolidates",
    family: "temporal",
    label: "巩固",
    description: "A 是 B 的巩固结果",
    defaultDirection: "directional",
    defaultWeight: 0.7,
  },
  // 调节族
  contextualizes: {
    kind: "contextualizes",
    family: "modulatory",
    label: "情境",
    description: "A 情境化 B（A 提供 B 的上下文）",
    defaultDirection: "directional",
    defaultWeight: 0.5,
  },
};

/** 所有 Synapse kind 列表 */
export const ALL_SYNAPSE_KINDS = Object.keys(
  SYNAPSE_KIND_REGISTRY,
) as readonly SynapseKind[];

/** 所有 Synapse 族列表 */
export const ALL_SYNAPSE_FAMILIES: readonly SynapseFamily[] = [
  "structural",
  "causal",
  "evidential",
  "temporal",
  "modulatory",
];

/** 族对应的中文 label */
export const SYNAPSE_FAMILY_LABEL: Record<SynapseFamily, string> = {
  structural: "结构",
  causal: "因果",
  evidential: "证据",
  temporal: "时间",
  modulatory: "调节",
};

/**
 * 校验 kind 字符串是否合法
 */
export function isValidSynapseKind(kind: string): kind is SynapseKind {
  return kind in SYNAPSE_KIND_REGISTRY;
}

/**
 * 获取 kind 元数据
 */
export function getSynapseKindMeta(kind: SynapseKind): SynapseKindMeta {
  const meta = SYNAPSE_KIND_REGISTRY[kind];
  if (!meta) {
    throw internalError(`Unknown SynapseKind: ${kind}`);
  }
  return meta;
}

/**
 * 列出某族下所有 kind
 */
export function listKindsByFamily(
  family: SynapseFamily,
): readonly SynapseKind[] {
  return ALL_SYNAPSE_KINDS.filter(
    (k) => SYNAPSE_KIND_REGISTRY[k].family === family,
  );
}

/**
 * 判断两个 kind 是否同族
 */
export function areSameFamily(a: SynapseKind, b: SynapseKind): boolean {
  return SYNAPSE_KIND_REGISTRY[a].family === SYNAPSE_KIND_REGISTRY[b].family;
}
