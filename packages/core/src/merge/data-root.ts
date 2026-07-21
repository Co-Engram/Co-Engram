/**
 * Walk up from a file path to find the team memory data root.
 *
 * Data root = the directory containing the `.co-engram/` subdir whose config.json
 * does NOT point elsewhere。一个 `.co-engram/` 若其 config.json.dataRoot 指向「他处」,
 * 那是 co-engram 的全局 bootstrap 配置(如 ~/.co-engram/),不是 dataRoot —— 必须跳过,
 * 否则任何其下仓库的 git pull 都会误触发 doctor 在 bootstrap 目录上跑(慢、污染 stale 索引)。
 *
 * @module @co-engram/core/merge
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MARKER_DIR = ".co-engram";

/**
 * 判断一个 .co-engram/ 是否为「全局 bootstrap 配置」(非真 dataRoot)。
 *
 * bootstrap 标志:config.json 含 dataRoot 字段且指向「他处」(≠ candidateRoot)。
 * 真 dataRoot 的 config.json 无 dataRoot 字段(或指自己)。无 config.json 时按 dataRoot 处理
 * (向后兼容既有 .co-engram/ 目录)。
 */
function isBootstrapConfig(coEngramDir: string, candidateRoot: string): boolean {
  try {
    const configPath = join(coEngramDir, "config.json");
    if (!existsSync(configPath)) return false;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { dataRoot?: unknown };
    if (typeof config.dataRoot !== "string" || config.dataRoot.trim() === "") return false;
    return resolve(config.dataRoot) !== resolve(candidateRoot);
  } catch {
    return false;
  }
}

export function findDataRoot(startPath: string): string | null {
  let current = startPath;
  // If startPath is a file, begin from its directory
  try {
    const stat = statSync(current);
    if (stat.isFile()) current = dirname(current);
  } catch {
    // path may not exist yet (e.g. %A in some git versions); assume it's a file path
    current = dirname(current);
  }

  current = resolve(current);
  // Walk up
  while (true) {
    const coEngramDir = join(current, MARKER_DIR);
    try {
      if (existsSync(coEngramDir) && statSync(coEngramDir).isDirectory()) {
        if (!isBootstrapConfig(coEngramDir, current)) return current;
        // bootstrap 配置(如 ~/.co-engram/,config.json.dataRoot → 他处):跳过,继续向上找真 dataRoot
      }
    } catch {
      // ignore stat errors
    }
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}
