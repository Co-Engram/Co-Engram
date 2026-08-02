/**
 * Skill sidecar 存储（spec §3.2 fallback）
 * - 可写 → <dataRoot>/<sourcePath>/.co-engram/imprint.json
 * - 只读/非法 → <dataRoot>/skill-imprints/<hash(skillId)>.json
 * 绝不读写 sourcePath 下的 SKILL.md。
 * @module @co-engram/core/skill
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { safeJoinWithinRoot } from "../storage/path.js";
import { internalError } from "../tools/error-schema.js";
import type { SkillImprint } from "../types/skill.js";

export const SIDECAR_DIR = ".co-engram";
export const SIDECAR_FILE = "imprint.json";
export const FALLBACK_DIR = "skill-imprints";

/**
 * 扫描时跳过的目录。
 * 注意：.co-engram 不在此列——它通过 SIDECAR_DIR 特判处理
 * （sidecar 就在 <sourcePath>/.co-engram/imprint.json，若放进 SKIP_DIRS 会漏扫）。
 */
const SKIP_DIRS = new Set([".git", "node_modules", FALLBACK_DIR, "synapses", ".trash", "intentions", "config"]);

export function sidecarPath(dataRoot: string, sourcePath: string): string {
  return join(safeJoinWithinRoot(dataRoot, sourcePath), SIDECAR_DIR, SIDECAR_FILE);
}
export function fallbackPath(dataRoot: string, skillId: string): string {
  return join(dataRoot, FALLBACK_DIR, `${computeImprintHash(skillId, "")}.json`);
}
export function computeImprintHash(skillId: string, sourcePath: string): string {
  return createHash("sha256").update(`${skillId}|${sourcePath}`).digest("hex").slice(0, 16);
}

function tryWriteSidecar(dataRoot: string, imprint: SkillImprint): boolean {
  try {
    // bugfix: sidecarPath 内的 safeJoinWithinRoot 对非法 sourcePath 会抛 internalError，
    // 必须包在 try 内才能正确降级到 fallback（plan 原版在 try 外，会崩溃）
    const abs = sidecarPath(dataRoot, imprint.sourcePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(imprint, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function writeImprint(dataRoot: string, imprint: SkillImprint): void {
  if (tryWriteSidecar(dataRoot, imprint)) return;
  const fb = fallbackPath(dataRoot, imprint.skillId);
  try {
    mkdirSync(dirname(fb), { recursive: true });
    writeFileSync(fb, JSON.stringify(imprint, null, 2) + "\n", "utf8");
  } catch (e) {
    // fail-loud：sidecar 与 fallback 都失败 = 系统真的写不了，必须让调用方知情
    // wrap 成 internalError 带上下文（skillId），比裸 fs ENOSPC/EACCES 更可诊断
    throw internalError(
      `Failed to persist skill imprint (sidecar & fallback both unwritable): skillId=${imprint.skillId}`,
      e,
    );
  }
}

export function readImprint(dataRoot: string, skillId: string, sourcePath: string): SkillImprint | null {
  try {
    const sc = sidecarPath(dataRoot, sourcePath);
    if (existsSync(sc)) return parseImprint(readFileSync(sc, "utf8"));
  } catch {
    // sourcePath 非法或不存在 → 走 fallback
  }
  const fb = fallbackPath(dataRoot, skillId);
  if (existsSync(fb)) return parseImprint(readFileSync(fb, "utf8"));
  return null;
}

function parseImprint(raw: string): SkillImprint | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.schemaVersion === 1) {
      // S6.x: 旧 imprint 含已移除的 termination/policy 字段；destructure 剥离避免回写污染新数据
      // 向后兼容：旧 imprint（无 composes/relatedEngrams 字段）读取时默认 []
      const { termination: _termination, policy: _policy, ...rest } = obj;
      const typed = rest as SkillImprint & { composes?: unknown; relatedEngrams?: unknown };
      return {
        ...typed,
        composes: Array.isArray(typed.composes) ? typed.composes : [],
        relatedEngrams: Array.isArray(typed.relatedEngrams) ? typed.relatedEngrams : [],
      } as SkillImprint;
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteImprint(dataRoot: string, skillId: string, sourcePath: string): void {
  try {
    const sc = sidecarPath(dataRoot, sourcePath);
    if (existsSync(sc)) unlinkSync(sc);
  } catch {
    // ignore
  }
  const fb = fallbackPath(dataRoot, skillId);
  if (existsSync(fb)) {
    try { unlinkSync(fb); } catch { /* ignore */ }
  }
}

/** 扫描 dataRoot 下所有 sidecar + fallback 印迹（sidecar 为真理源，覆盖同名 fallback） */
export function scanAllImprints(dataRoot: string): SkillImprint[] {
  const out = new Map<string, SkillImprint>();
  // 1. 兜底目录
  const fbDir = join(dataRoot, FALLBACK_DIR);
  if (existsSync(fbDir)) {
    for (const f of readdirSync(fbDir)) {
      if (!f.endsWith(".json")) continue;
      const imp = parseImprint(readFileSync(join(fbDir, f), "utf8"));
      if (imp) out.set(imp.skillId, imp);
    }
  }
  // 2. sidecar（后处理，覆盖兜底——sidecar 为真理源）
  for (const sc of collectSidecars(dataRoot)) {
    const imp = parseImprint(readFileSync(sc, "utf8"));
    if (imp) out.set(imp.skillId, imp);
  }
  return [...out.values()];
}

/**
 * bugfix: plan 原版把 ".co-engram" 放进 SKIP_DIRS，导致递归时跳过所有 sidecar 目录、漏扫。
 * 修正：遇 SIDECAR_DIR 特判（取其中 imprint.json，不递归子目录），不靠 SKIP_DIRS 排除。
 */
function collectSidecars(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name as string;
    if (name === SIDECAR_DIR) {
      const file = join(dir, name, SIDECAR_FILE);
      if (existsSync(file)) out.push(file);
      continue;
    }
    if (SKIP_DIRS.has(name)) continue;
    out.push(...collectSidecars(join(dir, name)));
  }
  return out;
}
