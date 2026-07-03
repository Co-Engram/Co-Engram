import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { serializeEngramFile } from "../src/storage/engram-store.js";
import { collectAllSynapses } from "../src/storage/synapse-store.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-repo-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("EngramRepository — Engram CRUD", () => {
  it("createEngram 生成 ULID + 默认路径", () => {
    const engram = repo.createEngram({
      title: "操作系统内存优化",
      content: "讨论操作系统内存优化策略",
      kind: "observation",
      domainTags: ["操作系统", "内存管理"],
      createdBy: "alice",
    });
    expect(engram.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(engram.title).toBe("操作系统内存优化");
    expect(
      existsSync(join(tmpDir, "操作系统", "内存管理", "操作系统内存优化.md")),
    ).toBe(true);
  });

  it("createEngram 用 pathHint 自定义路径", () => {
    const engram = repo.createEngram({
      title: "Custom Path",
      content: "content",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "custom/dir/my-note.md",
    });
    expect(existsSync(join(tmpDir, "custom", "dir", "my-note.md"))).toBe(true);
    expect(engram.title).toBe("Custom Path");
  });

  it("createEngram 重复路径报错", () => {
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "a.md",
    });
    expect(() =>
      repo.createEngram({
        title: "B",
        content: "y",
        kind: "observation",
        domainTags: [],
        createdBy: "alice",
        pathHint: "a.md",
      }),
    ).toThrow(/already exists/);
  });

  it("createEngram 自愈:同 path 的孤儿索引项在写入前被清理", () => {
    // 模拟真实 bug 场景:外部(用户 rm / git 操作 / 进程异常)删了磁盘文件,
    // 但 engram-index.json 仍保留旧 ULID 的 entry。下一次 createEngram 写入
    // 同 path 应当清掉孤儿,而不是留下永不消失的"重影"。
    const first = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "a.md",
    });
    expect(repo.listEngrams().length).toBe(1);

    // 外部删除磁盘文件,索引项残留(不走 repo.deleteEngram,所以索引不清)
    rmSync(join(tmpDir, "a.md"));
    expect(existsSync(join(tmpDir, "a.md"))).toBe(false);
    // 索引里 ULID A 还在(孤儿)
    expect(repo.listEngrams().length).toBe(1);

    // 新写入同 path:existsSync 通过(磁盘无文件),触发自愈清孤儿
    const second = repo.createEngram({
      title: "B",
      content: "y",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "a.md",
    });

    // 索引只剩新 ULID,listEngrams 不再显示重影
    expect(repo.listEngrams().length).toBe(1);
    expect(repo.listEngrams()[0]!.id).toBe(second.id);
    expect(() => repo.readEngram(first.id)).toThrow();
  });

  it("readEngram 读回创建的数据", () => {
    const created = repo.createEngram({
      title: "Test Engram",
      content: "hello world",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "bob",
    });
    const read = repo.readEngram(created.id);
    expect(read.title).toBe("Test Engram");
    expect(read.content).toBe("hello world");
    expect(read.kind).toBe("fact");
    expect(read.createdBy).toBe("bob");
  });

  it("createEngram 默认 summary 从 content 派生(不再重复 title)", () => {
    // 回归:之前 summary 默认 = title,导致 FTS 把同一个 title token 索引两次,
    // 完全无法命中 content 里的关键词。用户搜 'parser' 永远找不到含 'parser'
    // 的 engram,即使 content 里就有这个词。
    const engram = repo.createEngram({
      title: "Bug fix",
      content: "Fixed CLI parser to support --flag=VALUE syntax properly.",
      kind: "fact",
      domainTags: ["testing"],
      createdBy: "bob",
    });
    expect(engram.summary).not.toBe(engram.title); // 不能再是 title 的副本
    expect(engram.summary).toContain("parser"); // 应包含 content 关键词
    expect(engram.summary!.length).toBeLessThanOrEqual(200);
  });

  it("createEngram 无 content 时 summary 回退到 title", () => {
    // 兜底:如果用户连 content 都没给,用 title 至少不会是空字符串
    const engram = repo.createEngram({
      title: "Sticky note",
      content: "",
      kind: "fact",
      domainTags: [],
      createdBy: "bob",
    });
    expect(engram.summary).toBe("Sticky note");
  });

  it("createEngram 长 content 截断 + 省略号", () => {
    const long = "a".repeat(500);
    const engram = repo.createEngram({
      title: "Long",
      content: long,
      kind: "fact",
      domainTags: [],
      createdBy: "bob",
    });
    expect(engram.summary!.length).toBeLessThanOrEqual(200);
    expect(engram.summary!.endsWith("...")).toBe(true);
  });

  it("createEngram 用户显式给的 summary 优先(不被覆盖)", () => {
    const engram = repo.createEngram({
      title: "T",
      content: "some content here",
      kind: "fact",
      domainTags: [],
      createdBy: "bob",
      summary: "User-provided summary",
    });
    expect(engram.summary).toBe("User-provided summary");
  });

  it("readEngram 抛出未找到错误", () => {
    expect(() => repo.readEngram("01KVNJ9RN190DVHBKFB7NHDF9Q")).toThrow(
      /not found/,
    );
  });

  it("exists 返回正确状态", () => {
    expect(repo.exists("01KVNJ9RN190DVHBKFB7NHDF9Q")).toBe(false);
    const e = repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    expect(repo.exists(e.id)).toBe(true);
  });

  it("updateEngram 修改 content + version++", () => {
    const e = repo.createEngram({
      title: "Original",
      content: "original content",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    const updated = repo.updateEngram(e.id, {
      content: "updated content",
      updatedBy: "bob",
    });
    expect(updated.content).toBe("updated content");
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe("bob");
  });

  it("updateEngram 修改 title 触发文件 rename(slug 未锁定)", () => {
    const e = repo.createEngram({
      title: "Old Title",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    // 原 slug 是 "old-title"
    expect(existsSync(join(tmpDir, "old-title.md"))).toBe(true);
    repo.updateEngram(e.id, {
      title: "New Title",
      updatedBy: "alice",
    });
    // 新 slug 是 "new-title",旧文件应消失
    expect(existsSync(join(tmpDir, "new-title.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "old-title.md"))).toBe(false);
  });

  it("updateEngram title 变但 slug 锁定不 rename", () => {
    // 直接写文件,frontmatter 显式 slug
    const { writeFileSync } = require("node:fs");
    const { ulid } = require("ulid");
    const stableId = ulid();
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "locked-slug.md"),
      `---
id: ${stableId}
title: Original
slug: locked-slug
kind: observation
createdAt: 2026-06-22T10:00:00Z
updatedAt: 2026-06-22T10:00:00Z
createdBy: alice
updatedBy: alice
version: 1
---
body
`,
    );
    repo.rebuildIndex();
    repo.updateEngram(stableId, { title: "New Title", updatedBy: "alice" });
    expect(existsSync(join(tmpDir, "locked-slug.md"))).toBe(true);
  });

  it("deleteEngram 删除文件 + 索引", () => {
    const e = repo.createEngram({
      title: "To Delete",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    repo.deleteEngram(e.id);
    expect(repo.exists(e.id)).toBe(false);
    expect(repo.readCatalogEntry(e.id)).toBeNull();
  });

  it("deleteEngram 不存在的不报错", () => {
    expect(() => repo.deleteEngram("01KVNJ9RN190DVHBKFB7NHDF9Q")).not.toThrow();
  });
});

describe("EngramRepository — Catalog & Path", () => {
  it("listEngrams 返回所有 engram", () => {
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: ["t1"],
      createdBy: "a",
    });
    repo.createEngram({
      title: "B",
      content: "x",
      kind: "fact",
      domainTags: ["t2"],
      createdBy: "a",
    });
    const list = repo.listEngrams();
    expect(list.length).toBe(2);
  });

  it("readEngramByPath 按路径读", () => {
    repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "foo/bar/x.md",
    });
    const e = repo.readEngramByPath("foo/bar/x.md");
    expect(e).toBeDefined();
    expect(e!.title).toBe("X");
  });

  it("readEngramByPath 不存在返回 undefined", () => {
    expect(repo.readEngramByPath("missing.md")).toBeUndefined();
  });

  it("listPathTree 构建目录树 + 累积 engramCount", () => {
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "foo/a.md",
    });
    repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "foo/bar/b.md",
    });
    repo.createEngram({
      title: "C",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "baz/c.md",
    });
    const tree = repo.listPathTree();
    expect(tree.engramCount).toBe(3);
    expect(tree.children.length).toBe(2); // foo + baz

    const fooNode = tree.children.find((n) => n.path === "foo")!;
    expect(fooNode.engramCount).toBe(2); // 累积包含 bar 下的 B
    expect(fooNode.children.length).toBe(1); // bar
    expect(fooNode.children[0]!.path).toBe("foo/bar");
    expect(fooNode.children[0]!.engramCount).toBe(1);

    const bazNode = tree.children.find((n) => n.path === "baz")!;
    expect(bazNode.engramCount).toBe(1);
    expect(bazNode.children.length).toBe(0);
  });
});

