/**
 * 记忆候选引擎（Proposal Engine）
 *
 * 实现"候选提示(prompted candidates)"机制——被动观察对话片段,
 * 当某主题被多次提及但无匹配 engram 时,生成候选提案等待确认。
 *
 * 工作流:
 *   1. observe(message) — host 每次对话都调用,把片段喂进引擎
 *   2. 内部:向量化 → 在线聚类(余弦 > 阈值归同簇)
 *   3. cluster.occurrences ≥ threshold → 检查是否已有匹配 engram
 *   4. 无匹配 → 生成/更新 proposal(status=pending)
 *   5. 下次会话开始 → system prompt 注入提示
 *   6. accept / dismiss — LLM 或用户决策
 *
 * 设计原则:
 *   - embedder 注入式: core 不绑定 embedding provider
 *   - 默认 embedder: hash-based(无 LLM 成本,准确度低但可用于 M1)
 *   - 查重: 仅用 repository.listEngrams() + 标题子串匹配(简单,M1 够用)
 *   - 失败静默: 观察失败不阻塞对话流
 *
 * @module @co-engram/core/observability
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import type { AuditLog } from "./audit-log.js";
import type { EngramCreateInput } from "../types/engram.js";
import { safeEmit } from "../prompt-signals/event-bus.js";
import {
  RuleBasedNecessityEvaluator,
  prefilterMessage,
  type NecessityEvaluator,
  type NecessityVerdict,
} from "./necessity-evaluator.js";

/** Embedder 接口:文本 → 向量 */
export type Embedder = (text: string) => Promise<readonly number[]>;

/** 主题簇 */
export interface TopicCluster {
  /** 簇唯一 ID(短 hash) */
  readonly id: string;
  /** 质心向量(增量平均) */
  readonly centroid: readonly number[];
  /** 出现次数 */
  readonly occurrences: number;
  /** 最近 N 条样本(原文截断,最多 100 字符) */
  readonly samples: readonly string[];
  /** 首次见到时间 */
  readonly firstSeenAt: string;
  /** 最后见到时间 */
  readonly lastSeenAt: string;
}

/** 候选提案 */
export interface Proposal {
  /** 关联的 cluster id */
  readonly entityId: string;
  /** 出现次数(snapshot) */
  readonly occurrences: number;
  /** 样本引用(snapshot,最多 3 条) */
  readonly sampleQuotes: readonly string[];
  /** 最接近质心的样本(用于预览) */
  readonly centroidExcerpt: string;
  /** 首次见到时间 */
  readonly firstSeenAt: string;
  /** 最后见到时间 */
  readonly lastSeenAt: string;
  /** 创建时间(生成 proposal 时) */
  readonly createdAt: string;
  /** 状态 */
  readonly status: "pending" | "accepted" | "dismissed";
  /** dismiss 时的截止时间(期间不再提示) */
  readonly dismissedUntil?: string;
  /** dismiss 原因 */
  readonly dismissReason?: string;
  /** accept 时创建的 engramId */
  readonly acceptedEngramId?: string;
  /** 必要性评估理由(展示给用户,辅助审批决策) */
  readonly necessityReason?: string;
  /** 必要性评估触发的规则(规则版填充,如 'high_repetition') */
  readonly necessityRule?: string;
  /** LLM 建议的标题(可作审批草稿) */
  readonly suggestedTitle?: string;
}

/** Proposal Engine 配置 */
export interface ProposalEngineConfig {
  /** 触发阈值(默认 3) */
  readonly threshold?: number;
  /** 余弦相似度阈值(默认 0.75) */
  readonly similarityThreshold?: number;
  /** 样本保留数(默认 3) */
  readonly maxSamples?: number;
  /** 默认 dismiss 天数(默认 30) */
  readonly defaultDismissDays?: number;
  /** 短消息过滤阈值(默认 20 字符,更短跳过;Layer 1 已用更严格规则,此字段仅作粗筛) */
  readonly minMessageLength?: number;
}

/** 默认配置 */
export const DEFAULT_PROPOSAL_CONFIG: Required<ProposalEngineConfig> = {
  threshold: 3,
  similarityThreshold: 0.75,
  maxSamples: 3,
  defaultDismissDays: 30,
  minMessageLength: 20,
};

/**
 * Proposal Engine
 *
 * 使用:
 *   const engine = new ProposalEngine({ repository, embedder, auditLog, dataRoot })
 *   await engine.observe({ role: 'user', content: '...', at: nowIso })
 *   const pending = engine.listPending()
 *   engine.accept(entityId, { title, content, domainTags })
 */
