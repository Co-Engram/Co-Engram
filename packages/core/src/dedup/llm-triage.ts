/**
 * LLM Triage（三态裁决）
 *
 * 接口：LlmTriageProvider（由宿主实现，绑定具体 LLM provider）
 * 默认实现：LocalHeuristicTriage（启发式规则，无需 LLM）
 *
 * 启发式规则（P1 默认）：
 *   1. contentHash 完全匹配（sha256）→ DUPLICATE（confidence=1.0）
 *   2. title 完全相同 + similarity ≥ titleMatchUpdateThreshold → UPDATE
 *   3. similarity ≥ highSimilarityUpdateThreshold（无论 title）→ UPDATE
 *   4. similarity ≥ newRelatedThreshold → NEW（标记可能相关，但不合并）
 *   5. 其他 → NEW
 *
 * similarity 字段由 SimilarityEngine 给出（如 TokenJaccardSimilarityEngine），
 * triage 信任引擎结果，不重新计算。
 *
 * 启发式适合 P1 测试和小规模数据；生产环境用 LlmTriageProvider
 * 调用真正的 LLM 做语义判断。
 *
 * @module @co-engram/core/dedup
 */

import { computeContentHash } from "../storage/hash.js";
import type {
  DedupCandidate,
  LlmTriageProvider,
  TriageInput,
  TriageResult,
} from "./types.js";

/** 启发式 triage 阈值（可配置） */
export interface HeuristicThresholds {
  /** title 完全相同 + similarity ≥ 此值 → UPDATE */
  readonly titleMatchUpdateThreshold: number;
  /** similarity ≥ 此值（无论 title）→ UPDATE */
  readonly highSimilarityUpdateThreshold: number;
  /** similarity ≥ 此值 → 至少考虑为 NEW（不合并） */
  readonly newRelatedThreshold: number;
}

export const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  titleMatchUpdateThreshold: 0.7,
  highSimilarityUpdateThreshold: 0.85,
  newRelatedThreshold: 0.5,
};

/**
 * 启发式 triage（不调用 LLM）
 *
 * 适合 P1 阶段测试和小规模数据；
 * 当候选 < 5 且规则明确时，与 LLM 结果接近。
 */
export class LocalHeuristicTriage implements LlmTriageProvider {
  constructor(
    private readonly thresholds: HeuristicThresholds = DEFAULT_THRESHOLDS,
  ) {}

  async triage(input: TriageInput): Promise<TriageResult> {
    return this.triageSync(input);
  }

  /**
   * 同步版本：用于 engram_create 自动 dedupe
   */
  triageSync(input: TriageInput): TriageResult {
    if (input.candidates.length === 0) {
      return {
        verdict: "NEW",
        reason: "no candidates",
        confidence: 1,
      };
    }

    const newHash = computeContentHash(input.newContent);

    let bestUpdate: { candidate: DedupCandidate; similarity: number } | null =
      null;
    let bestRelated: { candidate: DedupCandidate; similarity: number } | null =
      null;

    for (const candidate of input.candidates) {
      // 1. hash 完全匹配 → DUPLICATE
      if (newHash === candidate.contentHash) {
        return {
          verdict: "DUPLICATE",
          duplicateOf: candidate.id,
          reason: `exact contentHash match: ${candidate.contentHash}`,
          confidence: 1,
        };
      }

      const similarity = candidate.similarity;
      const titleMatch = candidate.title === input.newTitle;

      // 2/3. 判断 UPDATE 条件（信任引擎给出的 similarity）
      const shouldUpdate =
        (titleMatch &&
          similarity >= this.thresholds.titleMatchUpdateThreshold) ||
        similarity >= this.thresholds.highSimilarityUpdateThreshold;

      if (shouldUpdate && (!bestUpdate || similarity > bestUpdate.similarity)) {
        bestUpdate = { candidate, similarity };
        continue;
      }

      // 4. 记录可能相关（但不合并）
      if (similarity >= this.thresholds.newRelatedThreshold) {
        if (!bestRelated || similarity > bestRelated.similarity) {
          bestRelated = { candidate, similarity };
        }
      }
    }

    if (bestUpdate) {
      return {
        verdict: "UPDATE",
        updateTarget: bestUpdate.candidate.id,
        reason: `similarity=${bestUpdate.similarity.toFixed(3)} title=${bestUpdate.candidate.title === input.newTitle ? "match" : "diff"}`,
        confidence: bestUpdate.similarity,
      };
    }

    return {
      verdict: "NEW",
      reason: bestRelated
        ? `best related similarity=${bestRelated.similarity.toFixed(3)} below update threshold`
        : "no candidate above update threshold",
      confidence: 0.9,
    };
  }
}
