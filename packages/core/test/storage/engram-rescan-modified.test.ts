// packages/core/test/storage/engram-rescan-modified.test.ts
//
// engram 派生层按需同步测试(2026-08):补救 fs.watch(inotify)对编辑器原子写
// 漏事件,导致「用户改 engram .md 标题后 viewer 内容不更新」。
//
// 覆盖三个新增点:
//   A. startWatching 启动即扫 scanForModifiedEngrams(重启即同步,不再"重启都不补救")
//   B. rescanModifiedEngrams public 入口(viewer /api/stats 按需触发)
//   C. scanForModifiedEngrams 回写 index.json entry.mtime(避免重复同步)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { readEngramIndex } from "../../src/storage/engram-index.js";
import type { StableEngramId } from "../../src/types/repository-types.js";

let tmpDir: string;
let dbPath: string;
let repo: EngramRepository;
let indexDb: IndexDb;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rescan-mod-"));
  mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
  dbPath = join(tmpDir, ".co-engram", "index.db");
  indexDb = new IndexDb({ dbPath });
  indexDb.open();
  repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
});

afterEach(() => {
  repo.stopWatching();
  indexDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function readTitle(id: string): string | undefined {
  const row = indexDb
    .prepare("SELECT title FROM engrams WHERE id = ?")
    .get(id) as { title?: string } | undefined;
  return row?.title;
}

function entryMtime(id: string): number | undefined {
  const idx = readEngramIndex(tmpDir);
  return idx.entries.get(id as StableEngramId)?.mtime;
}

function absPathFor(id: string): string {
  const rel = repo.resolvePath(id);
  if (!rel) throw new Error(`resolvePath failed for ${id}`);
  return join(tmpDir, rel);
}

/** 改 .md 的 frontmatter title 并把 mtime 推后,确保被 scanForModifiedEngrams 检测到。 */
function rewriteTitle(id: string, newTitle: string): void {
  const abs = absPathFor(id);
  const raw = readFileSync(abs, "utf8");
  // frontmatter 字段名随仓库语言本地化(zh=标题 / en=title),两种都匹配
  const newRaw = raw
    .replace(/title:.*$/m, `title: "${newTitle}"`)
    .replace(/标题:.*$/m, `标题: "${newTitle}"`);
  if (newRaw === raw)
    throw new Error("test setup: title replace did not match");
  const base = statSync(abs).mtimeMs;
  writeFileSync(abs, newRaw);
  const future = new Date(base + 5000);
  utimesSync(abs, future, future);
}

describe("B: rescanModifiedEngrams · 改 engram .md 后按需同步(不依赖 fs.watch)", () => {
  it("外部改 title → rescanModifiedEngrams → SQLite title 更新", () => {
    const e = repo.createEngram({
      title: "旧标题",
      content: "c",
      kind: "observation",
      domainTags: ["x"],
    });
    expect(readTitle(e.id)).toBe("旧标题");

    // 模拟 fs.watch 漏事件:不 startWatching,直接改文件后用 public 入口同步
    rewriteTitle(e.id, "新标题");
    repo.rescanModifiedEngrams();

    expect(readTitle(e.id)).toBe("新标题");
  });

  it("无 indexDb 时 rescanModifiedEngrams noop(不抛错)", () => {
    const repoNoDb = new EngramRepository({ rootPath: tmpDir });
    expect(() => repoNoDb.rescanModifiedEngrams()).not.toThrow();
  });
});

describe("C: scanForModifiedEngrams 回写 index.json entry.mtime", () => {
  it("rescan 后 entry.mtime == 文件 mtime(之前不回写,永远停在旧值)", () => {
    const e = repo.createEngram({
      title: "原标题",
      content: "c",
      kind: "observation",
      domainTags: ["x"],
    });
    const abs = absPathFor(e.id);
    // 内容不变,仅推进 mtime(触发 scanForModifiedEngrams 的检测分支)
    writeFileSync(abs, readFileSync(abs, "utf8"));
    const base = statSync(abs).mtimeMs;
    const future = new Date(base + 5000);
    utimesSync(abs, future, future);
    const fileMtime = statSync(abs).mtimeMs;

    expect(entryMtime(e.id)).not.toBe(fileMtime); // 回写前:entry.mtime 是旧值
    repo.rescanModifiedEngrams();
    expect(entryMtime(e.id)).toBe(fileMtime); // 回写后:对齐文件 mtime
  });
});

describe("A: startWatching 启动即扫 scanForModifiedEngrams", () => {
  it("co-engram 未运行时改 .md → startWatching → SQLite 同步(重启即补救)", () => {
    const e = repo.createEngram({
      title: "启动前标题",
      content: "c",
      kind: "observation",
      domainTags: ["x"],
    });
    // createEngram 经 persistIndex 会 lazy 触发 startWatching;先停掉 watcher,
    // 模拟「co-engram 关闭期间 engram .md 被外部编辑」。
    repo.stopWatching();
    rewriteTitle(e.id, "启动后标题");
    expect(readTitle(e.id)).toBe("启动前标题"); // 启动扫之前仍是旧值

    repo.startWatching(); // 重启 → 启动即扫 scanForModifiedEngrams(同步执行)
    try {
      expect(readTitle(e.id)).toBe("启动后标题");
    } finally {
      repo.stopWatching();
    }
  });
});
