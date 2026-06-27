/**
 * Onboard: install/uninstall/status for the merge driver in a git repo.
 *
 * Phase 1: invoked manually by tests.
 * Phase 2: wired into plugin onboarding + `co-engram git enable/disable/status`.
 *
 * installMergeDriver:
 *  1. Copy the esbuild bundle to `~/.co-engram/merge-driver.cjs` (version-checked).
 *  2. Write `[merge "co-engram"]` block into the repo's `.git/config`.
 *  3. Append the merge=co-engram entry to `.gitattributes` (idempotent).
 *
 * uninstallMergeDriver (spec §8.8):
 *  - Removes `merge.co-engram.*` keys from `.git/config`.
 *  - DOES NOT remove .gitattributes entries (committed; affects whole team).
 *  - DOES NOT remove ~/.co-engram/merge-driver.cjs (shared across repos).
 *    Use uninstallGlobalBundle() for that.
 *
 * @module @co-engram-core/merge
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

export const GITATTRIBUTES_ENTRY = `# co-engram structured merge driver
**/*.md            merge=co-engram
synapses/**/*.yaml merge=co-engram
`;

const BUNDLE_RELATIVE_PATH = ".co-engram/merge-driver.cjs";
const VERSION_PREFIX = "// co-engram-merge-driver v";

export interface OnboardResult {
  readonly bundlePath: string;
  readonly bundleUpgraded: boolean;
  readonly gitConfigWritten: boolean;
  readonly gitattributesUpdated: boolean;
}

function readInstalledVersion(bundlePath: string): string | null {
  if (!existsSync(bundlePath)) return null;
  try {
    const firstLine = readFileSync(bundlePath, "utf8").split("\n")[0] ?? "";
    if (!firstLine.startsWith(VERSION_PREFIX)) return null;
    return firstLine.slice(VERSION_PREFIX.length).trim();
  } catch {
    return null;
  }
}

export function installMergeDriver(params: {
  repoRoot: string;
  bundleSourcePath: string;
}): OnboardResult {
  const { repoRoot, bundleSourcePath } = params;

  // 1. Bundle copy (version-gated)
  const home = homedir();
  const bundleDest = join(home, BUNDLE_RELATIVE_PATH);
  let bundleUpgraded = false;
  const installed = readInstalledVersion(bundleDest);
  if (installed !== DRIVER_BUNDLE_VERSION) {
    mkdirSync(dirname(bundleDest), { recursive: true });
    copyFileSync(bundleSourcePath, bundleDest);
    bundleUpgraded = true;
  }

  // 2. .git/config — register merge driver
  execSync('git config merge.co-engram.name "co-engram structured merge"', {
    cwd: repoRoot,
  });
  execSync(
    `git config merge.co-engram.driver "node ${bundleDest} %O %A %B %L %P"`,
    { cwd: repoRoot },
  );

  // 3. .gitattributes (idempotent — only append if the marker is missing)
  const attrsPath = join(repoRoot, ".gitattributes");
  const existing = existsSync(attrsPath) ? readFileSync(attrsPath, "utf8") : "";
  let gitattributesUpdated = false;
  if (!existing.includes("merge=co-engram")) {
    appendFileSync(attrsPath, GITATTRIBUTES_ENTRY, "utf8");
    gitattributesUpdated = true;
  }

  return {
    bundlePath: bundleDest,
    bundleUpgraded,
    gitConfigWritten: true,
    gitattributesUpdated,
  };
}

export interface OnboardStatus {
  /** True if ~/.co-engram/merge-driver.cjs exists and matches the current version. */
  readonly bundleInstalled: boolean;
  /** The version banner in the installed bundle, or null if missing. */
  readonly installedVersion: string | null;
  /** True if .git/config has merge.co-engram.name. */
  readonly gitConfigPresent: boolean;
  /** True if .gitattributes contains merge=co-engram. */
  readonly gitattributesPresent: boolean;
  /** Absolute path to the bundle. */
  readonly bundlePath: string;
}

export interface UninstallResult {
  /** True if .git/config merge.co-engram.* keys were removed. */
  readonly gitConfigRemoved: boolean;
  /** True if ~/.co-engram/merge-driver.cjs was removed. */
  readonly bundleRemoved: boolean;
}

/**
 * Read the current onboard status for diagnostic / `co-engram git status` use.
 */
export function getOnboardStatus(params: { repoRoot: string }): OnboardStatus {
  const { repoRoot } = params;
  const home = homedir();
  const bundleDest = join(home, BUNDLE_RELATIVE_PATH);
  const installedVersion = readInstalledVersion(bundleDest);

  let gitConfigPresent = false;
  try {
    execSync("git config merge.co-engram.name", {
      cwd: repoRoot,
      stdio: "pipe",
    });
    gitConfigPresent = true;
  } catch {
    gitConfigPresent = false;
  }

  const attrsPath = join(repoRoot, ".gitattributes");
  const existing = existsSync(attrsPath) ? readFileSync(attrsPath, "utf8") : "";
  const gitattributesPresent = existing.includes("merge=co-engram");

  return {
    bundleInstalled: installedVersion === DRIVER_BUNDLE_VERSION,
    installedVersion,
    gitConfigPresent,
    gitattributesPresent,
    bundlePath: bundleDest,
  };
}

/**
 * Uninstall merge driver from the repo (spec §8.8).
 *
 * Removes .git/config merge.co-engram.* keys. Does NOT touch:
 *   - .gitattributes (committed; affects whole team — user decides)
 *   - ~/.co-engram/merge-driver.cjs (shared across repos — use uninstallGlobalBundle)
 */
export function uninstallMergeDriver(params: {
  repoRoot: string;
}): UninstallResult {
  const { repoRoot } = params;
  let gitConfigRemoved = false;
  try {
    execSync("git config --remove-section merge.co-engram", {
      cwd: repoRoot,
      stdio: "pipe",
    });
    gitConfigRemoved = true;
  } catch {
    // Section already absent — nothing to remove.
    gitConfigRemoved = false;
  }
  return { gitConfigRemoved, bundleRemoved: false };
}

/**
 * Remove the global bundle (~/.co-engram/merge-driver.cjs).
 * Spec §8.8: explicit `co-engram git uninstall --global` only.
 */
export function uninstallGlobalBundle(): { bundleRemoved: boolean } {
  const home = homedir();
  const bundleDest = join(home, BUNDLE_RELATIVE_PATH);
  if (!existsSync(bundleDest)) return { bundleRemoved: false };
  try {
    unlinkSync(bundleDest);
    return { bundleRemoved: true };
  } catch {
    return { bundleRemoved: false };
  }
}
