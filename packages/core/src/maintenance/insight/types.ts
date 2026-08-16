/**
 * REM 深度思考(Deep Thought)类型定义 —— 七思维模式(一期:整合/复盘/灵感)× 夜思。
 *
 * 设计 spec:~/superpowers/specs/2026-08-15-rem-deep-thought-design.md(v2 冻结)。
 *
 * 认知科学依据的诚实分层(spec §二):扩散激活参数(衰减系数、跳数截止、子图
 * 上限、Jaccard 阈值、critic 阈值等)**全部是无来源初值**,冻结的只是"结构",
 * 不是"参数";上线前按 spec §九敏感性实验与人工盲评校准。
 *
 * @module @co-engram/core/maintenance/insight
 */

/** 一期思维模式(④批判/⑤元认知/⑥第一性原理/⑦溯因假设为二期) */
export type DeepThoughtMode = "integration" | "retrospective" | "inspiration";

/** 洞察产出类型(spec §三):synapse-suggestion 走 rem-synapse 既有路径,不在此列 */
export type InsightType = "theme" | "lesson" | "analogy" | "hypothesis";

/**
 * 笼统 domainTags:灵感模式域判定前过滤 —— imported/uncategorized 等标签
 * 不计为独立域,防脏标签库导致灵感模式恒假/恒真(spec §三 ③)。
 */
export const GENERIC_DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "imported",
  "uncategorized",
  "claude-code-auto-memory",
]);

/** maintenance.remInsight 配置(config 键 maintenance.remInsight.*) */
export interface RemInsightConfig {
  /**
   * 默认 true(2026-08-16 盲评校准后开启:真洞察率 84-95%,52 条人工判定
   * 46 真洞察/4 牵强/2 复述;兜底 = 每轮 ≤5 限流 + 机械校验 + 提案全审批)
   */
  readonly enabled?: boolean;
  /** 每轮 REM 按信号强度选 top-K 模式执行(默认 2,初值待校准) */
  readonly modesPerRun?: number;
  /** critic 综合分阈值,低于不出提案(默认 0.6,初值待盲评校准) */
  readonly criticThreshold?: number;
  /** 扩散激活子图节点上限(默认 30,初值待校准) */
  readonly maxSubgraphNodes?: number;
  /** 夜思联网能力默认 off(spec §四隐私硬约束;仅孵化条目显式 opt-in 才生效) */
  readonly webResearch?: boolean;
}

/** RemInsightConfig 的全字段解析默认值 */
export const DEFAULT_REM_INSIGHT: Readonly<Required<RemInsightConfig>> = {
  enabled: true,
  modesPerRun: 2,
  criticThreshold: 0.6,
  maxSubgraphNodes: 30,
  webResearch: false,
};

/**
 * 扩散激活参数(spec §三):全部为无文献来源的工程初值,实施时按 §九校准。
 * 归一化后加权(w1/w2),一跳/二跳衰减系数,激活低于 minActivation 不入子图。
 */
export const SPREAD_PARAMS: Readonly<{
  readonly w1: number;
  readonly w2: number;
  readonly hop1Decay: number;
  readonly hop2Decay: number;
  readonly minActivation: number;
}> = {
  w1: 0.5,
  w2: 0.5,
  hop1Decay: 0.5,
  hop2Decay: 0.25,
  minActivation: 0.1,
};

/**
 * 洞察/夜思硬限制(初值待校准):
 * - maxProposalsPerRun:每轮 REM rem-insight 提案硬上限(防提案页淹没;synapse-suggestion 走 rem-synapse 不占额度)
 * - jaccardDup:与已有 pattern/insight 的内容查重阈值(≥ 即丢弃)
 * - dreamJaccard:夜思回灌循环检测阈值(新洞察与历史 ≥ 即本轮作废)
 * - maxRoundsDefault:夜思每条目默认轮数上限(无 accept 到限 → paused + 提示用户裁决)
 * - inFlightTtlMs:in-flight 锁过期时间(进程崩溃后自动回收)
 */
export const INSIGHT_LIMITS: Readonly<{
  readonly maxProposalsPerRun: number;
  readonly jaccardDup: number;
  readonly dreamJaccard: number;
  readonly maxRoundsDefault: number;
  readonly inFlightTtlMs: number;
}> = {
  maxProposalsPerRun: 5,
  jaccardDup: 0.65,
  dreamJaccard: 0.65,
  maxRoundsDefault: 5,
  inFlightTtlMs: 30 * 60_000,
};

/**
 * 窗口活动事件权重(2026-08-16 第二刀:审计日志进 REM 输入)。
 * audit action → 权重;external-edit(update + metadata.source)取 EXTERNAL_EDIT_WEIGHT。
 * 不进白名单:create(新编码已是种子)、propose/dismiss(非 engram 活动)、
 * merge_*、forget、purge 等生命周期、skill_*、maintenance_run。
 */
export const ACTIVITY_EVENT_WEIGHTS: Readonly<Record<string, number>> = {
  reinforce: 1.5,
  accept: 1.5,
  importance_update: 1.0,
  report_failure: 1.0,
  contradicted: 1.0,
  update: 1.0,
  learning_loop_success: 1.0,
  learning_loop_partial: 1.0,
  learning_loop_failure: 1.0,
};

/** external-edit(用户手动编辑 .md,内容级 hash 判定)= 最强意图信号 */
export const EXTERNAL_EDIT_WEIGHT = 2.0;

/** 活动分数半饱和点:窗口内 3 次活动 ≈ 0.5(与模式信号 saturate 一致) */
export const ACTIVITY_SATURATION_K = 3;

