/**
 * 生成式巩固（spec §5.3 机制 1，P3 4.1）
 *
 * 从一组相关 engram（同 topic / domain）通过 Provider 接口生成可验证 hypothesis。
 *
 * 流程：
 *   1. 召集相关 engram（按 domainTags / contextTags 过滤；observation + fact 优先）
 *   2. Provider.generate 生成候选假设（标题/正文/置信度/理由）
 *   3. 自动采纳：confidence ≥ autoAdoptionThreshold → 创建 hypothesis engram
 *      + derives_from synapse 连接每个 source
 *   4. 验证流程：verifyHypothesis 把 verificationStatus 升级为
 *      plausible / verified / refuted
 *
 * 与 REM 做梦（spec §3.2）的区别：
 *   - REM 是被动 sleep-time consolidation，从相似 cluster 抽象出 pattern
 *   - hypothesis 是主动 wake-time 推理，生成可证伪假设并保留多视角
 *
 * core 层不绑定 LLM；HypothesisProvider 由宿主注入。
 *
 * @module @co-engram/core/generative
 */

import { randomUUID } from "node:crypto";
import type { EngramRepository } from "../storage/repository.js";
import type { Engram, EngramId, VerificationStatus } from "../types/engram.js";
import type { Synapse } from "../types/synapse.js";
import { notFoundError, validationError } from "../tools/error-schema.js";

/** collectSources 返回的精简结构(只含调用方实际使用的字段) */
type SourceEngram = {
  readonly id: EngramId;
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly domainTags: readonly string[];
  readonly kind: Engram["kind"];
};

/** 假设 Provider 输入：候选 engram 摘要 */
export interface HypothesisProviderInput {
  readonly topic: string;
  readonly engrams: ReadonlyArray<{
    readonly id: EngramId;
    readonly title: string;
    readonly content: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
    readonly kind: Engram["kind"];
  }>;
}

/** 假设 Provider 输出 */
export interface HypothesisProviderOutput {
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly confidence: number;
  readonly reason: string;
}

/**
 * 假设生成 Provider 接口
 *
 * 默认实现：LocalHeuristicHypothesisProvider（基于共现关键词）。
 * 生产实现：宿主注入真正的 LLM provider。
 */
export interface HypothesisProvider {
  generate(
    input: HypothesisProviderInput,
  ): Promise<HypothesisProviderOutput> | HypothesisProviderOutput;
}

/** 假设候选（Provider 输出 + 来源 engram ID） */
export interface HypothesisProposal extends HypothesisProviderOutput {
  readonly sourceIds: readonly EngramId[];
}

/** generateHypotheses 输入 */
export interface GenerateHypothesesInput {
  readonly topic: string;
  /** 过滤器：只在这些 domainTags 范围内召集 source */
  readonly domainTags?: readonly string[];
  /** 过滤器：只在这些 contextTags 范围内召集 source */
  readonly contextTags?: readonly string[];
  /** 召集 source 的最少数量（默认 3） */
  readonly minSources?: number;
  /** 召集 source 的最多数量（默认 10） */
  readonly maxSources?: number;
  /** 自动采纳的置信度阈值（默认 0.6） */
  readonly autoAdoptionThreshold?: number;
  /** 调用者标识 */
  readonly createdBy: string;
  /** 是否写盘（默认 true） */
  readonly persist?: boolean;
  /** dryRun=true 只返回 proposal，不创建 engram（默认 false） */
  readonly dryRun?: boolean;
  /** 时间戳（测试用） */
  readonly nowIso?: string;
}

/** 单条生成的假设 */
export interface GeneratedHypothesis {
  /** 创建的 engram ID（dryRun 或未采纳时为 null） */
  readonly engramId: EngramId | null;
  readonly proposal: HypothesisProposal;
  readonly adopted: boolean;
  readonly reason: string;
}

/** generateHypotheses 结果 */
export interface GenerateHypothesesResult {
  readonly topic: string;
  /** 召集到的候选 source 数量 */
  readonly candidateCount: number;
  /** 生成的假设（通常 1 条） */
  readonly hypotheses: readonly GeneratedHypothesis[];
  readonly durationMs: number;
  readonly persisted: boolean;
}

/** 验证裁决 */
export type HypothesisVerdict = "plausible" | "verified" | "refuted";

