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
   *
   * 性能(2026-07 schema v4 修复):原走 listEngrams + 逐个 readEngram
   * (1026 engram × readEngram ≈ 18s,readEngram 内部扫 synapses/ 目录)。
   * 现走 readContentBatch(单次 SQL JOIN engram_fts 拉齐 title + summary +
   * content_tokens)+ 内存 tokenize/Jaccard,N+1 消除。
   *
   * 语义不变:仍基于 title + summary + content 的 bigram + word Jaccard。
   * contentHash 字段从 readDigestBatch 拿(DigestLine 有 contentHash)。
   */
  findCandidatesSync(
    text: string,
    options: { topK: number; minSimilarity: number },
  ): readonly DedupCandidate[] {
    const queryTokens = tokenizeForDedup(text);
    if (queryTokens.size === 0) return [];

    const allIds = this.repo.listEngrams().map((e) => e.id);
    if (allIds.length === 0) return [];
    // 批量拉 content(SQL 端 JOIN engram_fts 一次完成)
    const contents = this.repo.readContentBatch(allIds);
    // contentHash 从 DigestLine 拿(content_batch 不返回该字段,避免重复)
    const lines = this.repo.readDigestBatch(allIds);
    const hashById = new Map<string, string>();
    for (const line of lines) hashById.set(line.id, line.contentHash);

    const candidates: DedupCandidate[] = [];
    for (const row of contents) {
      const engramTokens = tokenizeForDedup(
        `${row.title} ${row.summary} ${row.content}`,
      );
      const similarity = jaccardSimilarity(queryTokens, engramTokens);
      if (similarity < options.minSimilarity) continue;
      candidates.push({
        id: row.id,
        title: row.title,
        summary: row.summary,
        content: row.content,
        contentHash: hashById.get(row.id) ?? "",
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
