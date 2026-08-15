/**
 * 深度思考 runner —— REM 深度思考步骤的编排(spec §三/§五)。
 *
 * 管线:computeModeSignals → top-K 模式(孵化条目占灵感最高优先级槽)→
 * 扩散激活子图 → 模式 prompt → LLM 生成 → 机械校验 → 独立 critic →
 * 阈值过滤 + 排序 → 限流 ≤5 → proposeInsight。
 *
 * 跳过条件(一期):config 未启用 / 无事件信号(纯时间兜底 REM,零 LLM 调用)/
 * llmClient 或 proposalEngine 未注入。单模式失败不阻塞整体。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { critique } from "./critic.js";
import {
  buildAliasMap,
  buildModePrompt,
  computeModeSignals,
  inspirationSeedFilter,
  retrospectiveSeedFilter,
} from "./modes.js";
import { buildBaselineSubgraph, buildSubgraph } from "./spread.js";
import {
  DEFAULT_REM_INSIGHT,
  INSIGHT_LIMITS,
  type CriticScore,
  type DeepThoughtMode,
  type InsightDraft,
  type InsightSubgraph,
  type RemInsightConfig,
} from "./types.js";
import { validateInsightDraft, type ProposalLike } from "./validate.js";

/** runDeepThought 依赖的最小结构类型(避免循环依赖 ProposalEngine) */
export interface DeepThoughtProposalSink {
  proposeInsight(input: {
    readonly mode: string;
    readonly insightType: string;
    readonly title: string;
    readonly content: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
    readonly sourceIds: readonly string[];
    readonly criticScore: number;
    readonly criticRationale: string;
    readonly incubationId?: string;
    readonly round?: number;
  }): boolean;
  listAll(): readonly ProposalLike[];
}

/** 孵化条目最小接口(Incubator 的结构子集;从 runRem 解耦,REM 只是调度来源之一) */
export interface IncubationSource {
  activeEntries(): ReadonlyArray<{
    readonly id: string;
    readonly question: string;
    readonly dreamHistory: string;
  }>;
}

export interface DeepThoughtReport {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly modesRun: readonly DeepThoughtMode[];
  readonly proposals: number;
  readonly draftsGenerated: number;
  readonly criticRejected: number;
  readonly mechanicalRejected: number;
  /** 拒绝原因明细(机械+critic;运维诊断/盲评校准用) */
  readonly rejectReasons?: readonly string[];
  /** 消融对照(spec §九):主路径 vs baseline 子图重叠节点数(有模式执行时才统计) */
  readonly ablation?: { readonly subgraphNodes: number; readonly baselineNodes: number; readonly overlapNodes: number };
}

