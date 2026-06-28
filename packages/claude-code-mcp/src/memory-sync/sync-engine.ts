/**
 * Auto-memory 同步引擎
 *
 * 把 Claude Code auto-memory(.md 文件)同步为 co-engram engram。
 *
 * 幂等机制:
 *   - domainTag `claude-code-auto-memory`:标记来源,便于过滤
 *   - encodingContext `claude-code-auto-memory:<slug>`:每个 slug 唯一
 *
 * 同步策略:
 *   - 首次见到 slug:createEngram
 *   - 已有 slug 且 body/description 变化:updateEngram(只改 title/content/summary,
 *     保留 reinforcement/decay 等统计字段)
 *   - 已有 slug 且无变化:no-change
 *
 * 跨进程安全:多个 MCP 实例(Claude Code + OpenClaw 各起一份)同时跑时,
 * encodingContext 是确定性字符串,不会冲突;最坏情况是两进程都 createEngram,
 * 由 dedupe 兜底(同 contentHash + 相似度会被强化而非新建)。
 *
 * @module @co-engram/claude-code/memory-sync
 */

import type { Engram, EngramKind, EngramRepository } from "@co-engram/core";
import type { ParsedAutoMemory } from "./memory-parser.js";

/** 标识 auto-memory 来源的 domainTag */
export const AUTO_MEMORY_DOMAIN_TAG = "claude-code-auto-memory";

/** encodingContext 前缀,冒号后接 slug */
export const AUTO_MEMORY_ENCODING_PREFIX = "claude-code-auto-memory:";

/** 同步动作结果 */
export type SyncAction = "created" | "updated" | "no-change" | "skipped";

/** 单条同步结果 */
export interface SyncResult {
  readonly action: SyncAction;
  readonly slug: string;
  readonly engramId?: string;
  readonly reason?: string;
}

/** 批量同步统计 */
export interface SyncBatchStats {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

/**
 * Claude Code auto-memory type → co-engram EngramKind
 *
 * 设计原则:不丢语义。
 *   - `pattern` → `pattern`(用户在 spec 中明确点名)
 *   - `feedback` / `user` → `observation`(行为偏好,持续观察所得)
 *   - `project` / `reference` → `fact`(项目状态 / 外部指针,陈述性)
 *   - 其他未识别 type → `observation`(auto-memory 默认)
 */
export function mapAutoMemoryType(type: string): EngramKind {
  switch (type) {
    case "pattern":
      return "pattern";
    case "feedback":
    case "user":
    case "observation":
      return "observation";
    case "project":
    case "reference":
    case "fact":
      return "fact";
    case "procedure":
      return "procedure";
    case "hypothesis":
      return "hypothesis";
    default:
      return "observation";
  }
}

/**
 * 把 ParsedAutoMemory 渲染为 engram content
 *
 * 保留原始 body 作为主体,前面加 description 作为摘要式 lead-in。
 * 不丢 Claude Code 已有的 `[[link]]` 双向链接语法(co-engram 渲染时无视,但人读有益)。
 */
export function renderAutoMemoryContent(memory: ParsedAutoMemory): string {
  const parts: string[] = [];
  if (memory.description) {
    parts.push(`> ${memory.description}`);
    parts.push("");
  }
  if (memory.body) {
    parts.push(memory.body);
  }
  return parts.join("\n").trim();
}

/** 从 slug 构造 encodingContext */
export function encodingContextFor(slug: string): string {
  return `${AUTO_MEMORY_ENCODING_PREFIX}${slug}`;
}

/**
 * 同步引擎
 *
 * 内部维护 `Map<slug, engramId>` 缓存避免每次扫全库;首次按需构建。
 */
export class AutoMemorySyncEngine {
  /** slug → engramId 缓存(lazy build) */
  private slugCache: Map<string, string> | undefined;
  /** 内容指纹缓存(避免对未变化的内容调 updateEngram) */
  private readonly contentHashCache = new Map<string, string>();
  private readonly log: (msg: string) => void;

  constructor(params: {
    readonly repository: EngramRepository;
    readonly defaultCreatedBy: string;
    readonly log?: (msg: string) => void;
  }) {
    this.repository = params.repository;
    this.defaultCreatedBy = params.defaultCreatedBy;
    this.log = params.log ?? (() => {});
  }

