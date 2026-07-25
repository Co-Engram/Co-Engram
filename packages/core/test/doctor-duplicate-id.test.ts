import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { IndexDb } from "../src/storage/index-db.js";

/**
 * 验证 doctor 检测 duplicate_id(多文件同 id)。
 *
 * 根因:rebuildEngramIndex 用 Map.set(id, entry),同 id 静默覆盖 → 被覆盖副本不在
 * index → orphan → 重复 import proposal(内容其实已是 engram)。修复:set 前 check
 * id 是否已存在,存在 → onDuplicate callback → runDoctor 报 duplicate_id (manual review)。
 */
describe("doctor 检测 duplicate_id (多文件同 id)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-dup-id-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir, language: "zh" }, indexDb);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("同 id 多文件 → doctor 报 duplicate_id (manual review + nextAction)", () => {
    // 1. 建 engram
    const eng = repo.createEngram({
      title: "duplicate id test",
      content: "body for duplicate id detection",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    const entry = repo.listEngramIndex().find((e) => e.id === eng.id)!;
    // 2. 复制到另一目录(同 id)模拟用户手动 cp 记忆到多目录
    const dupPath = join(tmpDir, "another-dir", "dup.md");
    mkdirSync(dirname(dupPath), { recursive: true });
    writeFileSync(dupPath, readFileSync(join(tmpDir, entry.path), "utf8"), "utf8");

    // 3. doctor
    const report = repo.runDoctor();
    const dupIssue = report.pendingManualReview.find(
      (i) => i.kind === "duplicate_id",
    );
    expect(dupIssue).toBeDefined();
    expect(dupIssue?.stableId).toBe(eng.id);
    expect(dupIssue?.nextAction?.tool).toBe("engram_delete");
  });
});
