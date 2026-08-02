/**
 * updatedAt 仲裁 + tiebreaker
 *
 * Layer A of spec §5.6 三层仲裁。当 ours.updatedAt != theirs.updatedAt 时直接判赢家;
 * 秒级碰撞时用 contentHash tiebreaker 判断"谁相对 base 真改了"。
 * ours===theirs contentHash(正文相同)→ 取 ours(同一份知识,无冲突,绝不 escalate);
 * 双方都改正文且互不同 / 无 contentHash 信号 → 'escalate'(留 marker 或调 LLM)。
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

  // 正文相同(ours === theirs contentHash)→ 同一份知识,无知识冲突。
  // 多机器并发检索同一条「正文从未改」的记忆时,frontmatter 运行时元数据
  // (检索次数 / 衰减分数 / 验证状态)各自分叉、但 contentHash 三方一致 ——
  // 此时确定性取 ours 即可(updatedAt 也相同,取哪边都零损失),绝不应 escalate。
  if (
    params.oursContentHash !== undefined &&
    params.oursContentHash === params.theirsContentHash
  ) {
    return "ours";
  }

  // 双方都改了正文(contentHash 都 !== base 且互不相同)/ 无 contentHash 信号 → 升级
  return "escalate";
}
