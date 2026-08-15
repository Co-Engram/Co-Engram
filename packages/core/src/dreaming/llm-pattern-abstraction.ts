/**
 * LLM-based PatternAbstractionProvider(Feature 2:REM dreaming 用 LLM 综合取代启发式)
 *
 * 与 `engram_synthesize` 工具(Feature 1:手工触发 REM)共享 prompt 模板、
 * samples block 构造器、LLM 输出解析器 —— 单一真相源,避免逻辑分裂。
 *
 * 与 `LocalHeuristicPatternAbstraction` 的关系:
 *   - LLM 可用 → LLM 语义抽象(质量高,捕获跨字面相似性的深层模式)
 *   - LLM 调用失败 / 解析失败 / client 未注入 → fallback 到 LocalHeuristic
 *     (启发式基于 token 频率,质量低但总能产出 output,保证 REM 不挂)
 *
 * 这种 fallback 模式与 `LlmNecessityEvaluator`(LLM 失败回退到 RuleBased)一致,
 * 让 LLM 增强是"加性"的:配置了就升级体验,没配置或不通就退到原有行为。
 *
 * @module @co-engram/core/dreaming
 */

import type { LlmClient } from "../observability/necessity-evaluator.js";
import {
  SYNTHESIS_PROMPT,
  buildSamplesBlock,
  parseSynthesisOutput,
} from "../tools/synthesize-tools.js";
import {
  LocalHeuristicPatternAbstraction,
  type AbstractionInput,
  type AbstractionOutput,
  type PatternAbstractionProvider,
} from "./rem.js";

/**
 * LLM 模式抽象 provider
 *
 * 内部包装 LocalHeuristicPatternAbstraction 作为 fallback,
 * 保证 LLM 失败时 REM 仍能产出低质量但可用的 output。
 */
export class LlmPatternAbstraction implements PatternAbstractionProvider {
  private readonly fallback = new LocalHeuristicPatternAbstraction();

  constructor(private readonly client: LlmClient) {}

  async abstract(input: AbstractionInput): Promise<AbstractionOutput> {
    if (input.engrams.length === 0) {
      // 空 cluster 直接走 fallback(LocalHeuristic 也处理空 cluster)
      return this.fallback.abstract(input);
    }

    const samplesBlock = buildSamplesBlock(input.engrams);
    const prompt = SYNTHESIS_PROMPT.replace(
      "<SAMPLE_COUNT>",
      String(input.engrams.length),
    )
      .replace("<SAMPLES_BLOCK>", samplesBlock)
      .replace("<HINTS_BLOCK>", "");

    let raw: unknown;
    try {
      // 效果优先(2026-08-15 用户决策):预算给到模型上限,不做人为收紧。
      // 思考型模型(GLM 等)thinking 块即可耗尽小预算 → text 为空 → 解析失败
      // → 静默降级回启发式垃圾;GLM 实测单次 126-263s,REM 为后台低频任务,
      // 600s 超时给足。
      raw = await this.client.complete(prompt, {
        maxTokens: 131072,
        temperature: 0.3,
        timeoutMs: 600_000,
      });
    } catch {
      // LLM 调用失败 → 启发式兜底
      return this.fallback.abstract(input);
    }

    if (typeof raw !== "string" || raw.length === 0) {
      return this.fallback.abstract(input);
    }

    const draft = parseSynthesisOutput(raw);
    if (!draft) {
      // LLM 返回非 JSON / 字段缺失 → 启发式兜底
      return this.fallback.abstract(input);
    }

    return {
      title: draft.title,
      content: draft.content,
      summary: draft.summary,
      confidence: draft.confidence,
      reason: draft.reason,
      provider: "llm",
    };
  }
}
