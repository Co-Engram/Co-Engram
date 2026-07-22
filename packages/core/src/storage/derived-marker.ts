/**
 * 派生突触段的 marker + 剥离函数(leaf 模块,零依赖)。
 *
 * 抽成独立叶子模块是为了让 `hash.ts` 能复用剥离逻辑而**不引入环依赖**:
 *   hash.ts →(若 import obsidian-links)→ engram-store → hash.ts 会成环。
 * derived-marker 不 import 任何东西,hash.ts / obsidian-links.ts 都安全地依赖它。
 *
 * 派生段是 synapse 的 denormalized 视图(权威源是 synapse yaml),可丢失、可重建、
 * 每次 doctor 的 regenerateObsidianLinks 会重写。故 contentHash/contentSize 必须在
 * **剥除派生段后的原始内容**上计算,否则派生段一变 hash 就漂移、doctor 反复误报 stale。
 *
 * @module @co-engram/core/storage
 */

/** 派生段起始 marker,兼作剥离锚点(与 obsidian-links 渲染输出一致)。 */
export const DERIVED_SYNAPSES_MARKER = "<!-- co-engram-derived:synapses -->";

/**
 * 剥离现有派生段(从 MARKER 至文件末尾),返回干净正文。
 *
 * 不存在 marker 时返回原 content(去尾换行)。
 */
export function stripDerivedSection(content: string): string {
  const idx = content.indexOf(DERIVED_SYNAPSES_MARKER);
  if (idx < 0) return content.replace(/\n+$/, "");
  return content.slice(0, idx).replace(/\n+$/, "");
}
