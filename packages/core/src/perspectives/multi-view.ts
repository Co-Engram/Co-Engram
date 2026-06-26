/**
 * 多视角保留（spec §5.3 机制 3，P3 4.4）
 *
 * 抗认知失调：矛盾 engram 并存且都可检索，不强制消除矛盾。
 *
 * 设计原则：
 *   - 检索时主动展示 contradicts 关系（双方都被返回）
 *   - 不主动排除任一方（避免单视角确认偏误）
 *   - 标注 resolutionState（pending/escalated/contested/...）
 *   - perspective 字段记录 engram 所属视角（"team-a"、"expert-yang"）
 *
 * @module @co-engram/core/perspectives
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramKind, EngramId } from "../types/engram.js";
import type { SynapseResolutionState } from "../types/synapse.js";

/** 单条 contradicts 视图 */
export interface ContradictingView {
  readonly engramId: EngramId;
  readonly title: string;
  readonly kind: EngramKind;
  readonly perspective?: string;
  /** outgoing = center 主动反驳 other；incoming = other 反驳 center */
  readonly direction: "outgoing" | "incoming";
  readonly resolutionState?: SynapseResolutionState;
  readonly synapseId: string;
}

/** 单个 engram 的多视角包 */
export interface MultiViewBundle {
  readonly centerId: EngramId;
  readonly contradictions: readonly ContradictingView[];
}

/** 检索结果 + 附加视图 */
export interface EnrichedResult {
  readonly engramId: EngramId;
  readonly contradictsViews: readonly ContradictingView[];
}

/** contradiction cluster（视角群） */
export interface ContradictionCluster {
  readonly clusterId: string;
  readonly memberIds: readonly EngramId[];
}

const DEFAULT_MAX_VIEWS_PER_RESULT = 5;

/**
 * 收集单个 engram 的所有 contradicts 视图（双向）
 *
 * outgoing: center 的 synapses.outgoing 中 kind=contradicts
 * incoming: 其他 engram 的 outgoing 指向 center 且 kind=contradicts
 */
export function gatherContradictingViews(
  repo: EngramRepository,
  engramId: EngramId,
): MultiViewBundle {
  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }

  const views: ContradictingView[] = [];
  const seen = new Set<string>();

  // === outgoing：center 反驳别人 ===
  const outgoing = repo.readSynapses(engramId).outgoing;
  for (const syn of outgoing) {
    if (syn.kind !== "contradicts") continue;
    if (!repo.exists(syn.to)) continue; // 跳过 dangling
    const other = repo.readEngram(syn.to);
    const key = `out:${syn.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push({
      engramId: other.id,
      title: other.title,
      kind: other.kind,
      perspective: other.perspective,
      direction: "outgoing",
      resolutionState: syn.resolutionState,
      synapseId: syn.id,
    });
  }

  // === incoming：别人反驳 center ===
  for (const entry of repo.listEngrams()) {
    if (entry.id === engramId) continue;
    const file = repo.readSynapses(entry.id);
    for (const syn of file.outgoing) {
      if (syn.kind !== "contradicts") continue;
      if (syn.to !== engramId) continue;
      const other = repo.readEngram(entry.id);
      const key = `in:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      views.push({
        engramId: other.id,
        title: other.title,
        kind: other.kind,
        perspective: other.perspective,
        direction: "incoming",
        resolutionState: syn.resolutionState,
        synapseId: syn.id,
      });
    }
  }

  // 排序：incoming 优先（外部挑战更值得关注），然后按 engramId 字典序
  views.sort((a, b) => {
    if (a.direction !== b.direction) {
      return a.direction === "incoming" ? -1 : 1;
    }
    return a.engramId < b.engramId ? -1 : 1;
  });

  return {
    centerId: engramId,
    contradictions: views,
  };
}

/**
 * 检索结果后处理：对每个结果附加 contradicts 视图
 *
 * 关键设计：本函数**不会从结果中移除任何 engram**，只附加 contradicts 元信息。
 * 即使 other 的 resolutionState=resolved 或 refuted，也仍然返回（保留审计痕迹）。
 *
 * @param resultIds 检索返回的 engram ID 列表
 * @param options.maxViewsPerResult 每个结果最多附加多少个视图（默认 5）
 */
