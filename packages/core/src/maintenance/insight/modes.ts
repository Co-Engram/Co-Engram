/**
 * 一期三模式:触发信号计算 + prompt 模板(spec §三)。
 *
 * 模式注册表:每模式 = 触发信号(自然事件)+ 种子选择器 + 提问方式 + 专属判据。
 * 信号是事件驱动的(优于盲扫的工程判断,不依赖睡眠机制);强度公式为
 * **待校准初值**(saturate 饱和归一),冻结的只是结构。
 *
 * @module @co-engram/core/maintenance/insight
 */

import type { EngramRepository } from "../../storage/repository.js";
import {
  GENERIC_DOMAIN_TAGS,
  type DeepThoughtMode,
  type InsightSubgraph,
  type ModeCalibration,
  type ModeSignal,
} from "./types.js";
import { saturate } from "./activity.js";

/**
 * 历史质量校准:strength × factor 后夹回 [0,1](factor 由 accept 分布派生,
 * 见 activity.computeModeCalibration)。factor 缺失(冷启动/无数据)不干预。
 */
function calibrateStrength(raw: number, cal: ModeCalibration | undefined): number {
  if (!cal) return raw;
  return Math.min(1, raw * cal.factor);
}

/** active engram digest(与 spread.ts 同源查询;SQLite 主路径批量,无 N+1) */
function activeDigests(
  repo: EngramRepository,
): ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly domainTags: readonly string[];
  readonly failedUses: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verificationStatus: string | null;
  readonly encodingContext?: string;
}> {
  return repo.listDigestByVerificationStatus(
    ["unverified", "plausible", "probable", "verified", "refuted"],
    { lifecycleStatuses: ["active"] },
  );
}

/** 过滤笼统标签后的域集合 */
function specificDomains(tags: readonly string[]): Set<string> {
  return new Set(tags.filter((t) => !GENERIC_DOMAIN_TAGS.has(t)));
}

/**
 * 三模式信号计算(spec §三触发信号列)。
 *
 * - 整合:新突触多、同域新增密集 → 0.6·sat(新突触) + 0.4·sat(单域最大新增)
 * - 复盘:failedUses↑ / refute / 强化分下降 → sat(failedUses≥3 记忆数 + 新 refute 数)
 * - 灵感:跨域新增(新 domainTags,过滤笼统标签)→ sat(携带 unseen 域的新增数);
 *   存在 active 孵化条目时灵感占据最高优先级槽(spec §三:夜思与自动灵感合并执行)
 *
 * 一期兜底 REM(无任何事件信号)→ 三个强度全 0,深度思考整体跳过。
 */
/** 被拒洞察快照(REM 审批反馈信号,2026-08-16 用户灵感) */
export interface DismissedInsight {
  readonly title: string;
  readonly reason: string | undefined;
  readonly sourceIds: readonly string[];
}

export function computeModeSignals(
  repo: EngramRepository,
  opts: {
    readonly lastRemAt: string | null;
    readonly hasActiveIncubation: boolean;
    /** 自 lastRemAt 起被 dismiss 的 rem-insight 提案(系统复盘自己的产出) */
    readonly dismissedInsights?: readonly DismissedInsight[];
    /** 各模式长期校准因子(accept 洞察的模式分布,2026-08-16 第二刀) */
    readonly modeCalibration?: ReadonlyMap<DeepThoughtMode, ModeCalibration>;
  },
): ModeSignal[] {
  const digests = activeDigests(repo);
  const since = opts.lastRemAt;

  const newEngrams =
    since === null ? digests : digests.filter((d) => d.createdAt > since);
  const oldEngrams =
    since === null ? [] : digests.filter((d) => d.createdAt <= since);

  // ---- 整合 ----
  const newSynapses = repo
    .collectAllSynapses()
    .filter(({ synapse }) => since !== null && synapse.createdAt > since);
  const domainNewCount = new Map<string, number>();
  for (const e of newEngrams) {
    for (const t of specificDomains(e.domainTags)) {
      domainNewCount.set(t, (domainNewCount.get(t) ?? 0) + 1);
    }
  }
  const maxSameDomainNew = Math.max(0, ...domainNewCount.values());
  const calIntegration = opts.modeCalibration?.get("integration");
  const integration: ModeSignal = {
    mode: "integration",
    strength: calibrateStrength(
      Math.min(
        1,
        0.6 * saturate(newSynapses.length) + 0.4 * saturate(maxSameDomainNew),
      ),
      calIntegration,
    ),
    detail: {
      newSynapses: newSynapses.length,
      sameDomainNew: maxSameDomainNew,
      newEngrams: newEngrams.length,
      calibrationFactor: calIntegration?.factor ?? 1,
      calibrationSamples: calIntegration?.samples ?? 0,
    },
  };

  // ---- 复盘 ----
  const failing = digests.filter((d) => d.failedUses >= 3);
  const newlyRefuted =
    since === null
      ? 0
      : digests.filter(
          (d) => d.verificationStatus === "refuted" && d.updatedAt > since,
        ).length;
  // 审批反馈(2026-08-16):洞察被 dismiss = 最直接的人工质量否决 ——
  // 比失败使用更早到达的负信号,纳入复盘强度(系统复盘自己的产出)
  const dismissed = opts.dismissedInsights ?? [];
  const calRetrospective = opts.modeCalibration?.get("retrospective");
  const retrospective: ModeSignal = {
    mode: "retrospective",
    strength: calibrateStrength(
      saturate(failing.length + newlyRefuted + dismissed.length),
      calRetrospective,
    ),
    detail: {
      failingEngrams: failing.length,
      newlyRefuted,
      dismissedInsights: dismissed.length,
      calibrationFactor: calRetrospective?.factor ?? 1,
      calibrationSamples: calRetrospective?.samples ?? 0,
    },
  };

  // ---- 灵感 ----
  const oldDomains = new Set<string>();
  for (const e of oldEngrams) {
    for (const t of specificDomains(e.domainTags)) oldDomains.add(t);
  }
  const crossDomainNew = newEngrams.filter((e) =>
    [...specificDomains(e.domainTags)].some((t) => !oldDomains.has(t)),
  );
  let inspirationStrength = saturate(crossDomainNew.length);
  if (opts.hasActiveIncubation) {
    // 孵化条目占据灵感模式最高优先级槽:强度提升保证入 top-K 首位
    inspirationStrength = Math.min(1, inspirationStrength + 0.5);
  }
  const calInspiration = opts.modeCalibration?.get("inspiration");
  const inspiration: ModeSignal = {
    mode: "inspiration",
    strength: calibrateStrength(inspirationStrength, calInspiration),
    detail: {
      crossDomainNew: crossDomainNew.length,
      hasActiveIncubation: opts.hasActiveIncubation ? 1 : 0,
      calibrationFactor: calInspiration?.factor ?? 1,
      calibrationSamples: calInspiration?.samples ?? 0,
    },
  };

  return [integration, retrospective, inspiration];
}

