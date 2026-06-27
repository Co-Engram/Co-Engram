import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  installPostMergeHook,
  uninstallPostMergeHook,
  getPostMergeHookStatus,
  runPostMergeCheck,
  HOOK_MARKER,
  HOOK_RELATIVE_PATH,
} from "./post-merge-hook.js";

function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

function hookPath(repoRoot: string): string {
  return join(repoRoot, HOOK_RELATIVE_PATH);
}

describe("installPostMergeHook", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pmh-repo-"));
    initGitRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates hook file on first install", () => {
    const result = installPostMergeHook({ repoRoot: repo });
    expect(existsSync(result.hookPath)).toBe(true);
    expect(result.overwritten).toBe(false);
    const content = readFileSync(result.hookPath, "utf8");
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain("post-merge --cwd");
  });

  it("overwrites our own previously-installed hook (upgrade path)", () => {
    installPostMergeHook({ repoRoot: repo });
    // 第二次安装 → 覆盖(版本升级)
    const result = installPostMergeHook({ repoRoot: repo });
    expect(result.overwritten).toBe(true);
    expect(existsSync(result.hookPath)).toBe(true);
  });

  it("preserves user-defined hook and writes sidecar instead", () => {
    // 用户先有自己的 hook
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    const userHook = hookPath(repo);
    writeFileSync(userHook, "#!/bin/sh\necho user-custom\n");
    chmodSync(userHook, 0o755);

    const result = installPostMergeHook({ repoRoot: repo });
    expect(result.overwritten).toBe(false);
    expect(result.hookPath).toMatch(/post-merge\.co-engram$/);

    // 原用户 hook 内容没动
    const userContent = readFileSync(userHook, "utf8");
    expect(userContent).toBe("#!/bin/sh\necho user-custom\n");
  });

  it("sets executable bit on hook", () => {
    installPostMergeHook({ repoRoot: repo });
    const stat = execSync(`stat -c '%a' ${hookPath(repo)}`, {
      encoding: "utf8",
    }).trim();
    // 0o755 = 755 字符串
    expect(stat).toBe("755");
  });
});

describe("getPostMergeHookStatus", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pmh-status-"));
    initGitRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns not installed when no hook exists", () => {
    const status = getPostMergeHookStatus({ repoRoot: repo });
    expect(status.installed).toBe(false);
  });

  it("detects our hook at primary path", () => {
    installPostMergeHook({ repoRoot: repo });
    const status = getPostMergeHookStatus({ repoRoot: repo });
    expect(status.installed).toBe(true);
    expect(status.atPrimaryPath).toBe(true);
  });

  it("detects sidecar when user has custom hook", () => {
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    writeFileSync(hookPath(repo), "#!/bin/sh\necho custom\n");
    chmodSync(hookPath(repo), 0o755);

    installPostMergeHook({ repoRoot: repo });
    const status = getPostMergeHookStatus({ repoRoot: repo });
    expect(status.installed).toBe(true);
    expect(status.atPrimaryPath).toBe(false);
  });
});

describe("uninstallPostMergeHook", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pmh-uninstall-"));
    initGitRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("removes our hook", () => {
    installPostMergeHook({ repoRoot: repo });
    expect(existsSync(hookPath(repo))).toBe(true);

    const result = uninstallPostMergeHook({ repoRoot: repo });
    expect(result.removed).toBe(true);
    expect(existsSync(hookPath(repo))).toBe(false);
  });

  it("does not remove user-defined hook", () => {
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    writeFileSync(hookPath(repo), "#!/bin/sh\necho user\n");
    chmodSync(hookPath(repo), 0o755);

    const result = uninstallPostMergeHook({ repoRoot: repo });
    expect(result.removed).toBe(false);
    expect(existsSync(hookPath(repo))).toBe(true);
  });

  it("returns removed=false when no hook exists", () => {
    const result = uninstallPostMergeHook({ repoRoot: repo });
    expect(result.removed).toBe(false);
  });
});

describe("runPostMergeCheck", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pmh-run-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns dataRoot=null when no .co-engram marker up the tree", async () => {
    const result = await runPostMergeCheck({ cwd });
    expect(result.dataRoot).toBeNull();
    expect(result.inconsistencies).toBe(0);
  });

  it("detects data root and runs consistency check", async () => {
    // 模拟一个 team-memory 仓库:有 .co-engram/ 标记
    mkdirSync(join(cwd, ".co-engram"), { recursive: true });
    writeFileSync(
      join(cwd, ".co-engram", "config.json"),
      JSON.stringify({ version: 1, language: "en" }),
    );

    const result = await runPostMergeCheck({ cwd });
    expect(result.dataRoot).toBe(cwd);
    // 空仓库 → 无 engram → 无 inconsistency
    expect(result.inconsistencies).toBe(0);
    expect(result.error).toBeUndefined();
  });
});