/** verifyHypothesis 输入证据 */
export interface VerificationEvidence {
  readonly description: string;
  readonly verifiedBy: string;
  readonly confidence?: number;
}

/** verifyHypothesis 结果 */
export interface VerifyHypothesisResult {
  readonly engramId: EngramId;
  readonly previousStatus: VerificationStatus | undefined;
  readonly newStatus: VerificationStatus;
  readonly evidenceAppended: boolean;
  /** 被升级时附带的 derives_from synapse ID（若有） */
  readonly synapseId?: string;
}

/** 默认配置 */
const DEFAULT_MIN_SOURCES = 3;
const DEFAULT_MAX_SOURCES = 10;
const DEFAULT_ADOPTION_THRESHOLD = 0.6;

/**
 * 默认启发式假设生成器（无 LLM）
 *
 * 算法：
 *   1. 收集所有 source 的 tokens（title + summary + content）
 *   2. 找出 ≥ 半数 source 共现的关键词
 *   3. title = "Hypothesis: 在 {topic} 中，{top1} 与 {top2} 相关"
 *   4. confidence = 共现 token 数 / topTokens 期望
 */
export class LocalHeuristicHypothesisProvider implements HypothesisProvider {
  constructor(
    private readonly options: {
      readonly topTokens?: number;
      readonly minConfidence?: number;
    } = {},
  ) {}

  generate(input: HypothesisProviderInput): HypothesisProviderOutput {
    const topTokens = this.options.topTokens ?? 5;
    const minConfidence = this.options.minConfidence ?? 0.3;

    if (input.engrams.length === 0) {
      return {
        title: `Hypothesis: <empty> (${input.topic})`,
        content: "",
        summary: "空候选",
        confidence: 0,
        reason: "no source engrams provided",
      };
    }

    const tokenFreq = new Map<string, number>();
    for (const e of input.engrams) {
      const tokens = extractTokens(`${e.title} ${e.summary} ${e.content}`);
      const unique = new Set(tokens);
      for (const t of unique) {
        tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
      }
    }

    // 共现 = 至少出现在 2 个 source 中（或半数以上，取大者）
    const threshold = Math.max(2, Math.ceil(input.engrams.length / 2));
    const common = [...tokenFreq.entries()]
      .filter(([, c]) => c >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topTokens)
      .map(([t]) => t);

    if (common.length === 0) {
      return {
        title: `Hypothesis: ${input.topic} 存在未被抽象的共同点`,
        content: "候选 source 共现关键词不足，无法形成可验证假设",
        summary: "低相似度候选",
        confidence: minConfidence,
        reason: "no common tokens above threshold",
      };
    }

    const title = `Hypothesis: 在 ${input.topic} 中，${common.slice(0, 3).join(" / ")} 存在共现规律`;
    const content = [
      `# ${title}`,
      "",
      `**候选 source**：${input.engrams.length} 个 engram`,
      "",
      "**共现关键词**：",
      ...common.map((t) => `- ${t}`),
      "",
      "**候选来源**：",
      ...input.engrams.map((e) => `- [${e.id}] ${e.title}`),
      "",
      "---",
      "",
      "**验证建议**：",
      `- 收集更多 ${common[0]} 相关 observation`,
      "- 寻找反例（contradicts）",
      `- 跨情境验证（不同 ${input.engrams[0]!.domainTags.join(",")} 域）`,
    ].join("\n");

    // confidence = 每个 common token 覆盖率的平均值（[0,1]）
    //   覆盖率 = 出现该 token 的 source 数 / 总 source 数
    // 例如 5 source 中 adb 全覆盖（1.0）、wireless 出现 3 次（0.6）
    //   → avg = 0.8
    const coverage = common.map(
      (t) => tokenFreq.get(t)! / input.engrams.length,
    );
    const confidence = coverage.reduce((a, b) => a + b, 0) / coverage.length;
    return {
      title,
      content,
      summary: `${common.length} 个共现关键词`,
      confidence,
      reason: `${common.length} common tokens across ${input.engrams.length} sources`,
    };
  }
}

/**
 * 生成假设（主入口）
 *
 * 行为：
 *   - 召集 source：按 domainTags/contextTags 过滤，observation/fact 优先
 *   - source 数量 < minSources → 不生成（返回空 hypotheses）
 *   - 调 Provider.generate → proposal
 *   - confidence ≥ autoAdoptionThreshold → 创建 hypothesis engram + derives_from synapse
 *
 * @returns GenerateHypothesesResult
 */