export function enrichWithContradictingViews(
  repo: EngramRepository,
  resultIds: readonly EngramId[],
  options: {
    readonly maxViewsPerResult?: number;
  } = {},
): EnrichedResult[] {
  const maxViews = options.maxViewsPerResult ?? DEFAULT_MAX_VIEWS_PER_RESULT;

  return resultIds.map((id) => {
    if (!repo.exists(id)) {
      return { engramId: id, contradictsViews: [] };
    }
    const bundle = gatherContradictingViews(repo, id);
    return {
      engramId: id,
      contradictsViews: bundle.contradictions.slice(0, maxViews),
    };
  });
}

/**
 * 找出整个仓库的 contradiction clusters（视角群）
 *
 * 算法：把 contradicts synapse 视为无向边，做 Union-Find 找连通分量。
 * 每个 cluster 是一组互相矛盾的 engram（视角群）。
 */
export function findContradictionClusters(
  repo: EngramRepository,
): ContradictionCluster[] {
  // 收集所有 contradicts 边
  const edges: Array<{ a: EngramId; b: EngramId }> = [];
  const allEngrams = new Set<EngramId>();
  for (const entry of repo.listEngrams()) {
    allEngrams.add(entry.id);
    const file = repo.readSynapses(entry.id);
    for (const syn of file.outgoing) {
      if (syn.kind !== "contradicts") continue;
      if (!repo.exists(syn.to)) continue;
      edges.push({ a: entry.id, b: syn.to });
      allEngrams.add(syn.to);
    }
  }

  // Union-Find
  const parent = new Map<EngramId, EngramId>();
  function find(x: EngramId): EngramId {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: EngramId, b: EngramId): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  }

  for (const e of edges) {
    union(e.a, e.b);
  }

  // 收集每个 root 下的成员
  const clusters = new Map<EngramId, EngramId[]>();
  for (const id of allEngrams) {
    const root = find(id);
    const arr = clusters.get(root) ?? [];
    arr.push(id);
    clusters.set(root, arr);
  }

  // 过滤：只保留 ≥ 2 个成员的 cluster（孤立节点不算 cluster）
  const result: ContradictionCluster[] = [];
  for (const [, members] of clusters) {
    if (members.length < 2) continue;
    const sorted = [...members].sort();
    result.push({
      clusterId: `cluster-${sorted[0]!.replace(/\//g, "_")}`,
      memberIds: sorted,
    });
  }

  // 排序：成员数多的优先；同 size 按 clusterId 字典序
  result.sort((a, b) => {
    if (b.memberIds.length !== a.memberIds.length) {
      return b.memberIds.length - a.memberIds.length;
    }
    return a.clusterId < b.clusterId ? -1 : 1;
  });

  return result;
}

/**
 * 统计：仓库中 multi-view 相关指标
 */
export interface MultiViewStats {
  readonly totalContradictsEdges: number;
  readonly activeContradictions: number;
  readonly resolvedContradictions: number;
  readonly clusters: number;
  readonly largestClusterSize: number;
  readonly distinctPerspectives: number;
}

export function computeMultiViewStats(repo: EngramRepository): MultiViewStats {
  let totalEdges = 0;
  let active = 0;
  let resolved = 0;
  const perspectives = new Set<string>();

  for (const entry of repo.listEngrams()) {
    const engram = repo.readEngram(entry.id);
    if (engram.perspective) perspectives.add(engram.perspective);
    const file = repo.readSynapses(entry.id);
    for (const syn of file.outgoing) {
      if (syn.kind !== "contradicts") continue;
      totalEdges += 1;
      const status = syn.resolutionState?.status;
      if (status === "resolved" || status === "auto_resolved") {
        resolved += 1;
      } else {
        active += 1;
      }
    }
  }

  const clusters = findContradictionClusters(repo);
  const largest = clusters.reduce((m, c) => Math.max(m, c.memberIds.length), 0);

  return {
    totalContradictsEdges: totalEdges,
    activeContradictions: active,
    resolvedContradictions: resolved,
    clusters: clusters.length,
    largestClusterSize: largest,
    distinctPerspectives: perspectives.size,
  };
}
