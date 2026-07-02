/**
 * REM Dreaming（跨情境抽象 + 模式发现）
 *
 * 神经科学依据：REM 睡眠期间，海马与皮层协同重放，发现跨情境的共同模式。
 *
 * 实现（spec §5.2）：
 *   1. 取所有 active engram
 *   2. 相似度聚类（基于 TokenJaccardSimilarityEngine）
 *   3. 对每个 ≥ minClusterSize 的 cluster 调用 abstractionProvider 抽象
 *   4. 生成 ConsolidationProposal（title/content/sourceIds/confidence）
 *   5. confidence ≥ autoAdoptionThreshold → 自动创建 pattern engram + 连接 derives_from
 *
 * Core 层提供 PatternAbstractionProvider 接口，宿主可注入真正的 LLM 抽象器；
 * 默认实现 LocalHeuristicPatternAbstraction 基于 token 频率提取共同 tokens。
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramId } from "../types/engram.js";
import type { Synapse } from "../types/synapse.js";
import { randomUUID } from "node:crypto";
import {
  tokenizeForDedup,
  TokenJaccardSimilarityEngine,
} from "../dedup/similar.js";

// ============================================================
// 抽象 Provider 接口
// ============================================================

export interface AbstractionInput {
  /** Cluster 内的 engram 摘要列表 */
  readonly engrams: ReadonlyArray<{
    readonly id: EngramId;
    readonly title: string;
    readonly summary: string;
    readonly content: string;
    readonly domainTags: readonly string[];
  }>;
}

export interface AbstractionOutput {
  /** 抽象出的模式 title */
  readonly title: string;
  /** 抽象出的模式 content（Markdown） */
  readonly content: string;
  /** 摘要 */
  readonly summary: string;
  /** 置信度 [0,1] */
  readonly confidence: number;
  /** 抽象理由（可解释性） */
  readonly reason: string;
}

/**
 * 模式抽象 Provider 接口
 *
 * 默认实现：LocalHeuristicPatternAbstraction（基于 token 频率）
 * 生产实现：宿主注入真正的 LLM provider（调用 GPT/Claude）
 */
export interface PatternAbstractionProvider {
  abstract(
    input: AbstractionInput,
  ): Promise<AbstractionOutput> | AbstractionOutput;
}

// ============================================================
// 默认启发式抽象
// ============================================================

/**
 * 启发式模式抽象（无 LLM）
 *
 * 算法：
 *   1. 合并 cluster 内所有 engram 的 tokens
 *   2. 按 token 频率倒序，取 top N 作为"共同关键词"
 *   3. title = "Pattern: {top1} {top2} {top3}"
 *   4. content = 共同关键词列表 + source 列表
 *   5. confidence = (top1 频率 / cluster size) × 加权
 *
 * 这是 P2 启发式；生产环境应该用 LLM 做语义抽象。
 */
export class LocalHeuristicPatternAbstraction implements PatternAbstractionProvider {
  constructor(
    private readonly options: {
      readonly topTokens?: number;
      readonly minConfidence?: number;
    } = {},
  ) {}

  abstract(input: AbstractionInput): AbstractionOutput {
    const topTokens = this.options.topTokens ?? 5;
    const minConfidence = this.options.minConfidence ?? 0.3;

    if (input.engrams.length === 0) {
      return {
        title: "Pattern: <empty>",
        content: "",
        summary: "空 cluster",
        confidence: 0,
        reason: "empty cluster",
      };
    }

    // 合并所有 tokens 并统计频率
    const tokenFreq = new Map<string, number>();
    for (const e of input.engrams) {
      const tokens = tokenizeForDedup(`${e.title} ${e.summary} ${e.content}`);
      for (const t of tokens) {
        tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
      }
    }

    // 取出现频率 ≥ 一半 engram 的 token 作为"共同关键词"
    const threshold = Math.ceil(input.engrams.length / 2);
    const commonTokens = [...tokenFreq.entries()]
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topTokens)
      .map(([t]) => t);

    if (commonTokens.length === 0) {
      return {
        title: `Pattern: ${input.engrams[0]!.domainTags[0] ?? "unknown"}`,
        content: "共同 tokens 不足，无法抽象出明确模式",
        summary: "低相似度 cluster",
        confidence: minConfidence,
        reason: "no common tokens above threshold",
      };
    }

    const title = `Pattern: ${commonTokens.slice(0, 3).join(" / ")}`;
    const content = [
      `# ${title}`,
      "",
      `**抽象来源**：${input.engrams.length} 个 engram`,
      "",
      "**共同关键词**：",
      ...commonTokens.map((t) => `- ${t}`),
      "",
      "**来源 engram**：",
      ...input.engrams.map((e) => `- [${e.id}] ${e.title}`),
    ].join("\n");

    // confidence = 共同 token 数 / 期望数（归一化到 [0,1]）
    const confidence = Math.min(1, commonTokens.length / topTokens);
    const reason = `${commonTokens.length} common tokens across ${input.engrams.length} engrams`;

    return {
      title,
      content,
      summary: `${commonTokens.length} 个共同关键词`,
      confidence,
      reason,
    };
  }
}

// ============================================================
// 聚类
// ============================================================

export interface Cluster {
  readonly representativeId: EngramId;
  readonly memberIds: readonly EngramId[];
}

export interface ClusteringOptions {
  /** 相似度阈值（两个 engram 视为同 cluster） */
  readonly similarityThreshold?: number;
  /** 一个 cluster 的 最大成员数 */
  readonly maxClusterSize?: number;
}

/**
 * 简单贪心聚类：按 id 字典序遍历，每个 engram 找未聚类的相似邻居组成 cluster
 */
