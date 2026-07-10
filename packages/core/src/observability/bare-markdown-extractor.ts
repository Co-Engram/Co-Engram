/**
 * 裸 markdown → engram 字段提取(Task:cp/mv 裸 .md 自动转化)
 *
 * 触发场景:用户通过 cp/mv 把无 frontmatter 的 .md 粘贴到记忆目录。
 * watcher 检测到 parsed=null(裸 markdown),用本模块提取字段生成 proposal。
 *
 * 两层实现:
 *   - `extractEngramFieldsWithLlm`:LLM 提取(精准,需 LlmClient)
 *   - `extractBareMarkdownDefaults`:规则版降级(零依赖,LLM 失败时用)
 *
 * 安全边界:本模块只填字段,**不**直接创建 engram。生成 payload 后走
 * `proposeExternalMarkdown` 进入 proposal 审批流程,用户 accept 才落库。
 *
 * @module @co-engram/core/observability
 */

import { basename } from "node:path";

import type { EngramCreateInput } from "../types/engram.js";
import type { LlmClient } from "./necessity-evaluator.js";

/** LLM 输入字符上限(控制 token 成本,大文档截断) */
const LLM_INPUT_CHAR_BUDGET = 2000;

/** LLM 调用超时(裸 .md 提取不应让用户等太久才看到 proposal) */
const LLM_TIMEOUT_MS = 10_000;

/** LLM 输出 token 上限(只需 4 个字段,500 够用) */
const LLM_MAX_TOKENS = 500;

/** LLM 提取温度(元数据提取要稳定不要发散) */
const LLM_TEMPERATURE = 0.3;

/** 规则版 + LLM 版共用的输出结构 */
export interface ExtractedEngramFields {
  readonly title: string;
  readonly content: string;
  readonly kind: EngramCreateInput["kind"];
  readonly domainTags: readonly string[];
  readonly summary?: string;
}

/** LLM 响应解析结果(不含 content,content 由调用方用原始 raw 填) */
interface LlmExtractedMetadata {
  readonly title: string;
  readonly kind: EngramCreateInput["kind"];
  readonly domainTags: readonly string[];
  readonly summary?: string;
}

/**
 * 规则版:从裸 markdown 提取默认字段(零依赖,降级路径)
 *
 * 策略:
 *   - title:第一行 H1(`# 标题`),否则文件名(去 .md 扩展名)
 *   - content:raw 全文(包含 H1,与 engram_create 的 content 语义一致)
 *   - kind:"observation"(单次观察,默认最保守)
 *   - domainTags:["imported"](统一标签,用户审批时可编辑)
 *
 * 不抛错:无论 raw 多奇怪都返回合法字段,作为 LLM 失败的兜底。
 */
export function extractBareMarkdownDefaults(
  sourcePath: string,
  raw: string,
): ExtractedEngramFields {
  const fileName = basename(sourcePath, ".md");
  const h1Match = raw.match(/^#\s+(.+)$/m);
  const title = h1Match?.[1]?.trim() || fileName || "imported-note";

  return {
    title: title.slice(0, 200),
    content: raw,
    kind: "observation",
    domainTags: ["imported"],
  };
}

/**
 * LLM 版:从裸 markdown 智能提取 engram 字段
 *
 * Prompt 嵌入 engram_create 的 schema 语义(kind 5 种含义、domainTags 用法),
 * 让 LLM 输出符合 co-engram 数据模型的字段。
 *
 * content 字段始终用原始 raw(LLM 不重新生成内容,只提取元数据)。
 *
 * 失败抛错(由调用方决定降级到规则版):
 *   - llmClient.complete 自身可能抛(网络错 / 超时 / API key 错)
 *   - JSON 解析失败抛
 *   - 字段校验失败抛
 */
export async function extractEngramFieldsWithLlm(
  raw: string,
  llmClient: LlmClient,
): Promise<ExtractedEngramFields> {
  const truncated = raw.slice(0, LLM_INPUT_CHAR_BUDGET);
  const prompt = buildExtractionPrompt(truncated);

  const response = await llmClient.complete(prompt, {
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
    timeoutMs: LLM_TIMEOUT_MS,
  });

  if (typeof response !== "string" || response.length === 0) {
    throw new Error("LLM returned non-string output");
  }

  const parsed = parseExtractionResponse(response);
  return {
    ...parsed,
    content: raw,
  };
}

/**
 * 构造 LLM 提取 prompt
 *
 * 嵌入 engram_create 的 schema 语义(kind 含义、domainTags 用法),
 * 让 LLM 输出符合 co-engram 数据模型的字段。
 */
function buildExtractionPrompt(content: string): string {
  return `You are extracting engram metadata from a markdown note that was pasted into a team memory directory.

An engram is a team memory entry with these fields:
- title: concise title (20-80 chars)
- kind: one of these 5 categories:
    - "observation": a single observation
    - "fact": a fact verified multiple times
    - "pattern": a pattern abstracted across situations
    - "procedure": a process / how-to statement
    - "hypothesis": a hypothesis awaiting verification
- domainTags: 1-3 lowercase domain tags describing the area (e.g. "frontend", "testing", "architecture", "tooling")
- summary: 30-100 char abstract

Read the markdown content and output ONLY a JSON object (no prose, no markdown fences):
{"title": "...", "kind": "observation|fact|pattern|procedure|hypothesis", "domainTags": ["...", "..."], "summary": "..."}

If the content is too short or ambiguous, default to:
- kind: "observation"
- domainTags: ["imported"]

Markdown content:
${content}`;
}

/**
 * 解析 LLM 响应为元数据(不含 content)
 *
 * 复用 engram_synthesize 的 parseSynthesisOutput 模式:
 *   1. trim
 *   2. 剥 markdown fence
 *   3. 抽取最外层 { ... }
 *   4. JSON.parse
 *   5. 字段类型校验 + 截断 + 默认值兜底
 *
 * 失败抛错(由调用方降级到规则版)。content 不在 LLM 输出里(LLM 只提取
 * 元数据,内容用原始 raw),由 extractEngramFieldsWithLlm 合并。
 */
function parseExtractionResponse(raw: string): LlmExtractedMetadata {
  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response has no JSON object");
  }
  const jsonStr = text.slice(start, end + 1);

  let obj: {
    title?: unknown;
    kind?: unknown;
    domainTags?: unknown;
    summary?: unknown;
  };
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `LLM response JSON parse failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const title =
    typeof obj.title === "string" && obj.title.trim().length > 0
      ? obj.title.trim().slice(0, 200)
      : null;
  if (!title) {
    throw new Error("LLM response missing valid title");
  }

  const validKinds = new Set([
    "observation",
    "fact",
    "pattern",
    "procedure",
    "hypothesis",
  ]);
  const kind =
    typeof obj.kind === "string" && validKinds.has(obj.kind)
      ? (obj.kind as EngramCreateInput["kind"])
      : "observation";

  const domainTags = Array.isArray(obj.domainTags)
    ? obj.domainTags
        .filter(
          (t): t is string => typeof t === "string" && t.trim().length > 0,
        )
        .map((t) => t.trim().toLowerCase().slice(0, 50))
        .slice(0, 5)
    : [];
  if (domainTags.length === 0) {
    // LLM 没给出有效 tag → 兜底 "imported",用户审批时可编辑
    domainTags.push("imported");
  }

  const summary =
    typeof obj.summary === "string" && obj.summary.trim().length > 0
      ? obj.summary.trim().slice(0, 300)
      : undefined;

  return {
    title,
    kind,
    domainTags,
    ...(summary !== undefined ? { summary } : {}),
  };
}
