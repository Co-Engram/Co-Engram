/**
 * Skill Chaining 候选检测（spec §3 + Options Skill Chaining）
 *
 * 判据：skill A 的 termination 与 skill B 的 initiationSet 的 token 重叠
 * （A 完成的状态 ≈ B 启动的情境）→ 建议组合（A→B）。
 * **只返回候选，不自动建**（低质量文本推断只建议，由用户/LLM 决定）。
 * @module @co-engram/core/skill
 */
import type { Skill } from "../types/skill.js";

/** 中文/英文停用词（不计入重合） */
const STOP_WORDS = new Set([
  // 中文
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "们", "和", "与", "或", "一个", "一种", "这", "那", "当", "后", "时", "前", "中",
  // 英文
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "should", "could", "may", "might", "must", "can", "shall", "to", "of", "in", "on", "at", "by", "for", "with", "about", "as", "into", "like", "through", "after", "over", "between", "out", "against", "during", "without", "before", "under", "around", "among",
  // 通用动词/代词（弱信号）
  "use", "using", "used", "when", "then", "if", "else",
]);

/**
 * 分词：英文按空格/标点 split；中文按字符 bigram；小写；去停用词。
 * 简单实现（不依赖外部分词器），够 Skill Chaining 重合判断用。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase();
  // 英文词（含数字）
  const asciiWords = normalized.match(/[a-z0-9]+/g) ?? [];
  for (const w of asciiWords) {
    if (w.length > 1 && !STOP_WORDS.has(w)) tokens.add(w);
  }
  // 中文 bigram（连续 CJK 字符两两组合）
  const cjkRuns = normalized.match(/[一-鿿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      if (!STOP_WORDS.has(run)) tokens.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 2);
        if (!STOP_WORDS.has(bg)) tokens.add(bg);
      }
    }
  }
  return tokens;
}

export interface ComposeCandidate {
  readonly from: string;      // A.skillId
  readonly to: string;        // B.skillId
  readonly overlap: readonly string[];  // 重合 tokens（示例，便于人审）
}

/**
 * 检测所有 Skill Chaining 候选：对每对 (A,B)，termination(A) ∩ initiationSet(B) 非空 → 候选 A→B。
 * @param skills 所有 skill（含 termination + initiationSet）
 * @param minOverlap 最小重合 token 数（默认 1）
 */
export function detectComposeCandidates(
  skills: readonly Skill[],
  options: { readonly minOverlap?: number } = {},
): ComposeCandidate[] {
  const minOverlap = options.minOverlap ?? 1;
  // 预计算每个 skill 的 termination + initiationSet tokens
  const indexed = skills.map((s) => ({
    skill: s,
    terminationTokens: tokenize(s.termination),
    initiationTokens: tokenize(s.initiationSet),
  }));
  const out: ComposeCandidate[] = [];
  for (const a of indexed) {
    for (const b of indexed) {
      if (a.skill.skillId === b.skill.skillId) continue;  // 不自环
      // termination(A) ∩ initiationSet(B)
      const overlap: string[] = [];
      for (const t of a.terminationTokens) {
        if (b.initiationTokens.has(t)) overlap.push(t);
      }
      if (overlap.length >= minOverlap) {
        out.push({ from: a.skill.skillId, to: b.skill.skillId, overlap });
      }
    }
  }
  return out;
}
