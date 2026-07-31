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
  EngramVisibility,
  VerificationStatus,
  Synapse,
  SynapseCreateInput,
  SynapseEvidence,
  SynapseKind,
  SynapseResolutionState,
  SynapseUpdateInput,
  SynapseDirection,
} from "../types/index.js";
import type {
  StableEngramId,
  EngramIndexEntry,
  DoctorReport,
  DoctorIssue,
  DoctorNextAction,
  PathTreeNode,
} from "../types/repository-types.js";
import { isStableEngramId } from "../types/repository-types.js";
import { slugify, inferDomainTagsFromPath } from "../types/slugify.js";
import { computeSynapseId } from "../types/synapse-id.js";
import { safeEmit } from "../prompt-signals/event-bus.js";
import { safeJoinWithinRoot, isPathWithinRoot } from "./path.js";

import { computeContentHash, computeContentSize } from "./hash.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/index.js";
import {
  type EngramFrontmatter,
  type EngramFile,
  type ValidationIssue,
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
  collectMarkdownFiles,
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
import { collectSkillDirs, SKILL_MD_FILENAME } from "../skill/skill-detector.js";
import { assertVisibilityTransitionAllowed } from "./visibility-gate.js";
import {
  IndexDb,
  type EngramIndexEntry as SqliteEngramIndexEntry,
  type EngramQueryRow,
  type EngramListRow,
  type DigestIndexRow,
  type ContentBatchRow,
  encodeQueryCursor,
  decodeQueryCursor,
} from "./index-db.js";
import {
  encodeCursor,
  decodeCursor,
  compareSortKey,
  type SortKey,
} from "./index-db-cursor.js";
import type { DigestLine } from "../index/types.js";
import type { SearchFilter } from "../types/disclosure.js";
import { deriveHalfLifeDays } from "../importance/dynamics.js";
import { computeFreshness } from "../lifecycle/freshness.js";
import { notFoundError, validationError } from "../tools/error-schema.js";

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

/**
 * 外部 .md 检测钩子参数:watcher 发现 dataRoot 下未追踪的 .md 文件时构造。
 *
 * - `absPath`:文件绝对路径,host 可读取内容做进一步处理
 * - `relPath`:相对 rootPath 的路径(用于提案展示与去重命名空间)
 * - `raw`:文件原始内容(避免 hook 反复读盘)
 * - `parsed`:尝试解析 frontmatter 的结果;`null` 表示文件不是合法 engram
 *   格式(无 frontmatter 或解析失败)—— host 通常应当跳过此类文件
 */
export interface ExternalMarkdownHookParams {
  readonly absPath: string;
  readonly relPath: string;
  readonly raw: string;
  readonly parsed: EngramFile | null;
}

/**
 * 外部 .md 检测钩子签名。
 *
 * 由 host 适配层(claude-code-mcp / openclaw-plugin)实现,绑定到
 * ProposalEngine.proposeExternalMarkdown,把"未授权来源"的 .md 转成
 * 待审批提案而非直接落库。
 */
export type ExternalMarkdownHook = (params: ExternalMarkdownHookParams) => void;

/**
 * skill 目录检测钩子签名（watcher 发现含 SKILL.md 的目录时回调）。
 */
export type SkillHook = (params: { readonly absPath: string; readonly relPath: string; readonly raw: string }) => void;

const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIDENCE_BY_SOURCE: Record<EngramSourceType, number> = {
  firsthand: 0.85,
  secondhand: 0.65,
  inferred: 0.5,
};

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
 * Synapse visibility 继承规则:取两端 engram 的最严。
 *
 * 严格度排序:`private` > `restricted` > `team` > `public`。
 * 任一端是 private,synapse 整条就按 private 处理(保守策略)。
 */
const VIS_STRICTNESS: Record<EngramVisibility, number> = {
  public: 0,
  team: 1,
  restricted: 2,
  private: 3,
};

function maxVisibility(
  a: EngramVisibility,
  b: EngramVisibility,
): EngramVisibility {
  return VIS_STRICTNESS[a] >= VIS_STRICTNESS[b] ? a : b;
}

/**
 * 判断给定的相对路径是否在 skill 目录下。
 *
 * 用于解冲突：skill 目录下的文件不进 external-markdown 提案（由 scanForSkills 统一处理）。
 */
function isUnderSkillRoot(relPath: string, skillRoots: readonly string[]): boolean {
  for (const r of skillRoots) {
    if (r === ".") return true; // dataRoot 本身是 skill 目录 → 所有文件都归 skill
    if (relPath === r || relPath.startsWith(r + "/")) return true;
  }
  return false;
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
   * Synapse 变更 listeners — 在 .yaml 文件被外部修改(git pull / Edit / cp 等)
   * 触发 dataWatcher 时调用。
   *
   * 主要用途:让 host adapter(mcp / plugin)在 .yaml 变化时重建 graph.json +
   * SQLite synapse 表(派生层与真理层重新对齐)。
   *
   * 设计动机:index-no-truth 架构缺陷修复 —— 原本 .yaml watcher 只清 synapseCache,
   * 不重建 graph.json / SQLite synapse 表,导致 viewer 贡献者排名(读 graph.json
   * edges[].createdBy)长期陈旧。
   */
  private readonly synapseChangeListeners: Array<() => void> = [];

  /**
   * fs.watch 句柄(可选)。启动后,外部进程修改 engram-index.json
   * 会立即触发缓存失效,无需等下次 getIndex 的 mtime 兜底检查。
   */
  private indexWatcher: FSWatcher | undefined;

  /**
   * 递归 fs.watch 句柄,监听 dataRoot 下所有 .md 文件变化(可选)。
   *
   * 触发场景(关键):git pull / git checkout / 手动编辑 / rsync / 用户拷贝文件
   * 等任何外部写入 .md 的途径,startWatching() 单独监听 index.json 看不到这些变化。
   *
   * 信任边界设计(关键安全语义):
   *   - git pull 来的 .md → 由 post-merge hook 调 runDoctor 自动接受(团队可信)
   *   - 其他来源的 .md(用户拷贝、IDE 写入等)→ **不**自动接受,通过
   *     externalMarkdownHook 通知 host 适配层形成 proposal,等用户审批
   *   - watcher 自身只做"扫描 + diff + 通知 hook",不写 index.json
   *   - 安全动机:防止恶意/误植的 .md 通过文件系统投毒直接进入团队记忆库
   */
  private dataWatcher: FSWatcher | undefined;

  /** dataWatcher debounce 定时器。git pull 一次性触发大量事件,合并为一次扫描。 */
  private dataRebuildTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * .yaml watcher debounce 定时器。synapse 文件批量变化时合并为一次重建通知,
   * 让 host adapter 一次性重建 graph.json + SQLite synapse 表,避免逐文件扫盘。
   */
  private synapseRebuildTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 外部 .md 检测钩子(由 host 适配层设置)。
   *
   * watcher 扫描发现"dataRoot 下存在但 index 中没有"的 .md 文件时调用。
   * host 适配层通常把回调绑到 ProposalEngine.proposeExternalMarkdown,
   * 让用户审批后再决定是否纳入团队记忆。
   *
   * 未设置时 → watcher 发现新 .md 仅记录 orphan,不自动接受(noop)。
   */
  private externalMarkdownHook: ExternalMarkdownHook | undefined;

  /**
   * skill 目录检测钩子(由 host 适配层设置)。
   *
   * watcher 扫描发现含 SKILL.md 的目录时调用，用于检测 superpowers 技能目录。
   * host 适配层通常把回调绑到 ProposalEngine.proposeSkill，
   * 让用户审批后再决定是否纳入团队记忆。
   *
   * 未设置时 → watcher 发现 skill 目录不自动接受(noop)。
   */
  private skillHook: SkillHook | undefined;

  private readonly config: RepositoryConfig;

  private readonly language: Language;

  /**
   * 可选 SQLite 索引层(用于 FTS 召回 / 排序)。
   *
   * 由 host adapter(claude-code-mcp / openclaw-plugin)在装配阶段注入。
   * 未注入时(向后兼容)所有写入路径行为不变;注入后,createEngram /
   * updateEngram / deleteEngram / mutateFrontmatter 在文件落盘成功后会
   * 透明地把 engram 投影 upsert / delete 到 SQLite。
   *
   * 写失败由调用方决定是否致命:本 repository 默认 fail-silent(SQLite 是
   * 派生数据,文件源真理仍然有效;doctor 自愈 + cold start rebuild 最终会
   * 修复 SQLite 与文件的不一致)。
   */
  /**
   * 派生 SQLite 索引(若注入)。viewer 层聚合统计(/api/stats、/api/trash 等)
   * 通过此字段直接走 SQL GROUP BY,避免 N+1 readEngram 在 1000+ engram 规模下
   * 卡爆(2026-07 viewer 性能修复:ghost 1026 条让 /api/stats 47s)。
   */
  readonly indexDb?: IndexDb;

  constructor(config: RepositoryConfig, indexDb?: IndexDb) {
    this.config = config;
    this.language = config.language ?? DEFAULT_LANGUAGE;
    this.indexDb = indexDb;
  }

  /**
   * 把 EngramFrontmatter + content 投影成 EngramIndexEntry,同步到 SQLite。
   *
   * 字段映射决策:
   *   - contentTokens = content 全文。FTS5 trigram 主要用于召回,词频统计
   *     不影响排序;SQLite page cache 自管索引大小。content 通常 < 2KB,
   *     直接全量灌入。
   *   - updatedAt 由 ISO string 转 epoch ms(Date.parse),与 IndexDb 的
   *     INTEGER 列对齐。
   *   - status / visibility / kind 等 union 类型直接 stringify 落 VARCHAR。
   *
   * Fail-silent:SQLite 是派生层,任何写失败都不阻塞文件源真理。
   */
  private syncEngramToIndex(
    frontmatter: EngramFrontmatter,
    content: string,
  ): void {
    if (!this.indexDb) return;
    const importance = frontmatter.importance ?? 0;
    // v4 freshness:forced 优先(生命周期工具显式锁定),否则按
    // lastEffectiveAt + 派生 halflife 实时计算。后续 maintenance 可周期性
    // UPDATE 全表(基于最新 lastEffectiveAt),此处写入保证 cold-start 后
    // 立即可用,避免 viewer ORDER BY freshness 全表扫。
    const freshness =
      frontmatter.forcedFreshness ??
      computeFreshness(
        frontmatter.lastEffectiveAt,
        frontmatter.createdAt,
        importance,
        frontmatter.kind,
      );
    const entry: SqliteEngramIndexEntry = {
      id: frontmatter.id,
      title: frontmatter.title,
      kind: frontmatter.kind,
      importance,
      confidence: frontmatter.confidence ?? 0,
      updatedAt: Date.parse(frontmatter.updatedAt),
      contentSize: frontmatter.contentSize ?? 0,
      visibility: frontmatter.visibility ?? "public",
      status: frontmatter.status ?? "active",
      domainTags: frontmatter.domainTags ?? [],
      summary: frontmatter.summary ?? "",
      contentTokens: content,
      // v2 schema 新增字段:让 viewer /api/engrams 可走 SQL ORDER BY/ LIMIT,
      // 消除 N+1 readEngram 卡死。retrievalCount 在 frontmatter 里是 number,
      // bumpRetrievalStats 也走全量 upsert(经 mutateFrontmatter → 这里)。
      // createdAt 是 ISO string,转 epoch ms 与 engrams 表对齐。
      retrievalCount: frontmatter.retrievalCount ?? 0,
      createdAt: frontmatter.createdAt
        ? Date.parse(frontmatter.createdAt)
        : Date.parse(frontmatter.updatedAt),
      // v3 schema:让 viewer /api/stats topContributors 走 SQL GROUP BY,
      // 避免 N+1 readEngram(listSynapsesForEngram 扫 1826 文件)卡 24s
      createdBy: frontmatter.createdBy ?? "",
      // v4 schema 投影:覆盖 DigestLine / readDigestBatch 需要的所有字段,
      // 让 engram_list / collectNeighborDigests / findCandidatesSync 等
      // 高频路径完全脱离 readEngram。synapse counts(out/in/contradiction)
      // frontmatter 不持有,这里写 0,由 maintenance / synapse-create 路径
      // 增量 UPDATE 回填(schema 已为此预留 idx_engrams_verification 等索引)。
      kinds: frontmatter.kinds ?? [frontmatter.kind],
      contextTags: frontmatter.contextTags ?? frontmatter.tags ?? [],
      freshness,
      sourceType: frontmatter.sourceType ?? "firsthand",
      contentHash: frontmatter.contentHash ?? "",
      lastRetrievedAt: frontmatter.lastRetrievedAt,
      lastEffectiveAt: frontmatter.lastEffectiveAt,
      effectiveRetrievals: frontmatter.effectiveRetrievals ?? 0,
      failedUses: frontmatter.failedUses ?? 0,
      reinforcementScore: frontmatter.reinforcementScore ?? 0,
      lastRetrievalScore: frontmatter.lastRetrievalScore,
      outgoingSynapseCount: 0,
      incomingSynapseCount: 0,
      activeContradictionCount: 0,
      verificationStatus: frontmatter.verificationStatus,
    };
    try {
      this.indexDb.upsertEngram(entry);
    } catch {
      // 派生数据失败不阻塞;doctor + cold start rebuild 会修复
    }
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

  /**
   * 清理索引中所有指向 relativePath 的孤儿 entry,返回清理数量。
   *
   * 触发场景:外部(用户 rm / git 操作 / 进程异常)删除 engram 文件后,
   * engram-index.json 仍保留旧 ULID 的 entry。下一次 createEngram 写入
   * 同 path 的新 ULID 会留下永不消失的孤儿,导致 listEngrams / viewer
   * 显示"重影"(同一文件被两个 ULID 引用)。
   *
   * 同 path 出现多条 entry 本身就是不变量破坏 —— 此处发现即清。多数调用
   * 不会命中,N=0 时是 O(|index|) 扫一次,可接受。
   */
  private purgeStaleIndexEntriesForPath(relativePath: string): number {
    const index = this.getIndex();
    const stale: StableEngramId[] = [];
    for (const [id, entry] of index.entries) {
      if (entry.path === relativePath) stale.push(id);
    }
    for (const id of stale) {
      this.deleteIndexEntry(id);
    }
    return stale.length;
  }

  // ─── Cross-process watcher ─────────────────────────────────────────────

  /**
   * 启动对 engram-index.json 的 fs.watch 监听 + dataRoot .md 递归监听。
   *
   * 启动后:
   *   - index.json watcher:外部进程修改 index(创建/更新/删除 engram)→ 失效 cache
   *   - dataRoot .md watcher:任何途径(git pull / checkout / 手动编辑 / 用户拷贝)
   *     写入 .md → debounce 后扫描,diff 出"未在 index 中的 .md"并通过
   *     externalMarkdownHook 通知 host 适配层。**watcher 自身不写 index**。
   *
   * 信任边界(安全关键):
   *   - git pull 来源由 post-merge hook 调 runDoctor 接受,不依赖 watcher
   *   - 其他来源由 host 通过 hook 决策(典型:形成 proposal 等待用户审批)
   *   - 防止"用户拷贝恶意 .md → 直接进团队记忆库"的攻击面
   *
   * 幂等:多次调用安全,只创建一个 watcher。
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
      this.indexWatcher.on("error", () => {
        this.indexWatcher = undefined;
      });
    } catch {
      this.indexWatcher = undefined;
    }
    this.startDataRootWatcher();
    // 启动即扫一次:覆盖"co-engram 启动前 dataRoot 已有未追踪 .md"的场景
    // (例如:用户先前拷贝文件但 co-engram 未运行 / 上次会话崩溃留下孤儿)。
    // fs.watch 只监听变化,无法发现现有状态,这里补一次扫描。
    // 已设置 hook → 形成 proposal;未设置 → noop。
    if (this.externalMarkdownHook) {
      try {
        this.scanForExternalMarkdown();
      } catch {
        // 启动扫描失败不阻塞 watcher,后续 .md 变化仍可被捕获
      }
    }
    if (this.skillHook) {
      try {
        this.scanForSkills();
      } catch {
        // 启动扫描失败不阻塞 watcher,后续 skill 目录变化仍可被捕获
      }
    }
    // 启动即清孤儿:覆盖"co-engram 启动前 .md 已被外部 rm 但 index 未同步"的场景。
    // 不依赖 externalMarkdownHook:索引一致性是基础保证,即使 host 未启用外部
    // 提案,也要让用户在重启后立即看到正确的 viewer 列表/统计。
    // 典型场景:用户在 co-engram 未运行时 rm 了文件 → 下次启动自动清孤儿。
    try {
      this.scanForDeletedEngrams();
    } catch {
      // 启动清孤儿失败不阻塞 watcher,后续 .md 变化仍可被捕获并重试
    }
  }

  /**
   * 注册外部 .md 检测钩子。host 适配层应在创建 repository + ProposalEngine
   * 之后、调用 startWatching 之前设置钩子,以确保 watcher 触发时回调就绪。
   *
   * @returns 取消注册函数(测试隔离 / 资源释放用)
   */
  setExternalMarkdownHook(hook: ExternalMarkdownHook): () => void {
    this.externalMarkdownHook = hook;
    return () => {
      if (this.externalMarkdownHook === hook) {
        this.externalMarkdownHook = undefined;
      }
    };
  }

  setSkillHook(hook: SkillHook): () => void {
    this.skillHook = hook;
    return () => {
      if (this.skillHook === hook) {
        this.skillHook = undefined;
      }
    };
  }

  /**
   * 启动 dataRoot 下 .md 文件的递归 fs.watch。
   *
   * Node 22+ 在 Linux/macOS/Windows 都支持 `recursive: true`(Linux 通过 inotify)。
   * 不支持的平台(NFS / 老 Node)→ catch 后 noop,startWatching 的 index.json
   * watcher + getIndex 的 mtime 兜底仍然有效。
   *
   * 触发后 debounce 调用 scanForExternalMarkdown(只读 + hook 通知),
   * **不**调用 rebuildIndex(避免 untrusted .md 直接落库)。
   */
  private startDataRootWatcher(): void {
    if (this.dataWatcher) return;
    try {
      this.dataWatcher = watch(
        this.config.rootPath,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          // 关心 .md(engram)与 .yaml(synapse)变化。.json / .co-engram/
          // 内部状态由 index.json watcher 或 persistIndex 路径覆盖。
          // filename 跨平台可能为 null,不可靠时宁可多触发一次扫描也不要漏事件。
          if (typeof filename === "string") {
            if (filename.endsWith(".yaml") || filename.endsWith(".yml")) {
              // synapse 文件变化 → 失效 synapseCache + debounce 通知 host
              // adapter 重建 graph.json / SQLite synapse 表(派生层与真理层对齐)。
              // 历史盲区:原版只清 cache,graph.json 长期陈旧 → viewer 贡献者排名错。
              this.invalidateSynapseCache();
              this.scheduleSynapseRebuild();
              return;
            }
            if (!filename.endsWith(".md")) return;
          }
          this.scheduleDataScan();
        },
      );
      this.dataWatcher.on("error", () => {
        this.dataWatcher = undefined;
      });
    } catch {
      // 平台不支持 recursive fs.watch → 降级,功能不阻塞
      this.dataWatcher = undefined;
    }
  }

  /**
   * Debounce 扫描,合并短时间内的多次 .md 变化事件。
   *
   * git pull / rsync 等批量操作会一次性产生几十~几百个事件,逐个扫描会卡死。
   * 2000ms debounce 既合并事件,也给 post-merge hook(post-merge 在 git pull
   * 完成后同步执行)足够时间完成可信路径的 index 写入,避免 watcher 与
   * post-merge 同时处理同一批文件造成竞争。
   */
  private scheduleDataScan(): void {
    if (this.dataRebuildTimer) clearTimeout(this.dataRebuildTimer);
    this.dataRebuildTimer = setTimeout(() => {
      this.dataRebuildTimer = undefined;
      // 删除方向:清理「index 有但文件被外部 rm」的孤儿 entry。
      // 不依赖 externalMarkdownHook —— 索引一致性是基础保证。
      // 必须放在 scanForExternalMarkdown 之前:若同一文件既被 rm 又被 cp
      // 回来(罕见 race),先清孤儿再检测新增,顺序符合「先减后加」语义。
      try {
        this.scanForDeletedEngrams();
      } catch {
        // 扫描失败不能阻塞 watcher 后续触发,静默吞掉(下次事件再次尝试)
      }
      // 修改方向:已 tracked 的 .md 被外部编辑(Edit / git pull / IDE 写入),
      // mtime 变但文件仍在 index 中 → 重读 frontmatter 同步到 SQLite 派生层。
      // 解决 index-no-truth:外部编辑不经过 mutateFrontmatter,SQLite 字段
      // (createdBy / importance 等)长期陈旧 → viewer 贡献者排名错。
      try {
        this.scanForModifiedEngrams();
      } catch {
        // 同上
      }
      // 新增方向:检测「.md 存在但 index 无」的新文件,通知 host 走提案审批。
      // 依赖 externalMarkdownHook:无 hook 时 noop。
      try {
        this.scanForExternalMarkdown();
      } catch {
        // 同上
      }
      // 新增方向(skill):检测「dataRoot 下含 SKILL.md 的新目录」,通知 host 走 skill 提案审批。
      // scanForExternalMarkdown 主动排除 skill 目录,故 skill 目录只能由 scanForSkills
      // 捕获;此处补扫,覆盖 daemon/mcp-server 运行期间新增 skill 目录(用户粘贴 skill)。
      // 依赖 skillHook:无 hook 时 scanForSkills 内部 noop(首行 if (!this.skillHook) return)。
      try {
        this.scanForSkills();
      } catch {
        // 扫描失败不阻塞 watcher 后续触发,静默吞掉(下次事件再次尝试)
      }
    }, 2000);
  }

  /**
   * Debounce synapse 派生层重建通知。
   *
   * .yaml 文件批量变化(git pull / rsync)合并为一次 listener 调用,
   * 让 host adapter 一次性重建 graph.json + SQLite synapse 表,避免逐文件
   * 全量扫盘。listener 自身负责幂等(运行中触发的新事件不会重复重建)。
   */
  private scheduleSynapseRebuild(): void {
    if (this.synapseRebuildTimer) clearTimeout(this.synapseRebuildTimer);
    this.synapseRebuildTimer = setTimeout(() => {
      this.synapseRebuildTimer = undefined;
      for (const cb of this.synapseChangeListeners) {
        try {
          cb();
        } catch {
          // listener 内部异常不影响其他 listener 与 repository 主流程
        }
      }
    }, 2000);
  }

  /**
   * 扫描 dataRoot 下所有 .md,diff 出"未在 index 中的 .md",逐个调用
   * externalMarkdownHook(若设置)。
   *
   * 关键不变量:
   *   - **不**写 engram-index.json(防止 untrusted .md 直接进 index)
   *   - **不**调用 getIndex() — getIndex 在 index.json 缺失时会触发 rebuildIndex
   *     把所有合法 .md 灌入,这会让"未追踪"判定全部失效。这里直接读
   *     index.json,不存在则视为空集合,所有 .md 都视为未追踪。
   *   - 已在 index.json 中的 .md → noop(post-merge 或 engram_create 已处理)
   *   - 未设置 hook → noop(等价于"未启用外部提案",安全默认)
   *   - hook 自身负责去重(典型:ProposalEngine.proposeExternalMarkdown
   *     检查 proposal 状态:pending/accepted/dismissed 都返回 no-change)
   *
   * 性能:全量扫盘读所有 .md,大仓库(>10k 文件)可能耗时数百毫秒。
   * 可接受因为:(1) 2s debounce 已经限频;(2) post-merge hook 通常先完成,
   * 大部分 .md 已在 index,scan 仅对增量做 hook 调用。
   */
  private scanForExternalMarkdown(): void {
    if (!this.externalMarkdownHook) return;
    // 直接读 index.json(getIndex 会触发 rebuild,污染"未追踪"判定)
    const knownPaths = new Set<string>();
    const knownIds = new Set<StableEngramId>();
    try {
      const raw = readEngramIndex(this.config.rootPath);
      for (const entry of raw.entries.values()) {
        knownPaths.add(entry.path);
        knownIds.add(entry.id);
      }
    } catch {
      // index.json 不存在或损坏 → 视为空集合,所有 .md 都未追踪
    }
    const root = this.config.rootPath;
    const mdFiles = collectMarkdownFiles(root);
    const skillRoots = collectSkillDirs(root); // 解冲突：收集 skill 目录，用于排除
    for (const absPath of mdFiles) {
      const relPath = relative(root, absPath).split(sep).join("/");
      // 解冲突：skill 目录下的文件不进 external-markdown 提案（由 scanForSkills 统一处理）
      if (isUnderSkillRoot(relPath, skillRoots)) continue;
      if (knownPaths.has(relPath)) continue;
      let raw: string;
      try {
        raw = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      // parsed 取值:isEngramFile=true(合法 engram)→ parseEngramFile 结果;
      // 裸 md / 解析失败 → null。注意下方无条件通知 hook —— 裸 md 也会进入提案
      // 流程(hook 路径 2 走 LLM/规则提取),accept 时由 adoptOrPromoteEngramAt 原地纳管。
      let parsed: EngramFile | null = null;
      if (isEngramFile(raw)) {
        try {
          parsed = parseEngramFile(raw);
        } catch {
          parsed = null;
        }
      }
      // 防御:合法 engram 且 stable id 已在 index → 已入库(路径未同步 / 迁移漏判 /
      // scanForDeletedEngrams 被异常跳过)。守住「已 accept 的 engram 不因路径变更
      // 复活成 proposal」的不变量,不依赖上游时序。外部 cp 进来的带 id .md(id 不在
      // index)仍走提案,语义不变。
      const parsedId = parsed?.frontmatter.id;
      if (
        parsed &&
        typeof parsedId === "string" &&
        isStableEngramId(parsedId) &&
        knownIds.has(parsedId)
      ) {
        continue;
      }
      try {
        this.externalMarkdownHook({ absPath, relPath, raw, parsed });
      } catch {
        // hook 内部异常不影响其他文件的通知
      }
    }
  }

  /**
   * 扫描 skill 目录，调用 skillHook。
   *
   * 只读 SKILL.md（解析传给 hook），不写。
   */
  private scanForSkills(): void {
    if (!this.skillHook) return;
    const root = this.config.rootPath;
    const skillDirs = collectSkillDirs(root);
    for (const sourcePath of skillDirs) {
      const absPath = sourcePath === "." ? join(root, SKILL_MD_FILENAME) : join(root, sourcePath, SKILL_MD_FILENAME);
      let raw: string;
      try {
        raw = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      try {
        this.skillHook({ absPath, relPath: sourcePath, raw });
      } catch {
        // hook 内部异常不影响其他 skill 目录的通知
      }
    }
  }

  /**
   * 扫描 engram-index.json 中所有 entry,检测「index 有记录但磁盘文件已不存在」
   * 的孤儿,逐条复用 deleteEngram 清理(engram-index.json + SQLite + synapse +
   * truthPaths cache 一致更新)。
   *
   * 触发场景:用户 / 外部进程绕过 deleteEngram 直接删除 .md 文件
   * (rm / git rm / rsync --delete / IDE 删除 等)。dataWatcher 监听到 .md 变化
   * 后由 scheduleDataScan 触发本方法,2 秒 debounce 合并批量事件。
   *
   * 与 scanForExternalMarkdown 的对称关系:
   *   - scanForExternalMarkdown:处理「新增」方向(.md 存在,index 无)→ 走
   *     externalMarkdownHook 提案审批(安全:防止 untrusted .md 投毒)
   *   - scanForDeletedEngrams:处理「删除」方向(index 有,.md 不存在)→
   *     直接清,不需要 hook 审批(删除是减少,与新增方向相反,无投毒风险)
   *
   * 不依赖 externalMarkdownHook:即使 host 未启用外部提案(未设 hook),删除
   * 同步依然生效。索引一致性是基础保证,不应因 host 配置缺失而破坏。
   *
   * 性能:O(|index|) existsSync 调用,1000 engram ~ 1-5ms。
   * 失败语义:单条 deleteEngram 异常不阻塞其他孤儿,try/catch 静默吞错,
   * 下次扫描重试。幂等:已清的 entry 下次扫描时不在 index 中,自然跳过。
   *
   * Bug 历史(2026-07 用户报告):用户从 shell 直接 rm 了 .md 文件后,
   * viewer 列表/统计栏仍显示该 engram(SQLite indexDb 与 engram-index.json
   * 均未同步),点击详情 404(走文件读取)。根因:dataWatcher 故意不写
   * index(防 untrusted 投毒),只处理「新增」方向走 hook,「删除」方向
   * 完全未处理。本方法补齐删除方向的自动同步。
   */
  private scanForDeletedEngrams(): void {
    // 直接读 index.json(不调 getIndex —— getIndex 在 index.json 缺失时会
    // 触发 rebuildIndex,把所有合法 .md 灌入,污染孤儿判定)。
    // index.json 损坏时 readEngramIndex 抛错,catch 后跳过本次扫描。
    let index: EngramIndexMap;
    try {
      index = readEngramIndex(this.config.rootPath);
    } catch {
      return;
    }
    const root = this.config.rootPath;
    // 磁盘合法 engram 的 id→path 映射,用于区分「路径迁移」与「真删除」。
    // engram 的稳定身份是 frontmatter 的 stable id(ULID),path 只是当前位置
    // (EngramIndexEntry.path 注释:可能因人类操作而变化)。原实现只看 entry.path
    // 是否存在 → 重命名目录 / 移动文件会让整批已 accept 的 engram 被判为孤儿,
    // 触发 deleteEngram(误删 synapse / SQLite / 磁盘文件),随后被
    // scanForExternalMarkdown 当成新文件重新提案。改用 stable id 判定:
    // id 仍在磁盘 → 路径迁移,只更新 entry.path;id 不在 → 真删除。
    const diskIds = this.collectDiskEngramIds();
    // 先收集再清理:readEngramIndex 快照不会被 deleteEngram 修改,先收集让语义清晰。
    const orphans: StableEngramId[] = [];
    let moved = false;
    for (const [id, entry] of index.entries) {
      // path 校验:理论上是 trusted,但 doctor 自愈后可能含异常路径
      if (!isPathWithinRoot(root, entry.path)) continue;
      const absPath = safeJoinWithinRoot(root, entry.path);
      if (existsSync(absPath)) continue; // 原路径还在 → 非孤儿,交给 scanForModifiedEngrams
      // 原路径消失:stable id 仍在磁盘 → 路径迁移;否则 → 真删除
      const diskPath = diskIds.get(id);
      if (diskPath && diskPath !== entry.path) {
        // 路径迁移:id 不变,只更新 entry.path + 刷新 mtime。
        // 不调 deleteEngram —— SQLite EngramIndexEntry 无 path 字段(index-db.ts),
        // 迁移无需动派生层;调 deleteEngram 反会误删 synapse / SQLite / 磁盘文件。
        let mtime = entry.mtime;
        try {
          mtime = statSync(safeJoinWithinRoot(root, diskPath)).mtimeMs;
        } catch {
          // 用旧 mtime 兜底,scanForModifiedEngrams 下轮校正
        }
        index.entries.set(id, { ...entry, path: diskPath, mtime });
        moved = true;
      } else {
        orphans.push(id);
      }
    }
    if (moved) {
      this.persistIndex(index);
    }
    for (const id of orphans) {
      try {
        // 复用 deleteEngram 的完整清理流程。deleteEngramFile 已 idempotent
        // (existsSync 检查),文件不存在时 noop,后续 SQLite/synapse/cache
        // 步骤照常执行。
        this.deleteEngram(id);
      } catch {
        // 部分清理失败不阻塞其他孤儿,下次扫描重试
      }
    }
  }

  /**
   * 扫描 dataRoot 下所有合法 engram 文件,返回 stable id → 相对路径 映射。
   * 供 scanForDeletedEngrams 区分「路径迁移」(id 仍在磁盘)与「真删除」。
   *
   * 只收集合法 engram(isEngramFile + 合法 ULID frontmatter.id);裸 md / 残缺
   * frontmatter 无稳定 id,不参与迁移判定(仍由 scanForExternalMarkdown 走提案)。
   * 同 id 多文件(duplicate_id)取首次出现,不覆盖 —— doctor 会单独报告并处理。
   */
  private collectDiskEngramIds(): Map<StableEngramId, string> {
    const root = this.config.rootPath;
    const mdFiles = collectMarkdownFiles(root);
    const disk = new Map<StableEngramId, string>();
    for (const absPath of mdFiles) {
      let raw: string;
      try {
        raw = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      if (!isEngramFile(raw)) continue;
      let parsed: EngramFile;
      try {
        parsed = parseEngramFile(raw);
      } catch {
        continue;
      }
      const id = parsed.frontmatter.id;
      if (!id || !isStableEngramId(id)) continue;
      if (disk.has(id)) continue;
      const relPath = relative(root, absPath).split(sep).join("/");
      disk.set(id, relPath);
    }
    return disk;
  }

  /**
   * 扫描 engram-index.json 中所有 entry,检测「文件 mtime 比 index entry 新」
   * 的已 tracked engram → 重读 frontmatter + syncEngramToIndex 把派生层
   * (SQLite engrams 表)字段(createdBy / importance / status 等)同步到最新。
   *
   * 触发场景:用户 / 外部进程通过 Edit / IDE / sed 等绕过 mutateFrontmatter
   * 直接改 .md frontmatter 字段(典型:改 `创建者` / `重要性` 等)。dataWatcher
   * 监听到 .md 变化后由 scheduleDataScan 触发本方法。
   *
   * 与 scanForDeletedEngrams / scanForExternalMarkdown 的对称关系:
   *   - scanForDeletedEngrams:删除方向(index 有,.md 不存在)
   *   - scanForExternalMarkdown:新增方向(.md 存在,index 无,走 hook 审批)
   *   - scanForModifiedEngrams:**修改方向**(index 有,.md 也有但 mtime 更新)
   *     → 直接同步,不需 hook 审批(文件已 trusted,只是字段刷新)
   *
   * 不依赖 externalMarkdownHook:索引一致性是基础保证。无 indexDb 时 noop
   * (无 SQLite 派生层需要同步,文件本身就是 truth)。
   *
   * 性能:O(|index|) statSync 调用,1000 engram ~ 5ms。mtime 未变的跳过
   * (覆盖 99% false-positive watcher 事件,例如 ls / cat 不改 mtime)。
   * 失败语义:单条 syncEngramToIndex 异常不阻塞其他 entry,try/catch 静默吞错,
   * 下次扫描重试。幂等:同一文件多次同步写同样的字段值(SQLite upsert)。
   *
   * Bug 历史(2026-07 用户报告):用户用 Edit 工具改 8 个 .md 的 `创建者` 字段
   * 后,viewer 贡献者排名仍显示旧作者。根因:dataWatcher 收到 .md 事件后,
   * scanForExternalMarkdown 看到文件已 tracked 直接 noop,SQLite engrams.created_by
   * 长期陈旧。本方法补齐修改方向的自动同步。
   */
  private scanForModifiedEngrams(): void {
    if (!this.indexDb) return; // 无 SQLite 派生层 → 无需同步,文件即 truth
    // 直接读 index.json(不调 getIndex —— 同 scanForDeletedEngrams 的考量)
    let index: EngramIndexMap;
    try {
      index = readEngramIndex(this.config.rootPath);
    } catch {
      return;
    }
    const root = this.config.rootPath;
    for (const [, entry] of index.entries) {
      if (!isPathWithinRoot(root, entry.path)) continue;
      const absPath = safeJoinWithinRoot(root, entry.path);
      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue; // 文件不存在或不可读 → 留给 scanForDeletedEngrams 处理
      }
      // mtime 没变 → 跳过(false-positive watcher 事件 / ls / cat 等)
      if (stat.mtimeMs === entry.mtime) continue;
      // mtime 变了 → 重读 frontmatter,触发 SQLite 同步
      try {
        const file = readEngramFile(absPath);
        this.syncEngramToIndex(file.frontmatter, file.content);
      } catch {
        // 文件损坏(parse 错)留给 doctor 处理,下次扫描重试
      }
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
    if (this.dataWatcher) {
      try {
        this.dataWatcher.close();
      } catch {
        // ignore
      }
      this.dataWatcher = undefined;
    }
    if (this.dataRebuildTimer) {
      clearTimeout(this.dataRebuildTimer);
      this.dataRebuildTimer = undefined;
    }
    if (this.synapseRebuildTimer) {
      clearTimeout(this.synapseRebuildTimer);
      this.synapseRebuildTimer = undefined;
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

  /**
   * 注册 synapse 变更 listener — 在 .yaml 文件被外部修改(git pull / Edit 等)
   * 触发 dataWatcher 后,经 2s debounce 被调用。
   *
   * 主要用途:host adapter 在此 listener 中触发 IndexOrchestrator 重建
   * graph.json + SQLite synapse 表,让派生层与 .yaml 真相层重新对齐。
   *
   * 跨进程:plugin 进程改 .yaml → mcp 进程 dataWatcher 触发 → listener
   * 重建派生层。listener 内部应自行处理跨进程竞态(SQLite WAL 幂等保护)。
   *
   * @returns 取消注册函数(用于测试隔离或资源释放)
   */
  addSynapseChangeListener(cb: () => void): () => void {
    this.synapseChangeListeners.push(cb);
    return () => {
      const idx = this.synapseChangeListeners.indexOf(cb);
      if (idx >= 0) this.synapseChangeListeners.splice(idx, 1);
    };
  }

  /** 解析 stableId → 相对路径 */
  private resolvePath(stableId: string): string | undefined {
    if (!isStableEngramId(stableId)) {
      // 兼容:可能是相对路径,直接当 path 用。
      // 但必须先校验路径在 root 内(防 `..` 逃逸,path traversal 防御)
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
    // safeJoinWithinRoot 拦截 `..` 逃逸与绝对路径(path traversal 防御)
    const relativePath = input.pathHint ?? this.deriveDefaultPath(input);
    const absolutePath = safeJoinWithinRoot(this.config.rootPath, relativePath);

    if (existsSync(absolutePath)) {
      throw validationError(`Engram already exists at ${relativePath}`);
    }

    // 自愈:外部 rm / git 操作可能让 engram-index.json 残留指向同 path
    // 但磁盘已无文件的孤儿 entry。新 ULID 写入后会留下永不消失的"重影"
    // (listEngrams / viewer 显示重复节点)。在写入前清理。engram_doctor
    // 是手动巡检版本,此处是写入路径的自动防线。
    this.purgeStaleIndexEntriesForPath(relativePath);

    const frontmatter = this.buildEngramFrontmatter(input, {
      stableId,
      timestamp,
      sourceType,
      contentHash,
      contentSize,
    });

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

    // Task 1.5:同步投影到 SQLite 索引层(若注入)
    this.syncEngramToIndex(frontmatter, input.content);

    // Task 3.4 Phase B:engram 创建后 emit,让 prompt-signals cache 失效并 debounced rebuild
    safeEmit({
      type: "engram_created",
      engramId: stableId,
      at: new Date().toISOString(),
    });

    // 失效 truthPaths cache:dedupe 路径可能在文件写入前填充了空 set,
    // 不失效会让 5s 内的 listEngrams/queryEngramsForList 漏掉这条新 engram。
    this.invalidateTruthPathsCache();

    return this.readEngram(stableId);
  }

  /**
   * 从 EngramCreateInput 构建 frontmatter（纯逻辑，不写文件 / 不入索引）。
   *
   * createEngram 与 adoptOrPromoteEngramAt（原地提升裸 md）共用，避免 frontmatter
   * 字段构建逻辑重复。任一处新增 frontmatter 字段时，两处同步生效。
   */
  private buildEngramFrontmatter(
    input: EngramCreateInput,
    ctx: {
      readonly stableId: StableEngramId;
      readonly timestamp: string;
      readonly sourceType: EngramSourceType;
      readonly contentHash: string;
      readonly contentSize: number;
    },
  ): EngramFrontmatter {
    const hasExplicitDomainTags = input.domainTags.length > 0;
    return {
      id: ctx.stableId,
      title: input.title,
      kind: input.kind,
      kinds: input.kinds ?? [input.kind],
      tags: input.contextTags,
      domainTags: hasExplicitDomainTags ? input.domainTags : undefined,
      summary: input.summary ?? deriveAutoSummary(input.content, input.title),
      contentHash: ctx.contentHash,
      contentSize: ctx.contentSize,
      createdBy: input.createdBy,
      createdAt: ctx.timestamp,
      updatedBy: input.createdBy,
      updatedAt: ctx.timestamp,
      version: 1,
      importance: input.importance ?? DEFAULT_IMPORTANCE,
      confidence: input.confidence ?? DEFAULT_CONFIDENCE_BY_SOURCE[ctx.sourceType],
      sourceType: ctx.sourceType,
      evidenceCount: 0,
      retrievalCount: 0,
      effectiveRetrievals: 0,
      failedUses: 0,
      reinforcementScore: 0,
      lastRetrievalScore: 0.5,
      status: "active",
      visibility: input.visibility ?? "public",
      verificationStatus: "unverified",
      encodingContext: input.encodingContext,
      perspective: input.perspective,
      contextTags: input.contextTags,
    };
  }

  /**
   * 默认路径:{domainTags.join('/')/}{slug}.md
   *
   * private engram 自动落 `private/` 子目录(被 .gitignore 隔离出团队仓库)。
   * 注意:本函数只用于「无 pathHint」场景;调用方传 pathHint 时直接尊重用户路径,
   * 不会自动加 private 前缀(避免 `private/private/...` 双前缀)。
   */
  private deriveDefaultPath(input: EngramCreateInput): string {
    const slug = slugify(input.title);
    // AI-10 路径分裂修复:domainTags 先按 Unicode 字母序排序,再拼路径。
    // 旧实现直接用 raw 顺序,导致同语义不同顺序的 tag 集合产生不同的目录树:
    //   ["协作原则","方法论","设计原则"] → 协作原则/方法论/设计原则/<slug>.md
    //   ["协作原则","设计原则","方法论"] → 协作原则/设计原则/方法论/<slug>.md
    // 这是路径分裂的根因 —— 排序后两者都归一到 协作原则/方法论/设计原则/。
    // domainTags 概念上是「无序集合」,frontmatter 仍按用户原始顺序保留(信息无损),
    // 只在路径派生时规范化,不影响展示语义。
    const sortedDomains = [...input.domainTags].sort();
    const parts = [...sortedDomains, `${slug}.md`];
    const basePath = parts.join("/");
    return input.visibility === "private" ? `private/${basePath}` : basePath;
  }

  /**
   * 读取完整 Engram(单文件 + 统计)
   *
   * ⚠️ **禁止在循环里调用**(2026-07 N+1 系统性 bug 教训):
   * 每次调用 = 3× readFileSync(content.md + meta.yaml + synapses.yaml)
   * + YAML parse + delocalizeKeys + assembleEngram(扫 synapses/ 目录)。
   * N=1026 时单次循环 ~30s,会让 viewer event loop 卡死。
   *
   * 替代 API(按字段需求选):
   *   - catalog 字段(id/title/kind/domainTags)→ listEngrams() 或 listEngramIndex()
   *     (后者还含 contentHash/slug/mtime/path,已是内存扫,无 I/O)
   *   - digest 字段(status/kind/kinds/summary/domainTags/contextTags/importance/
   *     confidence/freshness/sourceType/createdBy/createdAt/updatedAt/
   *     lastRetrievedAt/lastEffectiveAt/retrievalCount/effectiveRetrievals/
   *     failedUses/reinforcementScore/contentSize/contentHash/
   *     outgoingSynapseCount/incomingSynapseCount/activeContradictionCount/
   *     verificationStatus)→ readDigestBatch(ids)(SQLite WHERE IN,500/批)
   *   - content + title + summary → readContentBatch(ids)
   *
   * 单条且明确不在循环里(例如 engram_get 工具按用户传入的 id 读一条)用本方法 OK。
   */
  readEngram(stableId: string): Engram {
    const relativePath = this.resolvePath(stableId);
    if (!relativePath) {
      throw notFoundError("Engram", stableId);
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
      throw notFoundError("Engram", stableId);
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
    const newImportance =
      input.importance ?? oldFrontmatter.importance ?? DEFAULT_IMPORTANCE;
    const newConfidence =
      input.confidence ??
      oldFrontmatter.confidence ??
      DEFAULT_CONFIDENCE_BY_SOURCE.firsthand;
    const newVisibility =
      input.visibility ?? oldFrontmatter.visibility ?? "public";
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
      visibility: newVisibility,
      encodingContext: newEncodingContext,
      perspective: newPerspective,
      contextTags: newContextTags,
    };

    // 处理 slug 变化:title 变 + slug 未锁定 → 重新 slugify + rename
    const oldSlug = oldFrontmatter.slug ?? slugify(oldFrontmatter.title);
    const newSlugUnlocked =
      oldFrontmatter.slug === undefined
        ? slugify(newTitle)
        : oldFrontmatter.slug;

    // 处理 visibility 变化:public/team/restricted ↔ private → 路径前缀调整
    // (private engram 落 `private/` 子目录,变更 visibility 时同步迁移路径)
    const oldVisibility = oldFrontmatter.visibility ?? "public";
    const visibilityChanged = newVisibility !== oldVisibility;

    // 单向闸门:禁止任何非-private visibility 降级为 private。
    // private 路径进 .gitignore,降级会隐性删除其他成员工作树中的该记忆。
    // 仅当调用方显式传入 visibility 且与当前不同时触发(避免 no-op 与 fallback 干扰)。
    if (input.visibility !== undefined && input.visibility !== oldVisibility) {
      assertVisibilityTransitionAllowed(oldVisibility, input.visibility);
    }

    // slug + visibility 都可能触发 rename,正交串联应用
    let newPath = relativePath;
    if (newSlugUnlocked !== oldSlug) {
      newPath = this.rebuildPath(newPath, newSlugUnlocked);
    }
    if (visibilityChanged) {
      newPath = this.rebuildPathForVisibility(newPath, newVisibility);
    }

    const newFile: EngramFile = {
      frontmatter: newFrontmatter,
      content: newContent,
    };

    if (newPath !== relativePath) {
      const newAbsolutePath = join(this.config.rootPath, newPath);
      if (existsSync(newAbsolutePath)) {
        // 原子性保证:目标已存在就报错,不动旧文件
        throw validationError(`Rename conflict: ${newPath} already exists`);
      }
      writeEngramFile(newAbsolutePath, newFile, this.language);
      rmSync(absolutePath);
      // 旧路径孤儿 index entry 清理(原 updateEngram 漏了这一步):
      // rename 后旧 path 的反向 entry(path → stableId)若不清理,会留下
      // 「磁盘无文件但 index 有记录」的孤儿,listEngrams / viewer 会显示重影。
      this.purgeStaleIndexEntriesForPath(relativePath);
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

    // Task 1.5:同步投影到 SQLite 索引层(若注入)
    this.syncEngramToIndex(newFrontmatter, newContent);

    // 失效 truthPaths cache:rename 场景下旧路径已 rmSync,新路径已 writeEngramFile,
    // 旧 cache(可能含旧 path 或缺新 path)不再准确。update 场景(path 不变)也
    // 失效,因为 doctor / external edit 可能改了文件,mtime 变化不反映在 set 上。
    this.invalidateTruthPathsCache();

    return this.readEngram(stableId);
  }

  /** 重新组装路径:替换 basename 为 newSlug */
  private rebuildPath(oldRelativePath: string, newSlug: string): string {
    const parts = oldRelativePath.split("/");
    parts[parts.length - 1] = `${newSlug}.md`;
    return parts.join("/");
  }

  /**
   * 调整路径的 visibility 前缀(不改动 basename):
   * - `'private'` → 加 `private/` 前缀(若已含则幂等返回原值)
   * - 其他(`'public'`/`'team'`/`'restricted'`) → 移除 `private/` 前缀(若不含则幂等返回)
   *
   * 用于 updateEngram 中 visibility 变更时的路径迁移。
   * 注意:仅处理前缀,basename 由 rebuildPath 负责,两者正交可串联应用。
   */
  private rebuildPathForVisibility(
    path: string,
    visibility: EngramVisibility,
  ): string {
    const PRIVATE_PREFIX = "private/";
    if (visibility === "private") {
      return path.startsWith(PRIVATE_PREFIX)
        ? path
        : `${PRIVATE_PREFIX}${path}`;
    }
    return path.startsWith(PRIVATE_PREFIX)
      ? path.slice(PRIVATE_PREFIX.length)
      : path;
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
    // F3 修复(race window 缩小):删除顺序从「文件 → synapse → index」改为
    // 「index → 文件 → synapse」。
    //
    // 原顺序的最坏情况:「文件已删 + index 未删」中间态 → doctor 的
    // missing_file 检测要求文件确实不存在,但 race 中另一进程可能恢复
    // 文件,导致 doctor 看不到问题;同时该 engram 在 listEngrams 中仍可见。
    //
    // 新顺序的最坏情况:
    //   - index 删 + 文件未删 → orphan_markdown,doctor 能修(已支持)
    //   - 文件删 + synapse 未删 → dangling_synapse,doctor 能修(已支持)
    // 两种失败模式都被 doctor 覆盖,无 fail-silent 漏洞。
    //
    // relativePath 必须先缓存:deleteIndexEntry 后再调 resolvePath 会因
    // index 中已无 entry 而返回 undefined,导致后续步骤无法定位文件。
    if (isStableEngramId(stableId)) {
      this.deleteIndexEntry(stableId as StableEngramId);
    }
    const absolutePath = join(this.config.rootPath, relativePath);
    deleteEngramFile(absolutePath);
    this.deleteSynapsesTouching(stableId);

    // Task 1.5:从 SQLite 索引层删除(若注入)。domains / synapses 由外键
    // ON DELETE CASCADE 自动清,FTS 显式删;主表 + FTS 都包在 IndexDb 内部
    // 事务里。
    if (this.indexDb) {
      try {
        this.indexDb.deleteEngram(stableId);
      } catch {
        // 派生数据失败不阻塞
      }
    }

    // 失效 truthPaths cache:文件刚删除,5s 内的 cache 含幽灵 path,
    // 不失效会让 listEngrams 在 cache 窗口内仍返回该 entry(再走 readEngram 抛错)。
    this.invalidateTruthPathsCache();
  }

  /**
   * 批量删除 engram(2026-07 修复 Bug #6:回收站清空很慢)。
   *
   * 单条 deleteEngram 的瓶颈是 persistIndex(全量写 engram-index.json):
   *   - N 条回收站 → N 次 deleteEngram → N 次 persistIndex
   *   - 单次写盘 ~30-80ms(index.json ~1MB),N=267 时累计 8-22 秒
   *   - 期间 HTTP 服务器被单条同步 fs 操作阻塞,前端 fetch 超时(Bug #7)
   *
   * 批量优化:把 N 次 persistIndex 合并成 1 次。其余操作(deleteEngramFile /
   * deleteSynapsesTouching / indexDb.deleteEngram)各自已经够快(SQLite
   * fast path),保留逐条调用。
   *
   * 删除顺序与单条 deleteEngram 一致(index → 文件 → synapse),只是 index
   * 移除合并成一次。失败模式与单条相同,doctor 仍可自愈。
   *
   * 返回:实际删除的 stableId 数(部分项 resolvePath 失败会跳过)。
   */
  deleteEngramsBatch(stableIds: readonly string[]): string[] {
    if (stableIds.length === 0) return [];
    const deleted: string[] = [];
    const neighborsToRefresh = new Set<string>();

    // (1) 一次性批量从 index 移除并 persistIndex(关键优化)
    const index = this.getIndex();
    const relativePaths = new Map<string, string>();
    for (const id of stableIds) {
      const rp = this.resolvePath(id);
      if (!rp) continue;
      relativePaths.set(id, rp);
      if (isStableEngramId(id)) {
        removeEngramIndexEntry(index, id as StableEngramId);
      }
    }
    if (relativePaths.size === 0) return [];
    this.persistIndex(index);

    // (2) 逐个删 .md(磁盘 IO,无法批量化)
    for (const [id, rp] of relativePaths) {
      const absolutePath = join(this.config.rootPath, rp);
      try {
        deleteEngramFile(absolutePath);
      } catch {
        // 文件可能已被并发删除,继续
      }
    }

    // (3) 逐个 deleteSynapsesTouching(已走 SQLite fast path,O(log N))
    //     但 refreshObsidianLinks 逐条调;这里收集 neighbors,最后合并 refresh。
    for (const id of relativePaths.keys()) {
      // 直接调内部逻辑(不通过 this.deleteSynapsesTouching 以合并 refresh)
      let touching: { outgoing: Synapse[]; incoming: Synapse[] };
      if (this.indexDb) {
        try {
          touching = this.listSynapsesForEngramFromIndex(id);
        } catch {
          touching = listSynapsesForEngram(this.config.rootPath, id);
        }
      } else {
        touching = listSynapsesForEngram(this.config.rootPath, id);
      }
      for (const s of touching.outgoing) {
        if (s.to !== id) neighborsToRefresh.add(s.to);
      }
      for (const s of touching.incoming) {
        if (s.from !== id) neighborsToRefresh.add(s.from);
      }
      const all = [...touching.outgoing, ...touching.incoming];
      const seen = new Set<string>();
      for (const s of all) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const synPath = join(
          this.config.rootPath,
          synapseRelativePath(s.id, s.kind),
        );
        try {
          deleteSynapseFile(synPath);
        } catch {
          // 文件可能已被并发删除
        }
      }

      // (4) SQLite 删(逐条,但每条 O(log N))
      if (this.indexDb) {
        try {
          this.indexDb.deleteEngram(id);
        } catch {
          // 派生数据失败不阻塞
        }
      }
      deleted.push(id);
    }

    // (5) 合并邻居派生段刷新(O(K) 次,而非 O(N×K))
    if (neighborsToRefresh.size > 0) {
      this.refreshObsidianLinks(...neighborsToRefresh);
    }
    this.invalidateSynapseCache();
    this.invalidateTruthPathsCache();

    return deleted;
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

  /**
   * 把已存在的 .md 文件(orphan — 在磁盘但未在 engram-index.json / SQLite)
   * 正式纳入 index + SQLite,返回对应的 Engram。
   *
   * 触发场景(2026-07 修复 batch accept bug):
   *   - external-markdown proposal 来自 watcher 扫描「在 dataRoot 但不在 index」
   *     的 .md 文件。用户 accept 时 createEngram 会因 path 冲突抛错。
   *   - 旧实现整个 accept 失败,proposal 状态不变,batch accept 30 个只有
   *     N 个真正 path-new 的成功 → totalEngrams 增量远小于 30。
   *   - 新路径:proposal-engine.accept 捕获 conflict 错误,调本方法 adopt
   *     现有 .md,让 accept 完成 + orphan 计入 totalEngrams。
   *
   * 行为:
   *   - .md 不存在 / 解析失败 → undefined
   *   - id 已在 index(被 doctor 或先前 accept 处理过)→ 幂等 noop,只读返回
   *   - id 不在 index → 加 index.json + 同步 SQLite + 失效 truthPaths cache
   *
   * 与 createEngram 区别:不写新文件、不生成新 ULID、不动 frontmatter,
   * 只把磁盘上已有的 engram 文件登记到派生索引。
   */
  ingestExistingEngramFile(relativePath: string): Engram | undefined {
    if (!isPathWithinRoot(this.config.rootPath, relativePath)) return undefined;
    const absolutePath = safeJoinWithinRoot(this.config.rootPath, relativePath);
    if (!existsSync(absolutePath)) return undefined;
    let file: EngramFile;
    try {
      file = readEngramFile(absolutePath);
    } catch {
      return undefined;
    }
    const engram = this.assembleEngram(file, relativePath);
    const id = engram.id;

    // 幂等:id 已在 index → 只读返回(典型:doctor 已处理 / 别的 accept 刚 adopt 过)
    const index = this.getIndex();
    if (index.entries.has(id)) {
      return engram;
    }

    // 自愈:旧 entry 指向同 path 但不同 id(rare 不变量破坏)→ 清掉
    this.purgeStaleIndexEntriesForPath(relativePath);

    const stat = statSync(absolutePath);
    const contentHash =
      file.frontmatter.contentHash ?? computeContentHash(file.content);
    const entry = buildIndexEntryFromFrontmatter({
      relativePath,
      frontmatter: file.frontmatter,
      mtime: stat.mtimeMs,
      contentHash,
    });
    this.updateIndexEntry(entry);
    this.syncEngramToIndex(file.frontmatter, file.content);

    safeEmit({
      type: "engram_created",
      engramId: id,
      at: new Date().toISOString(),
    });
    this.invalidateTruthPathsCache();

    return engram;
  }

  /**
   * 在指定路径原地纳管源文件为 engram（external-markdown 提案 accept 用）。
   *
   * 与 createEngram 的区别：目标路径由调用方指定（= proposal.payload.sourcePath，
   * 即用户手动放入 dataRoot 的原文件位置），不重新推导到 imported/ 下。这样 accept
   * 后原文件「目录不动」——裸 md 被原地提升为 engram，合法 engram orphan 被原地 adopt。
   *
   * 两种源文件形态：
   *   - 已是合法 engram（有 frontmatter + id）→ adopt：文件字节不动，登记入索引
   *     （复用 ingestExistingEngramFile 语义，含幂等）。
   *   - 裸 md（无 frontmatter / 解析失败）→ promote：用 input 生成 frontmatter，
   *     writeEngramFile 覆盖原文件（路径不变，原正文作为 content 保留），再入索引。
   *
   * @throws 路径逃逸 root 外（防 proposal.jsonl 被篡改做 path traversal）
   * @returns undefined 表示源文件不存在（虚拟 proposal / 已被外部删除），
   *          调用方应退化到 createEngram（默认路径），不阻塞 accept。
   */
  adoptOrPromoteEngramAt(
    relativePath: string,
    input: EngramCreateInput,
  ): Engram | undefined {
    if (!isPathWithinRoot(this.config.rootPath, relativePath)) {
      throw validationError(
        `adoptOrPromoteEngramAt: path escapes dataRoot (${relativePath})`,
      );
    }
    const absolutePath = safeJoinWithinRoot(this.config.rootPath, relativePath);
    if (!existsSync(absolutePath)) {
      return undefined;
    }

    const raw = readFileSync(absolutePath, "utf8");
    // 路径 1：合法 engram（完整 frontmatter + id，无 critical issue）→ 原地 adopt，
    // 文件字节不动（含幂等 noop）。用 isEngramFile 而非 readEngramFile 的异常判断：
    // readEngramFile 对裸 md / 残缺 frontmatter 容忍（返回带 _validationIssues 的残缺
    // EngramFile），会让 ingestExistingEngramFile 误 adopt 裸 md、跳过提升。
    if (isEngramFile(raw)) {
      const adopted = this.ingestExistingEngramFile(relativePath);
      if (adopted) return adopted;
      // 极罕见：isEngramFile=true 但 ingest 失败（并发修改）→ 落到 promote 重写
    }

    // 路径 2：裸 md / 格式不完整 → 原地提升（覆盖写 engram 格式，路径不变）
    // 自愈：清掉指向同 path 的 stale entry（同 createEngram 写入前防线）
    this.purgeStaleIndexEntriesForPath(relativePath);

    const stableId = ulid() as StableEngramId;
    const timestamp = now();
    const sourceType = input.sourceType ?? "firsthand";
    const contentHash = computeContentHash(input.content);
    const contentSize = computeContentSize(input.content);
    const frontmatter = this.buildEngramFrontmatter(input, {
      stableId,
      timestamp,
      sourceType,
      contentHash,
      contentSize,
    });

    const file: EngramFile = { frontmatter, content: input.content };
    writeEngramFile(absolutePath, file, this.language);

    const stat = statSync(absolutePath);
    const entry = buildIndexEntryFromFrontmatter({
      relativePath,
      frontmatter,
      mtime: stat.mtimeMs,
      contentHash,
    });
    this.updateIndexEntry(entry);
    this.syncEngramToIndex(frontmatter, input.content);
    safeEmit({
      type: "engram_created",
      engramId: stableId,
      at: new Date().toISOString(),
    });
    this.invalidateTruthPathsCache();

    return this.readEngram(stableId);
  }

  // ─── Engram Catalog / Digest ───────────────────────────────────────────

  /**
   * 列出所有真实存在文件的 engram(catalog 元数据)。
   *
   * Truth-filter(2026-07 viewer 性能修复):
   *   engram-index.json 是 cache 而非 truth,但历史上有"用户删了 .md 文件
   *   而 index 未同步 rebuild"的场景(例如 1026 entries 中 1000 条 ghost),
   *   导致 listEngrams() 返回 ghost,下游 /api/stats、/api/trash 等遍历又对
   *   每个 ghost 调 readEngram,引发 47~69 秒卡顿。
   *
   *   这里用 truthPaths(文件系统扫盘)做一次集合差集,只返回真实存在的 entry。
   *   truthPaths 5 秒 cache,避免每次调用都扫盘。
   *
   *   检测到 ghost 时,异步触发 rebuildIndex(self-heal),让下一次调用即拿到
   *   清理后的 index。
   */
  listEngrams(): EngramCatalogEntry[] {
    const result: EngramCatalogEntry[] = [];
    const truthPaths = this.getTruthPaths();
    let ghostDetected = false;
    const allEntries = [...this.getIndex().entries.values()];
    for (const entry of allEntries) {
      if (!truthPaths.has(entry.path)) {
        ghostDetected = true;
        continue;
      }
      result.push({
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        domainTags: entry.domainTags,
      });
    }
    if (ghostDetected) {
      // 异步 rebuild,不阻塞当前请求;下次调用即拿到清理后的 index
      queueMicrotask(() => {
        try {
          this.rebuildIndex();
        } catch {
          // rebuild 失败不阻塞;下次 listEngrams 会再次尝试
        }
      });
    }
    return result;
  }

  /**
   * 文件系统真相路径集合(相对 rootPath),5 秒 cache 避免每次调用都扫盘。
   *
   * 用于 listEngrams/listEngramIndex 的 truth-filter。cache 短是因为:
   *   - 长 cache 期间用户删除文件 → 仍可能返回 ghost
   *   - 短 cache 5s 内多次调用只在首次扫盘(~50ms / 1000 文件)
   */
  private truthPathsCache: { paths: Set<string>; ts: number } | null = null;
  private getTruthPaths(): Set<string> {
    const now = Date.now();
    if (this.truthPathsCache && now - this.truthPathsCache.ts < 5000) {
      return this.truthPathsCache.paths;
    }
    const paths = new Set<string>();
    const root = this.config.rootPath;
    for (const absPath of collectMarkdownFiles(root)) {
      const rel = relative(root, absPath).split(sep).join("/");
      paths.add(rel);
    }
    this.truthPathsCache = { paths, ts: now };
    return paths;
  }

  /**
   * 失效 truthPaths cache。在 engram 文件写入/删除/重命名后调用,
   * 避免下次 listEngrams/listEngramIndex 拿到过期(空或含幽灵)的 truth set。
   *
   * 关键场景(fa20704 引入 5s TTL 后暴露的 race):
   *   1. dedupe 路径(checkDuplicateSync → findExactHashMatch → listEngrams)
   *      在 createEngram 内部、文件写入**之前**触发 getTruthPaths
   *   2. 此时磁盘还没新 .md,getTruthPaths 把空 set cache 5 秒
   *   3. createEngram 写入文件,但 listEngrams 5 秒内仍命中空 cache → 0 条
   *
   * 同样适用于 deleteEngram / updateEngram(rename) / restoreFromTrash:
   * 写盘后立即失效,下次 listEngrams 重新扫盘。
   */
  private invalidateTruthPathsCache(): void {
    this.truthPathsCache = null;
  }

  /**
   * collectAllSynapses 的进程内 cache。
   *
   * Why: collectAllSynapses 扫 `synapses/{kind}/*.yaml`,1026 engrams × ~12 kinds
   * 的全量扫描在 reinforcement / tier-loader / metacognition / detector 等路径
   * 反复触发(line 1730 的 6 个 caller),是 P2 调用者 N+1 的根因。Synapse 写入
   * 频率远低于读取(用户显式操作 vs. 每次 engram_get / reinforce),适合 cache。
   *
   * 一致性:同进程内,所有 synapse 写方法(createSynapse / updateSynapse /
   * deleteSynapse / deleteSynapsesTouching / addOutgoing / removeOutgoing /
   * updateSynapseResolution)在落盘后调 invalidateSynapseCache()。
   * 跨进程:fs.watch 监听 synapses/ 下 .yaml 变化(见 startDataRootWatcher
   * filter 放行 .yaml)→ 外部进程写入触发本进程 invalidate。
   *
   * 不存 TTL:与 truthPathsCache 不同,synapse 文件结构稳定(ULID 文件名),
   * 不像 .md 路径会 rename;同进程 invalidate 是同步的,无 race 窗口。
   */
  private synapseCache: Array<{ fromId: string; synapse: Synapse }> | undefined;

  private invalidateSynapseCache(): void {
    this.synapseCache = undefined;
  }

  /**
   * 列表查询(viewer /api/engrams 用):支持过滤 / 排序 / cursor 分页,
   * 返回字段直接够 viewer 渲染(无需 N+1 readEngram)。
   *
   * 注入 indexDb 时走 SQL(5k+ scale),否则 fallback 到内存 listEngrams +
   * enriched N+1 readEngram(慢但小规模 OK,memory engine 场景)。两条路径
   * 返回 shape 一致,viewer 不感知后端差异。
   *
   * cursor 由 encodeQueryCursor 生成(见 index-db.ts),半开区间保证翻页稳定。
   * total 不依赖 cursor,UI 显示"共 N 条"用。
   */
  queryEngramsForList(opts: {
    readonly kind?: string;
    readonly domainTags?: readonly string[];
    readonly status?: readonly string[];
    readonly sort?:
      | "createdAt"
      | "updatedAt"
      | "importance"
      | "retrievalCount"
      | "title";
    readonly descending?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
  }): {
    readonly results: readonly EngramQueryRow[];
    readonly total: number;
    readonly nextCursor: string | null;
  } {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

    if (this.indexDb) {
      try {
        const { results, total } = this.indexDb.queryEngrams(opts);
        const last = results[results.length - 1];
        let nextCursor: string | null = null;
        if (results.length === limit && last) {
          const sortField = opts.sort ?? "updatedAt";
          const sortValue =
            sortField === "createdAt"
              ? last.createdAt
              : sortField === "importance"
                ? last.importance
                : sortField === "retrievalCount"
                  ? last.retrievalCount
                  : sortField === "title"
                    ? last.title
                    : last.updatedAt;
          nextCursor = encodeQueryCursor(sortValue, last.id);
        }
        return { results, total, nextCursor };
      } catch {
        // SQLite 查询失败 → fallback 到内存路径,viewer 仍可用
      }
    }

    // memory fallback:listEngrams + enriched,在前端期望 shape 上对齐
    const all = this.listEngrams();
    const kindFilter = opts.kind;
    const statusFilter = opts.status;
    const tagFilters = opts.domainTags ?? [];
    const filtered = all.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (statusFilter && statusFilter.length > 0) {
        let curStatus: string | undefined;
        try {
          const full = this.readEngram(e.id);
          curStatus = full?.status;
        } catch {
          curStatus = undefined;
        }
        if (!curStatus || !statusFilter.includes(curStatus)) return false;
      }
      if (tagFilters.length > 0) {
        return tagFilters.some((t) => e.domainTags.includes(t));
      }
      return true;
    });
    const enriched: EngramQueryRow[] = filtered.map((entry) => {
      let full: {
        summary?: string;
        importance?: number;
        createdAt?: string;
        updatedAt?: string;
        retrievalCount?: number;
        visibility?: string;
        status?: string;
        confidence?: number;
        contentSize?: number;
      } | null = null;
      try {
        full = this.readEngram(entry.id);
      } catch {
        full = null;
      }
      return {
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        importance: full?.importance ?? 0,
        confidence: full?.confidence ?? 0,
        updatedAt: full?.updatedAt ? Date.parse(full.updatedAt) : 0,
        createdAt: full?.createdAt ? Date.parse(full.createdAt) : 0,
        contentSize: full?.contentSize ?? 0,
        visibility: full?.visibility ?? "public",
        status: full?.status ?? "active",
        summary: full?.summary ?? "",
        retrievalCount: full?.retrievalCount ?? 0,
      };
    });
    const sortField = opts.sort ?? "updatedAt";
    const descending = opts.descending ?? true;
    enriched.sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (av === bv) return 0;
      if (typeof av === "number" && typeof bv === "number") {
        return descending ? bv - av : av - bv;
      }
      const ac = String(av ?? "");
      const bc = String(bv ?? "");
      return descending ? bc.localeCompare(ac) : ac.localeCompare(bc);
    });
    const total = enriched.length;
    let startIdx = 0;
    if (opts.cursor) {
      const decoded = decodeQueryCursor(opts.cursor);
      if (decoded) {
        const [sortVal, idVal] = decoded;
        startIdx = enriched.findIndex((row) => {
          const rv = row[sortField];
          if (String(rv) !== String(sortVal)) return false;
          return row.id === idVal;
        });
        if (startIdx >= 0) startIdx += 1;
      }
    }
    const slice = enriched.slice(startIdx, startIdx + limit);
    const last = slice[slice.length - 1];
    let nextCursor: string | null = null;
    if (slice.length === limit && last) {
      const sortValue = last[sortField];
      nextCursor = encodeQueryCursor(sortValue, last.id);
    }
    return { results: slice, total, nextCursor };
  }

  /**
   * 批量读取 DigestLine(消除 N+1 readEngram 的核心 API)。
   *
   * 用例:任何需要 DigestLine 字段子集的批处理路径 ——
   *   - engram_list 后置过滤(memory 模式下未走 SQL filter)
   *   - collectNeighborDigests / reinforceRelated(synapse 邻域聚合)
   *   - findCandidatesSync(去重候选打分)
   *   - 任何 Orchestrator 的 build(score + filter)前置
   *
   * SQLite 模式:单条 `WHERE id IN (?,?,...)` 直查,跳过 readEngram 全字段
   * 装配(尤其跳过 listSynapsesForEngram 扫整个 synapses/ 目录的 N+1)。
   * 实测收益:1026 engram × 20 邻域 = 原 16.5s,SQL 批查 ~25ms(660x)。
   *
   * Memory 模式 fallback:逐个 readEngram + 字段投影(退化路径,数据规模小
   * 时 N+1 影响可控)。SQLite 不可用时由 bootstrap 自动 fallback 到此路径。
   *
   * 行为:
   *   - ids 为空 → 返回 []
   *   - ids 上限 500:超过由调用方分批(避免 SQL 参数爆炸)
   *   - 不存在的 id 静默跳过(结果可能短于输入)
   *   - 无 ORDER BY:调用方按需排序
   *
   * 注意:返回的 synapse counts(out/in/contradiction)在 v4 schema 下由
   * syncEngramToIndex 写入 0,实际统计由 maintenance 周期回填。当前如果
   * 调用方依赖真实 synapse counts(如 collectNeighborDigests 的反向遍历),
   * 应改用 synapse 索引端查询,而非依赖 engrams 表的缓存字段。这是 v4
   * schema 的 known limitation,由 Phase 3 调用方重构负责对齐。
   */
  readDigestBatch(ids: readonly string[]): DigestLine[] {
    if (ids.length === 0) return [];
    if (this.indexDb) {
      try {
        const rows = this.indexDb.readDigestBatch(ids);
        return rows.map(digestRowToLine);
      } catch {
        // SQLite 查询失败 → fallback 到内存路径
      }
    }
    // memory fallback:逐个 readEngram,字段内联投影
    const out: DigestLine[] = [];
    for (const id of ids) {
      if (!this.exists(id)) continue;
      // noplus1: readDigestBatch 的 memory fallback 自身,SQLite 路径走 WHERE IN
      const engram = this.readEngram(id);
      out.push({
        id: engram.id,
        title: engram.title,
        kind: engram.kind,
        kinds: engram.kinds,
        summary: engram.summary,
        domainTags: engram.domainTags,
        contextTags: engram.contextTags,
        importance: engram.importance,
        confidence: engram.confidence,
        freshness: engram.freshness,
        status: engram.status,
        sourceType: engram.sourceType,
        createdBy: engram.createdBy,
        createdAt: engram.createdAt,
        updatedAt: engram.updatedAt,
        lastRetrievedAt: engram.lastRetrievedAt ?? null,
        lastEffectiveAt: engram.lastEffectiveAt ?? null,
        retrievalCount: engram.retrievalCount,
        effectiveRetrievals: engram.effectiveRetrievals,
        failedUses: engram.failedUses,
        reinforcementScore: engram.reinforcementScore,
        contentSize: engram.contentSize,
        contentHash: engram.contentHash,
        outgoingSynapseCount: engram.outgoingSynapseCount,
        incomingSynapseCount: engram.incomingSynapseCount,
        activeContradictionCount: engram.activeContradictionCount,
        verificationStatus: engram.verificationStatus ?? null,
      });
    }
    return out;
  }

  /**
   * 批量读取 dedup 用 content 字段(id / title / summary / content)。
   *
   * 替代 dedup findCandidatesSync 内的 N+1 readEngram(1026 engram ×
   * readEngram ≈ 18s)。SQL 端一次拉齐 content_tokens + summary + title,
   * 内存 tokenize/Jaccard 计算相似度。
   *
   * 不存在的 id 静默跳过(结果可能短于输入)。memory 模式 fallback 走
   * readEngram 逐个(数据规模小,N+1 影响可控)。
   */
  readContentBatch(ids: readonly string[]): ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly content: string;
  }> {
    if (ids.length === 0) return [];
    if (this.indexDb) {
      try {
        return this.indexDb.readContentBatch(ids);
      } catch {
        // SQLite 查询失败 → fallback 到内存路径
      }
    }
    const out: Array<{
      id: string;
      title: string;
      summary: string;
      content: string;
    }> = [];
    for (const id of ids) {
      if (!this.exists(id)) continue;
      // noplus1: readContentBatch 的 memory fallback 自身,SQLite 路径走 WHERE IN
      const engram = this.readEngram(id);
      out.push({
        id: engram.id,
        title: engram.title,
        summary: engram.summary,
        content: engram.content,
      });
    }
    return out;
  }

  /**
   * engram_list 工具专用列表查询:完整 SearchFilter + SortKey 排序 + 三字段 cursor。
   *
   * 替代旧路径:listEngrams → 逐个 readEngram → 内存 filter/sort/cursor
   * (1026 engram × readEngram ≈ 18s)。
   *
   * SQLite 模式:filter / sort / cursor 全部下推到 SQL,内存 O(limit)。
   * Memory 模式:走 readDigestBatch(消除逐个 readEngram N+1)+ 内存
   * filter/sort/cursor(数据规模小,N×log(N) 排序可接受)。
   *
   * 返回字段:id / title / kind / domainTags(EngramCatalogEntry 子集)。
   */
  queryEngramsForMcpList(opts: {
    readonly filter?: SearchFilter;
    readonly cursor?: string;
    readonly limit: number;
  }): {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly kind: string;
      readonly domainTags: readonly string[];
    }>;
    readonly nextCursor: string | null;
  } {
    const limit = Math.max(1, Math.min(opts.limit, 500));

    if (this.indexDb) {
      try {
        const { results } = this.indexDb.queryEngramsBySortKey({
          filter: opts.filter,
          cursor: opts.cursor,
          limit,
        });
        const items = results.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          domainTags: r.domainTagsCsv
            ? r.domainTagsCsv.split(",").filter(Boolean)
            : [],
        }));
        // 拼装下一页 cursor:基于本页最后一条的 SortKey
        let nextCursor: string | null = null;
        if (items.length === limit) {
          const last = results[results.length - 1];
          if (last) {
            nextCursor = encodeCursor({
              importance: last.importance,
              updatedAt: last.updatedAt,
              id: last.id,
            });
          }
        }
        return { items, nextCursor };
      } catch {
        // SQLite 查询失败 → fallback 到内存路径
      }
    }

    // memory fallback:readDigestBatch 一次性拉所有 DigestLine,内存 filter/sort
    const allIds = this.listEngrams().map((e) => e.id);
    const lines = this.readDigestBatch(allIds);
    const filtered = opts.filter
      ? lines.filter((line) => matchesFilterLine(line, opts.filter!))
      : lines;
    const sorted = [...filtered].sort((a, b) => {
      const ka: SortKey = {
        importance: a.importance,
        updatedAt: Date.parse(a.updatedAt ?? "1970-01-01"),
        id: a.id,
      };
      const kb: SortKey = {
        importance: b.importance,
        updatedAt: Date.parse(b.updatedAt ?? "1970-01-01"),
        id: b.id,
      };
      return compareSortKey(ka, kb);
    });

    let startIdx = 0;
    if (opts.cursor) {
      const ck = decodeCursor(opts.cursor);
      startIdx = sorted.findIndex((line) => {
        const key: SortKey = {
          importance: line.importance,
          updatedAt: Date.parse(line.updatedAt ?? "1970-01-01"),
          id: line.id,
        };
        return compareSortKey(key, ck) > 0;
      });
      if (startIdx === -1) startIdx = sorted.length;
    }

    const slice = sorted.slice(startIdx, startIdx + limit);
    const items = slice.map((line) => ({
      id: line.id,
      title: line.title,
      kind: line.kind,
      domainTags: line.domainTags,
    }));

    const hasMore = startIdx + limit < sorted.length && items.length > 0;
    const nextCursor =
      hasMore && slice.length > 0
        ? encodeCursor({
            importance: slice[slice.length - 1]!.importance,
            updatedAt: Date.parse(
              slice[slice.length - 1]!.updatedAt ?? "1970-01-01",
            ),
            id: slice[slice.length - 1]!.id,
          })
        : null;

    return { items, nextCursor };
  }

  /**
   * 按 verification status + lifecycle status 过滤,返回 DigestLine[]。
   *
   * 替代旧路径:listByVerificationStatus 内存遍历 catalog + 逐个 readEngram
   * (1026 engram × readEngram ≈ 18s 痛点)。
   *
   * filter 全部 SQL 端下推(SQLite 模式),memory 模式走 readDigestBatch
   * + 内存 filter(数据规模小,N+1 影响可控)。
   *
   * 用例:maintenance engine 的 runRem / runRem —— 需要 id / importance /
   * status 字段做 metacognition / daily decay,不需要完整 Engram。
   *
   * lifecycleStatuses 过滤:maintenance 隐式只关心 'active' 状态(排除
   * archived/forgotten/draft)。旧 listByVerificationStatus 在 runRem
   * 内部用 `if (engram.status !== "active") continue` 做内存过滤,这里
   * 改为 SQL 端下推,消除无谓 readEngram。
   */
  listDigestByVerificationStatus(
    verificationStatuses: readonly VerificationStatus[],
    opts?: { readonly lifecycleStatuses?: readonly string[] },
  ): DigestLine[] {
    if (verificationStatuses.length === 0) return [];
    const lifecycleStatuses = opts?.lifecycleStatuses;

    if (this.indexDb) {
      try {
        const rows = this.indexDb.listDigestByVerificationStatus({
          verificationStatuses,
          ...(lifecycleStatuses ? { lifecycleStatuses } : {}),
        });
        return rows.map(digestRowToLine);
      } catch {
        // SQLite 查询失败 → fallback 到内存路径
      }
    }

    // memory fallback:catalog 遍历 + readDigestBatch + 内存 lifecycle 过滤
    // (catalog entry 不存 status,需 readEngram 拿,这是 fallback 路径的
    // 已知 N+1 代价。SQLite 主路径无此问题 —— memory 模式典型数据规模小)。
    const statusSet = new Set(verificationStatuses as readonly string[]);
    const lifecycleSet = lifecycleStatuses ? new Set(lifecycleStatuses) : null;
    const matchedIds: string[] = [];
    for (const entry of this.getIndex().entries.values()) {
      const current = entry.verificationStatus ?? "unverified";
      if (!statusSet.has(current)) continue;
      if (lifecycleSet) {
        const engram = this.readEngram(entry.id);
        if (!lifecycleSet.has(engram.status)) continue;
      }
      matchedIds.push(entry.id);
    }
    return this.readDigestBatch(matchedIds);
  }

  /**
   * 按 verification status 过滤(支持单个 status 或数组,兼容历史调用方)。
   *
   * ⚠️ 性能注意:本方法内部 readEngram(逐个,含 synapse 扫描)。
   * 高频调用方应改用 `listDigestByVerificationStatus`(SQL 端 filter,
   * 返回 DigestLine[] 无 synapse 扫描)。本方法保留给需要完整 Engram[]
   * 的少数调用方(测试 / 视图渲染)。
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
      // noplus1: listEngramsByVerificationStatus 的语义是返回完整 Engram,
      // 调用方少(verification 工具内部)且通常按 status 过滤后命中数小。
      // 若出现 N+1 性能问题,改返回 DigestLine[] 或加 readEngramBatch。
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
   *
   * 走 collectAllSynapses 方法的 cache(20 个 caller 共享),
   * 避免每次都扫盘。原实现直接调 listSynapsesForEngram 模块函数 →
   * collectAllSynapses 模块函数,完全绕过 synapseCache,是 P2 调用者
   * 剩余 N+1 的漏网点(loadView / contradiction / evolution / generative /
   * lineage / perspectives 等都走 readSynapses)。
   *
   * bidirectional 语义与 listSynapsesForEngram 一致。
   */
  readSynapses(stableId: string): { outgoing: Synapse[]; incoming: Synapse[] } {
    const all = this.collectAllSynapses();
    const outgoing: Synapse[] = [];
    const incoming: Synapse[] = [];
    for (const { fromId, synapse } of all) {
      const touchesFrom = fromId === stableId;
      const touchesTo = synapse.to === stableId;
      if (synapse.direction === "bidirectional") {
        if (touchesFrom || touchesTo) {
          outgoing.push(synapse);
          incoming.push(synapse);
        }
      } else {
        if (touchesFrom) outgoing.push(synapse);
        if (touchesTo) incoming.push(synapse);
      }
    }
    return { outgoing, incoming };
  }

  /**
   * 列出所有 synapse(per-edge 扫描)。
   *
   * 返回 `{ fromId, synapse }` 形状以兼容历史调用方;
   * synapse 自身已携带 `from` 字段,fromId 就是 synapse.from。
   *
   * Cache:synapseCache 命中则直接返回,扫盘只发生一次。
   * 写方法(createSynapse / updateSynapse / deleteSynapse /
   * deleteSynapsesTouching / addOutgoing / removeOutgoing /
   * updateSynapseResolution)落盘后调 invalidateSynapseCache。
   */
  collectAllSynapses(): Array<{ fromId: string; synapse: Synapse }> {
    if (this.synapseCache) return this.synapseCache;
    const all = collectAllSynapses(this.config.rootPath);
    const result = all.map((synapse) => ({ fromId: synapse.from, synapse }));
    this.synapseCache = result;
    return result;
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
    // 继承最严 visibility:取 from/to 两端 engram 的 max(private > restricted > team > public)
    // 端点查不到(已删/无效 id)时降级 'public',不阻塞 synapse 创建
    let fromVis: EngramVisibility = "public";
    let toVis: EngramVisibility = "public";
    try {
      fromVis = this.readEngram(input.from).visibility ?? "public";
    } catch {
      // from engram 不存在或不可读,降级 public
    }
    try {
      toVis = this.readEngram(input.to).visibility ?? "public";
    } catch {
      // to engram 不存在或不可读,降级 public
    }
    const inheritedVisibility = maxVisibility(fromVis, toVis);

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
      visibility: inheritedVisibility,
      language: this.language,
    });
    this.refreshObsidianLinks(input.from, input.to);
    this.invalidateSynapseCache();
    // Task 3.4 Phase B:synapse 创建影响 graph 结构,触发 prompt-signals rebuild
    safeEmit({
      type: "synapse_created",
      engramId: input.from,
      at: new Date().toISOString(),
    });
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
      throw notFoundError("Synapse", synapseId, `from engram ${fromId}`);
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
      // 保守策略:不因端点 visibility 提升而自动调整 synapse visibility,
      // 保留原值。Phase 1.5 可加 recomputeSynapseVisibility(engramId)。
      visibility: target.visibility ?? "public",
      language: this.language,
    });
    this.refreshObsidianLinks(target.from, target.to);
    this.invalidateSynapseCache();
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
    this.invalidateSynapseCache();
  }

  /** 级联删除触及 engram 的所有 synapse */
  deleteSynapsesTouching(engramId: string): number {
    // 性能修复(2026-07 用户报告「永久清空失败」):
    //   旧实现走 listSynapsesForEngram + deleteSynapsesTouching 两次扫盘,
    //   每次 collectAllSynapses 扫 1827 个 yaml ~45s。purge 批量场景下
    //   267 次 deleteEngram × 90s = 6.7 小时,用户感觉「清空失败」。
    //
    //   SQLite fast path:用 `synapses(from_id, to_id)` 索引 O(log N) 查到
    //   相关 synapse 的 (id, kind, from, to),只 deleteSynapseFile 这几条 yaml。
    //   SQLite synapses 行由 deleteEngram 触发 ON DELETE CASCADE 自动清。
    //   267 engram 总耗时从 ~6 小时降到 ~1 秒。
    let touching: { outgoing: Synapse[]; incoming: Synapse[] };
    if (this.indexDb) {
      try {
        touching = this.listSynapsesForEngramFromIndex(engramId);
      } catch {
        touching = listSynapsesForEngram(this.config.rootPath, engramId);
      }
    } else {
      touching = listSynapsesForEngram(this.config.rootPath, engramId);
    }

    const neighbors = new Set<string>();
    for (const s of touching.outgoing) {
      if (s.to !== engramId) neighbors.add(s.to);
    }
    for (const s of touching.incoming) {
      if (s.from !== engramId) neighbors.add(s.from);
    }

    // 只 deleteSynapseFile 这几条 yaml(SQLite 行由后续 indexDb.deleteEngram 触发 cascade)
    const all = [...touching.outgoing, ...touching.incoming];
    const seen = new Set<string>();
    let count = 0;
    for (const s of all) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const path = join(
        this.config.rootPath,
        synapseRelativePath(s.id, s.kind),
      );
      try {
        deleteSynapseFile(path);
        count++;
      } catch {
        // 文件可能已被并发删除,忽略
      }
    }
    if (neighbors.size > 0) this.refreshObsidianLinks(...neighbors);
    this.invalidateSynapseCache();
    return count;
  }

  /**
   * SQLite fast path:O(log N) 查询触及 engramId 的所有 synapse。
   *
   * 用 `synapses(from_id)` + `synapses(to_id)` 索引替代 collectAllSynapses 扫盘。
   * 返回的 Synapse 仅填 id/from/to/kind/direction(够 deleteSynapseFile 用);
   * 其他字段(evidence/weight/...)不在此场景需要,留空避免 SQL 复杂化。
   */
  private listSynapsesForEngramFromIndex(engramId: string): {
    outgoing: Synapse[];
    incoming: Synapse[];
  } {
    const db = this.indexDb!;
    const outRows = db
      .prepare(
        `SELECT id, from_id, to_id, kind, weight FROM synapses WHERE from_id = ?`,
      )
      .all(engramId) as {
      id: string;
      from_id: string;
      to_id: string;
      kind: string;
      weight: number;
    }[];
    const inRows = db
      .prepare(
        `SELECT id, from_id, to_id, kind, weight, direction FROM synapses WHERE to_id = ?`,
      )
      .all(engramId) as {
      id: string;
      from_id: string;
      to_id: string;
      kind: string;
      weight: number;
      direction?: string;
    }[];
    const mkSynapse = (r: {
      id: string;
      from_id: string;
      to_id: string;
      kind: string;
      weight: number;
      direction?: string;
    }): Synapse =>
      ({
        id: r.id,
        from: r.from_id,
        to: r.to_id,
        kind: r.kind as SynapseKind,
        weight: r.weight,
        direction: (r.direction ?? "directional") as SynapseDirection,
        evidence: [],
        createdBy: "",
        createdAt: "",
        updatedAt: "",
        retrievalWeight: r.weight,
        visibility: "public",
      }) as Synapse;
    return {
      outgoing: outRows.map(mkSynapse),
      incoming: inRows.map(mkSynapse),
    };
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
    this.invalidateSynapseCache();
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
    this.invalidateSynapseCache();
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
      throw notFoundError("Synapse", synapseId, `from engram ${fromId}`);
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
    this.invalidateSynapseCache();
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
      throw notFoundError("Synapse", synapseId, `from engram ${fromId}`);
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
    this.invalidateSynapseCache();
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
      throw notFoundError("Synapse", synapseId, `from engram ${fromId}`);
    }
    const path = join(
      this.config.rootPath,
      synapseRelativePath(target.id, target.kind),
    );
    writeSynapseFile(path, next, this.language);
    this.invalidateSynapseCache();
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
   * 默认按 lastEffectiveAt + importance 派生 freshness,
   * 但允许通过 forcedFreshness 显式覆盖（用于 lifecycle 工具强制切换）。
   * 注意:forcedFreshness 一旦设置即锁定 —— effective 检索(更新 lastEffectiveAt)不会自动清除它,需 lifecycle 工具另行显式解除。
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
   * 更新 verificationStatus(不触发 version++)。
   */
  updateVerificationStatus(id: string, status: VerificationStatus): void {
    this.mutateFrontmatter(id, (fm) => ({ ...fm, verificationStatus: status }));
    // Task 3.4 Phase B:验证状态变化影响 prompt 的 lowConfidenceTopics
    safeEmit({
      type: "engram_verified",
      engramId: id,
      at: new Date().toISOString(),
    });
  }

  /**
   * 更新 confidence(correctness 基础输入)。clamp [0,1]。不触发 version++。
   *
   * correctness 回路(子项目 A):confidence 是 importance 的输入因子,
   * 被 refute/verify/effective/failure 信号驱动。本方法是它的持久化写入门。
   */
  updateConfidence(id: string, confidence: number): void {
    const clamped = Math.max(0, Math.min(1, confidence));
    this.mutateFrontmatter(id, (fm) => ({ ...fm, confidence: clamped }));
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

    // Task 1.5:同步投影到 SQLite(若注入)。mutateFrontmatter 被
    // bumpRetrievalStats / updateLifecycle /
    // updateVerificationStatus 复用,会改 importance / status / updatedAt
    // 等 SQLite 排序/过滤列,必须同步否则 SQLite 数据陈旧。
    this.syncEngramToIndex(newFrontmatter, oldFile.content);
  }

  // ─── Doctor 自愈扫描 ───────────────────────────────────────────────────

  /**
   * 自动可 clamp 的数值字段(doctor 安全修,语义保留)。
   *
   * 不在此集合的数值字段(version/contentSize/evidenceCount 等)语义更敏感:
   *   - version 必须 ≥1 整数,clamp 会掩盖 bug
   *   - contentSize 是 derived,走 derived_mismatch 路径重算(不 clamp)
   *   - evidenceCount/retrievalCount 是计数,负数语义可疑,留给用户
   */
  private static readonly CLAMPABLE_NUMERIC = new Set([
    "importance",
    "confidence",
    "lastRetrievalScore",
    "reinforcementScore",
  ]);

  /**
   * ValidationIssue → DoctorIssue 转换 + 自动修复决策。
   *
   * 规则(spec 4.5.1):
   *   - derived_mismatch → kind=derived_field_stale,自动修(contentHash/contentSize 重算)
   *   - out_of_range 数值字段(clampable)→ kind=invalid_field_value,自动修(clamp)
   *   - unknown_field → kind=invalid_field_value,自动修(删字段)
   *   - 其余 → kind=invalid_field_value,pendingManualReview
   *
   * 自动修走一次 `mutateFrontmatter`(per-file 原子):
   *   - mutateFrontmatter 内部用 `computeContentHash(oldFile.content)` 重算 hash,
   *     所以 derived_mismatch 用 identity mutator `fm => fm` 即可触发重算并落盘。
   *   - clamp / delete 在 mutator 内修改对应字段。
   *
   * 修复失败(并发删 / IO 错)→ 把所有 autoFixable 降级为 pending 不阻塞 doctor。
   */
  private processValidationIssues(
    stableId: string,
    relativePath: string,
    issues: readonly ValidationIssue[],
  ): { fixes: DoctorIssue[]; pending: DoctorIssue[] } {
    const fixes: DoctorIssue[] = [];
    const pending: DoctorIssue[] = [];

    const isAutoFixable = (i: ValidationIssue): boolean =>
      i.category === "derived_mismatch" ||
      (i.category === "out_of_range" &&
        EngramRepository.CLAMPABLE_NUMERIC.has(i.field)) ||
      i.category === "unknown_field" ||
      // multiple_frontmatter:mutateFrontmatter 无条件 readEngramFile(parse 取第一个
      // fm+body)+ writeEngramFile(覆盖写单 frontmatter),identity mutator 即可删多余 block
      i.category === "multiple_frontmatter" ||
      // contentHash 格式错(invalid_format):与 derived_mismatch 同源,都是 contentHash
      // 派生字段问题。mutator 用 content 重算后格式自动正确(sha256:<hex>),故也自动修,
      // 消除"格式错甩手动 / 值不符却自动修"的双标(F32)。
      (i.category === "invalid_format" && i.field === "contentHash");

    const autoFixable = issues.filter(isAutoFixable);
    const manual = issues.filter((i) => !isAutoFixable(i));

    // manual → 直接转 DoctorIssue(不修,带 nextAction 提示)
    for (const issue of manual) {
      pending.push({
        kind: "invalid_field_value",
        stableId: stableId as StableEngramId,
        path: relativePath,
        message: issue.message,
        autoFixed: false,
        nextAction: this.nextActionFor(issue, stableId),
      });
    }

    // autoFixable → 一次 mutateFrontmatter 批量改
    if (autoFixable.length > 0) {
      // F34 修复:derived 字段(contentHash/contentSize)显式重算。原注释声称
      // "mutateFrontmatter 内部用 oldFile.content 重算",但 mutateFrontmatter /
      // serializeEngramFile 实际都不重算(只序列化 frontmatter 原值),导致
      // derived_mismatch 标 autoFixed:true 但 frontmatter 未改 —— doctor 谎报修复,
      // 同样的 stale 每次 doctor 重复报(实证:磁盘 contentSize 长期停在旧值)。
      // 这里在 mutator 外读 content 闭包传入,真正重算。contentHash 格式错(F32)
      // 与值不符(derived_mismatch)同源,统一靠重算修复。
      let hasDerivedIssue = autoFixable.some(
        (i) =>
          i.category === "derived_mismatch" ||
          (i.category === "invalid_format" && i.field === "contentHash"),
      );
      let derivedContent = "";
      if (hasDerivedIssue) {
        try {
          derivedContent = readEngramFile(
            join(this.config.rootPath, relativePath),
          ).content;
        } catch {
          // 读失败:跳过 derived 重算,但仍走 mutateFrontmatter 处理其他 issue
          hasDerivedIssue = false;
        }
      }
      try {
        this.mutateFrontmatter(stableId, (fm) => {
          const next = { ...fm } as Record<string, unknown>;
          for (const issue of autoFixable) {
            if (issue.category === "out_of_range") {
              const v = next[issue.field];
              if (typeof v === "number") {
                next[issue.field] = v < 0 ? 0 : v > 1 ? 1 : v;
              }
            } else if (issue.category === "unknown_field") {
              delete next[issue.field];
            }
          }
          // derived 字段统一重算(闭包 derivedContent)。重算 idempotent:
          // content 未变 → 值不变;content 变了 / 历史脏值 → 修正为真相。
          if (hasDerivedIssue) {
            next.contentHash = computeContentHash(derivedContent);
            next.contentSize = computeContentSize(derivedContent);
          }
          return next as EngramFrontmatter;
        });

        // 记录 fixes(按 issue 类别选 kind)
        for (const issue of autoFixable) {
          const kind: DoctorIssue["kind"] =
            issue.category === "derived_mismatch" ||
            (issue.category === "invalid_format" &&
              issue.field === "contentHash")
              ? "derived_field_stale"
              : issue.category === "multiple_frontmatter"
                ? "multiple_frontmatter"
                : "invalid_field_value";
          fixes.push({
            kind,
            stableId: stableId as StableEngramId,
            path: relativePath,
            message: issue.message,
            autoFixed: true,
          });
        }
      } catch {
        // 修复失败:把 autoFixable 全部降级为 pending(保留 nextAction)
        for (const issue of autoFixable) {
          pending.push({
            kind: "invalid_field_value",
            stableId: stableId as StableEngramId,
            path: relativePath,
            message: `Auto-fix failed: ${issue.message}`,
            autoFixed: false,
            nextAction: this.nextActionFor(issue, stableId),
          });
        }
      }
    }

    return { fixes, pending };
  }

  /**
   * 按 ValidationIssue.category 模板生成 nextAction(spec 4.6)。
   *
   * 不可修字段(id invalid/missing/type-mismatch)→ engram_delete + 重建
   * 可修字段(枚举/格式/必填/类型)→ engram_update 或 (manual edit)
   * 已自动修(derived/out_of_range/unknown)→ (auto-fixed) sentinel
   */
  private nextActionFor(
    issue: ValidationIssue,
    stableId: string,
  ): DoctorNextAction {
    switch (issue.category) {
      case "invalid_enum":
        if (issue.field === "visibility") {
          return {
            tool: "engram_update",
            argsHint: `id=${stableId}, visibility="public"`,
            explanation:
              "visibility must be public/team/private/restricted. SECURITY: invalid value may cause fail-open visibility leak.",
          };
        }
        if (issue.field === "kind") {
          return {
            tool: "engram_update",
            argsHint: `id=${stableId}, kinds=["observation"]`,
            explanation:
              "kind must be one of: observation, fact, pattern, procedure, hypothesis",
          };
        }
        return {
          tool: "engram_update",
          argsHint: `id=${stableId}, ${issue.field}=<valid value from: ${(
            issue.validValues ?? []
          )
            .map((v) => String(v))
            .join(", ")}>`,
          explanation: issue.message,
        };
      case "invalid_format":
        if (issue.field === "id") {
          return {
            tool: "engram_delete",
            argsHint: `id=${stableId}`,
            explanation:
              "id is not a valid ULID; delete and recreate with engram_create (id is identity, cannot be patched)",
          };
        }
        return {
          tool: "(manual edit)",
          argsHint: `Edit frontmatter.${issue.field} to a valid ${issue.expectedType ?? "value"}`,
          explanation: issue.message,
        };
      case "missing_required":
        if (issue.field === "id") {
          return {
            tool: "engram_delete",
            argsHint: `id=${stableId}`,
            explanation:
              "id is missing; delete and recreate (id is identity, cannot be patched)",
          };
        }
        return {
          tool: "engram_update",
          argsHint: `id=${stableId}, ${issue.field}=<value>`,
          explanation: issue.message,
        };
      case "type_mismatch":
        if (issue.field === "id") {
          return {
            tool: "engram_delete",
            argsHint: `id=${stableId}`,
            explanation: "id type is wrong; delete and recreate",
          };
        }
        return {
          tool: "engram_update",
          argsHint: `id=${stableId}, ${issue.field}=<${issue.expectedType ?? "correct type"}>`,
          explanation: issue.message,
        };
      case "out_of_range":
      case "unknown_field":
      case "derived_mismatch":
      case "multiple_frontmatter":
        return {
          tool: "(auto-fixed)",
          argsHint: "",
          explanation: "doctor has already auto-fixed this issue",
        };
    }
  }

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
      (invalidPath, errorMessage) => {
        // 有 frontmatter marker 但 isEngramFile false(YAML 结构错 / critical 校验问题)。
        // Re-parse 文件,把具体字段级 issue 也上报(visibility/kind/id critical 等),
        // 让用户/agent 拿到精确 nextAction 而非通用 "parse failed" 消息。
        const absPath = join(this.config.rootPath, invalidPath);
        let parsed: EngramFile | undefined;
        try {
          const raw = readFileSync(absPath, "utf8");
          parsed = parseEngramFile(raw);
        } catch {
          parsed = undefined;
        }

        if (
          parsed &&
          parsed._validationIssues &&
          parsed._validationIssues.length > 0
        ) {
          // 字段级 issue 上报(critical 路径,非 orphan)
          const fmId = parsed.frontmatter.id;
          const stableId =
            typeof fmId === "string" && isStableEngramId(fmId)
              ? (fmId as StableEngramId)
              : undefined;
          for (const vi of parsed._validationIssues) {
            const issue: DoctorIssue = {
              kind: "invalid_field_value",
              stableId,
              path: invalidPath,
              message: vi.message,
              autoFixed: false,
              nextAction: this.nextActionFor(
                vi,
                typeof fmId === "string" ? fmId : "<unknown>",
              ),
            };
            issues.push(issue);
            pendingManualReview.push(issue);
          }
          return;
        }

        // 真 YAML 结构错(re-parse 也抛 / 无 issue):报 invalid_frontmatter
        const issue: DoctorIssue = {
          kind: "invalid_frontmatter",
          path: invalidPath,
          message: `YAML/parse error in ${invalidPath}: ${errorMessage}`,
          autoFixed: false,
          nextAction: {
            tool: "(manual edit)",
            argsHint: `Fix YAML syntax in ${invalidPath}`,
            explanation:
              "File has frontmatter marker but parsing failed. Common causes: tab indentation, unbalanced quotes, malformed YAML.",
          },
        };
        issues.push(issue);
        pendingManualReview.push(issue);
      },
      (dupId, existingPath, duplicatePath) => {
        // duplicate_id:同 id 多文件(用户复制记忆到多目录 / 手动 cp 带 id)。
        // doctor 不自动删(删哪个由用户决定,可能丢演化内容)→ manual review + nextAction。
        // 这正是「已有记忆却重复 propose」的根因:被覆盖的副本不在 index → orphan → propose。
        const issue: DoctorIssue = {
          kind: "duplicate_id",
          stableId: dupId as StableEngramId,
          path: duplicatePath,
          message: `Duplicate id ${dupId}: also at "${existingPath}" — keep one, delete the other (or change one's id)`,
          autoFixed: false,
          nextAction: {
            tool: "engram_delete",
            argsHint: `id=<one of the duplicates>  // decide which copy is canonical, delete the other`,
            explanation: `Two files share stable id "${dupId}": "${existingPath}" and "${duplicatePath}". Usually a memory was manually copied to multiple directories. Decide which is canonical, delete the other (engram_delete), or change one's id. The non-canonical copy otherwise becomes an orphan and generates duplicate import proposals.`,
          },
        };
        issues.push(issue);
        pendingManualReview.push(issue);
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

    // 3.5 Task 7:消费每个 indexed engram 的 _validationIssues。
    //   - indexed 路径 = isEngramFile true(parse 成功 + 无 critical)→ 字段级
    //     中低问题(枚举/格式/范围/未知字段/derived_mismatch)在这里处理。
    //   - critical 问题(id/visibility 非法)不进 index,已在 step 1 的
    //     onInvalidFrontmatter 回调里处理。
    //   - 自动修修完后 index 未重新读(中低字段问题不影响 index 的 id/path/title/slug,
    //     保留 freshIndex 即可);obsidian 视图在 step 5 重新生成。
    for (const [id, entry] of freshIndex.entries) {
      const absPath = join(this.config.rootPath, entry.path);
      if (!existsSync(absPath)) continue;
      let parsed: EngramFile | undefined;
      try {
        parsed = parseEngramFile(readFileSync(absPath, "utf8"));
      } catch {
        // parse 失败 → step 1 的 onInvalidFrontmatter 已上报,跳过
        continue;
      }
      if (!parsed._validationIssues || parsed._validationIssues.length === 0) {
        continue;
      }
      const { fixes: fmFixes, pending: fmPending } =
        this.processValidationIssues(id, entry.path, parsed._validationIssues);
      fixes.push(...fmFixes);
      pendingManualReview.push(...fmPending);
    }

    // 4. 检测并自动清理 dangling synapse(from/to 不在 index)
    //
    // 历史:此前仅报告不修,导致历史遗留 dangling synapse 累积(Bug A:
    // 统计栏突触总数与 graph 面板过滤后数量差 1000+)。2026-07 改为自动删除:
    // 任一端缺失 → synapse 无意义 → 删文件 + SQLite 行由 cascade 清。
    // 仍在 pendingManualReview 里报告(让用户/agent 知道发生了什么)。
    const allSynapses = collectAllSynapses(this.config.rootPath);
    for (const syn of allSynapses) {
      const fromMissing = !freshIndex.entries.has(syn.from as StableEngramId);
      const toMissing = !freshIndex.entries.has(syn.to as StableEngramId);
      if (!fromMissing && !toMissing) continue;

      const synPath = join(
        this.config.rootPath,
        synapseRelativePath(syn.id, syn.kind),
      );
      try {
        deleteSynapseFile(synPath);
      } catch {
        // 文件可能已被并发删除,忽略
      }
      const stableId = (fromMissing ? syn.from : syn.to) as StableEngramId;
      const which = fromMissing ? (toMissing ? "both" : "from") : "to";
      pendingManualReview.push({
        kind: "dangling_synapse_cleaned",
        stableId,
        message: `Synapse ${syn.id} auto-deleted (.${which}="${which === "both" ? `${syn.from}/${syn.to}` : which === "from" ? syn.from : syn.to}" no longer exists)`,
        autoFixed: true,
      });
    }

    // 4.6 SQLite ghost 清理(plan AI-2 derived atomic 校验的核心子集)
    //
    // 历史盲区(2026-07 用户报告 630 ghost):runDoctor 原本只比对
    // engram-index.json vs markdown,不覆盖 SQLite vs markdown。SQLite ghost 来源:
    //   - 历史负载测试残留 / deleteEngram 调用中途失败 / 双写竞态
    //
    // 修复:以 freshIndex(markdown 全量重建)为唯一真相,清理 SQLite 里任何
    // markdown 不存在的条目。复用 indexDb.deleteEngram 的级联清理(FTS /
    // engram_domains / synapses 由外键 ON DELETE CASCADE 自动清)。
    if (this.indexDb) {
      const rows = this.indexDb
        .prepare("SELECT id FROM engrams")
        .all() as unknown as readonly { readonly id: string }[];
      for (const row of rows) {
        if (!freshIndex.entries.has(row.id as StableEngramId)) {
          try {
            this.indexDb.deleteEngram(row.id);
            fixes.push({
              kind: "sqlite_ghost",
              stableId: row.id as StableEngramId,
              message: `SQLite engrams row without markdown source: ${row.id} (cascade cleaned: FTS / engram_domains / synapses)`,
              autoFixed: true,
            });
          } catch {
            // 单条失败不阻塞其他 ghost,下次 doctor 重试
          }
        }
      }
    }

    // 4.5 2026-07 archived → frozen migration
    //
    // EngramStatus 枚举改名(archived → frozen)。旧数据 frontmatter 里仍是
    // `status: archived`,VALID_STATUS 临时容忍读取,但写入永远用 frozen。
    // 这里一次性扫完所有 engram,把 frontmatter.status === "archived" 改写成
    // "frozen",让旧数据升级后无差异。
    //
    // 注意:EngramFrontmatter.status 的 TS 类型已不含 "archived",但 VALID_STATUS
    // 仍容忍读取(过渡期)。这里 cast 到 string 比较 + 用 spread 构造新 frontmatter
    // 对象(因为 frontmatter 字段是 readonly)。
    for (const [id, entry] of freshIndex.entries) {
      const absPath = join(this.config.rootPath, entry.path);
      if (!existsSync(absPath)) continue;
      let parsed: EngramFile | undefined;
      try {
        parsed = readEngramFile(absPath);
      } catch {
        continue;
      }
      const curStatus = parsed.frontmatter.status as string | undefined;
      if (curStatus === "archived") {
        const migrated: EngramFile = {
          ...parsed,
          frontmatter: { ...parsed.frontmatter, status: "frozen" },
        };
        try {
          writeEngramFile(absPath, migrated, this.language);
          fixes.push({
            kind: "status_renamed",
            stableId: id as StableEngramId,
            path: entry.path,
            message: `Status renamed: archived → frozen (2026-07 rename, see EngramStatus docs)`,
            autoFixed: true,
          });
        } catch {
          // 写入失败忽略,下次 doctor 还会再扫
        }
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

    // 6. SQLite engrams 表全量重投(派生层 → 真相层对齐)
    //
    // 历史盲区(2026-07 index-no-truth 修复):runDoctor 原本只清理 SQLite ghost
    // 行(4.6 节),不覆盖「行存在但字段陈旧」场景。典型路径:
    //   - 用户用 Edit 工具改 .md frontmatter 的 `创建者` / `重要性` 等字段
    //   - watcher.scanForModifiedEngrams 实时同步(覆盖 90%)
    //   - 但 watcher 漏事件(NFS / Docker / 进程未启动)时,SQLite 字段长期陈旧
    //   - viewer /api/stats 贡献者排名、/api/engrams 排序读 SQLite → 错
    //
    // 兜底策略:doctor 结尾强制全量重投,确保 SQLite engrams 表所有字段
    // (createdBy / importance / status / freshness 等)与 frontmatter 一致。
    // 性能:O(|freshIndex|) readEngramFile + syncEngramToIndex,1000 engram ~ 200ms。
    // 幂等:upsert 同一字段值,多次跑 doctor 不累积副作用。
    if (this.indexDb) {
      let resynced = 0;
      for (const [id, entry] of freshIndex.entries) {
        if (!isPathWithinRoot(this.config.rootPath, entry.path)) continue;
        const absPath = safeJoinWithinRoot(this.config.rootPath, entry.path);
        try {
          const file = readEngramFile(absPath);
          this.syncEngramToIndex(file.frontmatter, file.content);
          resynced++;
        } catch {
          // 单条失败不阻塞,留给下次 doctor
        }
      }
      if (resynced > 0) {
        fixes.push({
          kind: "sqlite_resynced",
          path: this.config.rootPath,
          message: `SQLite engrams table resynced from frontmatter truth (${resynced} rows updated)`,
          autoFixed: true,
        });
      }
    }

    // Task 3.4 Phase B:doctor 完成后 emit(doctor 可能 sweep/forget,engram 集合变化)
    safeEmit({ type: "doctor_completed", at: new Date().toISOString() });

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

    const ensureNode = (relPath: string): MutableNode => {
      if (relPath.length === 0) return root;
      const segments = relPath.split("/");
      let currentPath = "";
      let parentNode = root;
      let node = root;
      for (const seg of segments) {
        currentPath = currentPath.length === 0 ? seg : `${currentPath}/${seg}`;
        const existing = nodeMap.get(currentPath);
        if (existing) {
          node = existing;
        } else {
          node = { path: currentPath, engramCount: 0, children: [] };
          nodeMap.set(currentPath, node);
          parentNode.children.push(node);
        }
        parentNode = node;
      }
      return node;
    };

    const SKIP_DIRS = new Set([".git", "node_modules", ".co-engram", "synapses"]);
    const walkDirs = (absDir: string, relDir: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true }) as import("node:fs").Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const relPath = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
        ensureNode(relPath);
        walkDirs(join(this.config.rootPath, relPath), relPath);
      }
    };
    walkDirs(this.config.rootPath, "");

    // Truth-filter(与 listEngrams 一致):engram-index.json 可能含 ghost
    // (外部 rm 了 .md 但 index 还没 rebuild)。直接拿 fs 文件列表做交集,
    // 5s 缓存摊销开销。无此 filter 时,ghost 会让 path-tree 凭空多出目录。
    const truthPaths = this.getTruthPaths();
    let ghostDetected = false;
    for (const entry of this.getIndex().entries.values()) {
      // forgotten(软删除)不计入目录树:与卡片视图(status=active)口径一致。
      // 文件仍保留(等 maintenance sweepToTrash 移入 .trash/),但目录浏览不应展示。
      if ((entry.status ?? "active") === "forgotten") continue;
      if (!truthPaths.has(entry.path)) {
        ghostDetected = true;
        continue;
      }
      // entry.path 形如 "<domain1>/<domain2>/.../<slug>.md"
      // 最后一段是文件名,跳过;之前每段都是目录,需逐级累加(包含 root)
      const segments = entry.path.split("/");
      const dirSegments = segments.slice(0, -1);

      root.engramCount++;
      let currentPath = "";
      for (const seg of dirSegments) {
        currentPath = currentPath.length === 0 ? seg : `${currentPath}/${seg}`;
        ensureNode(currentPath).engramCount++;
      }
    }

    if (ghostDetected) {
      queueMicrotask(() => {
        try {
          this.rebuildIndex();
        } catch {}
      });
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

    // evidenceCount 派生:从 derives_from synapse.evidence 的 verdict 证据数算
    // (description 以 [plausible/probable/verified/refuted] 开头)。
    // 废弃 frontmatter 的死字段 fm.evidenceCount(从不 increment),对齐 network count 正模式。
    // 这是 [[co-engram-architecture-defects]] index-no-truth 修复:派生量读取时算,不存盘。
    const verdictEvidenceCount = synapses.outgoing
      .filter((s) => s.kind === "derives_from")
      .reduce(
        (sum, s) =>
          sum +
          s.evidence.filter((ev) =>
            /^\[(plausible|probable|verified|refuted)\]/.test(ev.description),
          ).length,
        0,
      );

    const createdAt = fm.createdAt ?? now();
    const lastEffectiveAtForFreshness = fm.lastEffectiveAt ?? createdAt;
    const importanceForFreshness = fm.importance ?? DEFAULT_IMPORTANCE;
    const status = fm.status ?? "active";
    const freshness: EngramFreshness =
      status === "forgotten"
        ? "forgotten"
        : (fm.forcedFreshness ??
          computeFreshness(
            lastEffectiveAtForFreshness,
            createdAt,
            importanceForFreshness,
            fm.kind,
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
      sourceType: fm.sourceType ?? "firsthand",
      evidenceCount: verdictEvidenceCount,
      retrievalCount: fm.retrievalCount ?? 0,
      effectiveRetrievals: fm.effectiveRetrievals ?? 0,
      failedUses: fm.failedUses ?? 0,
      lastRetrievedAt: fm.lastRetrievedAt,
      lastEffectiveAt: fm.lastEffectiveAt,
      reinforcementScore: fm.reinforcementScore ?? 0,
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
      // synapse 内容变了(语言迁移),cache 会 stale
      this.invalidateSynapseCache();
    }

    return result;
  }
}

