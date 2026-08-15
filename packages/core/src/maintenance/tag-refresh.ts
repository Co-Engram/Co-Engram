/**
 * 标签漂移刷新(REM tag-refresh)
 *
 * 解决的问题:导入/历史 engram 的 domainTags 笼统(`imported`/`uncategorized`)或
 * 与内容脱节,且 `updateEngram` 改 content 不重算标签 → 滞后。本模块在 REM 阶段
 * 周期性扫描,对「内容显著变化(≥阈值)」或「仍为占位标签」的 engram 用 LLM 重新
 * 提取内容语义标签。
 *
 * 三层过滤控 token(与 engram 总数 N 解耦):
 *   L0: 当前 contentHash == baseline.content_hash?→ skip(已分类记忆,绝大多数命中,零 LLM)
 *   L1: contentHash 变了 → 算 token Jaccard(current vs baseline token set)
 *   L2: `1 - Jaccard ≥ 阈值` → LLM 提取新 domainTags;否则只更新 baseline(不调 LLM)
 *
 * 占位符豁免(修卡死,2026-08):oldTags 全为 `imported`/`uncategorized` 的记忆
 * **绕过 L0/L1**——即使 contentHash 相等也进入 L2 重提。否则首次 LLM 偶发返回空 →
 * 兜底占位符 + baseline 写入 → 后续 L0 永久短路,占位标签永远刷不掉(与"待 REM
 * 刷新"的设计承诺矛盾)。
 *
 * 已有 pending 的 rem-tag-refresh proposal → 不重复提取(等用户先审),避免占位符
 * 每轮 REM 白调 LLM。
 *
 * 审批化(2026-08):提取出的新标签不再直接 `updateEngram`,而是生成 pending
 * proposal(rem-tag-refresh),与 rem-pattern/synapse/verification 对齐——用户在
 * 提案卡片 accept 才改 domainTags,dismiss 则保持。注入 proposalEngine 即走审批;
 * 未注入时退化为直接落盘(向后兼容)。
 *
 * 性能说明:首次启用时所有 active engram 的 baseline 都不存在 → 全部走 L2,
 * LLM 调用数 = active engram 数(一次性成本,后续 REM 只有 drift≥阈值或占位符
 * 的少数才调)。REM 是低频后台阶段(runRem 失败不阻塞主流程),可接受。
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
 * 模块级 const,不进 maintenance config(避免双宿主适配 / 中英文档 / 帮助栏
 * 一串成本);将来有部署调参需求再提升。参照 `DEFAULT_GAP_CONFIG`(gap-detector.ts)、
 * `TRUTH_THRESHOLDS`(metacognition.ts)惯例。
 */
export const TAG_REFRESH_CHANGE_THRESHOLD = 0.3;

/**
 * tag-refresh 只需 proposal 引擎的两个方法(结构类型,与 maintenance/types 的窄接口
 * 及完整 ProposalEngine class 均结构兼容,避免循环 import)。
 */
interface TagRefreshProposalSink {
  proposeTagRefresh(input: {
    readonly engramId: string;
    readonly oldTags: readonly string[];
    readonly newTags: readonly string[];
    readonly reason: string;
    readonly drift?: number;
    readonly engramTitle?: string;
  }): boolean;
  findProposalByEntityId(
    entityId: string,
  ): { readonly status?: string } | undefined;
}

/** 占位标签:语义为「分类未完成」,豁免 L0/L1 反复重提直到刷出真实标签 */
const PLACEHOLDER_TAGS = new Set(["imported", "uncategorized"]);

/**
 * 单个标签是否占位:笼统标签,或纯点号省略号("..." / "…" / 纯 "." 序列)——
 * 后者是 LLM/agent 为过非空校验填的占位(2026-08-15 真实库发现 10 条
 * domainTags=["...","..."] 的记忆),同样无分类意义。
 */
function isPlaceholderTag(t: string): boolean {
  if (PLACEHOLDER_TAGS.has(t)) return true;
  return t.trim().length > 0 && /^[.·]+$/.test(t) && t.includes(".");
}

/** oldTags 是否全为占位标签(空数组也视为占位——从未分类) */
function isPlaceholderOnly(tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  return tags.every((t) => isPlaceholderTag(t));
}

