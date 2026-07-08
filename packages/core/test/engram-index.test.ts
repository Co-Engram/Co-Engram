import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  rebuildEngramIndex,
  readEngramIndex,
  writeEngramIndex,
  engramIndexPath,
  createEmptyEngramIndex,
  buildIndexEntryFromFrontmatter,
  upsertEngramIndexEntry,
  removeEngramIndexEntry,
  findEngramIdByPath,
  CO_ENGRAM_CACHE_DIR,
  ENGRAM_INDEX_FILENAME,
} from "../src/storage/engram-index.js";
import { serializeEngramFile } from "../src/storage/engram-store.js";
import type { EngramFrontmatter } from "../src/storage/engram-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-index-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFrontmatter(
  overrides: Partial<EngramFrontmatter> = {},
): EngramFrontmatter {
  return {
    id: "01KVNJ9RN190DVHBKFB7NHDF9Q",
    title: "测试 engram",
    kind: "observation",
    createdBy: "alice",
    createdAt: "2026-06-22T10:00:00Z",
    updatedBy: "alice",
    updatedAt: "2026-06-22T10:00:00Z",
    version: 1,
    ...overrides,
  };
}

function writeEngram(
  relativePath: string,
  frontmatter: EngramFrontmatter,
  content = "body",
): void {
  const absolute = join(tmpDir, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, serializeEngramFile({ frontmatter, content }));
}

