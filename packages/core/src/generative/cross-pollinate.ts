/**
 * 跨域授粉（spec §5.3 机制 4，P3 4.3）
 *
 * 发现跨领域类比（创造性思维）。
 *
 * 算法：
 *   1. 计算每个 domain 的结构指纹：
 *      - SynapseKind 分布（structural/causal/evidential/...）
 *      - EngramKind 分布（observation/fact/...）
 *      - 平均 importance / confidence
 *   2. 计算两个 domain 的结构相似度（Cosine similarity on synapse kind 向量）
 *   3. 相似度 ≥ threshold → 调 Provider 生成类比描述
 *   4. 可选创建 hypothesis engram 记录类比（kind=hypothesis, domainTags=[A,B]）
 *
 * 默认启发式：基于结构向量相似度 + 模板化类比描述。
 * 生产实现：宿主注入 LLM provider 做真正的语义类比。
 *
 * @module @co-engram/core/generative
 */

import { randomUUID } from "node:crypto";
import type { EngramRepository } from "../storage/repository.js";
import type { EngramKind } from "../types/engram.js";
import type { SynapseKind } from "../types/synapse.js";

/** Domain 结构指纹 */
export interface DomainProfile {
  readonly domain: string;
  readonly engramCount: number;
  readonly kindDistribution: Record<EngramKind, number>;
  readonly synapseDistribution: Record<SynapseKind, number>;
  readonly avgImportance: number;
  readonly avgConfidence: number;
}

/** Provider 输入 */
export interface CrossPollinationProviderInput {
  readonly domainA: string;
  readonly profileA: DomainProfile;
  readonly domainB: string;
  readonly profileB: DomainProfile;
  readonly structuralSimilarity: number;
  readonly sampleEngramsA: ReadonlyArray<{ title: string; content: string }>;
  readonly sampleEngramsB: ReadonlyArray<{ title: string; content: string }>;
}

/** Provider 输出 */
export interface CrossPollinationProviderOutput {
  readonly analogy: string;
  readonly sharedPrinciple: string;
  readonly confidence: number;
  readonly reason: string;
}

/** 跨域授粉 Provider 接口 */
export interface CrossPollinationProvider {
  generate(
    input: CrossPollinationProviderInput,
  ): Promise<CrossPollinationProviderOutput> | CrossPollinationProviderOutput;
}

/** crossPollinate 单条输入 */
export interface CrossPollinatePairInput {
  readonly domainA: string;
  readonly domainB: string;
  readonly createdBy: string;
  /** 自动采纳阈值（默认 0.5） */
  readonly autoAdoptionThreshold?: number;
  /** 是否创建 hypothesis engram 记录类比（默认 false） */
  readonly createHypothesis?: boolean;
  readonly nowIso?: string;
}

/** crossPollinate 单条结果 */
export interface CrossPollinationResult {
  readonly domainA: string;
  readonly domainB: string;
  readonly structuralSimilarity: number;
  readonly profileA: DomainProfile;
  readonly profileB: DomainProfile;
  readonly analogy: CrossPollinationProviderOutput | null;
  readonly adopted: boolean;
  readonly engramId: string | null;
  readonly reason: string;
}

/** findCrossDomainCandidates 结果 */
export interface CrossDomainCandidate {
  readonly domainA: string;
  readonly domainB: string;
  readonly similarity: number;
}

/** 默认配置 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_ADOPTION_THRESHOLD = 0.5;
const SAMPLE_SIZE = 3;

// ============================================================
// 默认启发式 Provider
// ============================================================

/**
 * 默认启发式跨域类比 Provider（无 LLM）
 *
 * 模板化输出：
 *   - analogy: "{domainA} 的 {topKindA} 模式与 {domainB} 的 {topKindB} 模式结构同构"
 *   - sharedPrinciple: 基于 top synapse kind 推断
 *   - confidence = structuralSimilarity
 */
