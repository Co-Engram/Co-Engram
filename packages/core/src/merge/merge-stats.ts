/**
 * Merge statistics (spec §7.4, §9) — 从 audit log 聚合 merge driver 指标。
 *
 * 用途:
 *   - `co-engram merge stats` CLI 输出
 *   - viewer "Merges" tab 数据源
 *   - anomaly detection(P4.4)的输入
 *
 * 设计:纯函数 + 注入 AuditLog,便于测试。
 *
 * @module @co-engram/core/merge
 */

import type {
  AuditLog,
  AuditEntry,
  AuditAction,
} from "../observability/audit-log.js";

/** Merge-related audit actions(spec §5.5 + §9)。 */
const MERGE_ACTIONS: readonly AuditAction[] = [
  "merge_resolved",
  "merge_conflict_escalated",
  "merge_backup_failed",
  "merge_llm_arbitrated",
  "merge_llm_arbitrated_escalated",
  "merge_llm_arbitrated_failed",
];

/** 默认统计窗口:7 天(spec §9 operational window)。 */
export const DEFAULT_STATS_WINDOW_DAYS = 7;

export interface MergeStatsWindow {
  readonly since: string; // ISO
  readonly until: string; // ISO
}

export interface MergeStats {
  readonly window: MergeStatsWindow;
  /** 总 merge 处理数(resolved + escalated)。 */
  readonly totalMerges: number;
  /** 自动解决数(merge_resolved)。 */
  readonly autoResolved: number;
  /** 升级到 markers 的冲突数(merge_conflict_escalated)。 */
  readonly escalatedToMarkers: number;
  /** LLM 介入统计。 */
  readonly llm: LlmStats;
  /** Backup 失败数(spec §9 健康指标)。 */
  readonly backupFailures: number;
  /** 自动解决率 [0,1] = autoResolved / totalMerges。 */
  readonly autoResolveRate: number;
  /** 按策略(strategy)分组的解决计数(metadata.reason)。 */
  readonly byStrategy: Readonly<Record<string, number>>;
  /** 按路径分组的冲突计数(metadata.path)。 */
  readonly byPath: Readonly<Record<string, number>>;
  /** 按天聚合的 merge 总数(YYYY-MM-DD → count),用于趋势分析。 */
  readonly byDay: Readonly<Record<string, number>>;
}

export interface LlmStats {
  /** LLM 成功仲裁数(merge_llm_arbitrated)。 */
  readonly arbitrated: number;
  /** LLM 介入但 escalate 的数(置信度不够等)。 */
  readonly escalated: number;
  /** LLM 调用失败数(网络 / parse / timeout)。 */
  readonly failed: number;
  /** LLM 总调用尝试 = arbitrated + escalated + failed。 */
  readonly totalInvocations: number;
  /** 成功率 [0,1] = arbitrated / totalInvocations。 */
  readonly successRate: number;
}

/**
 * 聚合 audit log 为 merge 统计。
 *
 * @param auditLog 要读取的 audit log
 * @param windowMs 时间窗口(默认 7 天),从 now 向前回溯
 */
export function computeMergeStats(params: {
  auditLog: AuditLog;
  windowMs?: number;
  now?: () => Date;
}): MergeStats {
  const { auditLog, now = () => new Date() } = params;
  const windowMs =
    params.windowMs ?? DEFAULT_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const until = now();
  const since = new Date(until.getTime() - windowMs);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const entries = auditLog.query({
    since: sinceIso,
    until: untilIso,
    action: MERGE_ACTIONS,
  });

  return aggregateEntries(entries, { since: sinceIso, until: untilIso });
}

function aggregateEntries(
  entries: readonly AuditEntry[],
  window: MergeStatsWindow,
): MergeStats {
  let autoResolved = 0;
  let escalatedToMarkers = 0;
  let backupFailures = 0;
  let llmArbitrated = 0;
  let llmEscalated = 0;
  let llmFailed = 0;

  const byStrategy: Record<string, number> = {};
  const byPath: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const entry of entries) {
    // 按天聚合(YYYY-MM-DD)
    const day = entry.ts.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;

    switch (entry.action) {
      case "merge_resolved":
        autoResolved++;
        if (entry.metadata?.reason) {
          const reason = String(entry.metadata.reason);
          byStrategy[reason] = (byStrategy[reason] ?? 0) + 1;
        }
        break;
      case "merge_conflict_escalated":
        escalatedToMarkers++;
        if (entry.metadata?.path) {
          const p = String(entry.metadata.path);
          byPath[p] = (byPath[p] ?? 0) + 1;
        }
        break;
      case "merge_backup_failed":
        backupFailures++;
        break;
      case "merge_llm_arbitrated":
        llmArbitrated++;
        break;
      case "merge_llm_arbitrated_escalated":
        llmEscalated++;
        break;
      case "merge_llm_arbitrated_failed":
        llmFailed++;
        break;
    }
  }

  const totalMerges = autoResolved + escalatedToMarkers;
  const llmTotal = llmArbitrated + llmEscalated + llmFailed;

  return {
    window,
    totalMerges,
    autoResolved,
    escalatedToMarkers,
    llm: {
      arbitrated: llmArbitrated,
      escalated: llmEscalated,
      failed: llmFailed,
      totalInvocations: llmTotal,
      successRate: llmTotal === 0 ? 0 : llmArbitrated / llmTotal,
    },
    backupFailures,
    autoResolveRate: totalMerges === 0 ? 0 : autoResolved / totalMerges,
    byStrategy,
    byPath,
    byDay,
  };
}

/**
 * 把 MergeStats 格式化成人类可读的文本(供 CLI 使用)。
 */
export function formatMergeStatsAsText(stats: MergeStats): string {
  const lines: string[] = [];
  const w = stats.window;
  lines.push(`co-engram merge stats`);
  lines.push(`  window: ${w.since} → ${w.until}`);
  lines.push(`  `);
  lines.push(`  total merges:       ${stats.totalMerges}`);
  lines.push(
    `  auto-resolved:      ${stats.autoResolved} (${pct(stats.autoResolveRate)})`,
  );
  lines.push(`  escalated(markers): ${stats.escalatedToMarkers}`);
  lines.push(`  `);
  lines.push(`  LLM arbitration:`);
  lines.push(`    total:       ${stats.llm.totalInvocations}`);
  lines.push(`    succeeded:   ${stats.llm.arbitrated}`);
  lines.push(`    escalated:   ${stats.llm.escalated}`);
  lines.push(`    failed:      ${stats.llm.failed}`);
  lines.push(`    success rate:${pct(stats.llm.successRate)}`);
  lines.push(`  `);
  lines.push(`  backup failures:    ${stats.backupFailures}`);

  // Top strategies
  const strategies = Object.entries(stats.byStrategy).sort(
    (a, b) => b[1] - a[1],
  );
  if (strategies.length > 0) {
    lines.push(`  `);
    lines.push(`  top strategies:`);
    for (const [s, n] of strategies.slice(0, 5)) {
      lines.push(`    ${n.toString().padStart(5)}  ${s}`);
    }
  }

  // Hot paths
  const paths = Object.entries(stats.byPath).sort((a, b) => b[1] - a[1]);
  if (paths.length > 0) {
    lines.push(`  `);
    lines.push(`  hot paths (most conflicts):`);
    for (const [p, n] of paths.slice(0, 5)) {
      lines.push(`    ${n.toString().padStart(5)}  ${p}`);
    }
  }

  return lines.join("\n") + "\n";
}

function pct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}
