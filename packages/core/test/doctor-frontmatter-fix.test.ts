import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { parseEngramFile } from "../src/storage/engram-store.js";

const VALID_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function makeRepo(): { repo: EngramRepository; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-fm-test-"));
  const repo = new EngramRepository({ rootPath: tmpDir });
  return { repo, tmpDir };
}

function writeEngram(
  tmpDir: string,
  name: string,
  yaml: string,
  content = "body",
): void {
  writeFileSync(
    join(tmpDir, name),
    `---\n${yaml}\n---\n${content}`,
  );
}

function readFrontmatter(
  tmpDir: string,
  name: string,
): Record<string, unknown> {
  const raw = readFileSync(join(tmpDir, name), "utf8");
  return parseEngramFile(raw).frontmatter as unknown as Record<string, unknown>;
}

describe("runDoctor frontmatter 自愈", () => {
  let repo: EngramRepository;
  let tmpDir: string;

  beforeEach(() => {
    ({ repo, tmpDir } = makeRepo());
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("out_of_range: importance=1.5 → 自动 clamp 到 1.0", () => {
    writeEngram(
      tmpDir,
      "a.md",
      `id: ${VALID_ID}\ntitle: t\nkind: observation\nimportance: 1.5\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    expect(report.fixes).toContainEqual(
      expect.objectContaining({
        kind: "invalid_field_value",
        autoFixed: true,
      }),
    );
    expect(readFrontmatter(tmpDir, "a.md").importance).toBe(1);
  });

  it("unknown_field: priority=high → 自动删除字段", () => {
    writeEngram(
      tmpDir,
      "b.md",
      `id: ${VALID_ID}\ntitle: t\nkind: observation\npriority: high\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    repo.runDoctor();
    const fm = readFrontmatter(tmpDir, "b.md");
    expect(fm.priority).toBeUndefined();
  });

  it("derived_mismatch: contentHash 不符 → 自动重算", () => {
    writeEngram(
      tmpDir,
      "c.md",
      `id: ${VALID_ID}\ntitle: t\nkind: observation\ncontentHash: sha256:0000000000000000000000000000000000000000000000000000000000000000\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
      "actual content",
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    expect(report.fixes).toContainEqual(
      expect.objectContaining({
        kind: "derived_field_stale",
        autoFixed: true,
      }),
    );
  });

  it("invalid_enum: kind=\"wrong\" → pendingManualReview + nextAction.tool=engram_update", () => {
    writeEngram(
      tmpDir,
      "d.md",
      `id: ${VALID_ID}\ntitle: t\nkind: wrong\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    const issue = report.pendingManualReview.find(
      (i) => i.kind === "invalid_field_value",
    );
    expect(issue).toBeDefined();
    expect(issue?.nextAction?.tool).toBe("engram_update");
    expect(issue?.nextAction?.argsHint).toMatch(/kind|kinds/);
  });

  it("invalid_enum: visibility=\"world\" → 报告 visibility 错(critical → onInvalidFrontmatter 路径)", () => {
    writeEngram(
      tmpDir,
      "e.md",
      `id: ${VALID_ID}\ntitle: t\nkind: observation\nvisibility: world\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    // visibility=world 是 critical → isEngramFile false → 路由到 onInvalidFrontmatter。
    // 该回调 re-parse 文件并提取具体 issue,所以 message 含 "visibility"。
    const allIssues = [...report.pendingManualReview, ...report.issues];
    const visIssue = allIssues.find((i) => i.message.includes("visibility"));
    expect(visIssue).toBeDefined();
  });

  it("invalid_format: createdAt=\"yesterday\" → pendingManualReview + autoFixed=false", () => {
    writeEngram(
      tmpDir,
      "f.md",
      `id: ${VALID_ID}\ntitle: t\nkind: observation\ncreatedBy: tester\ncreatedAt: yesterday\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    const issue = report.pendingManualReview.find((i) =>
      i.message.includes("createdAt"),
    );
    expect(issue).toBeDefined();
    expect(issue?.autoFixed).toBe(false);
  });

  it("missing_required: title=\"\" → pendingManualReview + nextAction.tool=engram_update", () => {
    writeEngram(
      tmpDir,
      "g.md",
      `id: ${VALID_ID}\ntitle: ""\nkind: observation\ncreatedBy: tester\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    const issue = report.pendingManualReview.find(
      (i) => i.message.includes("title") && i.kind === "invalid_field_value",
    );
    expect(issue).toBeDefined();
    expect(issue?.nextAction?.tool).toBe("engram_update");
  });

  it("invalid_frontmatter: YAML 语法错 → 报告为 invalid_frontmatter(非 orphan_markdown)", () => {
    writeFileSync(
      join(tmpDir, "h.md"),
      `---\nid: ${VALID_ID}\n\ttitle: bad-indent\nkind: observation\n---\nbody`,
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    const kinds = [...report.pendingManualReview, ...report.issues].map(
      (i) => i.kind,
    );
    expect(kinds).toContain("invalid_frontmatter");
    expect(kinds).not.toContain("orphan_markdown");
  });

  it("批量篡改: 3 个文件含混合异常 → doctor 单次扫描报告全部", () => {
    writeEngram(
      tmpDir,
      "p1.md",
      `id: 01ARZ3NDEKTSV4RRFFQ69G5FA1\ntitle: p1\nkind: wrong\ncreatedBy: t\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    writeEngram(
      tmpDir,
      "p2.md",
      `id: 01ARZ3NDEKTSV4RRFFQ69G5FA2\ntitle: p2\nkind: observation\nimportance: 1.5\ncreatedBy: t\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
    );
    writeEngram(
      tmpDir,
      "p3.md",
      `id: 01ARZ3NDEKTSV4RRFFQ69G5FA3\ntitle: p3\nkind: observation\npriority: high\ncreatedBy: t\ncreatedAt: 2026-07-08T00:00:00.000Z\nupdatedAt: 2026-07-08T00:00:00.000Z`,
      "x",
    );
    repo.rebuildIndex();
    const report = repo.runDoctor();
    // p3=unknown_field auto-delete, p2=importance auto-clamp, p1=invalid_enum pending
    const totalChanges = report.fixes.length + report.pendingManualReview.length;
    expect(totalChanges).toBeGreaterThanOrEqual(3);
  });
});