describe("EngramRepository — Synapse 双向查询", () => {
  it("readSynapses 返回 outgoing + incoming", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "alice",
    });
    const aSyns = repo.readSynapses(a.id);
    expect(aSyns.outgoing.length).toBe(1);
    expect(aSyns.incoming.length).toBe(0);

    const bSyns = repo.readSynapses(b.id);
    expect(bSyns.outgoing.length).toBe(0);
    expect(bSyns.incoming.length).toBe(1);
  });

  it("collectAllSynapses 返回全部", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      direction: "bidirectional",
      createdBy: "a",
    });
    expect(repo.collectAllSynapses().length).toBe(2);
  });

  it("readSynapseByEndpoints 命中", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    const syn = repo.readSynapseByEndpoints(a.id, b.id, "extends");
    expect(syn).toBeDefined();
    expect(syn!.from).toBe(a.id);
  });

  it("createSynapse 幂等", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    expect(repo.collectAllSynapses().length).toBe(1);
  });
});

describe("EngramRepository — deleteEngram 级联", () => {
  it("删 engram 时触及的 synapse 全部消失", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const c = repo.createEngram({
      title: "C",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: c.id,
      kind: "similar_to",
      createdBy: "a",
    });
    repo.createSynapse({
      from: c.id,
      to: a.id,
      kind: "derives_from",
      createdBy: "a",
    });

    repo.deleteEngram(a.id);
    expect(repo.collectAllSynapses().length).toBe(0);
  });

  it("deleteSynapsesTouching 返回删除数", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "a",
    });
    repo.createSynapse({
      from: b.id,
      to: a.id,
      kind: "similar_to",
      createdBy: "a",
    });
    const count = repo.deleteSynapsesTouching(a.id);
    expect(count).toBe(2);
  });
});