export async function generateHypotheses(
  repo: EngramRepository,
  provider: HypothesisProvider,
  input: GenerateHypothesesInput,
): Promise<GenerateHypothesesResult> {
  const startMs = Date.now();
  const minSources = input.minSources ?? DEFAULT_MIN_SOURCES;
  const maxSources = input.maxSources ?? DEFAULT_MAX_SOURCES;
  const autoAdoptionThreshold =
    input.autoAdoptionThreshold ?? DEFAULT_ADOPTION_THRESHOLD;
  const persist = input.persist ?? true;
  const dryRun = input.dryRun ?? false;
  const nowIso = input.nowIso ?? new Date().toISOString();

  // 召集候选 source
  const candidates = collectSources(repo, {
    domainTags: input.domainTags,
    contextTags: input.contextTags,
    minSources,
    maxSources,
  });

  if (candidates.length < minSources) {
    return {
      topic: input.topic,
      candidateCount: candidates.length,
      hypotheses: [],
      durationMs: Date.now() - startMs,
      persisted: false,
    };
  }

  // Provider 生成
  const providerInput: HypothesisProviderInput = {
    topic: input.topic,
    engrams: candidates.map((e) => ({
      id: e.id,
      title: e.title,
      content: e.content,
      summary: e.summary,
      domainTags: e.domainTags,
      kind: e.kind,
    })),
  };
  const output = await provider.generate(providerInput);
  const proposal: HypothesisProposal = {
    ...output,
    sourceIds: candidates.map((e) => e.id),
  };

  const adopted = !dryRun && output.confidence >= autoAdoptionThreshold;
  let engramId: EngramId | null = null;
  let reason: string;

  if (dryRun) {
    reason = `dryRun; confidence=${output.confidence.toFixed(2)}`;
  } else if (!adopted) {
    reason = `confidence ${output.confidence.toFixed(2)} < threshold ${autoAdoptionThreshold}`;
  } else {
    // 自动采纳：创建 hypothesis engram
    const domainTags = input.domainTags
      ? [...input.domainTags]
      : [...new Set(candidates.flatMap((e) => [...e.domainTags]))].sort();

    const newEngram = repo.createEngram({
      title: proposal.title,
      content: proposal.content,
      summary: proposal.summary,
      kind: "hypothesis",
      domainTags,
      importance: 0.6,
      confidence: proposal.confidence,
      sourceType: "inferred",
      createdBy: input.createdBy,
    });
    engramId = newEngram.id;

    // 验证状态初始为 unverified
    repo.updateVerificationStatus(newEngram.id, "unverified");

    // derives_from 每个 source
    for (const sourceId of proposal.sourceIds) {
      const synapse: Synapse = {
        id: `hyp-${randomUUID().slice(0, 12)}`,
        from: newEngram.id,
        to: sourceId,
        kind: "derives_from",
        weight: 0.7,
        evidence: [
          {
            description: `hypothesis generated from ${proposal.sourceIds.length} sources (confidence=${proposal.confidence.toFixed(2)})`,
            addedAt: nowIso,
            addedBy: input.createdBy,
            confidence: proposal.confidence,
          },
        ],
        createdBy: input.createdBy,
        createdAt: nowIso,
        updatedAt: nowIso,
        visibility: "public",
      };
      repo.addOutgoingSynapse(newEngram.id, synapse);
    }

    persist; // no-op（保留语义）
    reason = `adopted; confidence=${output.confidence.toFixed(2)}`;
  }

  return {
    topic: input.topic,
    candidateCount: candidates.length,
    hypotheses: [
      {
        engramId,
        proposal,
        adopted,
        reason,
      },
    ],
    durationMs: Date.now() - startMs,
    persisted: persist && !dryRun,
  };
}

/**
 * 验证假设（升级或反驳）
 *
 * verdict 对应 verificationStatus：
 *   - plausible → plausible
 *   - verified  → verified
 *   - refuted   → refuted
 *
 * 行为：
 *   1. 把 engram.verificationStatus 设为 newStatus
 *   2. 追加 evidence 到所有 derives_from synapse（如果有）
 *
 * 注意：本函数只更新 engram 自身；如需对 source 触发 reliability
 * 更新，由上层调用 provenance.applyProvenanceSignal。
 */
