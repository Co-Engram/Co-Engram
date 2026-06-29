/**
 * MCP resources(/resources/list + /resources/read + /resources/templates)
 *
 * 暴露 engram 为可读资源:
 *   - URI 模板: `engram:///{id}`(例如 `engram:///testing/2026-06-21-abc123`)
 *   - list: 最近更新的 10 条 engram(title + updatedAt + uri)
 *   - read: 完整 markdown,包含 frontmatter + content + synapses 摘要
 *
 * 设计原则:
 *   - read 是 idempotent,无 side-effect
 *   - 不存在的 id 返回 MCP 错误(不抛异常)
 *   - 不暴露 synapses 的完整图(避免大对象);只返回 count
 *
 * @module @co-engram/claude-code
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { translatePrompt } from "@co-engram/core";
import type { Engram, Language, ToolContext } from "@co-engram/core";

const LIST_LIMIT = 10;
const ENGRAM_URI_SCHEME = "engram";

/**
 * 注册 engram:///{id} 资源模板
 */
export function registerMcpResources(
  server: McpServer,
  ctx: ToolContext,
  language: Language,
): void {
  const template = new ResourceTemplate(
    // {+id} 用 RFC 6570 reserved expansion,允许 id 里包含斜杠
    // (engram id 形如 "domain/2026-06-21-xxx")
    `${ENGRAM_URI_SCHEME}:///{+id}`,
    {
      list: () => listCallback(ctx, language),
    },
  );

  server.registerResource(
    "engram",
    template,
    {
      description:
        language === "zh"
          ? "团队记忆(engram)资源。URI 格式: engram:///<id>。"
          : "Team memory (engram) resource. URI scheme: engram:///<id>.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => readCallback(ctx, language, uri, variables),
  );
}

type ListedResource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

function listCallback(
  ctx: ToolContext,
  language: Language,
): { resources: ListedResource[] } {
  const entries = ctx.repository.listEngrams();
  // listEngrams 只返回 catalog(id/title/kind/domainTags),无 updatedAt
  // 简单按 id 字母序(等价于创建时间,因 id 里嵌入 ISO 日期)倒序
  const sorted = [...entries].sort((a, b) => b.id.localeCompare(a.id));
  const limited = sorted.slice(0, LIST_LIMIT);

  return {
    resources: limited.map((e) => ({
      uri: `${ENGRAM_URI_SCHEME}:///${e.id}`,
      name: e.title,
      description: [
        `kind: ${e.kind}`,
        e.domainTags.length > 0 ? `tags: ${e.domainTags.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
      mimeType: "text/markdown",
    })),
  };
}

type ReadResult = {
  contents: {
    uri: string;
    mimeType?: string;
    text: string;
  }[];
};

async function readCallback(
  ctx: ToolContext,
  language: Language,
  uri: URL,
  variables: Record<string, string | string[]>,
): Promise<ReadResult> {
  const id = extractId(uri, variables);
  if (!id) {
    return errorRead(
      uri.toString(),
      translatePrompt(language, "error.uri_missing_id"),
    );
  }

  if (!ctx.repository.exists(id)) {
    return errorRead(
      uri.toString(),
      translatePrompt(language, "error.engram_not_found", { id }),
    );
  }

  let engram: ReturnType<typeof ctx.repository.readEngram>;
  try {
    engram = ctx.repository.readEngram(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorRead(uri.toString(), `readEngram failed: ${msg}`);
  }

  const text = formatEngramAsMarkdown(engram, language);
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "text/markdown",
        text,
      },
    ],
  };
}

function extractId(
  uri: URL,
  variables: Record<string, string | string[]>,
): string | null {
  // 模板变量优先
  const fromVar = variables.id;
  if (typeof fromVar === "string" && fromVar.length > 0) return fromVar;
  if (Array.isArray(fromVar) && fromVar.length > 0) return fromVar[0]!;

  // 从 URI 解析:engram:///path/to/id → path/to/id
  const full = uri.toString();
  const prefix = `${ENGRAM_URI_SCHEME}:///`;
  if (full.startsWith(prefix)) {
    const id = full.slice(prefix.length);
    return id.length > 0 ? decodeURIComponent(id) : null;
  }
  return null;
}

function formatEngramAsMarkdown(engram: Engram, language: Language): string {
  const lines: string[] = [];
  lines.push(`# ${engram.title}`);
  lines.push("");

  // Frontmatter-style metadata block
  lines.push("| field | value |");
  lines.push("|---|---|");
  lines.push(`| id | \`${engram.id}\` |`);
  lines.push(`| kind | \`${engram.kind}\` |`);
  if (engram.domainTags.length > 0) {
    lines.push(
      `| tags | ${engram.domainTags.map((t) => `\`${t}\``).join(" ")} |`,
    );
  }
  if (typeof (engram as { importance?: number }).importance === "number") {
    lines.push(
      `| importance | ${((engram as { importance: number }).importance * 100).toFixed(0)}% |`,
    );
  }
  if ((engram as { updatedAt?: string }).updatedAt) {
    lines.push(
      `| updatedAt | ${(engram as { updatedAt: string }).updatedAt} |`,
    );
  }
  if ((engram as { createdAt?: string }).createdAt) {
    lines.push(
      `| createdAt | ${(engram as { createdAt: string }).createdAt} |`,
    );
  }
  if ((engram as { version?: number }).version !== undefined) {
    lines.push(`| version | v${(engram as { version: number }).version} |`);
  }
  lines.push("");

  lines.push(language === "zh" ? "## 内容" : "## Content");
  lines.push("");
  lines.push(engram.content || (language === "zh" ? "(空)" : "(empty)"));

  return lines.join("\n");
}

function errorRead(uri: string, message: string): ReadResult {
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: `# Error\n\n${message}`,
      },
    ],
  };
}