// ============================================================
// F3: deleteEngram 顺序契约 —— 先删 index 再删文件
//
// 旧顺序「文件 → synapse → index」的最坏情况:文件已删 + index 未删 中间态。
// 若此时另一进程恢复文件,doctor 看不到问题(因为 missing_file 检测要求
// 文件确实不存在),但该 engram 仍在 listEngrams 中可见 → fail-silent。
//
// 新顺序「index → 文件 → synapse」保证:deleteEngram 返回时,index 已清。
// 即使后续步骤失败(文件未删 / synapse 残留),失败模式都落在 doctor 能
// 自愈的范畴(orphan_markdown / dangling_synapse)。
// ============================================================

describe("EngramRepository — F3: deleteEngram 顺序契约", () => {
  it("deleteEngram 返回后,index 立即不含该 id", () => {
    const a = repo.createEngram({
      title: "F3 顺序",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    expect(repo.listEngrams().some((e) => e.id === a.id)).toBe(true);

    repo.deleteEngram(a.id);

    // 关键不变量:index 立即清,不等文件 / synapse 步骤完成
    expect(repo.listEngrams().some((e) => e.id === a.id)).toBe(false);
    expect(repo.exists(a.id)).toBe(false);
  });

  it("F3: 文件已被外部删除时,deleteEngram 仍清 index(老顺序会留下 dangling index entry)", () => {
    // 模拟"另一进程已 rm 文件,index 还有 entry"的部分崩溃状态
    const a = repo.createEngram({
      title: "外部 rm 后",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });

    // 外部删除文件(绕过 deleteEngram)
    const entry = repo.listEngramIndex().find((e) => e.id === a.id);
    expect(entry).toBeDefined();
    unlinkSync(join(tmpDir, entry!.path));

    // 此时:index 有 entry,文件不存在
    expect(repo.listEngrams().some((e) => e.id === a.id)).toBe(true);
    expect(repo.exists(a.id)).toBe(false);

    // deleteEngram 应该幂等清掉 index entry,不抛错
    expect(() => repo.deleteEngram(a.id)).not.toThrow();

    // 关键:index 已清(若顺序是「先文件后 index」,文件已不存在 → deleteEngramFile
    // 静默 noop → 但 index 删除仍会执行,因为 F3 的新顺序是先删 index)
    expect(repo.listEngrams().some((e) => e.id === a.id)).toBe(false);
  });

  it("F3: 多次 deleteEngram 同一 id 幂等,不抛错", () => {
    const a = repo.createEngram({
      title: "幂等",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    repo.deleteEngram(a.id);
    // 第二次:entry 已不存在,resolvePath 返回 undefined → 早 return,不抛错
    expect(() => repo.deleteEngram(a.id)).not.toThrow();
    expect(repo.listEngrams().some((e) => e.id === a.id)).toBe(false);
  });
});

describe("EngramRepository — Doctor 自愈", () => {
  it("空仓库返回空 report", () => {
    const report = repo.runDoctor();
    expect(report.totalEngrams).toBe(0);
    expect(report.totalSynapses).toBe(0);
  });

  it("检测 orphan_markdown(无 frontmatter)", () => {
    writeFileSync(join(tmpDir, "note.md"), "# 普通笔记\n\n无 frontmatter\n");
    const report = repo.runDoctor();
    const orphanIssues = report.pendingManualReview.filter(
      (i) => i.kind === "orphan_markdown",
    );
    expect(orphanIssues.length).toBe(1);
    expect(orphanIssues[0]!.path).toBe("note.md");
  });

  it("README/LICENSE 等仓库级文档不报为 orphan_markdown", () => {
    writeFileSync(join(tmpDir, "README.md"), "# Team Memory\n\n说明文档\n");
    writeFileSync(
      join(tmpDir, "readme.md"),
      "# lowercase readme also skipped\n",
    );
    writeFileSync(join(tmpDir, "LICENSE.md"), "MIT License\n");
    writeFileSync(join(tmpDir, "CONTRIBUTING.md"), "# Contributing\n");
    const report = repo.runDoctor();
    const orphanIssues = report.pendingManualReview.filter(
      (i) => i.kind === "orphan_markdown",
    );
    expect(orphanIssues).toEqual([]);
  });

  it("检测 missing_file(旧 index 有但磁盘无)", () => {
    // 先创建一个 engram 让 index 记录
    const e = repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    // 删除文件但不更新 index
    rmSync(join(tmpDir, "x.md"));
    // 强制让缓存指向旧 index(直接读盘但缓存未更新)
    const report = repo.runDoctor();
    // 重建后 index 不应该有这个 engram
    expect(report.totalEngrams).toBe(0);
  });

  it("检测 moved_file(id 保留但 path 变)", () => {
    // 创建 engram
    const e = repo.createEngram({
      title: "Test",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "old/test.md",
    });
    // 移动文件到新路径(保留 frontmatter id)
    mkdirSync(join(tmpDir, "new"), { recursive: true });
    renameSync(join(tmpDir, "old", "test.md"), join(tmpDir, "new", "test.md"));
    // doctor 应该能识别这是同一 engram
    const report = repo.runDoctor();
    expect(report.totalEngrams).toBe(1);
    const moved = report.fixes.find((f) => f.kind === "moved_file");
    expect(moved).toBeDefined();
    expect(moved!.path).toBe("new/test.md");
  });

  it("检测 dangling_synapse(from/to 不存在)", () => {
    // 手动写一个引用不存在 engram 的 synapse
    mkdirSync(join(tmpDir, "synapses", "extends"), { recursive: true });
    writeFileSync(
      join(tmpDir, "synapses", "extends", "syn-a1b2c3d4e5f67890.yaml"),
      `id: syn-a1b2c3d4e5f67890
from: 01FAKEFAKEFAKEFAKEFAKEFAKEF
to: 01FAKEFAKEFAKEFAKEFAKEFAKEFA
kind: extends
weight: 0.5
direction: directional
evidence: []
createdBy: test
createdAt: 2026-06-22T10:00:00Z
updatedAt: 2026-06-22T10:00:00Z
retrievalWeight: 0.5
`,
    );
    const report = repo.runDoctor();
    const dangling = report.pendingManualReview.filter(
      (i) => i.kind === "dangling_synapse",
    );
    expect(dangling.length).toBeGreaterThan(0);
  });

  it("增量 vs 全量都工作", () => {
    repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const full = repo.runDoctor({ incremental: false });
    expect(full.totalEngrams).toBe(1);
    const inc = repo.runDoctor({ incremental: true });
    expect(inc.totalEngrams).toBe(1);
  });
});

describe("EngramRepository — 文件移动后关系保持", () => {
  it("人类 mv 文件后,synapse 引用稳定", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "dir1/a.md",
    });
    const b = repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
      pathHint: "dir1/b.md",
    });
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "extends",
      createdBy: "alice",
    });

    // 人类 mv 文件(保留 frontmatter id)
    mkdirSync(join(tmpDir, "dir2"), { recursive: true });
    renameSync(join(tmpDir, "dir1", "a.md"), join(tmpDir, "dir2", "a.md"));

    // doctor 识别移动,更新 index
    repo.runDoctor();

    // synapse 关系仍存在(from/to 用 stableId,不受 path 影响)
    const allSyns = collectAllSynapses(tmpDir);
    expect(allSyns.length).toBe(1);
    expect(allSyns[0]!.from).toBe(a.id);
    expect(allSyns[0]!.to).toBe(b.id);
  });
});

