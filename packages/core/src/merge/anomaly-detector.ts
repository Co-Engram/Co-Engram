/**
 * 异常检测(spec §13.1 KPI 表 + §13.2 "异常报警")。
 *
 * 把 MergeStats 与一组可配置阈值比对,返回违规列表(带严重级别)。
 * 设计原则:
 *  - 纯函数,不读 audit log / 不调 LLM;输入已聚合的 MergeStats
 *  - 阈值有默认值(spec §13.1),但全部可覆盖以便团队调校
 *  - 样本不足时(总 merge 数 < minSamples)跳过比率类检查,避免噪声
 *
 * spec §13.2 触发场景:
 *  - LLM 仲裁率飙升(可能 prompt drift)→ successRate 低于阈值
 *  - 备份失败(磁盘问题)→ backupFailures 超过阈值
 *  - 团队集中编辑核心 engram → escalatedToMarkers 比率超标
 *
 * @module @co-engram/core/merge
 */

import type { MergeStats } from "./merge-stats.js";

/** 异常严重级别。 */
export type AnomalySeverity = "info" | "warning" | "critical";

/** 异常种类标识符(稳定字符串,便于过滤 / audit)。 */
export type AnomalyKind =
  | "low_llm_success_rate"
  | "high_escalation_rate"
  | "low_auto_resolve_rate"
  | "backup_failure"
  | "hot_path_concentration";

/** 单条异常报告。 */
export interface Anomaly {
  /** 异常种类。 */
  readonly kind: AnomalyKind;
  /** 严重级别。 */
  readonly severity: AnomalySeverity;
  /** 人类可读描述(含具体数值)。 */
  readonly message: string;
  /** 当前观测值。 */
  readonly observed: number;
  /** 触发的阈值。 */
  readonly threshold: number;
}

/** 可配置阈值(全部可选,有默认值)。 */
export interface AnomalyThresholds {
  /** LLM 仲裁成功率低于此值 → warning(spec §13.1 目标 ≥ 0.7)。 */
  readonly llmSuccessRateWarning?: number;
  /** LLM 仲裁成功率低于此值 → critical。 */
  readonly llmSuccessRateCritical?: number;
  /** 升级到 markers 的比率超过此值 → warning(spec §13.1 目标 ≤ 0.05)。 */
  readonly escalationRateWarning?: number;
  /** 自动解决率低于此值 → warning(spec §13.1 目标 ≥ 0.95)。 */
  readonly autoResolveRateWarning?: number;
  /** 备份失败次数(窗口内绝对值)超过此值 → critical(spec §13.1 备份失败率 ≤ 0.1%)。 */
  readonly backupFailuresCritical?: number;
  /** 单条路径占总冲突比率超过此值 → warning(热点集中)。 */
  readonly hotPathConcentrationWarning?: number;
  /** 比率类检查的最小样本数,不足则跳过(避免小样本噪声)。 */
  readonly minSamples?: number;
}

export const DEFAULT_ANOMALY_THRESHOLDS: Required<AnomalyThresholds> = {
  llmSuccessRateWarning: 0.7,
  llmSuccessRateCritical: 0.5,
  escalationRateWarning: 0.05,
  autoResolveRateWarning: 0.95,
  backupFailuresCritical: 1,
  hotPathConcentrationWarning: 0.4,
  minSamples: 10,
};

/**
 * 检测异常。
 *
 * @param stats 已聚合的 MergeStats(由 computeMergeStats 产生)
 * @param thresholds 可选阈值覆盖
 * @returns 异常列表,按 severity 降序排列(critical → warning → info)
 */
