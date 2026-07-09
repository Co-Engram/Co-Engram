/**
 * Engram 基础类型定义
 *
 * @module @co-engram/core/types
 */

/** Engram 唯一标识符（路径形式，如 testing/adb/android-14-wireless-adb） */
export type EngramId = string;

/** Synapse 唯一标识符 */
export type SynapseId = string;

/** Skill 唯一标识符 */
export type SkillId = string;

/** Intention 唯一标识符 */
export type IntentionId = string;

/** Scene 唯一标识符 */
export type SceneId = string;

/**
 * Engram kind 单标签
 *
 * 5 种基础类别，支持进化升级（observation → fact → pattern → procedure → hypothesis）
 */
export type EngramKind =
  | "observation" // 单次观察
  | "fact" // 事实（多次验证）
  | "pattern" // 模式（跨情境抽象）
  | "procedure" // 流程（陈述性）
  | "hypothesis"; // 假设（AI 独有，待验证）

/** Engram 多标签（允许一条记忆同时属于多个类别） */
export type EngramKinds = readonly EngramKind[];

/**
 * Engram 生命周期状态
 *
 * 2026-07 改名:`archived` → `frozen`。原因:旧名"归档"暗示"可能还会自己
 * 代谢或被遗忘",但代码实际行为是"完全冻结 —— 不衰退、不强化、不综合、
 * 不检索,数据完整保留可恢复,不会自动转 forgotten"。`frozen` 与代码实际
 * 行为精确一致,避免用户误解。
 *
 * 向后兼容:doctor 自动扫描 frontmatter,把旧的 `status: archived` 迁移为
 * `status: frozen`;旧数据升级后无差异。
 *
 * 神经科学依据:多级存储模型(海马 → 皮层 → 归档)
 */
export type EngramStatus =
  | "draft" // 草稿,未激活
  | "active" // 激活,正常检索
  | "frozen" // 冻结,不参与衰退/检索/强化(原 archived,2026-07 改名)
  | "forgotten"; // 遗忘,移出索引但 Git 保留

/**
 * Engram 新鲜度（系统计算，不可手动设置）
 *
 * 基于 lastEffectiveAt + 派生 halflife(由 importance 实时算) 计算
 */
export type EngramFreshness = "fresh" | "aging" | "stale" | "forgotten";

/**
 * 来源类型
 *
 * 默认 confidence：
 *   firsthand: 0.85
 *   secondhand: 0.65
 *   inferred: 0.50
 */
export type EngramSourceType = "firsthand" | "secondhand" | "inferred";

/**
 * 可见性（访问控制）
 *
 * - public: 全团队可见
 * - team: 特定团队可见
 * - private: 仅创建者可见
 * - restricted: 仅特定角色可见（如安全策略）
 */
export type EngramVisibility = "public" | "team" | "private" | "restricted";

/**
 * 认知模式（Scene Layer 1，神经科学固定的 5 种）
 */
export type CognitiveMode =
  | "exploration"
  | "execution"
  | "reflection"
  | "emergency"
  | "learning";

/**
 * Engram 验证状态
 *
 * 状态机：unverified → plausible → probable → verified → refuted
 */
export type VerificationStatus =
  | "unverified"
  | "plausible"
  | "probable"
  | "verified"
  | "refuted";

/**
 * Catalog Entry（Tier 0，最小开销）
 *
 * 用于检索结果列表的最小展示单元
 */
export interface EngramCatalogEntry {
  readonly id: EngramId;
  readonly title: string;
  readonly kind: EngramKind;
  readonly domainTags: readonly string[];
}

/**
 * Digest（Tier 1，再认）
 *
 * 用于检索结果展示，附加价值指标
 */
export interface EngramDigest extends EngramCatalogEntry {
  readonly summary: string;
  readonly importance: number;
  readonly freshness: EngramFreshness;
  readonly updatedAt: string;
  readonly contentSize: number;
}

/**
 * Engram 完整对象（Tier 2/3/4 的聚合视图）
 *
 * 实际存储拆为三个文件：content.md / meta.yaml / synapses.yaml
 * 本接口是读取后的合并视图
 */
export interface Engram {
  /* === 标识与定位 === */
  readonly id: EngramId;
  readonly title: string;
  readonly contentHash: string;
  readonly kind: EngramKind;
  readonly kinds: EngramKinds;
  readonly domainTags: readonly string[];

  /* === 内容 === */
  readonly content: string;
  readonly summary: string;
  readonly contentSize: number;

  /* === 编码情境（不可变） === */
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly encodingContext?: string;
  readonly version: number;

  /* === 价值评估 === */
  readonly importance: number;
  readonly confidence: number;
  readonly sourceType: EngramSourceType;
  readonly evidenceCount: number;

  /* === 三信号检索统计 === */
  readonly retrievalCount: number;
  readonly effectiveRetrievals: number;
  readonly failedUses: number;
  readonly lastRetrievedAt?: string;
  readonly lastEffectiveAt?: string;
  readonly reinforcementScore: number;
  /**
   * 最近一次检索时计算出的相关性分数 [0,1]（P4 自动维护用）。
   *
   * 作为 RPE 公式的"预期值"基准：actual_signal - lastRetrievalScore。
   * 老数据缺省为 0.5（中性）。
   */
  readonly lastRetrievalScore?: number;

  /* === 网络位置缓存 === */
  readonly outgoingSynapseCount: number;
  readonly incomingSynapseCount: number;
  readonly activeContradictionCount: number;

  /* === 生命周期与访问 === */
  readonly freshness: EngramFreshness;
  readonly status: EngramStatus;
  readonly contextTags: readonly string[];
  readonly visibility: EngramVisibility;

  /* === 高级元数据（P2/P3 才用） === */
  readonly verificationStatus?: VerificationStatus;
  /** 视角标识（spec §5.3 机制 3，多视角保留） */
  readonly perspective?: string;
}

/**
 * 创建 Engram 的输入参数（不包含系统计算字段）
 */
export interface EngramCreateInput {
  readonly title: string;
  readonly content: string;
  readonly summary?: string;
  readonly kind: EngramKind;
  readonly kinds?: readonly EngramKind[];
  readonly domainTags: readonly string[];
  readonly contextTags?: readonly string[];
  readonly encodingContext?: string;
  readonly createdBy: string;
  readonly sourceType?: EngramSourceType;
  readonly importance?: number;
  readonly confidence?: number;
  readonly visibility?: EngramVisibility;
  readonly perspective?: string;
}

/**
 * 更新 Engram 的输入参数（部分字段可变）
 */
export interface EngramUpdateInput {
  readonly title?: string;
  readonly content?: string;
  readonly summary?: string;
  readonly kinds?: readonly EngramKind[];
  readonly domainTags?: readonly string[];
  readonly contextTags?: readonly string[];
  readonly encodingContext?: string;
  readonly updatedBy: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly visibility?: EngramVisibility;
  readonly perspective?: string;
}
