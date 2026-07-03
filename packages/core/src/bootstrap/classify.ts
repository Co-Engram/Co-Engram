/**
 * dataRoot 路径分类与切换逻辑(CLI + viewer UI 共享)
 *
 * 从 `@co-engram/claude-code/cli.ts` 提取,让 viewer 的 PUT /api/config 也能安全地
 * 修改 dataRoot。两入口共享同一份验证 + 初始化 + 写 bootstrap 逻辑,保证行为一致。
 *
 * @module @co-engram/core/bootstrap
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { writeTeamMemoryConfig } from "../config/index.js";
import { detectGitAuthor } from "../host/detect-git-author.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";

import { writeBootstrapDataRoot } from "./index.js";

/** 目标路径分类结果 */
export type TargetPathClassification =
  | "missing"
  | "empty"
  | "engram-warehouse"
  | "non-engram";

/**
 * 探测目标路径状态,返回分类结果
 *
 * 分类:
 *   - 'missing':路径不存在
 *   - 'empty':存在但完全空(可立即接管)
 *   - 'engram-warehouse':已是 co-engram 仓库(有 .co-engram/config.json)
 *   - 'non-engram':有其他文件,可能是用户用作他途
 */
export function classifyTargetPath(
  targetPath: string,
): TargetPathClassification {
  if (!existsSync(targetPath)) return "missing";
  let entries: readonly string[];
  try {
    entries = readdirSync(targetPath);
  } catch {
    return "non-engram";
  }
  if (entries.length === 0) return "empty";
  const hasCoEngramConfig = existsSync(
    resolve(targetPath, ".co-engram", "config.json"),
  );
  if (hasCoEngramConfig) return "engram-warehouse";
  return "non-engram";
}

/**
 * 初始化一个空的 team-memory 目录(创建 .co-engram/config.json)
 *
 * 用于首次切换到新 dataRoot 时。失败抛错。
 */
export async function initializeEmptyWarehouse(
  targetPath: string,
  options: { readonly createdBy?: string; readonly language?: Language } = {},
): Promise<void> {
  const createdBy =
    options.createdBy ??
    detectGitAuthor() ??
    process.env.USER ??
    "unknown";
  const language = options.language ?? DEFAULT_LANGUAGE;
  mkdirSync(resolve(targetPath, ".co-engram"), { recursive: true });
  await writeTeamMemoryConfig(targetPath, {
    version: 1,
    language,
    defaultCreatedBy: createdBy,
    createdAt: new Date().toISOString(),
    initializedBy: "co-engram-cli",
  });
}

/** applyDataRootChange 成功结果 */
export interface ApplyDataRootSuccessResult {
  readonly ok: true;
  readonly dataRoot: string;
  readonly classification: TargetPathClassification;
  readonly initialized: boolean;
}

/** applyDataRootChange 失败结果 */
export interface ApplyDataRootFailureResult {
  readonly ok: false;
  readonly error: string;
  readonly reason: "non-engram" | "invalid" | "init-failed";
  /**
   * non-engram 失败时附带:目标目录里现有的文件/子目录名(最多 10 个)+ 总数。
   * UI 用它给用户展示"将接管此目录,你的这些文件不会被改动",让用户二次确认。
   */
  readonly existingFiles?: readonly string[];
  readonly existingCount?: number;
}

/** applyDataRootChange 结果 */
export type ApplyDataRootResult =
  | ApplyDataRootSuccessResult
  | ApplyDataRootFailureResult;

/**
 * 应用 dataRoot 变更:验证 + 初始化(若需) + 写 bootstrap config
 *
 * 用于 CLI `co-engram config data-root <path>` 和 viewer PUT /api/config。
 *
 * 行为:
 *   - 'missing' / 'empty':mkdir + initializeEmptyWarehouse + writeBootstrap
 *   - 'engram-warehouse':直接 writeBootstrap(不重新初始化,保留已有数据)
 *   - 'non-engram' + force=true:mkdir + initializeEmptyWarehouse + writeBootstrap
 *   - 'non-engram' + force=false:拒绝,返回 reason='non-engram'
 *
 * @param rawPath 用户输入的路径(相对或绝对)
 * @param opts.force 是否强制接管非空非 co-engram 目录(UI 默认 false,CLI 支持 --force)
 * @param opts.createdBy 可选,初始化空 warehouse 时的 defaultCreatedBy
 * @param opts.language 可选,初始化空 warehouse 时的 language
 */
export async function applyDataRootChange(
  rawPath: string,
  options: { readonly force?: boolean; readonly createdBy?: string; readonly language?: Language } = {},
): Promise<ApplyDataRootResult> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "Path is empty", reason: "invalid" };
  }
  const newPath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
  const classification = classifyTargetPath(newPath);

  if (classification === "non-engram" && !options.force) {
    // 收集目录里现有的文件/子目录名(最多 10 个),让 UI 展示给用户。
    // co-engram 接管时只在目录里创建 .co-engram/ 子目录,不会触碰这些文件;
    // 但仍需让用户清楚地"看到自己在接管什么",二次确认后再 force=true 重发。
    let existingFiles: string[] = [];
    let existingCount = 0;
    try {
      const all = readdirSync(newPath);
      existingCount = all.length;
      existingFiles = all.slice(0, 10);
    } catch {
      // 读失败就空数组返回,UI 仍可继续(基于 reason 给出二次确认)
    }
    return {
      ok: false,
      error: `Directory ${newPath} exists but is not a co-engram warehouse (no .co-engram/config.json). It may contain unrelated user data. Use --force (CLI) to take over.`,
      reason: "non-engram",
      existingFiles,
      existingCount,
    };
  }

  let initialized = false;
  if (
    classification === "missing" ||
    classification === "empty" ||
    classification === "non-engram"
  ) {
    mkdirSync(newPath, { recursive: true });
    try {
      await initializeEmptyWarehouse(newPath, {
        ...(options.createdBy ? { createdBy: options.createdBy } : {}),
        ...(options.language ? { language: options.language } : {}),
      });
      initialized = true;
    } catch (err) {
      return {
        ok: false,
        error: `Failed to initialize warehouse: ${err instanceof Error ? err.message : String(err)}`,
        reason: "init-failed",
      };
    }
  }

  await writeBootstrapDataRoot(newPath);

  return {
    ok: true,
    dataRoot: newPath,
    classification,
    initialized,
  };
}
