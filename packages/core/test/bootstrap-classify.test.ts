import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDataRootChange,
  classifyTargetPath,
} from "../src/bootstrap/classify.js";

// 这组测试锁住首次用户 dataroot 设置的关键行为:
//
// 历史背景:PUT /api/config 端点曾一刀切拒绝 non-engram 目录(无 --force 选项),
// 把首次用户最常见场景——"我想放在 ~/我的项目/team-memory"——挡在门外。
// 改进后:applyDataRootChange 在 non-engram 失败时返回 existingFiles 数组,
// 让 UI 弹"接管此目录"二次确认 banner(中文化、列出现有文件),用户确认后
// 带 force=true 重发请求。这组测试防止回归到"硬拒绝、不返回 existingFiles"。
//
// 同时锁住"接管 non-engram 目录时用户原有文件不被破坏"——这是用户对 force 的
// 核心信任基础。

describe("bootstrap/classify — applyDataRootChange UX 行为(首次用户场景)", () => {
  let tmpRoot: string;
  let originalHomeBootstrap: string | undefined;
  let homeBootstrapPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "co-engram-bootstrap-test-"));
    // 把 bootstrap config 重定向到 tmp,避免污染真实 ~/.co-engram/config.json
    homeBootstrapPath = join(tmpRoot, "bootstrap-config.json");
    originalHomeBootstrap = process.env.HOME;
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    if (originalHomeBootstrap !== undefined) {
      process.env.HOME = originalHomeBootstrap;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("missing 目录 + force=false → 自动 mkdir + initialize", async () => {
    const path = join(tmpRoot, "does-not-exist");
    const r = await applyDataRootChange(path, { force: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.classification).toBe("missing");
      expect(r.initialized).toBe(true);
    }
  });

  it("empty 目录 + force=false → 接管 + initialize", async () => {
    const path = join(tmpRoot, "empty-dir");
    mkdirSync(path, { recursive: true });
    const r = await applyDataRootChange(path, { force: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.classification).toBe("empty");
      expect(r.initialized).toBe(true);
    }
  });

  it("engram-warehouse + force=false → 直接接管,不重新 initialize", async () => {
    const path = join(tmpRoot, "existing-warehouse");
    mkdirSync(join(path, ".co-engram"), { recursive: true });
    writeFileSync(
      join(path, ".co-engram", "config.json"),
      '{"version":1}',
    );
    const r = await applyDataRootChange(path, { force: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.classification).toBe("engram-warehouse");
      expect(r.initialized).toBe(false);
    }
  });

  it("non-engram + force=false → 失败,但返回 existingFiles/existingCount 让 UI 弹二次确认", async () => {
    const path = join(tmpRoot, "non-engram-dir");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "README.md"), "# existing project");
    writeFileSync(join(path, "notes.txt"), "my notes");
    mkdirSync(join(path, "subdir"), { recursive: true });
    writeFileSync(join(path, "subdir", "file.txt"), "sub");

    const r = await applyDataRootChange(path, { force: false });

    // 首次拒绝 + 返回现有文件清单(关键:让 UI 能弹二次确认)
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("non-engram");
      expect(r.existingCount).toBe(3);
      expect(r.existingFiles).toBeDefined();
      expect(r.existingFiles?.sort()).toEqual(["README.md", "notes.txt", "subdir"]);
    }
  });

  it("non-engram + force=true → 接管成功,用户原有文件完好无损", async () => {
    const path = join(tmpRoot, "takeover-dir");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "README.md"), "# my project notes");
    writeFileSync(join(path, "TODO.txt"), "- task1\n- task2");
    mkdirSync(join(path, "subdir"), { recursive: true });
    writeFileSync(join(path, "subdir", "file.txt"), "sub-content");

    const r = await applyDataRootChange(path, { force: true });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.classification).toBe("non-engram");
      expect(r.initialized).toBe(true);
    }

    // 用户原有文件必须完好——这是 force 的核心信任基础
    expect(readFileUtf8(join(path, "README.md"))).toBe("# my project notes");
    expect(readFileUtf8(join(path, "TODO.txt"))).toBe("- task1\n- task2");
    expect(readFileUtf8(join(path, "subdir", "file.txt"))).toBe("sub-content");
    // .co-engram/ 子目录被新建,但与用户文件并存
    expect(classifyTargetPath(path)).toBe("engram-warehouse");
  });

  it("空路径 + force=true → 仍按 invalid 拒绝(force 不能绕过空路径校验)", async () => {
    const r = await applyDataRootChange("   ", { force: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid");
    }
  });
});

function readFileUtf8(p: string): string {
  // 用同步 readFileSync 小文件场景,避免引入额外的 fs/promise import
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(p, "utf8");
}
