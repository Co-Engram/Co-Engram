/**
 * 扩散激活选材 —— seed 导向的局部图展开(spec §三)。
 *
 * 与 P0-2 五因子检索打分的层关系:五因子是 query 导向排序(给定查询,排记忆);
 * 本模块是 seed 导向局部展开(给定事件种子,思考扩散到哪)。二者不同层、非替代。
 *
 * 机制诚实声明(spec §二):「扩散激活」是叙事灵感的工程等价物(合理的图算法),
 * 衰减系数 / 跳数截止 / 子图上限 / 阈值等参数**全部为无文献来源初值**,
 * 按 spec §九敏感性实验校准;冻结的只是结构。
 *
 * @module @co-engram/core/maintenance/insight
 */

import type { EngramRepository } from "../../storage/repository.js";
import { SPREAD_PARAMS, TRUTH_FACTOR, type InsightSubgraph, type SubgraphEdge, type SubgraphNode } from "./types.js";

/** 子图构建选项 */
export interface BuildSubgraphOpts {
  /** 上次 REM 完成时间;null = 从未跑过(全库候选,按 activation 排序) */
  readonly lastRemAt: string | null;
  /** 子图节点上限(初值待校准) */
  readonly maxNodes: number;
  /** 模式专属种子约束(灵感:跨域;复盘:failedUses≥3);extraSeeds 不受此约束 */
  readonly seedFilter?: (id: string) => boolean;
  /** 显式种子(孵化条目 seedEngramIds),绕过 seedFilter */
  readonly extraSeeds?: readonly string[];
}