describe("engram-index — rebuildEngramIndex", () => {
  it("空目录返回空 index", () => {
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(0);
  });

  it("扫描单层目录的 engram", () => {
    writeEngram("test.md", makeFrontmatter());
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(1);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.title).toBe("测试 engram");
    expect(entry.path).toBe("test.md");
  });

  it("扫描多层目录的 engram", () => {
    writeEngram("项目管理/需求管理/操作系统内存优化.md", makeFrontmatter());
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(1);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.path).toBe("项目管理/需求管理/操作系统内存优化.md");
  });

  it("slug 默认从 title slugify", () => {
    writeEngram("test.md", makeFrontmatter({ title: "Hello World" }));
    const idx = rebuildEngramIndex(tmpDir);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.slug).toBe("hello-world");
    expect(entry.slugLocked).toBe(false);
  });

  it("slug 显式锁定", () => {
    writeEngram("test.md", makeFrontmatter({ slug: "custom-slug" }));
    const idx = rebuildEngramIndex(tmpDir);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.slug).toBe("custom-slug");
    expect(entry.slugLocked).toBe(true);
  });

  it("domainTags 默认从路径推断", () => {
    writeEngram("项目管理/需求管理/x.md", makeFrontmatter());
    const idx = rebuildEngramIndex(tmpDir);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.domainTags).toEqual(["项目管理", "需求管理"]);
    expect(entry.domainTagsLocked).toBe(false);
  });

  it("domainTags 显式锁定", () => {
    writeEngram(
      "a/b/x.md",
      makeFrontmatter({ domainTags: ["自定义", "标签"] }),
    );
    const idx = rebuildEngramIndex(tmpDir);
    const entry = idx.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.domainTags).toEqual(["自定义", "标签"]);
    expect(entry.domainTagsLocked).toBe(true);
  });

  it("跳过 .co-engram 缓存目录", () => {
    writeEngram("test.md", makeFrontmatter());
    mkdirSync(join(tmpDir, CO_ENGRAM_CACHE_DIR), { recursive: true });
    writeFileSync(
      join(tmpDir, CO_ENGRAM_CACHE_DIR, "cache.md"),
      serializeEngramFile({
        frontmatter: makeFrontmatter({ id: "01JXBBBBBBBBBBBBBBBBBBBBB" }),
        content: "x",
      }),
    );
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(1);
  });

  it("跳过 synapses 目录", () => {
    writeEngram("test.md", makeFrontmatter());
    mkdirSync(join(tmpDir, "synapses", "extends"), { recursive: true });
    writeFileSync(
      join(tmpDir, "synapses", "extends", "syn-a1b2c3d4e5f67890.yaml"),
      "kind: extends",
    );
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(1);
  });

  it("无 frontmatter 的 .md 触发 onOrphan 回调", () => {
    const orphanPath = join(tmpDir, "note.md");
    writeFileSync(orphanPath, "# 普通笔记\n\nbody\n");
    const orphans: string[] = [];
    const idx = rebuildEngramIndex(tmpDir, (p) => orphans.push(p));
    expect(idx.entries.size).toBe(0);
    expect(orphans).toEqual(["note.md"]);
  });

  it("多 engram 全部索引", () => {
    writeEngram("a.md", makeFrontmatter({ id: "01KVNJ9RN190DVHBKFB7NHDF9Q" }));
    writeEngram("b.md", makeFrontmatter({ id: "01KVNJ9RN3GW1KWXKVJ56RGJ0W" }));
    writeEngram("c.md", makeFrontmatter({ id: "01KVNJ9RN3SHB480QSCT7DZ63Q" }));
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(3);
  });

  it("lastRebuiltAt 是 ISO 时间戳", () => {
    const idx = rebuildEngramIndex(tmpDir);
    expect(idx.lastRebuiltAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("engram-index — 持久化", () => {
  it("writeEngramIndex 写入 .co-engram/engram-index.json", () => {
    const idx = createEmptyEngramIndex();
    writeEngramIndex(tmpDir, idx);
    expect(engramIndexPath(tmpDir)).toBe(
      join(tmpDir, CO_ENGRAM_CACHE_DIR, ENGRAM_INDEX_FILENAME),
    );
  });

  it("readEngramIndex 不存在时返回空 index", () => {
    const idx = readEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(0);
  });

  it("write + read round-trip", () => {
    writeEngram("test.md", makeFrontmatter());
    const original = rebuildEngramIndex(tmpDir);
    writeEngramIndex(tmpDir, original);

    const loaded = readEngramIndex(tmpDir);
    expect(loaded.entries.size).toBe(1);
    const entry = loaded.entries.get("01KVNJ9RN190DVHBKFB7NHDF9Q")!;
    expect(entry.title).toBe("测试 engram");
  });

  it("损坏的 JSON 文件返回空 index", () => {
    mkdirSync(join(tmpDir, CO_ENGRAM_CACHE_DIR), { recursive: true });
    writeFileSync(engramIndexPath(tmpDir), "not valid json{{{");
    const idx = readEngramIndex(tmpDir);
    expect(idx.entries.size).toBe(0);
  });
});

describe("engram-index — 增量维护", () => {
  it("upsertEngramIndexEntry 新增 entry", () => {
    const idx = createEmptyEngramIndex();
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "x.md",
      frontmatter: makeFrontmatter(),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    upsertEngramIndexEntry(idx, entry);
    expect(idx.entries.size).toBe(1);
  });

  it("removeEngramIndexEntry 删除存在的 entry", () => {
    const idx = createEmptyEngramIndex();
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "x.md",
      frontmatter: makeFrontmatter(),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    upsertEngramIndexEntry(idx, entry);
    const removed = removeEngramIndexEntry(idx, "01KVNJ9RN190DVHBKFB7NHDF9Q");
    expect(removed).toBe(true);
    expect(idx.entries.size).toBe(0);
  });

  it("removeEngramIndexEntry 删除不存在的 entry 返回 false", () => {
    const idx = createEmptyEngramIndex();
    const removed = removeEngramIndexEntry(idx, "01KVNJ9RN190DVHBKFB7NHDF9Q");
    expect(removed).toBe(false);
  });

  it("findEngramIdByPath 按 path 查 id", () => {
    const idx = createEmptyEngramIndex();
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "foo/bar.md",
      frontmatter: makeFrontmatter(),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    upsertEngramIndexEntry(idx, entry);
    expect(findEngramIdByPath(idx, "foo/bar.md")).toBe(
      "01KVNJ9RN190DVHBKFB7NHDF9Q",
    );
  });

  it("findEngramIdByPath 未找到返回 undefined", () => {
    const idx = createEmptyEngramIndex();
    expect(findEngramIdByPath(idx, "missing.md")).toBeUndefined();
  });
});

describe("engram-index — buildIndexEntryFromFrontmatter", () => {
  it("使用显式 slug", () => {
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "foo/test.md",
      frontmatter: makeFrontmatter({ title: "Some Title", slug: "fixed-slug" }),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    expect(entry.slug).toBe("fixed-slug");
    expect(entry.slugLocked).toBe(true);
  });

  it("无显式 slug 时从 title 派生", () => {
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "foo/test.md",
      frontmatter: makeFrontmatter({ title: "Hello World" }),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    expect(entry.slug).toBe("hello-world");
    expect(entry.slugLocked).toBe(false);
  });

  it("使用显式 domainTags", () => {
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "foo/test.md",
      frontmatter: makeFrontmatter({ domainTags: ["语义域"] }),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    expect(entry.domainTags).toEqual(["语义域"]);
    expect(entry.domainTagsLocked).toBe(true);
  });

  it("无显式 domainTags 时从路径推断", () => {
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "操作系统/内存管理/test.md",
      frontmatter: makeFrontmatter(),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    expect(entry.domainTags).toEqual(["操作系统", "内存管理"]);
    expect(entry.domainTagsLocked).toBe(false);
  });

  it("保留 tags", () => {
    const entry = buildIndexEntryFromFrontmatter({
      relativePath: "x.md",
      frontmatter: makeFrontmatter({ tags: ["性能", "优化"] }),
      mtime: 1000,
      contentHash: "sha256:abc",
    });
    expect(entry.tags).toEqual(["性能", "优化"]);
  });
});

describe("rebuildEngramIndex invalid_frontmatter 分流", () => {
  it("有 frontmatter marker 但 YAML 语法错 → onInvalidFrontmatter(非 onOrphan)", () => {
    // tab 缩进触发 YAML parser 抛错(YAML 规范禁止 tab 作缩进)
    const raw =
      "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n\ttitle: bad-indent\n---\nbody";
    writeFileSync(join(tmpDir, "bad.md"), raw);

    const orphanPaths: string[] = [];
    const invalidPaths: string[] = [];
    rebuildEngramIndex(
      tmpDir,
      (rel) => orphanPaths.push(rel),
      (rel, _msg) => invalidPaths.push(rel),
    );

    expect(orphanPaths).toEqual([]);
    expect(invalidPaths).toEqual(["bad.md"]);
  });

  it("有 marker 但 critical 校验问题 → onInvalidFrontmatter", () => {
    // visibility 非法触发 critical(fail-open 安全风险),isEngramFile 返回 false
    const raw = [
      "---",
      "id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "title: x",
      "kind: observation",
      "visibility: leaked",
      "createdBy: a",
      "createdAt: 2026-06-22T10:00:00Z",
      "updatedBy: a",
      "updatedAt: 2026-06-22T10:00:00Z",
      "version: 1",
      "---",
      "body",
      "",
    ].join("\n");
    writeFileSync(join(tmpDir, "crit.md"), raw);

    const orphanPaths: string[] = [];
    const invalidPaths: string[] = [];
    rebuildEngramIndex(
      tmpDir,
      (rel) => orphanPaths.push(rel),
      (rel, _msg) => invalidPaths.push(rel),
    );

    expect(orphanPaths).toEqual([]);
    expect(invalidPaths).toEqual(["crit.md"]);
  });

  it("无 frontmatter marker 的裸 .md → onOrphan(行为不变)", () => {
    writeFileSync(join(tmpDir, "bare.md"), "# just markdown\nno frontmatter");
    const orphanPaths: string[] = [];
    const invalidPaths: string[] = [];
    rebuildEngramIndex(
      tmpDir,
      (rel) => orphanPaths.push(rel),
      (rel, _msg) => invalidPaths.push(rel),
    );
    expect(orphanPaths).toEqual(["bare.md"]);
    expect(invalidPaths).toEqual([]);
  });

  it("onInvalidFrontmatter 可选(向后兼容)", () => {
    writeFileSync(join(tmpDir, "bare.md"), "# just markdown");
    expect(() => rebuildEngramIndex(tmpDir, () => {})).not.toThrow();
  });

  it("onInvalidFrontmatter 回调收到错误信息", () => {
    const raw =
      "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n\ttitle: bad-indent\n---\nbody";
    writeFileSync(join(tmpDir, "bad.md"), raw);

    const errors: Array<{ path: string; msg: string }> = [];
    rebuildEngramIndex(
      tmpDir,
      () => {},
      (rel, msg) => errors.push({ path: rel, msg }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("bad.md");
    expect(errors[0]?.msg.length).toBeGreaterThan(0);
  });
});
