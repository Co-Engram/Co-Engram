/**
 * CONCEPT_DICTIONARY —— 概念字典单一真相源
 *
 * 所有用户可见 surface(viewer help tab、mcp instructions、prompt-builder、工具描述)
 * 引用此处的概念解释,而不是各自维护一份(否则会出现概念漂移,见 fix-2 的
 * help-contract 抓到的 synapse/proposal 漂移)。
 *
 * 默认值必须与源码一致:
 *   - ReinforcementConfig.DEFAULT_CONFIG(hebbianRatio=0.5 等,D1 之后单次增量由 dynamics.ts 决定)
 *   - DEFAULT_EFFECTIVENESS_WINDOWS(observation=6h 等)
 *   - DEFAULT_VERIFICATION_CONFIG(minEvidenceForPlausible=1 等)
 *   - DEFAULT_WEIGHTS(alpha=0.5 等)
 *
 * 修改默认值时,改源码同时改这里 —— fix-3 的运行时 FORBIDDEN_TERMS 校验 + fix-5 的
 * 默认值审计会捕获不一致。
 *
 * @module @co-engram/core/concepts
 */

import type { ConceptEntry, ConceptId, ScoreBand } from "./types.js";

/**
 * 概念字典本体
 *
 * `satisfies Readonly<Record<ConceptId, ConceptEntry>>` 强制每个 ConceptId 都有 entry,
 * 添加新 id 但忘了填字典会编译失败。
 */
