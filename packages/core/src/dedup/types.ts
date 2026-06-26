/**
 * 智能去重类型定义
 *
 * FlexMem 风格的三态判断（DUPLICATE / UPDATE / NEW）。
 *
 * 流程：
 *   1. 精确匹配：contentHash 是否已存在 → DUPLICATE
 *   2. 相似度召回：Top-K 候选（token Jaccard 或向量余弦）
 *   3. LLM/启发式 triage：在候选中裁决 → DUPLICATE / UPDATE / NEW
 *   4. 处理：
 *      - DUPLICATE：跳过创建，强化原 engram（LTP）
 *      - UPDATE：合并 + version+1 + mergeHistory 记录
 *      - NEW：正常创建
 *
 * @module @co-engram/core/dedup
 */

import type { EngramId } from "../types/engram.js";

/** 三态裁决 */
export type DedupVerdict = "DUPLICATE" | "UPDATE" | "NEW";

/** 去重候选 */
export interface DedupCandidate {
  readonly id: EngramId;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly contentHash: string;
  readonly similarity: number; // [0,1]
}

/** triage 输入（候选 + 新内容） */
export interface TriageInput {
  readonly newTitle: string;
  readonly newContent: string;
  readonly candidates: readonly DedupCandidate[];
}

/** triage 输出 */
export interface TriageResult {
  readonly verdict: DedupVerdict;
  /** verdict=DUPLICATE 时指向被复制的 engram */
  readonly duplicateOf?: EngramId;
  /** verdict=UPDATE 时指向被更新的 engram */
  readonly updateTarget?: EngramId;
  readonly reason: string;
  readonly confidence: number; // [0,1]
}

/** 去重总结果 */
export interface DedupResult {
  readonly verdict: DedupVerdict;
  readonly targetId?: EngramId;
  readonly reason: string;
  readonly confidence: number;
  readonly candidatesConsidered: number;
}

/** 相似度引擎接口（P1: token Jaccard；P2: 向量余弦） */
export interface SimilarityEngine {
  findCandidates(
    text: string,
    options: { topK: number; minSimilarity: number },
  ): Promise<readonly DedupCandidate[]>;
}

/** LLM triage 接口（宿主提供，core 不绑定 provider） */
export interface LlmTriageProvider {
  triage(input: TriageInput): Promise<TriageResult>;
}

/** 合并记录（写入 meta.mergeHistory） */
export interface MergeHistoryEntry {
  readonly at: string;
  readonly fromHash: string;
  readonly toHash: string;
  readonly reason: string;
  readonly mergedBy: string;
}
