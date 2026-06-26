/**
 * Digest 索引构建器
 *
 * 扫描仓库中所有 engram 文件（单文件布局）,构建 digest.jsonl 索引。
 * 支持增量构建（基于 mtime / contentHash 对比）。
 *
 * @module @co-engram/core/index
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import type { DigestBuildResult, DigestLine } from "./types.js";

/**
 * 从 engram id 读取所有需要的字段
 */
export function readDigestLine(
  repo: EngramRepository,
  id: string,
): DigestLine | null {
  if (!repo.exists(id)) {
    return null;
  }
  const engram = repo.readEngram(id);
  return {
    id: engram.id,
    title: engram.title,
    kind: engram.kind,
    kinds: engram.kinds,
    summary: engram.summary,
    domainTags: engram.domainTags,
    contextTags: engram.contextTags,
    importance: engram.importance,
    importanceVector: engram.importanceVector,
    emotionalValence: engram.emotionalValence,
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
    decayHalfLifeDays: engram.decayHalfLifeDays,
    contentSize: engram.contentSize,
    contentHash: engram.contentHash,
    outgoingSynapseCount: engram.outgoingSynapseCount,
    incomingSynapseCount: engram.incomingSynapseCount,
    activeContradictionCount: engram.activeContradictionCount,
  };
}

/**
 * Digest 构建器
 */
export class DigestBuilder {
  constructor(
    private readonly repo: EngramRepository,
    private readonly cachePath: string,
  ) {}

  /** digest.jsonl 路径 */
  get digestFilePath(): string {
    return join(this.cachePath, "digest.jsonl");
  }

  /**
   * 读取现有 digest（按 id 索引）
   */
  readExisting(): Map<string, DigestLine> {
    const map = new Map<string, DigestLine>();
    if (!existsSync(this.digestFilePath)) {
      return map;
    }
    const raw = readFileSync(this.digestFilePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as DigestLine;
        map.set(parsed.id, parsed);
      } catch {
        // 跳过无效行
      }
    }
    return map;
  }

  /**
   * 增量构建 digest 索引
   *
   * 通过对比 engram.updatedAt 和 contentHash 判断是否变化
   */
  buildIncremental(): DigestBuildResult {
    const existing = this.readExisting();
    const entries = this.repo.listEngramIndex();
    const currentIds = new Set<string>();
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let removed = 0;

    const result = new Map<string, DigestLine>();

    for (const entry of entries) {
      currentIds.add(entry.id);
      const newLine = readDigestLine(this.repo, entry.id);
      if (!newLine) {
        continue;
      }

      const oldLine = existing.get(entry.id);
      if (!oldLine) {
        added++;
      } else if (
        oldLine.updatedAt !== newLine.updatedAt ||
        oldLine.contentHash !== newLine.contentHash
      ) {
        updated++;
      } else {
        unchanged++;
      }
      result.set(entry.id, newLine);
    }

    // 统计被删除的
    for (const id of existing.keys()) {
      if (!currentIds.has(id)) {
        removed++;
      }
    }

    this.write(result.values());

    return {
      total: result.size,
      added,
      updated,
      unchanged,
      removed,
    };
  }

  /**
   * 完全重建（强制全量）
   */
  rebuild(): DigestBuildResult {
    const entries = this.repo.listEngramIndex();
    const result = new Map<string, DigestLine>();
    let added = 0;

    for (const entry of entries) {
      const newLine = readDigestLine(this.repo, entry.id);
      if (!newLine) {
        continue;
      }
      result.set(entry.id, newLine);
      added++;
    }

    this.write(result.values());

    return {
      total: result.size,
      added,
      updated: 0,
      unchanged: 0,
      removed: 0,
    };
  }

  /**
   * 写入 digest.jsonl
   */
  private write(lines: Iterable<DigestLine>): void {
    mkdirSync(this.cachePath, { recursive: true });
    const text = Array.from(lines)
      .map((line) => JSON.stringify(line))
      .join("\n");
    writeFileSync(this.digestFilePath, text + "\n", "utf8");
  }
}

/**
 * 收集仓库中所有 engram 的 DigestLine(纯内存,不写文件)
 *
 * 用于 search 索引重建等场景:需要真实 importance / decayHalfLifeDays /
 * retrievalCount 等字段参与三因子打分,但又不需要持久化 digest.jsonl 缓存。
 *
 * 与 `DigestBuilder.rebuild()` 区别:
 *   - `DigestBuilder.rebuild()` 写文件 + 返回统计
 *   - `collectDigestLines()` 不写文件,直接返回 DigestLine[]
 *
 * 行为:
 *   - 跳过 repo.exists(id) 为 false 的条目(可能并发删除)
 *   - 跳过 readEngram 失败的条目(损坏文件由 repository 层吞错)
 *   - 返回顺序与 repo.listEngramIndex() 一致(确定性)
 */
export function collectDigestLines(repo: EngramRepository): DigestLine[] {
  const out: DigestLine[] = [];
  for (const entry of repo.listEngramIndex()) {
    const line = readDigestLine(repo, entry.id);
    if (line) out.push(line);
  }
  return out;
}
