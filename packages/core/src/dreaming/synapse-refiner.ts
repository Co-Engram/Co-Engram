/**
 * REM 突触候选对计算(二期,agent-driven):局部图遍历,输出候选对给 agent 判断。
 *
 * **不调 LLM,不 propose**——co-engram 跑在 Claude Code 里,agent 本身是强 LLM。
 * 突触关系判断交 agent(透明、遵循指令、可复用 synapse_create/delete 工具),
 * co-engram 只负责计算「哪些 engram 对值得 agent 看」(候选对)。
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
import { tokenizeForDedup, jaccardSimilarity } from "../dedup/similar.js";

/** 候选对 Jaccard 预筛阈值(范围内,低于此值的 A×A 对不给 agent) */
export const SYNAPSE_REFINE_JACCARD_THRESHOLD = 0.15;

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
 * 计算突触候选对(局部图遍历)。不调 LLM,不 propose——交 agent 判断。
 *
 * @param repo 仓库
 * @param options.lastRemAt 上次 REM 完成时间(增量触发基线);undefined→全量(冷启动)
 * @param options.jaccardThreshold 覆盖默认预筛阈值
 */
export async function refineSynapsesOnActiveGraph(
  repo: EngramRepository,
  proposalEngine: ProposalEngineLike | undefined,
  options: {
    readonly lastRemAt?: string;
    readonly jaccardThreshold?: number;
  } = {},
): Promise<SynapseRefineResult> {
  const lastRemAt = options.lastRemAt;
  const jaccardThreshold =
    options.jaccardThreshold ?? SYNAPSE_REFINE_JACCARD_THRESHOLD;

  // 1. 活跃集 A(增量检索 OR 新建)
  const allIds = repo.listEngrams().map((e) => e.id);
  if (allIds.length === 0) {
    return { activeCount: 0, neighborCount: 0, candidatePairs: [], proposed: 0 };
  }
  const digests = repo.readDigestBatch(allIds);
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
    return { activeCount: 0, neighborCount: 0, candidatePairs: [], proposed: 0 };
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

  // 候选对(无现有 edge)→ proposeSynapseOp 生成 add similar_to 占位 proposal。
  // 复用现有 proposal 系统:agent 通过 engram_list_proposals/accept/dismiss review。
  // accept 落盘 similar_to;想改 kind→dismiss+synapse_create;不建→dismiss。
  // 有 edge 的候选(现有突触)不 propose——agent 用 synapse 工具评估 retype/delete。
  // proposeSynapseOp 幂等(entityId=hash(from+to+op+kind)),与 rem.ts 聚类 add 同对同 kind 去重。
  let proposed = 0;
  for (const p of candidatePairs) {
    if (p.hasEdge) continue;
    try {
      proposalEngine?.proposeSynapseOp?.({
        op: "add",
        from: p.a,
        to: p.b,
        kind: "similar_to",
        reason: `REM 突触候选(局部图遍历:活跃集+邻居;Jaccard ${p.similarity.toFixed(2)});agent review 关系类型`,
        confidence: p.similarity,
        fromTitle: p.aTitle,
        toTitle: p.bTitle,
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
}
