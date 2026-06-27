import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  autoOnboardMergeDriver,
  findGitRepoRoot,
  resolveMergeDriverBundle,
} from "./auto-onboard.js";
import { DRIVER_BUNDLE_VERSION } from "@co-engram/core";

function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

describe("resolveMergeDriverBundle", () => {
  it("returns the bundle path when merge-driver.cjs exists in coreDistDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-dist-"));
    writeFileSync(
      join(dir, "merge-driver.cjs"),
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\n`,
    );
    expect(resolveMergeDriverBundle(dir)).toBe(join(dir, "merge-driver.cjs"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when merge-driver.cjs absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-dist-empty-"));
    expect(resolveMergeDriverBundle(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("findGitRepoRoot", () => {
  it("returns the directory containing .git", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-root-"));
    initGitRepo(repo);
    expect(findGitRepoRoot(repo)).toBe(repo);
    rmSync(repo, { recursive: true, force: true });
  });

  it("walks up through nested directories to find .git", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-walk-"));
    initGitRepo(repo);
    const nested = join(repo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findGitRepoRoot(nested)).toBe(repo);
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns null when no ancestor has .git", () => {
    // /tmp 几乎不可能在 git repo 内
    expect(findGitRepoRoot(tmpdir())).toBeNull();
  });
});

describe("autoOnboardMergeDriver", () => {
  let repo: string;
  let nonRepo: string;
  let bundleSource: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "auto-repo-"));
    initGitRepo(repo);

    nonRepo = mkdtempSync(join(tmpdir(), "auto-non-repo-"));

    fakeHome = mkdtempSync(join(tmpdir(), "auto-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    bundleSource = join(fakeHome, `bundle-${process.pid}-${Date.now()}.cjs`);
    writeFileSync(
      bundleSource,
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\nconsole.log('test');\n`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(nonRepo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (existsSync(bundleSource)) rmSync(bundleSource);
  });

  it("installs driver when dataRoot is inside a git repo", () => {
    const result = autoOnboardMergeDriver({
      dataRoot: repo,
      bundleSourcePath: bundleSource,
    });

    expect(result.attempted).toBe(true);
    expect(result.repoRoot).toBe(repo);
    expect(result.bundleUpgraded).toBe(true);
    expect(result.gitattributesUpdated).toBe(true);

    // .gitattributes written
    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    expect(attrs).toContain("merge=co-engram");

    // .git/config has merge.co-engram section
    const name = execSync("git config merge.co-engram.name", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(name).toBe("co-engram structured merge");
  });

  it("is idempotent — second call does not re-upgrade bundle", () => {
    autoOnboardMergeDriver({
      dataRoot: repo,
      bundleSourcePath: bundleSource,
    });
    const second = autoOnboardMergeDriver({
      dataRoot: repo,
      bundleSourcePath: bundleSource,
    });

    expect(second.attempted).toBe(true);
    expect(second.bundleUpgraded).toBe(false);
    expect(second.gitattributesUpdated).toBe(false);
  });

  it("returns attempted=false when dataRoot is not in a git repo", () => {
    const result = autoOnboardMergeDriver({
      dataRoot: nonRepo,
      bundleSourcePath: bundleSource,
    });

    expect(result.attempted).toBe(false);
    expect(result.repoRoot).toBeUndefined();
  });

  it("returns attempted=false when bundle source is missing", () => {
    rmSync(bundleSource);
    const result = autoOnboardMergeDriver({
      dataRoot: repo,
      bundleSourcePath: bundleSource,
    });

    expect(result.attempted).toBe(false);
  });

  it("uses repoRootOverride when provided (skips git detection)", () => {
    const result = autoOnboardMergeDriver({
      dataRoot: nonRepo,
      bundleSourcePath: bundleSource,
      repoRootOverride: repo,
    });

    expect(result.attempted).toBe(true);
    expect(result.repoRoot).toBe(repo);
  });

  it("captures errors without throwing (installMergeDriver failure)", () => {
    // Create a "repo" directory with .git as a file (not dir) to make git commands fail
    const fakeRepo = mkdtempSync(join(tmpdir(), "fake-repo-"));
    writeFileSync(join(fakeRepo, ".git"), "not a real git dir");

    const result = autoOnboardMergeDriver({
      dataRoot: fakeRepo,
      bundleSourcePath: bundleSource,
    });

    expect(result.attempted).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.bundleUpgraded).toBeUndefined();

    rmSync(fakeRepo, { recursive: true, force: true });
  });

  it("walks up from dataRoot to find repo root and installs there", () => {
    // Create nested dir inside repo; auto-onboard should find the parent repo
    const nested = join(repo, "subdir", "deeper");
    mkdirSync(nested, { recursive: true });

    const result = autoOnboardMergeDriver({
      dataRoot: nested,
      bundleSourcePath: bundleSource,
    });

    expect(result.attempted).toBe(true);
    expect(result.repoRoot).toBe(repo);
    expect(existsSync(join(repo, ".gitattributes"))).toBe(true);
  });
});
