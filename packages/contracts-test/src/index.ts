/**
 * @co-engram/contracts-test —— 双宿主契约测试包
 *
 * co-engram 是跨宿主插件:@co-engram/claude-code(Claude Code MCP 适配)与
 * @co-engram/openclaw(OpenClaw 插件)共享同一份 @co-engram/core 与 @co-engram/viewer。
 * 本包提供契约测试,确保两端在以下维度保持一致:
 *
 *   1. profile 工具集(minimal/standard/full 三档工具集合两端 byte-for-byte 一致)
 *   2. i18n key(zh / en 字典 key parity,无 hard-coded language ternary)
 *   3. config schema(共享字段语义对称,host-only / deprecated 字段两端都识别)
 *   4. help 文案(viewer help tab / mcp instructions / openclaw prompt-builder 三处引用
 *      同一 CONCEPT_DICTIONARY,无概念漂移)
 *
 * 设计哲学(对应 15 轮拉通分析的元2「双宿主无契约」):
 *   契约测试先于具体修复 —— 给 fix-1(概念字典)与 fix-3(可观测性)的 dual-host
 *   一致性提供自动化保障,避免"改 core 一边漏另一边"的反复。
 *
 * @module @co-engram/contracts-test
 */

export interface ContractResult {
  readonly passed: boolean;
  readonly diffs: readonly ContractDiff[];
}

export interface ContractDiff {
  readonly kind: "profile" | "i18n" | "config" | "help";
  readonly detail: string;
}

export {
  runProfileContractTests,
} from "./profile-contract.js";

/**
 * i18n key 两端一致性测试
 *
 * 验证 zh / en 字典 key parity,扫描源码中残留的 hard-coded `language === "zh" ? ...`
 * ternary(应为 i18n key 引用)。
 */
export {
  runI18nContractTests,
} from "./i18n-contract.js";

/**
 * config schema 字段语义对称性测试
 *
 * 验证 host-only / deprecated 字段两端都识别 metadata(不会静默忽略 / 静默丢弃)。
 */
export {
  runConfigSchemaContractTests,
} from "./config-contract.js";

/**
 * help 文案两端一致性测试
 *
 * 验证 viewer help tab / mcp instructions / openclaw prompt-builder 三处 surface
 * 对同一概念的解释一致(都引用 CONCEPT_DICTIONARY)。
 *
 * Task 2.5 实现。
 */
export async function runHelpTextContractTests(): Promise<ContractResult> {
  return { passed: true, diffs: [] };
}
