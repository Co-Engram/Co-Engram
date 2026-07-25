import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

import { EngramRepository } from "../src/storage/repository.js";
import { IndexDb } from "../src/storage/index-db.js";

/**
 * 验证修复:双 frontmatter(外部编辑/git 合并误留)→ parseEngramFile 检测
 * (ValidationIssue category=multiple_frontmatter)→ doctor 自动自愈
 * (保留第一个 frontmatter,删多余 block)。
 *
 * 根因:parseEngramFile 只取第一个 marker,多余 block 静默丢弃 → doctor 盲区。
 * 修复后:显式收集 issue + processValidationIssues 走 mutateFrontmatter 重写单 frontmatter。
 */
describe("doctor 自愈双 frontmatter (multiple_frontmatter)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-multi-fm-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir, language: "zh" }, indexDb);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("双 frontmatter 文件 → doctor 保留第一个 frontmatter,删多余 block", () => {
    // 1. 建合法 engram(单 frontmatter,zh 格式)
    const eng = repo.createEngram({
      title: "dual frontmatter test",
      content: "body content for the test engram",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    const entry = repo.listEngramIndex().find((e) => e.id === eng.id)!;
    const filePath = join(tmpDir, entry.path);
    const raw = readFileSync(filePath, "utf8");

    // 2. 追加第二个 frontmatter block(复制第一个,改 id)模拟外部/git 误留
    const markerIdx = raw.indexOf("<!-- co-engram-meta:zh -->");
    expect(markerIdx).toBeGreaterThan(-1); // 确认 zh 格式(底部 marker)
    const firstBlock = raw.slice(markerIdx);
    const secondId = ulid();
    const secondBlock = firstBlock.replace(eng.id, secondId);
    writeFileSync(filePath, raw + "\n" + secondBlock, "utf8");

    // fixture 自检:确实是双 frontmatter
    const beforeRaw = readFileSync(filePath, "utf8");
    expect(
      (beforeRaw.match(/<!-- co-engram-meta:zh -->/g) ?? []).length,
    ).toBe(2);

    // 3. doctor 自愈
    const report = repo.runDoctor();
    const multiFmFix = report.fixes.find(
      (f) => f.kind === "multiple_frontmatter",
    );
    expect(multiFmFix).toBeDefined();

    // 4. 文件变单 frontmatter;保留第一个 id,删第二个 id
    const afterRaw = readFileSync(filePath, "utf8");
    expect(
      (afterRaw.match(/<!-- co-engram-meta:zh -->/g) ?? []).length,
    ).toBe(1);
    expect(afterRaw).toContain(eng.id);
    expect(afterRaw).not.toContain(secondId);
  });
});