/** REM 检索快照(.co-engram/rem-state.json):下轮 diff 得窗口检索增量 */
export interface RemRetrievalSnapshot {
  readonly writtenAt: string;
  readonly retrievalCounts: Readonly<Record<string, number>>;
}

/** 模式强度长期校准(被 accept 洞察的模式分布,全历史维度) */
export interface ModeCalibration {
  /** 乘性因子,clamp [MODE_CALIBRATION.floor, ceiling];冷启动 = 1 */
  readonly factor: number;
  /** 样本量(accepted + dismissed);< minSamples 时 factor = 1 */
  readonly samples: number;
  readonly acceptRate: number;
}

/**
 * 校准参数(无文献初值,§九校准预留)。acceptRate=0.5 为中性点
 * (factor=1)要求 ceiling = 2 - floor,调整常量时保持该关系。
 */
export const MODE_CALIBRATION: Readonly<{
  readonly minSamples: number;
  readonly floor: number;
  readonly ceiling: number;
}> = {
  minSamples: 5,
  floor: 0.7,
  ceiling: 1.3,
};

/** 每日排程时刻格式(锚点调度用);m[1]=时、m[2]=分(anchorOn 解析用) */
export const SCHEDULE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** verificationStatus → 真值因子(activation 计算用;refuted = 0) */
export const TRUTH_FACTOR: Readonly<Record<string, number>> = {
  verified: 1.0,
  probable: 0.8,
  plausible: 0.6,
  unverified: 0.4,
  refuted: 0,
};

/** 单模式触发信号(事件驱动,非盲扫) */
export interface ModeSignal {
  readonly mode: DeepThoughtMode;
  /** 归一化强度 [0,1],按强度 top-K 调度 */
  readonly strength: number;
  /** 信号构成明细(计数等,供 report/审计) */
  readonly detail: Readonly<Record<string, number | string>>;
}

/** 扩散激活子图节点(节点 digest + 活动记录,spec §三「输入」) */
export interface SubgraphNode {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly domainTags: readonly string[];
  readonly kind: string;
  readonly importance: number;
  readonly confidence: number;
  readonly verificationStatus: string | null;
  readonly retrievalCount: number;
  readonly failedUses: number;
  readonly reinforcementScore: number;
  readonly freshness: string;
  readonly isSeed: boolean;
  /** 归一化后的激活值(种子)或扩散激活值(邻居) */
  readonly activation: number;
}

/** 子图内部边(kind/weight/evidence 数 + 本轮新增标记) */
export interface SubgraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly weight: number;
  readonly isNew: boolean;
}

/** 记忆网络切片 + 全局统计(LLM 看到的输入) */
export interface InsightSubgraph {
  readonly nodes: readonly SubgraphNode[];
  readonly edges: readonly SubgraphEdge[];
  /** topTags / 真值分布 / 种子数等预计算统计 */
  readonly globalStats: Readonly<Record<string, number | string>>;
}

/** 洞察草稿(LLM 产出 → 机械校验 + critic → 提案) */
export interface InsightDraft {
  readonly mode: DeepThoughtMode;
  readonly type: InsightType;
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly domainTags: readonly string[];
  readonly reason: string;
  /** 复盘(lesson)四要素:预期→实际→原因→下次怎么改(AAR 骨架) */
  readonly aar?: {
    readonly expected: string;
    readonly actual: string;
    readonly cause: string;
    readonly improvement: string;
  };
}

/** critic 四维评分(独立第二次 LLM 调用;overall 为机器主观初值,非客观真值) */
export interface CriticScore {
  readonly overall: number;
  readonly evidenceSufficiency: number;
  readonly novelty: number;
  readonly actionability: number;
  readonly consistency: number;
  readonly rationale: string;
}

/** 夜思 L2 agent 会话的 PLAN 步骤 */
export interface NightThinkingPlanStep {
  readonly step: string;
  readonly capability: string;
}

/** 夜思 L2 agent 会话的执行轨迹(过程透明是信任来源,spec §六) */
export interface NightThinkingTraceStep {
  readonly step: string;
  readonly action: string;
  readonly detail: string;
}

/** 夜思 L2 外部调用申报(联网/外部 LLM;写审计日志,viewer 可查) */
export interface NightThinkingExternalCall {
  readonly tool: string;
  readonly purpose: string;
  readonly at: string;
}

/** 夜思任务包(core 只定义契约,不绑宿主;spec §七) */
export interface NightThinkingTask {
  readonly incubationId: string;
  readonly question: string;
  /** 种子摘要级内容(脱敏:不带记忆原文,spec §四隐私边界) */
  readonly seedDigests: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
  }>;
  /** 完整梦境史(过往洞察摘要 + accept/dismiss 理由,回灌迭代) */
  readonly dreamHistory: string;
  /** 按条目 opt-in 的联网开关(默认 off) */
  readonly webResearchOptIn: boolean;
  /** 固化协议:盘点→plan→执行→按格式 report(不依赖 agent 自觉) */
  readonly protocol: string;
}

/** 夜思回写(incubation_report 是唯一写回路径) */
export interface NightThinkingReport {
  readonly insights: readonly InsightDraft[];
  readonly plan: readonly NightThinkingPlanStep[];
  readonly trace: readonly NightThinkingTraceStep[];
  readonly externalCalls: readonly NightThinkingExternalCall[];
}

/** L2 Agent 编排执行器契约(宿主提供 agent runtime;claude-code = headless spawn) */
export interface NightThinkingExecutor {
  execute(task: NightThinkingTask): Promise<NightThinkingReport>;
}
