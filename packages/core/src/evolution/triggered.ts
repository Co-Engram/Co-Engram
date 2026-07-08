/**
 * 触发式进化（A-MEM，spec §5.2 路径 1）
 *
 * 新 engram 写入时，立即触发局部联想更新：
 *   1. 重叠检测：domainTags / contextTags 与已有 engram 重叠
 *   2. Synapse 权重重塑：
 *      - 无连接 + 重叠 → 创建 similar_to（弱权重）
 *      - 已有连接 + 重叠 → 权重提升（Hebbian 强化）
 *   3. 模式重复检测：同 kind + 同 domainTags 多次出现 → 累计计数
 *      (供 REM 做梦消费，达到阈值时升级为 pattern)
 *   4. 潜在 contradiction 检测：kind 不同但内容关键词重叠 → 返回候选对
 *      (contradicts synapse 由调用方/人工确认，不自动创建)
 *
 * 范围：局部（只处理与 newEngram 重叠的 engram），毫秒级。
 *
 * @module @co-engram/core/evolution
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramKind, EngramId } from "../types/engram.js";
import { randomUUID } from "node:crypto";

/** 触发式进化的默认配置 */
export interface TriggeredEvolutionConfig {
  /** domainTags 重叠的最小数量（默认 1） */
  readonly minDomainTagOverlap: number;
  /** contextTags 重叠的最小数量（默认 1） */
  readonly minContextTagOverlap: number;
  /** 新建 similar_to synapse 的初始权重（默认 0.3） */
  readonly newSynapseWeight: number;
  /** 已有 synapse 的权重提升（默认 0.05） */
  readonly synapseBoost: number;
  /** 权重上限（默认 1.0） */
  readonly maxSynapseWeight: number;
  /** 潜在 contradiction 关键词最小重叠（默认 2） */
  readonly minContradictionKeywordOverlap: number;
  /** 是否排除自身（默认 true） */
  readonly excludeSelf: boolean;
}

export const DEFAULT_TRIGGERED_CONFIG: TriggeredEvolutionConfig = {
  minDomainTagOverlap: 1,
  minContextTagOverlap: 1,
  newSynapseWeight: 0.3,
  synapseBoost: 0.05,
  maxSynapseWeight: 1.0,
  minContradictionKeywordOverlap: 2,
  excludeSelf: true,
};

/** 重塑的单条 synapse 操作记录 */
export interface SynapseReshapeRecord {
  readonly otherEngramId: EngramId;
  readonly action: "created" | "boosted" | "skipped_existing_max";
  readonly kind: "similar_to";
  readonly weight: number;
  readonly previousWeight?: number;
  readonly reason: string;
}

/** 模式重复检测记录 */
export interface PatternRepeatRecord {
  readonly kind: EngramKind;
  readonly domainTagsKey: string;
  readonly occurrences: number;
  readonly siblingIds: readonly EngramId[];
}

/** 潜在矛盾候选对（不自动创建 contradicts synapse） */
export interface PotentialContradictionRecord {
  readonly otherEngramId: EngramId;
  readonly newKind: EngramKind;
  readonly otherKind: EngramKind;
  readonly sharedKeywords: readonly string[];
  readonly reason: string;
}

/** 触发式进化结果 */
export interface TriggeredEvolutionResult {
  readonly newEngramId: EngramId;
  /** 找到的重叠 engram 总数 */
  readonly overlapCount: number;
  /** synapse 重塑记录 */
  readonly reshapings: readonly SynapseReshapeRecord[];
  /** 模式重复记录 */
  readonly patternRepeats: readonly PatternRepeatRecord[];
  /** 潜在矛盾候选对（供人工/上层确认） */
  readonly potentialContradictions: readonly PotentialContradictionRecord[];
  /** 执行耗时（毫秒） */
  readonly durationMs: number;
  /** 是否实际落盘 */
  readonly persisted: boolean;
}

/**
 * 触发式进化：新 engram 写入钩子
 *
 * 主流程：
 *   1. 读 newEngram + 列出所有 active engram
 *   2. 对每个 candidate：
 *      - 计算 domainTags + contextTags 重叠
 *      - 满足阈值 → 重塑 synapse（创建 or 强化）
 *      - kind 不同 + 内容关键词重叠 → 记为潜在 contradiction
 *   3. 模式重复检测：按 (kind, domainTags 组合 key) 分组计数
 *
 * 稳定扫描：candidates 按 id 字典序（prompt cache 友好）
 */
