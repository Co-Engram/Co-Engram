/**
 * Post-merge git hook installer + runner (spec §7.5).
 *
 * Git 在 `git pull` / `git merge` 完成后会触发 `.git/hooks/post-merge`。
 * 我们利用它跑一次跨文件一致性 check,捕捉 merge driver 看不到的
 * 跨文件状态不一致(spec §7.3)。
 *
 * 设计要点:
 *   1. installer 写一个**幂等**的 shell 脚本,不依赖具体路径
 *   2. 脚本调用 `node <co-engram-cli>` 跑 runCrossFileConsistency
 *   3. 失败/缺失不影响 git 操作(exit 0);不一致通过 audit log + stderr 提示
 *   4. CLI 找不到时静默跳过(zero-friction:不影响普通 git pull)
 *
 * @module @co-engram/core/merge
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { findDataRoot } from "./data-root.js";
import { runCrossFileConsistency } from "./cross-file-coordinator.js";
import { EngramRepository } from "../storage/repository.js";
import { AuditLog } from "../observability/audit-log.js";
import { createDriverLlmClient } from "./driver-llm.js";
import { LlmArbiter } from "./llm-arbiter.js";
import type { Language } from "../i18n/types.js";

/** Marker 让我们识别已安装的 hook(避免覆盖用户自定义 hook)。 */
export const HOOK_MARKER = "# co-engram-post-merge-hook";

/** Hook 在仓库中的相对路径(相对于 repoRoot)。 */
export const HOOK_RELATIVE_PATH = ".git/hooks/post-merge";

/**
 * 模板 shell 脚本。
 *
 * 策略:
 *   1. 找到 co-engram CLI(尝试 PATH 中的 `co-engram`,然后 `npx co-engram`)
 *   2. 跑 `co-engram post-merge --cwd <cwd>`
 *   3. 任何错误都 exit 0(绝不阻塞 git)
 *
 * 注:模板里用 `${CO_ENGRAM_CLI}` 占位,installer 写入时替换。
 */
const HOOK_TEMPLATE = `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by @co-engram/core. Runs cross-file consistency check.
# Safe to remove. Will NOT be re-installed unless you run install again.

# 找 co-engram CLI:PATH 优先,fallback 到 npx
CO_ENGRAM_CLI=""
if command -v co-engram >/dev/null 2>&1; then
  CO_ENGRAM_CLI="co-engram"
elif command -v npx >/dev/null 2>&1; then
  CO_ENGRAM_CLI="npx --no-install co-engram"
fi

# CLI 不可用 → 静默退出(不阻塞 git,不刷屏)
if [ -z "$CO_ENGRAM_CLI" ]; then
  exit 0
fi

# 跑 post-merge check(任何错误都吞掉,只 stderr 提示)
"$CO_ENGRAM_CLI" post-merge --cwd "$(pwd)" 2>&1 | sed 's/^/[co-engram] /' >&2 || true
exit 0
`;

export interface InstallPostMergeHookResult {
  /** Hook 写入的绝对路径。 */
  readonly hookPath: string;
  /** True = 本次新建;False = 已存在且被覆盖(用户上次手改过或重装)。 */
  readonly overwritten: boolean;
}

/**
 * 在 repoRoot 中安装 `.git/hooks/post-merge` 钩子。
 *
 * 行为:
 *   - .git/hooks 目录不存在 → 创建
 *   - hook 不存在 → 写入
 *   - hook 存在且包含 HOOK_MARKER → 覆盖(平滑升级)
 *   - hook 存在但不含 HOOK_MARKER → **不覆盖**,把新内容写到 `.post-merge.co-engram`,
 *     并提示用户手动合并(保护用户的自定义 hook)
 */
export function installPostMergeHook(params: {
  repoRoot: string;
}): InstallPostMergeHookResult {
  const { repoRoot } = params;
  const hookPath = join(repoRoot, HOOK_RELATIVE_PATH);
  const hookDir = dirname(hookPath);

  if (!existsSync(hookDir)) {
    mkdirSync(hookDir, { recursive: true });
  }

  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;

  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    // 用户已有自定义 hook — 旁挂一份,不动原 hook
    const sidecarPath = join(hookDir, "post-merge.co-engram");
    writeFileSync(sidecarPath, HOOK_TEMPLATE, { mode: 0o755 });
    return { hookPath: sidecarPath, overwritten: false };
  }

  writeFileSync(hookPath, HOOK_TEMPLATE, { mode: 0o755 });
  return { hookPath, overwritten: existing !== null };
}

/**
 * 卸载 post-merge hook(仅当我们安装的)。
 *
 * 如果 hook 不含 HOOK_MARKER,不操作(用户自定义)。
 */