/** 归一化到 [0,1];全等时返回 0.5(避免单种子/无区分度时归零) */
function minMax(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/** verificationStatus → 真值因子(未知状态按 unverified 处理) */
function truthFactorOf(status: string | null | undefined): number {
  if (!status) return TRUTH_FACTOR.unverified!;
  return TRUTH_FACTOR[status] ?? TRUTH_FACTOR.unverified!;
}

/** 简化 Engram 视图(spread 内部只依赖这些字段) */
interface NodeFact {
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
  readonly updatedAt: string;
  readonly createdAt: string;
}

/**
 * 全量 active engram 的 digest 事实(SQLite 主路径批量查询,无 N+1;
 * 含 refuted —— 真值因子为 0 但仍可作为证据节点入子图)。
 */
function collectFacts(repo: EngramRepository): NodeFact[] {
  return repo
    .listDigestByVerificationStatus(
      ["unverified", "plausible", "probable", "verified", "refuted"],
      { lifecycleStatuses: ["active"] },
    )
    .map((e) => ({
      id: e.id,
      title: e.title,
      summary: e.summary,
      domainTags: e.domainTags ?? [],
      kind: e.kind,
      importance: e.importance,
      confidence: e.confidence,
      verificationStatus: e.verificationStatus ?? null,
      retrievalCount: e.retrievalCount,
      failedUses: e.failedUses,
      reinforcementScore: e.reinforcementScore,
      updatedAt: e.updatedAt,
      createdAt: e.createdAt,
    }));
}

/** 无向邻接表(扩散不分方向;对称/有向 kind 对"思考扩散到哪"等价) */
interface Adj {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly weight: number;
  readonly createdAt: string;
}

function collectAdj(repo: EngramRepository): Adj[] {
  return repo.collectAllSynapses().map(({ fromId, synapse }) => ({
    from: fromId,
    to: synapse.to,
    kind: synapse.kind,
    weight: synapse.weight,
    createdAt: synapse.createdAt,
  }));
}

/** 种子判定:新编码 ∪ 再激活 ∪ 结构重连端点 ∪ 显式种子 */
function isEventSeed(
  fact: NodeFact,
  adj: readonly Adj[],
  lastRemAt: string | null,
): boolean {
  if (lastRemAt === null) return true; // 从未跑过 REM:全库候选
  if (fact.createdAt > lastRemAt) return true; // 新编码
  if (fact.updatedAt > lastRemAt) return true; // 再激活(检索/强化/失败会更新 updatedAt)
  // 结构重连:新/变突触的两端
  return adj.some(
    (a) =>
      (a.from === fact.id || a.to === fact.id) && a.createdAt > lastRemAt,
  );
}

/** activity 增量初值:窗口内有更新 = 1,否则 0(待校准;新鲜度维度由 updatedAt 承载) */
function activityOf(fact: NodeFact, lastRemAt: string | null): number {
  if (lastRemAt === null) return 1;
  return fact.updatedAt > lastRemAt || fact.createdAt > lastRemAt ? 1 : 0;
}

/**
 * 扩散激活子图(主路径)。
 *
 * activation(种子) = w1·norm(importance × 真值因子) + w2·norm(活动增量)
 * 一跳:activation(邻居) += activation(节点) × 突触weight × hop1Decay
 * 二跳再乘 hop2Decay;低于 minActivation 的非种子节点不入子图;
 * 截 maxNodes(按 activation),边只保留两端都在子图内的。
 */
export function buildSubgraph(
  repo: EngramRepository,
  opts: BuildSubgraphOpts,
): InsightSubgraph {
  const facts = collectFacts(repo);
  const factById = new Map(facts.map((f) => [f.id, f]));
  const adj = collectAdj(repo);
  const extraSeeds = new Set(opts.extraSeeds ?? []);

  // ---- 种子收集 ----
  const seedFacts = facts.filter(
    (f) =>
      extraSeeds.has(f.id) ||
      (isEventSeed(f, adj, opts.lastRemAt) &&
        (opts.seedFilter ? opts.seedFilter(f.id) : true)),
  );
  // 显式种子即使不满足事件条件/过滤条件也保留(孵化条目语义)
  for (const id of extraSeeds) {
    const f = factById.get(id);
    if (f && !seedFacts.some((s) => s.id === id)) seedFacts.push(f);
  }
  if (seedFacts.length === 0) {
    return { nodes: [], edges: [], globalStats: { seedCount: 0, totalEngrams: facts.length } };
  }

  // ---- 种子 activation(先归一化再加权,spec §三)----
  const impNorm = minMax(seedFacts.map((f) => f.importance * truthFactorOf(f.verificationStatus)));
  const actNorm = minMax(seedFacts.map((f) => activityOf(f, opts.lastRemAt)));
  const activation = new Map<string, number>();
  seedFacts.forEach((f, i) => {
    activation.set(
      f.id,
      SPREAD_PARAMS.w1 * impNorm[i]! + SPREAD_PARAMS.w2 * actNorm[i]!,
    );
  });

  // ---- 两跳扩散(非种子取 max 累积激活)----
  const neighborsOf = (id: string): ReadonlyArray<{ to: string; weight: number }> =>
    adj
      .filter((a) => a.from === id || a.to === id)
      .map((a) => ({ to: a.from === id ? a.to : a.from, weight: a.weight }));

  const hop1 = new Map<string, number>();
  for (const seed of seedFacts) {
    const seedAct = activation.get(seed.id) ?? 0;
    for (const n of neighborsOf(seed.id)) {
      if (activation.has(n.to)) continue; // 种子不扩散覆盖
      const v = seedAct * n.weight * SPREAD_PARAMS.hop1Decay;
      hop1.set(n.to, Math.max(hop1.get(n.to) ?? 0, v));
    }
  }
  const hop2 = new Map<string, number>();
  for (const [id, act1] of hop1) {
    for (const n of neighborsOf(id)) {
      if (activation.has(n.to) || hop1.has(n.to)) continue;
      const v = act1 * n.weight * SPREAD_PARAMS.hop2Decay;
      hop2.set(n.to, Math.max(hop2.get(n.to) ?? 0, v));
    }
  }

  // ---- 组装节点(种子全保留;非种子过阈值,按激活降序补位到上限)----
  const nodes: SubgraphNode[] = seedFacts.map((f) => toNode(f, true, activation.get(f.id) ?? 0));
  const spreadCandidates = [...hop1.entries(), ...hop2.entries()]
    .filter(([, v]) => v >= SPREAD_PARAMS.minActivation)
    .filter(([id]) => factById.has(id))
    .sort((a, b) => b[1] - a[1]);
  for (const [id, v] of spreadCandidates) {
    if (nodes.length >= opts.maxNodes) break;
    nodes.push(toNode(factById.get(id)!, false, v));
  }
  // 种子数超上限:按 activation 截断种子自身(极端情况,保序)
  const capped =
    nodes.length > opts.maxNodes
      ? [...nodes].sort((a, b) => b.activation - a.activation).slice(0, opts.maxNodes)
      : nodes;

  const nodeIds = new Set(capped.map((n) => n.id));
  const edges: SubgraphEdge[] = adj
    .filter((a) => nodeIds.has(a.from) && nodeIds.has(a.to))
    .map((a) => ({
      from: a.from,
      to: a.to,
      kind: a.kind,
      weight: a.weight,
      isNew: opts.lastRemAt !== null && a.createdAt > opts.lastRemAt,
    }));

  return { nodes: capped, edges, globalStats: globalStatsOf(capped, facts, seedFacts.length, "spreading-activation") };
}

/**
 * 消融对照 baseline(spec §三/§九):「importance × truth 排序取种子邻域 top-N」。
 *
 * 不进主路径;与 buildSubgraph 同构输出,供质量度量比较子图命中
 * 人工认可洞察来源的比例。一期实现为种子 + 1-hop 邻居按重要性排序截断
 * (无扩散/无活动维度),差异即扩散激活的贡献。
 */
export function buildBaselineSubgraph(
  repo: EngramRepository,
  opts: BuildSubgraphOpts,
): InsightSubgraph {
  const facts = collectFacts(repo);
  const factById = new Map(facts.map((f) => [f.id, f]));
  const adj = collectAdj(repo);
  const extraSeeds = new Set(opts.extraSeeds ?? []);
  const seedFacts = facts.filter(
    (f) =>
      extraSeeds.has(f.id) ||
      (isEventSeed(f, adj, opts.lastRemAt) &&
        (opts.seedFilter ? opts.seedFilter(f.id) : true)),
  );
  if (seedFacts.length === 0) {
    return { nodes: [], edges: [], globalStats: { seedCount: 0, totalEngrams: facts.length, method: "importance-baseline" } };
  }

  // 1-hop 邻居按 importance × truth 排序补位(baseline 无二跳)
  const nodes: SubgraphNode[] = seedFacts.map((f) =>
    toNode(f, true, f.importance * truthFactorOf(f.verificationStatus)),
  );
  const candidates = new Set<string>();
  for (const seed of seedFacts) {
    for (const a of adj) {
      if (a.from === seed.id && factById.has(a.to)) candidates.add(a.to);
      if (a.to === seed.id && factById.has(a.from)) candidates.add(a.from);
    }
  }
  const ranked = [...candidates]
    .filter((id) => !nodes.some((n) => n.id === id))
    .map((id) => factById.get(id)!)
    .sort(
      (a, b) =>
        b.importance * truthFactorOf(b.verificationStatus) -
        a.importance * truthFactorOf(a.verificationStatus),
    );
  for (const f of ranked) {
    if (nodes.length >= opts.maxNodes) break;
    nodes.push(toNode(f, false, f.importance * truthFactorOf(f.verificationStatus)));
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: SubgraphEdge[] = adj
    .filter((a) => nodeIds.has(a.from) && nodeIds.has(a.to))
    .map((a) => ({
      from: a.from,
      to: a.to,
      kind: a.kind,
      weight: a.weight,
      isNew: opts.lastRemAt !== null && a.createdAt > opts.lastRemAt,
    }));
  return { nodes, edges, globalStats: globalStatsOf(nodes, facts, seedFacts.length, "importance-baseline") };
}

function toNode(f: NodeFact, isSeed: boolean, activation: number): SubgraphNode {
  return {
    id: f.id,
    title: f.title,
    summary: f.summary,
    domainTags: f.domainTags,
    kind: f.kind,
    importance: f.importance,
    confidence: f.confidence,
    verificationStatus: f.verificationStatus,
    retrievalCount: f.retrievalCount,
    failedUses: f.failedUses,
    reinforcementScore: f.reinforcementScore,
    freshness: f.updatedAt,
    isSeed,
    activation: Math.round(activation * 1e6) / 1e6,
  };
}

function globalStatsOf(
  nodes: readonly SubgraphNode[],
  allFacts: readonly NodeFact[],
  seedCount: number,
  method: string,
): Readonly<Record<string, number | string>> {
  const tagCounts = new Map<string, number>();
  const verCounts = new Map<string, number>();
  for (const n of nodes) {
    for (const t of n.domainTags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    const v = n.verificationStatus ?? "unverified";
    verCounts.set(v, (verCounts.get(v) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);
  return {
    method,
    seedCount,
    totalEngrams: allFacts.length,
    subgraphNodes: nodes.length,
    topTags: topTags.join(","),
    ...Object.fromEntries([...verCounts.entries()].map(([k, v]) => [`ver_${k}`, v])),
  };
}
