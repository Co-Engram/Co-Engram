/**
 * 相似度候选查找
 *
 * P1 实现：Token Jaccard 相似度（中英混合分词）
 * P2 升级：向量余弦相似度（embedding model）
 *
 * 接口稳定：SimilarityEngine 抽象，P2 替换底层实现即可。
 *
 * @module @co-engram/core/dedup
 */

import type { EngramRepository } from "../storage/repository.js";
import type { DedupCandidate, SimilarityEngine } from "./types.js";

/**
 * Token 化（与 retrieval/fts.ts 保持一致的策略）
 *
 * - 中文：单字 + bigram
 * - 英文：word boundary
 * - 小写化
 */
export function tokenizeForDedup(text: string): Set<string> {
  if (!text) return new Set();
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  const englishWords = lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
  for (const w of englishWords) tokens.add(w);

  const chineseSegments = lower.match(/[一-龥]+/g) ?? [];
  for (const seg of chineseSegments) {
    if (seg.length === 1) {
      tokens.add(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2));
      }
      for (const ch of seg) tokens.add(ch);
    }
  }

  const numbers = lower.match(/\d+/g) ?? [];
  for (const n of numbers) tokens.add(n);

  return tokens;
}

/**
 * Jaccard 相似度：|A ∩ B| / |A ∪ B|
 *
 * 返回 [0,1]，越大越相似。
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Token Jaccard 相似度引擎（P1 默认实现）
 */
export class TokenJaccardSimilarityEngine implements SimilarityEngine {
  constructor(private readonly repo: EngramRepository) {}

  async findCandidates(
    text: string,
    options: { topK: number; minSimilarity: number },
  ): Promise<readonly DedupCandidate[]> {
    return this.findCandidatesSync(text, options);
  }

  /**
   * 同步版本：用于 engram_create 自动 dedupe（无 IO 等待）
   */
  findCandidatesSync(
    text: string,
    options: { topK: number; minSimilarity: number },
  ): readonly DedupCandidate[] {
    const queryTokens = tokenizeForDedup(text);
    if (queryTokens.size === 0) return [];

    const candidates: DedupCandidate[] = [];
    for (const entry of this.repo.listEngrams()) {
      const engram = this.repo.readEngram(entry.id);
      const engramTokens = tokenizeForDedup(
        `${engram.title} ${engram.summary} ${engram.content}`,
      );
      const similarity = jaccardSimilarity(queryTokens, engramTokens);
      if (similarity < options.minSimilarity) continue;
      candidates.push({
        id: engram.id,
        title: engram.title,
        summary: engram.summary,
        content: engram.content,
        contentHash: engram.contentHash,
        similarity,
      });
    }

    return candidates
      .sort((a, b) => {
        if (a.similarity !== b.similarity) return b.similarity - a.similarity;
        return a.id < b.id ? -1 : 1; // 稳定排序
      })
      .slice(0, options.topK);
  }
}
