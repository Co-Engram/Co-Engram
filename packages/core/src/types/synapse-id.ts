/**
 * Synapse 确定性 ID 计算
 *
 * 同 (from, to, kind) 组合必产生同 id,使 per-edge 存储天然幂等。
 *
 * @module @co-engram/core/types
 */

import { createHash } from "node:crypto";

import type { EngramId } from "./engram.js";
import type { SynapseId } from "./engram.js";
import type { SynapseKind } from "./synapse.js";
import { isSymmetricKind } from "./synapse.js";

/**
 * 计算确定性 SynapseId。
 *
 * 公式:`syn-` + sha256(`${a}|${b}|${kind}`).slice(0, 16)
 *
 * 端点规范化规则(对称性派生自 kind,见 isSymmetricKind):
 * - 对称 kind(similar_to / contradicts):对 from/to 做 min/max 排序,
 *   保证 (A, B) 与 (B, A) 生成同一 id——对称关系端点无方向语义。
 * - 有向 kind(其余 10 种):严格保留 (from, to) 顺序,因为方向本身承载
 *   语义(A→B ≠ B→A),顺序差异应产生不同 id。
 *
 * 历史的 direction 参数已移除;对称性回归 kind 的固有派生属性。
 */
export function computeSynapseId(
  from: EngramId,
  to: EngramId,
  kind: SynapseKind,
): SynapseId {
  const [a, b] = isSymmetricKind(kind)
    ? from <= to
      ? [from, to]
      : [to, from]
    : [from, to];
  const composite = `${a}|${b}|${kind}`;
  const hash = createHash("sha256")
    .update(composite)
    .digest("hex")
    .slice(0, 16);
  return `syn-${hash}` as SynapseId;
}

/** 校验字符串是否符合 SynapseId 格式(syn- + 16 位 hex) */
export function isSynapseId(value: string): value is SynapseId {
  return /^syn-[0-9a-f]{16}$/.test(value);
}
