// packages/core/test/storage/repository-write-through.test.ts
//
// Task 1.5:EngramRepository write-through to IndexDb
//
// 验证 EngramRepository 的 4 个写入路径(createEngram / updateEngram /
// deleteEngram / mutateFrontmatter)在 indexDb 注入时,文件落盘成功后
// 透明同步到 SQLite 索引层;未注入时完全等同当前行为(向后兼容)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";

let tmpDir: string;
let dbPath: string;
let repo: EngramRepository;
let indexDb: IndexDb;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-write-through-"));
  // IndexDb.open() 要求父目录存在
  mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
  dbPath = join(tmpDir, ".co-engram", "index.db");
  indexDb = new IndexDb({ dbPath });
  indexDb.open();
  repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
});

afterEach(() => {
  indexDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 从 SQLite 主表读一条 engram 的全部列(列名 snake_case) */
function readRow(id: string): Record<string, unknown> | undefined {
  return indexDb
    .prepare("SELECT * FROM engrams WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

describe("EngramRepository write-through to IndexDb", () => {
  it("createEngram:文件落盘后同步 UPSERT 到 SQLite", () => {
    const engram = repo.createEngram({
      title: "测试写穿透",
      content: "这是一段用于 FTS 召回的内容",
      kind: "fact",
      domainTags: ["demo", "测试"],
      summary: "测试摘要",
      importance: 0.7,
      confidence: 0.85,
      visibility: "public",
      createdBy: "tester",
    });

    const row = readRow(engram.id);
    expect(row).toBeDefined();
    expect(row!.title).toBe("测试写穿透");
    expect(row!.kind).toBe("fact");
    expect(row!.importance).toBeCloseTo(0.7, 6);
    expect(row!.confidence).toBeCloseTo(0.85, 6);
    expect(row!.visibility).toBe("public");
    expect(row!.status).toBe("active");
    expect(row!.content_size).toBe(engram.contentSize);
    // updatedAt 是 epoch ms;engram 对象的 updatedAt 是 ISO
    expect(row!.updated_at).toBe(Date.parse(engram.updatedAt));

    // domainTags 全量落到 engram_domains 表
    const domains = indexDb
      .prepare(
        "SELECT domain FROM engram_domains WHERE engram_id = ? ORDER BY domain",
      )
      .all(engram.id) as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain)).toEqual(["demo", "测试"]);

    // FTS5 表也同步写入(含 content_tokens = content 全文)
    const fts = indexDb
      .prepare(
        "SELECT title, summary, content_tokens FROM engram_fts WHERE id = ?",
      )
      .get(engram.id) as {
        title: string;
        summary: string;
        content_tokens: string;
      };
    expect(fts.title).toBe("测试写穿透");
    expect(fts.summary).toBe("测试摘要");
    expect(fts.content_tokens).toContain("FTS 召回");
  });

  it("updateEngram:更新文件后同步更新 SQLite(含字段覆盖 + domains 替换)", () => {
    const engram = repo.createEngram({
      title: "原标题",
      content: "原内容",
      kind: "observation",
      domainTags: ["旧tag"],
      importance: 0.4,
      confidence: 0.5,
      createdBy: "tester",
    });

    repo.updateEngram(engram.id, {
      title: "新标题",
      content: "新内容",
      importance: 0.9,
      confidence: 0.95,
      domainTags: ["新tag1", "新tag2"],
      summary: "新摘要",
      updatedBy: "tester2",
    });

    const row = readRow(engram.id);
    expect(row).toBeDefined();
    expect(row!.title).toBe("新标题");
    expect(row!.importance).toBeCloseTo(0.9, 6);
    expect(row!.confidence).toBeCloseTo(0.95, 6);

    // domains 被全量替换为新的集合,旧 tag 不残留
    const domains = indexDb
      .prepare(
        "SELECT domain FROM engram_domains WHERE engram_id = ? ORDER BY domain",
      )
      .all(engram.id) as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain)).toEqual(["新tag1", "新tag2"]);

    // FTS 也反映新内容
    const fts = indexDb
      .prepare("SELECT title, content_tokens FROM engram_fts WHERE id = ?")
      .get(engram.id) as { title: string; content_tokens: string };
    expect(fts.title).toBe("新标题");
    expect(fts.content_tokens).toContain("新内容");
  });

  it("deleteEngram:文件删除后同步从 SQLite 删除(主表 + domains + FTS)", () => {
    const engram = repo.createEngram({
      title: "待删除",
      content: "x",
      kind: "fact",
      domainTags: ["d"],
      createdBy: "tester",
    });
    expect(readRow(engram.id)).toBeDefined();

    repo.deleteEngram(engram.id);

    expect(readRow(engram.id)).toBeUndefined();
    const domainCount = indexDb
      .prepare("SELECT count(*) as n FROM engram_domains WHERE engram_id = ?")
      .get(engram.id) as { n: number };
    expect(domainCount.n).toBe(0);
    const ftsCount = indexDb
      .prepare("SELECT count(*) as n FROM engram_fts WHERE id = ?")
      .get(engram.id) as { n: number };
    expect(ftsCount.n).toBe(0);
  });

  it("向后兼容:indexDb 未传时,createEngram / updateEngram / deleteEngram 行为不变", () => {
    // 不注入 indexDb —— 必须不抛错、不改变磁盘行为
    const plainRepo = new EngramRepository({ rootPath: tmpDir });
    const engram = plainRepo.createEngram({
      title: "无 SQLite",
      content: "y",
      kind: "fact",
      domainTags: ["plain"],
      createdBy: "tester",
    });
    expect(engram.id).toBeTruthy();
    // 文件确实落盘
    expect(plainRepo.exists(engram.id)).toBe(true);

    const updated = plainRepo.updateEngram(engram.id, {
      title: "改后",
      content: "z",
      updatedBy: "tester",
    });
    expect(updated.title).toBe("改后");

    plainRepo.deleteEngram(engram.id);
    expect(plainRepo.exists(engram.id)).toBe(false);

    // 不影响已注入 indexDb 的另一 repo 实例(隔离验证)
    expect(readRow(engram.id)).toBeUndefined();
  });
});
