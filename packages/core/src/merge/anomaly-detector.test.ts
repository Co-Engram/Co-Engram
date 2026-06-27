import { describe, it, expect } from "vitest";

import {
  detectAnomalies,
  formatAnomaliesAsText,
  DEFAULT_ANOMALY_THRESHOLDS,
  type AnomalyThresholds,
} from "./anomaly-detector.js";
import type { MergeStats } from "./merge-stats.js";

function makeStats(overrides: Partial<MergeStats> = {}): MergeStats {
  return {
    window: {
      since: "2026-06-20T00:00:00.000Z",
      until: "2026-06-27T00:00:00.000Z",
    },
    totalMerges: 100,
    autoResolved: 96,
    escalatedToMarkers: 4,
    llm: {
      arbitrated: 8,
      escalated: 1,
      failed: 1,
      totalInvocations: 10,
      successRate: 0.8,
    },
    backupFailures: 0,
    autoResolveRate: 0.96,
    byStrategy: {},
    byPath: {},
    byDay: {},
    ...overrides,
  };
}

describe("detectAnomalies", () => {
  it("健康 stats 无异常", () => {
    const anomalies = detectAnomalies(makeStats());
    expect(anomalies).toEqual([]);
  });

  it("backup 失败超阈值 → critical(不需 minSamples)", () => {
    const stats = makeStats({ backupFailures: 3, totalMerges: 2 });
    const anomalies = detectAnomalies(stats);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe("backup_failure");
    expect(anomalies[0]!.severity).toBe("critical");
    expect(anomalies[0]!.observed).toBe(3);
  });

  it("LLM 成功率低于 warning 阈值 → warning", () => {
    const stats = makeStats({
      llm: {
        arbitrated: 6,
        escalated: 2,
        failed: 2,
        totalInvocations: 10,
        successRate: 0.6,
      },
    });
    const anomalies = detectAnomalies(stats);
    const llm = anomalies.find((a) => a.kind === "low_llm_success_rate");
    expect(llm).toBeDefined();
    expect(llm!.severity).toBe("warning");
  });

  it("LLM 成功率低于 critical 阈值 → critical", () => {
    const stats = makeStats({
      llm: {
        arbitrated: 3,
        escalated: 3,
        failed: 4,
        totalInvocations: 10,
        successRate: 0.3,
      },
    });
    const anomalies = detectAnomalies(stats);
    const llm = anomalies.find((a) => a.kind === "low_llm_success_rate");
    expect(llm).toBeDefined();
    expect(llm!.severity).toBe("critical");
  });

  it("升级率超过阈值 → warning", () => {
    const stats = makeStats({
      totalMerges: 100,
      autoResolved: 90,
      escalatedToMarkers: 10,
      autoResolveRate: 0.9,
    });
    const anomalies = detectAnomalies(stats);
    const esc = anomalies.find((a) => a.kind === "high_escalation_rate");
    expect(esc).toBeDefined();
    expect(esc!.severity).toBe("warning");
    expect(esc!.observed).toBeCloseTo(0.1, 5);
  });

  it("自动解决率低于阈值 → warning", () => {
    const stats = makeStats({
      totalMerges: 100,
      autoResolved: 90,
      escalatedToMarkers: 10,
      autoResolveRate: 0.9,
    });
    const anomalies = detectAnomalies(stats);
    const auto = anomalies.find((a) => a.kind === "low_auto_resolve_rate");
    expect(auto).toBeDefined();
  });

  it("热点路径集中度超过阈值 → info", () => {
    const stats = makeStats({
      totalMerges: 100,
      byPath: { "engrams/hot.md": 50, "engrams/other.md": 50 },
    });
    const anomalies = detectAnomalies(stats);
    const hot = anomalies.find((a) => a.kind === "hot_path_concentration");
    expect(hot).toBeDefined();
    expect(hot!.severity).toBe("info");
    expect(hot!.observed).toBe(0.5);
  });

  it("样本不足时跳过比率类检查", () => {
    const stats = makeStats({
      totalMerges: 5,
      autoResolved: 0,
      escalatedToMarkers: 5,
      autoResolveRate: 0,
    });
    const anomalies = detectAnomalies(stats);
    expect(anomalies).toEqual([]);
  });

  it("自定义阈值覆盖默认值", () => {
    const stats = makeStats({ backupFailures: 0 });
    const custom: AnomalyThresholds = { backupFailuresCritical: 0 };
    const anomalies = detectAnomalies(stats, custom);
    expect(anomalies.some((a) => a.kind === "backup_failure")).toBe(true);
  });

  it("critical 异常排在 warning 之前", () => {
    const stats = makeStats({
      totalMerges: 100,
      autoResolved: 50,
      escalatedToMarkers: 50,
      autoResolveRate: 0.5,
      backupFailures: 5,
    });
    const anomalies = detectAnomalies(stats);
    const criticalIdx = anomalies.findIndex((a) => a.severity === "critical");
    const warningIdx = anomalies.findIndex((a) => a.severity === "warning");
    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeGreaterThan(criticalIdx);
  });

  it("无 LLM 调用时不检查 LLM 成功率", () => {
    const stats = makeStats({
      llm: {
        arbitrated: 0,
        escalated: 0,
        failed: 0,
        totalInvocations: 0,
        successRate: 0,
      },
    });
    const anomalies = detectAnomalies(stats);
    expect(anomalies.some((a) => a.kind === "low_llm_success_rate")).toBe(
      false,
    );
  });

  it("DEFAULT_ANOMALY_THRESHOLDS 与 spec §13.1 KPI 一致", () => {
    expect(DEFAULT_ANOMALY_THRESHOLDS.llmSuccessRateWarning).toBe(0.7);
    expect(DEFAULT_ANOMALY_THRESHOLDS.escalationRateWarning).toBe(0.05);
    expect(DEFAULT_ANOMALY_THRESHOLDS.autoResolveRateWarning).toBe(0.95);
  });
});

describe("formatAnomaliesAsText", () => {
  it("无异常返回 ✓", () => {
    const text = formatAnomaliesAsText([]);
    expect(text).toContain("✓");
    expect(text).toContain("无异常");
  });

  it("异常列表格式化为多行", () => {
    const stats = makeStats({
      totalMerges: 100,
      autoResolved: 50,
      escalatedToMarkers: 50,
      autoResolveRate: 0.5,
      backupFailures: 2,
    });
    const anomalies = detectAnomalies(stats);
    const text = formatAnomaliesAsText(anomalies);
    expect(text).toContain("CRITICAL");
    expect(text).toContain("WARNING");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});
