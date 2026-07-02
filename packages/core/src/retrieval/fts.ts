/**
 * Full Text Search（关键词匹配）
 *
 * 基于内存倒排索引。Task 4.1 把 P0 时代的中文 bigram 切分换成了
 * Intl.Segmenter(Node 22+ 内置,零新依赖),消除 bigram 跨词边界的假阳性。
 *
 * 策略:
 *   - 中文:Intl.Segmenter(granularity=word)按字典做词级切分,
 *     同时保留单字让短查询仍能命中(unigram 覆盖,无 bigram 假阳性)。
 *   - 英文:word boundary 切分
 *   - 大小写不敏感
 *
 * @module @co-engram/core/retrieval
 */

import type { DigestLine } from "../index/types.js";

/**
 * 中文 word segmenter(lazy 单例)
 *
 * Intl.Segmenter 实例可重用,构造有非零开销。模块级缓存让多次 tokenize 共享。
 */
let zhWordSegmenter: Intl.Segmenter | null = null;
function getZhSegmenter(): Intl.Segmenter | null {
  if (zhWordSegmenter !== null) return zhWordSegmenter;
  try {
    zhWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  } catch {
    zhWordSegmenter = null; // 旧 ICU / 非 zh 环境:fallback 到单字
  }
  return zhWordSegmenter;
}

/** Token 化结果
 *
 * mode 参数(P0-6 修复):
 *   - 'index':索引阶段。word-level segment 长度 > 1 时,额外补单字 token,
 *     让单字 query(如"团")能命中含该字的词(如"团队")。
 *   - 'query':查询阶段。不补单字 token,但 segmenter 输出的 word-level
 *     单字 token(如"调试"被切成["调","试"])正常加入。
 *
 * Task 4.1 anti-false-positive 的 trade-off(P0-6 修订):
 *   索引端补单字后,segmenter 不识别的 2 字 query(如"忆系")会产生跨词
 *   边界匹配(假阳性)。但用户极少查无意义 2 字组合,单字 query 极常见,
 *   trade-off 划算。FTS 真正消除假阳性需要 phrase matching(未实现)。
 */
function tokenize(text: string, mode: "index" | "query" = "index"): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // 英文 word
  const englishWords = lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
  tokens.push(...englishWords);

  // 中文段(Intl.Segmenter 也能切英文,但 regex 已处理;这里只跑中日韩段)
  const cjkSegments = lower.match(/[一-龥ぁ-んァ-ン]+/g) ?? [];
  const segmenter = getZhSegmenter();
  for (const seg of cjkSegments) {
    if (segmenter !== null) {
      // 词级切分:不额外生成单字 token,避免 "忆系" 这种跨词边界的查询命中
      // "记忆系统设计"(否则单字 "忆"/"系" 都在文档 tokens 里,导致假阳性)。
      // ICU 字典能识别的常见词("记忆"/"系统"/"设计")会作为一个 token,
      // 词典不识别的("调试"→["调","试"])按单字输出,符合用户直觉。
      const seen = new Set<string>();
      for (const { segment } of segmenter.segment(seg)) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          tokens.push(trimmed);
        }
        // P0-6 修复(index 模式):word-level segment 额外补单字 token,
        // 让单字 query(如"团")能命中含该字的词(如"团队")。
        // 仅 index 模式拆字;query 模式不拆,避免膨胀 query token 集合。
        if (mode === "index" && trimmed.length > 1) {
          for (const ch of trimmed) {
            if (/[一-龥ぁ-んァ-ン]/.test(ch) && !seen.has(ch)) {
              seen.add(ch);
              tokens.push(ch);
            }
          }
        }
      }
    } else {
      // fallback:无 Intl.Segmenter 时退到单字(不引入 bigram 假阳性)
      for (const ch of seg) tokens.push(ch);
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
    const tokens = new Set(tokenize(text, "index"));
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
  const queryTokens = tokenize(query, "query");
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

      // title 加权：如果 token 在 title 中(用 index 模式 tokenize,
      // 因为 doc.title 在索引阶段也用 index 模式,两端一致)
      const doc = index.docs.get(docId);
      if (doc && tokenize(doc.title, "index").includes(token)) {
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
