/**
 * Git 操作封装（基于 child_process 调用系统 git）
 *
 * 不依赖外部 npm 包，保持 host-agnostic。
 * 只封装 co-engram 需要的最小操作集。
 *
 * 公司内外部兼容性策略:
 *   - 直接调用系统 `git`,继承用户 SSH/credentials/proxy 环境
 *   - 不硬编码任何主机名/URL/refspec(Gerrit review 由用户 .git/config 决定)
 *   - 不主动写 Change-Id(ZTE/Gerrit commit-msg hook 若已装会自动加)
 *
 * @module @co-engram/core/storage
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
 *
 * 实现安全说明(Task 4.2):用 `spawnSync` + 数组参数(`args[]`)而非
 * `execSync` + 字符串拼接,避免 shell 元字符(backtick / $ / 反引号)
 * 在 authorName / message / file 路径里触发命令注入。数组参数下 git
 * 直接收到原始字符串,不经 shell 解释。
 */
export function commitFiles(options: GitCommitOptions): GitCommitResult {
  const { repoPath, files, message, authorName, authorEmail } = options;

  if (!isGitRepo(repoPath)) {
    initGitRepo(repoPath);
  }

  // Stage files —— 数组参数,文件名含空格 / 特殊字符都无需 shell 转义
  if (files.length > 0) {
    runGitSpawn(repoPath, ["add", ...files]);
  } else {
    runGitSpawn(repoPath, ["add", "-A"]);
  }

  // Check if there are staged changes(git diff --cached --quiet 退出码:
  // 0 = 无变化,1 = 有变化)
  const diffResult = spawnSync(
    "git",
    ["diff", "--cached", "--quiet"],
    { cwd: repoPath, stdio: "ignore" },
  );
  if (diffResult.status === 0) {
    // Nothing to commit
    const branch = getCurrentBranch(repoPath);
    return { commitHash: "", branch, filesChanged: 0 };
  }

  // Commit —— 用 -c user.name=... -c user.email=... 临时覆盖;数组参数
  // 让 authorName 含 backtick / $ 等也字面保留,不触发 shell
  const commitArgs: string[] = [];
  if (authorName) {
    commitArgs.push("-c", `user.name=${authorName}`);
  }
  if (authorEmail) {
    commitArgs.push("-c", `user.email=${authorEmail}`);
  }
  commitArgs.push("commit", "-m", message);
  runGitSpawn(repoPath, commitArgs);

  const commitHash = spawnSyncOutput(repoPath, ["rev-parse", "HEAD"]).trim();
  const branch = getCurrentBranch(repoPath);

  // Count changed files in this commit(spawn 版,无 shell pipeline)
  // 用 `git show --name-only` 对首次 commit(无 HEAD~1)也工作
  const showNames = spawnSyncOutput(repoPath, [
    "show",
    "--name-only",
    "--pretty=format:",
    "HEAD",
  ]).trim();
  const filesChanged = showNames
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  return { commitHash, branch, filesChanged };
}

/**
 * 内部 helper:用 spawnSync 跑 git 命令,失败抛错。
 *
 * 数组参数绕过 shell,任何字符(包括 backtick / $ / 引号 / 换行)都按
 * 字面传递给 git。是 Task 4.2 防 shell 注入的核心。
 */