export function onEngramCreated(
  repo: EngramRepository,
  newEngramId: EngramId,
  options: {
    readonly config?: Partial<TriggeredEvolutionConfig>;
    readonly nowIso?: string;
    readonly persist?: boolean;
  } = {},
): TriggeredEvolutionResult {
  const startMs = Date.now();
  if (!repo.exists(newEngramId)) {
    throw new Error(`Engram not found: ${newEngramId}`);
  }
  const cfg: TriggeredEvolutionConfig = {
    ...DEFAULT_TRIGGERED_CONFIG,
    ...options.config,
  };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const persist = options.persist ?? true;

  const newEngram = repo.readEngram(newEngramId);
  const newDomainSet = new Set(newEngram.domainTags);
  const newContextSet = new Set(newEngram.contextTags);
  const newKeywords = extractKeywords(newEngram.content);

  const reshapings: SynapseReshapeRecord[] = [];
  const potentialContradictions: PotentialContradictionRecord[] = [];

  // 列出所有候选（排除自身）
  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  let overlapCount = 0;

  // 收集 newEngram 的 outgoing synapses（用于判断是否已有连接）
  const newSynapses = repo.readSynapses(newEngramId).outgoing;
  const existingOutgoing = new Set(
    newSynapses.map((s) => `${s.to}::${s.kind}`),
  );

  // 模式重复 key 收集（newEngram 自己也算一次）
  const patternBuckets = new Map<
    string,
    { kind: EngramKind; ids: EngramId[] }
  >();
  const newPatternKey = patternKey(newEngram.kind, newEngram.domainTags);
  patternBuckets.set(newPatternKey, {
    kind: newEngram.kind,
    ids: [newEngramId],
  });

  // 性能修复(2026-07):消除循环内 readEngram N+1,
  // triggeredConsolidation 在新 engram 落库后被调用,N=仓库总数,
  // 在 1000+ engrams 规模下原 N+1 实现 30s+ 卡死 viewer。
  // 同时需要 digest(status/kind/domainTags/contextTags)+ content(extractKeywords 用)。
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );
  const contentById = new Map(
    repo.readContentBatch(allIds).map((c) => [c.id, c] as const),
  );

  for (const entry of entries) {
    if (cfg.excludeSelf && entry.id === newEngramId) continue;

    const other = digestById.get(entry.id);
    const otherContent = contentById.get(entry.id);
    if (!other || !otherContent) continue;
    if (other.status !== "active") continue;

    // 模式重复检测
    const otherPatternKey = patternKey(
      other.kind as EngramKind,
      other.domainTags,
    );
    const bucket = patternBuckets.get(otherPatternKey);
    if (bucket) {
      bucket.ids.push(other.id);
    } else {
      patternBuckets.set(otherPatternKey, {
        kind: other.kind as EngramKind,
        ids: [other.id],
      });
    }

    // 计算 tag 重叠
    const domainOverlap = countOverlap(newDomainSet, other.domainTags);
    const contextOverlap = countOverlap(newContextSet, other.contextTags);
    const domainOk = domainOverlap >= cfg.minDomainTagOverlap;
    const contextOk = contextOverlap >= cfg.minContextTagOverlap;

    if (!domainOk && !contextOk) continue;
    overlapCount += 1;

    // 检查是否已有 similar_to 连接（任一方向）
    const key = `${other.id}::similar_to`;
    const reverseKey = `${newEngramId}::similar_to`; // outgoing from other
    const hasOutgoing = existingOutgoing.has(key);
    const hasIncoming = repo
      .readSynapses(other.id)
      .outgoing.some((s) => s.to === newEngramId && s.kind === "similar_to");

    if (hasOutgoing) {
      // 已有 outgoing → boost 权重
      const existing = newSynapses.find(
        (s) => s.to === other.id && s.kind === "similar_to",
      )!;
      const newWeight = Math.min(
        cfg.maxSynapseWeight,
        existing.weight + cfg.synapseBoost,
      );
      if (newWeight === existing.weight) {
        reshapings.push({
          otherEngramId: other.id,
          action: "skipped_existing_max",
          kind: "similar_to",
          weight: existing.weight,
          previousWeight: existing.weight,
          reason: "already at max weight",
        });
      } else {
        if (persist) {
          boostSynapseWeight(repo, newEngramId, existing.id, newWeight, nowIso);
        }
        reshapings.push({
          otherEngramId: other.id,
          action: "boosted",
          kind: "similar_to",
          weight: newWeight,
          previousWeight: existing.weight,
          reason: `domainOverlap=${domainOverlap}, contextOverlap=${contextOverlap}`,
        });
      }
    } else if (!hasIncoming) {
      // 无连接 → 创建 similar_to
      if (persist) {
        repo.addOutgoingSynapse(newEngramId, {
          id: `trig-${randomUUID().slice(0, 12)}`,
          from: newEngramId,
          to: other.id,
          kind: "similar_to",
          weight: cfg.newSynapseWeight,
          direction: "bidirectional",
          evidence: [
            {
              description: `triggered evolution: domainOverlap=${domainOverlap}, contextOverlap=${contextOverlap}`,
              addedAt: nowIso,
              addedBy: "triggered-evolution",
            },
          ],
          createdBy: "triggered-evolution",
          createdAt: nowIso,
          updatedAt: nowIso,
          retrievalWeight: cfg.newSynapseWeight,
          visibility: "public",
        });
      }
      reshapings.push({
        otherEngramId: other.id,
        action: "created",
        kind: "similar_to",
        weight: cfg.newSynapseWeight,
        reason: `domainOverlap=${domainOverlap}, contextOverlap=${contextOverlap}`,
      });
    }

    // 潜在 contradiction 检测：kind 不同 + 关键词重叠
    if (other.kind !== newEngram.kind) {
      const otherKeywords = extractKeywords(otherContent.content);
      const sharedKeywords = intersect(newKeywords, otherKeywords);
      if (sharedKeywords.length >= cfg.minContradictionKeywordOverlap) {
        potentialContradictions.push({
          otherEngramId: other.id,
          newKind: newEngram.kind,
          otherKind: other.kind as EngramKind,
          sharedKeywords,
          reason: `kind mismatch (${newEngram.kind} vs ${other.kind}) + ${sharedKeywords.length} shared keywords`,
        });
      }
    }
  }

  // 模式重复记录（只保留 occurrences >= 2 的）
  const patternRepeats: PatternRepeatRecord[] = [];
  for (const [key, bucket] of patternBuckets) {
    if (bucket.ids.length >= 2) {
      patternRepeats.push({
        kind: bucket.kind,
        domainTagsKey: key,
        occurrences: bucket.ids.length,
        siblingIds: [...bucket.ids].sort(),
      });
    }
  }
  patternRepeats.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.domainTagsKey < b.domainTagsKey ? -1 : 1;
  });

  return {
    newEngramId,
    overlapCount,
    reshapings,
    patternRepeats,
    potentialContradictions,
    durationMs: Date.now() - startMs,
    persisted: persist,
  };
}