/**
 * DigestIndexRow(SQL 原始行) → DigestLine(类型化)转换。
 *
 * 处理三类列形态差异:
 *   - epoch ms INTEGER → ISO string(new Date(ms).toISOString())
 *   - JSON string(kinds / contextTags) → readonly array(JSON.parse + 兜底)
 *   - CSV string(domainTagsCsv) → readonly string[](split + filter)
 *
 * 兜底语义:损坏的 JSON / 空字符串视为空数组,不抛错。SQLite 是派生数据,
 * 损坏行应该被静默跳过而非阻塞批处理(doctor / cold-start rebuild 会修复)。
 */
function digestRowToLine(row: DigestIndexRow): DigestLine {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    kinds: parseJsonArray(row.kindsJson),
    summary: row.summary,
    domainTags: splitCsv(row.domainTagsCsv),
    contextTags: parseJsonArray(row.contextTagsJson),
    importance: row.importance,
    confidence: row.confidence,
    freshness: row.freshness,
    status: row.status,
    sourceType: row.sourceType,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    lastRetrievedAt:
      row.lastRetrievedAt !== null
        ? new Date(row.lastRetrievedAt).toISOString()
        : null,
    lastEffectiveAt:
      row.lastEffectiveAt !== null
        ? new Date(row.lastEffectiveAt).toISOString()
        : null,
    retrievalCount: row.retrievalCount,
    effectiveRetrievals: row.effectiveRetrievals,
    failedUses: row.failedUses,
    reinforcementScore: row.reinforcementScore,
    contentSize: row.contentSize,
    contentHash: row.contentHash,
    outgoingSynapseCount: row.outgoingSynapseCount,
    incomingSynapseCount: row.incomingSynapseCount,
    activeContradictionCount: row.activeContradictionCount,
    verificationStatus: row.verificationStatus,
  };
}