/** 顶层入口(REM metacognition 之后调用) */
export async function runDeepThought(deps: {
  readonly repository: EngramRepository;
  readonly proposalEngine?: DeepThoughtProposalSink;
  readonly llmClient?: LlmClient;
  readonly lastRemAt: string | null;
  readonly config: RemInsightConfig;
  readonly incubator?: IncubationSource;
}): Promise<DeepThoughtReport> {
  const config: Required<RemInsightConfig> = {
    enabled: deps.config.enabled ?? DEFAULT_REM_INSIGHT.enabled,
    modesPerRun: deps.config.modesPerRun ?? DEFAULT_REM_INSIGHT.modesPerRun,
    criticThreshold:
      deps.config.criticThreshold ?? DEFAULT_REM_INSIGHT.criticThreshold,
    maxSubgraphNodes:
      deps.config.maxSubgraphNodes ?? DEFAULT_REM_INSIGHT.maxSubgraphNodes,
    webResearch: deps.config.webResearch ?? DEFAULT_REM_INSIGHT.webResearch,
  };
  const empty = (reason: string): DeepThoughtReport => ({
    skipped: true,
    reason,
    modesRun: [],
    proposals: 0,
    draftsGenerated: 0,
    criticRejected: 0,
    mechanicalRejected: 0,
  });

  if (!config.enabled) return empty("disabled");
  if (!deps.llmClient) return empty("no-llm-client");
  if (!deps.proposalEngine) return empty("no-proposal-engine");

  const active = deps.incubator?.activeEntries() ?? [];
  const signals = computeModeSignals(deps.repository, {
    lastRemAt: deps.lastRemAt,
    hasActiveIncubation: active.length > 0,
  });
  // 一期兜底 REM(无事件信号)→ 深度思考整体跳过,零 LLM 调用(spec §三)
  if (signals.every((s) => s.strength <= 0)) return empty("no-mode-signals");

  // top-K 调度;active 孵化条目 → 灵感模式占据最高优先级槽(合并执行)
  const ranked = [...signals].sort((a, b) => b.strength - a.strength);
  if (active.length > 0) {
    const idx = ranked.findIndex((s) => s.mode === "inspiration");
    if (idx > 0) ranked.unshift(ranked.splice(idx, 1)[0]!);
  }
  const modes = ranked
    .filter((s) => s.strength > 0)
    .slice(0, config.modesPerRun)
    .map((s) => s.mode);

  const incubation = active[0] ?? null;
  let proposals = 0;
  let draftsGenerated = 0;
  let criticRejected = 0;
  let mechanicalRejected = 0;
  const modesRun: DeepThoughtMode[] = [];
  const rejectReasons: string[] = [];
  const accepted: Array<{ draft: InsightDraft; score: CriticScore }> = [];
  let ablation: DeepThoughtReport["ablation"];

  for (const mode of modes) {
    try {
      const seedFilter =
        mode === "retrospective"
          ? retrospectiveSeedFilter(deps.repository)
          : mode === "inspiration"
            ? inspirationSeedFilter(deps.repository)
            : undefined;
      const subgraph = buildSubgraph(deps.repository, {
        lastRemAt: deps.lastRemAt,
        maxNodes: config.maxSubgraphNodes,
        ...(seedFilter ? { seedFilter } : {}),
        ...(incubation
          ? {
              // 孵化条目经 incubator 单独执行(Task incubator);REM 自动灵感
              // 模式合并以孵化为中心时不在此重复 extraSeeds —— 孵化产物走
              // incubation_report 唯一写回路径。此处子图仅供跨域自动信号背景。
            }
          : {}),
      });
      if (subgraph.nodes.length === 0) continue;
      modesRun.push(mode);

      // 消融对照:首个执行的模式记录主路径 vs baseline 重叠(§九度量数据)
      if (!ablation) {
        const baseline = buildBaselineSubgraph(deps.repository, {
          lastRemAt: deps.lastRemAt,
          maxNodes: config.maxSubgraphNodes,
          ...(seedFilter ? { seedFilter } : {}),
        });
        const mainIds = new Set(subgraph.nodes.map((n) => n.id));
        const overlap = baseline.nodes.filter((n) => mainIds.has(n.id)).length;
        ablation = {
          subgraphNodes: subgraph.nodes.length,
          baselineNodes: baseline.nodes.length,
          overlapNodes: overlap,
        };
      }

      const prompt = buildModePrompt(
        mode,
        subgraph,
        incubation
          ? {
              incubation: {
                question: incubation.question,
                dreamHistory: incubation.dreamHistory,
              },
            }
          : undefined,
      );
      const raw = await deps.llmClient.complete(prompt, {
        temperature: 0.4,
        // 思考型模型先输出 thinking 块,预算不足会导致 text 为空(见 critic 注释)
        maxTokens: 8192,
      });
      // 别名(S1..Sn)→ 真实 id:LLM 抄写 ULID 易错,prompt 用短别名
      const aliasMap = buildAliasMap(subgraph);
      const drafts = parseDrafts(raw, mode).map((d) => ({
        ...d,
        sourceIds: d.sourceIds.map((x) => aliasMap.get(x) ?? x),
      }));
      draftsGenerated += drafts.length;

      const existing = deps.proposalEngine.listAll();
      for (const draft of drafts) {
        const v = validateInsightDraft(draft, subgraph, deps.repository, existing);
        if (!v.ok) {
          mechanicalRejected += 1;
          rejectReasons.push(`[${mode}] ${draft.title.slice(0, 30)}: ${v.reason}`);
          continue;
        }
        const score = await critique(deps.llmClient, draft, subgraph, mode);
        if (!score || score.overall < config.criticThreshold) {
          criticRejected += 1;
          rejectReasons.push(`[${mode}] ${draft.title.slice(0, 30)}: critic=${score ? score.overall.toFixed(2) : "null"} < ${config.criticThreshold}`);
          continue;
        }
        accepted.push({ draft, score });
      }
    } catch {
      // 单模式失败(LLM 抛错/JSON 解析失败等)不阻塞其余模式
    }
  }

  // 限流:按 critic 分排序取 top ≤5(spec §五第一关)
  accepted.sort((a, b) => b.score.overall - a.score.overall);
  for (const { draft, score } of accepted.slice(0, INSIGHT_LIMITS.maxProposalsPerRun)) {
    const ok = deps.proposalEngine.proposeInsight({
      mode: draft.mode,
      insightType: draft.type,
      title: draft.title,
      content: draft.content,
      summary: draft.summary,
      domainTags: draft.domainTags,
      sourceIds: draft.sourceIds,
      criticScore: score.overall,
      criticRationale: score.rationale,
      ...(incubation
        ? { incubationId: incubation.id, round: undefined }
        : {}),
    });
    if (ok) proposals += 1;
  }

  return {
    skipped: false,
    modesRun,
    proposals,
    draftsGenerated,
    criticRejected,
    mechanicalRejected,
    ...(rejectReasons.length ? { rejectReasons } : {}),
    ...(ablation ? { ablation } : {}),
  };
}

