/**
 * 仓库同步工具集
 *
 *   - engram_sync   手动触发 pull → commit → push(赋予用户掌控感)
 *
 * 设计要点:
 *   - 用户主动触发,与系统自动 markDirty 区分
 *   - 流程编排严格按"先 pull 合并远端 → 再 commit 本地 → 最后 push"
 *   - 不硬编码任何主机/URL/refspec,继承用户 git 环境
 *   - 冲突不自动 resolve,rebase --abort 后清晰报告让用户决策
 *   - dryRun 完全只读(不写 .gitignore,不动 git index),只预测变更
 *
 * @module @co-engram/core/tools
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";
import {
  commitFiles,
  countTrackedCoEngramCache,
  ensureGitignore,
  getGitStatusShort,
  hasRemote,
  isGitRepo,
  pullRepo,
  pushRepo,
  untrackCoEngramCache,
  type GitPullResult,
  type GitPushResult,
} from "../storage/git.js";

// ============================================================
// engram_sync
// ============================================================

export const EngramSyncInputSchema = z
  .object({
    message: z
      .string()
      .optional()
      .describe(
        "Custom commit message. If omitted, auto-generates `co-engram sync: YYYY-MM-DD`.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Preview-only: return what would be committed, do not pull/commit/push. Default false.",
      ),
    pull: z
      .boolean()
      .optional()
      .describe(
        "Pull with --rebase before committing. Default true. Set false to commit against current HEAD only.",
      ),
    push: z
      .boolean()
      .optional()
      .describe(
        "Push to remote after committing. Default true. Auto-degrades to commit-only when no remote is configured.",
      ),
    untrackCache: z
      .boolean()
      .optional()
      .describe(
        "If .co-engram/ files are already git-tracked (legacy), run `git rm -r --cached .co-engram/` to untrack them in this commit (disk files kept locally). NOTE: teammates who pull this commit will see git delete those files on their disk too. Default false — opt-in. dryRun reports the tracked count regardless.",
      ),
  })
  .strict();

export type EngramSyncToolInput = z.infer<typeof EngramSyncInputSchema>;

/** pull 阶段结果(对齐 GitPullResult,增加 skipped 标记) */
export interface SyncPullPhase {
  readonly ok: boolean;
  /** 是否被跳过(pull=false 时) */
  readonly skipped: boolean;
  readonly upToDate?: boolean;
  readonly fetchedCount?: number;
  readonly conflicts?: readonly string[];
}

/** commit 阶段结果 */
export interface SyncCommitPhase {
  readonly ok: boolean;
  /** 无变更时为 true(已跳过 commit) */
  readonly nothingToCommit?: boolean;
  readonly sha?: string;
  readonly branch?: string;
  readonly filesChanged: number;
  readonly message: string;
}

/** push 阶段结果 */
export interface SyncPushPhase {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly reason?: string;
  readonly remote?: string;
  /** 实际生效的 push 模式;fallback 成功时为 "gerrit-review" */
  readonly mode?: "direct" | "gerrit-review";
  /** 仅在 direct 拒绝后自动 fallback 到 gerrit-review 成功时为 true */
  readonly autoFallback?: true;
}

export interface EngramSyncResult {
  /**
   * 整体成功/失败机器判断位。
   *
   * pull 失败或 push 失败(非 skipped)→ false;push skipped(无 remote / push=false)
   * 视为预期降级,不影响 ok。让 host adapter 据此决定是否给用户追加高亮提示,
   * 不必解析 summary 字符串。
   */
  readonly ok: boolean;
  /** 仓库绝对路径(=dataRoot) */
  readonly repoPath: string;
  /** 本次是否新建了 .gitignore(dryRun 时为 false,只预测) */
  readonly gitignoreCreated: boolean;
  /** 本次是否把 .co-engram/ 从 git index 移除(磁盘保留) */
  readonly cacheUntracked: boolean;
  /** 当前 .co-engram/ 下已被 git track 的文件数(用于让用户判断是否需要 untrackCache) */
  readonly trackedCacheCount: number;
  /** dryRun=true 时的变更预览(相对仓库根路径) */
  readonly changedFiles?: readonly string[];
  readonly pulled?: SyncPullPhase;
  readonly committed?: SyncCommitPhase;
  readonly pushed?: SyncPushPhase;
  /** 整体结论摘要(给 LLM 用的自然语言一句话) */
  readonly summary: string;
}

/**
 * 生成默认 commit 信息: `co-engram sync: YYYY-MM-DD`
 *
 * 用本地日期(非 UTC),匹配用户主观"今天"概念。
 */
function defaultCommitMessage(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `co-engram sync: ${yyyy}-${mm}-${dd}`;
}