/**
 * 复盘模式种子约束:failedUses≥3 的记忆,含 rem-insight 洞察自身
 * (failedUses≥3 → 系统复盘自己的旧产出,自我修正闭环,spec §五)。
 */
export function retrospectiveSeedFilter(
  repo: EngramRepository,
  dismissedInsights?: readonly DismissedInsight[],
): (id: string) => boolean {
  const failing = new Set(
    activeDigests(repo)
      .filter((d) => d.failedUses >= 3)
      .map((d) => d.id),
  );
  // 被拒洞察的来源记忆:产出被否决的"原料"同入复盘视野
  for (const d of dismissedInsights ?? []) {
    for (const id of d.sourceIds) failing.add(id);
  }
  return (id: string) => failing.has(id);
}

/** 灵感模式种子约束:携带非笼统域标签的记忆 */
export function inspirationSeedFilter(
  repo: EngramRepository,
): (id: string) => boolean {
  const tagged = new Set(
    activeDigests(repo)
      .filter((d) => specificDomains(d.domainTags).size > 0)
      .map((d) => d.id),
  );
  return (id: string) => tagged.has(id);
}

/**
 * 节点短别名:LLM 抄写 26 位 ULID 极易出错导致引用闭合拒绝(2026-08-15
 * 真实 LLM 场景验证发现),prompt 用 S1..Sn 别名,解析后经 aliasMap 映射回真实 id。
 */
export function nodeAlias(index: number): string {
  return `S${index + 1}`;
}

/** 别名 → 真实 id 映射(与 serializeSubgraph 的编号一致) */
export function buildAliasMap(sub: InsightSubgraph): Map<string, string> {
  const m = new Map<string, string>();
  sub.nodes.forEach((n, i) => m.set(nodeAlias(i), n.id));
  return m;
}

/** 子图序列化(LLM 输入:节点 digest + 活动 + 边 + 全局统计,spec §三「输入」) */
export function serializeSubgraph(sub: InsightSubgraph): string {
  const nodes = sub.nodes
    .map(
      (n, i) =>
        `- [${nodeAlias(i)}] ${n.title} (id=${n.id}) | kind=${n.kind} | tags=${n.domainTags.join("/")} | imp=${n.importance.toFixed(2)} | ver=${n.verificationStatus ?? "unverified"} | retrieves=${n.retrievalCount} failedUses=${n.failedUses} | seed=${n.isSeed}`,
    )
    .join("\n");
  const summaries = sub.nodes
    .map((n, i) => `- [${nodeAlias(i)}] ${n.summary}`)
    .join("\n");
  const edges = sub.edges
    .map(
      (e) =>
        `- ${e.from} --${e.kind}(w=${e.weight.toFixed(2)})${e.isNew ? " NEW" : ""}--> ${e.to}`,
    )
    .join("\n");
  const stats = Object.entries(sub.globalStats)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return [
    "## Memory network slice",
    stats,
    "### Nodes",
    nodes || "(none)",
    "### Summaries",
    summaries || "(none)",
    "### Edges",
    edges || "(none)",
  ].join("\n");
}