export const CONCEPT_DICTIONARY = {
  engram: {
    id: "engram",
    zh: "记忆印迹",
    en: "engram",
    userExplanation: {
      zh: "一条被持久化的团队记忆。每条记忆有标题、内容、领域标签,以及随使用强度变化的『重要性』分数。一条记忆可以被多次检索、强化或反驳,状态会随使用反馈演化。",
      en: 'A persistent team memory entry with a title, content, domain tags, and an "importance" score that evolves with use. Each memory can be retrieved, reinforced, or refuted multiple times — its state evolves with feedback.',
    },
    internalRule: {
      zh: "存储为 markdown + frontmatter,文件路径默认 {domainTags}/{slug}.md。5 种 kind:observation / fact / pattern / procedure / hypothesis。",
      en: "Stored as markdown + frontmatter, default path {domainTags}/{slug}.md. 5 kinds: observation / fact / pattern / procedure / hypothesis.",
    },
    refs: ["synapse", "importance", "kind", "domain_tag"],
  },

  synapse: {
    id: "synapse",
    zh: "记忆突触",
    en: "synapse",
    userExplanation: {
      zh: "两条记忆印迹之间的有类型连接(类似大脑里神经元之间的突触)。常见类型:extends(扩展)、derives_from(派生/证据)、contradicts(矛盾)、related_to(关联)。突触让记忆从孤立条目变成知识图谱。",
      en: "A typed connection between two engrams (like synapses between neurons). Common kinds: extends, derives_from (evidence), contradicts, related_to. Synapses turn isolated entries into a knowledge graph.",
    },
    internalRule: {
      zh: 'kind="contradicts" 时,自动给双方 engram 写 contradicted audit 事件(可被 engram_audit_query 查到),触发矛盾解决流程。',
      en: 'When kind="contradicts", automatically writes contradicted audit events to both engrams (queryable via engram_audit_query), triggering the contradiction resolution flow.',
    },
    refs: ["engram", "verification_status"],
  },

  ltp: {
    id: "ltp",
    zh: "长时程增强(LTP)",
    en: "Long-Term Potentiation (LTP)",
    userExplanation: {
      zh: "记忆被有效使用时,重要性上升的机制。每次『有效检索』(用户真的用到这条记忆解决了任务)给这条记忆的重要性 +0.1(默认,D1 dynamics)。这是大脑里『一起激活的神经元连接增强』(Hebbian)的简化模型。",
      en: 'The mechanism by which a memory\'s importance rises on effective use. Each "effective retrieval" (the user actually applied the memory to solve a task) adds +0.1 (default, D1 dynamics) to its importance. This is a simplified model of Hebbian learning ("neurons that fire together wire together").',
    },
    internalRule: {
      zh: "每次 effective=1 检索,importance = dynamics.updateOnReinforce(current, effectiveness)(默认 +0.1)。约 5 次有效检索能把 0.5 提升到 1.0。",
      en: "Per effective=1 retrieval, importance = dynamics.updateOnReinforce(current, effectiveness) (default +0.1). ~5 effective retrievals raise 0.5 to 1.0.",
    },
    refs: ["importance", "observation_window", "hebbian"],
  },

  ltd: {
    id: "ltd",
    zh: "长时程削弱(LTD)",
    en: "Long-Term Depression (LTD)",
    userExplanation: {
      zh: "记忆被错误使用时,重要性下降的机制。每次『失败使用』(用户反馈说这条记忆错了/过时)给重要性 -0.1(默认,D1 dynamics)。失败惩罚与成功增益对等,D1 之后删除了 escalation 倍率。",
      en: 'The mechanism by which a memory\'s importance falls on failed use. Each "failed use" (user reports the memory was wrong or stale) subtracts 0.1 (default, D1 dynamics) from importance. D1 removed the previous cumulative-failure escalation multiplier.',
    },
    internalRule: {
      zh: "每次 failedUse,importance = dynamics.updateOnReportFailure(current)(默认 -0.1,固定)。failedUses ≥ archiveThreshold(默认 3)建议 archive,≥ forgetThreshold(默认 5)建议 forget。",
      en: "Per failedUse, importance = dynamics.updateOnReportFailure(current) (default -0.1, fixed). failedUses ≥ archiveThreshold (default 3) suggests archive; ≥ forgetThreshold (default 5) suggests forget.",
    },
    refs: ["ltp", "importance", "observation_window"],
  },

  hebbian: {
    id: "hebbian",
    zh: "Hebbian 原则",
    en: "Hebbian principle",
    userExplanation: {
      zh: "『一起激活的神经元连接增强』。在 co-engram 里:强化一条记忆时,与它直接相连(通过突触)的邻居记忆也会得到一部分增益(默认一半,即 0.5 倍),让相关知识一起被记住。",
      en: '"Neurons that fire together wire together." In co-engram: when a memory is reinforced, its direct neighbors (via synapses) also gain a fraction of the boost (default half, i.e. 0.5x) — so related knowledge gets remembered together.',
    },
    internalRule: {
      zh: "邻居强化系数 = hebbianRatio(默认 0.5)。直接邻居得到与源 engram 同等 importance 增益 × hebbianRatio 的 importance 增益。",
      en: "Neighbor reinforcement ratio = hebbianRatio (default 0.5). Direct neighbors gain the source's importanceDelta × hebbianRatio.",
    },
    refs: ["ltp", "synapse", "importance"],
  },

  rpe: {
    id: "rpe",
    zh: "奖励预测误差(RPE)",
    en: "Reward Prediction Error (RPE)",
    userExplanation: {
      zh: "实际价值超出预期的程度。在大脑里,阳性 RPE(比预期好)会触发多巴胺释放,加强相关记忆。co-engram 借用这个概念驱动『候选审批』—— 系统观察到的、超出阈值的新模式会被提名为候选记忆,等用户确认后转为正式记忆。",
      en: "The gap between actual and expected value. In the brain, positive RPE (better than expected) triggers dopamine release and strengthens associated memories. co-engram borrows this for proposal capture — observed patterns exceeding a threshold are nominated as candidate memories awaiting user approval.",
    },
    internalRule: {
      zh: 'necessity-evaluator 通过 LLM 或规则评估『这条消息是否值得捕获』,必要度超阈值才进入 proposal 队列。',
      en: 'The necessity-evaluator (LLM or rule-based) assesses "is this message worth capturing"; only those above the threshold enter the proposal queue.',
    },
    refs: ["engram", "importance"],
  },

  verification_status: {
    id: "verification_status",
    zh: "验证状态",
    en: "verification status",
    userExplanation: {
      zh: "记忆可信度的 5 档状态:未验证 → 似合理 → 较可能 → 已验证 → 已反驳。状态随使用反馈(强化 / 失败 / 跨情境证据)演化。已反驳状态会阻止这条记忆再次被检索命中。",
      en: "5-level memory credibility: unverified → plausible → probable → verified → refuted. Evolves with use feedback (reinforcement / failure / cross-context evidence). Refuted memories are excluded from retrieval.",
    },
    internalRule: {
      zh: "升级条件(默认):似合理需 ≥1 evidence;较可能需 ≥2 evidence 且 ≥2 个不同 domainTags;已验证需 ≥3 evidence、≥2 domains 且创建满 7 天。降级由 LTD/失败驱动。",
      en: "Default upgrade thresholds: plausible ≥1 evidence; probable ≥2 evidence AND ≥2 distinct domainTags; verified ≥3 evidence, ≥2 domains, AND 7 days since creation. Downgrade driven by LTD/failures.",
    },
    refs: ["observation_window", "provenance", "synapse"],
  },

  observation_window: {
    id: "observation_window",
    zh: "观察窗口",
    en: "observation window",
    userExplanation: {
      zh: "记忆被检索命中后开启的一段观察期。窗口期内:用户若回来强化这条记忆 → 记为『有效检索』,触发 LTP;用户若反馈失败 → 记为『失败使用』,触发 LTD;窗口过期 → 关闭,本次命中不计入有效性。窗口长度按 kind 不同:观察类 6 小时、事实/模式/流程类 1-2 天、假设类 7 天。",
      en: 'An observation period opened when a memory is retrieved. During the window: if the user returns to reinforce the memory → counted as "effective retrieval" (triggers LTP); if the user reports a failure → counted as "failed use" (triggers LTD); if the window expires → closed, this hit does not count. Length depends on kind: observation 6h, fact/pattern/procedure 1-2d, hypothesis 7d.',
    },
    internalRule: {
      zh: "默认窗口长度:observation=6h,fact=24h,pattern=48h,procedure=48h,hypothesis=7d。多 kind engram 取最长。",
      en: "Default window lengths: observation=6h, fact=24h, pattern=48h, procedure=48h, hypothesis=7d. Multi-kind engrams use the maximum.",
    },
    refs: ["ltp", "ltd", "kind"],
  },

  importance: {
    id: "importance",
    zh: "重要性",
    en: "importance",
    userExplanation: {
      zh: "记忆的优先级分数,取值 [0,1]。检索结果按相关性 + 时效性 + 重要性三因子加权打分排序。重要性会随 LTP 上升、LTD 下降,所以常用且有效的记忆会自然浮上来。",
      en: "Memory priority score in [0,1]. Retrieval results are ranked by a weighted three-factor score: relevance + recency + importance. Importance rises with LTP and falls with LTD, so frequently-effective memories naturally surface.",
    },
    internalRule: {
      zh: "三因子权重(默认):relevance α=0.5,recency β=0.3,importance γ=0.2。effectiveImportance = importance × (1 + reinforcementScore),截断到 [0,1]。",
      en: "Default three-factor weights: relevance α=0.5, recency β=0.3, importance γ=0.2. effectiveImportance = importance × (1 + reinforcementScore), clamped to [0,1].",
    },
    refs: ["ltp", "ltd", "decay"],
  },

  decay: {
    id: "decay",
    zh: "艾宾浩斯衰退",
    en: "Ebbinghaus decay",
    userExplanation: {
      zh: "记忆随时间淡化。检索打分里 recency 因子按艾宾浩斯遗忘曲线衰退:每过一个半衰期,recency 减半。半衰期从 importance 派生(重要记忆衰退慢),公式 halflife = BASE × (importance + 0.1) ^ 2.5。",
      en: 'Memories fade over time. The "recency" retrieval factor follows the Ebbinghaus forgetting curve: each half-life halves the recency. The half-life is derived from importance (important memories decay slower): halflife = BASE × (importance + 0.1) ^ 2.5.',
    },
    internalRule: {
      zh: "recency = 0.5^(ageDays / deriveHalfLifeDays(importance))。ageDays ≤ 0 时 recency = 1(不衰退)。",
      en: "recency = 0.5^(ageDays / deriveHalfLifeDays(importance)). When ageDays ≤ 0, recency = 1 (no decay).",
    },
    refs: ["importance"],
  },

  provenance: {
    id: "provenance",
    zh: "溯源",
    en: "provenance",
    userExplanation: {
      zh: "每条记忆的来源信息:谁创建、何时创建、sourceType(firsthand / secondhand / inferred)。验收高可信结论前,应通过溯源信息判断原始证据是否可靠。",
      en: "Each memory carries its origin: who created it, when, and sourceType (firsthand / secondhand / inferred). Before relying on a high-confidence conclusion, check provenance to judge if the underlying evidence is trustworthy.",
    },
    refs: ["engram", "verification_status"],
  },

  domain_tag: {
    id: "domain_tag",
    zh: "领域标签",
    en: "domain tag",
    userExplanation: {
      zh: "记忆的主题分类(如 testing、android、backend)。用于检索过滤、跨情境证据聚合(verification 升级条件需要 ≥2 个不同 domainTags)、目录组织。一条记忆可有多个领域标签。",
      en: "Memory topic (e.g. testing, android, backend). Used for retrieval filtering, cross-context evidence aggregation (verification upgrade requires ≥2 distinct domainTags), and directory layout. A memory can have multiple domain tags.",
    },
    refs: ["engram", "context_tag", "verification_status"],
  },

  context_tag: {
    id: "context_tag",
    zh: "情境标签",
    en: "context tag",
    userExplanation: {
      zh: "比领域标签更细粒度的使用情境(如 session-id、子项目名)。用于跨情境证据聚合 —— 同样的结论在不同情境被独立验证,可信度才更高。",
      en: "Finer-grained use context than domain tags (e.g. session-id, sub-project). Used for cross-context evidence aggregation — the same conclusion independently verified across different contexts yields higher credibility.",
    },
    refs: ["domain_tag", "verification_status"],
  },

  kind: {
    id: "kind",
    zh: "类别",
    en: "kind",
    userExplanation: {
      zh: "记忆的 5 种基础类别:观察(单次所见)、事实(多次验证)、模式(跨情境抽象)、流程(陈述性步骤)、假设(AI 推断、待验证)。类别决定观察窗口长度、检索权重等行为。",
      en: "5 base kinds: observation (single sighting), fact (verified multiple times), pattern (cross-context abstraction), procedure (declarative steps), hypothesis (AI-inferred, to be verified). The kind drives observation-window length, retrieval weights, and other behaviors.",
    },
    internalRule: {
      zh: "observation 窗口 6h;fact 24h;pattern/procedure 48h;hypothesis 7d。多 kind 取 max。",
      en: "observation window 6h; fact 24h; pattern/procedure 48h; hypothesis 7d. Multi-kind uses max.",
    },
    refs: ["engram", "observation_window", "domain_tag"],
  },
} as const satisfies Readonly<Record<ConceptId, ConceptEntry>>;

