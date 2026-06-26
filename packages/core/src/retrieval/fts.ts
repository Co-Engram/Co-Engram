/**
 * Full Text Search（关键词匹配）
 *
 * 简单实现：基于 digest.jsonl 的内存倒排索引。
 * P1 阶段会替换为 MiniSearch 等成熟方案；P0 先用极简实现验证流程。
 *
 * 策略：
 *   - 中文：按字符切分（bigram）
 *   - 英文：按 word boundary 切分
 *   - 大小写不敏感
 *
 * @module @co-engram/core/retrieval
 */

import type { DigestLine } from "../index/types.js";

/** Token 化结果 */
function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // 英文 word
  const englishWords = lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
  tokens.push(...englishWords);

  // 中文 bigram
  const chineseSegments = lower.match(/[一-龥]+/g) ?? [];
  for (const seg of chineseSegments) {
    if (seg.length === 1) {
      tokens.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg.slice(i, i + 2));
      }
      // 也加入单字，便于短查询匹配
      for (const ch of seg) {
        tokens.push(ch);
      }
    }
  }

  // 数字
  const numbers = lower.match(/\d+/g) ?? [];
  tokens.push(...numbers);

  return tokens;
}

/**
 * FTS 索引（简化版：基于 token -> docId set 的倒排索引）
 */
export interface FtsIndex {
  /** token -> Set<docId> */
  readonly inverted: ReadonlyMap<string, ReadonlySet<string>>;
  /** docId -> token set（用于快速过滤） */
  readonly docTokens: ReadonlyMap<string, ReadonlySet<string>>;
  /** docId -> DigestLine */
  readonly docs: ReadonlyMap<string, DigestLine>;
}

/**
 * 构建 FTS 索引
 *
 * 索引字段：title + summary + domainTags
 */
export function buildFtsIndex(lines: Iterable<DigestLine>): FtsIndex {
  const inverted = new Map<string, Set<string>>();
  const docTokens = new Map<string, Set<string>>();
  const docs = new Map<string, DigestLine>();

  for (const line of lines) {
    docs.set(line.id, line);
    const text = [
      line.title,
      line.summary,
      line.domainTags.join(" "),
      line.contextTags.join(" "),
    ].join(" ");
    const tokens = new Set(tokenize(text));
    docTokens.set(line.id, tokens);

    for (const token of tokens) {
      let postings = inverted.get(token);
      if (!postings) {
        postings = new Set();
        inverted.set(token, postings);
      }
      postings.add(line.id);
    }
  }

  return {
    inverted: inverted as ReadonlyMap<string, ReadonlySet<string>>,
    docTokens: docTokens as ReadonlyMap<string, ReadonlySet<string>>,
    docs,
  };
}

/** FTS 搜索结果 */
export interface FtsHit {
  readonly docId: string;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

/**
 * 在 FTS 索引上搜索
 *
 * 计分：每个匹配 token 加 1 分；title 中的 token 加权（2x）
 */
export function searchFts(
  query: string,
  index: FtsIndex,
  limit = 50,
): FtsHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const scores = new Map<string, { score: number; matched: Set<string> }>();

  for (const token of queryTokens) {
    const postings = index.inverted.get(token);
    if (!postings) {
      continue;
    }
    for (const docId of postings) {
      let entry = scores.get(docId);
      if (!entry) {
        entry = { score: 0, matched: new Set() };
        scores.set(docId, entry);
      }
      // 基础分
      entry.score += 1;
      entry.matched.add(token);

      // title 加权：如果 token 在 title 中
      const doc = index.docs.get(docId);
      if (doc && tokenize(doc.title).includes(token)) {
        entry.score += 1;
      }
    }
  }

  return Array.from(scores.entries())
    .map(([docId, { score, matched }]) => ({
      docId,
      score,
      matchedTokens: Array.from(matched),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
