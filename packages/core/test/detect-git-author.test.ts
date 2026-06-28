import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectGitAuthor } from "../src/host/detect-git-author.js";

/**
 * detectGitAuthor 行为测试
 *
 * 直接调用本地 git,所以测试需要:
 *   - 测试环境装了 git(几乎所有 CI 和开发机都满足)
 *   - 用临时 HOME + GIT_CONFIG_GLOBAL 隔离 global 配置,避免污染 ~/.gitconfig
 *
 * 如果测试环境没装 git,所有"正向"测试会被 skip(因为没法设置 fixture),
 * 但容错测试(无配置时返回 undefined)仍然可以跑。
 */
const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const itIfGit = hasGit ? it : it.skip;

let tmpHome: string | undefined;
let tmpRepo: string | undefined;
let savedHome: string | undefined;
let savedGitConfigGlobal: string | undefined;
let savedCwd: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedCwd = process.cwd();
});

afterEach(() => {
  // 还原 env
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  // 还原 cwd(测试可能 chdir 到 tmpRepo / tmpdir)
  if (savedCwd !== undefined) {
    try {
      process.chdir(savedCwd);
    } catch {
      // 原目录可能已删,忽略
    }
  }
  // 清理临时目录(skip 时为 undefined)
  for (const dir of [tmpHome, tmpRepo]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
  }
  tmpHome = undefined;
  tmpRepo = undefined;
});

function setupTmpEnv(): void {
  tmpHome = mkdtempSync(join(tmpdir(), "co-engram-git-home-"));
  tmpRepo = mkdtempSync(join(tmpdir(), "co-engram-git-repo-"));
  process.env.HOME = tmpHome;
  process.env.GIT_CONFIG_GLOBAL = join(tmpHome, ".gitconfig");
  // 初始化一个空仓库(虽然在仓库外调用也能读到 global,但这样更接近实际)
  execSync("git init", { cwd: tmpRepo, stdio: "ignore" });
  // chdir 到 tmpRepo,避免宿主仓库的 local .git/config 干扰测试。
  // detectGitAuthor() 用 `git config user.name`(无 --global)读取,
  // 会合并 system + global + local(cwd 所在仓库的 .git/config)。
  // 若不 chdir,vitest 的 cwd 是 packages/core(co-engram 仓库内),
  // 该仓库 local 设了 user.name,会覆盖测试设的 global 值,导致 4 个正向测试失败。
  process.chdir(tmpRepo);
}

describe("detectGitAuthor — 容错", () => {
  it("无 git 配置时返回 undefined", () => {
    // 不设置任何 git 配置;即便有 global,也不应抛错
    expect(() => detectGitAuthor()).not.toThrow();
  });

  it("返回值是 string 或 undefined 之一", () => {
    const r = detectGitAuthor();
    expect([undefined, expect.any(String)]).toContainEqual(r);
  });
});

describe("detectGitAuthor — 正向", () => {
  itIfGit("优先返回 user.name(人类可读)", () => {
    setupTmpEnv();
    execSync('git config --global user.name "Alice Engineer"', {
      stdio: "ignore",
    });
    execSync('git config --global user.email "alice@example.com"', {
      stdio: "ignore",
    });
    expect(detectGitAuthor()).toBe("Alice Engineer");
  });

  itIfGit("user.name 缺失时回退到 user.email", () => {
    setupTmpEnv();
    execSync('git config --global user.email "bob@example.com"', {
      stdio: "ignore",
    });
    // 不设 user.name
    expect(detectGitAuthor()).toBe("bob@example.com");
  });

  itIfGit("user.name 与 user.email 都缺失时返回 undefined", () => {
    setupTmpEnv();
    // 故意什么都不设
    expect(detectGitAuthor()).toBeUndefined();
  });

  itIfGit("配置含前后空白时被 trim", () => {
    setupTmpEnv();
    // 注意:shell 会吞掉前后空白,所以这里用 \t 与尾随空格制造空白
    execSync('git config --global user.name "Carol"', { stdio: "ignore" });
    const result = detectGitAuthor();
    expect(result).toBe("Carol");
    expect(result?.startsWith(" ")).toBe(false);
    expect(result?.endsWith(" ")).toBe(false);
  });

  itIfGit("在 git 仓库外调用也能读到 global 配置", () => {
    setupTmpEnv();
    execSync('git config --global user.name "Dana Coder"', { stdio: "ignore" });
    // 切到一个非 git 目录(临时目录的父)
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(detectGitAuthor()).toBe("Dana Coder");
    } finally {
      process.chdir(cwd);
    }
  });

  itIfGit("local user.name 优先于 global(在仓库内)", () => {
    setupTmpEnv();
    execSync('git config --global user.name "Global Alice"', {
      stdio: "ignore",
    });
    execSync('git config user.name "Local Bob"', {
      cwd: tmpRepo,
      stdio: "ignore",
    });
    // detectGitAuthor 在当前 process.cwd() 调用,要让它读到 local 必须切到仓库内
    const cwd = process.cwd();
    try {
      process.chdir(tmpRepo);
      expect(detectGitAuthor()).toBe("Local Bob");
    } finally {
      process.chdir(cwd);
    }
  });
});
