/**
 * 概念字典 —— co-engram 神经科学概念的单一真相源
 *
 * 详见 {@link dictionary.ts} 的 docstring。
 *
 * @module @co-engram/core/concepts
 */

export * from "./types.js";
export {
  CONCEPT_DICTIONARY,
  getConcept,
  formatScore,
} from "./dictionary.js";
