/**
 * Engram Index — 派生缓存 {stableId → path/title/mtime/...}
 *
 * 设计见 docs/superpowers/specs/2026-06-22-per-edge-synapse-refactor-design.md。
 *
 * 文件位置:`.co-engram/engram-index.json`(gitignore)
 * 用途:
 *   - doctor 增量扫描(mtime 比对)
 *   - repository 快速查 stableId → path
 *   - graph 派生
 *   - viewer 渲染
 *
 * @module @co-engram/core/storage
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Dirent } from "node:fs";

import type {
  StableEngramId,
  EngramIndexEntry,
  EngramIndex as EngramIndexData,
} from "../types/repository-types.js";
import { isStableEngramId } from "../types/repository-types.js";
import { slugify, inferDomainTagsFromPath } from "../types/slugify.js";
import {
  isEngramFile,
  hasFrontmatterMarker,
  parseEngramFile,
  type EngramFrontmatter,
} from "./engram-store.js";

/** .co-engram/ 顶层缓存目录名 */
export const CO_ENGRAM_CACHE_DIR = ".co-engram";

/** engram-index.json 文件名 */
export const ENGRAM_INDEX_FILENAME = "engram-index.json";

/** 应被 index 扫描跳过的目录 */
const SKIP_DIRECTORIES = new Set([
  CO_ENGRAM_CACHE_DIR,
  "node_modules",
  ".git",
  "synapses", // synapse 数据,不是 engram
  "engrams", // 旧版三文件数据布局(content/meta/synapses),不扫
]);

/**
 * 应被 index 扫描跳过的 markdown 文件名(大小写不敏感)。
 * 这些是仓库级文档,不是 engram —— 例如 README 是 quickstart 教用户创建的文件。
 * doctor 不会把它们报为 orphan_markdown。
 */
const SKIP_MARKDOWN_FILENAMES = new Set([
  "readme.md",
  "license.md",
  "contributing.md",
  "changelog.md",
  "code_of_conduct.md",
  "security.md",
]);

/** engram-index.json 完整路径 */
export function engramIndexPath(dataRoot: string): string {
  return join(dataRoot, CO_ENGRAM_CACHE_DIR, ENGRAM_INDEX_FILENAME);
}

/** 内存中的 index 结构(用 Map 加速查询) */
export interface EngramIndexMap {
  readonly version: 1;
  readonly entries: Map<StableEngramId, EngramIndexEntry>;
  lastRebuiltAt: string;
}

/** 创建空 index */
export function createEmptyEngramIndex(): EngramIndexMap {
  return {
    version: 1,
    entries: new Map(),
    lastRebuiltAt: new Date().toISOString(),
  };
}

/**
 * 从磁盘读取 index;不存在或损坏返回空 index。
 */
export function readEngramIndex(dataRoot: string): EngramIndexMap {
  const path = engramIndexPath(dataRoot);
  if (!existsSync(path)) return createEmptyEngramIndex();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as EngramIndexData & {
      engrams: Record<string, EngramIndexEntry>;
    };
    const entries = new Map<StableEngramId, EngramIndexEntry>();
    if (parsed.engrams && typeof parsed.engrams === "object") {
      for (const [key, value] of Object.entries(parsed.engrams)) {
        if (isStableEngramId(key) && value) {
          entries.set(key as StableEngramId, value);
        }
      }
    }
    return {
      version: 1,
      entries,
      lastRebuiltAt: parsed.lastRebuiltAt ?? new Date().toISOString(),
    };
  } catch {
    return createEmptyEngramIndex();
  }
}

/**
 * 落盘 index(gitignore,但结构稳定以便人类 debug)。
 */
