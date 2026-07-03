/**
 * Auto-memory → proposal 同步引擎
 *
 * 把 Claude Code auto-memory(.md 文件)同步为 co-engram proposal(候选提案)。
 * 用户/LLM 通过 `engram_accept_proposal` 主动审批后才成为 engram。
 *
 * 与之前直接生成 engram 的设计相比:
 *   - auto-memory 是 Claude Code 自动捕获的,未经用户审核
 *   - 直接 createEngram 会污染检索池(engram 一旦创建就会被检索、强化、Hebbian 传播)
 *   - 走 proposal 路径与 ProposalEngine 既有的「候选 → 审批 → engram」语义一致
 *
 * 幂等机制:
 *   - 调用 ProposalEngine.proposeAutoMemory,它按 entityId=`am:<slug>` 去重
 *   - payload fingerprint 缓存避免对未变化内容重复 propose
 *   - 已 accepted 的 proposal 不会被源文件变化重开
 *
 * 跨进程安全:多个 MCP 实例(Claude Code + OpenClaw 各起一份)同时跑时,
 * entityId 是确定性字符串(`am:<slug>`),不会冲突;proposals.jsonl 的并发写
 * 是 ProposalEngine 的单点存储(本引擎不做额外协调)。
 *
 * @module @co-engram/claude-code/memory-sync
 */

import type { EngramKind } from "@co-engram/core";
import type { ProposalEngine } from "@co-engram/core";
import type { ParsedAutoMemory } from "./memory-parser.js";

/** 标识 auto-memory 来源的 domainTag(用于 accept 后 engram 的过滤) */
export const AUTO_MEMORY_DOMAIN_TAG = "claude-code-auto-memory";

/** encodingContext 前缀,冒号后接 slug */
export const AUTO_MEMORY_ENCODING_PREFIX = "claude-code-auto-memory:";

/** 同步动作结果 */
export type SyncAction = "proposed" | "updated" | "no-change" | "skipped";

/** 单条同步结果 */
export interface SyncResult {
  readonly action: SyncAction;
  readonly slug: string;
  readonly entityId?: string;
  readonly reason?: string;
}

/** 批量同步统计 */
export interface SyncBatchStats {
  readonly proposed: number;
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
 * 依赖 ProposalEngine(而非 EngramRepository) —— 把每条 memory 作为 pending
 * proposal 写入,由用户/LLM 主动审批后才创建 engram。
 */
export class AutoMemorySyncEngine {
  /** 内容指纹缓存(避免对未变化的内容调 proposeAutoMemory) */
  private readonly contentHashCache = new Map<string, string>();
  private readonly log: (msg: string) => void;

  constructor(params: {
    readonly proposalEngine: ProposalEngine;
    readonly defaultCreatedBy: string;
    readonly log?: (msg: string) => void;
  }) {
    this.proposalEngine = params.proposalEngine;
    this.defaultCreatedBy = params.defaultCreatedBy;
    this.log = params.log ?? (() => {});
  }

  /**
   * 同步单条 memory → proposal
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

    // 用 description + body 做去重 hash,避免无变化时反复调 proposeAutoMemory
    const contentFingerprint = `${memory.description}\n\n---\n\n${memory.body}`;
    const lastFingerprint = this.contentHashCache.get(memory.slug);
    if (lastFingerprint === contentFingerprint) {
      // 内容未变化,ProposalEngine.proposeAutoMemory 也会判 no-change,
      // 但本地直接短路避免一次磁盘 IO + JSONL 读写
      return {
        action: "no-change",
        slug: memory.slug,
        entityId: `am:${memory.slug}`,
      };
    }

    const kind = mapAutoMemoryType(memory.type);
    let action: "proposed" | "updated" | "no-change";
    try {
      action = this.proposalEngine.proposeAutoMemory({
        slug: memory.slug,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(
        `[memory-sync] proposeAutoMemory failed for slug=${memory.slug}: ${msg}`,
      );
      throw err;
    }
    this.contentHashCache.set(memory.slug, contentFingerprint);
    return { action, slug: memory.slug, entityId: `am:${memory.slug}` };
  }

  /**
   * 批量同步(初始扫描)
   *
   * 不抛错,逐条 try-catch 收集错误。返回统计 + 错误列表。
   */
  syncBatch(memories: readonly ParsedAutoMemory[]): SyncBatchStats {
    let proposed = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const memory of memories) {
      try {
        const result = this.syncMemory(memory);
        switch (result.action) {
          case "proposed":
            proposed += 1;
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
    return { proposed, updated, unchanged, skipped, failed, errors };
  }

  private readonly proposalEngine: ProposalEngine;
  private readonly defaultCreatedBy: string;
}