export const engramSyncTool: Tool<EngramSyncToolInput, EngramSyncResult> = {
  name: "engram_sync",
  description:
    "Manually trigger a full memory sync: pull (rebase) → commit → push. Gives the user explicit control over when memories are persisted to the remote, as opposed to the automatic dirty-marking that just flags the repo as changed. Auto-creates a .gitignore excluding the .co-engram/ cache directory if missing. Handles conflicts by aborting the rebase and reporting conflict files for manual resolution. Degrades to commit-only when no remote is configured. Compatible with any git host (GitHub / GitLab / Gerrit / internal) — does not hardcode URLs, Change-Id, or push refspecs.",
  inputSchema: EngramSyncInputSchema,
  execute(input, ctx) {
    const parsed = validateInput<EngramSyncToolInput>(
      EngramSyncInputSchema,
      input,
    );

    const repoPath = resolveRepoPathFromContext(ctx);
    if (!isGitRepo(repoPath)) {
      throw new Error(
        `engram_sync requires a git repo. dataRoot is not a git repository: ${repoPath}. Initialize with: cd ${repoPath} && git init && git remote add origin <url>`,
      );
    }

    const pull = parsed.pull !== false;
    const push = parsed.push !== false;
    const dryRun = parsed.dryRun === true;
    const untrackCacheRequested = parsed.untrackCache === true;

    // 只读检测:已有 .gitignore?已 tracked 缓存数?
    const gitignoreExists = existsSync(join(repoPath, ".gitignore"));
    const trackedCacheCount = countTrackedCoEngramCache(repoPath);

    // 1. dryRun:完全只读 —— 不创建 .gitignore、不动 git index
    //    只预测 effective changedFiles:
    //      - 若 untrackCacheRequested=true,模拟 .co-engram/ 退出跟踪 →
    //        从 changedFiles 排除 .co-engram/(因为它们会变成 staged delete,
    //        但不会作为"新内容"出现在 commit 里,只是退出 tracking)
    //      - 否则按当前 git status 报告
    if (dryRun) {
      const allFiles = getGitStatusShort(repoPath);
      const effectiveFiles = untrackCacheRequested
        ? allFiles.filter((f) => !f.startsWith(".co-engram/"))
        : allFiles;
      const wouldCreateGitignore = !gitignoreExists;
      const summary = buildDryRunSummary({
        effectiveCount: effectiveFiles.length,
        pull,
        push,
        wouldCreateGitignore,
        trackedCacheCount,
        untrackCacheRequested,
      });
      return {
        ok: true,
        repoPath,
        gitignoreCreated: false,
        cacheUntracked: false,
        trackedCacheCount,
        changedFiles: effectiveFiles,
        summary,
      };
    }

    // 2. 非 dryRun:执行 .gitignore + 可选 untrack
    const gitignoreCreated = ensureGitignore(repoPath);
    let cacheUntracked = false;
    if (untrackCacheRequested) {
      const removed = untrackCoEngramCache(repoPath);
      cacheUntracked = removed > 0;
    }

    // 3. pull 阶段(--rebase,autostash;冲突时 abort 并报告)
    let pulled: SyncPullPhase | undefined;
    if (pull) {
      const r: GitPullResult = pullRepo(repoPath);
      pulled = {
        ok: r.ok,
        skipped: false,
        ...(r.upToDate !== undefined ? { upToDate: r.upToDate } : {}),
        ...(r.fetchedCount !== undefined
          ? { fetchedCount: r.fetchedCount }
          : {}),
        ...(r.conflicts !== undefined ? { conflicts: r.conflicts } : {}),
      };
      if (!r.ok && r.conflicts) {
        const fileList = r.conflicts.join(", ");
        return {
          ok: false,
          repoPath,
          gitignoreCreated,
          cacheUntracked,
          trackedCacheCount,
          pulled,
          summary: `pull failed: ${r.conflicts.length} conflict(s) after rebase — ${fileList}. Rebase auto-aborted. Resolve manually and rerun engram_sync.`,
        };
      }
    } else {
      pulled = { ok: true, skipped: true };
    }

    // 4. commit 阶段(git add -A + commit;无变更跳过)
    const message = parsed.message?.trim() || defaultCommitMessage();
    const commitResult = commitFiles({
      repoPath,
      files: [],
      message,
    });
    const committed: SyncCommitPhase = {
      ok: true,
      filesChanged: commitResult.filesChanged,
      message,
      ...(commitResult.commitHash
        ? { sha: commitResult.commitHash, branch: commitResult.branch }
        : { nothingToCommit: true }),
    };

    // 5. push 阶段(无 remote 自动降级为 skipped,不报错)
    let pushed: SyncPushPhase | undefined;
    if (push) {
      if (!hasRemote(repoPath)) {
        pushed = {
          ok: true,
          skipped: true,
          reason: "no remote configured (commit only)",
        };
      } else {
        const r: GitPushResult = pushRepo(repoPath);
        pushed = toSyncPushPhase(r);
      }
    } else {
      pushed = { ok: true, skipped: true, reason: "push disabled by caller" };
    }

    return {
      ok: computeOverallOk(pulled, pushed),
      repoPath,
      gitignoreCreated,
      cacheUntracked,
      trackedCacheCount,
      pulled,
      committed,
      pushed,
      summary: buildSummary(pulled, committed, pushed, {
        cacheUntracked,
        trackedCacheCount,
      }),
    };
  },
};

