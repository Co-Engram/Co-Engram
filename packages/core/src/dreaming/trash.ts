/**
 * 记忆回收站（Trash Sweep）
 *
 * 神经科学类比：遗忘不等于物理销毁——已被"遗忘"的突触在一段时间内仍可被找回。
 * 此模块把"已 forgotten 超过 N 天"的 engram 从主索引物理移动到 `.trash/YYYY-MM/`，
 * 既给了恢复窗口,又降低了 FTS / 图遍历对陈旧数据的扫描成本。
 *
 * 设计约束：
 *   - 文件系统操作：rename / mkdir。优先 git mv（若仓库为 git 仓库）,否则退化为 fs.rename。
 *   - 不动 synapse 引用：允许 dangling（其他 engram 仍可能指向被回收的 id）。
 *     这是有意的：未来若 restore,引用自动恢复有效。
 *   - purge（物理删除）独立阶段,默认 365 天后才删,且需要显式开启。
 *   - engram 是单文件 (.md),移动一个文件即可;同时更新 engram-index.json
 *     以保证主索引不再列出已回收的条目。
 *
 * 时间戳策略：
 *   使用 engram 文件的 mtime 作为"最后被触碰时刻"的近似。
 *   原因：forgotten 状态切换走 `updateLifecycle`,不写 updatedAt；mtime 是最接近真相的信号。
 *   已知缺陷：任何对文件的写入都会刷新 mtime。对 forgotten engram 来说,这种写入很少发生,
 *   所以近似在 90%+ 场景下是准确的。后续如需精确,可加 `forgottenAt` 字段。
 *
 * @module @co-engram/core/dreaming
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import { isGitRepo } from "../storage/git.js";
import { readEngramFile } from "../storage/engram-store.js";
import { slugify } from "../types/slugify.js";
import type { AuditLog } from "../observability/audit-log.js";

/** Trash 配置 */
export interface TrashOptions {
  /** 当前时间（测试用）,默认 new Date() */
  readonly nowIso?: string;
  /** forgotten 后多少天才进入回收站（默认 30 天） */
  readonly afterDays?: number;
  /** 回收站中多少天后物理删除（默认 365 天）;0 或负数表示永不删除 */
  readonly purgeAfterDays?: number;
  /** 只读模式：只计算不落盘 */
  readonly dryRun?: boolean;
  /** 可选审计日志：sweep/restore/purge 时自动记录 */
  readonly auditLog?: AuditLog;
}

/** 单次 sweep 结果 */
export interface TrashSweepResult {
  /** 扫描的 forgotten engram 数 */
  readonly scanned: number;
  /** 已移入回收站的 id 列表 */
  readonly trashed: string[];
  /** 已从回收站物理删除的 id 列表（purge 阶段） */
  readonly purged: string[];
  /** 跳过的 id → 原因 */
  readonly skipped: Array<{ id: string; reason: string }>;
}

/** Trash 根目录名（相对仓库根） */
export const TRASH_DIR_NAME = ".trash";

/** 默认进入回收站阈值：forgotten 后 30 天 */
export const DEFAULT_TRASH_AFTER_DAYS = 30;

/** 默认物理删除阈值：进入回收站后 365 天 */
export const DEFAULT_TRASH_PURGE_AFTER_DAYS = 365;

/**
 * 计算某个月份分区名（YYYY-MM）
 *
 * 使用 UTC 以避免本地时区在跨日边界的不一致。
 */
