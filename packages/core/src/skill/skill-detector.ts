/**
 * Skill 目录检测与 SKILL.md 解析（spec S2 §3.3）
 *
 * 不绑死目录：扫 dataRoot 下任意含 SKILL.md（frontmatter name）的目录。
 * 最浅层判定：某目录有 SKILL.md 即为 skill 根，不再下钻（避免子目录 skill 被重复收）。
 * trigger 推断为规则版（S2）+ LLM 版（S2.x）。
 * @module @co-engram/core/skill
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SkillPolicy } from "../types/skill.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";

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

/** LLM 输入字符上限（控制 token 成本，大文档截断） */
const LLM_INPUT_CHAR_BUDGET = 3000;

/** LLM 调用超时（skill trigger 推断不应让用户等太久） */
const LLM_TIMEOUT_MS = 10_000;

/** LLM 输出 token 上限（只需 2 个字段，300 够用） */
const LLM_MAX_TOKENS = 300;

/** LLM 推断温度（trigger 提取要稳定不要发散） */
const LLM_TEMPERATURE = 0.3;

/**
 * LLM 版：从 SKILL.md 智能推断 trigger 字段
 *
 * Prompt 嵌入 skill 的语义，让 LLM 输出符合 trigger 的 initiationSet/termination。
 *
 * 失败抛错（由调用方决定降级到规则版）：
 *   - llmClient.complete 自身可能抛（网络错 / 超时 / API key 错）
 *   - JSON 解析失败抛
 *   - 字段校验失败抛
 */
export async function inferSkillFieldsWithLlm(
  parsed: ParsedSkillMd,
  llmClient: LlmClient,
): Promise<{
  readonly initiationSet: string;
  readonly termination: string;
  readonly policy: SkillPolicy;
}> {
  const prompt = buildSkillTriggerPrompt(parsed);
  const response = await llmClient.complete(prompt, {
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
    timeoutMs: LLM_TIMEOUT_MS,
  });

  if (typeof response !== "string" || response.length === 0) {
    throw new Error("LLM returned non-string output");
  }

  const parsedResponse = parseSkillTriggerResponse(response);
  const kind: SkillPolicy["kind"] = parsed.sourcePath.includes("openclaw") ? "openclaw-skill"
    : parsed.sourcePath.includes("claude") ? "claude-skill" : "prompt";

  return {
    initiationSet: parsedResponse.initiationSet,
    termination: parsedResponse.termination,
    policy: { kind, ref: SKILL_MD_FILENAME },
  };
}

/**
 * 构造 LLM skill trigger 推断 prompt
 *
 * 嵌入 skill 的语义，让 LLM 理解何时触发该技能、何时结束。
 */
function buildSkillTriggerPrompt(parsed: ParsedSkillMd): string {
  const truncatedBody = parsed.body.slice(0, LLM_INPUT_CHAR_BUDGET);
  return `You are analyzing a skill definition to infer when it should be triggered and when it should terminate.

Skill ID: ${parsed.skillId}
Description: ${parsed.description}

Skill Content:
${truncatedBody}

Your task: Infer the trigger conditions for this skill.

Return ONLY a JSON object (no prose, no markdown fences):
{"initiationSet": "...", "termination: "..."}

Where:
- "initiationSet": A concise phrase describing when this skill should be triggered/invoked (e.g. "用户需要设计复杂系统架构时", "When analyzing performance bottlenecks", "During code refactoring")
- "termination": A concise phrase describing when the skill should end/terminate (e.g. "架构设计完成并输出方案后", "After identifying root causes", "When refactoring is complete")

Rules:
- Both fields should be 10-80 characters, concise and actionable
- initiationSet should focus on the user's intent or scenario
- termination should focus on the completion condition or outcome
- Use the same language as the skill content (Chinese for Chinese skills, English for English skills)
- If the content is too short to infer, use generic sensible defaults

JSON output:`;
}

/**
 * 解析 LLM 响应为 skill trigger 字段
 *
 * 复用 engram_synthesize 的 parseSynthesisOutput 模式：
 *   1. trim
 *   2. 剥 markdown fence
 *   3. 抽取最外层 { ... }
 *   4. JSON.parse
 *   5. 字段类型校验 + 截断 + 默认值兜底
 *
 * 失败抛错（由调用方降级到规则版）。
 */
function parseSkillTriggerResponse(raw: string): {
  readonly initiationSet: string;
  readonly termination: string;
} {
  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response has no JSON object");
  }
  const jsonStr = text.slice(start, end + 1);

  let obj: {
    initiationSet?: unknown;
    termination?: unknown;
  };
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `LLM response JSON parse failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const initiationSet =
    typeof obj.initiationSet === "string" && obj.initiationSet.trim().length > 0
      ? obj.initiationSet.trim().slice(0, 200)
      : null;
  if (!initiationSet) {
    throw new Error("LLM response missing valid initiationSet");
  }

  const termination =
    typeof obj.termination === "string" && obj.termination.trim().length > 0
      ? obj.termination.trim().slice(0, 200)
      : null;
  if (!termination) {
    throw new Error("LLM response missing valid termination");
  }

  return {
    initiationSet,
    termination,
  };
}
