/**
 * 运行时描述质量校验(Task 3.1)
 *
 * 与 `auditDescriptionQuality` 平行,但服务不同场景:
 *   - `auditDescriptionQuality`:CI gate 用,返回违规列表
 *   - `applyRuntimeCheck`:运行时用,根据 failMode 决定 throw 或 warn
 *
 * 解决 root cause AF(spec 时约束运行时无强制):
 *   之前 FORBIDDEN_TERMS 仅在测试时检查,生产 host 启动时即使描述被恶意
 *   改成含禁词也不报错。本模块在 resolveLlmDescription 链路上加入运行时校验,
 *   让违规描述"无法被 silently resolved"。
 *
 * @module @co-engram/core/observability
 */

import { FORBIDDEN_TERMS } from "../tools/llm-descriptions.js";
import { validationError } from "../tools/error-schema.js";

/** 失败模式 */
export type FailMode = "strict" | "warn";

/** 运行时校验选项 */
export interface RuntimeCheckOptions {
  /**
   * 失败模式:
   *   - `strict`(生产 host 启动时用):含禁词 → throw
   *   - `warn`(默认,不破坏现有调用):含禁词 → log + 文本加 [⚠ description violates] 前缀
   */
  readonly failMode?: FailMode;
  /** warn 模式下的告警回调(默认 no-op) */
  readonly onWarn?: (msg: string) => void;
}

/** 单条违规 */
export interface DescriptionViolation {
  /** 触发违规的禁词 */
  readonly term: string;
  /** 人类可读的违规消息 */
  readonly message: string;
}

/**
 * 在描述文本中查找禁词
 *
 * `truthScore` 在 `engram_get` 的 RETURNS 段是允许的(作为字段名引用),
 * 与 `auditDescriptionQuality` 保持一致的例外。
 */
export function findForbiddenTerms(
  text: string,
  toolName: string,
): readonly DescriptionViolation[] {
  const isEngramGet = toolName === "engram_get";
  const violations: DescriptionViolation[] = [];
  for (const term of FORBIDDEN_TERMS) {
    if (term === "truthScore" && isEngramGet) continue;
    if (text.includes(term)) {
      violations.push({
        term,
        message: `forbidden term "${term}" in tool "${toolName}" description`,
      });
    }
  }
  return violations;
}

/**
 * 对描述文本应用运行时校验
 *
 * 行为:
 *   - 无违规 → 原样返回 text
 *   - 有违规 + strict → throw Error(消息含 "forbidden term" 前缀,便于测试 / 日志检索)
 *   - 有违规 + warn → 调用 onWarn 回调,返回 `[⚠ description violates] ${text}` 标记文本
 *
 * 默认 failMode 为 `warn`(向后兼容:现有调用方不会因描述漂移而崩溃)。
 * 生产 host(claude-code-mcp / openclaw-plugin)在启动注册工具时应传 `strict`,
 * 让禁词在 dev/ci 阶段立刻暴露。
 */
export function applyRuntimeCheck(
  text: string,
  toolName: string,
  options: RuntimeCheckOptions = {},
): string {
  const failMode = options.failMode ?? "warn";
  const violations = findForbiddenTerms(text, toolName);
  if (violations.length === 0) return text;

  const messages = violations.map((v) => v.message).join("; ");

  if (failMode === "strict") {
    throw validationError(`forbidden term: ${messages}`);
  }

  if (options.onWarn) {
    options.onWarn(messages);
  }
  return `[⚠ description violates] ${text}`;
}
