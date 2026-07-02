/**
 * Adapter：把 host-agnostic 的 Co-Engram Tool 转为 OpenClaw ToolDescriptor
 *
 * @module @co-engram/openclaw
 */

import {
  localizeToolDescription,
  resolveLlmDescription,
  DEFAULT_LANGUAGE,
  type Tool,
  type ToolContext,
  type Language,
} from "@co-engram/core";
import type {
  OpenClawToolDescriptor,
  ToolExecuteResult,
  JsonSchemaObject,
} from "./types.js";
import { TOOL_JSON_SCHEMAS } from "./json-schemas.js";

/**
 * 把任意值包装为 OpenClaw tool execute 的返回结构
 *
 * 对常见的列表型返回(engram_list / engram_search / memory_search 等),渲染为
 * markdown 文本而不是 JSON——OpenClaw 收到 type:'json' 时会把数组渲染成"图表",
 * 让 LLM 误判为不可读。改用 type:'text' + markdown,LLM 一眼就能解析。
 */
/**
 * 把任意值包装为 OpenClaw tool execute 的返回结构
 *
 * 对常见的列表型返回(engram_list / engram_search / memory_search 等),渲染为
 * markdown 文本而不是 JSON——OpenClaw 收到 type:'json' 时会把数组渲染成"图表",
 * 让 LLM 误判为不可读。改用 type:'text' + markdown,LLM 一眼就能解析。
 *
 * 同时识别 engram_get / memory_get 的非列表形状,避免 OpenClaw UI 把单条 engram
 * 数据渲染成"卡片/图表",让 agent 误以为"图片没显示"。
 */
export function toToolResult(
  data: unknown,
  ctx: ToolContext,
): ToolExecuteResult {
  const text = renderForLlm(data, ctx);
  if (text !== null) {
    return {
      content: [{ type: "text", text }],
      details: { ok: true },
    };
  }
  return {
    content: [
      {
        type: "json",
        data,
      },
    ],
    details: { ok: true },
  };
}

/**
 * 把工具返回值渲染为 LLM 友好的 markdown 文本
 *
 * 已识别模式(全部渲染为 type:'text',避免 OpenClaw UI 把 JSON 渲染成
 * 图表卡片让 agent 误判为"图片没显示"):
 *
 *   1. { results: [...], total }  — engram_list / engram_search / memory_search
 *   2. { tier: 'catalog'|'digest'|'content'|'meta'|'synapses', ... }  — engram_get
 *   3. { id, content, metadata, relatedIds }  — memory_get
 *
 * summary 处理:catalog 级结果(engram_list)本身不带 summary,这里通过
 * ctx.repository.readDigest(id) 在 adapter 层附加,保持 core 工具的返回类型不变。
 * 检索类工具(engram_search/memory_search)结果可能自带 summary,优先用自带的。
 *
 * 不识别的返回 null(调用方回退到 JSON)。
 */
function renderForLlm(data: unknown, ctx: ToolContext): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // 模式 1:列表型
  if (Array.isArray(obj["results"])) {
    return renderListResult(obj, ctx);
  }
  // 模式 2:engram_get(tier-based) — tier 是已知字符串即识别
  //   catalog/digest/content/meta 都有 entry;synapses 只有 bundle(无 entry)
  const tier = obj["tier"];
  if (
    typeof tier === "string" &&
    /^(catalog|digest|content|meta|synapses)$/.test(tier)
  ) {
    return renderEngramGetResult(obj);
  }
  // 模式 3:memory_get(id + content + metadata + relatedIds)
  if (
    typeof obj["id"] === "string" &&
    typeof obj["content"] === "string" &&
    typeof obj["metadata"] === "object"
  ) {
    return renderMemoryGetResult(obj);
  }
  return null;
}

