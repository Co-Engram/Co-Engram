/**
 * REM 突触候选对计算(二期,agent-driven):局部图遍历,输出候选对给 agent 判断。
 *
 * 反思落地(2026-08,REM 突触维护二期 / 记忆 01KYCGK8FPGW2GW9C3WF0FK2TM):
 * 注入 llmClient 时,候选对经 LLM 语义判断(12 种 SynapseKind 或 none)后按
 * 判定 kind 生成提案——修复「similar_to 占位提案」导致因果/时间族突触恒为 0
 * 的结构缺陷(机械层只筛候选,关系判断只有 LLM)。未注入/失败时保持原行为
 * (占位 similar_to,agent review),记审计 reflection_skipped。
 *
 * 算法(局部图遍历,神经科学:REM 巩固白天激活的记忆 + 关联网络):
 *   1. 活跃集 A = { e | 上次 REM 后检索(lastRetrievedAt > lastRemAt) OR 新建(createdAt > lastRemAt) }
 *   2. 邻居集 N = A 的 1-hop 突触邻居(readSynapses outgoing+incoming 对端)
 *   3. 候选对 = A×A(活跃间,可能建新)+ A×N(活跃 vs 已关联,评估现有)
 *      不含 N×N(邻居间不直接处理,避免扩散)
 *   4. Jaccard 预筛(范围内,捞「可能相关」)+ 已有突触对(评估现有)
 *   5. 返回候选对(agent review → 调 synapse_create/synapse_delete/synapse_update)
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SynapseKind } from "../types/synapse.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { tokenizeForDedup, jaccardSimilarity } from "../dedup/similar.js";
import {
  judgeRelationPairs,
  type RelationJudgePair,
} from "./synapse-relation-judge.js";

/**
 * 候选对 Jaccard 预筛阈值(范围内,低于此值的 A×A 对不给 agent)。
 *
 * 0.25(2026-08-18 从 0.15 上调):0.15 为未校准初值,实测(162 engram 生产仓库
 * dry-run)单轮 propose 85 条、confidence 中位数 0.20,审批队列倾泻(2026-08-17
 * 一轮 REM 产生 95 条 pending)。实测阈值-提案量分布:0.15→85 / 0.20→40 /
 * 0.25→24 / 0.30→7。取 0.25:成对候选比成簇(聚类阈值 0.3)宽松一档合理,
 * 配合 hub 抑制与每轮总量上限后实际 ~19 条,人工可审;0.30 召回损失过大。
 */
export const SYNAPSE_REFINE_JACCARD_THRESHOLD = 0.25;

/**
 * 单节点(engram 端点)单轮无 edge 候选 propose 上限(hub 抑制)。
 *
 * 归档/元层 engram(loop round 归档、方法论元条目)content 引用大量其他记忆
 * 标题,token 重叠天然高,实测 top hub 单轮被 propose 13-14 条(占总量 ~40%)。
 * 候选按相似度降序接纳,任一端点达上限即跳过该对——hub 保留其最相似的 5 条,
 * 余量让给长尾对。0 即禁用。
 */
export const SYNAPSE_REFINE_MAX_PER_NODE = 5;

/**
 * 单轮 REM propose 总量上限(保险丝)。
 *
 * 正常轮次达不到(实测 0.25 阈值 + hub≤5 后 ~19 条);防活跃集异常大
 * (批量导入后冷启动/高频检索周)时倾泻。0 即禁用。
 */
export const SYNAPSE_REFINE_MAX_PROPOSE_PER_RUN = 30;

/** proposalEngine 接口(复用 proposeSynapseOp,结构类型避免循环 import) */
interface ProposalEngineLike {
  proposeSynapseOp?(input: {
    readonly op: "add" | "delete" | "retype";
    readonly from: string;
    readonly to: string;
    readonly kind: SynapseKind;
    readonly oldKind?: SynapseKind;
    readonly reason: string;
    readonly confidence: number;
    readonly fromTitle?: string;
    readonly toTitle?: string;
  }): boolean;
}

