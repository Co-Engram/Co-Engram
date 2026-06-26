/**
 * Tier Loader：按需加载 EngramView
 *
 * 把 engram-tools 里的 readEngramView 逻辑提取出来，
 * 给 disclosure 模块复用，并加 token 估算。
 *
 * 升级路径：Catalog → Digest → Content → Meta → Synapse
 *   - Catalog：仅 id/title/kind/domainTags（~50 token）
 *   - Digest：+ summary/importance/freshness（~120 token）
 *   - Content：+ 完整 Markdown（变长）
 *   - Meta：+ 全部 meta 字段（除 content）
 *   - Synapse：+ outgoing/incoming/neighborDigests
 *
 * @module @co-engram/core/disclosure
 */

import type {
  EngramCatalogEntry,
  EngramDigest,
  Engram,
  EngramId,
} from "../types/engram.js";
import type {
  DisclosureTier,
  EngramView,
  SynapseBundle,
} from "../types/disclosure.js";
import type { Synapse } from "../types/synapse.js";
import type { EngramRepository } from "../storage/repository.js";
import { estimateTokens } from "./budget.js";

/**
 * 视图大小估算（单位：token）
 *
 * 用于 budget 检查；与实际序列化后的 token 数会有误差，
 * 但数量级一致。
 */
export function estimateViewSize(
  tier: DisclosureTier,
  preview: {
    contentSize?: number;
    outgoingCount?: number;
    incomingCount?: number;
  },
): number {
  const contentTokens = preview.contentSize
    ? Math.ceil(preview.contentSize / 2)
    : 0;
  const edgeTokens =
    (preview.outgoingCount ?? 0) + (preview.incomingCount ?? 0);
  switch (tier) {
    case "catalog":
      // id + title + kind + domainTags ~ 30-60 token
      return 50;
    case "digest":
      // + summary + importance + freshness
      return 120;
    case "content":
      // digest + 完整正文
      return 120 + contentTokens;
    case "meta":
      // digest + 所有 meta 字段
      return 300;
    case "synapses":
      // digest + edges + neighbor digests
      return 120 + edgeTokens * 20;
  }
}

/**
 * 按 tier 加载 EngramView
 *
 * 与 engram-tools.readEngramView 行为一致，
 * 但单独导出便于 disclosure 模块和未来 agent 复用。
 */
export function loadView(
  repo: EngramRepository,
  id: EngramId,
  tier: DisclosureTier,
): EngramView {
  switch (tier) {
    case "catalog": {
      const entry = repo.readCatalogEntry(id);
      if (!entry) throw new Error(`Engram not found: ${id}`);
      return { tier: "catalog", entry };
    }
    case "digest": {
      const digest = repo.readDigest(id);
      if (!digest) throw new Error(`Engram not found: ${id}`);
      return { tier: "digest", digest };
    }
    case "content": {
      const engram = repo.readEngram(id);
      return {
        tier: "content",
        entry: toCatalogEntry(engram),
        content: engram.content,
      };
    }
    case "meta": {
      const engram = repo.readEngram(id);
      return {
        tier: "meta",
        entry: toCatalogEntry(engram),
        meta: stripContentFromMeta(engram),
      };
    }
    case "synapses": {
      const entry = repo.readCatalogEntry(id);
      if (!entry) throw new Error(`Engram not found: ${id}`);
      const outgoingFile = repo.readSynapses(id);
      const incoming = collectIncoming(repo, id);
      const neighborDigests = collectNeighborDigests(
        repo,
        outgoingFile.outgoing,
        incoming,
      );
      const bundle: SynapseBundle = {
        engramId: id,
        outgoing: outgoingFile.outgoing,
        incoming,
        neighborDigests,
      };
      return { tier: "synapses", bundle };
    }
  }
}

/** tier 排序：catalog < digest < content/meta < synapses */
const TIER_ORDER: ReadonlyArray<DisclosureTier> = [
  "catalog",
  "digest",
  "content",
  "meta",
  "synapses",
];

/**
 * 比较两个 tier 的"粒度等级"
 *
 * 返回：负数表示 a < b，0 表示相等，正数表示 a > b
 */
export function compareTier(a: DisclosureTier, b: DisclosureTier): number {
  return TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b);
}

/**
 * 从 EngramView 提取 engram id
 */
export function viewIdOf(view: EngramView): EngramId {
  switch (view.tier) {
    case "catalog":
      return view.entry.id;
    case "digest":
      return view.digest.id;
    case "content":
    case "meta":
      return view.entry.id;
    case "synapses":
      return view.bundle.engramId;
  }
}

/**
 * 升级视图到更高 tier
 *
 * 若 target 粒度低于或等于 current，直接返回 current（不降级）。
 */
export function upgradeView(
  repo: EngramRepository,
  current: EngramView,
  target: DisclosureTier,
): { view: EngramView; tierChanged: boolean } {
  const currentId = viewIdOf(current);
  if (compareTier(target, current.tier) <= 0) {
    return { view: current, tierChanged: false };
  }
  return {
    view: loadView(repo, currentId, target),
    tierChanged: true,
  };
}

/** 估算已加载视图的 token 数（实际序列化后） */
export function estimateLoadedTokens(view: EngramView): number {
  switch (view.tier) {
    case "catalog":
      return (
        estimateTokens(view.entry.id) + estimateTokens(view.entry.title) + 10
      );
    case "digest":
      return (
        estimateTokens(view.digest.id) +
        estimateTokens(view.digest.title) +
        estimateTokens(view.digest.summary) +
        20
      );
    case "content":
      return (
        estimateTokens(view.entry.id) +
        estimateTokens(view.entry.title) +
        estimateTokens(view.content) +
        20
      );
    case "meta":
      return estimateTokens(JSON.stringify(view.meta));
    case "synapses": {
      const neighborTokens = view.bundle.neighborDigests.reduce(
        (sum, d) => sum + estimateTokens(d.title) + estimateTokens(d.summary),
        0,
      );
      const edgeTokens =
        (view.bundle.outgoing.length + view.bundle.incoming.length) * 15;
      return neighborTokens + edgeTokens + 30;
    }
  }
}

// ============================================================
// 内部辅助（与 engram-tools.ts 保持一致，未来可合并）
// ============================================================

function toCatalogEntry(engram: Engram): EngramCatalogEntry {
  return {
    id: engram.id,
    title: engram.title,
    kind: engram.kind,
    domainTags: engram.domainTags,
  };
}

function stripContentFromMeta(engram: Engram): Record<string, unknown> {
  const { content: _content, ...rest } = engram;
  return rest as unknown as Record<string, unknown>;
}

function collectIncoming(
  repo: EngramRepository,
  id: string,
): readonly Synapse[] {
  const all = repo.collectAllSynapses();
  return all
    .filter(({ synapse }) => synapse.to === id)
    .map(({ synapse }) => synapse);
}

function collectNeighborDigests(
  repo: EngramRepository,
  outgoing: readonly { to: string }[],
  incoming: readonly { from: string }[],
): readonly EngramDigest[] {
  const neighborIds = new Set<string>();
  for (const s of outgoing) neighborIds.add(s.to);
  for (const s of incoming) neighborIds.add(s.from);
  const digests: EngramDigest[] = [];
  for (const nid of neighborIds) {
    const d = repo.readDigest(nid);
    if (d) digests.push(d);
  }
  return digests;
}
