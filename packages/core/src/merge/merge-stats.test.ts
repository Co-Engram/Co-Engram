import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../observability/audit-log.js";
import { computeMergeStats, formatMergeStatsAsText } from "./merge-stats.js";
import type { AuditEntry } from "../observability/audit-log.js";

function iso(daysAgo: number, now = new Date("2026-06-15T12:00:00Z")): string {
  // 减去 1 分钟避免 audit query 的 until 严格 >= 过滤把当前时刻排除
  return new Date(
    now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - 60 * 1000,
  ).toISOString();
}

function writeAuditLines(
  dir: string,
  entries: Array<Omit<AuditEntry, "ts"> & { ts?: string }>,
): void {
  mkdirSync(join(dir, ".co-engram"), { recursive: true });
  const lines = entries.map((e) => {
    const { ts = iso(0), ...rest } = e;
    return JSON.stringify({ ts, ...rest });
  });
  writeFileSync(
    join(dir, ".co-engram", "audit.jsonl"),
    lines.join("\n") + "\n",
  );
}

describe("computeMergeStats", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-stats-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty stats for empty audit log", () => {
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.totalMerges).toBe(0);
    expect(stats.autoResolved).toBe(0);
    expect(stats.escalatedToMarkers).toBe(0);
    expect(stats.llm.totalInvocations).toBe(0);
    expect(stats.autoResolveRate).toBe(0);
  });

  it("counts merge_resolved and merge_conflict_escalated", () => {
    writeAuditLines(dir, [
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "frontmatter-field-arbitration" },
      },
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "frontmatter-field-arbitration" },
      },
      {
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: "engrams/AIOS/x.md" },
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.totalMerges).toBe(3);
    expect(stats.autoResolved).toBe(2);
    expect(stats.escalatedToMarkers).toBe(1);
    expect(stats.autoResolveRate).toBeCloseTo(2 / 3, 5);
  });

  it("respects window: ignores entries older than window", () => {
    writeAuditLines(dir, [
      {
        ts: iso(3),
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "old" },
      },
      {
        ts: iso(20),
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "ancient" },
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      windowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.totalMerges).toBe(1); // 仅 3 天前的
    expect(stats.byStrategy).toEqual({ old: 1 });
  });

  it("aggregates LLM arbitration counts", () => {
    writeAuditLines(dir, [
      { actor: "llm", action: "merge_llm_arbitrated" },
      { actor: "llm", action: "merge_llm_arbitrated" },
      { actor: "llm", action: "merge_llm_arbitrated_escalated" },
      { actor: "llm", action: "merge_llm_arbitrated_failed" },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.llm.arbitrated).toBe(2);
    expect(stats.llm.escalated).toBe(1);
    expect(stats.llm.failed).toBe(1);
    expect(stats.llm.totalInvocations).toBe(4);
    expect(stats.llm.successRate).toBeCloseTo(0.5, 5);
  });

  it("counts backup failures", () => {
    writeAuditLines(dir, [
      {
        actor: "system",
        action: "merge_backup_failed",
        metadata: { path: "x" },
      },
      {
        actor: "system",
        action: "merge_backup_failed",
        metadata: { path: "y" },
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.backupFailures).toBe(2);
  });

  it("groups by strategy and path", () => {
    writeAuditLines(dir, [
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "git-3way-clean" },
      },
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "git-3way-clean" },
      },
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "updatedAt-fallback" },
      },
      {
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: "engrams/AIOS/a.md" },
      },
      {
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: "engrams/AIOS/a.md" },
      },
      {
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: "synapses/causes/x.yaml" },
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    expect(stats.byStrategy).toEqual({
      "git-3way-clean": 2,
      "updatedAt-fallback": 1,
    });
    expect(stats.byPath).toEqual({
      "engrams/AIOS/a.md": 2,
      "synapses/causes/x.yaml": 1,
    });
  });

  it("groups by day for trend analysis", () => {
    writeAuditLines(dir, [
      {
        ts: iso(0),
        actor: "system",
        action: "merge_resolved",
      },
      {
        ts: iso(0),
        actor: "system",
        action: "merge_resolved",
      },
      {
        ts: iso(1),
        actor: "system",
        action: "merge_resolved",
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    const days = Object.keys(stats.byDay);
    expect(days).toHaveLength(2);
    expect(stats.byDay["2026-06-15"]).toBe(2);
    expect(stats.byDay["2026-06-14"]).toBe(1);
  });
});

describe("formatMergeStatsAsText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-stats-fmt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders empty stats without error", () => {
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    const text = formatMergeStatsAsText(stats);
    expect(text).toContain("total merges:       0");
    expect(text).toContain("co-engram merge stats");
  });

  it("renders strategy and path sections when present", () => {
    writeAuditLines(dir, [
      {
        actor: "system",
        action: "merge_resolved",
        metadata: { reason: "frontmatter-field-arbitration" },
      },
      {
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: "engrams/AIOS/x.md" },
      },
    ]);
    const audit = new AuditLog(dir);
    const stats = computeMergeStats({
      auditLog: audit,
      now: () => new Date("2026-06-15T12:00:00Z"),
    });
    const text = formatMergeStatsAsText(stats);
    expect(text).toContain("top strategies:");
    expect(text).toContain("frontmatter-field-arbitration");
    expect(text).toContain("hot paths");
    expect(text).toContain("engrams/AIOS/x.md");
  });
});
