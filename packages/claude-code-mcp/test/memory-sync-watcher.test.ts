import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "@co-engram/core";
import { AutoMemorySyncEngine } from "../src/memory-sync/sync-engine.js";
import { AutoMemoryWatcher } from "../src/memory-sync/memory-watcher.js";

let tmpRoot: string;
let projectsRoot: string;
let repo: EngramRepository;
let engine: AutoMemorySyncEngine;
let watcher: AutoMemoryWatcher;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "co-engram-watcher-"));
  projectsRoot = join(tmpRoot, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  repo = new EngramRepository({ rootPath: join(tmpRoot, "memory-repo") });
  engine = new AutoMemorySyncEngine({
    repository: repo,
    defaultCreatedBy: "watcher-test",
    log: () => {},
  });
});

afterEach(() => {
  watcher?.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProjectMemoryDir(encodedCwd: string): string {
  const dir = join(projectsRoot, encodedCwd, "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMemory(
  dir: string,
  fileName: string,
  opts: { name?: string; type?: string; description?: string; body?: string },
): void {
  const content = `---
name: ${opts.name ?? fileName.replace(/\.md$/, "")}
description: "${opts.description ?? ""}"
metadata:
  node_type: memory
  type: ${opts.type ?? "observation"}
---

${opts.body ?? ""}
`;
  writeFileSync(join(dir, fileName), content, "utf8");
}

describe("AutoMemoryWatcher.start", () => {
  it("projectsRoot 不存在 → 返回 enabled:false", () => {
    watcher = new AutoMemoryWatcher({
      projectsRoot: join(tmpRoot, "no-exist"),
      engine,
    });
    const result = watcher.start();
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("projectsRoot 是文件 → 返回 enabled:false", () => {
    const filePath = join(tmpRoot, "im-a-file");
    writeFileSync(filePath, "not a dir", "utf8");
    watcher = new AutoMemoryWatcher({
      projectsRoot: filePath,
      engine,
    });
    const result = watcher.start();
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("not a directory");
  });

  it("初始扫描所有项目目录下的 .md 文件", () => {
    const dir1 = makeProjectMemoryDir("project-A");
    const dir2 = makeProjectMemoryDir("project-B");
    writeMemory(dir1, "memory-a1.md", {
      name: "memory-a1",
      body: "content A1",
      type: "feedback",
    });
    writeMemory(dir1, "memory-a2.md", {
      name: "memory-a2",
      body: "content A2",
      type: "fact",
    });
    writeMemory(dir2, "memory-b1.md", {
      name: "memory-b1",
      body: "content B1",
      type: "pattern",
    });

    watcher = new AutoMemoryWatcher({ projectsRoot, engine });
    const result = watcher.start();
    expect(result.enabled).toBe(true);
    expect(result.initialSync?.files).toBe(3);
    expect(result.initialSync?.created).toBe(3);
    expect(repo.listEngrams()).toHaveLength(3);
  });

  it("MEMORY.md 索引文件被忽略", () => {
    const dir = makeProjectMemoryDir("proj");
    writeMemory(dir, "real.md", { name: "real", body: "real body" });
    writeFileSync(
      join(dir, "MEMORY.md"),
      "- [real](real.md) — hook\n",
      "utf8",
    );
    watcher = new AutoMemoryWatcher({ projectsRoot, engine });
    const result = watcher.start();
    expect(result.initialSync?.files).toBe(1);
    expect(repo.listEngrams()).toHaveLength(1);
  });

  it("watcher 启动后注册了 projectsRoot + 各 memory 目录的监听", () => {
    const dir1 = makeProjectMemoryDir("proj1");
    const dir2 = makeProjectMemoryDir("proj2");
    writeMemory(dir1, "a.md", { name: "a", body: "x" });
    writeMemory(dir2, "b.md", { name: "b", body: "y" });

    watcher = new AutoMemoryWatcher({ projectsRoot, engine });
    watcher.start();
    // projectsRoot + 2 个 memory 目录
    expect(watcher.watcherCount).toBeGreaterThanOrEqual(3);
  });
});

describe("AutoMemoryWatcher 增量同步(debounce 后)", () => {
  it("启动后新写入 .md → 触发增量同步,创建 engram", async () => {
    const dir = makeProjectMemoryDir("proj");
    watcher = new AutoMemoryWatcher({
      projectsRoot,
      engine,
      debounceMs: 30,
    });
    watcher.start();
    expect(repo.listEngrams()).toHaveLength(0);

    writeMemory(dir, "after-start.md", {
      name: "after-start",
      body: "created after watcher started",
    });

    // 等待 debounce + IO 传播
    await new Promise((resolve) => setTimeout(resolve, 200));

    const all = repo.listEngrams();
    expect(all.length).toBe(1);
    const engram = repo.readEngram(all[0]!.id);
    expect(engram.content).toContain("created after watcher started");
  });

  it("已存在 engram 的 slug 收到内容更新 → updated", async () => {
    const dir = makeProjectMemoryDir("proj");
    writeMemory(dir, "existing.md", {
      name: "existing",
      body: "initial",
    });
    watcher = new AutoMemoryWatcher({
      projectsRoot,
      engine,
      debounceMs: 30,
    });
    watcher.start();
    expect(repo.listEngrams()).toHaveLength(1);
    const initialId = repo.listEngrams()[0]!.id;
    const initialVersion = repo.readEngram(initialId).version;

    writeMemory(dir, "existing.md", {
      name: "existing",
      body: "updated body",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const engram = repo.readEngram(initialId);
    expect(engram.version).toBe(initialVersion + 1);
    expect(engram.content).toContain("updated body");
  });

  it("新项目目录被创建后 → 自动监听其 memory 子目录", async () => {
    watcher = new AutoMemoryWatcher({
      projectsRoot,
      engine,
      debounceMs: 30,
    });
    watcher.start();

    // 启动后新增项目目录
    const newDir = makeProjectMemoryDir("late-project");
    writeMemory(newDir, "late.md", { name: "late", body: "late body" });

    // 等待 projectsRoot watcher 检测到新目录 + 启动子目录 watcher + debounce
    await new Promise((resolve) => setTimeout(resolve, 300));

    const all = repo.listEngrams();
    expect(all.length).toBe(1);
    expect(repo.readEngram(all[0]!.id).content).toContain("late body");
  });

  it("stop() 清理所有 watcher", () => {
    const dir = makeProjectMemoryDir("proj");
    writeMemory(dir, "a.md", { name: "a", body: "x" });
    watcher = new AutoMemoryWatcher({ projectsRoot, engine });
    watcher.start();
    const initialCount = watcher.watcherCount;
    expect(initialCount).toBeGreaterThan(0);

    watcher.stop();
    expect(watcher.watcherCount).toBe(0);

    // 重置 watcher 变量,afterEach 不会再 stop
    watcher = undefined as unknown as AutoMemoryWatcher;

    expect(existsSync(projectsRoot)).toBe(true);
  });
});

describe("AutoMemoryWatcher 错误恢复", () => {
  it("单个文件 YAML 损坏 → 跳过该文件,其他正常同步", () => {
    const dir = makeProjectMemoryDir("proj");
    writeMemory(dir, "good.md", { name: "good", body: "good body" });
    writeFileSync(
      join(dir, "broken.md"),
      `---
name: [invalid
description: "broken"
---
body
`,
      "utf8",
    );
    watcher = new AutoMemoryWatcher({ projectsRoot, engine });
    const result = watcher.start();
    expect(result.initialSync?.files).toBe(2);
    expect(result.initialSync?.created).toBe(1);
    expect(repo.listEngrams()).toHaveLength(1);
  });
});