export class ProposalEngine {
  private readonly repository: EngramRepository;
  private readonly embedder: Embedder;
  private readonly auditLog: AuditLog;
  private readonly dataRoot: string;
  private readonly config: Required<ProposalEngineConfig>;
  private readonly clustersFile: string;
  private readonly proposalsFile: string;
  private readonly necessityEvaluator: NecessityEvaluator;

  constructor(deps: {
    readonly repository: EngramRepository;
    readonly embedder: Embedder;
    readonly auditLog: AuditLog;
    readonly dataRoot: string;
    readonly config?: ProposalEngineConfig;
    /**
     * 必要性评估器(可选)。
     * 默认 RuleBasedNecessityEvaluator(零依赖,挡机械噪声)。
     * host 可注入 LlmNecessityEvaluator(需 LlmClient)做语义判断。
     */
    readonly necessityEvaluator?: NecessityEvaluator;
  }) {
    this.repository = deps.repository;
    this.embedder = deps.embedder;
    this.auditLog = deps.auditLog;
    this.dataRoot = deps.dataRoot;
    this.config = { ...DEFAULT_PROPOSAL_CONFIG, ...deps.config };
    this.clustersFile = join(
      deps.dataRoot,
      ".co-engram",
      "topic-clusters.jsonl",
    );
    this.proposalsFile = join(deps.dataRoot, ".co-engram", "proposals.jsonl");
    this.necessityEvaluator =
      deps.necessityEvaluator ?? new RuleBasedNecessityEvaluator();
  }

  /**
   * 观察一条对话消息
   *
   * 流程:
   *   1. Layer 1 规则预过滤(零成本挡机械噪声:trivial/短消息/低密度)
   *   2. 向量化
   *   3. 找最相似的现有 cluster
   *   4. 归簇 or 新建
   *   5. 若 occurrences 达到阈值 → Layer 2 必要性评估 → 查重 → 生成 proposal
   */
  async observe(message: {
    readonly role: "user" | "assistant" | "system";
    readonly content: string;
    readonly at?: string;
  }): Promise<void> {
    // Layer 1:规则预过滤(挡机械噪声)
    //   - system role 不观察(设计意图)
    //   - 其他被过滤的情形静默丢弃(不写 audit,避免每条对话消息都产生噪音)
    //     Layer 1 拒绝率 60-80%,记 audit 会让 audit.jsonl 被噪声淹没
    if (message.role === "system") return;

    const pre = prefilterMessage(message.content, message.role);
    if (!pre.accepted) {
      return;
    }

    const now = message.at ?? new Date().toISOString();

    let vector: readonly number[];
    try {
      vector = await this.embedder(message.content);
    } catch {
      // embedder 失败:静默放弃本次观察
      return;
    }

    const clusters = this.readClusters();
    const matchResult = findBestMatch(
      vector,
      clusters,
      this.config.similarityThreshold,
    );

    let updatedClusters: readonly TopicCluster[];
    let targetCluster: TopicCluster;

    if (matchResult) {
      targetCluster = addToCluster(
        matchResult.cluster,
        message.content,
        vector,
        now,
        this.config.maxSamples,
      );
      updatedClusters = clusters.map((c) =>
        c.id === targetCluster.id ? targetCluster : c,
      );
    } else {
      const candidate = newCluster(vector, message.content, now);
      // 防御:即使 clusterId 算法发生碰撞,也合并到已有 cluster,
      // 避免文件里出现同 id 多行(findBestMatch 没命中但 id 已存在 →
      // 说明相似度算法和 id 算法不一致,仍按 id 合并以保证文件唯一性)
      const collision = clusters.find((c) => c.id === candidate.id);
      if (collision) {
        targetCluster = addToCluster(
          collision,
          message.content,
          vector,
          now,
          this.config.maxSamples,
        );
        updatedClusters = clusters.map((c) =>
          c.id === targetCluster.id ? targetCluster : c,
        );
      } else {
        targetCluster = candidate;
        updatedClusters = [...clusters, targetCluster];
      }
    }

    this.writeClusters(updatedClusters);

    // 达到阈值 → 检查查重 → 生成 proposal
    if (targetCluster.occurrences >= this.config.threshold) {
      await this.maybePromoteToProposal(targetCluster, now);
    }
  }

  /** 列出 status=pending 的提案 */
  listPending(): readonly Proposal[] {
    return this.readProposals().filter((p) => {
      if (p.status !== "pending") return false;
      // 检查 dismissedUntil 是否已过期(重新激活)
      if (p.dismissedUntil && p.dismissedUntil > new Date().toISOString()) {
        return false;
      }
      return true;
    });
  }