export function clusterSimilarEngrams(
  repo: EngramRepository,
  options: ClusteringOptions = {},
): readonly Cluster[] {
  const similarityThreshold = options.similarityThreshold ?? 0.4;
  const maxClusterSize = options.maxClusterSize ?? 10;

  const engine = new TokenJaccardSimilarityEngine(repo);
  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const clustered = new Set<string>();
  const clusters: Cluster[] = [];

  for (const entry of entries) {
    if (clustered.has(entry.id)) continue;
    const engram = repo.readEngram(entry.id);
    if (engram.status !== "active") continue;

    const candidates = engine.findCandidatesSync(
      `${engram.title} ${engram.summary} ${engram.content}`,
      { topK: maxClusterSize, minSimilarity: similarityThreshold },
    );

    const memberIds: EngramId[] = [entry.id];
    clustered.add(entry.id);
    for (const c of candidates) {
      if (c.id === entry.id) continue;
      if (clustered.has(c.id)) continue;
      const candidateEngram = repo.readEngram(c.id);
      if (candidateEngram.status !== "active") continue;
      memberIds.push(c.id);
      clustered.add(c.id);
      if (memberIds.length >= maxClusterSize) break;
    }

    if (memberIds.length > 1) {
      clusters.push({ representativeId: entry.id, memberIds });
    }
  }

  return clusters;
}

// ============================================================
// 提案 + 采纳
// ============================================================

export interface ConsolidationProposal {
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly confidence: number;
  readonly reason: string;
  readonly sourceIds: readonly EngramId[];
  readonly clusterRepresentativeId: EngramId;
}

export interface RemDreamingOptions {
  readonly abstractionProvider?: PatternAbstractionProvider;
  readonly clustering?: ClusteringOptions;
  /** 最小 cluster size（默认 3） */
  readonly minClusterSize?: number;
  /** 自动采纳阈值（默认 0.85） */
  readonly autoAdoptionThreshold?: number;
  /** 创建 pattern engram 时使用 */
  readonly createdBy?: string;
  /** 只读模式：只生成提案不落盘 */
  readonly dryRun?: boolean;
}

export interface RemDreamingResult {
  readonly clustersScanned: number;
  readonly proposals: readonly ConsolidationProposal[];
  readonly adopted: ReadonlyArray<{
    patternEngramId: EngramId;
    proposal: ConsolidationProposal;
  }>;
  readonly skipped: ReadonlyArray<{
    proposal: ConsolidationProposal;
    reason: string;
  }>;
}

/**
 * 执行 REM Dreaming
 *
 * 1. 聚类所有 active engram
 * 2. 对每个 ≥ minClusterSize 的 cluster 生成抽象提案
 * 3. confidence ≥ autoAdoptionThreshold → 自动创建 pattern engram + derives_from synapse
 *
 * 注意：core 层不绑定 LLM；abstractionProvider 由宿主注入。
 */
export async function runRemDreaming(
  repo: EngramRepository,
  options: RemDreamingOptions = {},
): Promise<RemDreamingResult> {
  const provider =
    options.abstractionProvider ?? new LocalHeuristicPatternAbstraction();
  const minClusterSize = options.minClusterSize ?? 3;
  const autoAdoptionThreshold = options.autoAdoptionThreshold ?? 0.85;
  const createdBy = options.createdBy ?? "dreaming-rem";
  const dryRun = options.dryRun ?? false;

  const clusters = clusterSimilarEngrams(repo, options.clustering ?? {});
  const proposals: ConsolidationProposal[] = [];
  const adopted: Array<{
    patternEngramId: EngramId;
    proposal: ConsolidationProposal;
  }> = [];
  const skipped: Array<{ proposal: ConsolidationProposal; reason: string }> =
    [];

  for (const cluster of clusters) {
    if (cluster.memberIds.length < minClusterSize) continue;

    const engrams = cluster.memberIds.map((id) => {
      const e = repo.readEngram(id);
      return {
        id: e.id,
        title: e.title,
        summary: e.summary,
        content: e.content,
        domainTags: [...e.domainTags],
      };
    });

    const output = await provider.abstract({ engrams });
    const proposal: ConsolidationProposal = {
      title: output.title,
      content: output.content,
      summary: output.summary,
      confidence: output.confidence,
      reason: output.reason,
      sourceIds: cluster.memberIds,
      clusterRepresentativeId: cluster.representativeId,
    };
    proposals.push(proposal);

    if (output.confidence >= autoAdoptionThreshold && !dryRun) {
      // 自动采纳：创建 pattern engram + derives_from synapse
      const patternEngram = repo.createEngram({
        title: proposal.title,
        content: proposal.content,
        summary: proposal.summary,
        kind: "pattern",
        domainTags: [...new Set(engrams.flatMap((e) => e.domainTags))],
        importance: 0.7,
        confidence: output.confidence,
        sourceType: "inferred",
        createdBy,
      });
      // 连接 derives_from 每个 source
      const timestamp = patternEngram.createdAt;
      for (const sourceId of proposal.sourceIds) {
        const synapse: Synapse = {
          id: randomUUID(),
          from: patternEngram.id,
          to: sourceId,
          kind: "derives_from",
          weight: 0.8,
          direction: "directional",
          evidence: [],
          createdBy,
          createdAt: timestamp,
          updatedAt: timestamp,
          retrievalWeight: 0.8,
          visibility: "public",
        };
        repo.addOutgoingSynapse(patternEngram.id, synapse);
      }
      adopted.push({ patternEngramId: patternEngram.id, proposal });
    } else if (output.confidence < autoAdoptionThreshold) {
      skipped.push({
        proposal,
        reason: `confidence ${output.confidence.toFixed(2)} < threshold ${autoAdoptionThreshold}`,
      });
    }
  }

  return {
    clustersScanned: clusters.length,
    proposals,
    adopted,
    skipped,
  };
}
