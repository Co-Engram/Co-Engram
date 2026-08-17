/**
 * 独立 critic —— 提案生成时的第二次 LLM 调用(spec §五第一关)。
 *
 * 为什么独立调用而非同调用两段:审查确认「同调用 critic」是自我偏好换皮,
 * 机械校验兜不住该偏差维度;按「token 不是重点」原则取质量优先,
 * 单调用两段仅作降级选项(本模块不实现降级 —— 宁缺毋滥,fail-closed)。
 *
 * 评分是**机器主观初值而非客观真值**(spec §五第二关语义标注),
 * 参与后续 metacognition 轮转时按普通 confidence 对待。
 *
 * @module @co-engram/core/maintenance/insight
 */

import type { LlmClient } from "../../observability/necessity-evaluator.js";
import type { Language } from "../../i18n/types.js";
import type { CriticScore, DeepThoughtMode, InsightDraft, InsightSubgraph } from "./types.js";
import { serializeSubgraph } from "./modes.js";

/** 模式专属 rubric 前缀(四维评分共用骨架) */
const MODE_RUBRIC: Readonly<Record<DeepThoughtMode, string>> = {
  integration:
    "Mode rubric — INTEGRATION: does the theme generalize across >=2 distinct source contexts (cross-contextuality)? Is it a genuinely new structure, or a restatement of one memory?",
  retrospective:
    "Mode rubric — RETROSPECTIVE (AAR): is the causal chain complete (expected -> actual -> cause -> improvement) and actionable? An insight missing a link or without a concrete next change must score low.",
  inspiration:
    "Mode rubric — INSPIRATION: is the analogy structurally grounded (relational mapping, not surface vocabulary)? A far-fetched pairing must score low on consistency.",
};

function clamp01(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 剥离 ```json 围栏 / 提取首个 JSON 对象 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 独立第二次调用评审单条草稿。
 *
 * fail-closed:调用失败 / 不可解析 → null(不出提案),绝不放行。
 */
export async function critique(
  llm: LlmClient,
  draft: InsightDraft,
  sub: InsightSubgraph,
  mode: DeepThoughtMode,
  language: Language = "zh",
): Promise<CriticScore | null> {
  const prompt = [
    "You are an independent critic reviewing ONE candidate insight produced by another model.",
    "Score it strictly; you did not produce it, and weak insights pollute a team memory system.",
    MODE_RUBRIC[mode],
    "",
    "## Candidate insight",
    `type: ${draft.type}`,
    `title: ${draft.title}`,
    `summary: ${draft.summary}`,
    "--- content ---",
    draft.content,
    "--- end content ---",
    `claimed sources: ${draft.sourceIds.join(", ")}`,
    draft.aar ? `AAR: expected=${draft.aar.expected}; actual=${draft.aar.actual}; cause=${draft.aar.cause}; improvement=${draft.aar.improvement}` : "",
    "",
    "## Evidence available (memory slice the insight claims to derive from)",
    serializeSubgraph(sub),
    "",
    "Score four dimensions in [0,1]:",
    "- evidenceSufficiency: are the cited sources real, present above, and sufficient for the claim?",
    "- novelty: does it reveal a structure/cause/mapping NOT stated in any single source? If the content is",
    "  largely a restatement of one source's own wording or obvious keyword overlap across sources, novelty",
    "  must be <= 0.3 (2026-08-16 blind-eval calibration: critic scored restatements 0.68-0.80 — too lax).",
    "- actionability: can a team member act on it?",
    "- consistency: is it internally consistent and consistent with the sources? For analogies (inspiration",
    "  mode): if the cross-domain mapping matches surface words instead of relational roles, consistency",
    "  must be <= 0.4.",
    "overall = your holistic judgment (do not just average; you may veto).",
    language === "zh"
      ? "Write the rationale field in Simplified Chinese (简体中文); technical terms may remain in English."
      : "Write the rationale field in English.",
    "Return ONLY a JSON object: {\"evidenceSufficiency\":n,\"novelty\":n,\"actionability\":n,\"consistency\":n,\"overall\":n,\"rationale\":\"...\"}",
  ]
    .filter((l) => l !== "")
    .join("\n");

  // 间歇性输出波动重试(2026-08-16):同 prompt 同解析,失败样本复测 5/5
  // 通过 —— GLM 偶发 thinking-only/截断属瞬态,重试 2 次而非强化解析
  let parsed: Partial<CriticScore> | null = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete(prompt, {
        temperature: 0.2,
        // 效果优先(2026-08-15 用户决策):critic 输出短但思考长,真实库上
        // 2048 仍造成大量解析失败(fail-closed 拒绝);16384 + 600s 给足
        maxTokens: 16384,
        timeoutMs: 600_000,
      });
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return null; // fail-closed
    }
    parsed = extractJson(raw) as Partial<CriticScore> | null;
    // 字符串数字容错:模型偶发输出 "overall": "0.8"
    if (parsed && typeof parsed.overall === "string") {
      const n = Number(parsed.overall);
      if (Number.isFinite(n)) parsed = { ...parsed, overall: n };
      else parsed = null;
    }
    if (!parsed && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  if (!parsed || typeof parsed.overall !== "number") return null;
  return {
    overall: clamp01(parsed.overall),
    evidenceSufficiency: clamp01(parsed.evidenceSufficiency),
    novelty: clamp01(parsed.novelty),
    actionability: clamp01(parsed.actionability),
    consistency: clamp01(parsed.consistency),
    rationale:
      typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 500) : "",
  };
}
