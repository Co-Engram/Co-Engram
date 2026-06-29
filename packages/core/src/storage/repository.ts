/**
 * EngramRepository — per-edge synapse + 人类友好存储
 *
 * 设计要点:
 * - EngramId 是 ULID(stable,与路径解耦)
 * - Engram 单文件存储(frontmatter + content)
 * - Synapse per-edge 存储(synapses/{kind}/syn-{hash}.yaml)
 * - readSynapses 返回双向 { outgoing, incoming }
 * - deleteEngram 自动级联删除触及的 synapse
 * - 内置 doctor 自愈扫描
 * - 内置 path-tree(渐进式披露)
 *
 * @module @co-engram/core/storage
 */

import {
  existsSync,
  statSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { dirname, join, relative, sep } from "node:path";
import { ulid } from "ulid";

import type {
  Engram,
  EngramCatalogEntry,
  EngramCreateInput,
  EngramDigest,
  EngramFreshness,
  EngramKind,
  EngramSourceType,
  EngramStatus,
  EngramUpdateInput,
  EmotionalValence,
  EngramVisibility,
  ImportanceVector,
  VerificationStatus,
  Synapse,
  SynapseCreateInput,
  SynapseEvidence,
  SynapseKind,
  SynapseResolutionState,
  SynapseUpdateInput,
} from "../types/index.js";
import type {
  StableEngramId,
  EngramIndexEntry,
  DoctorReport,
  DoctorIssue,
  PathTreeNode,
} from "../types/repository-types.js";
import { isStableEngramId } from "../types/repository-types.js";
import { slugify, inferDomainTagsFromPath } from "../types/slugify.js";
import { computeSynapseId } from "../types/synapse-id.js";
import {
  safeJoinWithinRoot,
  isPathWithinRoot,
} from "./path.js";

import { computeContentHash, computeContentSize } from "./hash.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/index.js";
import {
  type EngramFrontmatter,
  type EngramFile,
  readEngramFile,
  writeEngramFile,
  deleteEngramFile,
  renameEngramFile,
  parseEngramFile,
  isEngramFile,
  detectEngramFileLanguage,
} from "./engram-store.js";
import {
  SYNAPSES_DIR,
  collectAllSynapses,
  upsertSynapse,
  readSynapseByEndpoints,
  readSynapseById,
  listSynapsesForEngram,
  deleteSynapsesTouching,
  synapseRelativePath,
  deleteSynapseFile,
  writeSynapseFile,
  parseSynapseFile,
} from "./synapse-store.js";
import {
  CO_ENGRAM_CACHE_DIR,
  ENGRAM_INDEX_FILENAME,
  buildIndexEntryFromFrontmatter,
  createEmptyEngramIndex,
  engramIndexPath,
  findEngramIdByPath,
  readEngramIndex,
  rebuildEngramIndex,
  removeEngramIndexEntry,
  upsertEngramIndexEntry,
  writeEngramIndex,
  type EngramIndexMap,
} from "./engram-index.js";
import {
  regenerateObsidianLinks,
  checkObsidianView,
} from "./obsidian-links.js";

/** Repository 配置 */
export interface RepositoryConfig {
  /** 仓库根目录(~/team-memory/) */
  readonly rootPath: string;
  /**
   * 写入磁盘时使用的语言格式
   *
   * - `'zh'`(默认):正文在上 + 底部 frontmatter + 中文字段名 + `__语言: zh` 标记
   * - `'en'`:legacy 顶部 frontmatter + 英文字段名
   *
   * 读取时自动检测兼容两种格式,因此旧文件无需迁移即可读。
   * 由 host adapter(MCP / OpenClaw)从 `.co-engram/config.json` 注入。
   */
  readonly language?: Language;
}

const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIDENCE_BY_SOURCE: Record<EngramSourceType, number> = {
  firsthand: 0.85,
  secondhand: 0.65,
  inferred: 0.5,
};
const DEFAULT_DECAY_HALF_LIFE_DAYS = 90;

function now(): string {
  return new Date().toISOString();
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 用户未显式提供 summary 时,从 content 派生一个简短摘要。
 *
 * 历史问题:之前默认 `summary = title`,导致 FTS 把 title 索引两次,完全无法
 * 命中 content 里的关键词。用户搜 content 里明明存在的词都搜不到。
 *
 * 派生策略:
 *   - 无 content 或纯空白 → 回退 title(避免空 summary)
 *   - content 走单行化 + trim,前 200 字符;超出加省略号
 *   - 不改变用户显式提供的 summary(那一路在调用方用 ?? 短路)
 */
function deriveAutoSummary(content: string | undefined, title: string): string {
  if (!content) return title;
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return title;
  if (cleaned.length <= 200) return cleaned;
  return cleaned.slice(0, 197) + "...";
}

/**
 * EngramRepository — per-edge synapse + ULID stable id + 单文件 engram
 *
 * 所有读取方法接受 stable id (ULID)。从 path 读 engram 用 readEngramByPath。
 */
export class EngramRepository {
  private indexCache: EngramIndexMap | undefined;
  /**
   * 当前 indexCache 对应的 engram-index.json 磁盘 mtime。
   * 用于跨进程缓存一致性校验:其他进程写入会使磁盘 mtime 改变,
   * 本进程 getIndex 检测到不一致时失效缓存并重读。
   */
  private indexCacheMtime: number | undefined;

  /**
   * Invalidate listeners — 在 indexCache 失效(watcher 触发或 mtime 不一致)时被调用。
   *
   * 主要用途:让 SearchOrchestrator 等依赖 index 派生数据的组件同步失效并重建。
   * 跨进程场景:plugin 进程写 index → mcp 进程的 fs.watch 触发 → listener 重建 ftsIndex。
   */
  private readonly invalidateListeners: Array<() => void> = [];

  /**
   * fs.watch 句柄(可选)。启动后,外部进程修改 engram-index.json
   * 会立即触发缓存失效,无需等下次 getIndex 的 mtime 兜底检查。
   */
  private indexWatcher: FSWatcher | undefined;
  private readonly language: Language;

  constructor(private readonly config: RepositoryConfig) {
    this.language = config.language ?? DEFAULT_LANGUAGE;
  }

  /** 当前写入语言(读取时自动兼容任意语言格式) */
  get currentLanguage(): Language {
    return this.language;
  }

  get rootPath(): string {
    return this.config.rootPath;
  }

  // ─── Index 管理 ────────────────────────────────────────────────────────

  /**
   * 获取 index(惰性加载 + 跨进程一致性校验)
   *
   * 双保险策略:
   *   1. mtime 校验(主路径):每次调用 stat engram-index.json,
   *      若磁盘 mtime 与 indexCacheMtime 不一致 → 缓存失效,重读。
   *   2. fs.watch(可选实时):若已 startWatching,外部进程写入会
   *      主动触发 invalidate,无需等下次调用。
   *
   * mtime 校验是兜底,即使 watcher 漏事件(NFS / Docker / WSL)也能保证最终一致。
   */
  private getIndex(): EngramIndexMap {
    const indexPath = engramIndexPath(this.config.rootPath);
    let diskMtime: number | undefined;
    try {
      diskMtime = statSync(indexPath).mtimeMs;
    } catch {
      // engram-index.json 不存在或不可读 — 下方处理
    }

    // 缓存新鲜(mtime 一致)
    if (
      this.indexCache !== undefined &&
      diskMtime !== undefined &&
      this.indexCacheMtime === diskMtime
    ) {
      return this.indexCache;
    }

    if (diskMtime !== undefined) {
      // 磁盘有 index.json → 读取(快,无需扫全树)
      const fresh = readEngramIndex(this.config.rootPath);
      this.indexCache = fresh;
      this.indexCacheMtime = diskMtime;
      return fresh;
    }

    // 磁盘无 index.json → 全量 rebuild + 写盘(rebuildIndex 会同步更新 mtime)
    return this.rebuildIndex();
  }

  /** 全量重建 index(并写盘) */
  rebuildIndex(): EngramIndexMap {
    const index = rebuildEngramIndex(this.config.rootPath);
    this.persistIndex(index);
    return index;
  }

  /**
   * 写入 index 到磁盘并同步更新 indexCacheMtime。
   *
   * 集中所有"写盘 + 更新 mtime"逻辑,确保自进程写入不会被下次 getIndex
   * 误判为外部修改而重读(浪费但不出错)。
   *
   * 若 startWatching 之前因 engram-index.json 不存在而降级,本次写盘后
   * 文件已存在,这里 lazy 重试启动 watcher(覆盖首次空 dataRoot 场景)。
   */
  private persistIndex(index: EngramIndexMap): void {
    writeEngramIndex(this.config.rootPath, index);
    this.indexCache = index;
    try {
      this.indexCacheMtime = statSync(
        engramIndexPath(this.config.rootPath),
      ).mtimeMs;
    } catch {
      this.indexCacheMtime = Date.now();
    }
    // 文件刚被创建/重写 — 若 watcher 因之前文件不存在而降级,现在 lazy 重试
    if (!this.indexWatcher) {
      this.startWatching();
    }
  }

  /** 增量更新单条 entry 并写盘 */
  private updateIndexEntry(entry: EngramIndexEntry): void {
    const index = this.getIndex();
    upsertEngramIndexEntry(index, entry);
    this.persistIndex(index);
  }

  /** 从 index 删除一条并写盘 */
  private deleteIndexEntry(id: StableEngramId): void {
    const index = this.getIndex();
    removeEngramIndexEntry(index, id);
    this.persistIndex(index);
  }

  // ─── Cross-process watcher ─────────────────────────────────────────────

  /**
   * 启动对 engram-index.json 的 fs.watch 监听。
   *
   * 启动后,外部进程修改 index(创建/更新/删除 engram)会触发 watcher,
   * 主动失效 indexCache。下次 getIndex 调用时从磁盘重读。
   *
   * 幂等:多次调用安全,只创建一个 watcher。
   *
   * 适用场景:多个 host adapter(MCP server / OpenClaw plugin)共享同一
   * dataRoot 时,确保各进程的缓存相互一致。
   *
   * 不需要显式停止 — 进程退出时 OS 自动回收 fd。stopWatching() 仅用于
   * 测试 / 显式资源管理场景。
   */
  startWatching(): void {
    if (this.indexWatcher) return;
    const indexPath = engramIndexPath(this.config.rootPath);
    try {
      // fs.watch 的 eventType 跨平台语义不稳定(Linux inotify / macOS FSEvents /
      // Windows ReadDirectoryChangesW 触发类型不同,且可能多次回调)。策略是
      // 收到任意事件即 invalidate,由 getIndex 的 mtime 兜底过滤假阳性。
      this.indexWatcher = watch(indexPath, { persistent: false }, () => {
        this.invalidateIndexCache();
      });
      // watcher 出错(NFS / 文件被删 / 平台不支持)→ 静默降级到 mtime 兜底
      this.indexWatcher.on("error", () => {
        this.indexWatcher = undefined;
      });
    } catch {
      // 平台不支持 fs.watch 或文件尚不存在 → 降级到 mtime 兜底(getIndex 中已实现)。
      // persistIndex 写盘后会 lazy 重试 startWatching,覆盖首次空 dataRoot 场景。
      this.indexWatcher = undefined;
    }
  }

  /** 停止 watcher(主要用于测试隔离) */
  stopWatching(): void {
    if (this.indexWatcher) {
      try {
        this.indexWatcher.close();
      } catch {
        // ignore
      }
      this.indexWatcher = undefined;
    }
  }

  /** 失效缓存 — 下次 getIndex 从磁盘重读。同时通知 invalidate listeners。 */
  private invalidateIndexCache(): void {
    this.indexCache = undefined;
    this.indexCacheMtime = undefined;
    // 通知外部依赖(SearchOrchestrator 等)派生数据需要重建
    for (const cb of this.invalidateListeners) {
      try {
        cb();
      } catch {
        // listener 内部异常不影响 repository 主流程
      }
    }
  }

  /**
   * 注册 invalidate listener — 在 indexCache 失效时被调用。
   *
   * 主要用途:让 SearchOrchestrator 等派生数据同步失效并重建。
   * 跨进程:plugin 进程写 index → mcp 进程 fs.watch 触发 → listener 重建 ftsIndex。
   *
   * @returns 取消注册函数(用于测试隔离或资源释放)
   */
  addInvalidateListener(cb: () => void): () => void {
    this.invalidateListeners.push(cb);
    return () => {
      const idx = this.invalidateListeners.indexOf(cb);
      if (idx >= 0) this.invalidateListeners.splice(idx, 1);
    };
  }

  /** 解析 stableId → 相对路径 */
  private resolvePath(stableId: string): string | undefined {
    if (!isStableEngramId(stableId)) {
      // 兼容:可能是相对路径,直接当 path 用。
      // 但必须先校验路径在 root 内(Finding 156/157 P0:防 `..` 逃逸)
      if (!isPathWithinRoot(this.config.rootPath, stableId)) return undefined;
      if (this.existsAtPath(stableId)) return stableId;
      return undefined;
    }
    const entry = this.getIndex().entries.get(stableId as StableEngramId);
    // 防御:索引中的 path 也校验(理论上是 trusted,但 doctor 自愈后可能含异常)
    if (entry?.path && !isPathWithinRoot(this.config.rootPath, entry.path)) {
      return undefined;
    }
    return entry?.path;
  }

  /** 检查相对路径是否存在 engram 文件 */
  private existsAtPath(relativePath: string): boolean {
    if (!isPathWithinRoot(this.config.rootPath, relativePath)) return false;
    return existsSync(safeJoinWithinRoot(this.config.rootPath, relativePath));
  }

  // ─── Engram CRUD ───────────────────────────────────────────────────────

  /**
   * 创建 Engram(单文件 + ULID)
   *
   * 文件位置:
   * - 若 input 提供 `pathHint`:用之(允许人类组织目录)
   * - 否则:从 domainTags + title slug 推导默认路径
   *
   * @throws 文件已存在 / title 为空
   */
  createEngram(input: EngramCreateInput & { pathHint?: string }): Engram {
    const stableId = ulid() as StableEngramId;
    const timestamp = now();
    const sourceType = input.sourceType ?? "firsthand";
    const contentHash = computeContentHash(input.content);
    const contentSize = computeContentSize(input.content);

    // pathHint 优先;否则用 deriveDefaultPath(slugify title + raw domainTags + .md)
    // safeJoinWithinRoot 拦截 `..` 逃逸与绝对路径(Finding 156/157 P0)
    const relativePath = input.pathHint ?? this.deriveDefaultPath(input);
    const absolutePath = safeJoinWithinRoot(this.config.rootPath, relativePath);

    if (existsSync(absolutePath)) {
      throw new Error(`Engram already exists at ${relativePath}`);
    }

    const hasExplicitDomainTags = input.domainTags.length > 0;
    const frontmatter: EngramFrontmatter = {
      id: stableId,
      title: input.title,
      kind: input.kind,
      kinds: input.kinds ?? [input.kind],
      tags: input.contextTags,
      domainTags: hasExplicitDomainTags ? input.domainTags : undefined,
      summary: input.summary ?? deriveAutoSummary(input.content, input.title),
      contentHash,
      contentSize,
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedBy: input.createdBy,
      updatedAt: timestamp,
      version: 1,
      importance: input.importance ?? DEFAULT_IMPORTANCE,
      confidence: input.confidence ?? DEFAULT_CONFIDENCE_BY_SOURCE[sourceType],
      emotionalValence: input.emotionalValence ?? "neutral",
      sourceType,
      evidenceCount: 0,
      retrievalCount: 0,
      effectiveRetrievals: 0,
      failedUses: 0,
      reinforcementScore: 0,
      lastRetrievalScore: 0.5,
      decayHalfLifeDays:
        input.decayHalfLifeDays === undefined
          ? DEFAULT_DECAY_HALF_LIFE_DAYS
          : input.decayHalfLifeDays,
      status: "active",
      visibility: input.visibility ?? "public",
      verificationStatus: "unverified",
      encodingContext: input.encodingContext,
      perspective: input.perspective,
      contextTags: input.contextTags,
    };

    const file: EngramFile = {
      frontmatter,
      content: input.content,
    };
    writeEngramFile(absolutePath, file, this.language);

    const stat = statSync(absolutePath);
    const entry = buildIndexEntryFromFrontmatter({
      relativePath,
      frontmatter,
      mtime: stat.mtimeMs,
      contentHash,
    });
    this.updateIndexEntry(entry);

    return this.readEngram(stableId);
  }

  /** 默认路径:{domainTags.join('/')/}{slug}.md */
  private deriveDefaultPath(input: EngramCreateInput): string {
    const slug = slugify(input.title);
    const domains = input.domainTags.length > 0 ? input.domainTags : [];
    const parts = [...domains, `${slug}.md`];
    return parts.join("/");
  }

  /**
   * 读取完整 Engram(单文件 + 统计)
   */
  readEngram(stableId: string): Engram {
    const relativePath = this.resolvePath(stableId);
    if (!relativePath) {
      throw new Error(`Engram not found: ${stableId}`);
    }
    // resolvePath 已校验路径在 root 内,这里再防御一次
    const absolutePath = safeJoinWithinRoot(this.config.rootPath, relativePath);
    const file = readEngramFile(absolutePath);
    return this.assembleEngram(file, relativePath);
  }

  /**
   * 检查 Engram 是否存在(按 stableId 或 path)
   */
  exists(stableId: string): boolean {
    const relativePath = this.resolvePath(stableId);
    return (
      relativePath !== undefined &&
      isPathWithinRoot(this.config.rootPath, relativePath) &&
      existsSync(safeJoinWithinRoot(this.config.rootPath, relativePath))
    );
  }

  /**
   * 更新 Engram(content/frontmatter 双写)
   *
   * - 自动 version++
   * - title 变更时若 slug 未锁定,重新 slugify + rename 文件
   * - domainTags 显式锁定时不重新推断
   */
  updateEngram(stableId: string, input: EngramUpdateInput): Engram {
    const relativePath = this.resolvePath(stableId);
    if (!relativePath) {
      throw new Error(`Engram not found: ${stableId}`);
    }
    const absolutePath = join(this.config.rootPath, relativePath);
    const oldFile = readEngramFile(absolutePath);
    const oldFrontmatter = oldFile.frontmatter;
    const timestamp = now();

    const newTitle = input.title ?? oldFrontmatter.title;
    const newContent = input.content ?? oldFile.content;
    const newSummary =
      input.summary ??
      oldFrontmatter.summary ??
      deriveAutoSummary(newContent, newTitle);
    const newContentHash = input.content
      ? computeContentHash(newContent)
      : (oldFrontmatter.contentHash ?? computeContentHash(newContent));
    const newContentSize = input.content
      ? computeContentSize(newContent)
      : (oldFrontmatter.contentSize ?? computeContentSize(newContent));
    const newKinds = input.kinds ??
      oldFrontmatter.kinds ?? [oldFrontmatter.kind];
    const newKind = newKinds[0] ?? oldFrontmatter.kind;

    // domainTags:显式输入优先,否则保留 frontmatter(锁定 / undefined)
    const hasExplicitInputDomainTags = input.domainTags !== undefined;
    const newDomainTags = hasExplicitInputDomainTags
      ? input.domainTags
      : oldFrontmatter.domainTags;

    const newContextTags = input.contextTags ?? oldFrontmatter.contextTags;
    const newEncodingContext =
      input.encodingContext ?? oldFrontmatter.encodingContext;
    const newEmotionalValence =
      input.emotionalValence ?? oldFrontmatter.emotionalValence ?? "neutral";
    const newImportance =
      input.importance ?? oldFrontmatter.importance ?? DEFAULT_IMPORTANCE;
    const newConfidence =
      input.confidence ??
      oldFrontmatter.confidence ??
      DEFAULT_CONFIDENCE_BY_SOURCE.firsthand;
    const newDecayHalfLife =
      input.decayHalfLifeDays === undefined
        ? (oldFrontmatter.decayHalfLifeDays ?? DEFAULT_DECAY_HALF_LIFE_DAYS)
        : input.decayHalfLifeDays;
    const newVisibility =
      input.visibility ?? oldFrontmatter.visibility ?? "public";
    const newImportanceVector =
      input.importanceVector === undefined
        ? (oldFrontmatter as { importanceVector?: ImportanceVector })
            .importanceVector
        : input.importanceVector;
    const newPerspective =
      input.perspective === undefined
        ? oldFrontmatter.perspective
        : input.perspective;

    const newFrontmatter: EngramFrontmatter = {
      ...oldFrontmatter,
      title: newTitle,
      kind: newKind,
      kinds: newKinds,
      tags: oldFrontmatter.tags,
      domainTags: newDomainTags,
      summary: newSummary,
      contentHash: newContentHash,
      contentSize: newContentSize,
      updatedBy: input.updatedBy,
      updatedAt: timestamp,
      version: (oldFrontmatter.version ?? 1) + 1,
      importance: newImportance,
      confidence: newConfidence,
      emotionalValence: newEmotionalValence,
      decayHalfLifeDays: newDecayHalfLife,
      visibility: newVisibility,
      encodingContext: newEncodingContext,
      perspective: newPerspective,
      contextTags: newContextTags,
      importanceVector: newImportanceVector,
    };

    // 处理 slug 变化:title 变 + slug 未锁定 → 重新 slugify + rename
    const oldSlug = oldFrontmatter.slug ?? slugify(oldFrontmatter.title);
    const newSlugUnlocked =
      oldFrontmatter.slug === undefined
        ? slugify(newTitle)
        : oldFrontmatter.slug;
    const newPath =
      newSlugUnlocked !== oldSlug
        ? this.rebuildPath(relativePath, newSlugUnlocked)
        : relativePath;

    const newFile: EngramFile = {
      frontmatter: newFrontmatter,
      content: newContent,
    };

    if (newPath !== relativePath) {
      const newAbsolutePath = join(this.config.rootPath, newPath);
      if (existsSync(newAbsolutePath)) {
        throw new Error(`Slug rename conflict: ${newPath} already exists`);
      }
      writeEngramFile(newAbsolutePath, newFile, this.language);
      rmSync(absolutePath);
    } else {
      writeEngramFile(absolutePath, newFile, this.language);
    }

    const stat = statSync(join(this.config.rootPath, newPath));
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: newPath,
      frontmatter: newFrontmatter,
      mtime: stat.mtimeMs,
      contentHash: newContentHash ?? "",
    });
    this.updateIndexEntry(entry);

    return this.readEngram(stableId);
  }

  /** 重新组装路径:替换 basename 为 newSlug */
  private rebuildPath(oldRelativePath: string, newSlug: string): string {
    const parts = oldRelativePath.split("/");
    parts[parts.length - 1] = `${newSlug}.md`;
    return parts.join("/");
  }

  /**
   * 删除 Engram + 级联删除触及的 synapses + 清理 index
   *
   * 走 `this.deleteSynapsesTouching` 方法版而非模块函数,以触发
   * 邻居派生段( Obsidian wikilinks)的 cascade refresh。
   */
  deleteEngram(stableId: string): void {
    const relativePath = this.resolvePath(stableId);
    if (!relativePath) return;
    const absolutePath = join(this.config.rootPath, relativePath);
    deleteEngramFile(absolutePath);
    this.deleteSynapsesTouching(stableId);
    if (isStableEngramId(stableId)) {
      this.deleteIndexEntry(stableId as StableEngramId);
    }
  }

  /**
   * 按 path 读 engram(用于 doctor 自愈 / 人类浏览)
   */
  readEngramByPath(relativePath: string): Engram | undefined {
    const absolutePath = join(this.config.rootPath, relativePath);
    if (!existsSync(absolutePath)) return undefined;
    try {
      const file = readEngramFile(absolutePath);
      return this.assembleEngram(file, relativePath);
    } catch {
      return undefined;
    }
  }

  // ─── Engram Catalog / Digest ───────────────────────────────────────────

  /** 列出所有 engram(catalog 元数据) */
  listEngrams(): EngramCatalogEntry[] {
    const result: EngramCatalogEntry[] = [];
    for (const entry of this.getIndex().entries.values()) {
      result.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        domainTags: entry.domainTags,
      });
    }
    return result;
  }

  /**
   * 按 verification status 过滤(支持单个 status 或数组,兼容历史调用方)。
   *
   * 返回完整 Engram[](非 catalog entry),便于上层直接复用。
   */
  listByVerificationStatus(
    statuses: readonly VerificationStatus[],
  ): readonly Engram[];
  listByVerificationStatus(status: VerificationStatus): readonly Engram[];
  listByVerificationStatus(
    input: VerificationStatus | readonly VerificationStatus[],
  ): readonly Engram[] {
    const list = Array.isArray(input) ? input : [input];
    if (list.length === 0) return [];
    const statusSet = new Set(list);
    const out: Engram[] = [];
    for (const entry of this.getIndex().entries.values()) {
      const current = entry.verificationStatus ?? "unverified";
      if (!statusSet.has(current)) continue;
      out.push(this.readEngram(entry.id));
    }
    return out;
  }

  /**
   * 列出所有 engram 的完整 index 条目(含 slug / domainTags / mtime / contentHash)
   *
   * 用于 viewer / 外部工具渲染人类友好的标识(slug 而非完整 title 或 path)。
   */
  listEngramIndex(): readonly EngramIndexEntry[] {
    return Array.from(this.getIndex().entries.values());
  }

  /** 单条 catalog entry */
  readCatalogEntry(stableId: string): EngramCatalogEntry | null {
    if (!isStableEngramId(stableId)) return null;
    const entry = this.getIndex().entries.get(stableId as StableEngramId);
    if (!entry) return null;
    return {
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      domainTags: entry.domainTags,
    };
  }

  /** 单条 digest(从单文件 + synapse count 构建) */
  readDigest(stableId: string): EngramDigest | null {
    if (!this.exists(stableId)) return null;
    const engram = this.readEngram(stableId);
    return {
      id: engram.id,
      title: engram.title,
      kind: engram.kind,
      domainTags: engram.domainTags,
      summary: engram.summary,
      importance: engram.importance,
      emotionalValence: engram.emotionalValence,
      freshness: engram.freshness,
      updatedAt: engram.updatedAt,
      contentSize: engram.contentSize,
    };
  }

  // ─── Synapse 操作 ──────────────────────────────────────────────────────

  /**
   * 读 engram 相关的所有 synapse(双向)。
   *
   * 返回 { outgoing, incoming }。
   * 调用方按需用 `.outgoing` 或 `.incoming`。
   */
  readSynapses(stableId: string): { outgoing: Synapse[]; incoming: Synapse[] } {
    return listSynapsesForEngram(this.config.rootPath, stableId);
  }

  /**
   * 列出所有 synapse(per-edge 扫描)。
   *
   * 返回 `{ fromId, synapse }` 形状以兼容历史调用方;
   * synapse 自身已携带 `from` 字段,fromId 就是 synapse.from。
   */
  collectAllSynapses(): Array<{ fromId: string; synapse: Synapse }> {
    const all = collectAllSynapses(this.config.rootPath);
    return all.map((synapse) => ({ fromId: synapse.from, synapse }));
  }

  /** 按 endpoints 查单条 synapse */
  readSynapseByEndpoints(
    from: string,
    to: string,
    kind: SynapseKind,
  ): Synapse | undefined {
    return readSynapseByEndpoints(this.config.rootPath, from, to, kind);
  }

  /** 按 id 查 synapse */
  readSynapseById(synapseId: string): Synapse | undefined {
    return readSynapseById(this.config.rootPath, synapseId);
  }

  /**
   * 触发 Obsidian 派生段重建(多条 engram 一次性刷新,去重)。
   *
   * 永不抛(regenerateObsidianLinks 内部已吞错)。调用方无需 try/catch。
   */
  private refreshObsidianLinks(...ids: readonly string[]): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      regenerateObsidianLinks(this.config.rootPath, id, this.language);
    }
  }

  /** 创建 synapse(idempotent) */
  createSynapse(input: SynapseCreateInput): Synapse {
    const result = upsertSynapse(this.config.rootPath, {
      from: input.from,
      to: input.to,
      kind: input.kind,
      direction: input.direction ?? "directional",
      weight: input.weight,
      evidence: input.evidence,
      createdBy: input.createdBy,
      sourceSemantic: input.sourceSemantic,
      targetSemantic: input.targetSemantic,
      language: this.language,
    });
    this.refreshObsidianLinks(input.from, input.to);
    return result;
  }

  /**
   * 更新 synapse(走 upsert,合并 evidence)。
   *
   * 若 input.kind 与原 kind 不同:删除旧文件,以新 kind 重建
   * (synapse id 由 from+to+kind+direction 派生,kind 变更必导致 id 变更)。
   */
  updateSynapse(
    fromId: string,
    synapseId: string,
    input: SynapseUpdateInput,
  ): Synapse {
    const existing = this.readSynapses(fromId);
    const target = [...existing.outgoing, ...existing.incoming].find(
      (s) => s.id === synapseId,
    );
    if (!target) {
      throw new Error(`Synapse not found: ${synapseId} (from ${fromId})`);
    }

    const nextKind = input.kind ?? target.kind;
    const nextDirection = input.direction ?? target.direction;
    const nextWeight = input.weight ?? target.weight;

    // kind 变化 → id 重算 → 必须先删旧文件再 upsert,否则会留下孤儿
    if (input.kind !== undefined && input.kind !== target.kind) {
      const oldPath = join(
        this.config.rootPath,
        synapseRelativePath(target.id, target.kind),
      );
      deleteSynapseFile(oldPath);
    }

    const result = upsertSynapse(this.config.rootPath, {
      from: target.from,
      to: target.to,
      kind: nextKind,
      direction: nextDirection,
      weight: nextWeight,
      evidence: input.evidence,
      createdBy: target.createdBy,
      sourceSemantic: target.sourceSemantic,
      targetSemantic: target.targetSemantic,
      resolutionState: target.resolutionState,
      language: this.language,
    });
    this.refreshObsidianLinks(target.from, target.to);
    return result;
  }

  /** 删除某条 synapse */
  deleteSynapse(synapseId: string): void {
    const syn = this.readSynapseById(synapseId);
    if (!syn) return;
    const path = join(
      this.config.rootPath,
      synapseRelativePath(syn.id, syn.kind),
    );
    deleteSynapseFile(path);
    this.refreshObsidianLinks(syn.from, syn.to);
  }

  /** 级联删除触及 engram 的所有 synapse */
  deleteSynapsesTouching(engramId: string): number {
    // 先抓所有邻居 endpoint — 删除后这些 synapse 就找不到了,
    // 邻居 engram.md 的派生段还引用着 engramId,需要重建。
    const touching = listSynapsesForEngram(this.config.rootPath, engramId);
    const neighbors = new Set<string>();
    for (const s of touching.outgoing) {
      if (s.to !== engramId) neighbors.add(s.to);
    }
    for (const s of touching.incoming) {
      if (s.from !== engramId) neighbors.add(s.from);
    }
    const count = deleteSynapsesTouching(this.config.rootPath, engramId);
    if (neighbors.size > 0) this.refreshObsidianLinks(...neighbors);
    return count;
  }

  /**
   * 添加 outgoing synapse。
   *
   * 内部走 upsertSynapse,synapse.id 由 (from, to, kind, direction) 确定性计算,
   * 调用方传入的 id 仅用作幂等性提示(实际以计算值为准)。
   *
   * @returns 实际落盘的 synapse(其 id 是计算值)
   */
  addOutgoingSynapse(fromId: string, synapse: Synapse): Synapse {
    const result = upsertSynapse(this.config.rootPath, {
      from: fromId,
      to: synapse.to,
      kind: synapse.kind,
      direction: synapse.direction,
      weight: synapse.weight,
      evidence: synapse.evidence.map((e) => ({
        description: e.description,
        source: e.source,
        confidence: e.confidence,
        addedBy: e.addedBy,
      })),
      createdBy: synapse.createdBy,
      sourceSemantic: synapse.sourceSemantic,
      targetSemantic: synapse.targetSemantic,
      resolutionState: synapse.resolutionState,
      language: this.language,
    });
    this.refreshObsidianLinks(fromId, synapse.to);
    return result;
  }

  /**
   * 删除 outgoing synapse。
   *
   * fromId 可从 synapse 自身解析,这里仅保留参数以维持调用接口稳定。
   */
  removeOutgoingSynapse(fromId: string, synapseId: string): void {
    const existing = this.readSynapses(fromId);
    const target = [...existing.outgoing, ...existing.incoming].find(
      (s) => s.id === synapseId,
    );
    if (!target) return;
    const path = join(
      this.config.rootPath,
      synapseRelativePath(target.id, target.kind),
    );
    deleteSynapseFile(path);
    this.refreshObsidianLinks(target.from, target.to);
  }

  /**
   * 更新 synapse 的 resolutionState(contradicts 专用)。
   *
   * per-edge 文件原地覆盖写。activeContradictionCount 是读取时派生,无需手动 bump 缓存。
   */
  updateSynapseResolution(
    fromId: string,
    synapseId: string,
    next: SynapseResolutionState,
  ): void {
    const existing = this.readSynapses(fromId);
    const target = [...existing.outgoing, ...existing.incoming].find(
      (s) => s.id === synapseId,
    );
    if (!target) {
      throw new Error(`Synapse not found: ${synapseId} (from ${fromId})`);
    }
    const updated: Synapse = {
      ...target,
      resolutionState: next,
      updatedAt: now(),
    };
    const path = join(
      this.config.rootPath,
      synapseRelativePath(target.id, target.kind),
    );
    writeSynapseFile(path, updated, this.language);
  }

  /**
   * 替换 synapse 的 evidence 数组。
   */
  replaceSynapseEvidence(
    fromId: string,
    synapseId: string,
    evidence: readonly SynapseEvidence[],
  ): void {
    const existing = this.readSynapses(fromId);
    const target = [...existing.outgoing, ...existing.incoming].find(
      (s) => s.id === synapseId,
    );
    if (!target) {
      throw new Error(`Synapse not found: ${synapseId} (from ${fromId})`);
    }
    const updated: Synapse = {
      ...target,
      evidence: [...evidence],
      updatedAt: now(),
    };
    const path = join(
      this.config.rootPath,
      synapseRelativePath(target.id, target.kind),
    );
    writeSynapseFile(path, updated, this.language);
  }

  /**
   * 替换整条 synapse(用于触发式进化 weight boost)。
   *
   * 注意:next.id / next.from / next.to / next.kind 若与原有不一致,
   * 同 (from, to, kind, direction) 确定性 id 会让 evidence/weight 变化落在同一条 edge 上,
   * 调用方需保证 next 的 endpoints/kind 与原有一致(只改 weight / updatedAt 等)。
   */
  replaceSynapse(fromId: string, synapseId: string, next: Synapse): void {
    const existing = this.readSynapses(fromId);
    const target = [...existing.outgoing, ...existing.incoming].find(
      (s) => s.id === synapseId,
    );
    if (!target) {
      throw new Error(`Synapse not found: ${synapseId} (from ${fromId})`);
    }
    const path = join(
      this.config.rootPath,
      synapseRelativePath(target.id, target.kind),
    );
    writeSynapseFile(path, next, this.language);
  }

  // ─── Engram Stats / Lifecycle(不触发 version++)────────────────────────

  /**
   * 批量增减检索/强化统计(retrievalCount / effectiveRetrievals / failedUses /
   * reinforcementScore / importance / 各时间戳)。
   *
   * 不触发 version++。
   */
  bumpRetrievalStats(
    id: string,
    delta: {
      retrievedDelta?: number;
      effectiveDelta?: number;
      failedDelta?: number;
      reinforcementDelta?: number;
      importanceDelta?: number;
      lastRetrievedAt?: string;
      lastEffectiveAt?: string;
      lastRetrievalScore?: number;
    },
  ): void {
    this.mutateFrontmatter(id, (fm) => ({
      ...fm,
      retrievalCount: Math.max(
        0,
        (fm.retrievalCount ?? 0) + (delta.retrievedDelta ?? 0),
      ),
      effectiveRetrievals: Math.max(
        0,
        (fm.effectiveRetrievals ?? 0) + (delta.effectiveDelta ?? 0),
      ),
      failedUses: Math.max(0, (fm.failedUses ?? 0) + (delta.failedDelta ?? 0)),
      reinforcementScore:
        (fm.reinforcementScore ?? 0) + (delta.reinforcementDelta ?? 0),
      importance: clamp01(
        (fm.importance ?? DEFAULT_IMPORTANCE) + (delta.importanceDelta ?? 0),
      ),
      lastRetrievedAt: delta.lastRetrievedAt ?? fm.lastRetrievedAt,
      lastEffectiveAt: delta.lastEffectiveAt ?? fm.lastEffectiveAt,
      ...(delta.lastRetrievalScore !== undefined
        ? { lastRetrievalScore: clamp01(delta.lastRetrievalScore) }
        : {}),
    }));
  }

  /**
   * 更新 status / freshness(不触发 version++)。
   *
   * 默认按 lastEffectiveAt + decayHalfLifeDays 派生 freshness,
   * 但允许通过 forcedFreshness 显式覆盖（用于 lifecycle 工具强制切换）。
   * 一旦再触发 effective 检索（lastEffectiveAt 更新）,forcedFreshness 会被清除。
   */
  updateLifecycle(
    id: string,
    status?: EngramStatus,
    freshness?: EngramFreshness,
  ): void {
    if (status === undefined && freshness === undefined) return;
    this.mutateFrontmatter(id, (fm) => ({
      ...fm,
      ...(status !== undefined ? { status } : {}),
      ...(freshness !== undefined ? { forcedFreshness: freshness } : {}),
    }));
  }

  /**
   * 更新多维重要性向量(不触发 version++)。
   *
   * 同时把 fm.importance 设为 vector.composite,保证检索公式读到最新综合分。
   */
  updateImportanceVector(
    id: string,
    input: { vector: ImportanceVector; updatedBy?: string },
  ): void {
    this.mutateFrontmatter(id, (fm) => ({
      ...fm,
      importance: input.vector.composite,
      importanceVector: input.vector,
    }));
  }

  /**
   * 更新 verificationStatus(不触发 version++)。
   */
  updateVerificationStatus(id: string, status: VerificationStatus): void {
    this.mutateFrontmatter(id, (fm) => ({ ...fm, verificationStatus: status }));
  }

  /**
   * 低层 frontmatter 修改:不触发 version++,不改 slug,不改 path。
   *
   * 供 stats / lifecycle / verification 等频次高的写入使用,避免频繁 version++。
   */
  private mutateFrontmatter(
    stableId: string,
    mutator: (fm: EngramFrontmatter) => EngramFrontmatter,
  ): void {
    const relativePath = this.resolvePath(stableId);
    if (!relativePath) return;
    const absolutePath = join(this.config.rootPath, relativePath);
    if (!existsSync(absolutePath)) return;
    const oldFile = readEngramFile(absolutePath);
    const newFrontmatter = mutator(oldFile.frontmatter);
    const newFile: EngramFile = {
      frontmatter: newFrontmatter,
      content: oldFile.content,
    };
    writeEngramFile(absolutePath, newFile, this.language);

    // 更新 index 的 mtime(其他字段未变,无需重建整条 entry)
    const stat = statSync(absolutePath);
    const contentHash =
      newFrontmatter.contentHash ?? computeContentHash(oldFile.content);
    this.updateIndexEntry(
      buildIndexEntryFromFrontmatter({
        relativePath,
        frontmatter: newFrontmatter,
        mtime: stat.mtimeMs,
        contentHash,
      }),
    );
  }

  // ─── Doctor 自愈扫描 ───────────────────────────────────────────────────

  /**
   * Doctor 全量扫描 + 自愈修复。
   *
   * 修复:
   * - moved_file:index 里 id 存在但 path 不匹配 → 更新 path
   * - title_changed:重新 slugify + rename(若 slug 未锁定且无冲突)
   * - missing_file:从 index 移除 + 标记相关 synapse 为 dangling
   * - duplicate_id:警告(人工裁决)
   * - orphan_markdown:提示注册为 engram
   * - dangling_synapse:报告(人工清理)
   */
  runDoctor(options: { incremental?: boolean } = {}): DoctorReport {
    const startedAt = now();
    const issues: DoctorIssue[] = [];
    const fixes: DoctorIssue[] = [];
    const pendingManualReview: DoctorIssue[] = [];

    // 1. 全量重建 fresh index
    const freshIndex = rebuildEngramIndex(
      this.config.rootPath,
      (orphanPath) => {
        issues.push({
          kind: "orphan_markdown",
          path: orphanPath,
          message: `Markdown file without frontmatter: ${orphanPath} (either delete it or add frontmatter with a stable id)`,
          autoFixed: false,
          nextAction: {
            tool: "engram_create",
            argsHint: `{ title, content, kind, domainTags, createdBy }  // 直接读取这个 markdown 的内容作为 engram body`,
            explanation:
              "Markdown 文件没有 frontmatter,所以不在 engram 索引里。如果是新记忆,用 engram_create 注册(把现有正文粘到 content);如果是废弃草稿,直接 rm 即可。",
          },
        });
        pendingManualReview.push(issues[issues.length - 1]!);
      },
    );

    // 2. 比对旧 index 检测 moved_file / title_changed / missing_file
    const oldIndex = readEngramIndex(this.config.rootPath);
    const freshIds = new Set(freshIndex.entries.keys());

    for (const [oldId, oldEntry] of oldIndex.entries) {
      if (!freshIds.has(oldId)) {
        // id 在旧 index 但不在 fresh → 文件被删除或被移动到不同 path(且 frontmatter id 保留)
        // 进一步检查是否在磁盘上能找到这个 id
        const foundInFresh = Array.from(freshIndex.entries.values()).find(
          (e) => e.id === oldId,
        );
        if (foundInFresh) {
          // moved:id 还在,但 path 变了
          if (foundInFresh.path !== oldEntry.path) {
            const fix: DoctorIssue = {
              kind: "moved_file",
              stableId: oldId,
              path: foundInFresh.path,
              message: `File moved: ${oldEntry.path} → ${foundInFresh.path} (index updated to new path)`,
              autoFixed: true,
            };
            fixes.push(fix);
          }
        } else {
          // missing:id 完全找不到
          const issue: DoctorIssue = {
            kind: "missing_file",
            stableId: oldId,
            path: oldEntry.path,
            message: `Index references ${oldId} at ${oldEntry.path} but the file is gone from disk (index entry cleared)`,
            autoFixed: true,
          };
          fixes.push(issue);
          // 标记相关 synapse dangling
          const touching = listSynapsesForEngram(this.config.rootPath, oldId);
          if (touching.outgoing.length + touching.incoming.length > 0) {
            const danglingCount =
              touching.outgoing.length + touching.incoming.length;
            pendingManualReview.push({
              kind: "dangling_synapse",
              stableId: oldId,
              message: `Engram ${oldId} was deleted but ${danglingCount} synapse(s) still reference it (clean up manually or restore the engram)`,
              autoFixed: false,
              nextAction: {
                tool: "synapse_delete",
                argsHint: `{ id: "<synapseId>" }  // synapseId 在每个 synapse 的 yaml id 字段,逐条删`,
                explanation: `被删 engram 还有 ${danglingCount} 条 synapse 指向它,这些 synapse 现在是悬空的。去 synapses/ 目录找出涉及该 engram 的 synapse,用 synapse_delete 逐条清理;或者用 engram_create 重建该 engram(让 synapse 重新有目标)。`,
              },
            });
          }
        }
      } else {
        // id 在 fresh,检查 path / title / slug 变化
        const freshEntry = freshIndex.entries.get(oldId)!;
        // 1) path 变化(通过 doctor 之外的途径,如人类 mv + 手动改 index)
        if (freshEntry.path !== oldEntry.path) {
          fixes.push({
            kind: "moved_file",
            stableId: oldId,
            path: freshEntry.path,
            message: `Path updated: ${oldEntry.path} → ${freshEntry.path}`,
            autoFixed: true,
          });
        }
        // 2) title 变 → 重新 slugify + rename(slug 未锁定时)
        if (freshEntry.title !== oldEntry.title && !freshEntry.slugLocked) {
          const newSlug = slugify(freshEntry.title);
          if (newSlug !== freshEntry.slug) {
            const newPath = this.rebuildPath(freshEntry.path, newSlug);
            const newAbs = join(this.config.rootPath, newPath);
            if (!existsSync(newAbs)) {
              renameEngramFile(
                join(this.config.rootPath, freshEntry.path),
                newAbs,
              );
              fixes.push({
                kind: "title_changed",
                stableId: oldId,
                path: newPath,
                message: `Title changed, file renamed to match new slug: ${freshEntry.path} → ${newPath}`,
                autoFixed: true,
              });
            } else {
              const issue: DoctorIssue = {
                kind: "slug_conflict",
                stableId: oldId,
                path: newPath,
                message: `New slug "${newSlug}" collides with an existing file; kept the old slug. Rename one of the files manually or change a title.`,
                autoFixed: false,
              };
              issues.push(issue);
              pendingManualReview.push(issue);
            }
          }
        }
      }
    }

    // 3. 写回 fresh index(同步更新 mtime,避免下次 getIndex 误判)
    this.persistIndex(freshIndex);

    // 4. 检测 dangling synapse(from/to 不在 index)
    const allSynapses = collectAllSynapses(this.config.rootPath);
    for (const syn of allSynapses) {
      if (!freshIndex.entries.has(syn.from as StableEngramId)) {
        pendingManualReview.push({
          kind: "dangling_synapse",
          stableId: syn.from as StableEngramId,
          message: `Synapse ${syn.id} references .from="${syn.from}" which no longer exists`,
          autoFixed: false,
        });
      }
      if (!freshIndex.entries.has(syn.to as StableEngramId)) {
        pendingManualReview.push({
          kind: "dangling_synapse",
          stableId: syn.to as StableEngramId,
          message: `Synapse ${syn.id} references .to="${syn.to}" which no longer exists`,
          autoFixed: false,
        });
      }
    }

    // 5. Obsidian 视图一致性(派生段 wikilinks)
    // 对每条 engram:checkObsidianView 检测派生段与权威源(synapse yaml)不一致,
    // 不一致 → regenerateObsidianLinks 重写派生段(wikilink target=文件名)。
    for (const [id, entry] of freshIndex.entries) {
      const absPath = join(this.config.rootPath, entry.path);
      if (!existsSync(absPath)) continue;
      let file;
      try {
        file = readEngramFile(absPath);
      } catch {
        continue; // parse 错误由别处报告(或phan_markdown 路径)
      }
      const touching = listSynapsesForEngram(this.config.rootPath, id);
      const status = checkObsidianView(file, touching, freshIndex);
      if (!status.stale) continue;

      regenerateObsidianLinks(this.config.rootPath, id, this.language);
      fixes.push({
        kind: "obsidian_view_stale",
        stableId: id as StableEngramId,
        path: entry.path,
        message: `Obsidian derived wikilinks regenerated (target=filename, display=title·kind)`,
        autoFixed: true,
      });
    }

    return {
      startedAt,
      finishedAt: now(),
      totalEngrams: freshIndex.entries.size,
      totalSynapses: allSynapses.length,
      issues,
      fixes,
      pendingManualReview,
    };
  }

  // ─── Path Tree(渐进式披露) ───────────────────────────────────────────

  /**
   * 构建目录树(用于 viewer 和 engram_list_paths 工具)。
   *
   * 每节点:{ path, engramCount, children }
   * engramCount = 该目录及其所有子目录的 engram 总数(累积)
   */
  listPathTree(): PathTreeNode {
    type MutableNode = {
      path: string;
      engramCount: number;
      children: MutableNode[];
    };
    const root: MutableNode = { path: "/", engramCount: 0, children: [] };
    const nodeMap = new Map<string, MutableNode>();
    nodeMap.set("", root);

    for (const entry of this.getIndex().entries.values()) {
      // entry.path 形如 "<domain1>/<domain2>/.../<slug>.md"
      // 最后一段是文件名,跳过;之前每段都是目录,需逐级累加(包含 root)
      const segments = entry.path.split("/");
      const dirSegments = segments.slice(0, -1);

      root.engramCount++;
      let currentPath = "";
      let parentNode = root;
      for (const seg of dirSegments) {
        currentPath = currentPath.length === 0 ? seg : `${currentPath}/${seg}`;
        let node = nodeMap.get(currentPath);
        if (!node) {
          node = {
            path: currentPath,
            engramCount: 0,
            children: [],
          };
          nodeMap.set(currentPath, node);
          parentNode.children.push(node);
        }
        node.engramCount++;
        parentNode = node;
      }
    }

    return root as PathTreeNode;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  /**
   * 把单文件 + synapse 统计组装成 Engram 对象
   */
  private assembleEngram(file: EngramFile, relativePath: string): Engram {
    const fm = file.frontmatter;
    const synapses = listSynapsesForEngram(this.config.rootPath, fm.id);
    const seenSynapseIds = new Set<string>();
    const activeContradictionCount = [
      ...synapses.outgoing,
      ...synapses.incoming,
    ].filter((s) => {
      if (s.kind !== "contradicts") return false;
      // bidirectional 会被同时计入 outgoing/incoming,按 id 去重
      if (seenSynapseIds.has(s.id)) return false;
      seenSynapseIds.add(s.id);
      const status = s.resolutionState?.status;
      // 无 resolutionState / pending / escalated 都视为活跃矛盾
      return (
        status === undefined || status === "pending" || status === "escalated"
      );
    }).length;

    const createdAt = fm.createdAt ?? now();
    const lastEffectiveAtForFreshness = fm.lastEffectiveAt ?? createdAt;
    const decayHalfLifeDays =
      fm.decayHalfLifeDays === undefined
        ? DEFAULT_DECAY_HALF_LIFE_DAYS
        : fm.decayHalfLifeDays;
    const status = fm.status ?? "active";
    const freshness: EngramFreshness =
      status === "forgotten"
        ? "forgotten"
        : (fm.forcedFreshness ??
          this.computeFreshness(
            lastEffectiveAtForFreshness,
            decayHalfLifeDays,
          ));

    // domainTags:frontmatter 锁定则用之,否则从 path 推断
    const hasExplicitDomainTags =
      Array.isArray(fm.domainTags) && fm.domainTags.length > 0;
    const domainTags = hasExplicitDomainTags
      ? [...fm.domainTags!]
      : inferDomainTagsFromPath(relativePath);

    return {
      id: fm.id,
      title: fm.title,
      contentHash: fm.contentHash ?? computeContentHash(file.content),
      kind: fm.kind,
      kinds: fm.kinds ?? [fm.kind],
      domainTags,
      content: file.content,
      summary: fm.summary ?? fm.title,
      contentSize: fm.contentSize ?? computeContentSize(file.content),
      createdBy: fm.createdBy,
      createdAt,
      updatedBy: fm.updatedBy,
      updatedAt: fm.updatedAt ?? now(),
      encodingContext: fm.encodingContext,
      version: fm.version ?? 1,
      importance: fm.importance ?? DEFAULT_IMPORTANCE,
      confidence: fm.confidence ?? DEFAULT_CONFIDENCE_BY_SOURCE.firsthand,
      emotionalValence: fm.emotionalValence ?? "neutral",
      sourceType: fm.sourceType ?? "firsthand",
      evidenceCount: fm.evidenceCount ?? 0,
      importanceVector: (fm as { importanceVector?: ImportanceVector })
        .importanceVector,
      retrievalCount: fm.retrievalCount ?? 0,
      effectiveRetrievals: fm.effectiveRetrievals ?? 0,
      failedUses: fm.failedUses ?? 0,
      lastRetrievedAt: fm.lastRetrievedAt,
      lastEffectiveAt: fm.lastEffectiveAt,
      reinforcementScore: fm.reinforcementScore ?? 0,
      decayHalfLifeDays,
      lastRetrievalScore: fm.lastRetrievalScore ?? 0.5,
      outgoingSynapseCount: synapses.outgoing.length,
      incomingSynapseCount: synapses.incoming.length,
      activeContradictionCount,
      freshness,
      status,
      contextTags: fm.contextTags ?? [],
      visibility: fm.visibility ?? "public",
      verificationStatus: fm.verificationStatus ?? "unverified",
      perspective: fm.perspective,
    };
  }

  private computeFreshness(
    lastEffectiveAt: string,
    decayHalfLifeDays: number | null,
  ): EngramFreshness {
    if (decayHalfLifeDays === null) return "fresh";
    const ageDays =
      (Date.now() - new Date(lastEffectiveAt).getTime()) / 86400000;
    if (ageDays < decayHalfLifeDays) return "fresh";
    if (ageDays < decayHalfLifeDays * 2) return "aging";
    if (ageDays < decayHalfLifeDays * 4) return "stale";
    return "forgotten";
  }

  /** 把绝对路径转回相对路径(用于 doctor 报告) */
  relativePath(absolutePath: string): string {
    return relative(this.config.rootPath, absolutePath).replaceAll(sep, "/");
  }

  /**
   * 把所有 engram + synapse 文件迁移到目标语言格式。
   *
   * 行为:
   * - 遍历 dataRoot 下所有 engram .md 文件 + synapses 子目录的 .yaml
   * - 每个文件:parse 归一化,按目标 language 重新 serialize,写回
   * - 文件已是目标格式则跳过
   * - 损坏文件(parse 失败)计入 errors,不阻塞其他文件
   *
   * 返回:迁移统计 { migrated, skipped, errors }
   */
  migrateFormat(targetLanguage: Language): {
    migrated: number;
    skipped: number;
    errors: string[];
  } {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] };

    // 1. 迁移 engram 文件(所有非 .co-engram/synapses 目录下的 .md)
    const index = this.getIndex();
    for (const entry of index.entries.values()) {
      const absolutePath = join(this.config.rootPath, entry.path);
      if (!existsSync(absolutePath)) {
        result.errors.push(`missing file: ${entry.path}`);
        continue;
      }
      try {
        const raw = readFileSync(absolutePath, "utf8");
        const diskLang = detectEngramFileLanguage(raw);
        if (diskLang === targetLanguage) {
          result.skipped++;
          continue;
        }
        const file = parseEngramFile(raw);
        writeEngramFile(absolutePath, file, targetLanguage);
        result.migrated++;
      } catch (err) {
        result.errors.push(
          `engram ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. 迁移 synapse 文件
    const synapseRoot = join(this.config.rootPath, SYNAPSES_DIR);
    if (existsSync(synapseRoot)) {
      const visitSynapseDir = (kindDir: string): void => {
        for (const entry of readdirSync(kindDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            visitSynapseDir(join(kindDir, entry.name));
            continue;
          }
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))
            continue;
          const absolutePath = join(kindDir, entry.name);
          try {
            const raw = readFileSync(absolutePath, "utf8");
            const parsed = parseYaml(raw) as Record<string, unknown> | null;
            if (!parsed || typeof parsed !== "object") {
              result.errors.push(`synapse ${entry.name}: not an object`);
              continue;
            }
            // 已是目标语言则跳过(检测标记字段或语言标记)
            const hasLangMarker =
              "__语言" in parsed
                ? parsed["__语言"] === "zh"
                : "__lang" in parsed
                  ? parsed["__lang"] === "en"
                  : false;
            if (hasLangMarker) {
              const currentLang = "__语言" in parsed ? "zh" : "en";
              if (currentLang === targetLanguage) {
                result.skipped++;
                continue;
              }
            }
            const file = parseSynapseFile(raw);
            writeSynapseFile(absolutePath, file, targetLanguage);
            result.migrated++;
          } catch (err) {
            result.errors.push(
              `synapse ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };
      visitSynapseDir(synapseRoot);
    }

    // 3. 重建索引(路径未变,但 mtime 变了)
    if (result.migrated > 0) {
      this.persistIndex(rebuildEngramIndex(this.config.rootPath));
    }

    return result;
  }
}
