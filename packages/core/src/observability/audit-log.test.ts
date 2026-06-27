import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AuditLog } from "./audit-log.js";

describe("AuditLog merge actions", () => {
  it("accepts merge_resolved with merge metadata", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-merge-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_resolved",
      engramId: "01HXXXXXXXXXXXXXXXXXXXXXX",
      metadata: {
        path: "engrams/AIOS/decision.md",
        strategy: "frontmatter-updatedAt-arbitration",
        winner: "theirs",
        backupPath:
          ".co-engram/merge-backup/20260626/engrams/AIOS/decision.md.ours",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_resolved");
    expect(entry.metadata.winner).toBe("theirs");
    expect(entry.metadata.strategy).toBe("frontmatter-updatedAt-arbitration");
  });

  it("accepts merge_backup_failed with reason metadata", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-backup-fail-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_backup_failed",
      metadata: {
        path: "engrams/AIOS/decision.md",
        reason: "EACCES permission denied",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_backup_failed");
    expect(entry.metadata.reason).toBe("EACCES permission denied");
  });

  it("accepts merge_conflict_escalated when driver leaves markers", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-escalate-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_conflict_escalated",
      metadata: {
        path: "engrams/AIOS/decision.md",
        reason:
          "updatedAt collision + tiebreaker平局; Phase 1 has no LLM arbiter",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_conflict_escalated");
  });
});
