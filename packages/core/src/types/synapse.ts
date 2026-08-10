/**
 * Synapse 类型定义
 *
 * 5 族 12 种连接类型，从神经科学严格推导，覆盖知识组织的核心维度。
 *
 * @module @co-engram/core/types
 */

import type { EngramId, EngramVisibility, SynapseId } from "./engram.js";

/**
 * Synapse kind（12 种，5 族）
 *
 * 中文 label 在 registry 中定义。
 *
 * 设计原则:12 种 kind 严格按神经科学 5 族推导,无兜底类型。
 * 历史数据中存在的 `related_to` 是 prompt 早期引导的产物,现已从工具描述中
 * 移除推荐;i18n 字典保留 `enum.synapseKind.related_to` / `tip.synapse.related_to`
 * 仅作前端显示兼容,不进入 schema/类型。
 */
export type SynapseKind =
  /* 结构族 */
  | "extends" // 扩展
  | "part_of" // 组成
  | "similar_to" // 相似
  /* 因果族 */
  | "depends_on" // 依赖
  | "causes" // 导致
  | "follows" // 顺承
  /* 证据族 */
  | "derives_from" // 溯源
  | "contradicts" // 矛盾
  | "exemplifies" // 例证
  /* 时间族 */
  | "supersedes" // 替代
  | "consolidates" // 巩固
  /* 调节族 */
  | "contextualizes"; // 情境

/** Synapse 5 族分类 */
export type SynapseFamily =
  | "structural"
  | "causal"
  | "evidential"
  | "temporal"
  | "modulatory";

/**
 * 对称 synapse kind 集合(「kind → 对称性」单一真相源)。
 *
 * 对称关系:A 与 B 的连接语义与方向无关,A↔B 与 B↔A 是同一事实。此类 kind
 * 的端点在 ID 计算时做 min/max 规范化,保证 (A,B) 与 (B,A) 生成同一 id
 * (幂等),并在检索层两端都计入 outgoing + incoming。
 *
 * 严格按关系语义推导:`similar_to`(相似)、`contradicts`(矛盾)天然对称;
 * 其余 10 种(extends / part_of / depends_on / causes / follows / derives_from
 * / exemplifies / supersedes / consolidates / contextualizes)天然有向——
 * 源/靶语义不可交换。
 *
 * 这是「kind → 对称性」的**唯一判断点**:ID 派生、检索分流、UI 呈现全部
 * 派生自 isSymmetricKind。历史的独立 `direction` 字段已移除,对称性回归
 * kind 的固有派生属性(此前 direction 与 kind 正交、可乱配,导致对称关系
 * 被误存为有向、有向关系被误存为双向两类语义错误)。
 */
export const SYMMETRIC_KINDS: ReadonlySet<SynapseKind> = new Set([
  "similar_to",
  "contradicts",
]);

/** kind 是否为对称关系(端点无方向语义)。派生自 SYMMETRIC_KINDS。 */
export function isSymmetricKind(kind: SynapseKind): boolean {
  return SYMMETRIC_KINDS.has(kind);
}

/**
 * Synapse 完整对象
 *
 * 存储在每个 engram 的 `synapses/{id}.yaml` 文件中（出边连接）
 */
export interface Synapse {
  readonly id: SynapseId;
  readonly from: EngramId;
  readonly to: EngramId;
  readonly kind: SynapseKind;

  /** 权重 [0.0, 1.0]，默认 0.5 */
  readonly weight: number;

  /** 证据数组（支持此连接的来源） */
  readonly evidence: readonly SynapseEvidence[];

  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;

  /** 语义标签（source/target 的语义快照） */
  readonly sourceSemantic?: string;
  readonly targetSemantic?: string;

  /** 裁决状态（仅 contradicts synapse 使用，spec §3.9） */
  readonly resolutionState?: SynapseResolutionState;

  /**
   * 可见性（继承自端点 engram,取两端最严）。
   *
   * 严格度排序:`private` > `restricted` > `team` > `public`。
   *
   * 取向:**保守策略**——只要有一端是 private,synapse 整条就按 private 处理。
   * 这是为了防止「private 端点的关联结构」通过 synapse 文件
   * `synapses/{kind}/{id}.yaml` 泄露到团队仓库。
   *
   * **注意**:synapse 文件落在 `synapses/` 目录(非 `private/`),即
   * 物理上仍会进团队仓库;此字段是**逻辑标记**,用于:
   * 1. 检索层根据 viewer/user 的权限过滤
   * 2. sync 层在 Phase 2 可决定是否把含 private 的 synapse 也加入隔离
   *
   * **保守策略**:端点 visibility 提升后,synapse 自身 visibility 字段**不自动
   * 更新**(可能比端点更严),Phase 1.5 可加 recomputeSynapseVisibility。
   */
  readonly visibility: EngramVisibility;
}

/** Synapse 证据 */
export interface SynapseEvidence {
  readonly description: string;
  readonly source?: string;
  readonly confidence?: number;
  readonly addedAt: string;
  readonly addedBy: string;
}

/**
 * Contradiction Resolution 状态（spec §3.9）
 *
 * 仅当 synapse.kind === 'contradicts' 时使用。
 * 三阶段流程：pending → auto_resolved / escalated → contested / resolved
 */
export type SynapseResolutionStatus =
  | "pending" // 检测到，未裁决
  | "auto_resolved" // 阶段 1：LLM 自动裁决
  | "escalated" // 阶段 2：升级归属人
  | "contested" // 阶段 3：超时未响应，附带警告
  | "resolved"; // 人工或自动最终解决

/** 裁决选项（spec §3.9 阶段 1） */
export type ContradictionVerdict =
  | "keep_new"
  | "keep_old"
  | "merge"
  | "archive";

/** Synapse 裁决状态（用于 contradicts synapse） */
export interface SynapseResolutionState {
  readonly status: SynapseResolutionStatus;
  /** 1=LLM 自动 / 2=升级归属人 / 3=超时降级 */
  readonly phase: 1 | 2 | 3;
  readonly verdict?: ContradictionVerdict;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly escalatedTo?: string;
  readonly escalatedAt?: string;
  /** 阶段 2 超时时间（ISO） */
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

/** 创建 Synapse 的输入参数 */
export interface SynapseCreateInput {
  readonly from: EngramId;
  readonly to: EngramId;
  readonly kind: SynapseKind;
  readonly weight?: number;
  readonly evidence?: readonly Omit<SynapseEvidence, "addedAt">[];
  readonly createdBy: string;
  readonly sourceSemantic?: string;
  readonly targetSemantic?: string;
}

/** 更新 Synapse 的输入(权重 / 类型 / 证据) */
export interface SynapseUpdateInput {
  readonly weight?: number;
  /** 变更类型(kind 变化会导致 synapse id 重新计算,内部走删除+重建) */
  readonly kind?: SynapseKind;
  readonly evidence?: readonly Omit<SynapseEvidence, "addedAt">[];
  readonly updatedBy: string;
}
