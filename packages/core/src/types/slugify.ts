/**
 * Slug 与 domainTags 推断
 *
 * 设计:
 * - slug: 保留 unicode(中文等非 ASCII),ASCII 转小写,非法路径字符替换为 `-`,
 *   连续空格合并为一个 `-`,首尾 `-` 裁剪,空时回退 `untitled`。
 * - inferDomainTagsFromPath: 从相对路径的所有目录层推断 domainTags。
 *
 * @module @co-engram/core/types
 */

/** 非法路径字符(在所有主流文件系统上有特殊含义) */
const ILLEGAL_PATH_CHARS = /[\/\\:*?"<>|]/g;

/** 连续空白(空格、tab)合并为单个分隔符 */
const WHITESPACE_RUN = /[\s]+/g;

/**
 * 把 title 转成人类可读的 slug(同时是文件名)。
 *
 * 示例:
 *   "React Hooks 最佳实践" → "react-hooks-最佳实践"
 *   "A/B:C?"                → "a-b-c"
 *   "  多余  空格  "         → "多余-空格"
 *   ""                       → "untitled"
 *
 * 特性:NFC 标准化、保留路径非法字符之外的所有 unicode,不强制 ASCII-only。
 */
export function slugify(title: string): string {
  const normalized = title.normalize("NFC").trim();
  if (normalized.length === 0) return "untitled";

  const replaced = normalized
    .replace(ILLEGAL_PATH_CHARS, "-")
    .replace(WHITESPACE_RUN, "-");
  const lower = replaced.toLowerCase();
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed.length === 0 ? "untitled" : trimmed;
}

/**
 * 从相对路径的所有目录层推断 domainTags。
 *
 * 例:`项目管理/需求管理/操作系统内存优化.md` → `["项目管理", "需求管理"]`
 *
 * 规则:
 * - 取 path 的 dirname
 * - 用 `/` 分隔后过滤空段
 * - 不含文件名,不 normalize unicode(保留人类原始拼写)
 */
export function inferDomainTagsFromPath(relativePath: string): string[] {
  const normalized = relativePath.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return [];
  const dirPart = normalized.slice(0, lastSlash);
  return dirPart.split("/").filter((segment) => segment.length > 0);
}
