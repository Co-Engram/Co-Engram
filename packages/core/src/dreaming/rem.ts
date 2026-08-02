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
  jaccardSimilarity,
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

    const title = `从 ${input.engrams.length} 条相似记忆提炼的模式`;
    const content = [
      `# ${title}`,
      "",
      `**提炼来源**：${input.engrams.length} 条记忆`,
      "",
      "**共同关键词**：",
      ...commonTokens.map((t) => `- ${t}`),
      "",
      "**来源记忆**：",
      ...input.engrams.map((e) => `- ${e.title}`),
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
 * 简单贪心聚类:按 id 字典序遍历,每个 engram 找未聚类的相似邻居组成 cluster
 *
 * 性能(2026-07 修复):原走 findCandidatesSync(内部 listEngrams +
 * readContentBatch + readDigestBatch)在每个 entry 上调用一次,
 * 簇扫描总成本 O(N²) 且每轮重复 batch 读。现直接 inline Jaccard:
 * 批量预取 content 一次,预 tokenize 所有 active engram tokens,
 * 扫描时只做 Set<string> Jaccard 比较(纯内存,无 IO)。
 */
export function clusterSimilarEngrams(
  repo: EngramRepository,
  options: ClusteringOptions = {},
): readonly Cluster[] {
  const similarityThreshold = options.similarityThreshold ?? 0.4;
  const maxClusterSize = options.maxClusterSize ?? 10;

  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const clustered = new Set<string>();
  const clusters: Cluster[] = [];

  // 批量预取 digest + content 一次(消除 findCandidatesSync 内的重复 batch)
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );
  const contentById = new Map(
    repo.readContentBatch(allIds).map((c) => [c.id, c] as const),
  );

  // 预 tokenize 每个 active engram 的 tokens(避免循环内重复 tokenize)
  const tokensById = new Map<string, Set<string>>();
  for (const entry of entries) {
    const digest = digestById.get(entry.id);
    const content = contentById.get(entry.id);
    if (!digest || !content) continue;
    if (digest.status !== "active") continue;
    tokensById.set(
      entry.id,
      tokenizeForDedup(
        `${content.title} ${content.summary} ${content.content}`,
      ),
    );
  }

  for (const entry of entries) {
    if (clustered.has(entry.id)) continue;
    const entryTokens = tokensById.get(entry.id);
    if (!entryTokens || entryTokens.size === 0) continue;

    const memberIds: EngramId[] = [entry.id];
    clustered.add(entry.id);

    for (const other of entries) {
      if (memberIds.length >= maxClusterSize) break;
      if (other.id === entry.id) continue;
      if (clustered.has(other.id)) continue;
      const otherTokens = tokensById.get(other.id);
      if (!otherTokens || otherTokens.size === 0) continue;

      const sim = jaccardSimilarity(entryTokens, otherTokens);
      if (sim < similarityThreshold) continue;

      memberIds.push(other.id);
      clustered.add(other.id);
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
  /**
   * REM 审批化(2026-07):注入后,pattern 提案**不再自动 createEngram**,而是交给
   * ProposalEngine.proposePattern 生成 rem-pattern 提案(用户 accept 才创建)。
   * 不注入时保持原行为(confidence ≥ autoAdoptionThreshold 自动创建,向后兼容)。
   */
  readonly proposalEngine?: {
    proposePattern(input: {
      readonly title: string;
      readonly content: string;
      readonly summary: string;
      readonly confidence: number;
      readonly reason: string;
      readonly sourceIds: readonly string[];
      readonly domainTags: readonly string[];
    }): boolean;
    proposeSynapseOp?(input: {
      readonly op: "add" | "delete" | "retype";
      readonly from: string;
      readonly to: string;
      readonly kind: import("../types/synapse.js").SynapseKind;
      readonly oldKind?: import("../types/synapse.js").SynapseKind;
      readonly synapseId?: string;
      readonly reason: string;
      readonly confidence: number;
      readonly fromTitle?: string;
      readonly toTitle?: string;
    }): boolean;
  };
  /** P1 delete:token Jaccard 阈值（默认 0.1） */
  readonly deleteJaccardThreshold?: number;
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
  const createdBy = options.createdBy ?? "unknown";
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

    // 批量预取 content(含 title/summary)+ digest(含 domainTags)
    // 性能修复(2026-07):消除循环内 readEngram(memberIds 数量次)
    const memberContents = repo.readContentBatch(cluster.memberIds);
    const memberDigests = repo.readDigestBatch(cluster.memberIds);
    const memberDigestById = new Map(
      memberDigests.map((d) => [d.id, d] as const),
    );

    const engrams = memberContents
      .map((c) => {
        const d = memberDigestById.get(c.id);
        if (!d) return null;
        return {
          id: c.id,
          title: c.title,
          summary: c.summary,
          content: c.content,
          domainTags: [...d.domainTags],
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

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

    if (options.proposalEngine) {
      // REM 审批化(2026-07):所有提炼的 pattern 都生成 rem-pattern 提案
      // (用户 accept 才创建),不再自动 createEngram / 丢弃。
      const domainTags = [...new Set(engrams.flatMap((e) => e.domainTags))];
      options.proposalEngine.proposePattern({
        title: proposal.title,
        content: proposal.content,
        summary: proposal.summary,
        confidence: proposal.confidence,
        reason: proposal.reason,
        sourceIds: proposal.sourceIds,
        domainTags,
      });

      // Task 5: REM 聚类驱动 add 发现（representative → 成员未连 similar_to）
      if (
        options.proposalEngine.proposeSynapseOp &&
        cluster.memberIds.length >= 2
      ) {
        const rep = cluster.representativeId;
        const repTitle = memberDigestById.get(rep)?.title ?? rep;
        const repSynapses = repo.readSynapses(rep);
        const existingTargets = new Set(
          [...repSynapses.outgoing, ...repSynapses.incoming]
            .map((s) => (s.to === rep ? s.from : s.to)),
        );
        for (const memberId of cluster.memberIds) {
          if (memberId === rep) continue;
          if (existingTargets.has(memberId)) continue;
          const memberTitle = memberDigestById.get(memberId)?.title ?? memberId;
          options.proposalEngine.proposeSynapseOp({
            op: "add",
            from: rep,
            to: memberId,
            kind: "similar_to",
            reason: `REM 聚类:两记忆高度相似,建议建立 similar_to 连接(置信度 ${output.confidence.toFixed(2)})`,
            confidence: output.confidence,
            fromTitle: repTitle,
            toTitle: memberTitle,
          });
        }
      }
    } else if (output.confidence >= autoAdoptionThreshold && !dryRun) {
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

  // P1+P2:突触维护发现——扫所有突触,delete(失效)+ retype(类型不精确)
  if (options.proposalEngine?.proposeSynapseOp) {
    const DELETE_JACCARD = options.deleteJaccardThreshold ?? 0.1;
    const allSynapses = repo.collectAllSynapses();
    for (const { fromId, synapse } of allSynapses) {
      if (!repo.exists(fromId) || !repo.exists(synapse.to)) continue;
      const fromEng = repo.readEngram(fromId);
      const toEng = repo.readEngram(synapse.to);

      // P2 retype:similar_to 但 pattern→fact/procedure → extends(更精确)
      if (
        synapse.kind === "similar_to" &&
        fromEng.kind === "pattern" &&
        (toEng.kind === "fact" || toEng.kind === "procedure")
      ) {
        options.proposalEngine.proposeSynapseOp({
          op: "retype",
          from: fromId,
          to: synapse.to,
          kind: "extends" as const,
          oldKind: "similar_to",
          synapseId: synapse.id,
          reason: `REM:两端 kind(${fromEng.kind}→${toEng.kind})表明是泛化-特化关系,similar_to 不如 extends 精确`,
          confidence: 0.55,
          fromTitle: fromEng.title,
          toTitle: toEng.title,
        });
        continue; // 已建议 retype,跳过 delete 判断
      }

      // P1 delete:两端 token Jaccard 低(关系失效)。
      // domainTags 交集硬门槛已去(二期:synapse-refiner 用 LLM 判关系成立否,
      // 此处旧规则保留 Jaccard 兜底,与 synapse-refiner 并存)。
      const fromTokens = tokenizeForDedup(
        `${fromEng.title} ${fromEng.summary} ${fromEng.content}`,
      );
      const toTokens = tokenizeForDedup(
        `${toEng.title} ${toEng.summary} ${toEng.content}`,
      );
      const sim = jaccardSimilarity(fromTokens, toTokens);
      if (sim >= DELETE_JACCARD) continue;
      options.proposalEngine.proposeSynapseOp({
        op: "delete",
        from: fromId,
        to: synapse.to,
        kind: synapse.kind,
        oldKind: synapse.kind,
        synapseId: synapse.id,
        reason: `REM:两端 token 相似度 ${sim.toFixed(2)} < ${DELETE_JACCARD} 且 domainTags 无交集,疑似失效连接`,
        confidence: Math.min(0.6, 1 - sim),
        fromTitle: fromEng.title,
        toTitle: toEng.title,
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
