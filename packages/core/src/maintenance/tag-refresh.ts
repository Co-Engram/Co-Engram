/**
 * 标签漂移刷新(REM tag-refresh)
 *
 * 解决的问题:导入/历史 engram 的 domainTags 笼统(`imported`/`uncategorized`)或
 * 与内容脱节,且 `updateEngram` 改 content 不重算标签 → 滞后。本模块在 REM 阶段
 * 周期性扫描,对「内容显著变化(≥阈值)」的 engram 用 LLM 重新提取内容语义标签。
 *
 * 三层过滤控 token(与 engram 总数 N 解耦):
 *   L0: 当前 contentHash == baseline.content_hash?→ skip(绝大多数命中,零 LLM)
 *   L1: contentHash 变了 → 算 token Jaccard(current vs baseline token set)
 *   L2: `1 - Jaccard ≥ 阈值` → LLM 提取新 domainTags;否则只更新 baseline(不调 LLM)
 *
 * baseline 不存在(首次/新 engram)→ 视为 100% 变化 → 无条件 LLM 刷新。
 * 现存 `imported` engram 靠此自动修正。
 *
 * 刷新直接落盘(`updateEngram`)+ audit,不走 proposal(标签低风险,审批堆积噪音)。
 *
 * 性能说明:首次启用时所有 active engram 的 baseline 都不存在 → 全部走 L2,
 * LLM 调用数 = active engram 数(一次性成本,后续 REM 只有 drift≥阈值的少数才调)。
 * REM 是低频后台阶段(runRem 失败不阻塞主流程),可接受。仓库极大时可后续加
 * maxRefreshPerRun 预算(本期未加,YAGNI)。
 *
 * @module @co-engram/core/maintenance
 */

import { extractEngramFieldsWithLlm } from "../observability/bare-markdown-extractor.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { tokenizeForDedup, jaccardSimilarity } from "../dedup/similar.js";
import type { EngramRepository } from "../storage/repository.js";
import type { AuditLog } from "../observability/audit-log.js";

/**
 * 内容变化阈值:token Jaccard 的「不相似度」达到此值才触发 LLM 刷新。
 * `1 - Jaccard(oldTokens, newTokens) ≥ 此值` → 刷新。
 * 默认 0.3(约 30% token 发生替换)。
 *
 * 模块级 const,不进 maintenance config(避免双宿主适配 / 中英文文档 / 帮助栏
 * 一串成本);将来有部署调参需求再提升。参照 `DEFAULT_GAP_CONFIG`(gap-detector.ts)、
 * `TRUTH_THRESHOLDS`(metacognition.ts)惯例。
 */
export const TAG_REFRESH_CHANGE_THRESHOLD = 0.3;

/** 单条刷新结果(统计/审计用) */
export interface TagRefreshOutcome {
  readonly engramId: string;
  readonly action:
    | "skipped-unchanged"
    | "skipped-below-threshold"
    | "refreshed"
    | "failed";
  readonly oldTags: readonly string[];
  readonly newTags?: readonly string[];
  readonly reason: string;
}

/** 一轮 REM 标签刷新的汇总 */
export interface TagRefreshReport {
  readonly scanned: number;
  readonly refreshed: number;
  readonly skippedUnchanged: number;
  readonly skippedBelowThreshold: number;
  readonly failed: number;
  readonly outcomes: readonly TagRefreshOutcome[];
}

/**
 * 执行一轮标签漂移刷新。
 *
 * @param repo 仓库(读 engram + updateEngram 写回;baseline 经 repo.indexDb)
 * @param auditLog 审计日志(刷新记 update audit);undefined 时只刷不记审计
 * @param llmClient LLM 客户端;undefined 时 L2 无法刷新,仅更新 baseline 标记已评估
 * @param options.updatedBy audit actor(默认 "rem-tag-refresh")
 * @param options.changeThreshold 覆盖默认阈值(测试/调参用)
 */
