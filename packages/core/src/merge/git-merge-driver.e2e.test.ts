/**
 * End-to-end test: real `git merge` invokes our driver and resolves engram conflicts.
 *
 * Requires dist/merge-driver.cjs to be built (`pnpm build:merge-driver`).
 * Skipped if bundle is missing (so `pnpm test` in clean checkouts still works).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installMergeDriver } from "./onboard.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const BUNDLE_PATH = resolve(here, "../../dist/merge-driver.cjs");

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function engramRaw(id: string, updatedAt: string, body: string): string {
  return `---
id: "${id}"
title: "decision"
kind: "observation"
createdBy: "user-a"
createdAt: "2026-01-01T00:00:00Z"
updatedBy: "user-a"
updatedAt: "${updatedAt}"
version: 1
domainTags: ["AIOS"]
---

${body}
`;
}

(existsSync(BUNDLE_PATH) ? describe : describe.skip)(
  "e2e: real git merge driver",
  () => {
    let repo: string;
    let fakeHome: string;
    let originalHome: string | undefined;

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "e2e-repo-"));
      fakeHome = mkdtempSync(join(tmpdir(), "e2e-home-"));
      originalHome = process.env.HOME;
      process.env.HOME = fakeHome;

      sh("git init -q", repo);
      sh("git symbolic-ref HEAD refs/heads/main", repo);
      sh("git config user.email test@test.com", repo);
      sh("git config user.name Test", repo);

      installMergeDriver({ repoRoot: repo, bundleSourcePath: BUNDLE_PATH });

      // installMergeDriver copies the bundle to $HOME/.co-engram/merge-driver.cjs
      // and writes that installed path into .git/config (NOT the source path).
      const installedPath = join(fakeHome, ".co-engram", "merge-driver.cjs");
      const driverLine = sh("git config merge.co-engram.driver", repo);
      expect(driverLine).toContain(installedPath);
      expect(existsSync(installedPath)).toBe(true);
    });

    it("auto-resolves an additive retrievalCount merge via driver", () => {
      const baseRel = "engrams/AIOS/decision.md";
      const baseDir = join(repo, "engrams", "AIOS");
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(
        join(repo, baseRel),
        engramRaw("01HE2E0001", "2026-06-01T00:00:00Z", "Base body."),
      );
      sh("git add engrams/ && git commit -q -m base", repo);

      // Branch feature: bump retrievalCount to 7
      sh("git checkout -q -b feature", repo);
      writeFileSync(
        join(repo, baseRel),
        engramRaw("01HE2E0001", "2026-06-02T00:00:00Z", "Base body.").replace(
          "version: 1",
          "version: 1\nretrievalCount: 7",
        ),
      );
      sh("git add -A && git commit -q -m feature", repo);

      // Back to main: bump retrievalCount to 6 + content edit
      sh("git checkout -q main", repo);
      writeFileSync(
        join(repo, baseRel),
        engramRaw(
          "01HE2E0001",
          "2026-06-03T00:00:00Z",
          "Base body + main edit.",
        ).replace("version: 1", "version: 1\nretrievalCount: 6"),
      );
      sh("git add -A && git commit -q -m main-edit", repo);

      // Merge feature → triggers driver. Both sides changed the file,
      // so git invokes our driver.
      const result = execSync("git merge feature 2>&1", {
        cwd: repo,
        encoding: "utf8",
      });
      expect(result).toMatch(/Auto-merging|Merge made|CONFLICT/);

      // base had no retrievalCount (undefined → 0). Additive rule:
      //   merged = ours(6) + theirs(7) - base(0) = 13
      const merged = readFileSync(join(repo, baseRel), "utf8");
      const match = merged.match(/retrievalCount:\s*(\d+)/);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(13);

      // Main's content edit should win (newer updatedAt).
      expect(merged).toContain("Base body + main edit.");
    });

    it("falls back to git default behavior when driver script is missing", () => {
      const repo2 = mkdtempSync(join(tmpdir(), "e2e-broken-"));
      sh("git init -q", repo2);
      sh("git symbolic-ref HEAD refs/heads/main", repo2);
      sh("git config user.email test@test.com", repo2);
      sh("git config user.name Test", repo2);
      sh('git config merge.co-engram.name "co-engram"', repo2);
      sh(
        'git config merge.co-engram.driver "node /nonexistent/path.cjs %O %A %B %L %P"',
        repo2,
      );

      mkdirSync(join(repo2, "engrams"), { recursive: true });
      writeFileSync(
        join(repo2, "engrams", "a.md"),
        '---\nid: "1"\ntitle: x\nkind: observation\ncreatedBy: a\ncreatedAt: "2026-01-01T00:00:00Z"\nupdatedBy: a\nupdatedAt: "2026-01-01T00:00:00Z"\nversion: 1\n---\n\nBody\n',
      );
      sh("git add -A && git commit -q -m base", repo2);
      sh("git checkout -q -b feat", repo2);
      writeFileSync(
        join(repo2, "engrams", "a.md"),
        '---\nid: "1"\ntitle: x\nkind: observation\ncreatedBy: a\ncreatedAt: "2026-01-01T00:00:00Z"\nupdatedBy: a\nupdatedAt: "2026-01-01T00:00:00Z"\nversion: 1\n---\n\nFeature body\n',
      );
      sh("git add -A && git commit -q -m feat", repo2);
      sh("git checkout -q main", repo2);
      writeFileSync(
        join(repo2, "engrams", "a.md"),
        '---\nid: "1"\ntitle: x\nkind: observation\ncreatedBy: a\ncreatedAt: "2026-01-01T00:00:00Z"\nupdatedBy: a\nupdatedAt: "2026-01-01T00:00:00Z"\nversion: 1\n---\n\nMain body\n',
      );
      sh("git add -A && git commit -q -m main", repo2);

      // git will fail to invoke the missing driver. Behavior: it reports the
      // driver failure, then either falls back to text merge or leaves conflict.
      let mergeResult: string;
      try {
        mergeResult = execSync("git merge feat 2>&1", {
          cwd: repo2,
          encoding: "utf8",
        });
      } catch (e) {
        mergeResult =
          (e as { stdout?: string; stderr?: string }).stdout ??
          (e as { stdout?: string; stderr?: string }).stderr ??
          "";
      }

      // Repo must not be corrupted; some signal of merge outcome must appear.
      // Locale-agnostic: git may output either English (CONFLICT/Auto-merging)
      // or Chinese (冲突/自动合并) depending on user environment.
      expect(mergeResult).toMatch(
        /CONFLICT|Automatic merge failed|Auto-merging|merge|冲突|自动合并|合并/,
      );

      rmSync(repo2, { recursive: true, force: true });
    });
  },
);
