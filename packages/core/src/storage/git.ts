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
import { internalError } from "../tools/error-schema.js";

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

  // P0-7:中文路径默认被 git 用 <U+XXXX> 转义,changedFiles 显示为
  // "\xxx\xxx\xxx" 不可读。在 commit 入口设 core.quotepath=false
  // (local repo,不污染 global);失败不阻断 commit —— 这只是显示优化。
  try {
    runGitSpawn(repoPath, ["config", "core.quotepath", "false"]);
  } catch {
    // config 设置失败(如 .git/config 权限问题)不阻断 commit
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
    throw internalError(
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
  /** 实际生效的 push 模式:direct = 普通 push;gerrit-review = 走 refs/for/<branch> review */
  readonly mode?: "direct" | "gerrit-review";
  /** 仅在 direct 拒绝后自动 fallback 到 gerrit-review 成功时为 true */
  readonly autoFallback?: true;
}

/**
 * 检测 stderr 是否是 Gerrit 对受保护分支的拒绝特征。
 *
 * Gerrit 对 master 等受保护分支的直接 push 返回 "prohibited by Gerrit"
 * 或 "need 'Push' rights"。命中后可 fallback 到 `refs/for/<branch>` 走 review。
 */
export function isGerritRejection(stderr: string): boolean {
  return /prohibited by Gerrit|need ['"]Push['"] rights/i.test(stderr);
}

/**
 * 用 `refs/for/<branch>` refspec 推送(Gerrit code-review 流程)。
 *
 * spawnSync + 数组参数,与 commitFiles 安全模型一致:branch 名含特殊字符
 * 也按字面传递给 git,不经 shell 解释。
 */
function tryGerritReviewPush(
  repoPath: string,
  remote: string,
  branch: string,
): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync("git", ["push", remote, `HEAD:refs/for/${branch}`], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const stderr = (result.stderr ?? "").trim();
  return {
    ok: false,
    reason: `gerrit-review push to refs/for/${branch} failed: ${stderr || `exit status ${result.status ?? "unknown"}`}`,
  };
}

/**
 * push 失败的统一处理:若 stderr 命中 Gerrit 拒绝特征,fallback 到 review refspec。
 *
 * execSync 失败时 Error.stderr 含 git 原始 stderr(encoding=utf8 时为 string),
 * 兜底用 err.message。返回带 mode/autoFallback 标记的 GitPushResult。
 */
function handlePushFailure(
  repoPath: string,
  remote: string,
  err: unknown,
  directLabel: string,
): GitPushResult {
  const errStderr = (err as { stderr?: unknown }).stderr;
  const stderr =
    typeof errStderr === "string"
      ? errStderr
      : Buffer.isBuffer(errStderr)
        ? errStderr.toString("utf8")
        : "";
  const msg = err instanceof Error ? err.message : String(err);
  const combined = stderr.trim() || msg;

  if (isGerritRejection(combined)) {
    const branch = getCurrentBranch(repoPath);
    const review = tryGerritReviewPush(repoPath, remote, branch);
    if (review.ok) {
      return {
        ok: true,
        skipped: false,
        remote,
        mode: "gerrit-review",
        autoFallback: true,
      };
    }
    return {
      ok: false,
      skipped: false,
      remote,
      mode: "gerrit-review",
      reason: review.reason,
    };
  }
  return {
    ok: false,
    skipped: false,
    remote,
    mode: "direct",
    reason: `${directLabel}: ${combined}`,
  };
}

/**
 * `git push` —— 推送当前分支,失败时若检测到 Gerrit 拒绝则自动 fallback 到 review。
 *
 * 行为:
 *   - 有 upstream → `git push`(尊重 push.default 配置)
 *   - 无 upstream → `git push --set-upstream <remote> <branch>`
 *   - 任一路径失败且 stderr 命中 Gerrit 拒绝特征 → 自动重试
 *     `git push <remote> HEAD:refs/for/<branch>`(spawnSync 数组参数,防注入)
 *
 * 兼容 GitHub / GitLab / Gerrit / 内部 Git 服务,不硬编码 URL 或 refspec。
 * Gerrit 用户无需手动配置 .git/config 的 `push = refs/heads/*:refs/for/*`,
 * 检测到 direct push 被拒即自动走 review(返回 mode="gerrit-review", autoFallback=true)。
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
      return { ok: true, skipped: false, remote, mode: "direct" };
    } catch (err) {
      return handlePushFailure(
        repoPath,
        remote,
        err,
        `push --set-upstream ${remote} ${branch} failed`,
      );
    }
  }

  // 正常 push(已有 upstream)
  try {
    execSync("git push", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, skipped: false, remote, mode: "direct" };
  } catch (err) {
    return handlePushFailure(repoPath, remote, err, "push rejected");
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
# 注意:团队动态事件在 events/ 目录(2026-08-19 起),**必须入库**——
# 它是跨机动态流的数据源,加入 ignore 会导致看不到团队成员的记忆动态。
.co-engram/

# Private engrams(visibility='private')—— 用户私人记忆,不入团队仓库
# 本机 agent 仍可索引/检索;只在 git sync 层隔离。
# 用户若想保留 private engram 的 git 历史,可在 private/ 子目录建独立 git 仓库。
private/

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
 * 向已存在的 .gitignore 追加规则(幂等)。
 *
 * 用于让历史已存在的 .gitignore 升级,补上新规则(如 `private/`)。
 * 与 `ensureGitignore` 互补:后者只处理"文件不存在"场景。
 *
 * 幂等性:若 .gitignore 已含相同 rule 行(忽略首尾空白),不重复追加。
 *
 * @returns true 表示本次追加,false 表示已含该 rule 或 .gitignore 不存在。
 */
export function appendToGitignore(repoPath: string, rule: string): boolean {
  const gitignorePath = join(repoPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return false;
  }
  const content = readFileSync(gitignorePath, "utf8");
  // 逐行比对,trim 后相等视为已含(避免末尾空白差异导致重复)
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === rule.trim()) {
      return false;
    }
  }
  // 追加:确保前一个空行存在,避免粘连上一行
  const prefix = content.endsWith("\n") ? "" : "\n";
  const separator = content.trim().length === 0 ? "" : "\n";
  writeFileSync(
    gitignorePath,
    `${content}${prefix}${separator}${rule}\n`,
    "utf8",
  );
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
 * 列出 repo 中所有 git-tracked 的 .md 文件(相对 repoPath,正斜杠)。
 *
 * 用于 scanForExternalMarkdown 判定"未在 index 的 .md 是否为团队仓库已授权内容":
 * git tracked = 经过 PR/commit 审查 → 直接纳管,不走 proposal;未被 track = 外部来源
 * (cp / 投毒)→ 走 proposal 审批。
 *
 * 实现注记:用 `git ls-files`(无 pathspec,全列)再 filter `.md`,而非 `git ls-files
 * '*.md'`——pathspec 的 `*` 不跨 `/`,会漏掉子目录里的 engram(co-engram 记忆多存子目录,
 * 如 `Agent/co-engram/xxx.md`)。git 输出统一用正斜杠,与 scanForExternalMarkdown 里
 * normalize 后的 relPath 直接对齐。
 *
 * 一次性建内存 Set,loop 内 O(1) 查询(避免逐文件 spawnSync)。
 *
 * @returns 非 git repo / 失败 → 空 Set(调用方据此降级为"全部未 track"→ 全走提案,现状)
 */
export function listTrackedMarkdownFiles(repoPath: string): Set<string> {
  if (!isGitRepo(repoPath)) return new Set();
  try {
    const raw = spawnSyncOutput(repoPath, ["ls-files"]);
    return new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".md")),
    );
  } catch {
    return new Set();
  }
}