  /** 列出所有提案(包含 accepted/dismissed,调试用) */
  listAll(): readonly Proposal[] {
    return this.readProposals();
  }

  /**
   * 接受提案 → 创建 engram
   *
   * @returns 新建的 engram id
   */
  accept(
    entityId: string,
    input: {
      readonly title: string;
      readonly content: string;
      readonly domainTags: readonly string[];
      readonly createdBy?: string;
      readonly kind?: EngramCreateInput["kind"];
    },
  ): string {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target) {
      throw new Error(`Proposal not found: ${entityId}`);
    }

    const engram = this.repository.createEngram({
      title: input.title,
      content: input.content,
      kind: input.kind ?? "fact",
      domainTags: input.domainTags,
      createdBy: input.createdBy ?? "proposal-engine",
    });

    const updated: Proposal = {
      ...target,
      status: "accepted",
      acceptedEngramId: engram.id,
    };
    this.writeProposals(
      proposals.map((p) => (p.entityId === entityId ? updated : p)),
    );

    // 移除对应的 cluster(已转化)
    this.writeClusters(this.readClusters().filter((c) => c.id !== entityId));

    this.auditLog.append({
      actor: "user",
      action: "accept",
      engramId: engram.id,
      metadata: { entityId, occurrences: target.occurrences },
    });

    // Task 3.4 Phase B:proposal accepted → 新 engram 已创建,触发 prompt-signals rebuild
    safeEmit({
      type: "proposal_accepted",
      engramId: engram.id,
      at: new Date().toISOString(),
    });

    return engram.id;
  }

  /**
   * 拒绝提案
   *
   * @param entityId 簇 id
   * @param reason 拒绝原因(可选,便于元学习)
   * @param dismissDays 多少天内不再提示(默认 30)
   */
  dismiss(entityId: string, reason?: string, dismissDays?: number): void {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target) {
      throw new Error(`Proposal not found: ${entityId}`);
    }

    const days = dismissDays ?? this.config.defaultDismissDays;
    const dismissedUntil = new Date(
      Date.now() + days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const updated: Proposal = {
      ...target,
      status: "dismissed",
      dismissReason: reason,
      dismissedUntil,
    };
    this.writeProposals(
      proposals.map((p) => (p.entityId === entityId ? updated : p)),
    );

    this.auditLog.append({
      actor: "user",
      action: "dismiss",
      metadata: { entityId, reason, dismissedUntil },
    });

    // Task 3.4 Phase B:proposal dismissed → pendingCount 变化,触发 prompt-signals rebuild
    safeEmit({
      type: "proposal_dismissed",
      at: new Date().toISOString(),
    });
  }

  /** 清理过期/已处理数据(测试用) */
  clear(): void {
    for (const f of [this.clustersFile, this.proposalsFile]) {
      if (existsSync(f)) writeFileSync(f, "", "utf8");
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  /**
   * 检查是否已有相关 engram;若无则创建/更新 proposal
   *
   * 流程:
   *   1. 查重:已有相似 engram → 跳过
   *   2. 已 accepted → 跳过;已 dismissed 且未过期 → 跳过
   *   3. Layer 2 必要性评估:necessity=false → 记 audit 不晋升
   *   4. necessity=true → 生成/更新 proposal(带 necessityReason)
   */
  private async maybePromoteToProposal(
    cluster: TopicCluster,
    now: string,
  ): Promise<void> {
    const centroidExcerpt = cluster.samples[cluster.samples.length - 1] ?? "";

    // 查重:简单标题/摘要子串匹配(M1 够用,M2 可升级为语义)
    if (this.hasSimilarEngram(centroidExcerpt)) {
      return; // 已有相关 engram,不生成 proposal
    }

    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === cluster.id);

    if (existing && existing.status === "accepted") {
      return; // 已接受,不再更新
    }

    if (existing && existing.status === "dismissed") {
      // dismissed 但 dismissUntil 已过 → 重新激活
      if (existing.dismissedUntil && existing.dismissedUntil > now) {
        return; // 仍在 dismiss 期
      }
    }

    // Layer 2:必要性评估
    const existingTitles = this.repository.listEngrams().map((e) => e.title);
    const verdict = await this.necessityEvaluator.evaluate({
      samples: cluster.samples,
      occurrences: cluster.occurrences,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      existingTitles,
    });

    if (!verdict.necessary) {
      // 不晋升,但保留 cluster(后续新样本可能改变判断)
      this.auditLog.append({
        actor: "system",
        action: "necessity_rejected",
        metadata: {
          entityId: cluster.id,
          occurrences: cluster.occurrences,
          rule: verdict.rule,
          reason: verdict.reason,
        },
      });
      return;
    }

    const proposal: Proposal = {
      entityId: cluster.id,
      occurrences: cluster.occurrences,
      sampleQuotes: cluster.samples.slice(-this.config.maxSamples),
      centroidExcerpt,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      necessityReason: verdict.reason,
      ...(verdict.suggestedTitle
        ? { suggestedTitle: verdict.suggestedTitle }
        : {}),
    };

    const next = existing
      ? {
          ...existing,
          ...proposal,
          dismissedUntil: undefined,
          dismissReason: undefined,
        }
      : proposal;

    if (existing) {
      this.writeProposals(
        proposals.map((p) => (p.entityId === cluster.id ? next : p)),
      );
    } else {
      this.writeProposals([...proposals, next]);
      // 首次生成 proposal → audit propose
      this.auditLog.append({
        actor: "system",
        action: "propose",
        metadata: { entityId: cluster.id, occurrences: cluster.occurrences },
      });
    }
  }

  /** 查重:简单子串匹配 */
  private hasSimilarEngram(excerpt: string): boolean {
    const entries = this.repository.listEngrams();
    const normalizedExcerpt = normalize(excerpt);
    if (!normalizedExcerpt) return false;

    // 提取 excerpt 的关键词(去停用词、取前 5 个)
    const keywords = extractKeywords(normalizedExcerpt, 5);
    if (keywords.length === 0) return false;

    for (const entry of entries) {
      const title = normalize(entry.title);
      // 至少 2 个关键词命中才算匹配
      const hits = keywords.filter((k) => title.includes(k)).length;
      if (hits >= 2) return true;
    }
    return false;
  }

  private readClusters(): TopicCluster[] {
    const raw = readJsonl(this.clustersFile) as TopicCluster[];
    // 防御性 dedupe by id:历史数据可能因 clusterId 碰撞 + push 不查重
    // 出现同 id 多行(已修复,但已有污染数据需在读时清理)。同 id 取
    // occurrences 最大者(代表累积最完整),其余字段以它为准。
    if (raw.length <= 1) return raw;
    const byId = new Map<string, TopicCluster>();
    for (const c of raw) {
      const existing = byId.get(c.id);
      if (!existing || c.occurrences > existing.occurrences) {
        byId.set(c.id, c);
      }
    }
    const deduped = Array.from(byId.values());
    // 若发生 dedupe,立刻把干净数据写回(下次 observe 走 writeClusters 自然保持)
    if (deduped.length !== raw.length) {
      this.writeClusters(deduped);
    }
    return deduped;
  }

  private writeClusters(clusters: readonly TopicCluster[]): void {
    writeJsonl(this.clustersFile, clusters);
  }

  private readProposals(): Proposal[] {
    return readJsonl(this.proposalsFile) as Proposal[];
  }

  private writeProposals(proposals: readonly Proposal[]): void {
    writeJsonl(this.proposalsFile, proposals);
  }
}

