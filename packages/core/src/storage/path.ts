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

import type { EngramCreateInput } from "../types/engram.js";
import { slugify } from "../types/slugify.js";

/** 最大 domainTags 深度（防止路径过深） */
const MAX_DOMAIN_DEPTH = 3;

/**
 * 推导 engram 的相对路径（不含扩展名）
 *
 * @param input - 创建参数
 * @returns 相对路径，如 "testing/adb/android/android-14-无线-adb"
 */
export function deriveEngramPath(
  input: Pick<EngramCreateInput, "title" | "domainTags">,
): string {
  const domainTags = input.domainTags ?? [];
  const domainPath = domainTags
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