export function writeEngramIndex(
  dataRoot: string,
  index: EngramIndexMap,
): void {
  const path = engramIndexPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const engramsObj: Record<string, EngramIndexEntry> = {};
  for (const [key, value] of index.entries) {
    engramsObj[key] = value;
  }
  const data: EngramIndexData = {
    version: 1,
    engrams: engramsObj,
    lastRebuiltAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 从单条 engram 文件构建 index entry。
 *
 * - slug:frontmatter 显式则锁定,否则从 title slugify
 * - domainTags:frontmatter 显式则锁定,否则从路径推断
 * - mtime / contentHash 必须由调用者传入
 */
export function buildIndexEntryFromFrontmatter(params: {
  readonly relativePath: string;
  readonly frontmatter: EngramFrontmatter;
  readonly mtime: number;
  readonly contentHash: string;
}): EngramIndexEntry {
  const { relativePath, frontmatter, mtime, contentHash } = params;

  const hasExplicitSlug =
    typeof frontmatter.slug === "string" && frontmatter.slug.length > 0;
  const slug = hasExplicitSlug ? frontmatter.slug! : slugify(frontmatter.title);

  const hasExplicitDomainTags =
    Array.isArray(frontmatter.domainTags) && frontmatter.domainTags.length > 0;
  const domainTags = hasExplicitDomainTags
    ? [...frontmatter.domainTags!]
    : inferDomainTagsFromPath(relativePath);

  return {
    id: frontmatter.id,
    path: relativePath,
    title: frontmatter.title,
    slug,
    slugLocked: hasExplicitSlug,
    domainTags,
    domainTagsLocked: hasExplicitDomainTags,
    tags: Array.isArray(frontmatter.tags) ? [...frontmatter.tags] : [],
    kind: frontmatter.kind,
    verificationStatus: frontmatter.verificationStatus,
    status: frontmatter.status ?? "active",
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
    mtime,
    contentHash,
  };
}

/**
 * 扫描 dataRoot 下所有 .md,构建 engram-index。
 *
 * 规则:
 * - 跳过 SKIP_DIRECTORIES 中的目录(.co-engram, node_modules, .git, synapses)
 * - 无 frontmatter 的 .md 跳过(由 doctor 报告为 orphan_markdown)
 * - frontmatter 缺 id 的 .md 跳过(由 doctor 报告为 orphan_markdown)
 */
export function rebuildEngramIndex(
  dataRoot: string,
  onOrphan?: (relativePath: string) => void,
  onInvalidFrontmatter?: (relativePath: string, errorMessage: string) => void,
  onDuplicate?: (
    id: string,
    existingPath: string,
    duplicatePath: string,
  ) => void,
): EngramIndexMap {
  const index = createEmptyEngramIndex();

  function walk(currentDir: string, relativeDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(currentDir, entry.name);
      const relativePath =
        relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (SKIP_MARKDOWN_FILENAMES.has(entry.name.toLowerCase())) continue;

      let raw: string;
      try {
        raw = readFileSync(absolutePath, "utf8");
      } catch {
        continue;
      }

      try {
        if (!isEngramFile(raw)) {
          // 分流:有 marker 但 parse 失败或 critical 校验问题 → invalid_frontmatter;
          // 无 marker → orphan(行为不变)。
          if (hasFrontmatterMarker(raw)) {
            onInvalidFrontmatter?.(
              relativePath,
              "engram file has frontmatter marker but isEngramFile returned false (parse failed or critical validation issue)",
            );
          } else {
            onOrphan?.(relativePath);
          }
          continue;
        }
        const parsed = parseEngramFile(raw);
        const stat = statSync(absolutePath);
        const entryRecord = buildIndexEntryFromFrontmatter({
          relativePath,
          frontmatter: parsed.frontmatter,
          mtime: stat.mtimeMs,
          contentHash: parsed.frontmatter.contentHash ?? "",
        });
        const existingEntry = index.entries.get(entryRecord.id);
        if (existingEntry) {
          // duplicate_id:同 id 多文件(用户复制记忆到多目录 / 手动 cp 带 id)。
          // 报 issue 让 doctor/用户处理(删哪个用户决定);index 仍 set(保留最后扫到的)。
          onDuplicate?.(entryRecord.id, existingEntry.path, relativePath);
        }
        index.entries.set(entryRecord.id, entryRecord);
      } catch (err) {
        // parseEngramFile/stat 抛错(YAML 结构错等):有 marker 走 invalid,无 marker 走 orphan
        const msg = err instanceof Error ? err.message : String(err);
        if (hasFrontmatterMarker(raw)) {
          onInvalidFrontmatter?.(relativePath, msg);
        } else {
          onOrphan?.(relativePath);
        }
      }
    }
  }

  walk(dataRoot, "");
  index.lastRebuiltAt = new Date().toISOString();
  return index;
}

/**
 * 收集 dataRoot 下所有 .md 文件(跳过 SKIP_DIRECTORIES 与 SKIP_MARKDOWN_FILENAMES)。
 *
 * 与 rebuildEngramIndex 共用同一份"哪些目录/文件不扫"规则,确保 watcher 的
 * 外部提案扫描与索引重建看到一致的文件集合。
 *
 * @returns 绝对路径数组(无特定顺序)
 */
export function collectMarkdownFiles(dataRoot: string): string[] {
  const out: string[] = [];
  function walk(currentDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (SKIP_MARKDOWN_FILENAMES.has(entry.name.toLowerCase())) continue;
      out.push(absolutePath);
    }
  }
  walk(dataRoot);
  return out;
}

/**
 * 增量更新:仅更新单条 engram 的 index entry。
 */
export function upsertEngramIndexEntry(
  index: EngramIndexMap,
  entry: EngramIndexEntry,
): EngramIndexMap {
  index.entries.set(entry.id, entry);
  return index;
}

/**
 * 从 index 中删除一条 engram。
 */
export function removeEngramIndexEntry(
  index: EngramIndexMap,
  id: StableEngramId,
): boolean {
  return index.entries.delete(id);
}

/**
 * 按 path 查 stableId(用于 doctor 检测文件移动)。
 */
export function findEngramIdByPath(
  index: EngramIndexMap,
  relativePath: string,
): StableEngramId | undefined {
  for (const entry of index.entries.values()) {
    if (entry.path === relativePath) return entry.id;
  }
  return undefined;
}