/** 安全解析 JSON 数组,失败返回空数组(派生数据损坏不阻塞批处理) */
function parseJsonArray(json: string): readonly string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/** CSV(group_concat 输出)拆数组,null/空串 → [] */
function splitCsv(joined: string | null): readonly string[] {
  if (!joined) return [];
  return joined.split(",").filter(Boolean);
}

/**
 * memory fallback 路径的 DigestLine filter(逻辑与 retrieval/filter.ts matchesFilter 一致)。
 *
 * 为什么要重复一份:storage 层不能反向依赖 retrieval 层(会形成循环依赖:
 * retrieval → storage → retrieval)。memory fallback 是 fail-safe 路径,
 * SQLite 不可用时才走,filter 字段集稳定,内联实现可接受。SQL 主路径在
 * IndexDb.queryEngramsBySortKey 里用 WHERE 下推,不走这里。
 *
 * 字段语义对齐 retrieval/filter.ts:status 隐式默认 ['active', 'draft'],
 * 其余字段未传/空数组视为不过滤。任何字段对齐偏差由
 * test/storage/repository-list-fallback.test.ts 兜底(后续 Phase 验证补)。
 */
function matchesFilterLine(line: DigestLine, filter: SearchFilter): boolean {
  if (filter.domainTags && filter.domainTags.length > 0) {
    if (!filter.domainTags.some((t) => line.domainTags.includes(t)))
      return false;
  }
  if (filter.contextTags && filter.contextTags.length > 0) {
    if (!filter.contextTags.some((t) => line.contextTags.includes(t)))
      return false;
  }
  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.some((k) => line.kinds.includes(k))) return false;
  }
  // status 隐式默认:与 retrieval/filter.ts 一致
  const statusFilter =
    filter.status && filter.status.length > 0
      ? filter.status
      : ["active", "draft"];
  if (!statusFilter.includes(line.status)) return false;
  if (filter.freshness && filter.freshness.length > 0) {
    if (!filter.freshness.includes(line.freshness)) return false;
  }
  if (filter.createdBy && filter.createdBy.length > 0) {
    if (!filter.createdBy.includes(line.createdBy)) return false;
  }
  if (filter.createdAfter && line.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore && line.createdAt > filter.createdBefore)
    return false;
  if (
    typeof filter.minImportance === "number" &&
    line.importance < filter.minImportance
  ) {
    return false;
  }
  return true;
}