describe("EngramRepository — 跨进程缓存一致性", () => {
  it("外部进程写入 engram-index.json 后,本进程 getIndex 重读(mtime 兜底)", () => {
    repo.createEngram({
      title: "原始记忆",
      content: "repo A 创建的内容",
      kind: "observation",
      domainTags: ["测试"],
      createdBy: "alice",
    });

    // 模拟另一个 host adapter:创建第二个 Repository 实例,共享同一 dataRoot
    const repoB = new EngramRepository({ rootPath: tmpDir });
    expect(repoB.listEngrams().length).toBe(1);

    // repoB 创建新 engram(写盘 → engram-index.json mtime 更新)
    repoB.createEngram({
      title: "另一进程写入",
      content: "repo B 创建",
      kind: "fact",
      domainTags: ["测试"],
      createdBy: "bob",
    });
    expect(repoB.listEngrams().length).toBe(2);

    // repo(原进程)的 cache 此时陈旧 — listEngrams 应感知到新条目
    // 这是 bug 的核心:修复前返回 1,修复后返回 2
    expect(repo.listEngrams().length).toBe(2);
  });

  it("startWatching 后,外部写入通过 fs.watch 实时失效缓存", async () => {
    repo.startWatching();
    try {
      repo.createEngram({
        title: "种子",
        content: "初始",
        kind: "observation",
        domainTags: ["测试"],
        createdBy: "alice",
      });

      const repoB = new EngramRepository({ rootPath: tmpDir });
      repoB.createEngram({
        title: "外部写入",
        content: "通过另一个进程",
        kind: "fact",
        domainTags: ["测试"],
        createdBy: "bob",
      });

      // 给 fs.watch 一点时间触发(inotify 异步)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // watcher 应已失效 cache;listEngrams 重读 → 看到 2 条
      expect(repo.listEngrams().length).toBe(2);
    } finally {
      repo.stopWatching();
    }
  });

  it("stopWatching 后,缓存依赖 mtime 兜底(仍能感知外部写入)", () => {
    repo.createEngram({
      title: "种子",
      content: "初始",
      kind: "observation",
      domainTags: ["测试"],
      createdBy: "alice",
    });

    const repoB = new EngramRepository({ rootPath: tmpDir });
    repoB.createEngram({
      title: "外部",
      content: "另一个进程",
      kind: "fact",
      domainTags: ["测试"],
      createdBy: "bob",
    });

    // 即使没启动 watcher,mtime 兜底也应让 repo 感知到外部写入
    expect(repo.listEngrams().length).toBe(2);
  });

  it("自进程 createEngram 后 listEngrams 立即看到新条目(无缓存阻塞)", () => {
    expect(repo.listEngrams().length).toBe(0);
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    expect(repo.listEngrams().length).toBe(1);
    repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    expect(repo.listEngrams().length).toBe(2);
  });

  it("外部进程 updateEngram 后,本进程 readEngram 看到新内容", () => {
    const created = repo.createEngram({
      title: "原标题",
      content: "原内容",
      kind: "observation",
      domainTags: ["测试"],
      createdBy: "alice",
    });

    // 另一进程 update
    const repoB = new EngramRepository({ rootPath: tmpDir });
    repoB.updateEngram(created.id, {
      title: "新标题",
      content: "新内容",
      updatedBy: "bob",
    });

    // 原 repo 应能看到更新(通过 mtime 兜底)
    const fresh = repo.readEngram(created.id);
    expect(fresh?.title).toBe("新标题");
    expect(fresh?.content).toBe("新内容");
  });

  it("外部进程 deleteEngram 后,本进程 listEngrams 不再返回该条目", () => {
    const a = repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "alice",
    });
    expect(repo.listEngrams().length).toBe(2);

    const repoB = new EngramRepository({ rootPath: tmpDir });
    repoB.deleteEngram(a.id);

    // 原 repo 应感知删除
    expect(repo.listEngrams().length).toBe(1);
    expect(repo.exists(a.id)).toBe(false);
  });

  it("首次空 dataRoot + startWatching 后,createEngram 触发 lazy watcher 重试", async () => {
    // 全新 repo,engram-index.json 不存在
    const freshRepo = new EngramRepository({ rootPath: tmpDir });
    // 此时 engram-index.json 不存在,startWatching 会静默降级
    freshRepo.startWatching();
    try {
      // createEngram → persistIndex → 写盘 → lazy 重试 startWatching
      freshRepo.createEngram({
        title: "触发 lazy watcher",
        content: "首次创建会写盘并启动 watcher",
        kind: "observation",
        domainTags: [],
        createdBy: "alice",
      });

      // 另一进程写入
      const repoB = new EngramRepository({ rootPath: tmpDir });
      repoB.createEngram({
        title: "外部",
        content: "通过另一进程",
        kind: "observation",
        domainTags: [],
        createdBy: "bob",
      });

      // 等 watcher 触发
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 若 lazy 重试成功,watcher 应已捕获外部写入 → cache 失效 → 看到 2 条
      expect(freshRepo.listEngrams().length).toBe(2);
    } finally {
      freshRepo.stopWatching();
    }
  });
});

