/**
 * 主张对手抽取与下轮任务生成(Phase3,2026-08-18)—— 同源判断的最后两块
 * 生成权转移:
 *
 * P7 主张对手抽取:答案的质量维度此前由执行者自答自评(红队发现⑧
 * 「主张自报+降级免重做」)。extractClaims 由独立 critic 从执行者提交的
 * answer 抽取主张清单,逐条判定 evidenced(答案明示有记忆/日志/探测/检索
 * 支撑)/ downgraded(无支撑断言、推测、待验证);降级占比 > 30% 判不合格
 * → 本 run 洞察提案隔离(答案弱支撑)。fail-open:LLM 不可用即跳过
 * (质量信号而非形式闸,无 llmClient 部署的洞察产出不受罚)。
 *
 * P8 接力权转移:degraded 终束的下轮任务此前是缺口描述的机械转写
 * (懒人自己布置下轮验证的自我议程残余)。generateNextTasks 由 critic 从
 * 问题 + 未闭合缺口 + 本轮答案生成结构化下轮验证任务,机械保证至少一条
 * 外部资源型(web/mcp);LLM 失败退化用缺口原文。
 *
 * @module @co-engram/core/maintenance/insight
 */

import type { LlmClient } from "../../observability/necessity-evaluator.js";

/** 单条主张(对手抽取产物) */
export interface AnswerClaim {
  readonly claim: string;
  readonly status: "evidenced" | "downgraded";
}

/** 抽取结果:claims 为空数组 = 抽取成功但零主张(极端短答案) */
export interface ClaimsExtraction {
  readonly claims: readonly AnswerClaim[];
  /** 降级主张占比 [0,1](claims 为空时 0) */
  readonly downgradeRatio: number;
  /** 不合格:降级占比 > 0.3 */
  readonly weak: boolean;
}

/** 主张条数上限(answer 长度保护;超出截断,占比按截断后计) */
const MAX_CLAIMS = 12;
/** 不合格阈值(v7 P7:降级占比 > 30%) */
export const CLAIM_WEAK_RATIO = 0.3;

/**
 * 对手抽取主张(独立第二次 LLM 调用;fail-open:异常/不可解析 → undefined
 * = 未抽取,调用方记 claimsSkipped,不做弱支撑判定)。
 */
export async function extractClaims(
  llm: LlmClient,
  answer: string,
): Promise<ClaimsExtraction | undefined> {
  try {
    const prompt = [
      "You are the ADVERSARIAL claim auditor for a deep-thinking (contemplation) answer.",
      "Extract the distinct claims the answer makes, then judge each one:",
      "- evidenced: the answer explicitly grounds it in collected evidence (a cited memory,",
      "  log, engine probe result, skill output, or web source it says it used);",
      "- downgraded: an assertion without such grounding — speculation, educated guess,",
      "  \"likely/probably\" hedging, or a statement deferred to future verification.",
      "Judge adversarially: vague gestures at evidence do NOT count as evidenced.",
      "",
      "## Answer to audit",
      answer.slice(0, 8000),
      "",
      "Reply with ONLY a JSON object:",
      '{"claims":[{"claim":"<one-sentence claim>","status":"evidenced|downgraded"}]}',
      "(3-12 claims; merge duplicates; skip pure restatements of the question)",
    ].join("\n");
    const raw = await llm.complete(prompt, {
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 120_000,
    });
    const parsed = JSON.parse(extractJson(raw)) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return undefined;
    const claims: AnswerClaim[] = [];
    for (const c of parsed.claims) {
      const claim = String((c as { claim?: unknown })?.claim ?? "").trim().slice(0, 400);
      if (!claim) continue;
      const status = (c as { status?: unknown })?.status === "downgraded" ? "downgraded" : "evidenced";
      claims.push({ claim, status });
      if (claims.length >= MAX_CLAIMS) break;
    }
    if (claims.length === 0) return undefined;
    const downgraded = claims.filter((c) => c.status === "downgraded").length;
    const downgradeRatio = downgraded / claims.length;
    return {
      claims,
      downgradeRatio,
      weak: downgradeRatio > CLAIM_WEAK_RATIO,
    };
  } catch {
    return undefined; // fail-open
  }
}

/** 外部资源型任务关键词(P8 机械保证:至少一条含外部证据源;plan.ts 复用分流) */
export const EXTERNAL_TASK_PATTERN = /web|联网|检索|search|外部|业界|benchmark|mcp|代码|codegraph|源码/i;

/**
 * 生成下轮验证任务(P8;fail-退化:LLM 失败 → 缺口原文作任务清单,
 * 与 Phase2 的机械 carryOver 行为一致)。
 */
export async function generateNextTasks(
  llm: LlmClient,
  input: {
    readonly question: string;
    readonly unclosedGaps: readonly string[];
    readonly answer: string;
  },
): Promise<readonly string[]> {
  const fallback = input.unclosedGaps.map((g) => `验证未闭合需求:${g}`);
  try {
    const prompt = [
      "You are the HANDOFF planner for a degraded deep-thinking run: it finalized with",
      "open gaps. Draft the NEXT run's verification tasks — what the next session should",
      "check, mine, or fetch to close them. The executor of the next run does NOT get to",
      "choose these; you do.",
      "Rules:",
      "- 2-5 tasks, each one sentence, each actionable (name the resource and the check).",
      "- At least ONE task must use an external evidence source (web research or an MCP",
      "  tool) — do not confine the next run to the memory graph.",
      "- Ground tasks in the gaps and the partial answer below; do not invent new scope.",
      "",
      "## Question",
      input.question,
      "",
      "## Unclosed gaps",
      input.unclosedGaps.map((g) => `- ${g}`).join("\n") || "(none listed)",
      "",
      "## This run's partial answer",
      input.answer.slice(0, 4000) || "(none)",
      "",
      'Reply with ONLY a JSON object: {"tasks":["<task>", ...]}',
    ].join("\n");
    const raw = await llm.complete(prompt, {
      temperature: 0.3,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });
    const parsed = JSON.parse(extractJson(raw)) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) return fallback;
    const tasks = parsed.tasks
      .map((t) => String(t).trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 5);
    if (tasks.length === 0) return fallback;
    // P8 机械保证:无外部型任务 → 追加一条(生成权兜底,不依赖 LLM 自觉)
    if (!tasks.some((t) => EXTERNAL_TASK_PATTERN.test(t))) {
      tasks.push("外部检索验证:对关键主张做一次联网/MCP 工具取证,补齐本地证据缺口");
    }
    return tasks;
  } catch {
    return fallback;
  }
}

/** 从 LLM 输出剥 ```json 围栏 / 前后散文(与 plan.ts 同款) */
function extractJson(raw: string): string {
  const text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
