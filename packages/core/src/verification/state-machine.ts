/**
 * 验证状态机（spec §3.9, P3 4.5.1）
 *
 * 状态序列：unverified → plausible → probable → verified
 * 终态：refuted
 *
 * 合法转移规则：
 *   1. undefined（创建后未设置）→ 任意状态：首次设置，允许
 *   2. 任何状态 → refuted：随时可以反驳（发现新证据）
 *   3. 相邻级别升级：unverified → plausible → probable → verified（不允许跳级）
 *   4. refuted → 任何：不允许（终态）
 *
 * 升级条件（spec §4.5.2）在 upgrade.ts 中实现，不在本文件。
 *
 * @module @co-engram/core/verification
 */

import type { VerificationStatus } from "../types/engram.js";

/**
 * 状态级别（数字越大越成熟）
 *
 * refuted 特殊处理：作为终态，不参与升降序比较。
 */
export const STATUS_ORDER: Record<VerificationStatus, number> = {
  unverified: 0,
  plausible: 1,
  probable: 2,
  verified: 3,
  refuted: 4,
};

/**
 * 正向升级路径（不含 refuted）
 *
 * unverified → plausible → probable → verified
 */
export const UPGRADE_PATH: readonly VerificationStatus[] = [
  "unverified",
  "plausible",
  "probable",
  "verified",
];

/** 终态集合（不允许转出） */
export const TERMINAL_STATUSES: ReadonlySet<VerificationStatus> =
  new Set<VerificationStatus>(["refuted"]);

/**
 * 判断状态转移是否合法
 *
 * 设计原则：
 *   - 首次设置（from=undefined）允许到 unverified 或 plausible（基础起点）
 *     或 refuted（直接反驳）；不允许跳到 probable/verified（跳级）
 *   - 已有状态：严格相邻升级，或直接 refute
 *   - refuted 是终态
 *
 * @param from 当前状态；undefined 表示尚未设置
 * @param to   目标状态
 */
export function canTransition(
  from: VerificationStatus | undefined,
  to: VerificationStatus,
): boolean {
  // 首次设置：允许 unverified（默认起点）/ plausible（部分验证起点）/ refuted（直接反驳）
  if (from === undefined) {
    return to === "unverified" || to === "plausible" || to === "refuted";
  }

  // 终态不允许转出
  if (TERMINAL_STATUSES.has(from)) {
    return false;
  }

  // 任何非终态都可以直接 refute（发现反例即可）
  if (to === "refuted") {
    return true;
  }

  // 升级：必须是相邻级别
  const fromLevel = STATUS_ORDER[from];
  const toLevel = STATUS_ORDER[to];
  return toLevel === fromLevel + 1;
}

/**
 * 获取下一个正向升级状态
 *
 * - undefined → unverified
 * - verified 已经最高，返回 verified
 * - refuted 返回 refuted（终态）
 */
export function nextUpgradeStatus(
  current: VerificationStatus | undefined,
): VerificationStatus {
  if (current === undefined) return "unverified";
  if (current === "refuted") return "refuted";
  if (current === "verified") return "verified";
  const idx = UPGRADE_PATH.indexOf(current);
  if (idx < 0 || idx >= UPGRADE_PATH.length - 1) {
    return current;
  }
  return UPGRADE_PATH[idx + 1]!;
}

/**
 * 比较状态成熟度
 *
 * 返回值：
 *   - 正数：a 比 b 成熟
 *   - 负数：b 比 a 成熟
 *   - 0：相等
 *
 * 注意：refuted 不与 verified/plausible 等比较"成熟度"。
 * 此函数仅用于升级路径排序，调用方应先排除 refuted。
 */
export function compareStatus(
  a: VerificationStatus,
  b: VerificationStatus,
): number {
  return STATUS_ORDER[a] - STATUS_ORDER[b];
}

/**
 * 是否为终态
 */
export function isTerminal(status: VerificationStatus | undefined): boolean {
  if (status === undefined) return false;
  return TERMINAL_STATUSES.has(status);
}

/**
 * 是否为反驳状态
 */
export function isRefuted(status: VerificationStatus | undefined): boolean {
  return status === "refuted";
}

/**
 * 是否为已验证状态（verified）
 */
export function isVerified(status: VerificationStatus | undefined): boolean {
  return status === "verified";
}
