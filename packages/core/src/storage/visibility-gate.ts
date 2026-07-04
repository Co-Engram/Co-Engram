import type { EngramVisibility } from "../types/engram.js";

/**
 * Visibility 单向闸门:禁止任何 → private 的转换。
 *
 * 理由:private 路径进 .gitignore,public/team 记忆切换为 private 会导致
 * 其他成员的 Git 工作树中该记忆消失(隐性删除)。private 只能在创建时设定。
 *
 * 允许的转换:
 *   - 任意 → 任意相同(无操作)
 *   - public ↔ team(可逆)
 *   - public ↔ restricted(可逆)
 *   - team ↔ restricted(可逆)
 *   - private → 任意(单向开放)
 *
 * 禁止的转换:
 *   - 任何非-private → private
 */
export function assertVisibilityTransitionAllowed(
  from: EngramVisibility,
  to: EngramVisibility,
): void {
  if (from === to) return;
  if (to === "private" && from !== "private") {
    throw new Error(
      `Visibility transition ${from} → private is not allowed. ` +
        `Private visibility can only be set at creation time. ` +
        `Reason: private paths are gitignored; switching to private would ` +
        `silently delete the memory from other users' worktrees.`,
    );
  }
}
