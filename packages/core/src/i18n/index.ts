/**
 * i18n 公共 API
 *
 * 翻译函数 + 工具描述本地化 + 语言解析工具。
 *
 * @module @co-engram/core/i18n
 */

import type { Language, StringKey, TranslationDict } from "./types.js";
import { en } from "./en.js";
import { zh } from "./zh.js";

// 配置相关 API 已迁至 @co-engram/core/config。这里保留 re-export 以向后兼容。
export {
  TEAM_MEMORY_CONFIG_FILENAME,
  readTeamMemoryConfig,
  writeTeamMemoryConfig,
} from "../config/index.js";
export type { TeamMemoryConfig } from "../config/types.js";
import type { TeamMemoryConfig } from "../config/types.js";

/**
 * 默认语言
 *
 * 默认中文(本项目主要面向中文团队)。国际团队可在 `.co-engram/config.json`
 * 或 `CO_ENGRAM_LANGUAGE=en` 显式覆盖。
 */
export const DEFAULT_LANGUAGE: Language = "zh";

/**
 * 所有支持的语言
 */
export const SUPPORTED_LANGUAGES: readonly Language[] = ["en", "zh"];

/**
 * 字典表(只读)
 */
const DICTIONARIES: Readonly<Record<Language, TranslationDict>> = {
  en,
  zh,
};

/**
 * 把任意字符串解析为 Language,无法识别时返回默认语言
 *
 * 接受 'en' / 'zh' / 'EN' / 'ZH' / 'english' / 'chinese' / 'zh-CN' / 'zh-CN' 等。
 */
export function parseLanguage(raw: string | undefined | null): Language {
  if (!raw) return DEFAULT_LANGUAGE;
  const lower = raw.toLowerCase().trim();
  if (lower === "en" || lower === "english") return "en";
  if (lower.startsWith("zh") || lower === "chinese" || lower === "cn")
    return "zh";
  return DEFAULT_LANGUAGE;
}

/**
 * 翻译函数
 *
 * - 在字典里找不到 key 时,返回 key 本身(便于发现遗漏)
 * - 接受可选的 vars 参数,做 ${name} 模板替换
 *
 * @example
 * ```ts
 * t('en', 'tool.engram_create')
 * t('zh', 'prompt.proposal_prompt', { count: 3, plural: 's' })
 * ```
 */
export function t(
  language: Language,
  key: StringKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const dict = DICTIONARIES[language] ?? en;
  const template = dict[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\$\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `\${${name}}`,
  );
}

/**
 * 本地化工具描述
 *
 * 在 i18n 字典里没有对应翻译时,fallback 到原始 description(向后兼容)。
 *
 * @param toolName snake_case 工具名,如 'engram_create'
 * @param language 目标语言
 * @param fallback 原始 description(host adapter 注入)
 */
export function localizeToolDescription(
  toolName: string,
  language: Language,
  fallback?: string,
): string {
  const key = `tool.${toolName}` as StringKey;
  const dict = DICTIONARIES[language] as Readonly<Record<string, string>>;
  const translated = dict[key];
  if (translated) return translated;
  // fallback 顺序:目标语言找不到 → 英文 → 原始
  const enDict = en as Readonly<Record<string, string>>;
  return enDict[key] ?? fallback ?? toolName;
}

/**
 * 翻译字符串并把模板变量替换好(等价于 t())
 *
 * 主要用于 host adapter 在 register 时一次性把模板字符串转成最终文本。
 */
export function translatePrompt(
  language: Language,
  key: StringKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return t(language, key, vars);
}

/**
 * 把数字按英文复数规则返回 's' 或 ''
 *
 * 中文场景下返回 ''(中文没有复数形式),英文场景下 1 返回 '' 其余返回 's'。
 */
export function pluralSuffix(language: Language, count: number): string {
  if (language === "en") return count === 1 ? "" : "s";
  return "";
}

/**
 * 解析语言优先级
 *
 * 解析顺序(高 → 低):
 *   1. envLanguage 显式传入(来自 CO_ENGRAM_LANGUAGE)
 *   2. team-memory 持久化配置(`.co-engram/config.json`)
 *   3. DEFAULT_LANGUAGE
 *
 * 这样可以让 env 覆盖持久化配置(临时实验),持久化覆盖默认。
 *
 * @param envLanguage 来自环境变量的值(可识别 'en'/'zh' 等)
 * @param persistedConfig 来自 .co-engram/config.json 的配置(可能为 undefined)
 */
export function resolveLanguage(
  envLanguage: string | undefined,
  persistedConfig?: TeamMemoryConfig,
): Language {
  if (envLanguage) return parseLanguage(envLanguage);
  if (persistedConfig?.language) return parseLanguage(persistedConfig.language);
  return DEFAULT_LANGUAGE;
}

/**
 * 读取 team-memory 持久化配置
 *
 * 文件路径:`${dataRoot}/.co-engram/${TEAM_MEMORY_CONFIG_FILENAME}`
 *
 * 如果文件不存在或解析失败,返回 undefined(不抛错,因为首次启动时确实没有)。
 *
 * @param dataRoot team-memory 根目录
 * @param fsRead 可选的自定义读取函数(测试注入用);默认走 node:fs
 */
// readTeamMemoryConfig / writeTeamMemoryConfig 已迁至 @co-engram/core/config,
// 此处由顶部 `export ... from '../config/index.js'` 提供。
// 保留 unresolved re-export 以维持向后兼容的命名导入。

export { en, zh };
export type { Language, StringKey, TranslationDict };