// ============================================================
// 纯函数(可测试)
// ============================================================

/**
 * 创建新 cluster
 */
export function newCluster(
  vector: readonly number[],
  firstSample: string,
  at: string,
): TopicCluster {
  return {
    id: clusterId(vector),
    centroid: [...vector],
    occurrences: 1,
    samples: [truncate(firstSample, 100)],
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

/**
 * 把新样本加入现有 cluster,更新质心
 *
 * 质心更新公式: new = old + (sample - old) / (n+1)
 */
export function addToCluster(
  cluster: TopicCluster,
  sample: string,
  vector: readonly number[],
  at: string,
  maxSamples: number,
): TopicCluster {
  const n = cluster.occurrences + 1;
  const newCentroid = cluster.centroid.map((c, i) => {
    const v = vector[i] ?? 0;
    return c + (v - c) / n;
  });

  const samples = [...cluster.samples, truncate(sample, 100)].slice(
    -maxSamples,
  );

  return {
    ...cluster,
    centroid: newCentroid,
    occurrences: n,
    samples,
    lastSeenAt: at,
  };
}

/**
 * 找最相似的 cluster(余弦)
 *
 * 返回 null 表示无匹配(需新建)
 */
export function findBestMatch(
  vector: readonly number[],
  clusters: readonly TopicCluster[],
  threshold: number,
): { readonly cluster: TopicCluster; readonly similarity: number } | null {
  if (clusters.length === 0) return null;

  let bestCluster: TopicCluster | null = null;
  let bestSim = -1;

  for (const c of clusters) {
    const sim = cosineSimilarity(vector, c.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestCluster = c;
    }
  }

  if (!bestCluster || bestSim < threshold) return null;
  return { cluster: bestCluster, similarity: bestSim };
}

/** 余弦相似度 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const len = Math.max(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 从向量派生短 id(便于调试 + 唯一索引) */
export function clusterId(vector: readonly number[]): string {
  // 全向量 SHA256 → 16 字符前缀,碰撞概率 ~1/2^64
  //
  // 历史 bug:旧实现只取前 4 + 后 4 维拼 hash,而 DEFAULT_HASHER_EMBEDDER
  // 把词 hash 到 0..N 的随机维度,只要词都没命中前 4/后 4 维,id 必然
  // 碰撞成 c128-0-0-0-0-0-0-0-0(或迁移到 c256 后的同等碰撞),导致 observe
  // 走 newCluster 分支时多次创建同 id 的不同 cluster,污染 topic-clusters.jsonl。
  const serialized = vector.map((n) => n.toFixed(6)).join(",");
  const digest = createHash("sha256").update(serialized).digest("hex");
  return `c${vector.length}-${digest.slice(0, 16)}`;
}

/**
 * 默认 embedder: hash-based(无 LLM)
 *
 * 把文本拆词,每个词 hash 到某维度,符号累加。CJK 字符连续段会进一步切成
 * 字符 bigram(我们/以后/所有…)——不加这一步,中文整段会被当成一个超大 token,
 * 导致相似 Chinese 句子的余弦接近正交,proposal pipeline 在中文场景下完全失灵。
 * 准确度低但零成本,可用于 M1 验证机制。M2 由宿主替换为真实 embedding。
 */
export const DEFAULT_HASHER_EMBEDDER: Embedder = async (text) => {
  const DIM = 256;
  const vec = new Array(DIM).fill(0);
  const tokens = tokenizeForEmbedding(text);
  for (const w of tokens) {
    let hash = 0;
    for (let i = 0; i < w.length; i++) {
      hash = (hash * 31 + w.charCodeAt(i)) | 0;
    }
    const dim = Math.abs(hash) % DIM;
    const sign = hash < 0 ? -1 : 1;
    vec[dim] += sign;
  }
  // L2 归一化(便于余弦)
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) vec[i] /= norm;
  }
  return vec;
};