function runGitSpawn(repoPath: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `git ${args.join(" ")} failed (status=${result.status}): ${stderr}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * 内部 helper:用 spawnSync 跑 git 命令取 stdout,失败返回空串。
 */
function spawnSyncOutput(repoPath: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return result.stdout ?? "";
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

// ============================================================
// engram_sync 工具所需:pull / push / status / remote / gitignore
// ============================================================

/** `git pull` 结果 */
export interface GitPullResult {
  /** 是否成功(无冲突) */
  readonly ok: boolean;
  /** 远端无新内容(已是最新) */
  readonly upToDate?: boolean;
  /** rebase 冲突文件清单(相对仓库根路径);ok=false 时填 */
  readonly conflicts?: readonly string[];
  /** 合并/快进的提交数(upToDate=true 时为 0) */
  readonly fetchedCount?: number;
}

/**
 * `git pull --rebase` —— 用 rebase 策略保持线性历史。
 *
 * 冲突时执行 `git rebase --abort` 回到 pull 前状态,并返回 conflicts 清单,
 * 让调用方决定下一步(人工解决 / 放弃)。绝不自动 resolve。
 *
 * 远端无新提交时返回 `{ ok: true, upToDate: true }`。
 *
 * 注意:调用方需保证 repoPath 是 git 仓库(用 isGitRepo 预检)。
 */
export function pullRepo(repoPath: string): GitPullResult {
  // 先 fetch,再尝试 rebase。分离两步便于精准识别"无远端更新"vs"rebase 冲突"。
  // --quiet 抑制 fetch 的进度噪声;--prune 让 deleted remote branch 同步。
  try {
    execSync("git fetch --quiet --prune", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    // fetch 失败:无远端 / 网络问题。降级为 "upToDate"(让 commit 阶段继续)。
    // 真正的"无远端"由 hasRemote 预检过滤;这里只剩网络问题。
    return { ok: true, upToDate: true };
  }

  // 比较本地与上游:HEAD...@{upstream}
  // 若无 upstream,直接 upToDate(本地分支未跟踪远端,pull 无意义)
  let upstreamAvailable = true;
  try {
    execSync("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    upstreamAvailable = false;
  }
  if (!upstreamAvailable) {
    return { ok: true, upToDate: true };
  }

  // 计算远端领先的提交数
  let behindCount = 0;
  try {
    const raw = execSync(
      "git rev-list --count HEAD..@{upstream}",
      { cwd: repoPath, stdio: "pipe", encoding: "utf8" },
    ).trim();
    behindCount = parseInt(raw, 10) || 0;
  } catch {
    behindCount = 0;
  }
  if (behindCount === 0) {
    return { ok: true, upToDate: true };
  }

  // 真正 rebase:--autostash 让本地未提交变更自动暂存
  try {
    execSync("git pull --rebase --autostash", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, fetchedCount: behindCount };
  } catch {
    // rebase 冲突:提取冲突文件清单,然后 abort 回到 pull 前状态
    const conflicts = listRebaseConflicts(repoPath);
    try {
      execSync("git rebase --abort", {
        cwd: repoPath,
        stdio: "ignore",
      });
    } catch {
      // abort 失败说明不在 rebase 状态(可能冲突已自动跳出),忽略
    }
    return { ok: false, conflicts };
  }
}

/**
 * 列出当前 rebase 冲突中的文件(相对仓库根路径)。
 *
 * 用 `git diff --name-only --diff-filter=U`:列出 unmerged paths。
 * 仅在 rebase/merge 进行中或索引有冲突标记时返回非空。
 */
function listRebaseConflicts(repoPath: string): readonly string[] {
  try {
    const raw = execSync("git diff --name-only --diff-filter=U", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** `git push` 结果 */
export interface GitPushResult {
  /** 是否成功 */
  readonly ok: boolean;
  /** 是否被跳过(无 remote / push=false / 无 upstream) */
  readonly skipped: boolean;
  /** 跳过/失败原因 */
  readonly reason?: string;
  /** push 到的 remote 名称(如 "origin") */
  readonly remote?: string;
}

/**
 * `git push` —— 推送当前分支到配置的 upstream。
 *
 * 不带 refspec(让 git 用 push.default 配置),完全尊重用户 .git/config。
 * 这意味着:
 *   - GitHub/GitLab 用户推到 origin/<branch>
 *   - ZTE/Gerrit 用户若 .git/config 配置了 `push = refs/heads/*:refs/for/*`
 *     会自动走 review;否则直接 push 到 master(由用户配置决定)
 *
 * 不抛错 —— 返回结构化结果让工具层向用户报告。
 */
export function pushRepo(repoPath: string): GitPushResult {
  // 检测 remote
  let remote = "";
  try {
    remote = execSync("git remote", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? "";
  } catch {
    return {
      ok: false,
      skipped: true,
      reason: "no remote configured (commit only, no push)",
    };
  }
  if (!remote) {
    return {
      ok: false,
      skipped: true,
      reason: "no remote configured (commit only, no push)",
    };
  }

  // 检测当前分支是否有 upstream
  try {
    execSync("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    // 无 upstream:尝试用当前分支名推到 remote,设上游
    const branch = getCurrentBranch(repoPath);
    try {
      execSync(`git push --set-upstream ${remote} ${branch}`, {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf8",
      });
      return { ok: true, skipped: false, remote };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        skipped: false,
        remote,
        reason: `push --set-upstream failed: ${msg}`,
      };
    }
  }

  // 正常 push(已有 upstream)
  try {
    execSync("git push", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, skipped: false, remote };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      skipped: false,
      remote,
      reason: `push rejected: ${msg}`,
    };
  }
}

/**
 * 获取 `git status --short` 解析后的变更清单。
 *
 * 用于 dryRun 预览 + 提交后校验 filesChanged。
 * 返回相对仓库根的路径数组(去重 + 排序,确保跨平台一致)。
 */
export function getGitStatusShort(repoPath: string): readonly string[] {
  try {
    const raw = execSync("git status --short --untracked-files=all", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return raw
      .split("\n")
      .map((line) => {
        // 格式:"XY path" 或 "XY orig -> renamed"
        const trimmed = line.trimEnd();
        if (!trimmed) return "";
        const pathPart = trimmed.slice(3);
        if (pathPart.includes(" -> ")) {
          return pathPart.split(" -> ").at(-1) ?? pathPart;
        }
        return pathPart;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 是否配置了 git remote。
 *
 * 用于工具层在 push=true 时预判"无 remote → commit-only 降级"路径。
 */
export function hasRemote(repoPath: string): boolean {
  try {
    const raw = execSync("git remote", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return raw
      .split("\n")
      .map((l) => l.trim())
      .some(Boolean);
  } catch {
    return false;
  }
}

/**
 * 默认 .gitignore 模板(co-engram 仓库)。
 *
 * 设计原则:整个 `.co-engram/` 目录不入库(派生数据 + 行为缓存 +
 * 审计日志,均可重新生成或本地保留),只跟踪用户内容(*.md, synapses/)。
 *
 * Obsidian 用户态文件(workspace.json 等)每台机器不同,不入库;
 * 团队级配置(app.json, appearance.json 等)可入库,由用户决定。
 */
export const DEFAULT_CO_ENGRAM_GITIGNORE = `# co-engram 仓库默认 .gitignore
# 整个 .co-engram/ 目录不入库(派生数据 + 行为缓存 + 审计日志,可重新生成)
.co-engram/

# Obsidian 用户态(每台机器不同)
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/workspace.json.bak
.obsidian/cache
.obsidian/plugins/*/data.json

# 系统
.DS_Store
Thumbs.db
*.swp
*.swo
`;

/**
 * 若缺失则创建 .gitignore(用 DEFAULT_CO_ENGRAM_GITIGNORE 模板)。
 *
 * @returns true 表示本次创建,false 表示已存在未动。
 */
export function ensureGitignore(repoPath: string): boolean {
  const gitignorePath = join(repoPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    return false;
  }
  writeFileSync(gitignorePath, DEFAULT_CO_ENGRAM_GITIGNORE, "utf8");
  return true;
}

/**
 * 把 `.co-engram/` 目录从 git index 移除(磁盘文件保留)。
 *
 * `.gitignore` 只对未 track 的文件生效;若历史 commit 已 track 了
 * `.co-engram/*`,新建 .gitignore 后这些文件仍会被 commit。
 *
 * 本函数检测这一情况,若已 track 则 `git rm -r --cached --quiet .co-engram/`,
 * 让缓存目录真正退出 git 跟踪(磁盘文件原样保留,不影响运行时)。
 *
 * **重要副作用:** commit 描述是"删除这些文件"。协作者 pull 此 commit 时,
 * 他们本地的 `.co-engram/*` 磁盘文件也会被 git 删除(因为 commit 说删)。
 * 若协作者本地有不可再生的数据(如 audit.jsonl 团队审计),会丢失。
 * 调用方应让用户显式 opt-in,而非默认执行。
 *
 * @returns 移除的文件数(0 = 本来就没 track 或失败)。
 */
export function untrackCoEngramCache(repoPath: string): number {
  // 先检测是否有 tracked 文件
  let trackedRaw = "";
  try {
    trackedRaw = execSync("git ls-files .co-engram/", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    return 0;
  }
  const tracked = trackedRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (tracked.length === 0) {
    return 0;
  }
  try {
    execSync("git rm -r --cached --quiet .co-engram/", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return tracked.length;
  } catch {
    return 0;
  }
}

/**
 * 只读检测:`.co-engram/` 下已 tracked 的文件数(不修改 index)。
 *
 * 用于 dryRun 预测 + 工具层判断是否需要提示用户 opt-in untrack。
 */
export function countTrackedCoEngramCache(repoPath: string): number {
  try {
    const raw = execSync("git ls-files .co-engram/", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * 读取 .gitignore 内容(用于诊断/展示)。不存在返回 null。
 */
export function readGitignore(repoPath: string): string | null {
  const gitignorePath = join(repoPath, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  try {
    return readFileSync(gitignorePath, "utf8");
  } catch {
    return null;
  }
}
