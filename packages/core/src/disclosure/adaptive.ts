/**
 * Adaptive Disclosure：按预算自动选择 tier
 *
 * 实现 spec 3.2 的 adaptiveDisclosure 伪代码：
 *
 *   candidates = semanticSearch(query)
 *   loaded = { c.id: c.toCatalogEntry() for c in candidates }  // 阶段 1
 *   for c in sortByScore(candidates):                          // 阶段 2
 *     if budget.remaining > c.digestSize:
 *       upgrade(c, 'digest')
 *   for c in topK(candidates, k=adaptive):                     // 阶段 3
 *     if budget.remaining > c.contentSize:
 *       upgrade(c, 'content')
 *   // 阶段 4：meta/synapse 由 agent 显式请求
 *
 * 关键特性：
 *   - 每个 engram 独立决定 tier（不是全量分层）
 *   - budget 不可用时（remaining ≤ 0）停止升级
 *   - 相同输入产生相同输出（prompt cache 友好）
 *
 * @module @co-engram/core/disclosure
 */

import type { EngramId } from "../types/engram.js";
import type {
  ContextBudget,
  DisclosureTier,
  EngramView,
} from "../types/disclosure.js";
import type { EngramRepository } from "../storage/repository.js";
import type { DigestLine } from "../index/types.js";
import { consume, hasBudget } from "./budget.js";
import { estimateViewSize, loadView, viewIdOf } from "./tier-loader.js";

/** 自适应披露输入 */
export interface AdaptiveDisclosureInput {
  /** 仓库（用于按需加载 tier） */
  readonly repository: EngramRepository;
  /** 候选集（含 score；通常来自 SearchOrchestrator） */
  readonly candidates: ReadonlyArray<{ id: EngramId; score: number }>;
  /** 候选的 DigestLine（用于预估大小） */
  readonly digestLines: Readonly<Record<EngramId, DigestLine>>;
  /** Token 预算（会被消耗，返回剩余） */
  readonly budget: ContextBudget;
  /** Top-K 升级到 content 的 K 值（默认 min(5, candidates.length)） */
  readonly topK?: number;
  /** 摘要层（阶段 2 升级上限；默认全升级） */
  readonly maxDigestUpgrades?: number;
}

/** 单条加载结果 */
export interface LoadedEntry {
  readonly id: EngramId;
  readonly score: number;
  readonly view: EngramView;
}

/** 自适应披露输出 */
export interface AdaptiveDisclosureResult {
  /** 加载的视图（按原 candidates 顺序） */
  readonly loaded: readonly LoadedEntry[];
  /** 实际消耗的 token 数（所有视图累加） */
  readonly tokensUsed: number;
  /** 剩余预算 */
  readonly budgetRemaining: number;
  /** 各 tier 分布：tier → count */
  readonly tierBreakdown: Readonly<Record<DisclosureTier, number>>;
  /** 触发的阶段（1=catalog、2=digest、3=content） */
  readonly reachedStage: 1 | 2 | 3;
}

const EMPTY_BREAKDOWN: Record<DisclosureTier, number> = {
  catalog: 0,
  digest: 0,
  content: 0,
  meta: 0,
  synapses: 0,
};

/**
 * 执行自适应披露
 *
 * 算法（严格按 spec 顺序）：
 *   1. 所有候选加载为 catalog
 *   2. 按 score 倒序，逐个升级到 digest（若预算够）
 *   3. Top-K（默认 min(5, len)）升级到 content（若预算够）
 *   4. meta/synapse 留给 agent 显式请求
 *
 * 顺序稳定性：同 score 的 candidates 保持原数组顺序（稳定排序）。
 */
