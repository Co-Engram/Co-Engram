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
  /** REM 深思联网能力开关(默认 off;当前无下游消费,保留配置位) */
  readonly webResearch?: boolean;
  /**
   * PDCA 修复 report 次数上限(Phase1;默认 INSIGHT_LIMITS.maxRepairRounds=6,
   * 引擎 clamp [1,10];业界基准 open-deep-research max_researcher_iterations)
   */
  readonly repairRounds?: number;
}

/** RemInsightConfig 的全字段解析默认值 */
export const DEFAULT_REM_INSIGHT: Readonly<Required<RemInsightConfig>> = {
  enabled: true,
  modesPerRun: 2,
  criticThreshold: 0.6,
  maxSubgraphNodes: 30,
  webResearch: false,
  repairRounds: 6,
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
 * - inFlightTtlMs:in-flight 锁过期时间(进程崩溃后自动回收)
 *
 * PDCA 修复回路(Phase1,2026-08-18;参数对齐业界基准,见 engram
 * 01M08950SRAHWPZ6FDZPAZR9EQ v6):
 * - maxRepairRounds:修复 report 次数上限(open-deep-research
 *   max_researcher_iterations 同源;宿主可经配置在 [1,10] 覆盖)
 * - maxNewGapsPerReport:单次 report 新增缺口上限,超出部分 deferred
 *   (不计闭合目标、只留痕)—— 防「报一堆新缺口拖延收束」
 * - maxTotalGapsPerRun:单 run 累计唯一缺口上限,触顶 → degraded 终束
 * - gapReopenEscalation:同哈希缺口连续重报次数阈值,达到 → 强制升级
 *   logic-needed(P3:重报 = 修复失败信号,不是无增量终束理由)
 */
export const INSIGHT_LIMITS: Readonly<{
  readonly maxProposalsPerRun: number;
  readonly jaccardDup: number;
  readonly dreamJaccard: number;
  readonly inFlightTtlMs: number;
  readonly maxRepairRounds: number;
  readonly maxNewGapsPerReport: number;
  readonly maxTotalGapsPerRun: number;
  readonly gapReopenEscalation: number;
}> = {
  maxProposalsPerRun: 5,
  jaccardDup: 0.65,
  dreamJaccard: 0.65,
  inFlightTtlMs: 30 * 60_000,
  maxRepairRounds: 6,
  maxNewGapsPerReport: 3,
  maxTotalGapsPerRun: 10,
  gapReopenEscalation: 2,
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

/**
 * 本轮资源使用申报(「依据」区数据源,2026-08-17 重设计):执行 agent 显式
 * 申报实际读取的记忆 / 使用的技能 / 读取的日志。engram id 走引用闭合校验
 * (不真实即拒)——依据不是 agent 的自我表述,而是过闸的可核验清单。
 */
/** 联网检索申报(受控联网线,2026-08-17):query=搜索词或 URL,purpose=回答了什么 */
export interface WebResourceUsed {
  readonly query: string;
  readonly purpose?: string;
}

export interface NightThinkingResourcesUsed {
  readonly engrams: readonly string[];
  readonly skills: readonly string[];
  readonly logs: readonly string[];
  readonly web?: readonly WebResourceUsed[];
}

// ============================================================
// PDCA 修复回路(Phase1,2026-08-18):清单自报、证据事实化
// Phase2(2026-08-18):计划先行 —— 清单生成权转移(引擎/critic 生成)
// ============================================================

/** 沉思资源类型(需求清单的归类维度;闭合可观测性按类型区分) */
export type PonderResourceType = "engrams" | "skills" | "logs" | "web" | "mcp";

/** 需求必要性:logic-needed(不闭合即缺口)/ helpful(可能有帮助) */
export type PonderNecessity = "logic-needed" | "helpful";

/**
 * 引擎生成的探测 payload(P1:生成权转移的核心)。
 * 探测词由引擎/critic 生成,执行者**逐字执行不得改写**(闭合核验按精确
 * 匹配);engrams 项强制 ≥2 个变体 —— 全部执行且全部空结果(引擎从调用
 * 流水的 outputSummary={hits:0} 亲证)→ 该需求自动豁免闭合。
 */
export interface PonderProbe {
  /** 探测查询词(engrams:engram_search 的 query;web:检索词,执行不可观测仅 payload 受控) */
  readonly query: string;
}

/** 计划项(需求拓扑节点;LLM 从问题结构生成,无 LLM 时模板兜底) */
export interface PonderPlanItem {
  /** 计划项 id(run 内稳定;report 需求经 planItemId 链接) */
  readonly id: string;
  readonly resourceType: PonderResourceType;
  readonly description: string;
  readonly necessity: PonderNecessity;
  /** 引擎生成的探测词(engrams ≥2 变体;logs/mcp 无探测) */
  readonly probes: readonly PonderProbe[];
  /** 跨轮接力来源:上轮 degraded 未闭合缺口机械带入(非 LLM 判断) */
  readonly carryOver?: boolean;
}

/** 一次深思 run 的思考计划(Phase2 计划先行:计划=执行拓扑,落盘可审视) */
export interface PonderPlan {
  /** plan 生成来源:llm(critic 从问题结构生成)/ template(无 llmClient 机械兜底) */
  readonly source: "llm" | "template";
  readonly generatedAt: string;
  readonly items: readonly PonderPlanItem[];
}

/**
 * 沉思需求清单条目(Phase1 折中:清单由执行者自报,闭合证据由引擎事实化)。
 *
 * - closed 的 engrams/skills 条目会被引擎用本次 run 的调用流水
 *   (signals.jsonl,时间窗 [thinkingAt, now])机械复核:evidence.ids
 *   里每个 id 必须真实出现在流水(retrievedEngramIds ∪ engram_get 的
 *   input.id / skill_get·skill_invoke 的 input.id),否则判假闭合缺口。
 * - logs/web/mcp 引擎无观测面(WebSearch/宿主 Skill/Read 不经 co-engram
 *   工具层),closed 仅作展示(unverified),不参与事实化闭合判定。
 * - 流水里有 engram/skill 读调用而清单未报对应条目 → 整单拒绝(瞒报拦截)。
 */
export interface PonderRequirement {
  readonly resourceType: PonderResourceType;
  /** 需求描述:这项资源为什么是本问题需要的(闭合目标声明) */
  readonly description: string;
  readonly necessity: PonderNecessity;
  /** 执行者自报闭合状态(引擎仅对可观测类型复核) */
  readonly closed: boolean;
  /** 事实锚点:真实调用过的 id(engrams=读过的 engram id;skills=skill id) */
  readonly evidence?: { readonly ids?: readonly string[] };
  /**
   * Phase2 计划先行:链接计划项(任务包 task.plan[].id)。有 planItemId 的
   * 条目是对计划项的闭合申报;necessity 以计划为准(降级无效,P5);缺失的
   * 计划项由引擎合成 open 缺口(删除=收窄被拦)。无 planItemId = 执行者
   * 追加项(受缺口预算约束)。
   */
  readonly planItemId?: string;
}

/** 引擎侧缺口记录(跨修复轮持久化;哈希 = 资源类型 + 归一化描述) */
export interface PonderGap {
  readonly hash: string;
  readonly resourceType: PonderResourceType;
  readonly description: string;
  /** 升级后可能高于自报(P3:连续重报强制升级 logic-needed) */
  readonly necessity: PonderNecessity;
  /** open=未闭合 / closed=已闭合(流水复核通过)/ deferred=超额不计闭合目标 */
  readonly state: "open" | "closed" | "deferred";
  /** 同哈希重报次数(修复失败信号;≥ gapReopenEscalation → 强制升级) */
  readonly reopens: number;
  /** 缺口成因:evidence-mismatch(自报闭合但流水无证据)/ unclosed(自报未闭合) */
  readonly reason?: "evidence-mismatch" | "unclosed" | "deferred-over-budget";
  /** 引擎不可观测类型的未闭合项(展示用,不阻塞终束) */
  readonly engineUnverified?: boolean;
  /** Phase2:缺口来源 —— plan(引擎承诺,不占执行者预算)/ executor(追加申报) */
  readonly origin?: "plan" | "executor";
  /** P1 自动豁免:全部引擎探测变体执行且皆空(引擎亲证)→ closed 附此标记 */
  readonly exempt?: "probe-empty";
}

/** 单次深思 run 的 PDCA 状态(acquireThinking 起、终束落定止;再思重置) */
export interface PonderRunState {
  readonly startedAt: string;
  /** 成功落盘的 report 次数(主报告计 1;0 = 主报告尚未成,timeline 未写) */
  readonly reports: number;
  /** 修复 report 次数(首次 report 不计) */
  readonly repairReports: number;
  /** 生命周期累计唯一缺口(含已闭合/deferred;预算分母) */
  readonly gaps: readonly PonderGap[];
  /** Phase2 计划先行:需求拓扑(buildTask 时生成落盘;report 按此核覆盖) */
  readonly plan?: PonderPlan;
}

/** 沉思任务包(core 只定义契约,不绑宿主;纯本地只读执行) */
export interface NightThinkingTask {
  readonly incubationId: string;
  readonly question: string;
  /** 种子摘要级内容(脱敏:不带记忆原文) */
  readonly seedDigests: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
  }>;
  /** 过往深思史(洞察摘要 + accept/dismiss 理由;再思时回灌防重复) */
  readonly dreamHistory: string;
  /** 本地日志/状态文件路径(存在的才列;L2 用已授权 Read 读取) */
  readonly resourceHints: readonly string[];
  /**
   * Phase2 计划先行:引擎生成的需求拓扑(critter 从问题结构生成,或无
   * llmClient 时的机械模板)。执行协议:逐项闭合;探测词逐字执行不得改写;
   * 可追加不可删除/降级(删除由引擎合成缺口拦截)。
   */
  readonly plan?: PonderPlan;
  /** 固化协议:盘点→plan→执行→按格式 report(不依赖 agent 自觉) */
  readonly protocol: string;
}

/**
 * 沉思回写(ponder_report 是唯一写回路径)。
 * answer 由执行现场生产(M1:agent 手握全部盘点上下文);缺省时 core 综合
 * 层兜底补写(L1 路径 / L2 未交)。
 */
export interface NightThinkingReport {
  readonly answer?: string;
  readonly insights: readonly InsightDraft[];
  readonly plan: readonly NightThinkingPlanStep[];
  readonly trace: readonly NightThinkingTraceStep[];
  readonly resourcesUsed?: NightThinkingResourcesUsed;
  /**
   * 需求清单(PDCA Phase1,L2 必填):本次深思判断需要的全部资源,逐条
   * 声明必要性/闭合状态/事实锚点。引擎用调用流水复核 closed 声明(假闭合
   * → 缺口)并交叉检查瞒报;有未闭合缺口时 report 被退回(gap list 随
   * 返回),修复后全量重报,直至闭合或预算触顶(degraded 终束)。
   */
  readonly requirements?: readonly PonderRequirement[];
}

/** L2 Agent 编排执行器契约(宿主提供 agent runtime;claude-code = headless spawn) */
export interface NightThinkingExecutor {
  execute(task: NightThinkingTask): Promise<NightThinkingReport>;
}
