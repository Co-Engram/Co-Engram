/**
 * 概念字典类型定义
 *
 * co-engram 引入大量神经科学概念(engram / synapse / LTP / LTD / Hebbian / RPE /
 * verification state machine / observation window / multi-dim importance 等)。
 * 元3「神经科学墙」的核心症状是:这些概念对挑剔用户完全不可见,规则藏在源码里。
 *
 * CONCEPT_DICTIONARY 是这些概念的单一真相源,所有面向用户的 surface
 * (viewer help tab / mcp instructions / prompt-builder / 工具描述)都必须引用它,
 * 不允许在别处重新定义。
 *
 * @module @co-engram/core/concepts
 */

/**
 * 概念 ID(全部小写下划线,稳定标识)
 *
 * 添加新概念时:
 *   1. 在此 union 加 id
 *   2. 在 dictionary.ts 填 ConceptEntry(必填 zh / en / userExplanation)
 *   3. 若有内部规则,补 internalRule(人类可读描述,引用真实默认值)
 *   4. 通过 `satisfies Readonly<Record<ConceptId, ConceptEntry>>` 让编译器强制全覆盖
 */
export type ConceptId =
  | "engram"
  | "synapse"
  | "ltp"
  | "ltd"
  | "hebbian"
  | "rpe"
  | "verification_status"
  | "observation_window"
  | "importance"
  | "decay"
  | "provenance"
  | "domain_tag"
  | "context_tag"
  | "kind";

/**
 * 概念字典条目
 *
 * 设计原则:
 *   - zh / en 是内部术语(可保留专业用词,允许"LTP"、"Hebbian"等缩写)
 *   - userExplanation 是面向挑剔用户的解释(避免术语堆砌,讲清楚是什么、为什么有用)
 *   - internalRule 引用真实源码默认值(不写"约 0.02",写"0.02"),便于用户验证
 *   - refs 把相关概念串起来,viewer help tab 可据此渲染图
 */
export interface ConceptEntry {
  /** 稳定 id(等于 CONCEPT_DICTIONARY 里的 key) */
  readonly id: ConceptId;
  /** 内部中文术语(可保留专业缩写) */
  readonly zh: string;
  /** 内部英文术语 */
  readonly en: string;
  /** 用户层解释 */
  readonly userExplanation: {
    /** 中文用户解释(挑剔用户能懂,不堆砌术语) */
    readonly zh: string;
    /** 英文用户解释 */
    readonly en: string;
  };
  /** 内部规则(引用真实默认值,如"每次 effective 检索 importance += 0.02") */
  readonly internalRule?: {
    /** 中文规则描述 */
    readonly zh: string;
    /** 英文规则描述 */
    readonly en: string;
  };
  /** 相关概念 id 列表(用于 viewer help 渲染关系图) */
  readonly refs?: readonly ConceptId[];
}

/**
 * 重要性 / 强化分数的可读分级
 *
 * 用于把 [0,1] 区间的浮点(importance / reinforcementScore / lastRetrievalScore /
 * FTS score)映射为"高/中/低"用户可读形式,防止浮点精度泄露
 * (如 0.018000000000000002 直接 dump 给用户)。
 */
export type ScoreBand = "high" | "medium" | "low";
