import { describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../observability/audit-log.js";
import { mergeEngramFile } from "./merge-engram.js";

function engramRaw(overrides: Record<string, unknown>, body: string): string {
  const baseFm = {
    id: "01HXXX",
    title: "base title",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
  };
  const fm = { ...baseFm, ...overrides };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

describe("mergeEngramFile", () => {
  it("clean-merges non-overlapping frontmatter + content changes", async () => {
    const base = engramRaw({ retrievalCount: 5 }, "Body");
    const ours = engramRaw(
      { retrievalCount: 7, updatedAt: "2026-06-01T00:00:00Z" },
      "Body",
    );
    const theirs = engramRaw(
      { retrievalCount: 6, updatedAt: "2026-06-02T00:00:00Z" },
      "Body + addition",
    );

    const result = await mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
    });

    expect(result.escalated).toBe(false);
    expect(result.mergedContent).toContain("Body + addition");
    expect(result.mergedContent).toMatch(/retrievalCount:\s*8/);
  });

  it("snapshots loser when content falls back to theirs", async () => {
    const dataRoot = mkdirSync(
      join(tmpdir(), `engram-merge-backup-${Date.now()}`),
      { recursive: true },
    );
    const auditLog = new AuditLog(dataRoot);

    const base = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Same body");
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours-title" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-02T00:00:00Z", title: "theirs-title" },
      "Their body",
    );

    const result = await mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
      dataRoot,
      auditLog,
    });

    expect(result.winner).toBe("theirs");
    expect(result.backupPath).toBeDefined();
    expect(result.mergedContent).toContain("Their body");
  });

  it("escalates when updatedAt collides on both frontmatter and content", async () => {
    const base = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "base" },
      "Base body",
    );
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "theirs" },
      "Their body",
    );

    const result = await mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
    });

    expect(result.escalated).toBe(true);
    expect(result.mergedContent).toContain("<<<<<<< ours");
    expect(result.mergedContent).toContain(">>>>>>> theirs");
  });

  it("recomputes contentHash and contentSize after content merge", async () => {
    const base = engramRaw({}, "Body");
    const ours = engramRaw({ updatedAt: "2026-06-02T00:00:00Z" }, "Body ours");
    const theirs = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Body");

    const result = await mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "test.md",
    });

    expect(result.mergedContent).toMatch(/contentHash:/);
    expect(result.mergedContent).toMatch(/contentSize:/);
  });

  it("skips backup + audit when dataRoot absent", async () => {
    const base = engramRaw({}, "Body");
    const ours = engramRaw({ updatedAt: "2026-06-02T00:00:00Z" }, "Body ours");
    const theirs = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Body");

    const result = await mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "test.md",
      // no dataRoot, no auditLog
    });

    expect(result.backupPath).toBeUndefined();
    expect(result.escalated).toBe(false);
  });

  it("throws on unparseable base file", async () => {
    await expect(
      mergeEngramFile({
        baseRaw: "this is not a valid engram file",
        oursRaw: engramRaw({}, "Body"),
        theirsRaw: engramRaw({}, "Body"),
        relPath: "test.md",
      }),
    ).rejects.toThrow(/Invalid engram file/);
  });
});
