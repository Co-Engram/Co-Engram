/**
 * Skill 目录检测与 SKILL.md 解析（spec S2 §3.3）
 *
 * 不绑死目录：扫 dataRoot 下任意含 SKILL.md（frontmatter name）的目录。
 * 最浅层判定：某目录有 SKILL.md 即为 skill 根，不再下钻（避免子目录 skill 被重复收）。
 * trigger 推断为规则版（S2）+ LLM 版（S2.x）。
 * @module @co-engram/core/skill
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { LlmClient } from "../observability/necessity-evaluator.js";

export const SKILL_MD_FILENAME = "SKILL.md";
const SKIP_DIRS = new Set([".git", "node_modules", ".co-engram", "skill-imprints", "synapses", ".trash", "intentions", "config"]);

export interface ParsedSkillMd {
  readonly skillId: string;
  readonly description: string;
  readonly body: string;
  readonly sourcePath: string;
  readonly allowedTools?: readonly string[];
  readonly license?: string;
  readonly skillVersion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly compatibility?: string;
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
  // SKILL.md 原生字段(agentskills.io 规范):allowed-tools 规范化为 string[]
  const rawAllowedTools = fm["allowed-tools"];
  let allowedTools: readonly string[] | undefined;
  if (typeof rawAllowedTools === "string") {
    allowedTools = rawAllowedTools.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(rawAllowedTools)) {
    allowedTools = rawAllowedTools.filter((s): s is string => typeof s === "string");
  }
  const license = typeof fm["license"] === "string" ? fm["license"] : undefined;
  const version = typeof fm["version"] === "string" ? fm["version"] : undefined;
  const metadata = (fm["metadata"] && typeof fm["metadata"] === "object" && !Array.isArray(fm["metadata"]))
    ? fm["metadata"] as Readonly<Record<string, unknown>> : undefined;
  const compatibility = typeof fm["compatibility"] === "string" ? fm["compatibility"] : undefined;
  return {
    skillId,
    description,
    body,
    sourcePath,
    ...(allowedTools ? { allowedTools } : {}),
    ...(license ? { license } : {}),
    ...(version ? { skillVersion: version } : {}),
    ...(metadata ? { metadata } : {}),
    ...(compatibility ? { compatibility } : {}),
  };
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

/**
 * 判断文件是否位于 skill 目录下（含 SKILL.md 的目录，或其任意深度的子目录）。
 *
 * 为什么 scanForExternalMarkdown 用本函数而非 collectSkillDirs 预扫描：
 * collectSkillDirs 用 readdirSync walk 列举整个 dataRoot 的目录结构。在 skill 目录
 * **创建瞬间**（daemon 运行中用户新粘贴 skill 目录），readdirSync 的目录列举（getdents）
 * 可能与文件可见性有时效差——collectMarkdownFiles 那一刻已能看到新目录下的 SKILL.md，
 * 但 collectSkillDirs 的 walk 可能还没列举到该新目录（readdir 缓存/竞态），导致
 * skillRoots 漏判，SKILL.md 被一次性、持久地误判为 external-markdown 提案
 * （误提案不可撤销，下一轮 scanForSkills 即使发现真实 skill 也撤不回已发的误提案）。
 * 这在本地 ext3/4 也可复现（非 NFS 特有——thinking-ooda 实测铁证）。
 *
 * 本函数以「文件自身的已知路径」为锚点，从所在目录逐级向上 existsSync(ancestor/SKILL.md)
 * （单文件 stat），正确性不依赖 collectSkillDirs 整体 walk 的一致性，消除上述窗口。
 * 前置条件：文件已被 collectMarkdownFiles 列出（文件 stat 已可见）→ 其祖先 SKILL.md 的
 * stat 同样可见，故向上查不会漏。
 *
 * @param fileRelPath 文件相对 dataRoot 的路径（正斜杠分隔，如 "共享skills/foo/notes.md"）
 * @param dataRoot dataRoot 绝对路径
 * @returns 该文件处于某 skill 目录（含 dataRoot 本身为 skill 的边缘情况）下 → true
 */
export function isInSkillId(fileRelPath: string, dataRoot: string): boolean {
  const parts = fileRelPath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  // i = 祖先目录由 parts 前 i 段构成；从「文件所在目录」(i = parts.length - 1)
  // 逐级上到 dataRoot 本身 (i = 0)。dataRoot 含 SKILL.md 时所有文件都归 skill。
  for (let i = parts.length - 1; i >= 0; i--) {
    const ancestorRel = i === 0 ? "" : parts.slice(0, i).join("/");
    const skillMdPath = join(dataRoot, ancestorRel, SKILL_MD_FILENAME);
    try {
      if (existsSync(skillMdPath)) return true;
    } catch {
      // existsSync 异常（权限 / 瞬断）→ 当作该级无 SKILL.md，继续向上查
    }
  }
  return false;
}

/** 规则版推断 skill 字段（无 LLM）。S6.x:只推断 initiationSet（termination/policy 已移除） */
export function inferSkillFields(parsed: ParsedSkillMd): {
  readonly initiationSet: string;
} {
  const initiationSet = parsed.description?.trim() || `使用 ${parsed.skillId} 技能时`;
  return { initiationSet };
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
 * LLM 版：从 SKILL.md 智能推断 initiationSet（S6.x:termination/policy 已移除）
 *
 * Prompt 嵌入 skill 的语义，让 LLM 输出精炼的触发条件。
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
  return { initiationSet: parsedResponse.initiationSet };
}

/**
 * 构造 LLM skill trigger 推断 prompt（S6.x:只推断 initiationSet）
 */
function buildSkillTriggerPrompt(parsed: ParsedSkillMd): string {
  const truncatedBody = parsed.body.slice(0, LLM_INPUT_CHAR_BUDGET);
  return `You are analyzing a skill definition to infer when it should be triggered.

Skill ID: ${parsed.skillId}
Description: ${parsed.description}

Skill Content:
${truncatedBody}

Your task: Infer the trigger condition (initiationSet only) for this skill.

Return ONLY a JSON object (no prose, no markdown fences):
{"initiationSet": "..."}

Where:
- "initiationSet": A concise phrase describing when this skill should be triggered/invoked (e.g. "用户需要设计复杂系统架构时", "When analyzing performance bottlenecks", "During code refactoring")

Rules:
- 10-80 characters, concise and actionable
- Focus on the user's intent or scenario
- Use the same language as the skill content (Chinese for Chinese skills, English for English skills)
- If the content is too short to infer, use generic sensible defaults

JSON output:`;
}

/**
 * 解析 LLM 响应为 initiationSet（S6.x:termination 已移除）
 *
 * 复用 engram_synthesize 的 parseSynthesisOutput 模式：trim → 剥 fence → 抽 {...} → JSON.parse → 校验。
 *
 * 失败抛错（由调用方降级到规则版）。
 */
function parseSkillTriggerResponse(raw: string): {
  readonly initiationSet: string;
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

  return { initiationSet };
}