export async function refreshDomainTagsOnDrift(
  repo: EngramRepository,
  auditLog: AuditLog | undefined,
  llmClient: LlmClient | undefined,
  options: {
    readonly updatedBy?: string;
    readonly changeThreshold?: number;
  } = {},
): Promise<TagRefreshReport> {
  const updatedBy = options.updatedBy ?? "rem-tag-refresh";
  const threshold = options.changeThreshold ?? TAG_REFRESH_CHANGE_THRESHOLD;
  const runStartedAt = new Date().toISOString();

  const outcomes: TagRefreshOutcome[] = [];
  let refreshed = 0;
  let skippedUnchanged = 0;
  let skippedBelowThreshold = 0;
  let failed = 0;

  // 无 SQLite 索引层 → 无法存/读 baseline,机制 noop(不阻塞 REM 其他阶段)
  const indexDb = repo.indexDb;
  if (!indexDb) {
    return {
      scanned: 0,
      refreshed,
      skippedUnchanged,
      skippedBelowThreshold,
      failed,
      outcomes,
    };
  }

  // 1. 拿全部 engram 的 id + digest(contentHash / domainTags / status)
  const allIds = repo.listEngrams().map((e) => e.id);
  if (allIds.length === 0) {
    return {
      scanned: 0,
      refreshed,
      skippedUnchanged,
      skippedBelowThreshold,
      failed,
      outcomes,
    };
  }
  const digests = repo.readDigestBatch(allIds);
  const digestById = new Map(digests.map((d) => [d.id, d] as const));
  // content 来自 FTS content_tokens(批量 JOIN,消除 N+1 readEngram)
  const contents = repo.readContentBatch(allIds);
  const contentById = new Map(contents.map((c) => [c.id, c] as const));

  // 2. 一次性读全部 baseline(避免 N 次 prepare)
  const baselines = indexDb.readAllTagRefreshBaselines();

  for (const id of allIds) {
    const digest = digestById.get(id);
    const contentRow = contentById.get(id);
    if (!digest || !contentRow) continue;
    // 只刷 active(frozen/forgotten 不参与检索,标签无意义)
    if (digest.status !== "active") continue;

    const currentHash = digest.contentHash ?? "";
    const baseline = baselines.get(id);
    const oldTags = digest.domainTags;

    // ── L0:contentHash 相等 → 内容没变 → skip(绝大多数 engram 命中,零 LLM) ──
    if (baseline && baseline.contentHash === currentHash) {
      skippedUnchanged += 1;
      outcomes.push({
        engramId: id,
        action: "skipped-unchanged",
        oldTags,
        reason: "contentHash unchanged since last refresh",
      });
      continue;
    }

    // contentHash 变了(或 baseline 不存在=首次)。算 token Jaccard 判变化幅度。
    const currentTokens = tokenizeForDedup(
      `${contentRow.title} ${contentRow.summary} ${contentRow.content}`,
    );

    // baseline 不存在 → 首次,视为 100% 变化,无条件触发(修正 imported/uncategorized 存量)
    const drift =
      baseline === undefined
        ? 1
        : 1 - jaccardSimilarity(currentTokens, new Set(baseline.tokenSet));

    // ── L1:drift < 阈值 → 小改,只更新 baseline 标记已评估,不调 LLM ──
    if (baseline !== undefined && drift < threshold) {
      indexDb.upsertTagRefreshBaseline({
        engramId: id,
        tokenSet: [...currentTokens],
        contentHash: currentHash,
        refreshedAt: runStartedAt,
      });
      skippedBelowThreshold += 1;
      outcomes.push({
        engramId: id,
        action: "skipped-below-threshold",
        oldTags,
        reason: `drift ${drift.toFixed(2)} < threshold ${threshold}`,
      });
      continue;
    }

    // ── L2:drift ≥ 阈值(或首次)→ LLM 提取新 domainTags ──
    if (!llmClient) {
      // 无 LLM:无法刷新,但仍更新 baseline 避免下轮重复算 drift(标记已评估)
      indexDb.upsertTagRefreshBaseline({
        engramId: id,
        tokenSet: [...currentTokens],
        contentHash: currentHash,
        refreshedAt: runStartedAt,
      });
      failed += 1;
      outcomes.push({
        engramId: id,
        action: "failed",
        oldTags,
        reason: "drift exceeds threshold but llmClient not configured",
      });
      continue;
    }

    let newTags: readonly string[];
    try {
      const fields = await extractEngramFieldsWithLlm(contentRow.content, llmClient);
      newTags = fields.domainTags;
    } catch {
      // LLM 调用失败:不更新 baseline(下轮重试),记 failed
      failed += 1;
      outcomes.push({
        engramId: id,
        action: "failed",
        oldTags,
        reason: "LLM extraction threw",
      });
      continue;
    }

    // LLM 偶发返回空数组 → 兜底 uncategorized 标记待下轮再刷
    if (!Array.isArray(newTags) || newTags.length === 0) {
      newTags = ["uncategorized"];
    }

    // 直接落盘(不走 proposal:标签低风险,审批堆积噪音)
    try {
      repo.updateEngram(id, { domainTags: [...newTags], updatedBy });
    } catch {
      failed += 1;
      outcomes.push({
        engramId: id,
        action: "failed",
        oldTags,
        reason: "updateEngram threw",
      });
      continue;
    }

    // 更新 baseline + audit
    indexDb.upsertTagRefreshBaseline({
      engramId: id,
      tokenSet: [...currentTokens],
      contentHash: currentHash,
      refreshedAt: runStartedAt,
    });
    auditLog?.append({
      actor: "system",
      action: "update",
      engramId: id,
      metadata: {
        source: "rem-tag-refresh",
        oldTags,
        newTags,
        drift: Number(drift.toFixed(2)),
      },
    });
    refreshed += 1;
    outcomes.push({
      engramId: id,
      action: "refreshed",
      oldTags,
      newTags,
      reason: `drift ${drift.toFixed(2)} >= threshold ${threshold}`,
    });
  }

  return {
    scanned: allIds.length,
    refreshed,
    skippedUnchanged,
    skippedBelowThreshold,
    failed,
    outcomes,
  };
}