export function adaptiveDisclosure(
  input: AdaptiveDisclosureInput,
): AdaptiveDisclosureResult {
  const {
    repository,
    candidates,
    digestLines,
    budget,
    topK,
    maxDigestUpgrades,
  } = input;
  const breakdown: Record<DisclosureTier, number> = { ...EMPTY_BREAKDOWN };

  // 候选索引，便于阶段 2/3 复用
  const workingBudget = { ...budget };
  const views = new Map<EngramId, EngramView>();
  let tokensUsed = 0;

  // ---- 阶段 1：全部 catalog ----
  for (const c of candidates) {
    const line = digestLines[c.id];
    const size = estimateViewSize("catalog", line ?? {});
    if (!hasBudget(workingBudget, size)) {
      // 预算不足以容纳 catalog：直接跳过（不入结果）
      continue;
    }
    const view = safeLoad(repository, c.id, "catalog");
    if (!view) continue;
    views.set(c.id, view);
    workingBudget.remaining -= size;
    tokensUsed += size;
    breakdown.catalog += 1;
  }

  let reachedStage: 1 | 2 | 3 = 1;
  if (views.size === 0) {
    return finalize(
      views,
      candidates,
      tokensUsed,
      workingBudget.remaining,
      breakdown,
      reachedStage,
    );
  }

  // ---- 阶段 2：digest 升级 ----
  const sortedByScore = stableSortByScoreDesc(candidates);
  const digestCap =
    maxDigestUpgrades !== undefined
      ? Math.max(0, maxDigestUpgrades)
      : Number.POSITIVE_INFINITY;
  let digestUpgraded = 0;
  for (const c of sortedByScore) {
    if (digestUpgraded >= digestCap) break;
    const line = digestLines[c.id];
    const size = estimateViewSize("digest", line ?? {});
    if (!hasBudget(workingBudget, size)) break;
    const view = safeLoad(repository, c.id, "digest");
    if (!view) continue;
    // catalog → digest：补差额（digest 大小 - catalog 大小）
    const catalogSize = estimateViewSize("catalog", line ?? {});
    workingBudget.remaining -= size - catalogSize;
    tokensUsed += size - catalogSize;
    views.set(c.id, view);
    breakdown.catalog -= 1;
    breakdown.digest += 1;
    digestUpgraded += 1;
  }
  if (breakdown.digest > 0) {
    reachedStage = 2;
  }

  // ---- 阶段 3：top-K content 升级 ----
  const k = Math.min(topK ?? DEFAULT_TOP_K, sortedByScore.length);
  for (let i = 0; i < k; i++) {
    const c = sortedByScore[i];
    if (!c) break;
    const line = digestLines[c.id];
    const size = estimateViewSize("content", line ?? {});
    if (!hasBudget(workingBudget, size)) break;
    const view = safeLoad(repository, c.id, "content");
    if (!view) continue;
    // digest → content：补差额
    const digestSize = estimateViewSize("digest", line ?? {});
    workingBudget.remaining -= size - digestSize;
    tokensUsed += size - digestSize;
    views.set(c.id, view);
    breakdown.digest -= 1;
    breakdown.content += 1;
  }
  if (breakdown.content > 0) {
    reachedStage = 3;
  }

  return finalize(
    views,
    candidates,
    tokensUsed,
    workingBudget.remaining,
    breakdown,
    reachedStage,
  );
}

const DEFAULT_TOP_K = 5;

function safeLoad(
  repo: EngramRepository,
  id: EngramId,
  tier: DisclosureTier,
): EngramView | null {
  try {
    return loadView(repo, id, tier);
  } catch {
    return null;
  }
}

function stableSortByScoreDesc<T extends { id: EngramId; score: number }>(
  candidates: ReadonlyArray<T>,
): T[] {
  return [...candidates]
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => {
      if (a.c.score !== b.c.score) return b.c.score - a.c.score;
      return a.idx - b.idx; // 稳定排序
    })
    .map((x) => x.c);
}

function finalize(
  views: Map<EngramId, EngramView>,
  candidates: ReadonlyArray<{ id: EngramId; score: number }>,
  tokensUsed: number,
  budgetRemaining: number,
  breakdown: Record<DisclosureTier, number>,
  reachedStage: 1 | 2 | 3,
): AdaptiveDisclosureResult {
  const loaded: LoadedEntry[] = [];
  for (const c of candidates) {
    const view = views.get(c.id);
    if (view) {
      loaded.push({ id: c.id, score: c.score, view });
    }
  }
  return {
    loaded,
    tokensUsed,
    budgetRemaining,
    tierBreakdown: breakdown,
    reachedStage,
  };
}

/**
 * 在自适应结果之上，按 agent 请求升级单个 engram 到指定 tier
 *
 * 用于阶段 4（meta / synapse）的按需请求。
 */
export function upgradeSingle(
  repository: EngramRepository,
  current: EngramView,
  target: DisclosureTier,
  budget: ContextBudget,
): { view: EngramView; budget: ContextBudget; tierChanged: boolean } {
  const size = estimateViewSize(target, viewPreview(current));
  if (!hasBudget(budget, size)) {
    return { view: current, budget, tierChanged: false };
  }
  const id = viewIdOf(current);
  if (!id) {
    return { view: current, budget, tierChanged: false };
  }
  try {
    const view = loadView(repository, id, target);
    return { view, budget: consume(budget, size), tierChanged: true };
  } catch {
    return { view: current, budget, tierChanged: false };
  }
}

function viewPreview(view: EngramView): {
  contentSize?: number;
  outgoingCount?: number;
  incomingCount?: number;
} {
  switch (view.tier) {
    case "digest":
      return { contentSize: view.digest.contentSize };
    case "content":
      return { contentSize: view.content.length };
    case "synapses":
      return {
        outgoingCount: view.bundle.outgoing.length,
        incomingCount: view.bundle.incoming.length,
      };
    default:
      return {};
  }
}
