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

/**
 * 计算确定性 SynapseId。
 *
 * 公式:`syn-` + sha256(`${from}|${to}|${kind}`).slice(0, 16)
 *
 * 规范化:对 from/to 排序保证 (A, B, kind) 和 (B, A, kind) 在 bidirectional 时
 * 生成同 id。directional 严格保留顺序。
 */
export function computeSynapseId(
  from: EngramId,
  to: EngramId,
  kind: SynapseKind,
  direction: "directional" | "bidirectional" = "directional",
): SynapseId {
  const [a, b] =
    direction === "bidirectional"
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