export class LocalHeuristicCrossPollinationProvider implements CrossPollinationProvider {
  generate(
    input: CrossPollinationProviderInput,
  ): CrossPollinationProviderOutput {
    const topKindA = topKey(input.profileA.synapseDistribution);
    const topKindB = topKey(input.profileB.synapseDistribution);

    if (input.structuralSimilarity < DEFAULT_SIMILARITY_THRESHOLD) {
      return {
        analogy: `${input.domainA} 与 ${input.domainB} 的结构相似度不足（${input.structuralSimilarity.toFixed(2)}），无明显类比`,
        sharedPrinciple: "N/A",
        confidence: input.structuralSimilarity,
        reason: `structuralSimilarity ${input.structuralSimilarity.toFixed(2)} < threshold ${DEFAULT_SIMILARITY_THRESHOLD}`,
      };
    }

    const sameTopKind = topKindA === topKindB;
    const analogy = sameTopKind
      ? `${input.domainA} 与 ${input.domainB} 都以 ${topKindA} 为主导连接模式，存在结构同构`
      : `${input.domainA}（${topKindA}）与 ${input.domainB}（${topKindB}）虽然主导连接不同，但整体结构相似度为 ${input.structuralSimilarity.toFixed(2)}`;

    const principle = sameTopKind
      ? `两个领域都通过 ${topKindA} 组织知识，可能共享相同的认知结构`
      : `两个领域结构相似但主导关系不同，可探索深层共同原理`;

    return {
      analogy,
      sharedPrinciple: principle,
      confidence: input.structuralSimilarity,
      reason: `cosine similarity ${input.structuralSimilarity.toFixed(2)} based on synapse kind distribution`,
    };
  }
}

// ============================================================
// 主 API
// ============================================================

/**
 * 计算单个 domain 的结构指纹
 */
export function computeDomainProfile(
  repo: EngramRepository,
  domain: string,
): DomainProfile | null {
  // 性能修复(2026-07):消除循环内 readEngram N+1
  type ProfileEngram = {
    readonly id: string;
    readonly kind: EngramKind;
    readonly importance: number;
    readonly confidence: number;
  };
  const all = repo.listEngrams();
  const allIds = all.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );

  const engrams: ProfileEngram[] = [];
  for (const entry of all) {
    const digest = digestById.get(entry.id);
    if (!digest) continue;
    if (digest.status !== "active") continue;
    if (!digest.domainTags.includes(domain)) continue;
    engrams.push({
      id: digest.id,
      kind: digest.kind as EngramKind,
      importance: digest.importance,
      confidence: digest.confidence,
    });
  }

  if (engrams.length === 0) return null;

  const kindDistribution: Record<EngramKind, number> = {
    observation: 0,
    fact: 0,
    pattern: 0,
    procedure: 0,
    hypothesis: 0,
  };
  let importanceSum = 0;
  let confidenceSum = 0;

  for (const e of engrams) {
    kindDistribution[e.kind] += 1;
    importanceSum += e.importance;
    confidenceSum += e.confidence;
  }

  // 统计该 domain 下所有 engram 的 outgoing synapses
  const synapseDistribution: Record<SynapseKind, number> = {
    extends: 0,
    part_of: 0,
    similar_to: 0,
    depends_on: 0,
    causes: 0,
    follows: 0,
    derives_from: 0,
    contradicts: 0,
    exemplifies: 0,
    supersedes: 0,
    consolidates: 0,
    contextualizes: 0,
  };
  const seenSynapse = new Set<string>();
  for (const e of engrams) {
    const file = repo.readSynapses(e.id);
    for (const syn of file.outgoing) {
      // 对称 kind(similar_to/contradicts)在两端的 outgoing 都出现,按 syn.id
      // 去重,避免 synapseDistribution 翻倍。
      if (seenSynapse.has(syn.id)) continue;
      seenSynapse.add(syn.id);
      synapseDistribution[syn.kind] += 1;
    }
  }

  return {
    domain,
    engramCount: engrams.length,
    kindDistribution,
    synapseDistribution,
    avgImportance: importanceSum / engrams.length,
    avgConfidence: confidenceSum / engrams.length,
  };
}

/**
 * 计算两个 domain 的结构相似度（Cosine similarity on synapse kind 向量）
 *
 * 返回 [0,1]，1 = 完全同构
 */
