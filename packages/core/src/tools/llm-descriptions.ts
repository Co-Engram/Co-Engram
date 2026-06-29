/**
 * LLM-facing tool description resolution (host-agnostic)
 *
 * 历史上这里维护一个独立的 `LLM_TOOL_DESCRIPTIONS` 常量,与 i18n 字典并行,
 * 容易漂移。Finding 107/111 的三层拆分重构把 agent 层描述统一迁入 i18n 字典
 * (`tool.<name>.agent`),实现单一真相源。本模块仅保留薄薄的解析/审计/override 函数,
 * 全部委托到 `localizeToolDescription(..., layer='agent')`。
 *
 * @module @co-engram/core/tools
 */

import type { Language, Tool } from "../index.js";
import { localizeToolDescription, en, zh } from "../i18n/index.js";
import {
  applyRuntimeCheck,
  type RuntimeCheckOptions,
} from "../observability/runtime-description-check.js";

/**
 * Resolve a tool's LLM-facing description.
 *
 * Resolution order:
 *   1. i18n 字典 `tool.<name>.agent`(单一真相源,迁移自原 LLM_TOOL_DESCRIPTIONS)
 *   2. fallback (caller-provided default, usually the core `tool.*` i18n string)
 *
 * 返回字符串,不修改入参。
 *
 * Task 3.1 后:解析结果会被运行时校验(FORBIDDEN_TERMS)。默认 `warn` 模式
 * (含禁词时返回带 [⚠ description violates] 前缀的标记文本)。生产 host 启动时
 * 应传 `options.failMode = 'strict'`,让违规描述立刻 throw。
 */
export function resolveLlmDescription<T extends Tool>(
  tool: T,
  language: Language,
  fallback?: string,
  options?: RuntimeCheckOptions,
): string {
  // localizeToolDescription 的最终 fallback 是 toolName;此处把 tool.description
  // 作为中间 fallback,保持与原 LLM_TOOL_DESCRIPTIONS 时代一致的语义:
  // agent 字典 → fallback (caller 提供) → tool.description → toolName
  const resolved = localizeToolDescription(
    tool.name,
    language,
    fallback ?? tool.description,
    "agent",
  );
  return applyRuntimeCheck(resolved, tool.name, options);
}

/**
 * Override 工具的 description
 *
 * 如果 `tool.<name>.agent` 在 i18n 字典中存在,返回新的 tool(描述被替换);
 * 否则返回原 tool(保持 caller 注入的 description / core i18n 描述)。
 *
 * 不修改输入 tool(返回新对象)。
 */
export function overrideDescription<T extends Tool>(
  tool: T,
  language: Language,
): T {
  const dict = (language === "zh" ? zh : en) as Readonly<Record<string, string>>;
  const key = `tool.${tool.name}.agent`;
  const newDescription = dict[key];
  if (!newDescription) return tool;
  return { ...tool, description: newDescription };
}

/**
 * 批量 override(immutable,不修改输入数组)
 */
export function overrideDescriptions<T extends Tool>(
  tools: readonly T[],
  language: Language,
): readonly T[] {
  return tools.map((t) => overrideDescription(t, language));
}

/**
 * 被禁止的实现术语(出现则视为描述不 LLM-friendly)
 *
 * 这些是开发者视角的术语,LLM 看到反而困惑。
 * technical 层允许;agent 层禁止。
 */
const FORBIDDEN_TERMS: readonly string[] = [
  "FTS",
  "LTP",
  "Hebbian",
  "RPE",
  "reinforcementScore",
  "effectiveRetrievals",
  "failedUses",
  "engram_reinforce", // 不应在描述里引用其他工具的内部字段
  "truthScore", // 例外:engram_get 描述里可以保留作为字段名
];
export { FORBIDDEN_TERMS };

/**
 * 列出 i18n 字典中所有 agent 层 key 对应的工具名
 *
 * 用于测试枚举覆盖度。返回工具名(去掉 `tool.` 前缀和 `.agent` 后缀)。
 */
export function listAgentDescribedTools(): readonly string[] {
  const dict = en as Readonly<Record<string, string>>;
  return Object.keys(dict)
    .filter((k) => k.startsWith("tool.") && k.endsWith(".agent"))
    .map((k) => k.slice("tool.".length, -".agent".length));
}

/**
 * 检查描述质量(用于测试 / CI gate)
 *
 * 返回违规列表(空 = 合格)。
 * 'truthScore' 在 engram_get 的 RETURNS 段是允许的(作为字段名引用)。
 */
export function auditDescriptionQuality(
  name: string,
  language: Language,
): readonly string[] {
  const dict = (language === "zh" ? zh : en) as Readonly<Record<string, string>>;
  const text = dict[`tool.${name}.agent`];
  if (!text) return [`tool "${name}" has no LLM-facing description`];
  const violations: string[] = [];

  // 结构检查
  if (!text.includes("WHEN TO CALL") && !text.includes("何时调用")) {
    violations.push('missing "WHEN TO CALL" / "何时调用" section');
  }
  if (!text.includes("RETURNS") && !text.includes("返回")) {
    violations.push('missing "RETURNS" / "返回" section');
  }

  // 长度检查(中文信息密度高,阈值放宽)
  const minLength = language === "zh" ? 80 : 150;
  const maxLength = language === "zh" ? 500 : 800;
  if (text.length < minLength) {
    violations.push(
      `description too short (${text.length} < ${minLength} chars)`,
    );
  }
  if (text.length > maxLength) {
    violations.push(
      `description too long (${text.length} > ${maxLength} chars)`,
    );
  }

  // 禁止术语检查(truthScore 在 engram_get 例外)
  const isEngramGet = name === "engram_get";
  for (const term of FORBIDDEN_TERMS) {
    if (term === "truthScore" && isEngramGet) continue;
    if (text.includes(term)) {
      violations.push(`forbidden term "${term}"`);
    }
  }

  return violations;
}
