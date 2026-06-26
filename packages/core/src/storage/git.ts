/**
 * Git 操作封装（基于 child_process 调用系统 git）
 *
 * 不依赖外部 npm 包，保持 host-agnostic。
 * 只封装 co-engram 需要的最小操作集。
 *
 * @module @co-engram/core/storage
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Git 提交选项 */
export interface GitCommitOptions {
  /** 仓库根目录 */
  readonly repoPath: string;
  /** 要提交的文件相对路径列表 */
  readonly files: readonly string[];
  /** 提交消息 */
  readonly message: string;
  /** 作者（覆盖 git config） */
  readonly authorName?: string;
  readonly authorEmail?: string;
}

/** Git 提交结果 */
export interface GitCommitResult {
  readonly commitHash: string;
  readonly branch: string;
  readonly filesChanged: number;
}

/**
 * 检查路径是否是 Git 仓库
 */
export function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) {
    return false;
  }
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: repoPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 初始化 Git 仓库
 */
export function initGitRepo(repoPath: string): void {
  if (isGitRepo(repoPath)) {
    return;
  }
  execSync("git init", { cwd: repoPath, stdio: "ignore" });
  // 设置默认分支为 main
  try {
    execSync("git symbolic-ref HEAD refs/heads/main", {
      cwd: repoPath,
      stdio: "ignore",
    });
  } catch {
    // 老版本 git 可能不支持，忽略
  }
}

/**
 * Stage 文件并提交
 *
 * 注意：不会自动 push，团队需要时手动 push。
 */
export function commitFiles(options: GitCommitOptions): GitCommitResult {
  const { repoPath, files, message, authorName, authorEmail } = options;

  if (!isGitRepo(repoPath)) {
    initGitRepo(repoPath);
  }

  // Stage files
  if (files.length > 0) {
    const fileArgs = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    execSync(`git add ${fileArgs}`, { cwd: repoPath, stdio: "ignore" });
  } else {
    execSync("git add -A", { cwd: repoPath, stdio: "ignore" });
  }

  // Check if there are staged changes
  let hasStagedChanges = true;
  try {
    execSync("git diff --cached --quiet", { cwd: repoPath, stdio: "ignore" });
    hasStagedChanges = false; // exit 0 means no changes
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    // Nothing to commit
    const branch = getCurrentBranch(repoPath);
    return { commitHash: "", branch, filesChanged: 0 };
  }

  // Commit
  const authorArgs: string[] = [];
  if (authorName) {
    authorArgs.push(`-c "user.name=${authorName.replace(/"/g, '\\"')}"`);
  }
  if (authorEmail) {
    authorArgs.push(`-c "user.email=${authorEmail}"`);
  }
  const authorPart =
    authorArgs.length > 0 ? `git ${authorArgs.join(" ")}` : "git";
  const escapedMessage = message.replace(/"/g, '\\"');
  execSync(`${authorPart} commit -m "${escapedMessage}"`, {
    cwd: repoPath,
    stdio: "ignore",
  });

  const commitHash = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
  const branch = getCurrentBranch(repoPath);

  // Count changed files in this commit
  const filesChanged = parseInt(
    execSync("git diff --name-only HEAD~1 HEAD 2>/dev/null | wc -l", {
      cwd: repoPath,
      encoding: "utf8",
    }).trim() || "0",
    10,
  );

  return { commitHash, branch, filesChanged };
}

/**
 * 获取当前分支名
 */
export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
  } catch {
    return "main";
  }
}

/**
 * 获取文件最后的提交信息
 */
export function getFileLastCommit(
  repoPath: string,
  relativePath: string,
): { hash: string; date: string; message: string } | null {
  try {
    const hash = execSync(`git log -n 1 --format="%H" -- "${relativePath}"`, {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
    if (!hash) {
      return null;
    }
    const date = execSync(`git log -n 1 --format="%cI" -- "${relativePath}"`, {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
    const message = execSync(
      `git log -n 1 --format="%s" -- "${relativePath}"`,
      {
        cwd: repoPath,
        encoding: "utf8",
      },
    ).trim();
    return { hash, date, message };
  } catch {
    return null;
  }
}

/**
 * 获取仓库根目录的绝对路径
 */
export function resolveRepoPath(repoPath: string): string {
  if (existsSync(join(repoPath, ".git"))) {
    return repoPath;
  }
  return repoPath;
}