export function verifyHypothesis(
  repo: EngramRepository,
  engramId: EngramId,
  verdict: HypothesisVerdict,
  evidence: VerificationEvidence,
  options: { nowIso?: string } = {},
): VerifyHypothesisResult {
  if (!repo.exists(engramId)) {
    throw notFoundError("Engram", engramId);
  }
  const nowIso = options.nowIso ?? new Date().toISOString();
  const engram = repo.readEngram(engramId);

  if (engram.kind !== "hypothesis") {
    throw validationError(
      `Engram ${engramId} is not a hypothesis (kind=${engram.kind})`,
    );
  }

  const statusMap: Record<HypothesisVerdict, VerificationStatus> = {
    plausible: "plausible",
    verified: "verified",
    refuted: "refuted",
  };
  const newStatus = statusMap[verdict];

  const previousStatus = engram.verificationStatus;
  repo.updateVerificationStatus(engramId, newStatus);

  // 追加 evidence 到 derives_from synapse
  const synapseFile = repo.readSynapses(engramId);
  const derivesSynapse = synapseFile.outgoing.find(
    (s) => s.kind === "derives_from",
  );
  let evidenceAppended = false;
  let synapseId: string | undefined;

  if (derivesSynapse) {
    const newEvidence = [
      ...derivesSynapse.evidence,
      {
        description: `[${verdict}] ${evidence.description}`,
        addedAt: nowIso,
        addedBy: evidence.verifiedBy,
        confidence: evidence.confidence,
      },
    ];
    repo.replaceSynapseEvidence(engramId, derivesSynapse.id, newEvidence);
    evidenceAppended = true;
    synapseId = derivesSynapse.id;
  }

  return {
    engramId,
    previousStatus,
    newStatus,
    evidenceAppended,
    synapseId,
  };
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 召集 source engram：按 domainTags/contextTags 过滤
 *
 * 优先级：observation > fact > pattern > procedure（不召回其他 hypothesis）
 */
function collectSources(
  repo: EngramRepository,
  options: {
    domainTags?: readonly string[];
    contextTags?: readonly string[];
    minSources: number;
    maxSources: number;
  },
): SourceEngram[] {
  const kindPriority: Record<Engram["kind"], number> = {
    observation: 0,
    fact: 1,
    pattern: 2,
    procedure: 3,
    hypothesis: 4, // 不召回其他 hypothesis
  };

  // 性能修复(2026-07):消除循环内 readEngram N+1
  const all = repo.listEngrams();
  const allIds = all.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );
  const contentById = new Map(
    repo.readContentBatch(allIds).map((c) => [c.id, c] as const),
  );

  const candidates: SourceEngram[] = [];
  for (const entry of all) {
    const digest = digestById.get(entry.id);
    const content = contentById.get(entry.id);
    if (!digest || !content) continue;
    if (digest.status !== "active") continue;
    if (digest.kind === "hypothesis") continue;

    // domainTags 过滤
    if (options.domainTags && options.domainTags.length > 0) {
      const hasOverlap = options.domainTags.some((t) =>
        digest.domainTags.includes(t),
      );
      if (!hasOverlap) continue;
    }

    // contextTags 过滤
    if (options.contextTags && options.contextTags.length > 0) {
      const hasOverlap = options.contextTags.some((t) =>
        digest.contextTags.includes(t),
      );
      if (!hasOverlap) continue;
    }

    candidates.push({
      id: digest.id,
      title: content.title,
      content: content.content,
      summary: content.summary,
      domainTags: digest.domainTags,
      kind: digest.kind as Engram["kind"],
    });
  }

  // 排序：kind 优先级 + id 字典序（稳定）
  candidates.sort((a, b) => {
    const pa = kindPriority[a.kind];
    const pb = kindPriority[b.kind];
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : 1;
  });

  return candidates.slice(0, options.maxSources);
}

/** 简易 token 提取（与 dedup / triggered 一致：英文 word + 中文 bigram） */
function extractTokens(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  const enWords = trimmed.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? [];
  tokens.push(...enWords.map((w) => w.toLowerCase()));
  const cn = trimmed.match(/[一-鿿]+/g) ?? [];
  for (const seg of cn) {
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}
