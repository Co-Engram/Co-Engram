/**
 * engram_synthesize 工具(Feature 1:手工触发 REM)
 *
 * 接受一组 engram id,调 LLM 综合形成 pattern engram,并对每个源 engram 创建
 * `derives_from` synapse(pattern → source)。
 *
 * 与 REM dreaming 的关系:
 *   - REM 是自动聚类 + 启发式抽象,后台定时跑
 *   - 本工具是用户/agent 显式触发,语义层 LLM 抽象,精确度高
 *   - Feature 2 会把 REM dreaming 的 abstractionProvider 替换为同等 LLM 路径
 *
 * 与 proposal-engine 的区别:
 *   - proposal-engine 监听对话流自动累积 cluster → promotion
 *   - 本工具不依赖 proposal-engine,直接由调用方提供源 engram id 列表
 *
 * @module @co-engram/core/tools
 */

import { randomUUID } from "node:crypto";
import type { EngramRepository } from "../storage/repository.js";
import type { Engram } from "../types/engram.js";
import type { Synapse } from "../types/synapse.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import type { Tool, ToolContext } from "./tool.js";
import {
  validateInput,
  llmUnavailableError,
  notFoundError,
  validationError,
  internalError,
} from "./tool.js";
import {
  EngramSynthesizeInputSchema,
  type EngramSynthesizeToolInput,
} from "./schemas.js";

// ============================================================
// 类型
// ============================================================

/** LLM 综合产物(供 dry-run 返回 / 实际创建共用) */
export interface SynthesisDraft {
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly domainTags: readonly string[];
  /** LLM 自评置信度 [0,1] */
  readonly confidence: number;
  /** LLM 给出的综合理由(展示给用户) */
  readonly reason: string;
}

/** engram_synthesize 返回值 */
export interface EngramSynthesizeResult {
  /** dry-run 时为 undefined */
  readonly patternEngramId?: string;
  /** dry-run 时为空数组 */
  readonly synapseIds: readonly string[];
  /** 综合的源 engram id(去重后) */
  readonly sourceIds: readonly string[];
  /** LLM 草拟的 title/content/summary(永远返回,供调用方审计/调试) */
  readonly draft: SynthesisDraft;
  /** dry-run 标志 */
  readonly dryRun: boolean;
}

// ============================================================
// Prompt 模板(共享:engram_synthesize 工具 + REM LlmPatternAbstraction)
// ============================================================

export const SYNTHESIS_PROMPT = `You are synthesizing a team memory pattern from a set of related engrams.

A "pattern" is a higher-order insight that connects or abstracts multiple specific memories into a reusable lesson, principle, or design rationale. It should be more than a summary — it should reveal what these memories have in common at a level that will help future conversations.

Below are ${"<SAMPLE_COUNT>"} source engrams:

${"<SAMPLES_BLOCK>"}

${"<HINTS_BLOCK>"}

Synthesize them into ONE pattern. Return STRICT JSON only (no markdown, no prose) with this shape:

{
  "title": "<4-10 word pattern title, must NOT just copy any source title>",
  "summary": "<1-2 sentence plain-language summary of the pattern>",
  "content": "<full pattern body in markdown, 100-500 words; explain the insight, evidence from sources, and how to apply it>",
  "domainTags": ["<3-6 lowercase tags>"],
  "confidence": <number 0..1 — how confident this is a real pattern vs cherry-picked coincidence>,
  "reason": "<one sentence on why these sources support this pattern>"
}

 STRICT rules:
  1. The pattern must be NON-TRIVIAL — if the sources are too unrelated, set confidence < 0.4 and explain why in reason.
  2. Title must be different from every source title; reuse is a failure mode.
  3. Content must reference specific details from sources (not generic platitudes).
  4. domainTags should be the shared vocabulary across sources, not a union of all tags.
  5. If any source is clearly off-topic from the others, exclude it mentally but list it in reason.`;

// ============================================================
// 辅助:解析 LLM 输出
// ============================================================

/**
 * 解析 LLM 综合输出
 *
 * 容忍 markdown fence / 前后 prose / 嵌套 JSON 等不规范输出。
 * 返回 null 表示无法解析,调用方 fallback / 抛错。
 */
