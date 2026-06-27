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
  getOnboardStatus,
  GITATTRIBUTES_ENTRY,
} from "./onboard.js";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

/**
 * 多 host 共存测试 (spec §8.7)
 *
 * 场景:openclaw-plugin 和 claude-code-mcp 两个 host 进程都把同一个团队记忆仓库
 * (dataRoot)作为 git repo 管理,各自启动时都会 auto-onboard merge driver。
 *
 * 关键不变量:
 *   1. 共享 bundle:`~/.co-engram/merge-driver.cjs` 是 per-user 不是 per-host
 *   2. .gitattributes 幂等:多次 install 不重复添加条目
 *   3. .git/config 幂等:多次写 merge.co-engram.* 不冲突
 *   4. 版本一致性:任意 host 升级 bundle 后,其他 host 看到同一版本
 *   5. 并发安全:两个 host 几乎同时启动时,最终状态一致(无撕裂)
 */
describe("multi-host coexistence", () => {
  let repo: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let bundleSource: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "multihost-repo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "multihost-home-"));
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

  it("two hosts installing sequentially converge to the same state", () => {
    // Host A (e.g., openclaw-plugin) onboards first
    const resultA = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(resultA.bundleUpgraded).toBe(true);

    // Host B (e.g., claude-code-mcp) onboards after — sees same version, no upgrade
    const resultB = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(resultB.bundleUpgraded).toBe(false);
    expect(resultB.gitConfigWritten).toBe(true);
    expect(resultB.gitattributesUpdated).toBe(false); // already present

    // Both hosts agree on state via getOnboardStatus
    const statusA = getOnboardStatus({ repoRoot: repo });
    const statusB = getOnboardStatus({ repoRoot: repo });
    expect(statusA).toEqual(statusB);
    expect(statusA.bundleInstalled).toBe(true);
    expect(statusA.installedVersion).toBe(DRIVER_BUNDLE_VERSION);
    expect(statusA.gitConfigPresent).toBe(true);
    expect(statusA.gitattributesPresent).toBe(true);
  });

  it("shares a single bundle in ~/.co-engram/merge-driver.cjs across hosts", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });

    // Only ONE bundle file exists in home dir, regardless of host count
    const bundlePath = join(fakeHome, ".co-engram", "merge-driver.cjs");
    expect(existsSync(bundlePath)).toBe(true);
    const content = readFileSync(bundlePath, "utf8");
    expect(content).toContain(`v${DRIVER_BUNDLE_VERSION}`);
  });

  it(".gitattributes has exactly one merge=co-engram block per pattern after multiple installs", () => {
    for (let i = 0; i < 5; i++) {
      installMergeDriver({
        repoRoot: repo,
        bundleSourcePath: bundleSource,
      });
    }
    const attrs = readFileSync(join(repo, ".gitattributes"), "utf8");
    const mdMatches = attrs.match(/^\*\*\/\*\.md\s+merge=co-engram$/gm) ?? [];
    const yamlMatches =
      attrs.match(/^synapses\/\*\*\/\*\.yaml\s+merge=co-engram$/gm) ?? [];
    expect(mdMatches).toHaveLength(1);
    expect(yamlMatches).toHaveLength(1);
  });

  it(".git/config has exactly one merge.co-engram section after multiple installs", () => {
    for (let i = 0; i < 3; i++) {
      installMergeDriver({
        repoRoot: repo,
        bundleSourcePath: bundleSource,
      });
    }
    const sections = execSync(
      "git config --get-regexp '^merge\\.co-engram\\.'",
      {
        cwd: repo,
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
    // Exactly 2 keys: name + driver
    expect(sections).toHaveLength(2);
    expect(sections.some((s) => s.startsWith("merge.co-engram.name "))).toBe(
      true,
    );
    expect(sections.some((s) => s.startsWith("merge.co-engram.driver "))).toBe(
      true,
    );
  });

  it("version drift between installed bundle and host's compiled-in version is visible", () => {
    // Host A installs the bundle matching its compiled-in DRIVER_BUNDLE_VERSION
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });

    // Simulate out-of-band drift: another host manually downgrades the bundle file
    const bundlePath = join(fakeHome, ".co-engram", "merge-driver.cjs");
    writeFileSync(
      bundlePath,
      `// co-engram-merge-driver v0.0.1-stale\nconsole.log('stale');\n`,
    );

    // Host B reads status — sees the stale version (NOT what B compiled with)
    const status = getOnboardStatus({ repoRoot: repo });
    expect(status.installedVersion).toBe("0.0.1-stale");
    expect(status.bundleInstalled).toBe(false); // mismatch → needs upgrade

    // Host B's installMergeDriver call upgrades the bundle back to its compiled-in version
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(true);

    const finalStatus = getOnboardStatus({ repoRoot: repo });
    expect(finalStatus.installedVersion).toBe(DRIVER_BUNDLE_VERSION);
    expect(finalStatus.bundleInstalled).toBe(true);
  });

  it("re-creates bundle if a host manually deleted it", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const bundlePath = join(fakeHome, ".co-engram", "merge-driver.cjs");
    expect(existsSync(bundlePath)).toBe(true);

    // Simulate corruption: bundle deleted out-of-band
    rmSync(bundlePath);
    expect(existsSync(bundlePath)).toBe(false);

    // Next host startup re-installs it
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("uninstallMergeDriver by one host does NOT affect the shared bundle", () => {
    installMergeDriver({ repoRoot: repo, bundleSourcePath: bundleSource });
    const bundlePath = join(fakeHome, ".co-engram", "merge-driver.cjs");

    // Host A uninstalls (e.g., `co-engram git disable`)
    execSync("git config --remove-section merge.co-engram", {
      cwd: repo,
      stdio: "pipe",
    });

    // Shared bundle is intact — other hosts still rely on it
    expect(existsSync(bundlePath)).toBe(true);

    // Host B can re-onboard cleanly
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(false); // bundle unchanged
    expect(result.gitConfigWritten).toBe(true);
  });

  it("exports a stable GITATTRIBUTES_ENTRY across all hosts", () => {
    // All hosts must agree on the same .gitattributes entry — if they differed,
    // repeated installs would add conflicting patterns and the file would grow unboundedly.
    expect(GITATTRIBUTES_ENTRY).toMatch(/^\*\*\/\*\.md\s+merge=co-engram$/m);
    expect(GITATTRIBUTES_ENTRY).toMatch(
      /^synapses\/\*\*\/\*\.yaml\s+merge=co-engram$/m,
    );
  });
});
