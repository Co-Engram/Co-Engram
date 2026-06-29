/**
 * commitFiles spawn 安全测试(Task 4.2)
 *
 * 验证 commitFiles 不通过 shell 拼接命令(避免 backtick / $ / 反引号
 * 等 shell 元字符让 authorName / message 触发任意命令执行)。
 *
 * 测试构造 authorName = `user\`whoami\`` —— 旧 execSync + 字符串拼接实现
 * 会让 backtick 被 shell 解释,执行 whoami,导致 git config user.name 变成
 * `user<whoami_output>`。spawnSync + 数组参数实现下,backtick 字面保留。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitFiles } from "../src/storage/git.js";

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itIfGit = hasGit ? it : it.skip;

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
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  if (savedCwd !== undefined) {
    try {
      process.chdir(savedCwd);
    } catch {
      // ignore
    }
  }
  if (tmpRepo) {
    try {
      rmSync(tmpRepo, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpRepo = undefined;
});

function setupTmpRepo(): void {
  const tmpHome = mkdtempSync(join(tmpdir(), "co-engram-commit-home-"));
  tmpRepo = mkdtempSync(join(tmpdir(), "co-engram-commit-repo-"));
  process.env.HOME = tmpHome;
  process.env.GIT_CONFIG_GLOBAL = join(tmpHome, ".gitconfig");
  execSync("git init", { cwd: tmpRepo, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', {
    cwd: tmpRepo,
    stdio: "ignore",
  });
  execSync('git config user.name "Test User"', {
    cwd: tmpRepo,
    stdio: "ignore",
  });
  process.chdir(tmpRepo);
}

describe("commitFiles spawn safety (Task 4.2)", () => {
  itIfGit(
    "authorName with backtick 不执行 shell,字面保留",
    () => {
      setupTmpRepo();
      writeFileSync(join(tmpRepo!, "test.md"), "hello\n", "utf8");
      // 含 backtick 的 authorName —— 旧实现会执行 whoami 命令
      const malicious = 'user`whoami`';
      const result = commitFiles({
        repoPath: tmpRepo!,
        files: ["test.md"],
        message: "test commit",
        authorName: malicious,
        authorEmail: "u@example.com",
      });
      expect(result.commitHash).toBeTruthy();
      // 读回这次 commit 的 author name
      const committedName = execSync("git log -1 --format='%an'", {
        cwd: tmpRepo!,
        encoding: "utf8",
      }).trim();
      // 字面保留 backtick(未被 shell 执行)
      expect(committedName).toBe(malicious);
    },
  );

  itIfGit("message with $ 不展开 shell 变量", () => {
    setupTmpRepo();
    writeFileSync(join(tmpRepo!, "test2.md"), "world\n", "utf8");
    const message = "fix $(echo pwned) bug";
    const result = commitFiles({
      repoPath: tmpRepo!,
      files: ["test2.md"],
      message,
    });
    expect(result.commitHash).toBeTruthy();
    const committedMessage = execSync("git log -1 --format='%s'", {
      cwd: tmpRepo!,
      encoding: "utf8",
    }).trim();
    expect(committedMessage).toBe(message);
  });

  itIfGit("filename with space 字面保留(数组参数,无需 shell 转义)", () => {
    setupTmpRepo();
    mkdirSync(join(tmpRepo!, "sub"), { recursive: true });
    const fname = "file with space.md";
    writeFileSync(join(tmpRepo!, fname), "spaced\n", "utf8");
    const result = commitFiles({
      repoPath: tmpRepo!,
      files: [fname],
      message: "add spaced file",
    });
    expect(result.commitHash).toBeTruthy();
    expect(result.filesChanged).toBe(1);
  });
});