  /**
   * 同步单条 memory
   *
   * - 文件被 Claude Code 删除/重命名 → 调用方应使用 `forgetMemoryBySlug`
   *   (本方法只处理"存在的文件")
   * - body 为空且 description 为空 → skipped(无内容可同步)
   */
  syncMemory(memory: ParsedAutoMemory): SyncResult {
    const content = renderAutoMemoryContent(memory);
    if (!content) {
      return { action: "skipped", slug: memory.slug, reason: "empty content" };
    }

    // 用 description + body 做去重 hash,避免无变化时反复 updateEngram 触发 version++
    const contentFingerprint = `${memory.description}\n\n---\n\n${memory.body}`;
    const existing = this.findBySlug(memory.slug);
    if (existing) {
      const lastFingerprint = this.contentHashCache.get(memory.slug);
      if (lastFingerprint === contentFingerprint) {
        return { action: "no-change", slug: memory.slug, engramId: existing.id };
      }
      // 内容有变化 → update(只改 title/summary/content,统计字段保留)
      try {
        this.repository.updateEngram(existing.id, {
          title: memory.slug,
          summary: memory.description || memory.body.slice(0, 200),
          content,
          updatedBy: this.defaultCreatedBy,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[memory-sync] updateEngram failed for slug=${memory.slug}: ${msg}`);
        throw err;
      }
      this.contentHashCache.set(memory.slug, contentFingerprint);
      return { action: "updated", slug: memory.slug, engramId: existing.id };
    }

    // 不存在 → create
    const kind = mapAutoMemoryType(memory.type);
    let engramId: string;
    try {
      const created = this.repository.createEngram({
        title: memory.slug,
        content,
        summary: memory.description || memory.body.slice(0, 200),
        kind,
        domainTags: [AUTO_MEMORY_DOMAIN_TAG],
        contextTags: ["auto-sync"],
        encodingContext: encodingContextFor(memory.slug),
        createdBy: this.defaultCreatedBy,
        sourceType: "firsthand",
        importance: kind === "pattern" ? 0.7 : 0.5,
      });
      engramId = created.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[memory-sync] createEngram failed for slug=${memory.slug}: ${msg}`);
      throw err;
    }
    if (this.slugCache) {
      this.slugCache.set(memory.slug, engramId);
    }
    this.contentHashCache.set(memory.slug, contentFingerprint);
    return { action: "created", slug: memory.slug, engramId };
  }

  /**
   * 批量同步(初始扫描)
   *
   * 不抛错,逐条 try-catch 收集错误。返回统计 + 错误列表。
   */
  syncBatch(memories: readonly ParsedAutoMemory[]): SyncBatchStats {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const memory of memories) {
      try {
        const result = this.syncMemory(memory);
        switch (result.action) {
          case "created":
            created += 1;
            break;
          case "updated":
            updated += 1;
            break;
          case "no-change":
            unchanged += 1;
            break;
          case "skipped":
            skipped += 1;
            break;
        }
      } catch (err) {
        failed += 1;
        errors.push(
          `${memory.slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { created, updated, unchanged, skipped, failed, errors };
  }

  /**
   * 重置 slug 缓存(下次 findBySlug 会重新扫全库)
   *
   * 不清理 contentHashCache —— 该缓存只是"避免对未变化内容调 updateEngram"
   * 的会话内优化,不影响正确性。resetCache 主要用于测试 / 强制 slug→id 映射重建。
   */
  resetCache(): void {
    this.slugCache = undefined;
  }

  /** 测试用:获取当前 slug 缓存快照 */
  peekSlugCache(): ReadonlyMap<string, string> | undefined {
    return this.slugCache;
  }

  // ────────────────────────────────────────────────────────────

  /** 按 slug 查找已存在的 engram(undefined 表示未同步过) */
  private findBySlug(slug: string): Engram | undefined {
    const cache = this.ensureSlugCache();
    const engramId = cache.get(slug);
    if (engramId) {
      try {
        return this.repository.readEngram(engramId);
      } catch {
        // 缓存陈旧(被删了)→ fallthrough 重建
        cache.delete(slug);
      }
    }
    // cache miss:扫全部 auto-memory domain engram(只在首次或 cache 失效时触发)
    return undefined;
  }

  /** 懒构建 slug 缓存:扫一次所有带 AUTO_MEMORY_DOMAIN_TAG 的 engram */
  private ensureSlugCache(): Map<string, string> {
    if (this.slugCache) return this.slugCache;
    const cache = new Map<string, string>();
    const all = this.repository.listEngrams();
    for (const entry of all) {
      if (!entry.domainTags.includes(AUTO_MEMORY_DOMAIN_TAG)) continue;
      try {
        const full = this.repository.readEngram(entry.id);
        const ctx = full.encodingContext;
        if (!ctx || !ctx.startsWith(AUTO_MEMORY_ENCODING_PREFIX)) continue;
        const slug = ctx.slice(AUTO_MEMORY_ENCODING_PREFIX.length);
        if (slug) cache.set(slug, entry.id);
      } catch {
        // 读单条失败:跳过
      }
    }
    this.slugCache = cache;
    return cache;
  }

  private readonly repository: EngramRepository;
  private readonly defaultCreatedBy: string;
}