/** 审计接口(降级留痕用,结构类型避免 import AuditLog 实类) */
interface AuditLike {
  append(entry: {
    readonly actor: "system";
    readonly action: "reflection_skipped";
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): void;
}

/** 一对候选(交 agent 判断) */
export interface SynapseCandidatePair {
  readonly a: string;
  readonly b: string;
  readonly aTitle: string;
  readonly bTitle: string;
  /** token Jaccard 相似度 */
  readonly similarity: number;
  /** 是否已有突触连接(有→agent 评估 retype/delete;无→agent 评估 add) */
  readonly hasEdge: boolean;
  /** 现有突触 kind(hasEdge=true 时) */
  readonly edgeKind?: SynapseKind;
}

/** 候选对计算结果 */
export interface SynapseRefineResult {
  readonly activeCount: number;
  readonly neighborCount: number;
  readonly candidatePairs: readonly SynapseCandidatePair[];
  /** 已 proposeSynapseOp 的候选对数(无现有 edge 的,生成 add similar_to 占位 proposal) */
  readonly proposed: number;
}

/**
 * 计算突触候选对(局部图遍历)+ 可选 LLM 语义判断(反思落地)。
 *
 * @param repo 仓库
 * @param proposalEngine 注入时对无 edge 候选生成 add 提案(用户审批)
 * @param options.lastRemAt 上次 REM 完成时间(增量触发基线);undefined→全量(冷启动)
 * @param options.jaccardThreshold 覆盖默认预筛阈值
 * @param options.llmClient 注入时启用反思判断层(按判定 kind 提案;none 不提);
 *   缺失/失败降级为占位 similar_to 提案(原行为)
 * @param options.auditLog 降级时记 reflection_skipped 审计
 */
export async function refineSynapsesOnActiveGraph(
  repo: EngramRepository,
  proposalEngine: ProposalEngineLike | undefined,
  options: {
    readonly lastRemAt?: string;
    readonly jaccardThreshold?: number;
    readonly llmClient?: LlmClient;
    readonly auditLog?: AuditLike;
  } = {},
): Promise<SynapseRefineResult> {
  const lastRemAt = options.lastRemAt;
  const jaccardThreshold =
    options.jaccardThreshold ?? SYNAPSE_REFINE_JACCARD_THRESHOLD;

  // 1. 活跃集 A(增量检索 OR 新建)
  const allIds = repo.listEngrams().map((e) => e.id);
  if (allIds.length === 0) {
    return {
      activeCount: 0,
      neighborCount: 0,
      candidatePairs: [],
      proposed: 0,
    };
  }
  const digests = repo.readDigestBatch(allIds);
  const digestById = new Map(digests.map((d) => [d.id, d] as const));
  const titleById = new Map<string, string>();
  const activeIds = new Set<string>();
  for (const d of digests) {
    titleById.set(d.id, d.title);
    if (d.status !== "active") continue;
    const retrieved =
      d.lastRetrievedAt && lastRemAt ? d.lastRetrievedAt > lastRemAt : false;
    const created = lastRemAt ? d.createdAt > lastRemAt : true; // 无 lastRemAt(冷启动)→ 全活跃
    if (retrieved || created) activeIds.add(d.id);
  }
  if (activeIds.size === 0) {
    return {
      activeCount: 0,
      neighborCount: 0,
      candidatePairs: [],
      proposed: 0,
    };
  }

  // 2. 邻居集 N(1-hop:活跃 engram 的突触对端)
  const neighborIds = new Set<string>();
  const existingEdges = new Map<string, SynapseKind>();
  const allSynapses = repo.collectAllSynapses();
  for (const a of activeIds) {
    for (const { fromId, synapse } of allSynapses) {
      const otherEnd =
        fromId === a ? synapse.to : synapse.to === a ? fromId : null;
      if (otherEnd === null) continue;
      neighborIds.add(otherEnd);
      existingEdges.set(`${synapse.from}|${synapse.to}`, synapse.kind);
    }
  }
  for (const a of activeIds) neighborIds.delete(a); // N 去掉 A

  // 3. 候选对 A×A + A×N(去重,a<b 字典序避免双向重复)
  const contents = repo.readContentBatch([...activeIds, ...neighborIds]);
  const contentById = new Map(contents.map((c) => [c.id, c] as const));
  for (const c of contents) titleById.set(c.id, c.title);

  const candidateSet = new Set<string>();
  const addPairKey = (a: string, b: string): string => {
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}`;
    candidateSet.add(key);
    return key;
  };
  const activeArr = [...activeIds];
  for (let i = 0; i < activeArr.length; i++) {
    for (let j = i + 1; j < activeArr.length; j++) {
      addPairKey(activeArr[i]!, activeArr[j]!);
    }
  }
  for (const a of activeIds) {
    for (const n of neighborIds) {
      addPairKey(a, n);
    }
  }

  // 4. Jaccard 预筛 + 已有突触对 → 候选对列表
  const tokensCache = new Map<string, Set<string>>();
  const tokensOf = (id: string): Set<string> => {
    const cached = tokensCache.get(id);
    if (cached) return cached;
    const c = contentById.get(id);
    const t = c
      ? tokenizeForDedup(`${c.title} ${c.summary} ${c.content}`)
      : new Set<string>();
    tokensCache.set(id, t);
    return t;
  };

  const candidatePairs: SynapseCandidatePair[] = [];
  for (const key of candidateSet) {
    const [a, b] = key.split("|");
    if (!a || !b) continue;
    const edgeKey1 = `${a}|${b}`;
    const edgeKey2 = `${b}|${a}`;
    const edgeKind = existingEdges.get(edgeKey1) ?? existingEdges.get(edgeKey2);
    const hasEdge = edgeKind !== undefined;
    if (!hasEdge) {
      // 无现有突触→Jaccard 预筛(低于阈值的不给 agent)
      const sim = jaccardSimilarity(tokensOf(a), tokensOf(b));
      if (sim < jaccardThreshold) continue;
      candidatePairs.push({
        a,
        b,
        aTitle: titleById.get(a) ?? a,
        bTitle: titleById.get(b) ?? b,
        similarity: sim,
        hasEdge: false,
      });
    } else {
      // 已有突触→交给 agent 评估(retype/delete),不卡 Jaccard
      candidatePairs.push({
        a,
        b,
        aTitle: titleById.get(a) ?? a,
        bTitle: titleById.get(b) ?? b,
        similarity: jaccardSimilarity(tokensOf(a), tokensOf(b)),
        hasEdge: true,
        edgeKind,
      });
    }
  }

  // 候选对(无现有 edge)→ 三层节流选出配额内的对 → (可选)LLM 语义判断 →
  // proposeSynapseOp 生成 add 提案。复用现有 proposal 系统:agent 通过
  // engram_list_proposals/accept/dismiss review。
  // 有 edge 的候选(现有突触)不 propose——agent 用 synapse 工具评估 retype/delete。
  // proposeSynapseOp 幂等(entityId=hash(from+to+op+kind)),与 rem.ts 聚类 add 同对同 kind 去重。
  //
  // 三层节流(2026-08-18,修复 95 条提案倾泻;实测 85 → 19 条,-78%):
  //   1. Jaccard ≥ 0.25(上方常量,校准依据见注释)
  //   2. 单节点 ≤ 5:相似度降序接纳,任一端点达上限跳过——抑制归档 hub
  //   3. 每轮总量 ≤ 30:保险丝
  const noEdgeCandidates = candidatePairs
    .filter((p) => !p.hasEdge)
    .sort((x, y) => y.similarity - x.similarity);
  // 先选后判:配额在「选中」时计,LLM 成本恒等于节流后数量(≤ 30/轮),
  // 判 none 的对不 propose 但占配额——配额控制的是「LLM 看多少对」。
  const nodeProposeCount = new Map<string, number>();
  const selected: SynapseCandidatePair[] = [];
  for (const p of noEdgeCandidates) {
    if (
      SYNAPSE_REFINE_MAX_PROPOSE_PER_RUN > 0 &&
      selected.length >= SYNAPSE_REFINE_MAX_PROPOSE_PER_RUN
    ) {
      break;
    }
    if (
      SYNAPSE_REFINE_MAX_PER_NODE > 0 &&
      ((nodeProposeCount.get(p.a) ?? 0) >= SYNAPSE_REFINE_MAX_PER_NODE ||
        (nodeProposeCount.get(p.b) ?? 0) >= SYNAPSE_REFINE_MAX_PER_NODE)
    ) {
      continue;
    }
    selected.push(p);
    nodeProposeCount.set(p.a, (nodeProposeCount.get(p.a) ?? 0) + 1);
    nodeProposeCount.set(p.b, (nodeProposeCount.get(p.b) ?? 0) + 1);
  }

  // 反思判断层(2026-08 二期):LLM 判 12 kind/none;机械层至此为止,
  // 关系判断只有 LLM(降级不产伪因果——占位 similar_to 是「待 agent 复核」
  // 的诚实标注,不是伪造的语义关系)。
  let verdicts: Awaited<ReturnType<typeof judgeRelationPairs>> | undefined;
  if (selected.length > 0) {
    if (options.llmClient) {
      const judgePairs: RelationJudgePair[] = selected.map((p) => ({
        aId: p.a,
        bId: p.b,
        aTitle: p.aTitle,
        bTitle: p.bTitle,
        aText: judgeTextOf(p.a),
        bText: judgeTextOf(p.b),
      }));
      try {
        const results = await judgeRelationPairs(options.llmClient, judgePairs);
        const degraded = results.filter((v) => v === undefined).length;
        if (degraded > 0) {
          options.auditLog?.append({
            actor: "system",
            action: "reflection_skipped",
            metadata: {
              layer: "rem-synapse-refine",
              reason: "llm-failed",
              pairsTotal: selected.length,
              pairsDegraded: degraded,
            },
          });
        }
        if (results.some((v) => v !== undefined)) verdicts = results;
      } catch {
        options.auditLog?.append({
          actor: "system",
          action: "reflection_skipped",
          metadata: { layer: "rem-synapse-refine", reason: "llm-error" },
        });
      }
    } else {
      options.auditLog?.append({
        actor: "system",
        action: "reflection_skipped",
        metadata: {
          layer: "rem-synapse-refine",
          reason: "llm-missing",
          pairsTotal: selected.length,
        },
      });
    }
  }

  let proposed = 0;
  for (let i = 0; i < selected.length; i++) {
    const p = selected[i]!;
    const v = verdicts?.[i];
    if (v?.kind === "none") continue; // LLM 判无关系 → 不提(比占位更少噪音)
    // 有向关系方向由 LLM 裁定(reverse → 交换两端)
    const from = v?.reverse ? p.b : p.a;
    const to = v?.reverse ? p.a : p.b;
    try {
      proposalEngine?.proposeSynapseOp?.({
        op: "add",
        from,
        to,
        kind: v?.kind ?? "similar_to",
        reason:
          v !== undefined
            ? `REM 反思(LLM 语义判断,${v.kind}${v.reverse ? ",反向" : ""},置信 ${v.confidence.toFixed(2)}):${v.reason}`
            : `REM 突触候选(局部图遍历:活跃集+邻居;Jaccard ${p.similarity.toFixed(2)});agent review 关系类型`,
        confidence: v?.confidence ?? p.similarity,
        fromTitle: v?.reverse ? p.bTitle : p.aTitle,
        toTitle: v?.reverse ? p.aTitle : p.bTitle,
      });
      proposed += 1;
    } catch {
      // 单条 propose 失败不阻塞
    }
  }

  return {
    activeCount: activeIds.size,
    neighborCount: neighborIds.size,
    candidatePairs,
    proposed,
  };

  /** 端点判断素材(优先全文摘要,缺则标题兜底;截断在 judge 层) */
  function judgeTextOf(id: string): string {
    const c = contentById.get(id);
    if (c) {
      const d = digestById.get(id);
      const tags = d ? ` [${d.domainTags.join("/")}]` : "";
      return `${c.summary ?? ""}${tags}\n${c.content}`;
    }
    return titleById.get(id) ?? id;
  }
}
