/**
 * Claude Code auto-memory 文件解析
 *
 * Claude Code 在 `~/.claude/projects/<encoded-cwd>/memory/*.md` 下写入自动记忆,
 * 格式为 YAML frontmatter + markdown body:
 *
 * ```markdown
 * ---
 * name: low-friction-defaults
 * description: "用户偏好..."
 * metadata:
 *   node_type: memory
 *   type: feedback
 *   originSessionId: <uuid>
 * ---
 *
 * <body>
 * ```
 *
 * `MEMORY.md` 是索引文件(一行一条 `- [Title](file.md) — hook`),不包含真正的
 * 记忆内容,本解析器会跳过它。
 *
 * @module @co-engram/claude-code/memory-sync
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "yaml";

/** Claude Code auto-memory type → co-engram EngramKind 的映射源类型 */
export type AutoMemoryType =
  | "user"
  | "feedback"
  | "project"
  | "reference"
  | "pattern"
  | "observation"
  | "fact"
  | "procedure"
  | "hypothesis"
  | (string & {});

/** 解析结果 */
export interface ParsedAutoMemory {
  /** 来自 frontmatter `name` 字段,缺失时用文件名(去 .md) */
  readonly slug: string;
  /** 来自 frontmatter `description` 字段,缺失时为空字符串 */
  readonly description: string;
  /** 来自 frontmatter `metadata.type`,缺失时为 "observation" */
  readonly type: string;
  /** markdown body(frontmatter 之后的原始内容,已 trim) */
  readonly body: string;
  /** 源文件绝对路径(用于日志) */
  readonly filePath: string;
}

/** 文件名特殊处理:Claude Code 的索引文件 */
const INDEX_FILENAMES = new Set(["MEMORY.md", "memory.md"]);

/**
 * 从原始文本解析 Claude Code auto-memory
 *
 * 返回 `null` 表示应跳过:
 *   - 无 frontmatter
 *   - 是 MEMORY.md 索引文件(由调用方判断文件名,这里只看内容)
 *   - frontmatter 缺 `name`(且文件名也无法推导 slug)
 *
 * @internal 此函数接受 filePath 仅用于日志,不做 IO
 */
export function parseAutoMemoryContent(
  raw: string,
  filePath: string,
): ParsedAutoMemory | null {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const yamlText = frontmatterMatch[1] ?? "";
  const body = (frontmatterMatch[2] ?? "").trim();

  let parsed: Record<string, unknown> | null = null;
  try {
    const result = parse(yamlText);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      parsed = result as Record<string, unknown>;
    }
  } catch {
    // YAML 解析失败:跳过这条记忆
    return null;
  }
  if (!parsed) return null;

  const name = typeof parsed["name"] === "string" ? parsed["name"] : "";
  const description =
    typeof parsed["description"] === "string" ? parsed["description"] : "";
  const metadata = parsed["metadata"];
  const type =
    metadata && typeof metadata === "object" && "type" in metadata
      ? typeof (metadata as Record<string, unknown>)["type"] === "string"
        ? ((metadata as Record<string, unknown>)["type"] as string)
        : "observation"
      : "observation";

  // slug 优先用 name;否则用文件名(去 .md)
  const fileBase = basename(filePath).replace(/\.md$/i, "");
  const slug = name.trim() || fileBase;
  if (!slug) return null;

  return { slug, description, type, body, filePath };
}

/**
 * 读取并解析单个文件
 *
 * IO 错误向上抛;解析失败(无 frontmatter / YAML 损坏)返回 `null`。
 * 是 MEMORY.md 索引文件返回 `null`。
 */
export function parseAutoMemoryFile(filePath: string): ParsedAutoMemory | null {
  if (INDEX_FILENAMES.has(basename(filePath))) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return parseAutoMemoryContent(raw, filePath);
}

/**
 * 是否是 Claude Code auto-memory 文件名(用于目录扫描过滤)
 *
 * 接受 `*.md` 但排除 `MEMORY.md` 索引。
 */
export function isAutoMemoryFileName(fileName: string): boolean {
  if (!fileName.endsWith(".md")) return false;
  return !INDEX_FILENAMES.has(fileName);
}