/** 渲染列表型结果(engram_list / engram_search / memory_search) */
function renderListResult(
  obj: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const results = obj["results"] as readonly unknown[];
  const lines: string[] = [];
  const total =
    typeof obj["total"] === "number"
      ? (obj["total"] as number)
      : results.length;
  lines.push(`共 ${total} 条记忆(展示前 ${results.length} 条):`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const item = results[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;
    const id = String(item["id"] ?? "?");
    const title = String(item["title"] ?? "(无标题)");
    const explicitSummary = item["summary"] ? String(item["summary"]) : "";
    const summary =
      explicitSummary || (id !== "?" ? safeReadDigestSummary(ctx, id) : "");

    // kind / tags 兼容两种形状:
    //   - engram_list/engram_search: item.kind, item.domainTags(顶层)
    //   - memory_search: item.metadata.kind, item.metadata.tags(嵌套 metadata)
    const meta =
      typeof item["metadata"] === "object"
        ? (item["metadata"] as Record<string, unknown>)
        : {};
    const kind = item["kind"]
      ? String(item["kind"])
      : meta["kind"]
        ? String(meta["kind"])
        : "";
    const rawTags = Array.isArray(item["domainTags"])
      ? item["domainTags"]
      : Array.isArray(meta["tags"])
        ? meta["tags"]
        : [];
    const tags = rawTags.map(String).join(", ");
    const score =
      typeof item["score"] === "number"
        ? ` (score: ${(item["score"] as number).toFixed(2)})`
        : "";

    // P0-4 修复:此前 OpenClaw render 丢弃 importance/freshness/contextTags/createdBy,
    // 让 agent 看不到记忆的"权重/新鲜度/情境标签/作者"四项关键元数据,只能看 id+title+tags。
    // 现在补齐:与 engram_list/engram_search 的 DigestLine 字段对齐,优先读顶层,缺失时
    // 兜底读 metadata(memory_search 形状)。
    const importance = readNumberField(item["importance"], meta["importance"]);
    const freshness = readStringField(item["freshness"], meta["freshness"]);
    const rawContextTags = Array.isArray(item["contextTags"])
      ? item["contextTags"]
      : Array.isArray(meta["contextTags"])
        ? meta["contextTags"]
        : [];
    const contextTags =
      rawContextTags.length > 0 ? rawContextTags.map(String).join(", ") : "";
    const createdBy = readStringField(item["createdBy"], meta["createdBy"]);

    lines.push(`${i + 1}. **${title}**${score}`);
    lines.push(`   - id: \`${id}\``);
    if (kind) lines.push(`   - kind: ${kind}`);
    if (tags) lines.push(`   - tags: ${tags}`);
    if (contextTags) lines.push(`   - contextTags: ${contextTags}`);
    if (importance !== null) {
      lines.push(`   - importance: ${importance.toFixed(2)}`);
    }
    if (freshness) lines.push(`   - freshness: ${freshness}`);
    if (createdBy) lines.push(`   - createdBy: ${createdBy}`);
    if (summary) lines.push(`   - summary: ${summary}`);
  }

  lines.push("");
  lines.push("用户想看某条的完整内容时,根据 id 调 engram_get 或 memory_get。");
  return lines.join("\n");
}

/** 防御性读字符串字段(支持顶层或嵌套 metadata),都不是字符串返回空 */
function readStringField(
  primary: unknown,
  fallback: unknown,
): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return "";
}

/** 防御性读数字字段(支持顶层或嵌套 metadata),都不是有限数字返回 null */
function readNumberField(
  primary: unknown,
  fallback: unknown,
): number | null {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return null;
}

/** 渲染 engram_get 各 tier 结果 */
function renderEngramGetResult(obj: Record<string, unknown>): string {
  const tier = String(obj["tier"] ?? "");
  const entry = obj["entry"] as Record<string, unknown> | undefined;
  const lines: string[] = [];

  // synapses tier 没有 entry,但有 bundle — 直接走突触渲染
  if (tier === "synapses") {
    return renderSynapsesBundle(obj);
  }

  if (entry) {
    const title = String(entry["title"] ?? "(无标题)");
    const id = String(entry["id"] ?? "?");
    const kind = entry["kind"] ? String(entry["kind"]) : "";
    const tags = Array.isArray(entry["domainTags"])
      ? (entry["domainTags"] as unknown[]).map(String).join(", ")
      : "";
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- id: \`${id}\``);
    if (kind) lines.push(`- kind: ${kind}`);
    if (tags) lines.push(`- tags: ${tags}`);
    lines.push("");
  }

  if (tier === "content" && typeof obj["content"] === "string") {
    lines.push("### 内容");
    lines.push("");
    lines.push(obj["content"]);
    return lines.join("\n");
  }

  if (tier === "digest") {
    const digest = obj["digest"] as Record<string, unknown> | undefined;
    if (digest) {
      lines.push("### 摘要");
      lines.push("");
      if (typeof digest["summary"] === "string" && digest["summary"]) {
        lines.push(String(digest["summary"]));
      }
      if (typeof digest["importance"] === "number") {
        lines.push(``);
        lines.push(`importance: ${digest["importance"]}`);
      }
      lines.push(``);
      lines.push(
        `(digest tier — 要完整内容调 \`engram_get(id, tier="content")\`)`,
      );
    }
    return lines.join("\n");
  }

  if (tier === "meta") {
    const meta = obj["meta"] as Record<string, unknown> | undefined;
    if (meta) {
      lines.push("### 元数据");
      lines.push("");
      for (const [k, v] of Object.entries(meta)) {
        if (k === "content") continue;
        lines.push(`- ${k}: ${formatMetaValue(v)}`);
      }
    }
    return lines.join("\n");
  }

  if (tier === "catalog") {
    lines.push(
      `(catalog tier — 只有元数据;要完整内容调 \`engram_get(id, tier="content")\`)`,
    );
    return lines.join("\n");
  }

  if (tier === "synapses") {
    return renderSynapsesBundle(obj);
  }

  return lines.join("\n");
}

