/**
 * Content hash 计算（SHA-256）
 *
 * 用于精确去重和变更检测
 *
 * @module @co-engram/core/storage
 */

import { createHash } from "node:crypto";
import { stripDerivedSection } from "./derived-marker.js";

/**
 * 计算 SHA-256 哈希(基于「原始内容」,自动剥除派生突触段)
 *
 * 派生段(`<!-- co-engram-derived:synapses -->` ...)每次 doctor 的
 * regenerateObsidianLinks 会重写,若纳入 hash 会导致 contentHash 反复漂移、
 * doctor 误报 derived_field_stale(stable churn)。createEngram 用 input.content
 * (无派生段)算 hash,故此处对含派生段的 file.content 也先剥除,口径一致。
 *
 * @param content - 任意字符串(可能含派生段)
 * @returns 形如 "sha256:abc123..." 的哈希字符串
 */
export function computeContentHash(content: string): string {
  const hashable = stripDerivedSection(content);
  const hash = createHash("sha256").update(hashable, "utf8").digest("hex");
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
 * 计算内容大小(字符数,基于「原始内容」,自动剥除派生突触段)
 */
export function computeContentSize(content: string): number {
  return stripDerivedSection(content).length;
}
