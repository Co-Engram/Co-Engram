/**
 * OpenClaw 兼容的 memory_search / memory_get 工具
 *
 * 这两个工具是 co-engram 对 OpenClaw memory 标准协议的适配层：
 *   - 触发 OpenClaw 核心的 memory section 系统提示注入
 *   - 提供与 memory-core / flexmem-local 兼容的 schema
 *   - 内部仍走 co-engram 的 FTS + 图检索 + RPE 强化闭环
 *
 * 与 co-engram 原生 25 个工具的关系：
 *   - memory_search 是 engram_search 的"对外友好版"（隐藏内部术语）
 *   - memory_get 是 engram_get 的"对外友好版"（简化 schema）
 *   - 25 个原生工具仍全部注册，提供 synapse/RPE/metacognition 等高级功能
 *
 * @module @co-engram/openclaw
 */

import {
  DEFAULT_LANGUAGE,
  localizeToolDescription,
  type ToolContext,
  type Language,
  type EngramDigest,
} from "@co-engram/core";
import type {
  OpenClawToolDescriptor,
  ToolExecuteResult,
  JsonSchemaObject,
} from "./types.js";
import { toToolResult as toAdaptedToolResult } from "./adapter.js";

/**
 * memory_search 返回的单条结果（简化 schema，对 LLM 友好）
 *
 * 注:title 字段非 OpenClaw memory slot 协议核心字段,仅用于 adapter markdown 渲染
 * 时显示可读标题(避免渲染为"(无标题)")。OpenClaw 核心协议不会因多出这个字段
 * 报错(JSON schema 是 input 端,output 端是 ToolExecuteResult 不受 schema 约束)。
 */
export interface MemorySearchHit {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly score: number;
  readonly metadata: {
    readonly createdAt: string;
    readonly importance: number;
    readonly truthScore?: number;
    readonly tags: readonly string[];
    readonly kind: string;
  };
}

/**
 * memory_get 返回的富结构（单条 engram 详情）
 */
export interface MemoryGetResult {
  readonly id: string;
  readonly content: string;
  readonly metadata: {
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly createdBy: string;
    readonly importance: number;
    readonly truthScore?: number;
    readonly reinforcementCount: number;
    readonly lastReinforcedAt: string | null;
    readonly tags: readonly string[];
    readonly kind: string;
    readonly verificationStatus?: string;
  };
  readonly relatedIds: readonly string[];
}

/**
 * memory_search 的 JSON Schema
 */
const MEMORY_SEARCH_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Natural language search query.",
      minLength: 1,
    },
    maxResults: {
      type: "number",
      description: "Maximum number of results to return (default: 5, max: 20).",
      minimum: 1,
      maximum: 20,
    },
    minScore: {
      type: "number",
      description:
        "Minimum relevance score (0-1). Results below this are filtered out.",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["query"],
};

/**
 * memory_get 的 JSON Schema
 */
const MEMORY_GET_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Engram ID returned by memory_search.",
      minLength: 1,
    },
  },
  required: ["id"],
};

const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 20;
const DEFAULT_MIN_SCORE = 0;
const CONTENT_SUMMARY_LIMIT = 500;

function toErrorResult(error: unknown, language: Language): ToolExecuteResult {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = language === "zh" ? "错误" : "Error";
  return {
    content: [{ type: "text", text: `${prefix}: ${message}` }],
    details: { ok: false, error: message },
  };
}

function clampMaxResults(value: unknown): number {
  const n = typeof value === "number" ? value : DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(n, HARD_MAX_RESULTS));
}

function clampMinScore(value: unknown): number {
  const n = typeof value === "number" ? value : DEFAULT_MIN_SCORE;
  return Math.max(0, Math.min(n, 1));
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "...";
}

/**
 * 把 EngramDigest 转为 MemorySearchHit
 *
 * 隐藏 co-engram 内部术语（emotionalValence / freshness / sourceType 等），
 * 只暴露对 LLM 决策有用的字段。
 */
function digestToHit(digest: EngramDigest, score: number): MemorySearchHit {
  return {
    id: digest.id,
    title: digest.title,
    content: truncate(digest.summary || digest.title, CONTENT_SUMMARY_LIMIT),
    score,
    metadata: {
      createdAt: digest.updatedAt,
      importance: digest.importance,
      tags: digest.domainTags,
      kind: digest.kind,
    },
  };
}