/**
 * Hash-based embedder 配套的相似度阈值。
 *
 * `DEFAULT_PROPOSAL_CONFIG.similarityThreshold = 0.75` 是为真实 LLM embedding
 * 设计的;hash-based fallback 的余弦分布完全不同(同义改写最多 ~0.4,完全无关
 * 的文本 ~0.05-0.1),用 0.75 会导致 proposal pipeline 在 hash fallback 下
 * 完全无法成簇——任何话题被反复提及都不会生成 proposal。
 *
 * 0.35 是经验值:在 256 维 + CJK bigram 切分下,足以让"arrow function"
 * 这样的核心词在 4-5 次提及后成簇,又不会把"今天天气真好"和"我们去爬山"
 * 这种无关句子误聚到一起。宿主替换为真实 embedder 时应使用更高阈值(如 0.75)。
 */
export const DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35;

// ============================================================
// 辅助
// ============================================================

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "when",
  "why",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "但",
  "可以",
  "应该",
  "需要",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// CJK / Hangana / Hangul 范围。用于把连续 CJK 段切成字符 bigram。
// 没有这一步,中文整段会被 normalize() 当成一个 token。
const CJK_RUN = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

/**
 * 把 normalize 后的文本切成可 hash 的 token:
 *   - 拉丁/数字词:原样返回
 *   - 连续 CJK/Hangana/Hangul 段:切成字符 bigram("我们以后" → 我们/们以/以后)
 *     · 1 字符的孤儿(罕见,通常是被空格分隔的单字)按原样发出
 *     · bigram 是 zero-cost 中文语义近似的最优切分粒度:
 *       既能抓住常用双字词(我们/以后/所有),又无需词典或分词器
 */
function tokenizeForEmbedding(text: string): string[] {
  const tokens: string[] = [];
  for (const word of normalize(text).split(/\s+/).filter(Boolean)) {
    if (CJK_RUN.test(word)) {
      if (word.length === 1) {
        tokens.push(word);
        continue;
      }
      for (let i = 0; i + 1 < word.length; i++) {
        tokens.push(word.slice(i, i + 2));
      }
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function extractKeywords(text: string, n: number): string[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, n);
}

function readJsonl(filePath: string): readonly unknown[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r !== null);
}

function writeJsonl(filePath: string, records: readonly unknown[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content =
    records.map((r) => JSON.stringify(r)).join("\n") +
    (records.length > 0 ? "\n" : "");
  writeFileSync(filePath, content, "utf8");
}