export function parseSynthesisOutput(raw: string): SynthesisDraft | null {
  let text = raw.trim();

  // 剥 markdown fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // 抽取最外层 { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = text.slice(start, end + 1);

  let obj: {
    title?: unknown;
    content?: unknown;
    summary?: unknown;
    domainTags?: unknown;
    confidence?: unknown;
    reason?: unknown;
  };
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const title =
    typeof obj.title === "string" && obj.title.trim().length > 0
      ? obj.title.trim().slice(0, 200)
      : null;
  const content =
    typeof obj.content === "string" && obj.content.trim().length > 0
      ? obj.content.trim()
      : null;
  if (!title || !content) return null;

  const summary =
    typeof obj.summary === "string" && obj.summary.trim().length > 0
      ? obj.summary.trim().slice(0, 300)
      : content.slice(0, 200);

  const domainTags = Array.isArray(obj.domainTags)
    ? obj.domainTags
        .filter(
          (t): t is string => typeof t === "string" && t.trim().length > 0,
        )
        .map((t) => t.trim().toLowerCase().slice(0, 50))
        .slice(0, 5)
    : [];

  const confidence =
    typeof obj.confidence === "number" &&
    Number.isFinite(obj.confidence) &&
    obj.confidence >= 0 &&
    obj.confidence <= 1
      ? obj.confidence
      : 0.5;

  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim().slice(0, 500)
      : "LLM synthesis";

  return { title, content, summary, domainTags, confidence, reason };
}

// ============================================================
// 辅助:读取并校验源 engram
// ============================================================

interface SourceEngram {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly domainTags: readonly string[];
}

function loadAndValidateSources(
  repo: EngramRepository,
  ids: readonly string[],
): {
  readonly sources: readonly SourceEngram[];
  readonly missing: readonly string[];
} {
  const seen = new Set<string>();
  const sources: SourceEngram[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue; // 自动去重
    seen.add(id);

    if (!repo.exists(id)) {
      missing.push(id);
      continue;
    }

    const e = repo.readEngram(id) as Engram;
    sources.push({
      id: e.id,
      title: e.title,
      content: e.content,
      summary: e.summary,
      domainTags: [...e.domainTags],
    });
  }

  return { sources, missing };
}

/** 构造给 LLM 的样本块(共享:engram_synthesize 工具 + REM LlmPatternAbstraction) */
export function buildSamplesBlock(sources: readonly SourceEngram[]): string {
  return sources
    .map((s, i) => {
      const tags =
        s.domainTags.length > 0 ? s.domainTags.join(", ") : "(none)";
      const body =
        s.content.length > 1500
          ? `${s.content.slice(0, 1500)}...(truncated)`
          : s.content;
      return `--- Source [${i + 1}] id=${s.id} ---
title: ${s.title}
tags: ${tags}
summary: ${s.summary}
content:
${body}`;
    })
    .join("\n\n");
}

/**
 * AI-4: dryRun=true 时的 heuristic 路径,不调 LLM。
 *
 * 构造机械拼接 draft:从源 engram 的 title/summary/content/domainTags
 * 简单组装,让调用方看到源数据但不做语义综合。confidence=0 + reason
 * 字段标记为 heuristic 路径(无 LLM 信心)。
 *
 * 与 LLM 路径的区别:
 *   - LLM 路径:draft.content 是 LLM 新写的 pattern insight
 *   - heuristic 路径:draft.content 是源 content 的截断展示(机械拼接)
 *
 * 用户看到 confidence=0 + reason 标记,知道这是 dryRun 草稿,不是 LLM 综合,
 * 不会误当真实 pattern 使用。
 */
