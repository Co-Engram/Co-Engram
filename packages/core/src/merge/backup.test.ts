import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotLoser, cleanupOldBackups } from "./backup.js";

describe("snapshotLoser", () => {
  it("writes loser content under .co-engram/merge-backup/{date}/{relPath}.{side}", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-basic-${Date.now()}`), {
      recursive: true,
    });
    const content =
      "---\nid: 01HXXX\ntitle: loser version\n---\n\nloser body\n";

    const result = snapshotLoser({
      dataRoot,
      relPath: "engrams/AIOS/decision.md",
      side: "ours",
      content,
    });

    expect(result.backupPath).toMatch(
      /\.co-engram[\/]merge-backup[\/]\d{8}[\/]engrams[\/]AIOS[\/]decision\.md\.ours$/,
    );
    expect(existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath, "utf8")).toBe(content);
  });

  it("creates nested directories on first call", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-nested-${Date.now()}`), {
      recursive: true,
    });
    expect(existsSync(join(dataRoot, ".co-engram", "merge-backup"))).toBe(
      false,
    );

    snapshotLoser({
      dataRoot,
      relPath: "engrams/deep/nested/path.md",
      side: "theirs",
      content: "x",
    });

    expect(existsSync(join(dataRoot, ".co-engram", "merge-backup"))).toBe(true);
  });
});

describe("cleanupOldBackups", () => {
  it("deletes backup dirs older than ttlDays", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-cleanup-${Date.now()}`), {
      recursive: true,
    });
    const oldDir = join(dataRoot, ".co-engram", "merge-backup", "20250101");
    const recentDir = join(dataRoot, ".co-engram", "merge-backup", "20260620");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });
    writeFileSync(join(oldDir, "decision.md.ours"), "old");
    writeFileSync(join(recentDir, "decision.md.ours"), "recent");

    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
      ttlDays: 7,
    });

    expect(result.deleted).toEqual([join(oldDir, "decision.md.ours")]);
    expect(existsSync(join(oldDir, "decision.md.ours"))).toBe(false);
    expect(existsSync(join(recentDir, "decision.md.ours"))).toBe(true);
  });

  it("does nothing when no backup dir exists", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-empty-${Date.now()}`), {
      recursive: true,
    });
    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    expect(result.deleted).toEqual([]);
  });

  it("ignores non-date-named directories under merge-backup", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-junk-${Date.now()}`), {
      recursive: true,
    });
    const junkDir = join(dataRoot, ".co-engram", "merge-backup", "not-a-date");
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, "x"), "junk");

    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    expect(result.deleted).toEqual([]);
    expect(existsSync(junkDir)).toBe(true);
  });
});
