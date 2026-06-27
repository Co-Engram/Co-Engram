/**
 * Walk up from a file path to find the team memory data root.
 *
 * Data root = the directory containing the `.co-engram/` subdir.
 *
 * @module @co-engram/core/merge
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MARKER_DIR = ".co-engram";

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
    if (existsSync(join(current, MARKER_DIR))) {
      try {
        const stat = statSync(join(current, MARKER_DIR));
        if (stat.isDirectory()) return current;
      } catch {
        // ignore stat errors
      }
    }
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}