/** 解析 LLM 输出的 drafts JSON 数组(剥围栏;垃圾 → []) */
export function parseDrafts(raw: string, mode: DeepThoughtMode): InsightDraft[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: InsightDraft[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const d = item as Partial<InsightDraft> & { type?: string };
    if (!d.title || !d.content || !Array.isArray(d.sourceIds)) continue;
    const type = d.type;
    if (type !== "theme" && type !== "lesson" && type !== "analogy" && type !== "hypothesis") continue;
    out.push({
      mode,
      type,
      title: String(d.title),
      content: String(d.content),
      summary: String(d.summary ?? d.title),
      sourceIds: d.sourceIds.map(String),
      domainTags: Array.isArray(d.domainTags) ? d.domainTags.map(String) : [],
      reason: String(d.reason ?? ""),
      ...(d.aar && typeof d.aar === "object" ? { aar: d.aar as InsightDraft["aar"] } : {}),
    });
  }
  return out;
}

// ============================================================
// 存活期:证据链衰减监测(spec §五第三关)
// ============================================================

/** 单条洞察的衰减检查结果 */
export interface InsightDecayItem {
  readonly engramId: string;
  readonly title: string;
  readonly invalidEndpoints: number;
  readonly totalEndpoints: number;
  readonly ratio: number;
}

/** insight-review.json 落盘结构(每日重审摘要,viewer 展示) */
export interface InsightReviewFile {
  readonly version: 1;
  readonly generatedAt: string;
  readonly threshold: number;
  readonly items: readonly InsightDecayItem[];
}

const DECAY_THRESHOLD = 0.3; // 初值待校准(spec §五)
const REVIEW_FILE = "insight-review.json";

/**
 * 证据链衰减扫描(纯代码,无 LLM):
 * rem-insight 洞察(derives_from 出边)的对端 refuted / 非 active 占比 > 30%
 * → 汇入 insight-review.json 重审摘要;**不逐条出提案**(防泛滥)。
 *
 * 持锁写:仅 processLock holder(或未注入锁)落盘,与 maintenance-state 同款。
 */
export async function scanInsightDecay(
  repo: EngramRepository,
  dataRoot: string | undefined,
  processLock?: { readonly isHolder?: boolean },
  now: () => string = () => new Date().toISOString(),
): Promise<InsightDecayItem[]> {
  // 全库 digest 一次(id → 状态/生命周期),避免逐条 readEngram
  const digest = repo.listDigestByVerificationStatus(
    ["unverified", "plausible", "probable", "verified", "refuted"],
  );
  const statusById = new Map(
    digest.map((d) => [d.id, { ver: d.verificationStatus, life: d.status }]),
  );

  // derives_from 出边分组:from(洞察)→ [to(来源)]
  const evidence = new Map<string, string[]>();
  for (const { fromId, synapse } of repo.collectAllSynapses()) {
    if (synapse.kind !== "derives_from") continue;
    const list = evidence.get(fromId) ?? [];
    list.push(synapse.to);
    evidence.set(fromId, list);
  }

  const items: InsightDecayItem[] = [];
  for (const [engramId, targets] of evidence) {
    // 只审 rem-insight 洞察(encodingContext 标记);其余 derives_from
    // (人工/synthesize 连的)不属深度思考存活期管辖
    let title = engramId;
    let isInsight = false;
    try {
      const e = repo.readEngram(engramId);
      title = e.title;
      isInsight = (e.encodingContext ?? "").startsWith("rem-insight:");
    } catch {
      continue;
    }
    if (!isInsight) continue;
    let invalid = 0;
    for (const t of targets) {
      const s = statusById.get(t);
      if (!s || s.ver === "refuted" || s.life !== "active") invalid += 1;
    }
    const ratio = targets.length > 0 ? invalid / targets.length : 0;
    if (ratio > DECAY_THRESHOLD) {
      items.push({
        engramId,
        title,
        invalidEndpoints: invalid,
        totalEndpoints: targets.length,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }

  if (dataRoot && processLock?.isHolder !== false) {
    try {
      const file: InsightReviewFile = {
        version: 1,
        generatedAt: now(),
        threshold: DECAY_THRESHOLD,
        items,
      };
      const path = join(dataRoot, ".co-engram", REVIEW_FILE);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
    } catch {
      // 落盘失败不阻塞 REM
    }
  }
  return items;
}