export function detectAnomalies(
  stats: MergeStats,
  thresholds: AnomalyThresholds = {},
): Anomaly[] {
  const t = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  const anomalies: Anomaly[] = [];

  // 备份失败是绝对值检查,不需要 minSamples
  if (stats.backupFailures >= t.backupFailuresCritical) {
    anomalies.push({
      kind: "backup_failure",
      severity: "critical",
      message: `Backup 失败 ${stats.backupFailures} 次(阈值 ≥${t.backupFailuresCritical}),可能存在磁盘问题`,
      observed: stats.backupFailures,
      threshold: t.backupFailuresCritical,
    });
  }

  // 比率类检查需要足够样本
  if (stats.totalMerges >= t.minSamples) {
    // LLM 成功率(只在有 LLM 调用时检查)
    if (stats.llm.totalInvocations > 0) {
      const rate = stats.llm.successRate;
      if (rate < t.llmSuccessRateCritical) {
        anomalies.push({
          kind: "low_llm_success_rate",
          severity: "critical",
          message: `LLM 仲裁成功率 ${(rate * 100).toFixed(1)}% 低于 ${(
            t.llmSuccessRateCritical * 100
          ).toFixed(0)}%(critical),可能是 prompt drift 或上游故障`,
          observed: rate,
          threshold: t.llmSuccessRateCritical,
        });
      } else if (rate < t.llmSuccessRateWarning) {
        anomalies.push({
          kind: "low_llm_success_rate",
          severity: "warning",
          message: `LLM 仲裁成功率 ${(rate * 100).toFixed(1)}% 低于 ${(
            t.llmSuccessRateWarning * 100
          ).toFixed(0)}%(warning)`,
          observed: rate,
          threshold: t.llmSuccessRateWarning,
        });
      }
    }

    // 升级率
    const escalationRate =
      stats.totalMerges > 0 ? stats.escalatedToMarkers / stats.totalMerges : 0;
    if (escalationRate > t.escalationRateWarning) {
      anomalies.push({
        kind: "high_escalation_rate",
        severity: "warning",
        message: `冲突升级率 ${(escalationRate * 100).toFixed(1)}% 超过 ${(
          t.escalationRateWarning * 100
        ).toFixed(0)}%(spec §13.1 目标 ≤ 5%)`,
        observed: escalationRate,
        threshold: t.escalationRateWarning,
      });
    }

    // 自动解决率
    if (stats.autoResolveRate < t.autoResolveRateWarning) {
      anomalies.push({
        kind: "low_auto_resolve_rate",
        severity: "warning",
        message: `自动解决率 ${(stats.autoResolveRate * 100).toFixed(1)}% 低于 ${(
          t.autoResolveRateWarning * 100
        ).toFixed(0)}%(spec §13.1 目标 ≥ 95%)`,
        observed: stats.autoResolveRate,
        threshold: t.autoResolveRateWarning,
      });
    }

    // 热点路径集中度
    const pathEntries = Object.entries(stats.byPath);
    if (pathEntries.length > 0) {
      const maxPath = pathEntries.reduce((a, b) => (a[1] > b[1] ? a : b));
      const concentration = maxPath[1] / stats.totalMerges;
      if (concentration > t.hotPathConcentrationWarning) {
        anomalies.push({
          kind: "hot_path_concentration",
          severity: "info",
          message: `路径 "${maxPath[0]}" 占冲突的 ${(
            concentration * 100
          ).toFixed(
            1,
          )}%(>${(t.hotPathConcentrationWarning * 100).toFixed(0)}%),可能存在团队集中编辑`,
          observed: concentration,
          threshold: t.hotPathConcentrationWarning,
        });
      }
    }
  }

  return sortAnomalies(anomalies);
}

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sortAnomalies(anomalies: readonly Anomaly[]): Anomaly[] {
  return [...anomalies].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** 把异常列表格式化成人类可读文本(供 CLI 输出)。 */
export function formatAnomaliesAsText(anomalies: readonly Anomaly[]): string {
  if (anomalies.length === 0) {
    return "✓ 无异常告警 — 所有 KPI 在阈值内。";
  }
  const lines = anomalies.map((a) => {
    const icon =
      a.severity === "critical" ? "✗" : a.severity === "warning" ? "⚠" : "ℹ";
    return `[${a.severity.toUpperCase()}] ${icon} ${a.kind}: ${a.message}`;
  });
  return lines.join("\n");
}
