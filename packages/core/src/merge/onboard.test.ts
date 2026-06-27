import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  installMergeDriver,
  uninstallMergeDriver,
  uninstallGlobalBundle,
  getOnboardStatus,
  GITATTRIBUTES_ENTRY,
} from "./onboard.js";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

describe("installMergeDriver", () => {
  let repo: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let bundleSource: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "onboard-repo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "onboard-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    initGitRepo(repo);

    bundleSource = join(fakeHome, "fake-bundle.cjs");
    writeFileSync(
      bundleSource,
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\nconsole.log('test bundle');\n`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("copies bundle to ~/.co-engram/merge-driver.cjs on first install", () => {
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(true);
    expect(existsSync(join(fakeHome, ".co-engram", "merge-driver.cjs"))).toBe(
      true,
    );
    const written = readFileSync(
      join(fakeHome, ".co-engram", "merge-driver.cjs"),
      "utf8",
    );
    expect(written).toContain(`v${DRIVER_BUNDLE_VERSION}`);
  });

  it("skips bundle copy when version matches", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(false);
  });

  it("overwrites bundle when version differs", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    // Simulate an older bundle already installed
    writeFileSync(
      join(fakeHome, ".co-engram", "merge-driver.cjs"),
      `// co-engram-merge-driver v0.0.1-old\nconsole.log('old');\n`,
    );
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(true);
    const written = readFileSync(
      join(fakeHome, ".co-engram", "merge-driver.cjs"),
      "utf8",
    );
    expect(written).toContain(`v${DRIVER_BUNDLE_VERSION}`);
  });

  it("writes merge.co-engram.name and .driver in .git/config", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });

    const name = execSync("git config merge.co-engram.name", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const driver = execSync("git config merge.co-engram.driver", {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    expect(name).toBe("co-engram structured merge");
    expect(driver).toContain("node");
    expect(driver).toContain("%O %A %B %L %P");
    expect(driver).toContain(join(fakeHome, ".co-engram", "merge-driver.cjs"));
  });

  it("appends .gitattributes entry if missing", () => {
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.gitattributesUpdated).toBe(true);

    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    expect(attrs).toContain("merge=co-engram");
    expect(attrs).toMatch(/\*\.md\s+merge=co-engram/);
  });

  it("does not duplicate .gitattributes entry on re-run", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });

    expect(result.gitattributesUpdated).toBe(false);
    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    const matches = attrs.match(/merge=co-engram/g) ?? [];
    expect(matches).toHaveLength(2); // one for *.md, one for synapses/**/*.yaml
  });

  it("exports GITATTRIBUTES_ENTRY constant with the expected patterns", () => {
    expect(GITATTRIBUTES_ENTRY).toContain("**/*.md");
    expect(GITATTRIBUTES_ENTRY).toContain("synapses/**/*.yaml");
    expect(GITATTRIBUTES_ENTRY).toContain("merge=co-engram");
  });
});

describe("getOnboardStatus", () => {
  let repo: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let bundleSource: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "onboard-status-repo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "onboard-status-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    initGitRepo(repo);

    bundleSource = join(fakeHome, "fake-bundle.cjs");
    writeFileSync(
      bundleSource,
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\nconsole.log('test bundle');\n`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("reports all-present after installMergeDriver", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const status = getOnboardStatus({ repoRoot: repo });

    expect(status.bundleInstalled).toBe(true);
    expect(status.installedVersion).toBe(DRIVER_BUNDLE_VERSION);
    expect(status.gitConfigPresent).toBe(true);
    expect(status.gitattributesPresent).toBe(true);
    expect(status.bundlePath).toBe(
      join(fakeHome, ".co-engram", "merge-driver.cjs"),
    );
  });

  it("reports bundleInstalled=false when version differs", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    writeFileSync(
      join(fakeHome, ".co-engram", "merge-driver.cjs"),
      `// co-engram-merge-driver v0.0.1-stale\n`,
    );
    const status = getOnboardStatus({ repoRoot: repo });

    expect(status.bundleInstalled).toBe(false);
    expect(status.installedVersion).toBe("0.0.1-stale");
  });

  it("reports installedVersion=null when bundle missing", () => {
    const status = getOnboardStatus({ repoRoot: repo });
    expect(status.installedVersion).toBeNull();
    expect(status.bundleInstalled).toBe(false);
  });

  it("reports gitConfigPresent=false when .git/config has no merge.co-engram section", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    execSync("git config --remove-section merge.co-engram", {
      cwd: repo,
      stdio: "pipe",
    });
    const status = getOnboardStatus({ repoRoot: repo });
    expect(status.gitConfigPresent).toBe(false);
  });

  it("reports gitattributesPresent=false when .gitattributes has no merge=co-engram", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    writeFileSync(join(repo, ".gitattributes"), "# unrelated\n*.txt text\n");
    const status = getOnboardStatus({ repoRoot: repo });
    expect(status.gitattributesPresent).toBe(false);
  });
});

describe("uninstallMergeDriver", () => {
  let repo: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let bundleSource: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "onboard-uninstall-repo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "onboard-uninstall-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    initGitRepo(repo);

    bundleSource = join(fakeHome, "fake-bundle.cjs");
    writeFileSync(
      bundleSource,
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\nconsole.log('test bundle');\n`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("removes merge.co-engram.* keys from .git/config", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const result = uninstallMergeDriver({ repoRoot: repo });

    expect(result.gitConfigRemoved).toBe(true);
    expect(() =>
      execSync("git config merge.co-engram.name", {
        cwd: repo,
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("returns gitConfigRemoved=false when section already absent (idempotent)", () => {
    const result = uninstallMergeDriver({ repoRoot: repo });
    expect(result.gitConfigRemoved).toBe(false);
  });

  it("does NOT remove .gitattributes entries", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    uninstallMergeDriver({ repoRoot: repo });

    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    expect(attrs).toContain("merge=co-engram");
  });

  it("does NOT remove the global bundle", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    uninstallMergeDriver({ repoRoot: repo });

    expect(existsSync(join(fakeHome, ".co-engram", "merge-driver.cjs"))).toBe(
      true,
    );
  });

  it("reports bundleRemoved=false in its result", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const result = uninstallMergeDriver({ repoRoot: repo });
    expect(result.bundleRemoved).toBe(false);
  });
});

describe("uninstallGlobalBundle", () => {
  let repo: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let bundleSource: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "onboard-global-repo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "onboard-global-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    initGitRepo(repo);

    bundleSource = join(fakeHome, "fake-bundle.cjs");
    writeFileSync(
      bundleSource,
      `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\nconsole.log('test bundle');\n`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("removes ~/.co-engram/merge-driver.cjs when present", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    expect(existsSync(join(fakeHome, ".co-engram", "merge-driver.cjs"))).toBe(
      true,
    );

    const result = uninstallGlobalBundle();
    expect(result.bundleRemoved).toBe(true);
    expect(existsSync(join(fakeHome, ".co-engram", "merge-driver.cjs"))).toBe(
      false,
    );
  });

  it("returns bundleRemoved=false when bundle absent", () => {
    const result = uninstallGlobalBundle();
    expect(result.bundleRemoved).toBe(false);
  });

  it("is idempotent — second call returns bundleRemoved=false", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    uninstallGlobalBundle();
    const second = uninstallGlobalBundle();
    expect(second.bundleRemoved).toBe(false);
  });
});