export function formatTrashPartition(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * 计算 engram 在 trash 分区下的相对路径
 *
 * 输入：原 engram 相对路径（如 "testing/adb/foo.md"）,分区名 "2026-06"
 * 输出：".trash/2026-06/testing/adb/foo.md"
 *
 * 注：trash 下不再分 content/meta/synapses 子目录（单文件布局）。
 */
export function deriveTrashFilePath(
  relativePath: string,
  partition: string,
): string {
  return `${TRASH_DIR_NAME}/${partition}/${relativePath}`;
}

/** 旧版三路径 API（兼容调用方/测试）：派生 trash 下的镜像路径 */
export function deriveTrashFilePaths(
  relativePath: string,
  partition: string,
): { content: string; meta: string; synapses: string } {
  const base = `${TRASH_DIR_NAME}/${partition}`;
  const fileBase = relativePath.replace(/\.md$/, "");
  return {
    content: `${base}/engrams/content/${fileBase}.md`,
    meta: `${base}/engrams/meta/${fileBase}.yaml`,
    synapses: `${base}/engrams/synapses/${fileBase}.yaml`,
  };
}

/**
 * 执行 trash sweep
 *
 * 流程：
 *   1. 扫描所有 engram,过滤出 status=forgotten
 *   2. 对每个 forgotten engram,读文件 mtime,判断是否 ≥ afterDays
 *   3. 满足条件 → 计算分区（按当前时间）→ 移动单文件到 .trash/<partition>/<relativePath>
 *   4. （可选）扫描 .trash/ 中已存在且 ≥ purgeAfterDays 的分区,物理删除
 *
 * 安全保证：
 *   - 目标路径已存在时跳过（避免覆盖）
 *   - 移动失败时记录到 skipped,不抛
 */
export function sweepToTrash(
  repo: EngramRepository,
  options: TrashOptions = {},
): TrashSweepResult {
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const afterDays = options.afterDays ?? DEFAULT_TRASH_AFTER_DAYS;
  const purgeAfterDays =
    options.purgeAfterDays ?? DEFAULT_TRASH_PURGE_AFTER_DAYS;
  const dryRun = options.dryRun ?? false;

  const thresholdMs = afterDays * 24 * 60 * 60 * 1000;
  const purgeMs =
    purgeAfterDays > 0
      ? purgeAfterDays * 24 * 60 * 60 * 1000
      : Number.POSITIVE_INFINITY;

  const trashed: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let scanned = 0;

  // === 阶段 1: forgotten → trash ===
  const entries = [...repo.listEngramIndex()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  // 批量预取 digest(只需要 status 字段做过滤)
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );

  for (const entry of entries) {
    const digest = digestById.get(entry.id);
    if (!digest) continue;
    if (digest.status !== "forgotten") continue;
    scanned += 1;

    const fileAbs = join(repo.rootPath, entry.path);
    if (!existsSync(fileAbs)) {
      skipped.push({ id: digest.id, reason: "engram file missing" });
      continue;
    }

    const mtime = statSync(fileAbs).mtimeMs;
    const ageMs = now.getTime() - mtime;
    if (ageMs < thresholdMs) {
      skipped.push({
        id: digest.id,
        reason: `only ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days old (< ${afterDays})`,
      });
      continue;
    }

    if (!dryRun) {
      const moved = moveEngramFileToTrash(
        repo,
        digest.id,
        entry.path,
        formatTrashPartition(now),
      );
      if (!moved.ok) {
        skipped.push({ id: digest.id, reason: moved.reason });
        continue;
      }
    }
    trashed.push(digest.id);
    options.auditLog?.append({
      actor: "system",
      action: "sweep_to_trash",
      engramId: digest.id,
      metadata: { partition: formatTrashPartition(now) },
    });
  }

  // === 阶段 2: purge expired trash ===
  const purged = dryRun
    ? []
    : purgeExpiredTrash(repo, now, purgeMs, options.auditLog);

  return { scanned, trashed, purged, skipped };
}

/** 内部：物理移动单个 engram 文件到 trash 分区 */
function moveEngramFileToTrash(
  repo: EngramRepository,
  engramId: string,
  relativePath: string,
  partition: string,
): { ok: true } | { ok: false; reason: string } {
  const srcRel = relativePath;
  const dstRel = deriveTrashFilePath(srcRel, partition);
  const srcAbs = join(repo.rootPath, srcRel);
  const dstAbs = join(repo.rootPath, dstRel);

  if (!existsSync(srcAbs)) {
    return { ok: false, reason: `source missing: ${srcRel}` };
  }
  if (existsSync(dstAbs)) {
    return { ok: false, reason: `destination exists: ${dstRel}` };
  }

  mkdirSync(dirname(dstAbs), { recursive: true });

  const useGit = isGitRepo(repo.rootPath);
  try {
    if (useGit) {
      try {
        execSync(`git mv "${srcRel}" "${dstRel}"`, {
          cwd: repo.rootPath,
          stdio: "ignore",
        });
      } catch {
        renameSync(srcAbs, dstAbs);
      }
    } else {
      renameSync(srcAbs, dstAbs);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // 移除 engram-index 中的条目（保证主索引不再列出已回收的 id）
  repo.deleteEngram(engramId);
  // deleteEngram 也会尝试删文件——但文件已被移走,所以是 no-op;主要靠它清理 index + dangling synapses
  return { ok: true };
}

/**
 * 扫描 .trash/,删除超过 purgeMs 的分区
 *
 * 粗粒度策略：以"分区（月份）"为单位删除,而非单文件。
 * 好处：单次操作 O(月份数),避免遍历每个文件 mtime。
 * 缺点：可能删除略早于阈值的文件（最多 31 天误差）。
 */
function purgeExpiredTrash(
  repo: EngramRepository,
  now: Date,
  purgeMs: number,
  auditLog?: AuditLog,
): string[] {
  const trashRoot = join(repo.rootPath, TRASH_DIR_NAME);
  if (!existsSync(trashRoot)) return [];

  const purged: string[] = [];
  const partitions = readdirSync(trashRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();

  for (const partition of partitions) {
    const partPath = join(trashRoot, partition);
    const partMtime = statSync(partPath).mtimeMs;
    const ageMs = now.getTime() - partMtime;
    if (ageMs < purgeMs) continue;

    const engramIds = collectEngramIdsInPartition(partPath);
    purged.push(...engramIds);

    rmSync(partPath, { recursive: true, force: true });

    for (const id of engramIds) {
      auditLog?.append({
        actor: "system",
        action: "purge",
        engramId: id,
        metadata: { partition },
      });
    }
  }

  return purged;
}

/** 扫描分区目录,提取所有 engram id（从 frontmatter 读取,去重） */
function collectEngramIdsInPartition(partitionAbsPath: string): string[] {
  const ids = new Set<string>();

  const walk = (dir: string): void => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile() && item.name.endsWith(".md")) {
        try {
          const parsed = readEngramFile(full);
          if (parsed?.frontmatter?.id) ids.add(parsed.frontmatter.id);
        } catch {
          // 非 engram 文件,跳过
        }
      }
    }
  };
  walk(partitionAbsPath);
  return [...ids].sort();
}

/**
 * 列出 trash 中的所有 engram（跨分区）
 *
 * 用于 restore 工具的"查询接口"和排查。
 */
export interface TrashedEngram {
  /** 原 engram id */
  readonly id: string;
  /** 所在分区（YYYY-MM） */
  readonly partition: string;
  /** 在 trash 中的绝对路径（.md 文件） */
  readonly contentPath: string;
  /** 进入 trash 的时间（分区目录 mtime） */
  readonly trashedAt: string;
}

export function listTrashed(repo: EngramRepository): TrashedEngram[] {
  const trashRoot = join(repo.rootPath, TRASH_DIR_NAME);
  if (!existsSync(trashRoot)) return [];

  const out: TrashedEngram[] = [];
  const partitions = readdirSync(trashRoot, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name),
  );

  for (const part of partitions) {
    const partPath = join(trashRoot, part.name);
    const partMtime = statSync(partPath).mtime.toISOString();

    const walk = (dir: string): void => {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
        } else if (item.isFile() && item.name.endsWith(".md")) {
          try {
            const parsed = readEngramFile(full);
            const id = parsed?.frontmatter?.id;
            if (id) {
              out.push({
                id,
                partition: part.name,
                contentPath: full,
                trashedAt: partMtime,
              });
            }
          } catch {
            // skip
          }
        }
      }
    };
    walk(partPath);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * 在 trash 中查找指定 id 的 engram
 */
