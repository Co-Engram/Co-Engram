/**
 * Content hash 计算（SHA-256）
 *
 * 用于精确去重和变更检测
 *
 * @module @co-engram/core/storage
 */

import { createHash } from "node:crypto";

/**
 * 计算 SHA-256 哈希
 *
 * @param content - 任意字符串
 * @returns 形如 "sha256:abc123..." 的哈希字符串
 */
export function computeContentHash(content: string): string {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * 验证内容是否匹配给定的哈希
 */
export function verifyContentHash(
  content: string,
  expectedHash: string,
): boolean {
  return computeContentHash(content) === expectedHash;
}

/**
 * 计算内容大小（字符数）
 */
export function computeContentSize(content: string): number {
  return content.length;
}
