/**
 * Engram 路径推导
 *
 * 规则（spec 7.4）：
 *   1. 从 domainTags 推导目录层级（取前 3 个，避免过深）
 *   2. 从 title 生成 slug
 *   3. 组合为 {domainPath}/{slug}
 *
 * 示例：
 *   domainTags=["testing","adb","android"], title="Android 14 无线 ADB"
 *   → "testing/adb/android/android-14-无线-adb"
 *
 * @module @co-engram/core/storage
 */

import { resolve, normalize, relative, sep } from "node:path";
import type { EngramCreateInput } from "../types/engram.js";
import { slugify } from "../types/slugify.js";

/** 最大 domainTags 深度（防止路径过深） */
const MAX_DOMAIN_DEPTH = 3;

/**
 * 推导 engram 的相对路径（不含扩展名）
 *
 * AI-10 路径分裂修复:domainTags 先按 Unicode 字母序排序,再拼路径。
 * 同语义不同顺序的 tag 集合不再产生不同目录树。
 *
 * @param input - 创建参数
 * @returns 相对路径，如 "testing/adb/android/android-14-无线-adb"
 */
export function deriveEngramPath(
  input: Pick<EngramCreateInput, "title" | "domainTags">,
): string {
  const domainTags = input.domainTags ?? [];
  const domainPath = [...domainTags]
    .sort()
    .slice(0, MAX_DOMAIN_DEPTH)
    .map((t) => slugify(t))
    .filter(Boolean)
    .join("/");
  const slug = slugify(input.title) || "untitled";

  return domainPath ? `${domainPath}/${slug}` : slug;
}

/**
 * 推导 engram 在 content/ 目录下的完整路径（带 .md 扩展名）
 */
export function deriveContentFilePath(relativePath: string): string {
  return `engrams/content/${relativePath}.md`;
}

/**
 * 推导 engram 在 meta/ 目录下的完整路径（带 .yaml 扩展名）
 */
export function deriveMetaFilePath(relativePath: string): string {
  return `engrams/meta/${relativePath}.yaml`;
}

/**
 * 推导 engram 在 synapses/ 目录下的完整路径（带 .yaml 扩展名）
 */
export function deriveSynapsesFilePath(relativePath: string): string {
  return `engrams/synapses/${relativePath}.yaml`;
}

/**
 * 从相对路径反推 engram id（即相对路径本身）
 *
 * 在 Co-Engram 中，engram id 就是相对路径。
 */
export function idFromRelativePath(relativePath: string): string {
  return relativePath;
}

/**
 * 从 id 推导三文件相对路径（content/meta/synapses 各一份）
 *
 * @returns 三个文件路径的元组
 */
export function deriveAllFilePaths(relativePath: string): {
  content: string;
  meta: string;
  synapses: string;
} {
  return {
    content: deriveContentFilePath(relativePath),
    meta: deriveMetaFilePath(relativePath),
    synapses: deriveSynapsesFilePath(relativePath),
  };
}

/**
 * 把相对路径安全地拼到仓库根目录下,拒绝 `..` 逃逸(path traversal 防御)。
 *
 * 威胁模型:
 *   - 调用方传入 `pathHint='../etc/passwd'` 或 domainTag=`'..'`
 *   - 直接 `join(root, '../etc/passwd')` 会跳出 root,读写任意文件
 *
 * 防御:
 *   1. normalize 后用 `relative(root, abs)` 检查结果不以 `..` 开头
 *   2. 同时拒绝绝对路径(Windows 盘符 / POSIX `/`)与盘符相对路径(`C:foo`)
 *   3. 拒绝 NUL 字节(防止截断攻击)
 *
 * @param root 仓库根目录(绝对路径)
 * @param relativePath 用户/调用方传入的相对路径
 * @returns 安全的绝对路径
 * @throws 若 relativePath 试图逃逸 root 或含非法字符
 */
export function safeJoinWithinRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("safeJoinWithinRoot: relativePath is empty");
  }
  if (relativePath.includes("\0")) {
    throw new Error(`safeJoinWithinRoot: NUL byte in path`);
  }
  // 拒绝绝对路径(POSIX `/` 与 Windows `C:\\` / `C:foo`)
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath) || /^[a-zA-Z]:[^\\/]/.test(relativePath)) {
    throw new Error(`safeJoinWithinRoot: absolute path not allowed: ${relativePath}`);
  }
  const absRoot = resolve(root);
  const absTarget = normalize(resolve(absRoot, relativePath));
  const rel = relative(absRoot, absTarget);
  // rel === '' 表示 absTarget === absRoot(自身,合法)
  // rel 不以 `..` 开头且不以 `..${sep}` 开头 → 仍在 root 内
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `safeJoinWithinRoot: path escapes root (root=${absRoot}, target=${absTarget})`,
    );
  }
  return absTarget;
}

/**
 * 校验相对路径是否在 root 内(不抛错,返回 boolean)。
 *
 * 用于 readEngram 等读取场景:resolvePath 拿到 stableId 后,先校验路径合法性。
 */
export function isPathWithinRoot(root: string, relativePath: string): boolean {
  try {
    safeJoinWithinRoot(root, relativePath);
    return true;
  } catch {
    return false;
  }
}
