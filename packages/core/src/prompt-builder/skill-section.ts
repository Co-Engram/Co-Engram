/**
 * Skill catalog section(host-agnostic 渲染)
 *
 * 数据由 `@co-engram/core/skill` 的 `collectSkillCatalog()` 收集
 * (实时读 SKILL.md description + forgotten 过滤),本模块只做渲染。
 *
 * 两个形态,三通道复用:
 *   - `buildSkillSection`:行数组(core prompt-builder 第 6 段)
 *   - `formatSkillCatalog`:字符串(claude-code-mcp instructions 动态段 /
 *     openclaw-plugin before_prompt_build hook)
 *
 * @module @co-engram/core/prompt-builder
 */

import type { Language } from "../i18n/index.js";
import { translatePrompt } from "../i18n/index.js";
import type { SkillCatalogEntry } from "../skill/skill-catalog.js";

/**
 * 构建 skill catalog section(行数组)。
 *
 * 空列表返回 [](调用方决定是否注入)。
 */
export function buildSkillSection(
  skills: readonly SkillCatalogEntry[] | undefined,
  language: Language,
): readonly string[] {
  if (!skills || skills.length === 0) return [];
  return formatSkillCatalog(skills, language).split("\n");
}

/**
 * 格式化 skill catalog 为可注入 system prompt 的 i18n 文本。
 *
 * 空列表返回空字符串(调用方决定是否注入)。
 */
export function formatSkillCatalog(
  skills: readonly SkillCatalogEntry[],
  language: Language,
): string {
  if (skills.length === 0) return "";
  const entries = skills
    .map((s) =>
      translatePrompt(language, "prompt.skill.entry", {
        skillId: s.skillId,
        description: s.description,
      }),
    )
    .join("\n");
  return [
    translatePrompt(language, "prompt.skill.title"),
    translatePrompt(language, "prompt.skill.hint"),
    entries,
  ].join("\n");
}