/**
 * 触发式进化处理器工厂
 *
 * 返回一个 handler 函数，供 host 在 engram_create 后调用。
 *
 * 用法：
 *   const handler = createTriggeredEvolutionHandler(repo)
 *   // ...在 engram_create 工具 execute 后:
 *   handler(newEngramId)
 */
export function createTriggeredEvolutionHandler(
  repo: EngramRepository,
  config?: Partial<TriggeredEvolutionConfig>,
): (engramId: EngramId) => TriggeredEvolutionResult {
  return (engramId) => onEngramCreated(repo, engramId, { config });
}

// ============================================================
// 辅助函数
// ============================================================

function countOverlap(set: Set<string>, list: readonly string[]): number {
  let n = 0;
  for (const item of list) {
    if (set.has(item)) n += 1;
  }
  return n;
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const bset = new Set(b);
  const result: string[] = [];
  for (const x of a) {
    if (bset.has(x)) result.push(x);
  }
  return result;
}

/**
 * 简易关键词提取（中文按 2-gram，英文按 word）
 *
 * 与 dedup 的 TokenJaccardSimilarityEngine 一致。
 */
function extractKeywords(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  // 英文 word
  const enWords = trimmed.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? [];
  tokens.push(...enWords.map((w) => w.toLowerCase()));
  // 中文 bigram
  const cn = trimmed.match(/[一-鿿]+/g) ?? [];
  for (const seg of cn) {
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
  }
  return [...new Set(tokens)];
}

function patternKey(kind: EngramKind, domainTags: readonly string[]): string {
  return `${kind}|${[...domainTags].sort().join(",")}`;
}

function boostSynapseWeight(
  repo: EngramRepository,
  fromId: EngramId,
  synapseId: string,
  newWeight: number,
  nowIso: string,
): void {
  const file = repo.readSynapses(fromId);
  const target = file.outgoing.find((s) => s.id === synapseId);
  if (!target) return;
  // 通过 replaceSynapseEvidence 同样的私有路径... 实际上需要专门方法
  // 简化：使用 repo 的 addOutgoingSynapse 不行（追加），需要替换。
  // 我们用 replaceSynapseEvidence 间接 → 不行，那是 evidence-only。
  // 折中：直接调 repo.updateSynapseWeight（如果存在）；否则删除+重建。
  repo.replaceSynapse(fromId, synapseId, {
    ...target,
    weight: newWeight,
    updatedAt: nowIso,
  });
}