const MODE_INSTRUCTIONS: Readonly<Record<DeepThoughtMode, string>> = {
  integration: `You are running the INTEGRATION mode of a team-memory deep-thought engine.
Find cross-context common structures and themes ACROSS the memory slice below.
Requirements: a theme insight must synthesize at least 2 distinct sources (cross-contextuality);
report the relational/common structure, not surface keyword overlap.`,
  retrospective: `You are running the RETROSPECTIVE mode (After Action Review) of a team-memory deep-thought engine.
For memories with failures (failedUses >= 3) or refutations, build a complete causal chain with EXACTLY four AAR elements:
expected (what was assumed), actual (what happened), cause (root cause), improvement (what to change next time).
An insight missing any of the four elements will be discarded — do not produce it.`,
  inspiration: `You are running the INSPIRATION mode of a team-memory deep-thought engine.
Deliberately pick pairs of memories from DIFFERENT domains with LOW surface similarity, and ask:
"Can the relational structure of domain A map onto domain B?"
Map RELATIONAL STRUCTURE (how elements connect/constrain each other), NOT surface vocabulary.
A far-fetched analogy is worse than none: only produce an analogy when the mapping is structurally grounded.`,
};

/** JSON 输出格式说明(所有模式共用;结构与 InsightDraft 对齐) */
const OUTPUT_CONTRACT = `Return ONLY a JSON array (possibly empty) of insight drafts. Each element:
{
  "type": "theme" | "lesson" | "analogy" | "hypothesis",
  "title": string,
  "summary": string,
  "content": string (markdown, cites [id] of sources inline),
  "sourceIds": string[] (cite nodes by their [S1]-style alias or the full id),
  "domainTags": string[],
  "reason": string (why this is an insight, not a restatement),
  "aar": { "expected": string, "actual": string, "cause": string, "improvement": string }  // required for type=lesson only
}
Type selection: use "theme" for cross-context syntheses of shared structure; use "lesson" only with the four AAR fields; use "analogy" only across disjoint domains; use "hypothesis" only for causal explanations WITH explicit "if true observe X / if false observe Y" predictions (otherwise it will be discarded). No prose outside the JSON array.`;

/**
 * 模式 prompt。孵化条目存在时(Dormio 锚定):首行重复问题,携带完整梦境史,
 * 指令「不重复已探索方向,在上一轮基础上深化或转向」(回灌迭代,spec §四)。
 */
export function buildModePrompt(
  mode: DeepThoughtMode,
  sub: InsightSubgraph,
  opts: {
    readonly incubation?: {
      readonly question: string;
      readonly dreamHistory: string;
    } | null;
    /** 复盘模式:近期被拒洞察(审批反馈闭环) */
    readonly dismissedInsights?: readonly DismissedInsight[];
  } = {},
): string {
  const parts: string[] = [];
  if (opts.incubation) {
    parts.push(`TASK (repeat): ${opts.incubation.question}`);
    if (opts.incubation.dreamHistory.trim().length > 0) {
      parts.push(
        "",
        "## Dream history (previous rounds — do NOT repeat explored directions; deepen or pivot)",
        opts.incubation.dreamHistory,
      );
    }
    parts.push("");
  }
  if (mode === "retrospective" && (opts.dismissedInsights ?? []).length > 0) {
    const lines = opts.dismissedInsights!
      .map((d) => `- "${d.title}" — dismissed reason: ${d.reason ?? "(未填)"}`)
      .join("\n");
    parts.push(
      "## Recently dismissed insights (human feedback on YOUR previous outputs)",
      lines,
      "Retrospect on WHY they were rejected (insufficient evidence? restatement? far-fetched?)",
      "and produce a lesson on how insight generation should improve.",
      "",
    );
  }
  parts.push(MODE_INSTRUCTIONS[mode]);
  parts.push("");
  parts.push(serializeSubgraph(sub));
  parts.push("");
  parts.push(OUTPUT_CONTRACT);
  return parts.join("\n");
}

/** L1 夜思基线 prompt(spec §四:单次 LLM 远距类比;锚定 + 梦境史 + 跨域种子) */
export function buildNightThinkingL1Prompt(question: string, seeds: string, dreamHistory: string): string {
  const parts = [`TASK (repeat): ${question}`];
  if (dreamHistory.trim().length > 0) {
    parts.push(
      "",
      "## Previous thinking sessions (deepen or pivot, do not repeat)",
      dreamHistory,
    );
  }
  parts.push(
    "",
    "You are the baseline contemplation engine (this host has no agent runtime). Think about the task above using the seed memories below.",
    "Deliberately connect across domains with low surface similarity, mapping relational structure.",
    "",
    seeds,
    "",
    OUTPUT_CONTRACT,
  );
  return parts.join("\n");
}