export function computeStructuralSimilarity(
  a: DomainProfile,
  b: DomainProfile,
): number {
  const kinds: SynapseKind[] = [
    "extends",
    "part_of",
    "similar_to",
    "depends_on",
    "causes",
    "follows",
    "derives_from",
    "contradicts",
    "exemplifies",
    "supersedes",
    "consolidates",
    "contextualizes",
  ];

  // 归一化（除以总数，处理 domain 大小差异）
  const totalA = kinds.reduce((s, k) => s + a.synapseDistribution[k], 0) || 1;
  const totalB = kinds.reduce((s, k) => s + b.synapseDistribution[k], 0) || 1;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const k of kinds) {
    const va = a.synapseDistribution[k] / totalA;
    const vb = b.synapseDistribution[k] / totalB;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 扫描所有 domain pair，返回结构相似的候选对
 *
 * @param options.threshold 相似度下限（默认 0.5）
 * @param options.maxPairs 最多返回数量（默认 10）
 */
export function findCrossDomainCandidates(
  repo: EngramRepository,
  options: {
    readonly threshold?: number;
    readonly maxPairs?: number;
    readonly minEngramsPerDomain?: number;
  } = {},
): CrossDomainCandidate[] {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxPairs = options.maxPairs ?? 10;
  const minEngrams = options.minEngramsPerDomain ?? 2;

  // 收集所有 domain
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const domainSet = new Set<string>();
  const allEntries = repo.listEngrams();
  const allIds = allEntries.map((e) => e.id);
  const digests = repo.readDigestBatch(allIds);
  for (const digest of digests) {
    if (digest.status !== "active") continue;
    for (const d of digest.domainTags) domainSet.add(d);
  }

  // 计算每个 domain 的 profile
  const profiles = new Map<string, DomainProfile>();
  for (const d of domainSet) {
    const p = computeDomainProfile(repo, d);
    if (p && p.engramCount >= minEngrams) profiles.set(d, p);
  }

  // 两两计算相似度
  const domains = [...profiles.keys()].sort();
  const candidates: CrossDomainCandidate[] = [];
  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const a = profiles.get(domains[i]!)!;
      const b = profiles.get(domains[j]!)!;
      const sim = computeStructuralSimilarity(a, b);
      if (sim >= threshold) {
        candidates.push({
          domainA: domains[i]!,
          domainB: domains[j]!,
          similarity: sim,
        });
      }
    }
  }

  // 按相似度降序
  candidates.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return a.domainA < b.domainA ? -1 : 1;
  });

  return candidates.slice(0, maxPairs);
}

/**
 * 对单对 domain 执行跨域授粉
 *
 * 行为：
 *   1. 计算 profileA / profileB
 *   2. 计算 structuralSimilarity
 *   3. 调 Provider.generate（即使相似度低也调用，由 Provider 决定是否输出）
 *   4. createHypothesis=true 且 confidence ≥ autoAdoptionThreshold
 *      → 创建 hypothesis engram（domainTags=[A,B]）记录类比
 */
export async function crossPollinate(
  repo: EngramRepository,
  provider: CrossPollinationProvider,
  input: CrossPollinatePairInput,
): Promise<CrossPollinationResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const autoAdoptionThreshold =
    input.autoAdoptionThreshold ?? DEFAULT_ADOPTION_THRESHOLD;
  const createHypothesis = input.createHypothesis ?? false;

  const profileA = computeDomainProfile(repo, input.domainA);
  const profileB = computeDomainProfile(repo, input.domainB);

  if (!profileA) {
    return emptyResult(
      input.domainA,
      input.domainB,
      `domain A "${input.domainA}" has no active engrams`,
    );
  }
  if (!profileB) {
    return emptyResult(
      input.domainA,
      input.domainB,
      `domain B "${input.domainB}" has no active engrams`,
    );
  }

  const similarity = computeStructuralSimilarity(profileA, profileB);
  const sampleA = sampleEngrams(repo, input.domainA, SAMPLE_SIZE);
  const sampleB = sampleEngrams(repo, input.domainB, SAMPLE_SIZE);

  const output = await provider.generate({
    domainA: input.domainA,
    profileA,
    domainB: input.domainB,
    profileB,
    structuralSimilarity: similarity,
    sampleEngramsA: sampleA,
    sampleEngramsB: sampleB,
  });

  const adopted =
    createHypothesis && output.confidence >= autoAdoptionThreshold;
  let engramId: string | null = null;
  let reason: string;

  if (!createHypothesis) {
    reason = `analogy generated; createHypothesis=false`;
  } else if (!adopted) {
    reason = `confidence ${output.confidence.toFixed(2)} < threshold ${autoAdoptionThreshold}`;
  } else {
    const newEngram = repo.createEngram({
      title: `Cross-domain analogy: ${input.domainA} ↔ ${input.domainB}`,
      content: [
        `# ${output.analogy}`,
        "",
        `**共同原理**：${output.sharedPrinciple}`,
        "",
        `**结构相似度**：${similarity.toFixed(2)}`,
        `**置信度**：${output.confidence.toFixed(2)}`,
        "",
        `**${input.domainA} 样本**：`,
        ...sampleA.map((e) => `- ${e.title}`),
        "",
        `**${input.domainB} 样本**：`,
        ...sampleB.map((e) => `- ${e.title}`),
      ].join("\n"),
      summary: output.sharedPrinciple,
      kind: "hypothesis",
      domainTags: [input.domainA, input.domainB].sort(),
      importance: 0.5,
      confidence: output.confidence,
      sourceType: "inferred",
      createdBy: input.createdBy,
    });
    repo.updateVerificationStatus(newEngram.id, "unverified");
    engramId = newEngram.id;
    reason = `adopted; confidence=${output.confidence.toFixed(2)}`;
  }

  return {
    domainA: input.domainA,
    domainB: input.domainB,
    structuralSimilarity: similarity,
    profileA,
    profileB,
    analogy: output,
    adopted,
    engramId,
    reason,
  };
}