function toSyncPushPhase(r: GitPushResult): SyncPushPhase {
  return {
    ok: r.ok,
    skipped: r.skipped,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.remote !== undefined ? { remote: r.remote } : {}),
    ...(r.mode !== undefined ? { mode: r.mode } : {}),
    ...(r.autoFallback === true ? { autoFallback: true } : {}),
  };
}

/**
 * 从 ToolContext 解析仓库根路径。
 *
 * repository.config.rootPath 是 dataRoot 的权威来源(host 注入时已规范化)。
 */
function resolveRepoPathFromContext(ctx: ToolContext): string {
  const repo = ctx.repository as unknown as {
    readonly config: { readonly rootPath: string };
  };
  return repo.config.rootPath;
}

function buildDryRunSummary(opts: {
  readonly effectiveCount: number;
  readonly pull: boolean;
  readonly push: boolean;
  readonly wouldCreateGitignore: boolean;
  readonly trackedCacheCount: number;
  readonly untrackCacheRequested: boolean;
}): string {
  const parts: string[] = [];
  parts.push(
    `dry-run: ${opts.effectiveCount} file(s) would be committed (pull=${opts.pull}, push=${opts.push})`,
  );
  if (opts.wouldCreateGitignore) {
    parts.push(".gitignore would be created (excludes .co-engram/)");
  }
  if (opts.trackedCacheCount > 0) {
    if (opts.untrackCacheRequested) {
      parts.push(
        `${opts.trackedCacheCount} .co-engram/* file(s) would be untracked in this commit (teammates pulling will see git delete these on their disk)`,
      );
    } else {
      parts.push(
        `WARNING: ${opts.trackedCacheCount} .co-engram/* file(s) already tracked — they will be committed unless you pass untrackCache=true (consider implications for teammates)`,
      );
    }
  }
  return parts.join("; ") + ".";
}

function buildSummary(
  pulled: SyncPullPhase | undefined,
  committed: SyncCommitPhase | undefined,
  pushed: SyncPushPhase | undefined,
  opts: { readonly cacheUntracked: boolean; readonly trackedCacheCount: number },
): string {
  const parts: string[] = [];
  const pushFailed = pushed !== undefined && !pushed.skipped && !pushed.ok;

  // push 失败时提到最前,避免被前面的"成功"段掩盖(partial-success masking):
  // 挑剔用户看漏末尾的 push failed 会以为整体成功。
  if (pushFailed) {
    parts.push(`push failed: ${pushed!.reason ?? "unknown"}`);
    parts.push(
      `local commit ${committed?.sha?.slice(0, 8) ?? "?"} saved — manual push or gerrit review (refs/for/<branch>) required`,
    );
  }

  if (opts.cacheUntracked) {
    parts.push(
      `untracked ${opts.trackedCacheCount} .co-engram/* file(s) (teammates pulling will see git delete these on disk)`,
    );
  }
  if (pulled) {
    if (pulled.skipped) {
      parts.push("pull skipped");
    } else if (pulled.upToDate) {
      parts.push("already up-to-date with remote");
    } else if (!pulled.ok) {
      parts.push(`pull failed (${pulled.conflicts?.length ?? 0} conflicts)`);
    } else {
      parts.push(`pulled ${pulled.fetchedCount ?? 0} commit(s) via rebase`);
    }
  }
  if (committed) {
    if (committed.nothingToCommit) {
      parts.push("nothing to commit");
    } else {
      parts.push(
        `committed ${committed.filesChanged} file(s) as ${committed.sha?.slice(0, 8) ?? "?"}`,
      );
    }
  }
  if (pushed && !pushFailed) {
    if (pushed.skipped) {
      parts.push(`push skipped (${pushed.reason ?? "unknown"})`);
    } else if (pushed.autoFallback) {
      parts.push(
        `pushed via gerrit-review (refs/for/<branch>, auto-fallback) to ${pushed.remote ?? "origin"}`,
      );
    } else {
      parts.push(`pushed to ${pushed.remote ?? "origin"}`);
    }
  }
  return parts.join("; ") + ".";
}

/**
 * 整体成功/失败判定:pull 失败或 push 失败(非 skipped)→ false。
 *
 * push skipped 是预期降级(无 remote / push=false),不算失败。
 * committed 阶段现状总是 ok=true(无变更时 nothingToCommit 但 ok 仍 true),不影响判定。
 */
function computeOverallOk(
  pulled: SyncPullPhase | undefined,
  pushed: SyncPushPhase | undefined,
): boolean {
  if (pulled && !pulled.ok) return false;
  if (pushed && !pushed.ok && !pushed.skipped) return false;
  return true;
}

// ============================================================
// 注册
// ============================================================

export const ALL_SYNC_TOOLS: readonly Tool[] = [engramSyncTool];
