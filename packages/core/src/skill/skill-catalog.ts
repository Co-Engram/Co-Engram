/**
 * Skill catalog 收集(system prompt 确定性注入用)
 *
 * 设计判断(2026-08 skill 注入方案):
 *   - **内容对齐 Anthropic Agent Skills / OpenClaw 业界实践**:注入 SKILL.md 原生
 *     `description`(name + description 两段式,渐进式披露——正文不注入)。
 *     不读 imprint.initiationSet:规则版下两者同源,但 LLM 推断版会把 description
 *     改写成触发短语,且 imprint 可能滞后于 SKILL.md(contentHash stale)。
 *     实时读 SKILL.md = 单一真相源,零 drift。
 *   - **过滤用 imprint 的 retentionStage**(可变投影):forgotten 阶段的过期技能
 *     不注入——衰退联动是 co-engram 区别于 harness 静态 skill 清单的差异化能力。
 *   - **不变本体管内容,可变投影管过滤**,各归各位。
 *
 * 消费方(三通道复用同一数据):
 *   - core prompt-builder buildSkillSection(OpenClaw promptBuilder 路径)
 *   - claude-code-mcp buildServerInstructions(instructions 动态段)
 *   - openclaw-plugin before_prompt_build hook(appendSystemContext,可靠通道)
 *
 * @module @co-engram/core/skill
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillRepository } from "./skill-repository.js";
import { parseSkillMd, SKILL_MD_FILENAME } from "./skill-detector.js";

/** 单条 skill catalog 项(注入 system prompt 的最小单元) */
export interface SkillCatalogEntry {
  readonly skillId: string;
  /** SKILL.md 原生 description(截断后);空 description 时为兜底文案 */
  readonly description: string;
}

/** 注入条数上限(超出的按 utility 降序裁剪;system prompt 预算防护) */
export const SKILL_CATALOG_MAX_ENTRIES = 10;

/** 单条 description 截断长度(字符;防个别超长 description 撑爆注入预算) */
export const SKILL_CATALOG_DESC_MAX_CHARS = 60;

/**
 * 收集待注入的 skill catalog。
 *
 * 流程:listSkills(imprint)→ 过滤 forgotten → 实时读 SKILL.md 的 description
 * → 截断/兜底 → utility 降序 → 取前 N。
 *
 * 容错:SKILL.md 读不到(目录被 rm/mv,即 doctor 的 dangling 场景)→ 跳过该条,
 * 不让单文件故障拖垮注入;整体异常返回 [](降级为无 skill 段,不阻塞宿主启动)。
 */
export function collectSkillCatalog(
  repo: SkillRepository,
  dataRoot: string,
): readonly SkillCatalogEntry[] {
  let imprints;
  try {
    imprints = repo.listSkills();
  } catch {
    return [];
  }

  const entries: { skillId: string; description: string; utility: number }[] = [];
  for (const imp of imprints) {
    // 衰退联动:forgotten 技能不再注入(harness 静态清单做不到的过滤)
    if (imp.retentionStage === "forgotten") continue;
    const raw = readSkillMd(dataRoot, imp.sourcePath);
    if (raw === null) continue; // SKILL.md 缺失 → doctor 会报 dangling,注入侧跳过
    const parsed = parseSkillMd(raw, imp.sourcePath);
    if (parsed === null) continue; // frontmatter 损坏 → 跳过
    const description =
      truncateDescription(parsed.description) ??
      `使用 ${imp.skillId} 技能时`;
    entries.push({ skillId: imp.skillId, description, utility: imp.utility });
  }

  return entries
    .sort((a, b) => b.utility - a.utility)
    .slice(0, SKILL_CATALOG_MAX_ENTRIES)
    .map(({ skillId, description }) => ({ skillId, description }));
}

/** 读取 SKILL.md 原文;IO 错 / 非法 sourcePath → null */
function readSkillMd(dataRoot: string, sourcePath: string): string | null {
  try {
    const abs =
      sourcePath === "."
        ? join(dataRoot, SKILL_MD_FILENAME)
        : join(dataRoot, sourcePath, SKILL_MD_FILENAME);
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** 截断 description;空 → null(调用方兜底) */
function truncateDescription(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= SKILL_CATALOG_DESC_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SKILL_CATALOG_DESC_MAX_CHARS)}…`;
}