/**
 * 把 `private/` 目录从 git index 移除(磁盘文件保留)。
 *
 * `private/` 已加入 DEFAULT_CO_ENGRAM_GITIGNORE,新文件自动跳过;
 * 但历史 commit 已 track 的 `private/*.md` 仍会被 commit,需显式 untrack。
 *
 * **重要副作用(比 `.co-engram/` 更危险):** private engram 是用户私人记忆,
 * commit 描述是"删除这些文件"。协作者 pull 时,他们本地 `private/*.md` 也会被
 * git 删除 —— 而 private 通常**不可再生**(用户的个人凭据/路径/偏好)。
 *
 * 调用方必须:
 * 1. dryRun 预览,明确告知"会从 git 移除 N 个 private 文件";
 * 2. 让用户显式 opt-in(不能默认执行);
 * 3. 提示用户:本机磁盘文件保留,但跨机历史已被抹去。
 *
 * @returns 移除的文件数(0 = 本来就没 track 或失败)。
 */
export function untrackPrivateDir(repoPath: string): number {
  let trackedRaw = "";
  try {
    trackedRaw = execSync("git ls-files private/", {
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
    execSync("git rm -r --cached --quiet private/", {
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
 * 只读检测:`private/` 下已 tracked 的文件数(不修改 index)。
 *
 * 用于 dryRun 预测 + 工具层判断是否需要提示用户 opt-in untrack。
 */
export function countTrackedPrivateDir(repoPath: string): number {
  try {
    const raw = execSync("git ls-files private/", {
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

/**
 * 只读检测:.gitignore 是否已含指定 rule(逐行 trim 后比对)。
 *
 * 与 `appendToGitignore` 的检测逻辑镜像,但不写盘。
 * 用于 dryRun 预测:engram_sync 在只读模式下判断是否需要追加 private/。
 */
export function gitignoreContainsRule(repoPath: string, rule: string): boolean {
  const content = readGitignore(repoPath);
  if (!content) return false;
  return content
    .split(/\r?\n/)
    .some((line) => line.trim() === rule.trim());
}