function buildHeuristicDraft(
  sources: readonly SourceEngram[],
  parsed: EngramSynthesizeToolInput,
): SynthesisDraft {
  const titles = sources.map((s) => s.title);
  const userTags =
    parsed.domainTags && parsed.domainTags.length > 0
      ? parsed.domainTags
      : Array.from(new Set(sources.flatMap((s) => s.domainTags))).slice(0, 5);

  return {
    title: `综合草稿(${sources.length} 条源,heuristic)`,
    summary: `dryRun=true,未调 LLM。源标题:${titles.join(" / ")}`,
    content: sources
      .map((s, i) =>
        `## 源 ${i + 1}: ${s.title}\n\n**Summary:** ${s.summary}\n\n${s.content.slice(0, 500)}`,
      )
      .join("\n\n---\n\n"),
    domainTags: userTags,
    confidence: 0.0,
    reason:
      "dryRun=true,heuristic 路径,未调外部 LLM(plan AI-4 硬约束)",
  };
}

// ============================================================
// 工具实现
// ============================================================

/**
 * engram_synthesize 工具
 *
 * 输入:ids + 可选 createdBy/domainTags/synthesisHints/dryRun
 * 输出:patternEngramId + synapseIds + sourceIds + draft
 *
 * 副作用:创建 pattern engram(kind=pattern, sourceType=inferred) +
 * 对每个源创建 derives_from synapse + append audit。
 *
 * 失败模式:
 *   - ctx.llmClient 缺失 → 抛错带安装指引
 *   - 源 engram 部分不存在 → 抛错列出缺失的 id(不部分执行)
 *   - LLM 返回非 JSON → 抛错(不创建 engram,避免垃圾数据)
 *   - LLM 调用抛错 → 透传(由调用方决定重试 / fallback)
 */
export const engramSynthesizeTool: Tool<
  EngramSynthesizeToolInput,
  EngramSynthesizeResult
