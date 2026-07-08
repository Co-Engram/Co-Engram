/**
 * Light Dreaming（海马 CA3 模式完成：批量去重）
 *
 * 神经科学依据：海马 CA3 区在睡眠中重放近期经历，完成"模式补全"，
 * 把重复的记忆痕迹合并到同一表征。
 *
 * 实现（spec §5.2）：
 *   - 遍历所有 active engram
 *   - 对每个 engram 调 checkDuplicateSync 查"是否是其他 engram 的重复/相似"
 *   - DUPLICATE：强化 targetId，删除当前
 *   - UPDATE：合并到 targetId，删除当前
 *   - NEW：保留
 *
 * 处理顺序：按 id 字典序，保留第一个（稳定且 prompt-cache 友好）。
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramCreateInput } from "../types/engram.js";
import { checkDuplicateSync } from "../dedup/dedupe.js";
import { mergeEngram } from "../dedup/merge.js";
import { recordRetrievalSuccess } from "../reinforcement/ltp.js";

export interface LightDreamingOptions {
  /** 相似度引擎的最小 similarity（默认 0.3） */
  readonly minSimilarity?: number;
  /** Top-K 候选（默认 5） */
  readonly topK?: number;
  /** 只读模式：只计算不落盘 */
  readonly dryRun?: boolean;
}

export interface DedupActionRecord {
  /** 被合并/删除的 engram id */
  readonly from: string;
  /** 合并到的目标 engram id */
  readonly to: string;
  /** 触发原因（来自 triage reason） */
  readonly reason: string;
  /** 置信度（DUPLICATE=1，UPDATE=similarity） */
  readonly confidence?: number;
}

export interface LightDreamingResult {
  /** 扫描的 active engram 数 */
  readonly scanned: number;
  /** DUPLICATE 处理记录 */
  readonly duplicatesHandled: DedupActionRecord[];
  /** UPDATE 处理记录 */
  readonly updatesHandled: DedupActionRecord[];
  /** NEW 保留数 */
  readonly newConsidered: number;
}

/**
 * 执行 Light Dreaming（批量去重）
 *
 * 只处理 status=active 的 engram；已经是 archived/forgotten 的跳过。
 * 如果 dryRun=true，只返回计算结果不落盘。
 */
export function runLightDreaming(
  repo: EngramRepository,
  options: LightDreamingOptions = {},
): LightDreamingResult {
  const minSimilarity = options.minSimilarity ?? 0.3;
  const topK = options.topK ?? 5;
  const dryRun = options.dryRun ?? false;

  const duplicatesHandled: DedupActionRecord[] = [];
  const updatesHandled: DedupActionRecord[] = [];
  const removed = new Set<string>();

  // 按 id 字典序稳定扫描
  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  // 批量预取 digest + content,消除循环内 readEngram(N+1 → 2 次 SQL 查询)
  // 性能修复(2026-07):旧实现循环内 repo.readEngram(entry.id),N=1026 时
  // 同步阻塞 event loop 30s+。checkDuplicateSync 内部只需要 title + content
  // 做相似度比对,encodingContext/visibility 等字段在 dedupe 阶段不参与计算。
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );
  const contentById = new Map(
    repo.readContentBatch(allIds).map((c) => [c.id, c] as const),
  );

  let scanned = 0;
  for (const entry of entries) {
    if (removed.has(entry.id)) continue;
    const digest = digestById.get(entry.id);
    const content = contentById.get(entry.id);
    if (!digest || !content) continue;
    if (digest.status !== "active") continue;
    scanned += 1;

    const dedupInput: EngramCreateInput = {
      title: content.title,
      content: content.content,
      kind: digest.kind as EngramCreateInput["kind"],
      kinds: digest.kinds as EngramCreateInput["kinds"],
      summary: content.summary,
      domainTags: [...digest.domainTags],
      contextTags: [...digest.contextTags],
      importance: digest.importance,
      confidence: digest.confidence,
      sourceType: digest.sourceType as EngramCreateInput["sourceType"],
      createdBy: digest.createdBy,
    };

    const result = checkDuplicateSync(
      { repository: repo, options: { minSimilarity, topK } },
      dedupInput,
    );

    // targetId 是自己 → 跳过（理论上 checkDuplicate 会返回自己作为候选）
    if (!result.targetId || result.targetId === entry.id) continue;

    // 目标已被删除（例如先前的合并）→ 跳过
    if (removed.has(result.targetId)) continue;
    if (!repo.exists(result.targetId)) continue;

    if (result.verdict === "DUPLICATE") {
      // 强化目标，删除当前
      if (!dryRun) {
        recordRetrievalSuccess(repo, result.targetId, 1);
        repo.deleteEngram(entry.id);
      }
      removed.add(entry.id);
      duplicatesHandled.push({
        from: entry.id,
        to: result.targetId,
        reason: result.reason,
        confidence: result.confidence,
      });
    } else if (result.verdict === "UPDATE") {
      // 合并到目标，删除当前
      if (!dryRun) {
        mergeEngram(repo, {
          id: result.targetId,
          newTitle: content.title,
          newContent: content.content,
          newSummary: content.summary,
          newImportance: digest.importance,
          mergedBy: "dreaming-light",
          reason: result.reason ?? "light dreaming auto-merge",
        });
        repo.deleteEngram(entry.id);
      }
      removed.add(entry.id);
      updatesHandled.push({
        from: entry.id,
        to: result.targetId,
        reason: result.reason,
        confidence: result.confidence,
      });
    }
  }

  return {
    scanned,
    duplicatesHandled,
    updatesHandled,
    newConsidered: scanned - duplicatesHandled.length - updatesHandled.length,
  };
}
