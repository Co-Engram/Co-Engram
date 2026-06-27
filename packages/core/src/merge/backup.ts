/**
 * 输方版本备份 + TTL 清理
 *
 * 当 merge driver 选定赢家后,把输方的完整文件内容写入
 *   $DATA_ROOT/.co-engram/merge-backup/{YYYYMMDD}/{relPath}.{side}
 * 以便人工事后取回。7 天后自动清理(由 maintenance 调用 cleanupOldBackups)。
 *
 * @module @co-engram/core/merge
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MERGE_BACKUP_DIR = ".co-engram/merge-backup";
const DEFAULT_TTL_DAYS = 7;
const DATE_DIR_RE = /^\d{8}$/;

export interface BackupResult {
  readonly backupPath: string;
  readonly createdAt: string;
}

export function snapshotLoser(params: {
  dataRoot: string;
  relPath: string;
  side: "ours" | "theirs";
  content: string;
}): BackupResult {
  const { dataRoot, relPath, side, content } = params;
  const dateDir = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backupPath = join(
    dataRoot,
    MERGE_BACKUP_DIR,
    dateDir,
    `${relPath}.${side}`,
  );
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, content, "utf8");
  return { backupPath, createdAt: new Date().toISOString() };
}

export function cleanupOldBackups(params: {
  dataRoot: string;
  now?: Date;
  ttlDays?: number;
}): { deleted: readonly string[] } {
  const { dataRoot, now = new Date(), ttlDays = DEFAULT_TTL_DAYS } = params;
  const root = join(dataRoot, MERGE_BACKUP_DIR);
  if (!existsSync(root)) return { deleted: [] };

  const cutoffMs = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];

  for (const entry of readdirSync(root)) {
    if (!DATE_DIR_RE.test(entry)) continue;
    const year = parseInt(entry.slice(0, 4), 10);
    const month = parseInt(entry.slice(4, 6), 10) - 1;
    const day = parseInt(entry.slice(6, 8), 10);
    const entryDate = new Date(Date.UTC(year, month, day));
    if (entryDate.getTime() >= cutoffMs) continue;

    const entryDir = join(root, entry);
    for (const file of readdirSync(entryDir)) {
      const filePath = join(entryDir, file);
      unlinkSync(filePath);
      deleted.push(filePath);
    }
    rmdirSync(entryDir);
  }

  return { deleted };
}