/**
 * 批量执行：对前 N 个候选 pair 跑 crossPollinate
 */
export async function crossPollinateBatch(
  repo: EngramRepository,
  provider: CrossPollinationProvider,
  input: {
    readonly createdBy: string;
    readonly threshold?: number;
    readonly maxPairs?: number;
    readonly createHypothesis?: boolean;
    readonly autoAdoptionThreshold?: number;
  },
): Promise<{
  readonly candidates: readonly CrossDomainCandidate[];
  readonly results: readonly CrossPollinationResult[];
}> {
  const candidates = findCrossDomainCandidates(repo, {
    threshold: input.threshold,
    maxPairs: input.maxPairs,
  });
  const results: CrossPollinationResult[] = [];
  for (const c of candidates) {
    const r = await crossPollinate(repo, provider, {
      domainA: c.domainA,
      domainB: c.domainB,
      createdBy: input.createdBy,
      createHypothesis: input.createHypothesis,
      autoAdoptionThreshold: input.autoAdoptionThreshold,
    });
    results.push(r);
  }
  return { candidates, results };
}

// ============================================================
// 辅助
// ============================================================

function emptyResult(
  a: string,
  b: string,
  reason: string,
): CrossPollinationResult {
  return {
    domainA: a,
    domainB: b,
    structuralSimilarity: 0,
    profileA: emptyProfile(a),
    profileB: emptyProfile(b),
    analogy: null,
    adopted: false,
    engramId: null,
    reason,
  };
}

function emptyProfile(domain: string): DomainProfile {
  return {
    domain,
    engramCount: 0,
    kindDistribution: {
      observation: 0,
      fact: 0,
      pattern: 0,
      procedure: 0,
      hypothesis: 0,
    },
    synapseDistribution: {
      extends: 0,
      part_of: 0,
      similar_to: 0,
      depends_on: 0,
      causes: 0,
      follows: 0,
      derives_from: 0,
      contradicts: 0,
      exemplifies: 0,
      supersedes: 0,
      consolidates: 0,
      contextualizes: 0,
    },
    avgImportance: 0,
    avgConfidence: 0,
  };
}

function topKey<K extends string>(dist: Record<K, number>): K {
  let best: K | null = null;
  let bestN = -1;
  for (const key in dist) {
    if (dist[key as K] > bestN) {
      bestN = dist[key as K];
      best = key as K;
    }
  }
  return best ?? (Object.keys(dist)[0] as K);
}

function sampleEngrams(
  repo: EngramRepository,
  domain: string,
  n: number,
): Array<{ title: string; content: string }> {
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const result: Array<{ title: string; content: string }> = [];
  const all = repo.listEngrams();
  const allIds = all.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );
  const contentById = new Map(
    repo.readContentBatch(allIds).map((c) => [c.id, c] as const),
  );

  for (const entry of all) {
    if (result.length >= n) break;
    const digest = digestById.get(entry.id);
    const content = contentById.get(entry.id);
    if (!digest || !content) continue;
    if (digest.status !== "active") continue;
    if (!digest.domainTags.includes(domain)) continue;
    result.push({ title: content.title, content: content.content });
  }
  return result;
}

// 触发 randomUUID 的引用（用于 createHypothesis 时的 synapse ID，未来扩展用）
void randomUUID;