/**
 * 取概念条目(便于从 id 安全访问)
 *
 * 直接 `CONCEPT_DICTIONARY[id]` 也行;此函数主要给宿主代码显式标注返回类型。
 */
export function getConcept(id: ConceptId): ConceptEntry {
  return CONCEPT_DICTIONARY[id];
}

/**
 * 把 [0,1] 浮点分数格式化为人类可读的『高/中/低(数值)』
 *
 * 用于所有用户可见的数值字段(importance / reinforcementScore / lastRetrievalScore /
 * FTS score / effectiveness),防止浮点精度泄露(如 0.018000000000000002、
 * 0.7719155626908514 直接 dump 给用户)。
 *
 * 阈值:≥0.7 高;≥0.3 中;<0.3 低。2 位小数保留可读精度。
 *
 * JSON-RPC 协议层(raw)与文本呈现层(band+display)并存,见 Task 1.3。
 */
export function formatScore(score: number, lang: "zh" | "en"): string {
  const band: ScoreBand =
    score >= 0.7 ? "high" : score >= 0.3 ? "medium" : "low";
  const labels = {
    zh: { high: "高", medium: "中", low: "低" },
    en: { high: "high", medium: "medium", low: "low" },
  } as const;
  return `${labels[lang][band]}(${score.toFixed(2)})`;
}