// ============================================================
// 外部 .md 检测钩子(信任边界:不自动接受 untrusted .md)
// ============================================================

describe("EngramRepository — 外部 .md 检测钩子(信任边界)", () => {
  let extTmpDir: string;
  let extRepo: EngramRepository;

  beforeEach(() => {
    extTmpDir = mkdtempSync(join(tmpdir(), "co-engram-ext-hook-"));
    extRepo = new EngramRepository({ rootPath: extTmpDir, language: "en" });
    // 通过正规路径创建 1 个 engram,触发 index.json 写入。
    // 这模拟"co-engram 已经在正常运行,dataRoot 已有 index.json"的真实状态。
    // 后续测试中 watcher 看到的"已在 index 中"判定才会准确。
    extRepo.createEngram({
      title: "种子记忆",
      content: "用于初始化 index.json",
      kind: "observation",
      domainTags: ["测试"],
      createdBy: "alice",
    });
  });

  afterEach(() => {
    extRepo.stopWatching();
    rmSync(extTmpDir, { recursive: true, force: true });
  });

  /**
   * 辅助:生成一个合法的 engram .md 文件内容(legacy 顶部 frontmatter,en 模式)
   * 用 stableId 01EXT... 前缀(ULID 校验通过),每个文件用不同 id 避免冲突。
   */
  function makeEngramMarkdown(id: string, title: string, body: string): string {
    return [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      `kind: observation`,
      `domainTags:`,
      `  - imported`,
      `createdBy: external`,
      `createdAt: 2026-07-03T00:00:00.000Z`,
      `updatedBy: external`,
      `updatedAt: 2026-07-03T00:00:00.000Z`,
      `version: 1`,
      `status: active`,
      `visibility: public`,
      `---`,
      "",
      body,
      "",
    ].join("\n");
  }

  it("未设置 hook 时 → watcher 触发但 noop(untrusted .md 不进 index)", async () => {
    // 先确保 index.json 已存在且只含 1 个 engram(种子)
    expect(extRepo.listEngrams()).toHaveLength(1);

    // 模拟"用户拷贝一个 .md 文件到 dataRoot"
    writeFileSync(
      join(extTmpDir, "external.md"),
      makeEngramMarkdown("01EXT00000000000000000000AA", "外部文件", "正文"),
    );

    extRepo.startWatching();
    await new Promise((r) => setTimeout(r, 2700));

    // 关键安全断言:index 中**只有**种子文件,新增的 .md 不在内
    // (watcher 没 hook 通知任何人,且 index.json 不会被自动重写)
    const all = extRepo.listEngrams();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("种子记忆");
  });

  it("设置 hook + 用户拷贝 .md → hook 被调用,但 index 不写入(等审批)", async () => {
    const hookCalls: Array<{
      relPath: string;
      parsed: { readonly frontmatter: { readonly [k: string]: unknown } } | null;
    }> = [];
    extRepo.setExternalMarkdownHook((params) => {
      hookCalls.push({ relPath: params.relPath, parsed: params.parsed });
    });

    extRepo.startWatching();
    // 给 watcher 一点时间稳定
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(
      join(extTmpDir, "external.md"),
      makeEngramMarkdown("01EXT00000000000000000000BB", "外部文件", "正文"),
    );
    await new Promise((r) => setTimeout(r, 2700));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.relPath).toBe("external.md");
    expect(hookCalls[0]!.parsed).not.toBeNull();
    expect(hookCalls[0]!.parsed!.frontmatter.title).toBe("外部文件");

    // 关键安全断言:即使 hook 调用了,index 仍然只有种子文件
    // (hook 自身只负责形成 proposal,真正的 index 写入要等 accept → engram_create)
    expect(extRepo.listEngrams()).toHaveLength(1);
  });

  it("已在 index 中的 .md(engram_create 写入)→ 不触发 hook", async () => {
    let hookCalls = 0;
    extRepo.setExternalMarkdownHook(() => {
      hookCalls++;
    });

    extRepo.startWatching();
    await new Promise((r) => setTimeout(r, 2700));

    // 种子文件已通过 engram_create 进入 index,watcher 不应触发 hook
    expect(hookCalls).toBe(0);
  });

  it("裸 .md(无 frontmatter)→ hook 收到 parsed=null,不构成 engram", async () => {
    const hookCalls: Array<{ parsed: unknown; relPath: string }> = [];
    extRepo.setExternalMarkdownHook((params) => {
      hookCalls.push({ parsed: params.parsed, relPath: params.relPath });
    });

    extRepo.startWatching();
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(join(extTmpDir, "notes.md"), "这是一个普通笔记,无 frontmatter");
    await new Promise((r) => setTimeout(r, 2700));

    // 只 notes.md 触发(种子 .md 已在 index,跳过)
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.relPath).toBe("notes.md");
    expect(hookCalls[0]!.parsed).toBeNull();
  });

  it("hook 返回的 unregister 函数 → 后续 watcher 不再调用", async () => {
    let hookCalls = 0;
    const unregister = extRepo.setExternalMarkdownHook(() => {
      hookCalls++;
    });

    extRepo.startWatching();
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(
      join(extTmpDir, "a.md"),
      makeEngramMarkdown("01EXT0000000000000000000AAA", "A", "body a"),
    );
    await new Promise((r) => setTimeout(r, 2700));
    expect(hookCalls).toBe(1);

    unregister();

    writeFileSync(
      join(extTmpDir, "b.md"),
      makeEngramMarkdown("01EXT0000000000000000000BBB", "B", "body b"),
    );
    await new Promise((r) => setTimeout(r, 2700));
    expect(hookCalls).toBe(1); // 仍然是 1,unregister 后不再触发
  }, 15000);

  it("多个外部 .md 同时拷贝 → debounce 合并,各自触发 hook 一次", async () => {
    const seen: string[] = [];
    extRepo.setExternalMarkdownHook((params) => {
      seen.push(params.relPath);
    });

    extRepo.startWatching();
    await new Promise((r) => setTimeout(r, 100));

    // 一次性写 3 个文件(模拟 rsync / git checkout 的批量场景)
    writeFileSync(
      join(extTmpDir, "a.md"),
      makeEngramMarkdown("01EXT0000000000000000000A1", "A", "a"),
    );
    writeFileSync(
      join(extTmpDir, "b.md"),
      makeEngramMarkdown("01EXT0000000000000000000B1", "B", "b"),
    );
    writeFileSync(
      join(extTmpDir, "c.md"),
      makeEngramMarkdown("01EXT0000000000000000000C1", "C", "c"),
    );
    await new Promise((r) => setTimeout(r, 2700));

    expect(seen.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });
});

// ============================================================
// post-merge runPostMergeCheck — 可信路径仍走 runDoctor 自动接受
// ============================================================