export function findTrashed(
  repo: EngramRepository,
  engramId: string,
): TrashedEngram | null {
  const all = listTrashed(repo);
  return all.find((t) => t.id === engramId) ?? null;
}

/**
 * 一键清空回收站(永久删除)
 *
 * 与 sweepToTrash 内部的 purgeExpiredTrash 不同,本函数:
 *   - 不按时间过滤,而是清掉所有(或指定 partition)的 trashed engram
 *   - 由用户在 UI 显式触发,审计日志记 actor='user'(非 system)
 *   - 同步审计:每条删除写一条 action='purge' 审计
 *
 * 安全策略:
 *   - dryRun=true 时只计算 purged id,不真正删除
 *   - partition 未传 → 清所有分区
 *   - partition 传入但不存在 → 返回空(不抛)
 *
 * @returns purged id 列表(按字典序)
 */
export function purgeAllTrash(
  repo: EngramRepository,
  options: {
    /** 仅清空指定分区(YYYY-MM);不传则清所有分区 */
    readonly partition?: string;
    /** 只读模式:只返回会删的 id,不真正删除 */
    readonly dryRun?: boolean;
    /** 可选审计日志 */
    readonly auditLog?: AuditLog;
    /** 审计行为者(默认 'user',因为是用户在 UI 触发) */
    readonly actor?: "user" | "llm" | "system";
  } = {},
): { purged: readonly string[]; partitionsRemoved: readonly string[] } {
  const trashRoot = join(repo.rootPath, TRASH_DIR_NAME);
  if (!existsSync(trashRoot)) {
    return { purged: [], partitionsRemoved: [] };
  }

  const targetPartitions = options.partition
    ? [options.partition]
    : readdirSync(trashRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort();

  const actor = options.actor ?? "user";
  const purged: string[] = [];
  const partitionsRemoved: string[] = [];

  for (const partition of targetPartitions) {
    const partPath = join(trashRoot, partition);
    if (!existsSync(partPath)) continue;

    const ids = collectEngramIdsInPartition(partPath);
    purged.push(...ids);

    if (!options.dryRun) {
      rmSync(partPath, { recursive: true, force: true });
      partitionsRemoved.push(partition);

      for (const id of ids) {
        options.auditLog?.append({
          actor,
          action: "purge",
          engramId: id,
          metadata: { partition, source: "purge_all" },
        });
      }
    }
  }

  return {
    purged: [...new Set(purged)].sort(),
    partitionsRemoved: partitionsRemoved.sort(),
  };
}

/**
 * 单条彻底清除:从 trash 中物理删除指定 id 的 engram 文件
 *
 * 与 purgeAllTrash(分区粒度)相对,本函数是单文件粒度,供 viewer
 * 回收站行内「彻底清除」按钮使用。行为:
 *   - 找不到该 id → { ok: false, reason }(调用方决定 404)
 *   - 删除该 .md 文件;若所在分区因此变空,best-effort 清掉空目录
 *   - 审计 action='purge',actor='user',metadata.source='purge_one'
 *   - dryRun=true 只校验存在性,不删
 */
export function purgeTrashed(
  repo: EngramRepository,
  engramId: string,
  options: {
    readonly dryRun?: boolean;
    readonly auditLog?: AuditLog;
    readonly actor?: "user" | "llm" | "system";
  } = {},
): { ok: true; partition: string } | { ok: false; reason: string } {
  const found = findTrashed(repo, engramId);
  if (!found) {
    return { ok: false, reason: `not found in trash: ${engramId}` };
  }
  if (!options.dryRun) {
    try {
      rmSync(found.contentPath, { force: true });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    cleanupEmptyPartition(repo, found.partition);
    options.auditLog?.append({
      actor: options.actor ?? "user",
      action: "purge",
      engramId,
      metadata: { partition: found.partition, source: "purge_one" },
    });
  }
  return { ok: true, partition: found.partition };
}

/**
 * 读取 trash 中某个 engram 的完整内容(供 UI 预览)
 *
 * 返回 frontmatter + body,以及 partition / trashedAt 元信息。
 * 不存在时返回 null(由调用方决定 404)。
 */
export function readTrashed(
  repo: EngramRepository,
  engramId: string,
): {
  readonly id: string;
  readonly partition: string;
  readonly trashedAt: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
  readonly contentPath: string;
} | null {
  const found = findTrashed(repo, engramId);
  if (!found) return null;

  let parsed: { frontmatter: Record<string, unknown>; content: string } | null =
    null;
  try {
    parsed = readEngramFile(found.contentPath) as {
      frontmatter: Record<string, unknown>;
      content: string;
    };
  } catch {
    return null;
  }

  return {
    id: found.id,
    partition: found.partition,
    trashedAt: found.trashedAt,
    frontmatter: parsed.frontmatter,
    content: parsed.content,
    contentPath: found.contentPath,
  };
}

/**
 * 从 trash 恢复 engram：物理移回原位 + status 切回 active
 *
 * 流程：
 *   1. 在 .trash/ 中查找 id（可能跨多个分区）
 *   2. 把单文件移回 <root>/<originalRelativePath>
 *   3. repo.updateLifecycle(id, 'active', 'fresh') 重置检索状态
 *
 * 不抛：找不到返回 { ok: false, reason }。
 */
export function restoreFromTrash(
  repo: EngramRepository,
  engramId: string,
  options: { readonly auditLog?: AuditLog } = {},
): { ok: true } | { ok: false; reason: string } {
  const found = findTrashed(repo, engramId);
  if (!found) {
    return { ok: false, reason: `not found in trash: ${engramId}` };
  }

  // 从 trash 中的 frontmatter 读取原始 domainTags 来推断路径
  let parsed;
  try {
    parsed = readEngramFile(found.contentPath);
  } catch {
    return { ok: false, reason: "cannot parse trashed file" };
  }

  // 目标路径：恢复到 deriveDefaultPath（domainTags + slug）
  const slug = parsed.frontmatter.slug ?? slugify(parsed.frontmatter.title);
  const domains = parsed.frontmatter.domainTags ?? [];
  const dstRel =
    domains.length === 0 ? `${slug}.md` : `${domains.join("/")}/${slug}.md`;
  const srcAbs = found.contentPath;
  const dstAbs = join(repo.rootPath, dstRel);

  if (existsSync(dstAbs)) {
    return { ok: false, reason: `target exists in active area: ${dstRel}` };
  }

  mkdirSync(dirname(dstAbs), { recursive: true });

  const useGit = isGitRepo(repo.rootPath);
  const srcRel = relative(repo.rootPath, srcAbs);
  try {
    if (useGit) {
      try {
        execSync(`git mv "${srcRel}" "${dstRel}"`, {
          cwd: repo.rootPath,
          stdio: "ignore",
        });
      } catch {
        renameSync(srcAbs, dstAbs);
      }
    } else {
      renameSync(srcAbs, dstAbs);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // 触发 index 重建,使主索引重新列出该 engram
  repo.rebuildIndex();

  // 状态重置：forgotten → active;freshness 重新计算由调用方/检索期决定,这里先置 fresh
  repo.updateLifecycle(engramId, "active", "fresh");

  // 清理空分区目录（best-effort,不抛）
  cleanupEmptyPartition(repo, found.partition);

  options.auditLog?.append({
    actor: "system",
    action: "restore_from_trash",
    engramId,
    metadata: { partition: found.partition },
  });

  return { ok: true };
}

/** 清理空分区目录（best-effort） */
function cleanupEmptyPartition(
  repo: EngramRepository,
  partition: string,
): void {
  const partPath = join(repo.rootPath, TRASH_DIR_NAME, partition);
  if (!existsSync(partPath)) return;
  try {
    const isEmpty = (dir: string): boolean => {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          if (!isEmpty(full)) return false;
        } else {
          return false;
        }
      }
      return true;
    };
    if (isEmpty(partPath)) {
      rmSync(partPath, { recursive: true, force: true });
    }
  } catch {
    // ignore — 留下空目录无害
  }
}