/** 单条刷新结果(统计/审计用) */
export interface TagRefreshOutcome {
  readonly engramId: string;
  readonly action:
    | "skipped-unchanged"
    | "skipped-below-threshold"
    | "skipped-pending-proposal"
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
 * @param proposalEngine 提案引擎;注入后提取结果走 pending proposal(审批卡片),
 *   accept 才改 domainTags;undefined 时退化为直接 updateEngram 落盘(向后兼容)
 * @param options.updatedBy audit actor(默认 "rem-tag-refresh")
 * @param options.changeThreshold 覆盖默认阈值(测试/调参用)
 */
export async function refreshDomainTagsOnDrift(
  repo: EngramRepository,
  auditLog: AuditLog | undefined,
  llmClient: LlmClient | undefined,
  proposalEngine?: TagRefreshProposalSink,
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

  // 一次性读全部 baseline(避免 N 次 prepare)
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
    const placeholder = isPlaceholderOnly(oldTags);

    // 已有 pending 的 rem-tag-refresh proposal → 不重复提取(等用户先审),
    // 避免占位符每轮 REM 白调 LLM(proposeTagRefresh 内部亦有 dedup,这里是前置短路)
    const existingProposal = proposalEngine?.findProposalByEntityId(
      `rem-tag-refresh:${id}`,
    );
    if (existingProposal?.status === "pending") {
      skippedBelowThreshold += 1;
      outcomes.push({
        engramId: id,
        action: "skipped-pending-proposal",
        oldTags,
        reason: "a pending rem-tag-refresh proposal already awaits review",
      });
      continue;
    }

    // ── L0:已分类记忆 + contentHash 相等 → skip(占位符豁免:占位符继续走 L2)──
    if (!placeholder && baseline && baseline.contentHash === currentHash) {
      skippedUnchanged += 1;
      outcomes.push({
        engramId: id,
        action: "skipped-unchanged",
        oldTags,
        reason: "contentHash unchanged since last refresh",
      });
      continue;
    }

    // contentHash 变了(或 baseline 不存在=首次 / 占位符豁免)。算 token Jaccard 判变化幅度。
    const currentTokens = tokenizeForDedup(
      `${contentRow.title} ${contentRow.summary} ${contentRow.content}`,
    );

    // baseline 不存在 = 首次评估。已分类(非占位)记忆首跑**只建 baseline 不调
    // LLM** —— 标签没坏就不必重提(2026-08-15 修正:此前首跑全量 LLM,真实库
    // 81 条中 60+ 条已分类记忆被无谓重提且因提取器预算全失败);占位标签
    // (uncategorized/imported/纯点号)是标签质量债,首跑即走 L2 重提
    const drift =
      baseline === undefined
        ? 1
        : 1 - jaccardSimilarity(currentTokens, new Set(baseline.tokenSet));

    // ── L1:已分类记忆 + (首次 或 drift < 阈值)→ 只写 baseline 不调 LLM ──
    if (!placeholder && (baseline === undefined || drift < threshold)) {
      indexDb.upsertTagRefreshBaseline({
        engramId: id,
        tokenSet: [...currentTokens],
        contentHash: currentHash,
        refreshedAt: runStartedAt,
      });
      if (baseline === undefined) {
        skippedUnchanged += 1;
        outcomes.push({
          engramId: id,
          action: "skipped-unchanged",
          oldTags,
          reason: "first evaluation with valid tags — baseline established, no LLM needed",
        });
      } else {
        skippedBelowThreshold += 1;
        outcomes.push({
          engramId: id,
          action: "skipped-below-threshold",
          oldTags,
          reason: `drift ${drift.toFixed(2)} < threshold ${threshold}`,
        });
      }
      continue;
    }

    // ── L2:drift ≥ 阈值(或首次 / 占位符)→ LLM 提取新 domainTags ──
    if (!llmClient) {
      // 无 LLM:无法刷新,但仍更新 baseline 避免下轮重复算 drift(标记已评估)。
      // 占位符豁免保证:即使 baseline 写了,占位符下轮仍进入 L2(等 LLM 恢复),不卡死。
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

    // parseExtractionResponse 已保证 newTags 非空(空时兜底 imported),此处无需再兜底。

    // 提取出与现有标签完全一致 → 无需提案,更新 baseline 即可。
    const sameAsOld =
      oldTags.length === newTags.length &&
      oldTags.every((t, i) => t === newTags[i]);
    if (sameAsOld) {
      indexDb.upsertTagRefreshBaseline({
        engramId: id,
        tokenSet: [...currentTokens],
        contentHash: currentHash,
        refreshedAt: runStartedAt,
      });
      skippedUnchanged += 1;
      outcomes.push({
        engramId: id,
        action: "skipped-unchanged",
        oldTags,
        reason: "extracted tags identical to current tags",
      });
      continue;
    }

    const reason = placeholder
      ? `占位标签(${[...oldTags].join(",")})刷新为内容语义标签`
      : `内容漂移(drift=${drift.toFixed(2)})触发标签重提`;

    if (proposalEngine) {
      // 审批化:生成 pending proposal(用户 accept 才改 domainTags)。
      // proposeTagRefresh 内部按 entityId 去重 + tombstone 防复活;返回 false 表示
      // 已有 pending/accepted/dismissed,本轮不重复提案。
      const proposed = proposalEngine.proposeTagRefresh({
        engramId: id,
        oldTags: [...oldTags],
        newTags: [...newTags],
        reason,
        drift,
        engramTitle: contentRow.title,
      });
      // baseline 更新:占位符豁免下,只要 pending proposal 存在就会被上面的
      // hasPendingProposal 检查短路,不会白调 LLM。
      indexDb.upsertTagRefreshBaseline({
        engramId: id,
        tokenSet: [...currentTokens],
        contentHash: currentHash,
        refreshedAt: runStartedAt,
      });
      if (proposed) {
        refreshed += 1;
        auditLog?.append({
          actor: "system",
          action: "update",
          engramId: id,
          metadata: {
            source: "rem-tag-refresh-proposed",
            oldTags,
            newTags,
            drift: Number(drift.toFixed(2)),
          },
        });
        outcomes.push({
          engramId: id,
          action: "refreshed",
          oldTags,
          newTags,
          reason,
        });
      } else {
        outcomes.push({
          engramId: id,
          action: "skipped-pending-proposal",
          oldTags,
          reason:
            "rem-tag-refresh proposal already pending/accepted/dismissed (dedup)",
        });
      }
    } else {
      // 退化:无 proposalEngine → 直接落盘(向后兼容,保旧行为)
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
        reason,
      });
    }
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
