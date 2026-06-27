/**
 * updatedAt 仲裁 + tiebreaker
 *
 * Layer A of spec §5.6 三层仲裁。当 ours.updatedAt != theirs.updatedAt 时直接判赢家;
 * 秒级碰撞时用 contentHash tiebreaker 判断"谁相对 base 真改了"。
 * 仍平局 → 返回 'escalate',由调用方决定(Phase 1: 留 git marker;Phase 3: 调 LLM)。
 *
 * @module @co-engram/core/merge
 */

export type ArbitrationVerdict = "ours" | "theirs" | "escalate";

export function arbitrateByUpdatedAt(params: {
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
  baseContentHash?: string;
  oursContentHash?: string;
  theirsContentHash?: string;
}): ArbitrationVerdict {
  const { oursUpdatedAt, theirsUpdatedAt } = params;

  if (oursUpdatedAt > theirsUpdatedAt) return "ours";
  if (theirsUpdatedAt > oursUpdatedAt) return "theirs";

  // 秒级碰撞 — 用 contentHash tiebreaker
  const base = params.baseContentHash;
  const oursChanged =
    params.oursContentHash !== undefined && params.oursContentHash !== base;
  const theirsChanged =
    params.theirsContentHash !== undefined && params.theirsContentHash !== base;

  if (oursChanged && !theirsChanged) return "ours";
  if (theirsChanged && !oursChanged) return "theirs";

  // 双方都改 / 双方都没改 / 无 contentHash 信号 → 升级
  return "escalate";
}