export function uninstallPostMergeHook(params: { repoRoot: string }): {
  removed: boolean;
} {
  const { repoRoot } = params;
  const hookPath = join(repoRoot, HOOK_RELATIVE_PATH);
  if (!existsSync(hookPath)) return { removed: false };
  const content = readFileSync(hookPath, "utf8");
  if (!content.includes(HOOK_MARKER)) return { removed: false };
  try {
    execSync(`rm -f ${JSON.stringify(hookPath)}`);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

export interface PostMergeHookStatus {
  readonly installed: boolean;
  /** True = 主 hook 是我们的;False = 主 hook 是用户的,但有 sidecar。 */
  readonly atPrimaryPath: boolean;
  readonly hookPath: string;
}

/** 检查 post-merge hook 是否已安装。 */
export function getPostMergeHookStatus(params: {
  repoRoot: string;
}): PostMergeHookStatus {
  const { repoRoot } = params;
  const hookPath = join(repoRoot, HOOK_RELATIVE_PATH);
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, "utf8");
    if (content.includes(HOOK_MARKER)) {
      return { installed: true, atPrimaryPath: true, hookPath };
    }
  }
  const sidecar = join(dirname(hookPath), "post-merge.co-engram");
  if (existsSync(sidecar)) {
    return { installed: true, atPrimaryPath: false, hookPath: sidecar };
  }
  return { installed: false, atPrimaryPath: false, hookPath };
}

// ============================================================
// Runner — `co-engram post-merge` CLI 入口
// ============================================================

export interface PostMergeRunResult {
  readonly dataRoot: string | null;
  readonly inconsistencies: number;
  readonly autoFixed: number;
  readonly escalated: number;
  readonly durationMs: number;
  /** 数据根未找到 / repository 构建失败等错误。 */
  readonly error?: string;
}

/**
 * Post-merge runner:发现数据根 → 构建 repository → 跑 cross-file check。
 *
 * 设计为 CLI 友好:失败不抛(写 error 字段),返回值有结构化结果。
 * 调用方(CLI)负责把它格式化成 stdout/stderr 文本。
 */
export async function runPostMergeCheck(params: {
  cwd: string;
}): Promise<PostMergeRunResult> {
  const { cwd } = params;
  const dataRoot = findDataRoot(resolve(cwd));
  if (!dataRoot) {
    return {
      dataRoot: null,
      inconsistencies: 0,
      autoFixed: 0,
      escalated: 0,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  let repo: EngramRepository;
  try {
    repo = new EngramRepository({
      rootPath: dataRoot,
      language: detectLanguage(dataRoot),
    });
  } catch (e) {
    return {
      dataRoot,
      inconsistencies: 0,
      autoFixed: 0,
      escalated: 0,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const auditLog = new AuditLog(dataRoot);

  // ─── 索引重建(spec §7.5 关键补丁)──────────────────────────────────
  // git pull 拉到的 .md 不进入 engram-index.json → "engram_search 找不到"
  // fail-silent。post-merge 是补全索引的最佳时机:此时工作区已稳定,
  // 拉到的 .md 全部在磁盘上。runDoctor({ incremental: true }) 增量扫描,
  // 把新文件纳入索引 + 清理孤儿 entry + 修复 frontmatter,完成"git pull →
  // 索引同步"的最后一公里。失败不阻塞后续 cross-file check(各 try/catch 独立)。
  let doctorAutoFixed = 0;
  try {
    const doctorReport = repo.runDoctor({ incremental: true });
    doctorAutoFixed = doctorReport.fixes.length;
  } catch {
    // doctor 失败不阻塞 cross-file check,记 0 即可
  }

  // 复用 driver 的 LLM bootstrap(可选)
  const llmBootstrap = createDriverLlmClient();
  const llmArbiter = llmBootstrap
    ? new LlmArbiter({
        client: llmBootstrap.client,
        auditLog,
        providerName: llmBootstrap.config.model,
      })
    : undefined;

  try {
    const report = await runCrossFileConsistency({
      repository: repo,
      auditLog,
      llmArbiter,
    });
    return {
      dataRoot,
      inconsistencies: report.inconsistencies.length,
      autoFixed: report.autoFixedCount + doctorAutoFixed,
      escalated: report.llmEscalatedCount,
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      dataRoot,
      inconsistencies: 0,
      autoFixed: doctorAutoFixed,
      escalated: 0,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 从数据根探测语言。读 `.co-engram/config.json`,失败默认 'en'。
 */
function detectLanguage(dataRoot: string): Language {
  try {
    const configPath = join(dataRoot, ".co-engram", "config.json");
    if (!existsSync(configPath)) return "en";
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      language?: Language;
    };
    return config.language ?? "en";
  } catch {
    return "en";
  }
}
