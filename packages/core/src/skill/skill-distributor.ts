/**
 * Skill 分发（spec §3.2 分发 + D11 冲突优先级）
 *
 * team-memory 中的 skill 目录 → 复制到宿主 skills 目录（~/.claude/skills/、~/.openclaw/skills/）。
 * D11：目标已有同名 skill → 以工作目录原有为主，不覆盖。
 * 分发=复制（独立快照），不软链（避免 Hermes content-hash / OpenClaw 优先级问题）。
 * 不碰 sourceDir 原文件（D6）。
 * @module @co-engram/core/skill
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SKILL_MD_FILENAME } from "./skill-detector.js";

export interface DistributeResult {
  readonly action: "distributed" | "skipped-existing";
  readonly targetPath: string;
  readonly skillId: string;
}

/**
 * 分发一个 skill 目录到宿主 skills 根目录。
 * @param sourceDir  team-memory 中 skill 目录的绝对路径（含 SKILL.md）
 * @param targetDir  宿主 skills 根目录绝对路径（如 ~/.claude/skills）
 * @param skillId    目标子目录名（= skillId）
 * @returns distributed（复制成功）| skipped-existing（D11：目标已有同名，不覆盖）
 */
export function distributeSkill(params: {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly skillId: string;
}): DistributeResult {
  const { sourceDir, targetDir, skillId } = params;
  const targetSkillDir = join(targetDir, skillId);
  // D11：目标已有同名 skill（含 SKILL.md）→ 以工作目录原有为主，不覆盖
  if (existsSync(join(targetSkillDir, SKILL_MD_FILENAME))) {
    return { action: "skipped-existing", targetPath: targetSkillDir, skillId };
  }
  // 复制 sourceDir 全部内容 → targetSkillDir（独立快照，不碰 sourceDir）
  mkdirSync(targetSkillDir, { recursive: true });
  cpSync(sourceDir, targetSkillDir, { recursive: true, force: true });
  return { action: "distributed", targetPath: targetSkillDir, skillId };
}