/**
 * 创建 memory_search 工具（OpenClaw 兼容）
 *
 * 内部调用 ctx.searchOrchestrator + ctx.repository.readDigest，
 * 包装为 OpenClaw 期望的 ToolDescriptor。
 *
 * @param ctx co-engram ToolContext（含 repository + searchOrchestrator）
 * @param language 错误消息语言
 */
export function createMemorySearchTool(
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): OpenClawToolDescriptor {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: localizeToolDescription(
      "memory_search",
      language,
      "Search team memory (engrams) using natural language. Returns relevant memory snippets with relevance scores. Call this when the user asks about past decisions, preferences, people, dates, or project context.",
    ),
    parameters: MEMORY_SEARCH_SCHEMA,
    async execute(_toolCallId, params) {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const query = typeof p.query === "string" ? p.query : "";
        if (!query.trim()) {
          throw new Error("query is required and must be non-empty");
        }
        if (!ctx.searchOrchestrator) {
          throw new Error("SearchOrchestrator not available");
        }
        const maxResults = clampMaxResults(p.maxResults);
        const minScore = clampMinScore(p.minScore);

        const rawResults = ctx.searchOrchestrator.search(
          query,
          undefined,
          maxResults,
        );
        const hits: MemorySearchHit[] = [];
        for (const r of rawResults) {
          if (r.score < minScore) continue;
          const digest = ctx.repository.readDigest(r.id);
          if (!digest) continue;
          hits.push(digestToHit(digest, r.score));
        }
        return toAdaptedToolResult({ results: hits, total: hits.length }, ctx);
      } catch (error) {
        return toErrorResult(error, language);
      }
    },
  };
}

/**
 * 创建 memory_get 工具（OpenClaw 兼容）
 *
 * 返回单条 engram 的富结构（含完整 content + 元数据 + 相关 id 列表）。
 * synapse 图不展开（relatedIds 仅返回 id），需要详情走 synapse_list。
 *
 * @param ctx co-engram ToolContext
 * @param language 错误消息语言
 */
export function createMemoryGetTool(
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): OpenClawToolDescriptor {
  return {
    name: "memory_get",
    label: "Memory Get",
    description: localizeToolDescription(
      "memory_get",
      language,
      "Read full content of a single memory (engram) by ID. Returns content, metadata (importance, truthScore, reinforcementCount), and related memory IDs. Use after memory_search to dive into specifics.",
    ),
    parameters: MEMORY_GET_SCHEMA,
    async execute(_toolCallId, params) {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const id = typeof p.id === "string" ? p.id : "";
        if (!id.trim()) {
          throw new Error("id is required");
        }
        const engram = ctx.repository.readEngram(id);
        const outgoingFile = safeReadSynapses(ctx, id);
        const relatedIds = extractRelatedIds(id, outgoingFile);
        return toAdaptedToolResult(
          {
            id: engram.id,
            content: engram.content,
            metadata: {
              createdAt: engram.createdAt,
              updatedAt: engram.updatedAt,
              createdBy: engram.createdBy,
              importance: engram.importance,
              tags: engram.domainTags,
              kind: engram.kind,
              reinforcementCount:
                engram.effectiveRetrievals + engram.failedUses,
              lastReinforcedAt: engram.lastEffectiveAt ?? null,
              ...(engram.confidence !== undefined
                ? { truthScore: engram.confidence }
                : {}),
              ...(engram.verificationStatus
                ? { verificationStatus: engram.verificationStatus }
                : {}),
            },
            relatedIds,
          } satisfies MemoryGetResult,
          ctx,
        );
      } catch (error) {
        return toErrorResult(error, language);
      }
    },
  };
}

/**
 * 安全读取 synapses（engram 可能没有 synapses 文件）
 */
function safeReadSynapses(
  ctx: ToolContext,
  id: string,
): { readonly outgoing: ReadonlyArray<{ readonly to: string }> } | null {
  try {
    const file = ctx.repository.readSynapses(id);
    return file ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 synapse outgoing 抽取邻居 id（不展开详情，不扫 incoming 以避免全表扫描）
 */
function extractRelatedIds(
  selfId: string,
  bundle: { readonly outgoing: ReadonlyArray<{ readonly to: string }> } | null,
): readonly string[] {
  if (!bundle) return [];
  const ids = new Set<string>();
  for (const s of bundle.outgoing) {
    if (s.to && s.to !== selfId) ids.add(s.to);
  }
  return Array.from(ids);
}

/**
 * 批量创建两个 memory 工具
 */
export function createMemoryTools(
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): readonly OpenClawToolDescriptor[] {
  return [
    createMemorySearchTool(ctx, language),
    createMemoryGetTool(ctx, language),
  ];
}