> = {
  name: "engram_synthesize",
  description:
    '综合多条已有 engram 形成一条 pattern(模式)记忆。需要 ToolContext.llmClient(claude-code-mcp 默认从 ANTHROPIC_API_KEY 解析;openclaw-plugin 从 necessityLlm 配置或 ~/.openclaw/openclaw.json 解析)。流程:读源 → LLM 综合 → 创建 kind="pattern" engram → 对每个源连 derives_from synapse。dryRun=true 只返回草稿不创建。源 id 重复自动去重,源不存在抛错(不部分执行)。',
  inputSchema: EngramSynthesizeInputSchema,
  async execute(input, ctx) {
    const parsed = validateInput<EngramSynthesizeToolInput>(
      EngramSynthesizeInputSchema,
      input,
    );

    // 1. 加载并校验源(无 LLM 依赖,先做)
    const { sources, missing } = loadAndValidateSources(ctx.repository, parsed.ids);
    if (missing.length > 0) {
      throw notFoundError(
        "Source engrams",
        missing.join(", "),
        `Synthesis aborted (no partial execution). Verify the IDs via engram_search before retrying.`,
      );
    }
    if (sources.length < 2) {
      throw validationError(
        `At least 2 unique source engrams required for synthesis (got ${sources.length}).`,
        {
          suggestion:
            "Pass 2 or more distinct engram IDs in the `ids` array.",
          resourceId: "ids",
        },
      );
    }

    // AI-4 修复:dryRun=true 时绝不调 LLM(plan 硬约束)。
    //
    // 旧实现(line 347):dryRun 检查在 LLM 调用(line 319)之后,导致
    // dryRun=true 仍然消耗一次 LLM 调用(最贵 + 有副作用的步骤),违反
    // plan AI-4「dryRun=true 时绝不调外部 LLM」硬约束。这是与 AI-9
    // SQLite score 漏归一化同类的假完成 —— plan 声明完成,场景验证发现
    // 核心约束没满足。
    //
    // 新实现:dryRun=true 走 heuristic 路径,构造机械拼接 draft(源
    // title/summary/content/domainTags 简单组装),不调 LLM。confidence=0
    // + reason 字段标记为 heuristic 路径,让调用方知道这不是 LLM 综合。
    if (parsed.dryRun === true) {
      const heuristicDraft = buildHeuristicDraft(sources, parsed);
      return {
        synapseIds: [],
        sourceIds: sources.map((s) => s.id),
        draft: heuristicDraft,
        dryRun: true,
      };
    }

    // dryRun=false 时,LLM client 必须存在
    const llmClient = ctx.llmClient as LlmClient | undefined;
    if (!llmClient) {
      throw llmUnavailableError(
        "engram_synthesize",
        "Configure necessityLlm in plugin config (MCP: persistedConfig.necessityLlm or ANTHROPIC_API_KEY env; OpenClaw: config.necessityLlm or ~/.openclaw/openclaw.json).",
      );
    }

    // 2. 调 LLM 综合
    const samplesBlock = buildSamplesBlock(sources);
    const hintsBlock = parsed.synthesisHints
      ? `Additional guidance from caller:\n${parsed.synthesisHints}`
      : "";
    const prompt = SYNTHESIS_PROMPT.replace(
      "<SAMPLE_COUNT>",
      String(sources.length),
    )
      .replace("<SAMPLES_BLOCK>", samplesBlock)
      .replace("<HINTS_BLOCK>", hintsBlock);

    let raw: unknown;
    try {
      // maxTokens 4000 留足 content body 长度 + reasoning 模型预算
      raw = await llmClient.complete(prompt, {
        maxTokens: 4000,
        temperature: 0.3,
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw internalError(
        `LLM synthesis call failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }

    if (typeof raw !== "string" || raw.length === 0) {
      throw internalError(
        `LLM returned non-string output (type=${typeof raw}); synthesis aborted.`,
      );
    }

    const draft = parseSynthesisOutput(raw);
    if (!draft) {
      throw internalError(
        `Failed to parse LLM synthesis output as JSON. First 200 chars: ${raw.slice(0, 200)}...`,
      );
    }

    // 3. 创建 pattern engram(dryRun=true 已在 execute 入口提前返回)
    // createdBy 完全由系统决定(2026-07 修复,与 engram_create 对齐):
    // 忽略 parsed.createdBy,走 ctx.defaultCreatedBy(host adapter 从 git config 解析)。
    void parsed.createdBy;
    const createdBy =
      ctx.resolveCreatedBy?.() ?? ctx.defaultCreatedBy ?? "unknown";
    // 用户显式 domainTags 优先;否则用 LLM 推断的;再 fallback 到源 tags 的并集
    const domainTags =
      parsed.domainTags && parsed.domainTags.length > 0
        ? parsed.domainTags
        : draft.domainTags.length > 0
          ? draft.domainTags
          : Array.from(new Set(sources.flatMap((s) => s.domainTags))).slice(
              0,
              5,
            );

    const patternEngram = ctx.repository.createEngram({
      title: draft.title,
      content: draft.content,
      summary: draft.summary,
      kind: "pattern",
      domainTags,
      importance: 0.7,
      confidence: draft.confidence,
      sourceType: "inferred",
      createdBy,
    });

    // 5. 创建 derives_from synapse(pattern → source)
    const synapseIds: string[] = [];
    const timestamp = patternEngram.createdAt;
    for (const source of sources) {
      const synapse: Synapse = {
        id: randomUUID(),
        from: patternEngram.id,
        to: source.id,
        kind: "derives_from",
        weight: 0.8,
        evidence: [
          {
            description: `Pattern synthesized from ${sources.length} sources via engram_synthesize`,
            source: "llm-synthesis",
            confidence: draft.confidence,
            addedAt: timestamp,
            addedBy: createdBy,
          },
        ],
        createdBy,
        createdAt: timestamp,
        updatedAt: timestamp,
        visibility: "public",
      };
      const stored = ctx.repository.addOutgoingSynapse(
        patternEngram.id,
        synapse,
      );
      synapseIds.push(stored.id);
    }

    // 6. audit + markDirty
    ctx.auditLog?.append({
      actor: "user",
      action: "create",
      engramId: patternEngram.id,
      metadata: {
        target: "pattern-via-synthesis",
        sourceIds: sources.map((s) => s.id),
        synapseIds,
        title: draft.title,
        confidence: draft.confidence,
        createdBy,
      },
    });
    ctx.markDirty?.();

    return {
      patternEngramId: patternEngram.id,
      synapseIds,
      sourceIds: sources.map((s) => s.id),
      draft,
      dryRun: false,
    };
  },
};

export const ALL_SYNTHESIZE_TOOLS: readonly Tool[] = [engramSynthesizeTool];