/**
 * 工具返回结果里的结构化分数字段
 *
 * `raw` 是 2 位小数(rounded),保证 JSON 序列化不会泄露浮点噪声
 * (如 0.018000000000000002 / 0.7719155626908514)。
 *
 * `band` 是语言中立的等级枚举,host adapter / viewer 用 translatePrompt
 * 或本地 i18n 字典把它本地化为『高』/『high』等。
 *
 * 设计原因:不在 core 层硬编码中文,保持 host-agnostic(元2 dual-host 契约)。
 */
export interface ScoreField {
  /** 2 位小数(rounded),JSON-safe */
  readonly raw: number;
  /** 语言中立等级:high (≥0.7) / medium (≥0.3) / low (<0.3) */
  readonly band: ScoreBand;
}

/**
 * 把裸浮点封装为 ScoreField
 *
 * 同时做两件事:
 *   1. round 到 2 位小数,杀掉浮点噪声(0.018000000000000002 → 0.02)
 *   2. 计算 band(high/medium/low),供 host adapter 渲染
 *
 * 单独抽出是因为多个工具(engram_get / engram_reinforce /
 * engram_search)都要做同样的处理,集中一处避免漂移。
 */
export function formatScoreField(raw: number): ScoreField {
  const rounded = Math.round(raw * 100) / 100;
  const band: ScoreBand =
    rounded >= 0.7 ? "high" : rounded >= 0.3 ? "medium" : "low";
  return { raw: rounded, band };
}

/** 重导出类型,方便 `import { CONCEPT_DICTIONARY, type ConceptEntry } from "..."` */
export type { ConceptEntry, ConceptId, ScoreBand } from "./types.js";
