/**
 * 智能去重编排器
 *
 * 整合 hash 匹配 + 相似度召回 + triage + 合并/强化，
 * 提供给 engram_create 工具调用。
 *
 * 用法：
 *   const result = await dedupe(repo, input, { similarityEngine, triageProvider })
 *   switch (result.verdict) {
 *     case 'DUPLICATE': // 强化原 engram
 *     case 'UPDATE':    // 已合并
 *     case 'NEW':       // 正常创建
 *   }
 *
 * 同步版本（checkDuplicateSync）用于 engram_create 自动触发，
 * 仅支持同步启发式引擎 + 启发式 triage；
 * 如需注入真正的 LLM triage，使用 async checkDuplicate 手动调用。
 *
 * @module @co-engram/core/dedup
 */

import { computeContentHash } from "../storage/hash.js";
import type { EngramCreateInput } from "../types/engram.js";
import type { EngramRepository } from "../storage/repository.js";
import type {
  DedupResult,
  LlmTriageProvider,
  SimilarityEngine,
} from "./types.js";
import { findExactHashMatch } from "./hash.js";
import { LocalHeuristicTriage } from "./llm-triage.js";
import { TokenJaccardSimilarityEngine } from "./similar.js";

export interface DedupeOptions {
  readonly similarityEngine?: SimilarityEngine;
  readonly triageProvider?: LlmTriageProvider;
  readonly topK?: number;
  readonly minSimilarity?: number;
}

export interface DedupeContext {
  readonly repository: EngramRepository;
  readonly options?: DedupeOptions;
}

/**
 * 执行去重检查（不创建/合并，只裁决）
 *
 * 返回 verdict + targetId（如有）。
 * 后续由调用方决定如何处理（DUPLICATE → 强化；UPDATE → mergeEngram；NEW → createEngram）。
 */
export async function checkDuplicate(
  ctx: DedupeContext,
  input: EngramCreateInput,
): Promise<DedupResult> {
  const repo = ctx.repository;
  const options = ctx.options ?? {};

  // 1. 精确 hash 匹配（O(N) 扫描）
  const newHash = computeContentHash(input.content);
  const exactMatch = findExactHashMatch(repo, newHash);
  if (exactMatch) {
    return {
      verdict: "DUPLICATE",
      targetId: exactMatch,
      reason: `exact contentHash match: ${newHash}`,
      confidence: 1,
      candidatesConsidered: 1,
    };
  }

  // 2. 相似度召回
  const engine =
    options.similarityEngine ?? new TokenJaccardSimilarityEngine(repo);
  const topK = options.topK ?? 5;
  const minSimilarity = options.minSimilarity ?? 0.3;
  const candidates = await engine.findCandidates(
    `${input.title} ${input.content}`,
    { topK, minSimilarity },
  );

  // 3. triage
  const triageProvider = options.triageProvider ?? new LocalHeuristicTriage();
  const triage = await triageProvider.triage({
    newTitle: input.title,
    newContent: input.content,
    candidates,
  });

  return {
    verdict: triage.verdict,
    targetId: triage.duplicateOf ?? triage.updateTarget,
    reason: triage.reason,
    confidence: triage.confidence,
    candidatesConsidered: candidates.length,
  };
}

/**
 * 同步版本：仅使用默认启发式（TokenJaccardSimilarityEngine + LocalHeuristicTriage）
 *
 * 用于 engram_create 自动触发，避免 async 传染；
 * 如需注入真正的 LLM triage，调用方应使用 async checkDuplicate 手动裁决，
 * 然后根据 verdict 决定 createEngram / mergeEngram / 强化。
 */
export function checkDuplicateSync(
  ctx: DedupeContext,
  input: EngramCreateInput,
): DedupResult {
  const repo = ctx.repository;
  const options = ctx.options ?? {};

  // 1. 精确 hash 匹配
  const newHash = computeContentHash(input.content);
  const exactMatch = findExactHashMatch(repo, newHash);
  if (exactMatch) {
    return {
      verdict: "DUPLICATE",
      targetId: exactMatch,
      reason: `exact contentHash match: ${newHash}`,
      confidence: 1,
      candidatesConsidered: 1,
    };
  }

  // 2. 同步相似度召回（走 TokenJaccardSimilarityEngine.findCandidatesSync）
  const injectedEngine = options.similarityEngine;
  const topK = options.topK ?? 5;
  const minSimilarity = options.minSimilarity ?? 0.3;
  const candidates =
    injectedEngine &&
    typeof (injectedEngine as TokenJaccardSimilarityEngine)
      .findCandidatesSync === "function"
      ? (injectedEngine as TokenJaccardSimilarityEngine).findCandidatesSync(
          `${input.title} ${input.content}`,
          { topK, minSimilarity },
        )
      : new TokenJaccardSimilarityEngine(repo).findCandidatesSync(
          `${input.title} ${input.content}`,
          { topK, minSimilarity },
        );

  // 3. 同步 triage（仅 LocalHeuristicTriage 支持）
  const triage = new LocalHeuristicTriage().triageSync({
    newTitle: input.title,
    newContent: input.content,
    candidates,
  });

  return {
    verdict: triage.verdict,
    targetId: triage.duplicateOf ?? triage.updateTarget,
    reason: triage.reason,
    confidence: triage.confidence,
    candidatesConsidered: candidates.length,
  };
}
