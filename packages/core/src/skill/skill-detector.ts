/**
 * Skill 目录检测与 SKILL.md 解析（spec S2 §3.3）
 *
 * 不绑死目录：扫 dataRoot 下任意含 SKILL.md（frontmatter name）的目录。
 * 最浅层判定：某目录有 SKILL.md 即为 skill 根，不再下钻（避免子目录 skill 被重复收）。
 * trigger 推断为规则版（S2）；LLM 版留 S2.x。
 * @module @co-engram/core/skill
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SkillPolicy } from "../types/skill.js";

export const SKILL_MD_FILENAME = "SKILL.md";
const SKIP_DIRS = new Set([".git", "node_modules", ".co-engram", "skill-imprints", "synapses", ".trash", "intentions", "config"]);

export interface ParsedSkillMd {
  readonly skillId: string;
  readonly description: string;
  readonly body: string;
  readonly sourcePath: string;
}

/** 解析 SKILL.md 原文 → {skillId, description, body}；无 frontmatter/YAML 损坏返回 null */
export function parseSkillMd(raw: string, sourcePath: string): ParsedSkillMd | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  let fm: Record<string, unknown> = {};
  try {
    const r = parse(m[1] ?? "");
    if (r && typeof r === "object" && !Array.isArray(r)) fm = r as Record<string, unknown>;
    else return null;
  } catch {
    return null;
  }
  const name = typeof fm["name"] === "string" ? fm["name"].trim() : "";
  const description = typeof fm["description"] === "string" ? fm["description"] : "";
  const body = (m[2] ?? "").trim();
  const dirName = sourcePath.split("/").filter(Boolean).pop() ?? sourcePath;
  const skillId = name || dirName;
  if (!skillId) return null;
  return { skillId, description, body, sourcePath };
}

/** 扫 dataRoot 下含 SKILL.md 的目录（最浅层）→ sourcePath 列表（相对 dataRoot） */
export function collectSkillDirs(dataRoot: string): string[] {
  const out: string[] = [];
  function walk(currentDir: string, relDir: string): void {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(currentDir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === SKILL_MD_FILENAME)) {
      out.push(relDir || ".");
      return; // 不下钻
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(currentDir, e.name), relDir ? `${relDir}/${e.name}` : e.name);
    }
  }
  walk(dataRoot, "");
  return out;
}

/** 规则版推断 skill 字段（无 LLM） */
export function inferSkillFields(parsed: ParsedSkillMd): {
  readonly initiationSet: string;
  readonly termination: string;
  readonly policy: SkillPolicy;
} {
  const initiationSet = parsed.description?.trim() || `使用 ${parsed.skillId} 技能时`;
  const text = `${parsed.description}\n${parsed.body}`;
  const termMatch = text.match(/(完成|结束|拿到|得到|成功|返回)[^\n。；]{0,40}/);
  const termination = termMatch ? termMatch[0] : "任务完成或目标达成后";
  const kind: SkillPolicy["kind"] = parsed.sourcePath.includes("openclaw") ? "openclaw-skill"
    : parsed.sourcePath.includes("claude") ? "claude-skill" : "prompt";
  return { initiationSet, termination, policy: { kind, ref: SKILL_MD_FILENAME } };
}
