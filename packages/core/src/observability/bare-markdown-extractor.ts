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
// 效果优先(2026-08-15 用户决策):思考型模型(GLM)thinking 块远超 500
// token / 10s,曾导致真实库 tag-refresh 76/81 全失败
const LLM_TIMEOUT_MS = 600_000;

/** LLM 输出 token 上限(只需 4 个字段,500 够用) */
const LLM_MAX_TOKENS = 16384; // 提取输出短,但思考长(与 critic 同理)

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
 * 剥离 markdown 中的 fenced code block(``` 或 ~~~),返回仅含散文行的文本。
 *
 * 用途:标题提取前先剔除代码块,避免把代码块内的 `#` 注释行误当 H1
 * (典型场景:从 wiki 粘贴的 shell 步骤 `# 1. 切换到源分支` 被当成文档标题)。
 * CommonMark 围栏识别:行首 ≤3 空格缩进 + ≥3 个 ` 或 ~;关闭围栏需相同字符
 * 且长度 ≥ 开启长度。缩进 >3 空格的 ``` 属缩进代码块(非 fence),按普通文本保留。
 *
 * 仅服务于「找真 H1」的标题提取目标,不影响 content(全文始终用 raw)。
 */
function stripFencedCodeBlocks(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    if (fenceChar) {
      // fence 内:检查本行是否为关闭围栏(相同字符,长度 ≥ 开启长度)
      const closeMatch = line.match(/^\s{0,3}([`~])\1*/);
      if (closeMatch && closeMatch[1]![0] === fenceChar) {
        const len = closeMatch[0].replace(/^\s{0,3}/, "").length;
        if (len >= fenceLen) {
          fenceChar = null;
          fenceLen = 0;
        }
      }
      continue; // fence 内所有行(含关闭行)都剔除
    }
    const openMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (openMatch) {
      fenceChar = openMatch[1]![0] as "`" | "~";
      fenceLen = openMatch[1]!.length;
      continue; // 开启行也剔除
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 规则版:从裸 markdown 提取默认字段(零依赖,降级路径)
 *
 * 标题策略(优先级):
 *   1. 剥离 fenced code block 后,若**恰好 1 个** H1(`# 标题`)→ 用它;
 *   2. 否则(0 个 H1,或 >1 个 H1)→ 用文件名(去 .md)。
 *
 * 为何「>1 个 H1 → 文件名」:正常文档只有 1 个主题级 H1;出现多个 H1 通常是
 * 代码块围栏丢失(从 wiki 粘贴)导致 shell 注释 `# 1. xxx` 被误解析为 H1,或
 * 文档用 H1 切分多 section——两种都说明 H1 不可靠,文件名(用户刻意命名)更
 * 能代表主题。剥离 code block 处理「有围栏」的伪 H1;多 H1 检测处理「围栏已
 * 丢失、剥离无效」的伪 H1(靠数量启发式)。两者互补,完整覆盖伪 H1 场景。
 *
 *   - content:raw 全文(包含 H1,与 engram_create 的 content 语义一致)
 *   - kind:"observation"(单次观察,默认最保守)
 *   - domainTags:["uncategorized"](待 REM 刷新成真实语义标签)
 *
 * 不抛错:无论 raw 多奇怪都返回合法字段,作为 LLM 失败的兜底。
 */
export function extractBareMarkdownDefaults(
  sourcePath: string,
  raw: string,
): ExtractedEngramFields {
  const fileName = basename(sourcePath, ".md");
  const prose = stripFencedCodeBlocks(raw);
  const h1s = [...prose.matchAll(/^#\s+(.+)$/gm)].map((m) => m[1]!.trim());
  const title = h1s.length === 1 ? h1s[0]! : fileName || "untitled-note";

  return {
    title: title.slice(0, 200),
    content: raw,
    kind: "observation",
    // 未配置 LLM / LLM 失败时的兜底标签。用 uncategorized(待刷新)而非 imported:
    // imported 是来源类型不是内容语义,且会让 REM delete 的「domainTags 无交集」
    // 判定对所有导入 engram 永远不触发。REM 首次扫描时 baseline 不存在 = 100%
    // 变化,会无条件刷新成真实语义标签。
    domainTags: ["uncategorized"],
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
  fileName?: string,
): Promise<ExtractedEngramFields> {
  const truncated = raw.slice(0, LLM_INPUT_CHAR_BUDGET);
  const prompt = buildExtractionPrompt(truncated, fileName);

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
function buildExtractionPrompt(content: string, fileName?: string): string {
  const fileNameNote = fileName
    ? ` The file name (without \`.md\`) is \`${fileName}\` — it is the strongest signal of the document's topic; prefer it when the body has no single clear top-level heading.`
    : "";
  return `You are extracting engram metadata from a markdown note that was pasted into a team memory directory.

An engram is a team memory entry with these fields:
- title: concise title (20-80 chars)
- kind: one of these 5 categories:
    - "observation": a single observation
    - "fact": a fact verified multiple times
    - "pattern": a pattern abstracted across situations
    - "procedure": a process / how-to statement
    - "hypothesis": a hypothesis awaiting verification
- domainTags: 1-3 domain tags describing the area, in the content's own language (中文内容如 "前端", "测试", "架构"; English e.g. "frontend", "testing")
- summary: 30-100 char abstract

Read the markdown content and output ONLY a JSON object (no prose, no markdown fences):
{"title": "...", "kind": "observation|fact|pattern|procedure|hypothesis", "domainTags": ["...", "..."], "summary": "..."}

Rules for the title:
- Reflect the document's OVERALL topic, not a single step or fragment.
- Ignore \`#\` lines that are shell/code comments inside fenced code blocks (\`\`\` or ~~~); they are not headings. A document with many \`#\` lines is likely leaked code comments (e.g. pasted shell steps) — do not pick one as the title.
- If there is no single clear top-level heading, use the file name as the title${fileName ? ` (file name: \`${fileName}\`)` : ""}.${fileNameNote}

LANGUAGE RULE (applies to title, summary and domainTags):
- Match the DOMINANT LANGUAGE of the content. Chinese content → Chinese tags/title/summary (e.g. "测试", "架构", "工作流"); English content → English. Proper nouns / technical terms (e.g. "adb", "git", "co-engram") keep their original form regardless.

Rules for domainTags:
- They must describe the CONTENT domain / topic (e.g. "testing", "架构", "adb", "git-workflow"), NEVER the source type.
- Do NOT use "imported" or any source/origin label as a domainTag — it carries no content semantics.
- Always extract at least 1 content-derived tag. If the content is genuinely too short to infer any domain, use the single tag "uncategorized" (it marks the engram for a later REM refresh); whenever any topic word is present, prefer it over "uncategorized".

If the content is too short or ambiguous to classify the kind, default kind to "observation".

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