/** 渲染 synapses bundle(engram_get synapses tier) */
function renderSynapsesBundle(obj: Record<string, unknown>): string {
  const bundle = obj["bundle"] as Record<string, unknown> | undefined;
  const lines: string[] = [];
  if (!bundle) return "(无 synapses)";

  lines.push("### 突触(synapses)");
  lines.push("");
  const outgoing = Array.isArray(bundle["outgoing"]) ? bundle["outgoing"] : [];
  const incoming = Array.isArray(bundle["incoming"]) ? bundle["incoming"] : [];
  if (outgoing.length > 0) {
    lines.push(`**Outgoing (${outgoing.length}):**`);
    for (const s of outgoing as Record<string, unknown>[]) {
      const to = String(s["to"] ?? "?");
      const kind = String(s["kind"] ?? "?");
      const weight = typeof s["weight"] === "number" ? s["weight"] : "";
      lines.push(
        `- → \`${to}\` (${kind}${weight !== "" ? `, w=${weight}` : ""})`,
      );
    }
    lines.push("");
  }
  if (incoming.length > 0) {
    lines.push(`**Incoming (${incoming.length}):**`);
    for (const s of incoming as Record<string, unknown>[]) {
      const from = String(s["from"] ?? "?");
      const kind = String(s["kind"] ?? "?");
      const weight = typeof s["weight"] === "number" ? s["weight"] : "";
      lines.push(
        `- ← \`${from}\` (${kind}${weight !== "" ? `, w=${weight}` : ""})`,
      );
    }
  }
  if (outgoing.length === 0 && incoming.length === 0) {
    lines.push("(无 synapses)");
  }
  return lines.join("\n");
}

/** 渲染 memory_get 结果(OpenClaw 兼容包装) */
function renderMemoryGetResult(obj: Record<string, unknown>): string {
  const id = String(obj["id"] ?? "?");
  const content = String(obj["content"] ?? "");
  const metadata = obj["metadata"] as Record<string, unknown> | undefined;
  const relatedIds = Array.isArray(obj["relatedIds"])
    ? (obj["relatedIds"] as unknown[])
    : [];

  const lines: string[] = [];
  lines.push(`## Memory \`${id}\``);
  lines.push("");

  if (metadata) {
    lines.push("### 元数据");
    lines.push("");
    for (const [k, v] of Object.entries(metadata)) {
      lines.push(`- ${k}: ${formatMetaValue(v)}`);
    }
    lines.push("");
  }

  lines.push("### 内容");
  lines.push("");
  lines.push(content);

  if (relatedIds.length > 0) {
    lines.push("");
    lines.push("### 相关记忆");
    lines.push("");
    for (const rid of relatedIds) {
      lines.push(`- \`${String(rid)}\``);
    }
  }

  return lines.join("\n");
}

/** 元数据值的紧凑展示 */
function formatMetaValue(v: unknown): string {
  if (v === null || v === undefined) return "(无)";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * 安全读取 digest 的 summary,失败返回空字符串
 *
 * 用于给 catalog 级结果(engram_list)在 adapter 层补 summary。
 */
function safeReadDigestSummary(ctx: ToolContext, id: string): string {
  try {
    return ctx.repository.readDigest(id)?.summary ?? "";
  } catch {
    return "";
  }
}

function toErrorResult(error: unknown): ToolExecuteResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { ok: false, error: message },
  };
}

/**
 * 把单个 Co-Engram Tool 转为 OpenClaw ToolDescriptor
 *
 * @param language 工具描述本地化语言(默认英文)
 */
export function adaptTool(
  tool: Tool,
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): OpenClawToolDescriptor {
  const jsonSchema: JsonSchemaObject = TOOL_JSON_SCHEMAS[tool.name] ?? {
    type: "object",
    additionalProperties: true,
  };

  return {
    name: tool.name,
    label: tool.name,
    description: resolveLlmDescription(
      tool,
      language,
      localizeToolDescription(tool.name, language, tool.description),
    ),
    parameters: jsonSchema,
    async execute(_toolCallId, params, _signal) {
      try {
        const result = await tool.execute(params ?? {}, ctx);
        return toToolResult(result, ctx);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  };
}

/**
 * 批量适配所有工具
 */
export function adaptAllTools(
  tools: readonly Tool[],
  ctx: ToolContext,
  language: Language = DEFAULT_LANGUAGE,
): readonly OpenClawToolDescriptor[] {
  return tools.map((t) => adaptTool(t, ctx, language));
}
