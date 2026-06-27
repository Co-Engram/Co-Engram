# Git Merge Driver Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working co-engram git merge driver that automatically resolves engram file conflicts via updatedAt arbitration + structured frontmatter merge, with backup + audit hooks, and zero data loss on failure.

**Architecture:** A standalone esbuild-bundled CLI driver lives at `~/.co-engram/merge-driver.js`. Git invokes it via `.gitattributes` + `.git/config merge.co-engram.driver` with the standard `%O %A %B %L %P` plumbing contract. The driver parses base/ours/theirs engram files, merges frontmatter field-by-field (immutable / additive / max / updatedAt-arbitrated), runs `git merge-file` on content with updatedAt fallback, writes the merged result to `%A`, snapshots the loser to `.co-engram/merge-backup/`, and appends an audit entry. Any uncertainty leaves git conflict markers and exits non-zero so git falls back to standard behavior.

**Tech Stack:** TypeScript 5.6+ (ESM, `.js` import suffixes), Node 22+, vitest 2.0, esbuild (new dev dep), `yaml` ^2.5.0 (already in core), `yaml` parse for frontmatter, child_process for `git merge-file` + integration tests, ulid for stable engram ids (already used).

**Spec:** [docs/superpowers/specs/2026-06-26-git-merge-driver-design.md](../specs/2026-06-26-git-merge-driver-design.md) — sections §3 (architecture), §4 (engram merge algorithm), §8 (onboard), §10 (error handling), §12 (Phase 1 scope).

## Global Constraints

- **Language:** TypeScript strict mode, ESM, all internal imports use `.js` suffix (e.g. `import { parseEngramFile } from '../storage/engram-store.js'`).
- **Node:** >= 22.0.0 (already pinned in `packages/core/package.json` engines).
- **Test runner:** vitest 2.0 only. Colocated `*.test.ts`. No Jest. Run via `pnpm test` (per-package) or `pnpm test <path>` (targeted).
- **Typecheck:** `pnpm typecheck` (= `tsc --noEmit`). Do not add `tsc --noEmit` calls inline.
- **Format:** prettier (`pnpm format` / `pnpm format:check`); project style is double quotes, trailing commas, 2-space indent.
- **Git contract:** Driver CLI receives exactly 5 positional args: `%O` (base) `%A` (ours, also output target) `%B` (theirs) `%L` (marker size) `%P` (path being merged). Driver MUST write merged result to `%A` and exit 0 on success, OR leave `%A` with conflict markers and exit non-zero on failure. Never exit 0 with unmerged content.
- **Data loss invariant:** Any uncertainty → leave git's standard `<<<<<<<` markers in `%A` and exit 1. Git will then surface the conflict to the user. Never silently pick a winner when unsure.
- **Audit actor:** All merge audit entries use `actor: 'system'`.
- **No LLM in Phase 1:** When arbitration would need LLM (e.g. updatedAt tiebreaker平局), driver leaves markers + exits 1. Phase 3 will wire LLM.

---

## File Structure

All new code lives under `packages/core/src/merge/`. Colocated `*.test.ts`. Fixtures under `packages/core/test/fixtures/merge/`.

**New files (core):**

| Path                                            | Responsibility                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/merge/version.ts`            | Single source of truth for driver bundle version                                                                       |
| `packages/core/src/merge/backup.ts`             | Snapshot loser version to `.co-engram/merge-backup/{date}/{path}` + 7-day TTL cleanup                                  |
| `packages/core/src/merge/frontmatter-rules.ts`  | Field classification + per-class single-field merge rules (immutable / additive / max)                                 |
| `packages/core/src/merge/arbitration.ts`        | updatedAt arbitration + tiebreaker (returns `'ours' \| 'theirs' \| 'escalate'`)                                        |
| `packages/core/src/merge/frontmatter.ts`        | Frontmatter orchestrator: classify each field, dispatch, recompute contentHash/contentSize, drop legacy derived fields |
| `packages/core/src/merge/content.ts`            | Content body 3-way merge via `git merge-file -p --diff3`; fallback to updatedAt loser-wins on real conflict            |
| `packages/core/src/merge/merge-engram.ts`       | EngramMerger entry: compose frontmatter + content + finalization + backup + audit                                      |
| `packages/core/src/merge/data-root.ts`          | Walk up from `%P` to find `.co-engram/` marker dir                                                                     |
| `packages/core/src/merge/driver-main.ts`        | CLI entry: parse argv, route by path, handle non-engram `.md` transparently                                            |
| `packages/core/src/merge/onboard.ts`            | Install: copy bundle, write `.gitattributes`, write `.git/config`                                                      |
| `packages/core/src/merge/bundle.ts`             | esbuild programmatic build config (produces `dist/merge-driver.js`)                                                    |
| `packages/core/src/merge/index.ts`              | Barrel for host packages (Phase 2 will consume)                                                                        |
| `packages/core/test/fixtures/merge/<scenario>/` | Per-scenario fixture: `base.md`, `ours.md`, `theirs.md`, `expected.md`, `meta.json`                                    |

**Modified files (core):**

| Path                                           | Change                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/observability/audit-log.ts` | Add `'merge_resolved' \| 'merge_backup_failed' \| 'merge_conflict_escalated'` to `AuditAction` |
| `packages/core/package.json`                   | Add `esbuild` devDep, add `build:merge-driver` script                                          |
| `packages/core/src/index.ts`                   | Re-export merge barrel (if barrel pattern exists; otherwise skip)                              |

**No changes (Phase 1):** host plugin packages (`openclaw-plugin`, `claude-code-mcp`), viewer, e2e. Phase 2 will integrate onboard into plugin onboarding flows.

---

## Task Decomposition Rationale

Each task is sized so that:

- It has its own vitest test cycle (red → green → commit)
- A reviewer could approve one task while rejecting its neighbor
- Failure recovery is localized (revert one commit, not five)

Tasks are ordered as a clean DAG — no forward references. Each task's "Interfaces → Produces" block is the contract the next task depends on.

---

## Task 1: Extend AuditAction for merge events

**Files:**

- Modify: `packages/core/src/observability/audit-log.ts:30-52` (AuditAction union)
- Test: `packages/core/src/observability/audit-log.test.ts` (likely already exists — append a case)

**Interfaces:**

- Consumes: existing `AuditLog` class
- Produces: `AuditAction` now includes `'merge_resolved' | 'merge_backup_failed' | 'merge_conflict_escalated'`. `AuditEntry.metadata` carries merge-specific fields: `path: string`, `strategy: string`, `winner?: 'ours' | 'theirs'`, `backupPath?: string`, `reason?: string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/observability/audit-log.test.ts` (create the file if it does not already exist):

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit-log.js";

describe("AuditLog merge actions", () => {
  it("accepts merge_resolved with merge metadata", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-merge-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_resolved",
      engramId: "01HXXXXXXXXXXXXXXXXXXXXXX",
      metadata: {
        path: "engrams/AIOS/decision.md",
        strategy: "frontmatter-updatedAt-arbitration",
        winner: "theirs",
        backupPath:
          ".co-engram/merge-backup/20260626/engrams/AIOS/decision.md.ours",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_resolved");
    expect(entry.metadata.winner).toBe("theirs");
    expect(entry.metadata.strategy).toBe("frontmatter-updatedAt-arbitration");
  });

  it("accepts merge_backup_failed with reason metadata", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-backup-fail-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_backup_failed",
      metadata: {
        path: "engrams/AIOS/decision.md",
        reason: "EACCES permission denied",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_backup_failed");
    expect(entry.metadata.reason).toBe("EACCES permission denied");
  });

  it("accepts merge_conflict_escalated when driver leaves markers", () => {
    const dir = mkdirSync(join(tmpdir(), `audit-escalate-${Date.now()}`), {
      recursive: true,
    });
    const log = new AuditLog(dir);
    log.append({
      actor: "system",
      action: "merge_conflict_escalated",
      metadata: {
        path: "engrams/AIOS/decision.md",
        reason:
          "updatedAt collision + tiebreaker平局; Phase 1 has no LLM arbiter",
      },
    });

    const lines = readFileSync(join(dir, ".co-engram", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("merge_conflict_escalated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/observability/audit-log.test.ts`
Expected: FAIL with TypeScript error — `Argument of type '"merge_resolved"' is not assignable to parameter of type ...` because the action union does not include the new values.

- [ ] **Step 3: Extend the AuditAction union**

Edit `packages/core/src/observability/audit-log.ts`. Find the `AuditAction` union (around line 30-52) and append the merge events after the existing `necessity_rejected` literal:

```typescript
/** 审计动作 */
export type AuditAction =
  // 状态变更
  | "create"
  | "update"
  | "update_lifecycle"
  | "reinforce"
  | "report_failure"
  | "forget"
  | "restore"
  | "sweep_to_trash"
  | "restore_from_trash"
  | "purge"
  | "propose"
  | "accept"
  | "dismiss"
  // 有效性信号(只有 contradicted 仍写入;retrieve_* 不再写,见模块注释)
  | "retrieve_hit"
  | "retrieve_effective"
  | "retrieve_inconclusive"
  | "contradicted"
  // proposal engine 过滤(Layer 1 不再写 audit;Layer 2 必要性拒绝仍写)
  | "noise_filtered"
  | "necessity_rejected"
  // git merge driver 事件(Phase 1 MVP 起)
  | "merge_resolved"
  | "merge_backup_failed"
  | "merge_conflict_escalated";
```

Also update the file's top docstring comment (lines 1-24) — append to the "当前写入的事件" list:

```typescript
 *   - git merge driver 事件: merge_resolved(driver 自动解决冲突)/
 *                           merge_backup_failed(输方备份落盘失败)/
 *                           merge_conflict_escalated(driver 留 marker 升级人工)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/observability/audit-log.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass. If format fails, run `pnpm format` and re-stage.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/observability/audit-log.ts packages/core/src/observability/audit-log.test.ts
git commit -m "feat(core): add merge_resolved/merge_backup_failed/merge_conflict_escalated audit actions"
```

---

## Task 2: Backup module (loser snapshot + 7-day TTL)

**Files:**

- Create: `packages/core/src/merge/backup.ts`
- Create: `packages/core/src/merge/backup.test.ts`

**Interfaces:**

- Consumes: `dataRoot: string` (the team memory root containing `.co-engram/`)
- Produces:

  ```typescript
  export interface BackupResult {
    readonly backupPath: string; // absolute, under $DATA_ROOT/.co-engram/merge-backup/{YYYYMMDD}/{relPath}.{side}
    readonly createdAt: string; // ISO timestamp
  }
  export function snapshotLoser(params: {
    dataRoot: string;
    relPath: string; // e.g. 'engrams/AIOS/decision.md'
    side: "ours" | "theirs";
    content: string; // raw loser file content
  }): BackupResult;
  export function cleanupOldBackups(params: {
    dataRoot: string;
    now?: Date; // injectable for tests; default new Date()
    ttlDays?: number; // default 7
  }): { deleted: readonly string[] };
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/backup.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotLoser, cleanupOldBackups } from "./backup.js";

describe("snapshotLoser", () => {
  it("writes loser content under .co-engram/merge-backup/{date}/{relPath}.{side}", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-basic-${Date.now()}`), {
      recursive: true,
    });
    const content =
      "---\nid: 01HXXX\ntitle: loser version\n---\n\nloser body\n";

    const result = snapshotLoser({
      dataRoot,
      relPath: "engrams/AIOS/decision.md",
      side: "ours",
      content,
    });

    expect(result.backupPath).toMatch(
      /\.co-engram[\/]merge-backup[\/]\d{8}[\/]engrams[\/]AIOS[\/]decision\.md\.ours$/,
    );
    expect(existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath, "utf8")).toBe(content);
  });

  it("creates nested directories on first call", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-nested-${Date.now()}`), {
      recursive: true,
    });
    expect(existsSync(join(dataRoot, ".co-engram", "merge-backup"))).toBe(
      false,
    );

    snapshotLoser({
      dataRoot,
      relPath: "engrams/deep/nested/path.md",
      side: "theirs",
      content: "x",
    });

    expect(existsSync(join(dataRoot, ".co-engram", "merge-backup"))).toBe(true);
  });
});

describe("cleanupOldBackups", () => {
  it("deletes backup dirs older than ttlDays", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-cleanup-${Date.now()}`), {
      recursive: true,
    });
    const oldDir = join(dataRoot, ".co-engram", "merge-backup", "20250101");
    const recentDir = join(dataRoot, ".co-engram", "merge-backup", "20260620");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });
    writeFileSync(join(oldDir, "decision.md.ours"), "old");
    writeFileSync(join(recentDir, "decision.md.ours"), "recent");

    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
      ttlDays: 7,
    });

    expect(result.deleted).toEqual([join(oldDir, "decision.md.ours")]);
    expect(existsSync(join(oldDir, "decision.md.ours"))).toBe(false);
    expect(existsSync(join(recentDir, "decision.md.ours"))).toBe(true);
  });

  it("does nothing when no backup dir exists", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-empty-${Date.now()}`), {
      recursive: true,
    });
    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    expect(result.deleted).toEqual([]);
  });

  it("ignores non-date-named directories under merge-backup", () => {
    const dataRoot = mkdirSync(join(tmpdir(), `backup-junk-${Date.now()}`), {
      recursive: true,
    });
    const junkDir = join(dataRoot, ".co-engram", "merge-backup", "not-a-date");
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, "x"), "junk");

    const result = cleanupOldBackups({
      dataRoot,
      now: new Date("2026-06-26T12:00:00Z"),
    });
    expect(result.deleted).toEqual([]);
    expect(existsSync(junkDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/backup.test.ts`
Expected: FAIL with `Cannot find module './backup.js'` or `snapshotLoser is not a function`.

- [ ] **Step 3: Implement backup.ts**

Create `packages/core/src/merge/backup.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/backup.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/backup.ts packages/core/src/merge/backup.test.ts
git commit -m "feat(core/merge): add loser snapshot + 7-day TTL cleanup"
```

---

## Task 3: Frontmatter field classification + immutable / additive / max rules

**Files:**

- Create: `packages/core/src/merge/frontmatter-rules.ts`
- Create: `packages/core/src/merge/frontmatter-rules.test.ts`

**Interfaces:**

- Consumes: `EngramFrontmatter` from `../storage/engram-store.js`
- Produces:

  ```typescript
  export type FieldClass =
    | "immutable" // id, createdAt, createdBy — always base; ours/theirs changed → escalate
    | "additive" // retrievalCount etc. — merged = ours + theirs - base
    | "max" // updatedAt, version — max(ours, theirs)
    | "updatedAt_arbitrated" // title, summary, kind, tags, ... — needs Arbitrator
    | "recomputed" // contentHash, contentSize — recomputed post-merge
    | "legacy_derived"; // outgoingSynapseCount etc. — delete from merged frontmatter

  export function classifyField(fieldName: string): FieldClass;

  export interface SimpleMergeResult {
    readonly value: unknown;
    readonly changed: boolean; // did this field differ from base?
  }
  export function mergeImmutableField(params: {
    base: unknown;
    ours: unknown;
    theirs: unknown;
    fieldName: string;
  }): SimpleMergeResult; // always returns base; if ours or theirs differ → throws { kind: 'immutable_violation', fieldName, base, ours, theirs }

  export function mergeAdditiveField(params: {
    base: number;
    ours: number;
    theirs: number;
  }): SimpleMergeResult; // value = ours + theirs - base

  export function mergeMaxField(params: {
    base: number | string;
    ours: number | string;
    theirs: number | string;
  }): SimpleMergeResult; // value = max(ours, theirs)
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/frontmatter-rules.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  classifyField,
  mergeImmutableField,
  mergeAdditiveField,
  mergeMaxField,
  ImmutableViolationError,
} from "./frontmatter-rules.js";

describe("classifyField", () => {
  it("classifies immutable fields", () => {
    expect(classifyField("id")).toBe("immutable");
    expect(classifyField("createdAt")).toBe("immutable");
    expect(classifyField("createdBy")).toBe("immutable");
  });

  it("classifies additive numeric fields", () => {
    expect(classifyField("retrievalCount")).toBe("additive");
    expect(classifyField("effectiveRetrievals")).toBe("additive");
    expect(classifyField("failedUses")).toBe("additive");
    expect(classifyField("reinforcementScore")).toBe("additive");
    expect(classifyField("evidenceCount")).toBe("additive");
  });

  it("classifies max fields", () => {
    expect(classifyField("updatedAt")).toBe("max");
    expect(classifyField("lastRetrievedAt")).toBe("max");
    expect(classifyField("lastEffectiveAt")).toBe("max");
    expect(classifyField("version")).toBe("max");
  });

  it("classifies updatedAt_arbitrated fields", () => {
    expect(classifyField("title")).toBe("updatedAt_arbitrated");
    expect(classifyField("summary")).toBe("updatedAt_arbitrated");
    expect(classifyField("kind")).toBe("updatedAt_arbitrated");
    expect(classifyField("kinds")).toBe("updatedAt_arbitrated");
    expect(classifyField("importance")).toBe("updatedAt_arbitrated");
    expect(classifyField("confidence")).toBe("updatedAt_arbitrated");
    expect(classifyField("emotionalValence")).toBe("updatedAt_arbitrated");
    expect(classifyField("decayHalfLifeDays")).toBe("updatedAt_arbitrated");
    expect(classifyField("visibility")).toBe("updatedAt_arbitrated");
    expect(classifyField("status")).toBe("updatedAt_arbitrated");
    expect(classifyField("forcedFreshness")).toBe("updatedAt_arbitrated");
    expect(classifyField("verificationStatus")).toBe("updatedAt_arbitrated");
    expect(classifyField("encodingContext")).toBe("updatedAt_arbitrated");
    expect(classifyField("perspective")).toBe("updatedAt_arbitrated");
    expect(classifyField("domainTags")).toBe("updatedAt_arbitrated");
    expect(classifyField("contextTags")).toBe("updatedAt_arbitrated");
    expect(classifyField("tags")).toBe("updatedAt_arbitrated");
  });

  it("classifies recomputed fields", () => {
    expect(classifyField("contentHash")).toBe("recomputed");
    expect(classifyField("contentSize")).toBe("recomputed");
  });

  it("classifies legacy derived fields", () => {
    expect(classifyField("outgoingSynapseCount")).toBe("legacy_derived");
    expect(classifyField("incomingSynapseCount")).toBe("legacy_derived");
    expect(classifyField("activeContradictionCount")).toBe("legacy_derived");
  });

  it("classifies unknown fields as updatedAt_arbitrated (safe default)", () => {
    expect(classifyField("customField")).toBe("updatedAt_arbitrated");
  });
});

describe("mergeImmutableField", () => {
  it("returns base when both sides match base", () => {
    const result = mergeImmutableField({
      base: "01HXXX",
      ours: "01HXXX",
      theirs: "01HXXX",
      fieldName: "id",
    });
    expect(result).toEqual({ value: "01HXXX", changed: false });
  });

  it("throws ImmutableViolationError when ours changed id", () => {
    expect(() =>
      mergeImmutableField({
        base: "01HXXX",
        ours: "01HYYY",
        theirs: "01HXXX",
        fieldName: "id",
      }),
    ).toThrow(ImmutableViolationError);
  });

  it("throws ImmutableViolationError when theirs changed createdAt", () => {
    expect(() =>
      mergeImmutableField({
        base: "2026-01-01T00:00:00Z",
        ours: "2026-01-01T00:00:00Z",
        theirs: "2026-02-01T00:00:00Z",
        fieldName: "createdAt",
      }),
    ).toThrow(ImmutableViolationError);
  });
});

describe("mergeAdditiveField", () => {
  it("sums both deltas when both sides incremented", () => {
    // base=5, ours=7 (+2), theirs=6 (+1) → merged = 5+2+1 = 8
    const result = mergeAdditiveField({ base: 5, ours: 7, theirs: 6 });
    expect(result).toEqual({ value: 8, changed: true });
  });

  it("returns ours unchanged when theirs did not change", () => {
    const result = mergeAdditiveField({ base: 5, ours: 7, theirs: 5 });
    expect(result).toEqual({ value: 7, changed: true });
  });

  it("returns theirs when ours did not change", () => {
    const result = mergeAdditiveField({ base: 5, ours: 5, theirs: 9 });
    expect(result).toEqual({ value: 9, changed: true });
  });

  it("returns base when neither side changed", () => {
    const result = mergeAdditiveField({ base: 5, ours: 5, theirs: 5 });
    expect(result).toEqual({ value: 5, changed: false });
  });

  it("handles missing values by treating undefined as 0", () => {
    const result = mergeAdditiveField({
      base: undefined as unknown as number,
      ours: 3,
      theirs: 4,
    });
    expect(result).toEqual({ value: 7, changed: true });
  });
});

describe("mergeMaxField", () => {
  it("picks larger numeric value", () => {
    const result = mergeMaxField({ base: 1, ours: 5, theirs: 9 });
    expect(result).toEqual({ value: 9, changed: true });
  });

  it("picks later ISO timestamp", () => {
    const result = mergeMaxField({
      base: "2026-01-01T00:00:00Z",
      ours: "2026-06-01T00:00:00Z",
      theirs: "2026-03-01T00:00:00Z",
    });
    expect(result).toEqual({ value: "2026-06-01T00:00:00Z", changed: true });
  });

  it("returns unchanged when both sides equal base", () => {
    const result = mergeMaxField({ base: 5, ours: 5, theirs: 5 });
    expect(result).toEqual({ value: 5, changed: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/frontmatter-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement frontmatter-rules.ts**

Create `packages/core/src/merge/frontmatter-rules.ts`:

```typescript
/**
 * Frontmatter 字段分类 + 单字段合并规则
 *
 * 字段语义分类见 spec §4.2。每种分类有独立的合并规则。
 * updatedAt_arbitrated 字段不在此处处理(由 arbitration.ts 接管)。
 *
 * @module @co-engram/core/merge
 */

export type FieldClass =
  | "immutable"
  | "additive"
  | "max"
  | "updatedAt_arbitrated"
  | "recomputed"
  | "legacy_derived";

const IMMUTABLE_FIELDS = new Set(["id", "createdAt", "createdBy"]);
const ADDITIVE_FIELDS = new Set([
  "retrievalCount",
  "effectiveRetrievals",
  "failedUses",
  "reinforcementScore",
  "evidenceCount",
]);
const MAX_FIELDS = new Set([
  "updatedAt",
  "lastRetrievedAt",
  "lastEffectiveAt",
  "version",
]);
const RECOMPUTED_FIELDS = new Set(["contentHash", "contentSize"]);
const LEGACY_DERIVED_FIELDS = new Set([
  "outgoingSynapseCount",
  "incomingSynapseCount",
  "activeContradictionCount",
]);

export function classifyField(fieldName: string): FieldClass {
  if (IMMUTABLE_FIELDS.has(fieldName)) return "immutable";
  if (ADDITIVE_FIELDS.has(fieldName)) return "additive";
  if (MAX_FIELDS.has(fieldName)) return "max";
  if (RECOMPUTED_FIELDS.has(fieldName)) return "recomputed";
  if (LEGACY_DERIVED_FIELDS.has(fieldName)) return "legacy_derived";
  return "updatedAt_arbitrated";
}

export interface SimpleMergeResult {
  readonly value: unknown;
  readonly changed: boolean;
}

export class ImmutableViolationError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly base: unknown,
    public readonly ours: unknown,
    public readonly theirs: unknown,
  ) {
    super(
      `Immutable field "${fieldName}" was modified (base=${JSON.stringify(base)}, ours=${JSON.stringify(ours)}, theirs=${JSON.stringify(theirs)})`,
    );
    this.name = "ImmutableViolationError";
  }
}

export function mergeImmutableField(params: {
  base: unknown;
  ours: unknown;
  theirs: unknown;
  fieldName: string;
}): SimpleMergeResult {
  const { base, ours, theirs, fieldName } = params;
  if (ours !== base || theirs !== base) {
    throw new ImmutableViolationError(fieldName, base, ours, theirs);
  }
  return { value: base, changed: false };
}

export function mergeAdditiveField(params: {
  base: number | undefined;
  ours: number | undefined;
  theirs: number | undefined;
}): SimpleMergeResult {
  const base = params.base ?? 0;
  const ours = params.ours ?? 0;
  const theirs = params.theirs ?? 0;
  const value = ours + theirs - base;
  const changed = ours !== base || theirs !== base;
  return { value, changed };
}

export function mergeMaxField(params: {
  base: number | string;
  ours: number | string;
  theirs: number | string;
}): SimpleMergeResult {
  const { base, ours, theirs } = params;
  const value = ours > theirs ? ours : theirs;
  const changed = value !== base;
  return { value, changed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/frontmatter-rules.test.ts`
Expected: PASS — all classification + simple rule tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/frontmatter-rules.ts packages/core/src/merge/frontmatter-rules.test.ts
git commit -m "feat(core/merge): add frontmatter field classification + immutable/additive/max rules"
```

---

## Task 4: updatedAt arbitration + tiebreaker

**Files:**

- Create: `packages/core/src/merge/arbitration.ts`
- Create: `packages/core/src/merge/arbitration.test.ts`

**Interfaces:**

- Consumes: `EngramFrontmatter` fields (`updatedAt`, `contentHash`) from base/ours/theirs
- Produces:

  ```typescript
  export type ArbitrationVerdict = "ours" | "theirs" | "escalate";

  export function arbitrateByUpdatedAt(params: {
    oursUpdatedAt: string;
    theirsUpdatedAt: string;
    baseContentHash?: string;
    oursContentHash?: string;
    theirsContentHash?: string;
  }): ArbitrationVerdict;
  ```

  Returns `'ours'` when ours is strictly newer, `'theirs'` when theirs is strictly newer. On second-level collision (timestamps equal): if exactly one side's contentHash differs from base, that side wins; if both/neither changed → `'escalate'` (Phase 1 will leave git markers).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/arbitration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { arbitrateByUpdatedAt } from "./arbitration.js";

describe("arbitrateByUpdatedAt", () => {
  it("returns ours when ours.updatedAt is strictly newer", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T09:00:00Z",
      }),
    ).toBe("ours");
  });

  it("returns theirs when theirs.updatedAt is strictly newer", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T09:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
      }),
    ).toBe("theirs");
  });

  it("tiebreaker: ours wins when only ours changed contentHash", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "def",
        theirsContentHash: "abc",
      }),
    ).toBe("ours");
  });

  it("tiebreaker: theirs wins when only theirs changed contentHash", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "abc",
        theirsContentHash: "xyz",
      }),
    ).toBe("theirs");
  });

  it("escalates when both sides changed contentHash (no LLM in Phase 1)", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "def",
        theirsContentHash: "xyz",
      }),
    ).toBe("escalate");
  });

  it("escalates when neither side changed contentHash (ambiguous)", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
        baseContentHash: "abc",
        oursContentHash: "abc",
        theirsContentHash: "abc",
      }),
    ).toBe("escalate");
  });

  it("escalates when timestamps equal and no contentHash available", () => {
    expect(
      arbitrateByUpdatedAt({
        oursUpdatedAt: "2026-06-25T10:00:00Z",
        theirsUpdatedAt: "2026-06-25T10:00:00Z",
      }),
    ).toBe("escalate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/arbitration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement arbitration.ts**

Create `packages/core/src/merge/arbitration.ts`:

```typescript
/**
 * updatedAt 仲裁 + tiebreaker
 *
 * Layer A of spec §5.6 三层仲裁。当 ours.updatedAt != theirs.updatedAt 时直接判赢家;
 * 秒级碰撞时用 contentHash tiebreaker 判断"谁相对 base 真改了"。
 * 仍平局 → 返回 'escalate',由调用方决定(Phase 1: 留 git marker;Phase 3: 调 LLM)。
 *
 * @module @co-engram/core/merge
 */

export type ArbitrationVerdict = "ours" | "theirs" | "escalate";

export function arbitrateByUpdatedAt(params: {
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
  baseContentHash?: string;
  oursContentHash?: string;
  theirsContentHash?: string;
}): ArbitrationVerdict {
  const { oursUpdatedAt, theirsUpdatedAt } = params;

  if (oursUpdatedAt > theirsUpdatedAt) return "ours";
  if (theirsUpdatedAt > oursUpdatedAt) return "theirs";

  // 秒级碰撞 — 用 contentHash tiebreaker
  const base = params.baseContentHash;
  const oursChanged =
    params.oursContentHash !== undefined && params.oursContentHash !== base;
  const theirsChanged =
    params.theirsContentHash !== undefined && params.theirsContentHash !== base;

  if (oursChanged && !theirsChanged) return "ours";
  if (theirsChanged && !oursChanged) return "theirs";

  // 双方都改 / 双方都没改 / 无 contentHash 信号 → 升级
  return "escalate";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/arbitration.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/arbitration.ts packages/core/src/merge/arbitration.test.ts
git commit -m "feat(core/merge): add updatedAt arbitration with contentHash tiebreaker"
```

---

## Task 5: Frontmatter orchestrator

**Files:**

- Create: `packages/core/src/merge/frontmatter.ts`
- Create: `packages/core/src/merge/frontmatter.test.ts`

**Interfaces:**

- Consumes:
  - `EngramFrontmatter` from `../storage/engram-store.js`
  - `classifyField`, `mergeImmutableField`, `mergeAdditiveField`, `mergeMaxField`, `ImmutableViolationError` from `./frontmatter-rules.js`
  - `arbitrateByUpdatedAt` from `./arbitration.js`
  - `hashContent` for contentHash recompute (already in `../storage/hash.js` if present; otherwise inline SHA-256)
- Produces:

  ```typescript
  export interface FrontmatterMergeOutcome {
    readonly merged: Record<string, unknown>; // sanitized frontmatter (legacy_derived dropped)
    readonly strategy: string; // human-readable, e.g. "frontmatter: 3 additive + 2 max + 1 arbitrated(theirs)"
    readonly escalatedFields: readonly string[]; // fields where updatedAt arbitrated to 'escalate'
    readonly arbitratedWinner: "ours" | "theirs" | null; // null if no arbitrated field, or escalated
  }
  export function mergeFrontmatter(params: {
    base: EngramFrontmatter;
    ours: EngramFrontmatter;
    theirs: EngramFrontmatter;
  }): FrontmatterMergeOutcome;
  ```

  Behavior:
  - For each key in the union of `base | ours | theirs` keys:
    - `immutable` → call `mergeImmutableField`. On throw, add field to `escalatedFields` and use `base` value.
    - `additive` → `mergeAdditiveField`. Result is `value`.
    - `max` → `mergeMaxField`.
    - `updatedAt_arbitrated` → if only one side changed, use that side; if both changed, call `arbitrateByUpdatedAt`; on `'escalate'`, add to `escalatedFields` and use `ours` as placeholder (driver will leave markers anyway).
    - `recomputed` → skip for now (filled by `mergeEngram` after content merge).
    - `legacy_derived` → drop from merged.
  - Strategy string enumerates counts: `"frontmatter: {n_additive} additive + {n_max} max + {n_arbitrated} arbitrated({winner}|escalated)"`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/frontmatter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { EngramFrontmatter } from "../storage/engram-store.js";
import { mergeFrontmatter } from "./frontmatter.js";

function makeFrontmatter(
  overrides: Partial<EngramFrontmatter>,
): EngramFrontmatter {
  return {
    id: "01HXXX",
    title: "base title",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
    ...overrides,
  } as EngramFrontmatter;
}

describe("mergeFrontmatter", () => {
  it("additive-merges retrievalCount from both sides", () => {
    const base = makeFrontmatter({ retrievalCount: 5 });
    const ours = makeFrontmatter({
      retrievalCount: 7,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      retrievalCount: 6,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.retrievalCount).toBe(8); // 5 + (7-5) + (6-5)
  });

  it("max-merges updatedAt and version", () => {
    const base = makeFrontmatter({ version: 3 });
    const ours = makeFrontmatter({
      version: 4,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      version: 5,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.version).toBe(5);
    expect(outcome.merged.updatedAt).toBe("2026-06-02T00:00:00Z");
  });

  it("arbitrates title by updatedAt when both sides changed", () => {
    const base = makeFrontmatter({
      title: "base",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours-title",
      updatedAt: "2026-06-02T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs-title",
      updatedAt: "2026-06-03T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.title).toBe("theirs-title");
    expect(outcome.arbitratedWinner).toBe("theirs");
    expect(outcome.escalatedFields).toEqual([]);
  });

  it("escalates when updatedAt collides and both sides changed", () => {
    const base = makeFrontmatter({
      title: "base",
      contentHash: "abc",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const ours = makeFrontmatter({
      title: "ours-title",
      contentHash: "def",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      title: "theirs-title",
      contentHash: "xyz",
      updatedAt: "2026-06-01T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.escalatedFields).toContain("title");
    expect(outcome.arbitratedWinner).toBeNull();
  });

  it("drops legacy_derived fields", () => {
    const base = makeFrontmatter({
      outgoingSynapseCount: 3,
    } as Partial<EngramFrontmatter>);
    const ours = makeFrontmatter({
      outgoingSynapseCount: 4,
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({
      outgoingSynapseCount: 5,
    } as Partial<EngramFrontmatter>);

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.outgoingSynapseCount).toBeUndefined();
  });

  it("escalates when ours changes an immutable field", () => {
    const base = makeFrontmatter({});
    const ours = makeFrontmatter({
      id: "01HYYY",
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({});

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.escalatedFields).toContain("id");
    expect(outcome.merged.id).toBe("01HXXX"); // base value preserved
  });

  it("excludes contentHash and contentSize from merged (recomputed later)", () => {
    const base = makeFrontmatter({
      contentHash: "abc",
      contentSize: 100,
    } as Partial<EngramFrontmatter>);
    const ours = makeFrontmatter({
      contentHash: "def",
      contentSize: 110,
    } as Partial<EngramFrontmatter>);
    const theirs = makeFrontmatter({
      contentHash: "xyz",
      contentSize: 120,
    } as Partial<EngramFrontmatter>);

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.merged.contentHash).toBeUndefined();
    expect(outcome.merged.contentSize).toBeUndefined();
  });

  it("produces a human-readable strategy string", () => {
    const base = makeFrontmatter({ retrievalCount: 5 });
    const ours = makeFrontmatter({
      retrievalCount: 7,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const theirs = makeFrontmatter({
      retrievalCount: 6,
      updatedAt: "2026-06-02T00:00:00Z",
    });

    const outcome = mergeFrontmatter({ base, ours, theirs });

    expect(outcome.strategy).toMatch(/^frontmatter:/);
    expect(outcome.strategy).toContain("additive");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/frontmatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement frontmatter.ts**

Create `packages/core/src/merge/frontmatter.ts`:

```typescript
/**
 * Frontmatter 整体合并入口
 *
 * 遍历 base/ours/theirs 的所有字段 key,按 classifyField 分发到对应规则。
 * updatedAt_arbitrated 字段在双方都改时调 arbitrateByUpdatedAt;
 * 返回 'escalate' 时把字段名记入 escalatedFields(调用方应该 leave markers)。
 *
 * contentHash / contentSize 不在此处算,由 mergeEngram 在 content 合并后回填。
 *
 * @module @co-engram/core/merge
 */

import type { EngramFrontmatter } from "../storage/engram-store.js";
import {
  classifyField,
  mergeImmutableField,
  mergeAdditiveField,
  mergeMaxField,
  ImmutableViolationError,
} from "./frontmatter-rules.js";
import { arbitrateByUpdatedAt } from "./arbitration.js";

export interface FrontmatterMergeOutcome {
  readonly merged: Record<string, unknown>;
  readonly strategy: string;
  readonly escalatedFields: readonly string[];
  readonly arbitratedWinner: "ours" | "theirs" | null;
}

type Front = Record<string, unknown>;

function toRecord(fm: EngramFrontmatter): Front {
  return fm as unknown as Front;
}

function fieldChanged(base: Front, side: Front, key: string): boolean {
  return JSON.stringify(side[key]) !== JSON.stringify(base[key]);
}

export function mergeFrontmatter(params: {
  base: EngramFrontmatter;
  ours: EngramFrontmatter;
  theirs: EngramFrontmatter;
}): FrontmatterMergeOutcome {
  const base = toRecord(params.base);
  const ours = toRecord(params.ours);
  const theirs = toRecord(params.theirs);

  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  const merged: Record<string, unknown> = {};
  const escalatedFields: string[] = [];
  let nAdditive = 0;
  let nMax = 0;
  let nArbitrated = 0;
  let arbitratedWinner: "ours" | "theirs" | null = null;

  for (const key of allKeys) {
    const cls = classifyField(key);
    const baseV = base[key];
    const oursV = ours[key];
    const theirsV = theirs[key];

    if (cls === "legacy_derived") continue;
    if (cls === "recomputed") continue; // filled after content merge

    if (cls === "immutable") {
      try {
        const r = mergeImmutableField({
          base: baseV,
          ours: oursV,
          theirs: theirsV,
          fieldName: key,
        });
        merged[key] = r.value;
      } catch (e) {
        if (e instanceof ImmutableViolationError) {
          escalatedFields.push(key);
          merged[key] = baseV; // preserve base; driver will leave markers
        } else {
          throw e;
        }
      }
      continue;
    }

    if (cls === "additive") {
      const r = mergeAdditiveField({
        base: baseV as number | undefined,
        ours: oursV as number | undefined,
        theirs: theirsV as number | undefined,
      });
      merged[key] = r.value;
      nAdditive++;
      continue;
    }

    if (cls === "max") {
      const r = mergeMaxField({
        base: baseV as number | string,
        ours: oursV as number | string,
        theirs: theirsV as number | string,
      });
      merged[key] = r.value;
      nMax++;
      continue;
    }

    // updatedAt_arbitrated
    const oursChanged = fieldChanged(base, ours, key);
    const theirsChanged = fieldChanged(base, theirs, key);

    if (!oursChanged && !theirsChanged) {
      merged[key] = baseV;
      continue;
    }
    if (oursChanged && !theirsChanged) {
      merged[key] = oursV;
      nArbitrated++;
      arbitratedWinner = "ours";
      continue;
    }
    if (theirsChanged && !oursChanged) {
      merged[key] = theirsV;
      nArbitrated++;
      arbitratedWinner = "theirs";
      continue;
    }

    // both changed → arbitrate
    const verdict = arbitrateByUpdatedAt({
      oursUpdatedAt: ours.updatedAt as string,
      theirsUpdatedAt: theirs.updatedAt as string,
      baseContentHash: base.contentHash as string | undefined,
      oursContentHash: ours.contentHash as string | undefined,
      theirsContentHash: theirs.contentHash as string | undefined,
    });
    nArbitrated++;
    if (verdict === "escalate") {
      escalatedFields.push(key);
      merged[key] = oursV; // placeholder; driver will leave markers
      // Don't update arbitratedWinner on escalate; outcome tracks winner only on resolution
    } else {
      merged[key] = verdict === "ours" ? oursV : theirsV;
      arbitratedWinner = verdict;
    }
  }

  const winnerLabel =
    escalatedFields.length > 0 && nArbitrated > 0 && arbitratedWinner === null
      ? "escalated"
      : (arbitratedWinner ?? "none");
  const strategy = `frontmatter: ${nAdditive} additive + ${nMax} max + ${nArbitrated} arbitrated(${winnerLabel})`;

  return {
    merged,
    strategy,
    escalatedFields,
    arbitratedWinner: escalatedFields.length > 0 ? null : arbitratedWinner,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/frontmatter.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/frontmatter.ts packages/core/src/merge/frontmatter.test.ts
git commit -m "feat(core/merge): add frontmatter orchestrator with escalation tracking"
```

---

## Task 6: Content paragraph-level 3-way merge

**Files:**

- Create: `packages/core/src/merge/content.ts`
- Create: `packages/core/src/merge/content.test.ts`

**Interfaces:**

- Consumes: `child_process.spawnSync` for `git merge-file -p --diff3`
- Produces:

  ```typescript
  export interface ContentMergeOutcome {
    readonly merged: string;
    readonly strategy:
      | "git-3way-clean" // git merged without conflict
      | "updatedAt-fallback" // conflict; loser snapshot taken; winner's content used
      | "escalate"; // conflict + updatedAt collision; Phase 1 leaves markers
    readonly conflictMarkersPresent: boolean;
    readonly winner: "ours" | "theirs" | null;
  }
  export function mergeContent(params: {
    base: string;
    ours: string;
    theirs: string;
    oursUpdatedAt: string;
    theirsUpdatedAt: string;
    markerSize?: number; // default 7
  }): ContentMergeOutcome;
  ```

  Behavior:
  1. Write `base / ours / theirs` to temp files.
  2. Run `git merge-file -p --diff3 --marker-size=<n> ours.tmp base.tmp theirs.tmp`.
  3. If exit 0 → `{ merged: stdout, strategy: 'git-3way-clean', conflictMarkersPresent: false, winner: null }`.
  4. If exit non-zero → stdout contains `<<<<<<<` markers. Decide winner by updatedAt comparison:
     - ours > theirs → winner='ours', merged=ours (raw input), strategy='updatedAt-fallback'
     - theirs > ours → winner='theirs', merged=theirs, strategy='updatedAt-fallback'
     - equal → strategy='escalate', merged=stdout-with-markers (caller leaves markers)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/content.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeContent } from "./content.js";

describe("mergeContent", () => {
  it("returns clean merge when git 3-way succeeds", () => {
    const base = "Paragraph 1\n\nParagraph 2\n";
    const ours = "Paragraph 1 edited\n\nParagraph 2\n";
    const theirs = "Paragraph 1\n\nParagraph 2\nNew paragraph 3\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("git-3way-clean");
    expect(outcome.conflictMarkersPresent).toBe(false);
    expect(outcome.merged).toContain("Paragraph 1 edited");
    expect(outcome.merged).toContain("New paragraph 3");
  });

  it("falls back to theirs when both edited same paragraph and theirs is newer", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("updatedAt-fallback");
    expect(outcome.winner).toBe("theirs");
    expect(outcome.merged).toBe("Their revision\n");
    expect(outcome.conflictMarkersPresent).toBe(false);
  });

  it("falls back to ours when both edited same paragraph and ours is newer", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-03T00:00:00Z",
      theirsUpdatedAt: "2026-06-02T00:00:00Z",
    });

    expect(outcome.strategy).toBe("updatedAt-fallback");
    expect(outcome.winner).toBe("ours");
    expect(outcome.merged).toBe("Our revision\n");
  });

  it("escalates when both edited same paragraph and updatedAt collides", () => {
    const base = "Original paragraph\n";
    const ours = "Our revision\n";
    const theirs = "Their revision\n";

    const outcome = mergeContent({
      base,
      ours,
      theirs,
      oursUpdatedAt: "2026-06-01T00:00:00Z",
      theirsUpdatedAt: "2026-06-01T00:00:00Z",
    });

    expect(outcome.strategy).toBe("escalate");
    expect(outcome.winner).toBeNull();
    expect(outcome.conflictMarkersPresent).toBe(true);
    expect(outcome.merged).toContain("<<<<<<<");
    expect(outcome.merged).toContain(">>>>>>>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/content.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement content.ts**

Create `packages/core/src/merge/content.ts`:

```typescript
/**
 * Content body 段落级 3-way 合并
 *
 * 调 `git merge-file -p --diff3` 让 git 做机械合并。
 * 干净合并 → 直接用;有 marker → fallback updatedAt 取赢家整段;
 * updatedAt 一致 → escalate,把带 marker 的输出原样返回(由 driver 写入 %A + exit 1)。
 *
 * @module @co-engram/core/merge
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ContentMergeOutcome {
  readonly merged: string;
  readonly strategy: "git-3way-clean" | "updatedAt-fallback" | "escalate";
  readonly conflictMarkersPresent: boolean;
  readonly winner: "ours" | "theirs" | null;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function mergeContent(params: {
  base: string;
  ours: string;
  theirs: string;
  oursUpdatedAt: string;
  theirsUpdatedAt: string;
  markerSize?: number;
}): ContentMergeOutcome {
  const {
    base,
    ours,
    theirs,
    oursUpdatedAt,
    theirsUpdatedAt,
    markerSize = 7,
  } = params;

  const dir = mkdtempSync(join(tmpdir(), "co-engram-merge-"));
  const oursPath = join(dir, "ours.tmp");
  const basePath = join(dir, "base.tmp");
  const theirsPath = join(dir, "theirs.tmp");
  try {
    writeFileSync(oursPath, ours, "utf8");
    writeFileSync(basePath, base, "utf8");
    writeFileSync(theirsPath, theirs, "utf8");

    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "--diff3",
        `--marker-size=${markerSize}`,
        oursPath,
        basePath,
        theirsPath,
      ],
      { encoding: "utf8" },
    );

    // git merge-file: exit 0 = clean; exit >0 = conflict count; null = error
    const stdout = result.stdout ?? "";
    const hasMarkers = CONFLICT_MARKER_RE.test(stdout);

    if (!hasMarkers && result.status === 0) {
      return {
        merged: stdout,
        strategy: "git-3way-clean",
        conflictMarkersPresent: false,
        winner: null,
      };
    }

    // Conflict — try updatedAt fallback
    if (oursUpdatedAt > theirsUpdatedAt) {
      return {
        merged: ours,
        strategy: "updatedAt-fallback",
        conflictMarkersPresent: false,
        winner: "ours",
      };
    }
    if (theirsUpdatedAt > oursUpdatedAt) {
      return {
        merged: theirs,
        strategy: "updatedAt-fallback",
        conflictMarkersPresent: false,
        winner: "theirs",
      };
    }

    // updatedAt collision — escalate, pass through git's marked output
    return {
      merged: stdout,
      strategy: "escalate",
      conflictMarkersPresent: true,
      winner: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/content.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/content.ts packages/core/src/merge/content.test.ts
git commit -m "feat(core/merge): add git merge-file based content merge with updatedAt fallback"
```

---

## Task 7: EngramMerger entry (compose frontmatter + content + backup + audit)

**Files:**

- Create: `packages/core/src/merge/merge-engram.ts`
- Create: `packages/core/src/merge/merge-engram.test.ts`

**Interfaces:**

- Consumes:
  - `parseEngramFile`, `serializeEngramFile`, `isEngramFile` from `../storage/engram-store.js`
  - `mergeFrontmatter` from `./frontmatter.js`
  - `mergeContent` from `./content.js`
  - `snapshotLoser` from `./backup.js`
  - `AuditLog` from `../observability/audit-log.js`
  - `createHash` from `node:crypto` for contentHash recompute
- Produces:

  ```typescript
  export interface EngramMergeResult {
    readonly mergedContent: string; // full file content (frontmatter + body) to write to %A
    readonly strategy: string; // composite strategy description
    readonly winner: "ours" | "theirs" | null;
    readonly escalated: boolean; // true = driver should exit 1 after writing markers
    readonly backupPath?: string; // set when loser was snapshotted
  }
  export function mergeEngramFile(params: {
    baseRaw: string;
    oursRaw: string;
    theirsRaw: string;
    relPath: string; // for backup + audit
    dataRoot?: string; // optional; if absent, skip backup + audit
    auditLog?: AuditLog; // injectable for testing
  }): EngramMergeResult;
  ```

  Algorithm:
  1. Parse base/ours/theirs via `parseEngramFile`. On throw → return `{ mergedContent: originalRaw_with_markers_if_any, escalated: true, ... }` — actually: on parse error, return the raw ours with conflict markers so driver exits 1. Simpler: throw ParseError and let driver catch + exit 1.
  2. Run `mergeFrontmatter({ base, ours, theirs })`.
  3. Run `mergeContent({ base: base.content, ours: ours.content, theirs: theirs.content, oursUpdatedAt, theirsUpdatedAt })`.
  4. Recompute `contentHash = sha256(merged_content).hex()` and `contentSize = Buffer.byteLength(merged_content, 'utf8')`. Insert into merged frontmatter.
  5. If `frontmatter.escalatedFields.length > 0 || content.strategy === 'escalate'`:
     - Compose a file with conflict markers (manually constructed) OR just return the raw ours; caller will exit 1. Phase 1 simplest: return `{ mergedContent: oursRaw, escalated: true, strategy: 'escalate:frontmatter-or-content' }`. **Driver writes oursRaw to %A but exits 1 — this leaves git's AUTOMERGE in place, git then re-applies its own conflict markers** (we trust that if we exit non-zero, git uses its own previous conflict detection). **Wait — actually this needs more care. See step 6.**
  6. **Escalation protocol**: When escalated, write conflict markers manually into %A so the user sees them:
     ```typescript
     const escalatedContent = `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
     ```
     This way %A contains explicit markers and driver exits 1; git sees exit 1 and reports CONFLICT to the user; user opens file and sees our markers.
  7. **Non-escalated (success)**: Write serialized merged file (via `serializeEngramFile`) to %A. Snapshot loser via `snapshotLoser`. Append `merge_resolved` audit. If snapshot throws → append `merge_backup_failed` audit, but don't fail the merge.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/merge-engram.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../observability/audit-log.js";
import { mergeEngramFile } from "./merge-engram.js";

function engramRaw(overrides: Record<string, unknown>, body: string): string {
  const baseFm = {
    id: "01HXXX",
    title: "base title",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
  };
  const fm = { ...baseFm, ...overrides };
  const yaml = Object.entries(fm)
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`,
    )
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

describe("mergeEngramFile", () => {
  it("clean-merges non-overlapping frontmatter + content changes", () => {
    const base = engramRaw({ retrievalCount: 5 }, "Body");
    const ours = engramRaw(
      { retrievalCount: 7, updatedAt: "2026-06-01T00:00:00Z" },
      "Body",
    );
    const theirs = engramRaw(
      { retrievalCount: 6, updatedAt: "2026-06-02T00:00:00Z" },
      "Body + addition",
    );

    const result = mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
    });

    expect(result.escalated).toBe(false);
    expect(result.mergedContent).toContain("Body + addition");
    expect(result.mergedContent).toMatch(/retrievalCount:\s*8/);
  });

  it("snapshots loser when content falls back to theirs", () => {
    const dataRoot = mkdirSync(
      join(tmpdir(), `engram-merge-backup-${Date.now()}`),
      { recursive: true },
    );
    const auditLog = new AuditLog(dataRoot);

    const base = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Same body");
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours-title" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-02T00:00:00Z", title: "theirs-title" },
      "Their body",
    );

    const result = mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
      dataRoot,
      auditLog,
    });

    expect(result.winner).toBe("theirs");
    expect(result.backupPath).toBeDefined();
    expect(result.mergedContent).toContain("Their body");
  });

  it("escalates when updatedAt collides on both frontmatter and content", () => {
    const base = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "base" },
      "Base body",
    );
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "theirs" },
      "Their body",
    );

    const result = mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "engrams/AIOS/decision.md",
    });

    expect(result.escalated).toBe(true);
    expect(result.mergedContent).toContain("<<<<<<< ours");
    expect(result.mergedContent).toContain(">>>>>>> theirs");
  });

  it("recomputes contentHash and contentSize after content merge", () => {
    const base = engramRaw({}, "Body");
    const ours = engramRaw({ updatedAt: "2026-06-02T00:00:00Z" }, "Body ours");
    const theirs = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Body");

    const result = mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "test.md",
    });

    expect(result.mergedContent).toMatch(/contentHash:/);
    expect(result.mergedContent).toMatch(/contentSize:/);
  });

  it("skips backup + audit when dataRoot absent", () => {
    const base = engramRaw({}, "Body");
    const ours = engramRaw({ updatedAt: "2026-06-02T00:00:00Z" }, "Body ours");
    const theirs = engramRaw({ updatedAt: "2026-06-01T00:00:00Z" }, "Body");

    const result = mergeEngramFile({
      baseRaw: base,
      oursRaw: ours,
      theirsRaw: theirs,
      relPath: "test.md",
      // no dataRoot, no auditLog
    });

    expect(result.backupPath).toBeUndefined();
    expect(result.escalated).toBe(false);
  });

  it("throws on unparseable base file", () => {
    expect(() =>
      mergeEngramFile({
        baseRaw: "this is not a valid engram file",
        oursRaw: engramRaw({}, "Body"),
        theirsRaw: engramRaw({}, "Body"),
        relPath: "test.md",
      }),
    ).toThrow(/Invalid engram file/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/merge-engram.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement merge-engram.ts**

Create `packages/core/src/merge/merge-engram.ts`:

```typescript
/**
 * Engram 文件合并入口
 *
 * 组装 frontmatter 合并 + content 合并 + 收尾(contentHash / contentSize 重算,
 * updatedAt 取 max, version 取 max+1, updatedBy='merge-driver')。
 * 失败模式:任一方解析失败 → throw;frontmatter/content escalate → 用 git marker
 * 形式包装输给 driver 写 %A + exit 1。
 *
 * @module @co-engram/core/merge
 */

import { createHash } from "node:crypto";
import {
  parseEngramFile,
  serializeEngramFile,
  type EngramFile,
} from "../storage/engram-store.js";
import { mergeFrontmatter } from "./frontmatter.js";
import { mergeContent } from "./content.js";
import { snapshotLoser } from "./backup.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface EngramMergeResult {
  readonly mergedContent: string;
  readonly strategy: string;
  readonly winner: "ours" | "theirs" | null;
  readonly escalated: boolean;
  readonly backupPath?: string;
}

function computeContentHashAndSize(content: string): {
  hash: string;
  size: number;
} {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const size = Buffer.byteLength(content, "utf8");
  return { hash, size };
}

function buildEscalatedContent(oursRaw: string, theirsRaw: string): string {
  return `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
}

export function mergeEngramFile(params: {
  baseRaw: string;
  oursRaw: string;
  theirsRaw: string;
  relPath: string;
  dataRoot?: string;
  auditLog?: AuditLog;
}): EngramMergeResult {
  const { baseRaw, oursRaw, theirsRaw, relPath, dataRoot, auditLog } = params;

  // Step 1: Parse (may throw — caller exits 1)
  const baseFile = parseEngramFile(baseRaw);
  const oursFile = parseEngramFile(oursRaw);
  const theirsFile = parseEngramFile(theirsRaw);

  // Step 2: Frontmatter merge
  const fmOutcome = mergeFrontmatter({
    base: baseFile.frontmatter,
    ours: oursFile.frontmatter,
    theirs: theirsFile.frontmatter,
  });

  // Step 3: Content merge
  const contentOutcome = mergeContent({
    base: baseFile.content,
    ours: oursFile.content,
    theirs: theirsFile.content,
    oursUpdatedAt: oursFile.frontmatter.updatedAt,
    theirsUpdatedAt: theirsFile.frontmatter.updatedAt,
  });

  // Step 4: Decide escalation
  const escalated =
    fmOutcome.escalatedFields.length > 0 ||
    contentOutcome.strategy === "escalate";

  if (escalated) {
    const strategyParts: string[] = [];
    if (fmOutcome.escalatedFields.length > 0) {
      strategyParts.push(
        `frontmatter-escalate:${fmOutcome.escalatedFields.join(",")}`,
      );
    }
    if (contentOutcome.strategy === "escalate") {
      strategyParts.push("content-escalate:updatedAt-collision");
    }
    return {
      mergedContent: buildEscalatedContent(oursRaw, theirsRaw),
      strategy: `escalate(${strategyParts.join(" + ")})`,
      winner: null,
      escalated: true,
    };
  }

  // Step 5: Recompute contentHash / contentSize + finalize
  // updatedAt / version are 'max' fields — orchestrator already computed max(ours, theirs).
  // Per spec §4.5 we additionally:
  //   - bump version by +1 (merge produces a new state)
  //   - set updatedBy = 'merge-driver'
  const { hash, size } = computeContentHashAndSize(contentOutcome.merged);
  const oursVersion = (oursFile.frontmatter.version as number | undefined) ?? 0;
  const theirsVersion =
    (theirsFile.frontmatter.version as number | undefined) ?? 0;
  const mergedFm: Record<string, unknown> = {
    ...fmOutcome.merged,
    contentHash: hash,
    contentSize: size,
    updatedBy: "merge-driver",
    version: Math.max(oursVersion, theirsVersion) + 1,
  };
  // fmOutcome.merged.updatedAt is already max(ours, theirs) via the 'max' rule; leave as-is.
  // Guard against the case where both sides omitted updatedAt (rare; treat as Date.now).
  if (mergedFm.updatedAt === undefined) {
    mergedFm.updatedAt = new Date().toISOString();
  }

  const mergedFile: EngramFile = {
    frontmatter: mergedFm as EngramFile["frontmatter"],
    content: contentOutcome.merged,
  };
  const serialized = serializeEngramFile(mergedFile);

  // Step 6: Backup + audit
  let backupPath: string | undefined;
  const loserSide =
    contentOutcome.winner === "ours"
      ? "theirs"
      : contentOutcome.winner === "theirs"
        ? "ours"
        : null;
  if (loserSide && dataRoot) {
    try {
      const backup = snapshotLoser({
        dataRoot,
        relPath,
        side: loserSide,
        content: loserSide === "ours" ? oursRaw : theirsRaw,
      });
      backupPath = backup.backupPath;
    } catch (e) {
      auditLog?.append({
        actor: "system",
        action: "merge_backup_failed",
        metadata: {
          path: relPath,
          reason: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  auditLog?.append({
    actor: "system",
    action: "merge_resolved",
    engramId: mergedFm.id as string | undefined,
    metadata: {
      path: relPath,
      strategy: `${fmOutcome.strategy} + ${contentOutcome.strategy}`,
      winner: contentOutcome.winner ?? fmOutcome.arbitratedWinner,
      backupPath,
    },
  });

  return {
    mergedContent: serialized,
    strategy: `${fmOutcome.strategy} + ${contentOutcome.strategy}`,
    winner: contentOutcome.winner ?? fmOutcome.arbitratedWinner,
    escalated: false,
    backupPath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/merge-engram.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/merge-engram.ts packages/core/src/merge/merge-engram.test.ts
git commit -m "feat(core/merge): add engram file merger with content recompute + backup + audit"
```

---

## Task 8: Driver CLI entry + path routing

**Files:**

- Create: `packages/core/src/merge/driver-main.ts`
- Create: `packages/core/src/merge/driver-main.test.ts`
- Create: `packages/core/src/merge/data-root.ts`
- Create: `packages/core/src/merge/data-root.test.ts`
- Create: `packages/core/src/merge/version.ts`

**Interfaces:**

- Consumes:
  - `mergeEngramFile` from `./merge-engram.js`
  - `isEngramFile` from `../storage/engram-store.js`
  - `AuditLog` from `../observability/audit-log.js`
  - `findDataRoot` from `./data-root.js`
  - `DRIVER_BUNDLE_VERSION` from `./version.js`
- Produces:
  - `data-root.ts`:
    ```typescript
    export function findDataRoot(startPath: string): string | null;
    // Walk up from startPath; return the first dir containing `.co-engram/` subdir; null at filesystem root
    ```
  - `version.ts`:
    ```typescript
    export const DRIVER_BUNDLE_VERSION = "0.1.0" as const;
    ```
  - `driver-main.ts`:
    ```typescript
    export function runDriver(argv: string[]): {
      exitCode: number;
      stderr?: string;
    };
    // argv = [nodePath, scriptPath, %O, %A, %B, %L, %P]
    // 1. Validate argv length
    // 2. Read base/ours/theirs files
    // 3. Detect engram (isEngramFile on base, fallback to ours)
    //    - Not engram → run git merge-file on the three; write result to %A; exit with git's status
    //    - Is engram → call mergeEngramFile; write mergedContent to %A; exit 0 if !escalated, else exit 1
    // 4. On any thrown error → write conflict-marked wrapper to %A; exit 1
    ```
  - `main()` ESM entrypoint: when `import.meta.url === argv[1]`, call `process.exitCode = runDriver(process.argv).exitCode`

- [ ] **Step 1: Write the failing test for data-root.ts**

Create `packages/core/src/merge/data-root.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDataRoot } from "./data-root.js";

describe("findDataRoot", () => {
  it("finds the dir containing .co-engram/ when walking up", () => {
    const root = mkdtempSync(join(tmpdir(), "data-root-"));
    mkdirSync(join(root, ".co-engram"), { recursive: true });
    mkdirSync(join(root, "engrams", "AIOS"), { recursive: true });

    const result = findDataRoot(join(root, "engrams", "AIOS", "decision.md"));
    expect(result).toBe(root);
  });

  it("returns null when no .co-engram/ found", () => {
    const root = mkdtempSync(join(tmpdir(), "no-marker-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(findDataRoot(join(root, "sub", "file.md"))).toBeNull();
  });

  it("returns null at filesystem root", () => {
    expect(findDataRoot("/")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement data-root.ts**

Create `packages/core/src/merge/data-root.ts`:

```typescript
/**
 * Walk up from a file path to find the team memory data root.
 *
 * Data root = the directory containing the `.co-engram/` subdir.
 *
 * @module @co-engram/core/merge
 */

import { existsSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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
```

- [ ] **Step 3: Run data-root test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/data-root.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 4: Write the failing test for driver-main.ts**

Create `packages/core/src/merge/driver-main.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDriver } from "./driver-main.js";

function engramRaw(overrides: Record<string, unknown>, body: string): string {
  const baseFm = {
    id: "01HXXX",
    title: "base",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
  };
  const fm = { ...baseFm, ...overrides };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

describe("runDriver", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driver-test-"));
    mkdirSync(join(dir, ".co-engram"), { recursive: true });
    mkdirSync(join(dir, "engrams", "AIOS"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit 0 and writes merged content for clean engram merge", () => {
    const base = engramRaw({ retrievalCount: 5 }, "Body");
    const ours = engramRaw(
      { retrievalCount: 7, updatedAt: "2026-06-01T00:00:00Z" },
      "Body",
    );
    const theirs = engramRaw(
      { retrievalCount: 6, updatedAt: "2026-06-02T00:00:00Z" },
      "Body + addition",
    );

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md"); // acts as %A
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(0);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("Body + addition");
    expect(written).toMatch(/retrievalCount:\s*8/);
  });

  it("returns exit 1 and writes conflict markers when escalated", () => {
    const base = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "base" },
      "Base body",
    );
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "theirs" },
      "Their body",
    );

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(1);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<< ours");
    expect(written).toContain(">>>>>>> theirs");
  });

  it("transparently falls back to git merge-file for non-engram .md files", () => {
    const base = "# README\n\nLine 1\n\nLine 2\n";
    const ours = "# README\n\nLine 1 edited\n\nLine 2\n";
    const theirs = "# README\n\nLine 1\n\nLine 2\n\nLine 3\n";

    const baseP = join(dir, "README.base.md");
    const oursP = join(dir, "README.md");
    const theirsP = join(dir, "README.theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(0);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("Line 1 edited");
    expect(written).toContain("Line 3");
  });

  it("exits 1 when given wrong number of args", () => {
    const result = runDriver(["node", "driver.js", "only-one-arg"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage|expected|arguments/i);
  });

  it("exits 1 when base file is unparseable as engram but starts with frontmatter", () => {
    // Not a valid engram (no id, no title), but frontmatter-like — driver should escalate via thrown error
    const broken = "---\nbad: frontmatter\n---\n\nNo id or title\n";
    const valid = engramRaw({}, "Body");

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, broken);
    writeFileSync(oursP, valid);
    writeFileSync(theirsP, valid);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(1);
  });
});
```

- [ ] **Step 5: Implement version.ts**

Create `packages/core/src/merge/version.ts`:

```typescript
/**
 * Driver bundle version (single source of truth).
 *
 * Bumped on any change to driver behavior. Onboard uses this to decide
 * whether to overwrite ~/.co-engram/merge-driver.js.
 *
 * @module @co-engram/core/merge
 */

export const DRIVER_BUNDLE_VERSION = "0.1.0";
```

- [ ] **Step 6: Implement driver-main.ts**

Create `packages/core/src/merge/driver-main.ts`:

```typescript
#!/usr/bin/env node
/**
 * Git merge driver CLI entry.
 *
 * Git invokes: `node driver.js %O %A %B %L %P`
 *   %O = base (common ancestor)        argv[2]
 *   %A = ours (also the output target)  argv[3]
 *   %B = theirs                         argv[4]
 *   %L = conflict marker size           argv[5]
 *   %P = repo-relative path             argv[6]
 *
 * Behavior:
 *   - Detect engram (isEngramFile). If yes → mergeEngramFile.
 *   - Not engram → delegate to `git merge-file` (transparent fallback).
 *   - Escalation → write conflict markers + exit 1.
 *   - Any thrown error → write conflict markers + exit 1.
 *
 * @module @co-engram/core/merge
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isEngramFile } from "../storage/engram-store.js";
import { mergeEngramFile } from "./merge-engram.js";
import { findDataRoot } from "./data-root.js";
import { AuditLog } from "../observability/audit-log.js";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

const USAGE = "usage: co-engram-merge-driver %O %A %B %L %P";

export function runDriver(argv: string[]): {
  exitCode: number;
  stderr?: string;
} {
  const args = argv.slice(2);
  if (args.length < 5) {
    return { exitCode: 1, stderr: USAGE };
  }

  const [baseP, oursP, theirsP, markerSizeStr, pathArg] = args;
  const markerSize = parseInt(markerSizeStr, 10) || 7;

  let baseRaw: string, oursRaw: string, theirsRaw: string;
  try {
    baseRaw = readFileSync(baseP, "utf8");
    oursRaw = readFileSync(oursP, "utf8");
    theirsRaw = readFileSync(theirsP, "utf8");
  } catch (e) {
    return {
      exitCode: 1,
      stderr: `co-engram-merge-driver: failed to read input files: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Route: engram vs non-engram
  const isEngram =
    isEngramFile(oursRaw) || isEngramFile(baseRaw) || isEngramFile(theirsRaw);

  if (!isEngram) {
    // Transparent fallback: let git merge-file do its thing
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        `--marker-size=${markerSize}`,
        oursP,
        baseP,
        theirsP,
      ],
      { encoding: "utf8" },
    );
    if (result.stdout !== null) {
      writeFileSync(oursP, result.stdout, "utf8");
    }
    // exit status: 0 = clean, >0 = conflict count, null = error
    return { exitCode: result.status ?? 1 };
  }

  // Engram merge
  let dataRoot: string | null = null;
  try {
    dataRoot = findDataRoot(oursP);
  } catch {
    dataRoot = null;
  }
  const auditLog = dataRoot ? new AuditLog(dataRoot) : undefined;

  try {
    const result = mergeEngramFile({
      baseRaw,
      oursRaw,
      theirsRaw,
      relPath: pathArg,
      dataRoot: dataRoot ?? undefined,
      auditLog,
    });
    writeFileSync(oursP, result.mergedContent, "utf8");

    if (result.escalated) {
      auditLog?.append({
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: {
          path: pathArg,
          reason: result.strategy,
        },
      });
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  } catch (e) {
    // Parse error or other thrown — leave markers, exit 1
    const msg = e instanceof Error ? e.message : String(e);
    const wrapped = `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
    writeFileSync(oursP, wrapped, "utf8");
    auditLog?.append({
      actor: "system",
      action: "merge_conflict_escalated",
      metadata: { path: pathArg, reason: `driver-error: ${msg}` },
    });
    return { exitCode: 1, stderr: `co-engram-merge-driver: ${msg}` };
  }
}

// ESM entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const { exitCode } = runDriver(process.argv);
  if (exitCode !== 0 && process.stderr) {
    // Error context already provided via return value; nothing else to emit
  }
  process.exitCode = exitCode;
}

// Re-export for introspection by the bundle
export { DRIVER_BUNDLE_VERSION };
```

- [ ] **Step 7: Run driver-main test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/driver-main.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 8: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/version.ts packages/core/src/merge/data-root.ts packages/core/src/merge/data-root.test.ts packages/core/src/merge/driver-main.ts packages/core/src/merge/driver-main.test.ts
git commit -m "feat(core/merge): add driver CLI entry with engram/non-engram routing + data-root detection"
```

---

## Task 9: esbuild bundle configuration

**Files:**

- Create: `packages/core/src/merge/bundle.ts`
- Modify: `packages/core/package.json` (add esbuild devDep + `build:merge-driver` script)

**Interfaces:**

- Consumes: `esbuild` (new devDep)
- Produces:
  - `dist/merge-driver.js` — standalone CommonJS or ESM bundle with all deps inlined
  - Bundle header: `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}` for onboard version detection
  - `pnpm build:merge-driver` script

- [ ] **Step 1: Add esbuild devDep**

Run: `cd packages/core && pnpm add -D esbuild@^0.24.0`

Expected: `package.json` now includes `"esbuild": "^0.24.0"` under `devDependencies`. `pnpm-lock.yaml` updates.

- [ ] **Step 2: Create the bundle program**

Create `packages/core/src/merge/bundle.ts`:

```typescript
/**
 * esbuild 程序化构建配置
 *
 * 产出: dist/merge-driver.js — 单文件 bundle,所有 deps inlined。
 * bundle 文件头含 DRIVER_BUNDLE_VERSION 注释,供 onboard 检测版本。
 *
 * @module @co-engram/core/merge
 */

import { build } from "esbuild";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

export interface BundleOptions {
  readonly entryPoint: string; // absolute path to driver-main.ts
  readonly outfile: string; // absolute path to dist/merge-driver.js
  readonly minify?: boolean; // default false for debuggability
}

export async function buildMergeDriverBundle(
  opts: BundleOptions,
): Promise<void> {
  await build({
    entryPoints: [opts.entryPoint],
    bundle: true,
    platform: "node",
    format: "cjs", // cjs for max compatibility with node direct invocation
    target: "node22",
    outfile: opts.outfile,
    minify: opts.minify ?? false,
    sourcemap: false,
    banner: {
      js: `// co-engram-merge-driver v${DRIVER_BUNDLE_VERSION}\n// Auto-generated by pnpm build:merge-driver. Do not edit by hand.`,
    },
    external: [], // inline everything (no runtime deps)
  });
}

// CLI entry: `node --experimental-strip-types src/merge/bundle.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const entry = new URL("./driver-main.ts", import.meta.url).pathname;
  const outfile = new URL("../../dist/merge-driver.js", import.meta.url)
    .pathname;
  buildMergeDriverBundle({ entryPoint: entry, outfile })
    .then(() => {
      console.log(`[merge-driver] bundle written to ${outfile}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[merge-driver] bundle failed:`, e);
      process.exit(1);
    });
}
```

- [ ] **Step 3: Add the build script**

Edit `packages/core/package.json`. Find the `"scripts"` section and add:

```json
    "build:merge-driver": "node --experimental-strip-types src/merge/bundle.ts",
```

Also update the existing `"build"` script so it includes the bundle:

```json
    "build": "tsc -p tsconfig.json && pnpm build:merge-driver",
```

- [ ] **Step 4: Run the build and verify the bundle is created**

Run: `cd packages/core && pnpm build:merge-driver`
Expected output:

```
[merge-driver] bundle written to /home/10192021@zte.intra/AIOS/co-engram/packages/core/dist/merge-driver.js
```

Verify:

```bash
ls -la packages/core/dist/merge-driver.js
head -2 packages/core/dist/merge-driver.js
```

Expected: file exists, ~200-500KB; first line is `// co-engram-merge-driver v0.1.0`.

- [ ] **Step 5: Smoke-test the bundle directly**

Run:

```bash
cd /tmp
mkdir -p smoke-test/.co-engram smoke-test/engrams
cd smoke-test
cat > base.md <<'EOF'
---
id: "01HXXX"
title: "base"
kind: "observation"
createdBy: "a"
createdAt: "2026-01-01T00:00:00Z"
updatedBy: "a"
updatedAt: "2026-06-01T00:00:00Z"
version: 1
domainTags: ["AIOS"]
---

Body.
EOF
cp base.md ours.md
cp base.md theirs.md
# Modify ours/theirs differently
sed -i 's/Body\./Body from ours./' ours.md
sed -i 's/Body\./Body from theirs./' theirs.md
# Make theirs win by updatedAt
sed -i 's/updatedAt: "2026-06-01T00:00:00Z"/updatedAt: "2026-06-02T00:00:00Z"/' theirs.md

node /home/10192021@zte.intra/AIOS/co-engram/packages/core/dist/merge-driver.js base.md ours.md theirs.md 7 engrams/decision.md
echo "exit=$?"
cat ours.md
```

Expected: exit=0; ours.md now contains "Body from theirs." (winner).

- [ ] **Step 6: Add an .gitignore for dist if not present**

Check: `cat packages/core/.gitignore 2>/dev/null || echo "no gitignore"`
If `dist/` is not ignored, add `.gitignore`:

```
dist/
```

(Skip this step if `dist/` is already ignored at repo root.)

- [ ] **Step 7: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/bundle.ts packages/core/package.json packages/core/.gitignore
git commit -m "build(core/merge): add esbuild bundle for standalone merge-driver.js"
```

---

## Task 10: Onboard module (install driver bundle + .gitattributes + .git/config)

**Files:**

- Create: `packages/core/src/merge/onboard.ts`
- Create: `packages/core/src/merge/onboard.test.ts`

**Interfaces:**

- Consumes:
  - `DRIVER_BUNDLE_VERSION` from `./version.js`
  - `readFileSync, writeFileSync, existsSync, copyFileSync` from `node:fs`
  - `execSync` from `node:child_process`
  - `join, dirname` from `node:path`
  - `homedir` from `node:os`
- Produces:

  ```typescript
  export interface OnboardResult {
    readonly bundlePath: string; // ~/.co-engram/merge-driver.js
    readonly bundleUpgraded: boolean; // true if bundle was overwritten
    readonly gitConfigWritten: boolean;
    readonly gitattributesUpdated: boolean; // true if entry appended
  }
  export function installMergeDriver(params: {
    repoRoot: string;
    bundleSourcePath: string; // path to packages/core/dist/merge-driver.js
  }): OnboardResult;

  export const GITATTRIBUTES_ENTRY = `# co-engram structured merge driver
  **/*.md            merge=co-engram
  synapses/**/*.yaml merge=co-engram
  `;
  ```

  Algorithm:
  1. Resolve `bundleDest = ~/.co-engram/merge-driver.js`. If `!exists(bundleDest)` OR existing file's first line `// co-engram-merge-driver v<X>` doesn't match `DRIVER_BUNDLE_VERSION` → copy. Else skip.
  2. Run `git config merge.co-engram.name "co-engram structured merge"` (cwd=reporoot).
  3. Run `git config merge.co-engram.driver "node ${bundleDest} %O %A %B %L %P"`.
  4. If `.gitattributes` doesn't contain `merge=co-engram` line → append `GITATTRIBUTES_ENTRY`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/merge/onboard.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { installMergeDriver, GITATTRIBUTES_ENTRY } from "./onboard.js";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

function initGitRepo(dir: string): void {
  execSync(`git init -q`, { cwd: dir });
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

    bundleSource = join(fakeHome, "fake-bundle.js");
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

  it("copies bundle to ~/.co-engram/merge-driver.js on first install", () => {
    const result = installMergeDriver({
      repoRoot: repo,
      bundleSourcePath: bundleSource,
    });
    expect(result.bundleUpgraded).toBe(true);
    expect(existsSync(join(fakeHome, ".co-engram", "merge-driver.js"))).toBe(
      true,
    );
    const written = readFileSync(
      join(fakeHome, ".co-engram", "merge-driver.js"),
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
    expect(driver).toContain(join(fakeHome, ".co-engram", "merge-driver.js"));
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test src/merge/onboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement onboard.ts**

Create `packages/core/src/merge/onboard.ts`:

```typescript
/**
 * Onboard: 把 driver bundle + .gitattributes + .git/config 装到目标仓库。
 *
 * Phase 1: 由测试 + `co-engram git enable`(Phase 2 加)手动调用。
 * Phase 2: 接入 plugin 启动时的自动检测。
 *
 * @module @co-engram/core/merge
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DRIVER_BUNDLE_VERSION } from "./version.js";

export const GITATTRIBUTES_ENTRY = `# co-engram structured merge driver
**/*.md            merge=co-engram
synapses/**/*.yaml merge=co-engram
`;

const BUNDLE_RELATIVE_PATH = ".co-engram/merge-driver.js";
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

  // 1. Bundle copy
  const home = homedir();
  const bundleDest = join(home, BUNDLE_RELATIVE_PATH);
  let bundleUpgraded = false;
  const installed = readInstalledVersion(bundleDest);
  if (installed !== DRIVER_BUNDLE_VERSION) {
    mkdirSync(dirname(bundleDest), { recursive: true });
    copyFileSync(bundleSourcePath, bundleDest);
    bundleUpgraded = true;
  }

  // 2. .git/config
  execSync('git config merge.co-engram.name "co-engram structured merge"', {
    cwd: repoRoot,
  });
  execSync(
    `git config merge.co-engram.driver "node ${bundleDest} %O %A %B %L %P"`,
    { cwd: repoRoot },
  );

  // 3. .gitattributes (idempotent)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test src/merge/onboard.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/onboard.ts packages/core/src/merge/onboard.test.ts
git commit -m "feat(core/merge): add installMergeDriver (bundle + .gitattributes + .git/config)"
```

---

## Task 11: Real git merge driver end-to-end integration test

**Files:**

- Create: `packages/core/src/merge/git-merge-driver.e2e.test.ts`

**Interfaces:**

- Consumes:
  - `installMergeDriver` from `./onboard.js`
  - `DRIVER_BUNDLE_VERSION` from `./version.js`
  - `execSync, spawnSync` from `node:child_process`
  - Path to the built bundle: `packages/core/dist/merge-driver.js` (must be built before running)
- Produces: A vitest e2e test that proves the driver is invoked by real git during `git merge`, and resolves engram conflicts correctly.

- [ ] **Step 1: Write the e2e test**

Create `packages/core/src/merge/git-merge-driver.e2e.test.ts`:

```typescript
/**
 * End-to-end test: real `git merge` invokes our driver and resolves engram conflict.
 *
 * Requires dist/merge-driver.js to be built (`pnpm build:merge-driver`).
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
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { installMergeDriver } from "./onboard.js";

const BUNDLE_PATH = resolve(__dirname, "../../dist/merge-driver.js");

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

      // Init repo with main branch
      sh("git init -q -b main", repo);
      sh("git config user.email test@test.com", repo);
      sh("git config user.name Test", repo);

      // Install driver
      installMergeDriver({ repoRoot: repo, bundleSourcePath: BUNDLE_PATH });

      // Verify .git/config got the entry
      const driverLine = sh("git config merge.co-engram.driver", repo);
      expect(driverLine).toContain(BUNDLE_PATH);
    });

    it("auto-resolves a retrievalCount merge via driver", () => {
      // Commit base on main
      const baseRel = "engrams/AIOS/decision.md";
      const baseDir = join(repo, "engrams", "AIOS");
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(
        join(repo, baseRel),
        engramRaw("01HE2E0001", "2026-06-01T00:00:00Z", "Base body."),
      );
      sh(`git add engrams/ && git commit -q -m base`, repo);

      // Branch feature: bump retrievalCount + updatedAt
      sh("git checkout -q -b feature", repo);
      writeFileSync(
        join(repo, baseRel),
        engramRaw("01HE2E0001", "2026-06-02T00:00:00Z", "Base body.").replace(
          "version: 1",
          "version: 1\nretrievalCount: 7",
        ),
      );
      sh("git add -A && git commit -q -m feature", repo);

      // Back to main: different bump
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

      // Merge feature → triggers driver
      const result = execSync("git merge feature 2>&1", {
        cwd: repo,
        encoding: "utf8",
      });
      expect(result).toMatch(/Auto-merging|Merge made/);

      // The merged file should have retrievalCount = 5 + (7-5) + (6-5) = 8
      // (base had no retrievalCount = 0; ours=7 + theirs=6 - base=0 = 13)
      // Actually base has no retrievalCount; additive rule treats undefined as 0:
      //   merged = ours(7) + theirs(6) - base(0) = 13
      const merged = readFileSync(join(repo, baseRel), "utf8");
      const match = merged.match(/retrievalCount:\s*(\d+)/);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(13);

      // content should include main edit (newer updatedAt)
      expect(merged).toContain("Base body + main edit.");
    });

    it("falls back to git default behavior when driver script missing", () => {
      // Simulate missing driver by setting an invalid path
      const repo2 = mkdtempSync(join(tmpdir(), "e2e-broken-"));
      sh("git init -q -b main", repo2);
      sh("git config user.email test@test.com", repo2);
      sh("git config user.name Test", repo2);
      sh('git config merge.co-engram.name "co-engram"', repo2);
      sh(
        'git config merge.co-engram.driver "node /nonexistent/path.js %O %A %B %L %P"',
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

      // git will try to invoke the missing driver, fail, and fall back to default text merge
      // Since both sides changed the same line, git will produce conflict markers
      let mergeResult: string;
      try {
        mergeResult = execSync("git merge feat 2>&1", {
          cwd: repo2,
          encoding: "utf8",
        });
      } catch (e) {
        mergeResult = (e as { stdout?: string; stderr?: string }).stdout ?? "";
      }

      // git should report CONFLICT or fall back. Either way, repo is not corrupted.
      expect(mergeResult).toMatch(
        /CONFLICT|Automatic merge failed|Auto-merging/,
      );

      rmSync(repo2, { recursive: true, force: true });
    });
  },
);
```

- [ ] **Step 2: Build the bundle**

Run: `cd packages/core && pnpm build:merge-driver`
Expected: bundle built at `packages/core/dist/merge-driver.js`.

- [ ] **Step 3: Run the e2e test**

Run: `cd packages/core && pnpm test src/merge/git-merge-driver.e2e.test.ts`
Expected: PASS — 2 tests green.

If any test fails, debug by:

- Running `git merge` manually in the temp dir (add `console.log(repo)` to inspect)
- Checking `.git/config` has the driver entry
- Confirming the bundle path resolves correctly

- [ ] **Step 4: Run full merge test suite**

Run: `cd packages/core && pnpm test src/merge/`
Expected: ALL tests across all merge modules pass.

- [ ] **Step 5: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/git-merge-driver.e2e.test.ts
git commit -m "test(core/merge): add real git merge end-to-end integration test"
```

---

## Task 12: Failure-mode tests + barrel export

**Files:**

- Create: `packages/core/src/merge/driver-failure.test.ts`
- Create: `packages/core/src/merge/index.ts` (barrel)
- Modify (optional): `packages/core/src/index.ts` if barrel pattern exists

**Interfaces:**

- Consumes: `runDriver` from `./driver-main.js`
- Produces:
  - Test coverage for spec §10.1 failure modes:
    - Driver argv missing
    - Driver base file unparseable as engram
    - Driver base file unreadable (permission denied simulated by passing nonexistent path)
    - Driver crashes (mock mergeEngramFile to throw)
  - Barrel `packages/core/src/merge/index.ts` re-exports:
    ```typescript
    export * from "./version.js";
    export * from "./backup.js";
    export * from "./frontmatter-rules.js";
    export * from "./arbitration.js";
    export * from "./frontmatter.js";
    export * from "./content.js";
    export * from "./merge-engram.js";
    export * from "./data-root.js";
    export * from "./driver-main.js";
    export * from "./onboard.js";
    ```

- [ ] **Step 1: Write failure-mode tests**

Create `packages/core/src/merge/driver-failure.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriver } from "./driver-main.js";

function engramRaw(): string {
  return `---
id: "01HXXX"
title: "base"
kind: "observation"
createdBy: "user-a"
createdAt: "2026-01-01T00:00:00Z"
updatedBy: "user-a"
updatedAt: "2026-01-01T00:00:00Z"
version: 1
domainTags: ["AIOS"]
---

Body.
`;
}

describe("driver failure modes (spec §10.1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driver-fail-"));
    mkdirSync(join(dir, "engrams"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with usage message when no args", () => {
    const result = runDriver(["node", "driver.js"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("exits 1 when input file does not exist", () => {
    const result = runDriver([
      "node",
      "driver.js",
      join(dir, "nonexistent-base.md"),
      join(dir, "ours.md"),
      join(dir, "theirs.md"),
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/failed to read input files|ENOENT/i);
  });

  it("exits 1 with conflict markers when engram parse fails on base", () => {
    const broken = "---\nno id or title\n---\n\nbroken\n";
    const valid = engramRaw();

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, broken);
    writeFileSync(oursP, valid);
    writeFileSync(theirsP, valid);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);

    // %A should contain conflict markers (so user sees the conflict)
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<< ours");
    expect(written).toContain(">>>>>>> theirs");
  });

  it("exits 1 with conflict markers when ours is corrupted", () => {
    const valid = engramRaw();
    const broken = "---\nbroken: true\n---\n\nno engram fields\n";

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, valid);
    writeFileSync(oursP, broken);
    writeFileSync(theirsP, valid);

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);

    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<<");
  });

  it("transparently handles non-engram markdown via git fallback", () => {
    const baseP = join(dir, "README.base.md");
    const oursP = join(dir, "README.md");
    const theirsP = join(dir, "README.theirs.md");
    writeFileSync(baseP, "# Title\n\nP1\n");
    writeFileSync(oursP, "# Title\n\nP1 edited\n");
    writeFileSync(theirsP, "# Title\n\nP1\n\nP2\n");

    const result = runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "README.md",
    ]);
    expect(result.exitCode).toBe(0);

    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("P1 edited");
    expect(written).toContain("P2");
    expect(written).not.toContain("<<<<<");
  });
});
```

- [ ] **Step 2: Run failure tests to verify they pass**

Run: `cd packages/core && pnpm test src/merge/driver-failure.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 3: Create the barrel**

Create `packages/core/src/merge/index.ts`:

```typescript
/**
 * @module @co-engram/core/merge
 *
 * Public exports for the git merge driver subsystem.
 * Host packages (openclaw-plugin, claude-code-mcp) consume via this barrel
 * in Phase 2 when wiring auto-onboard.
 */

export * from "./version.js";
export * from "./backup.js";
export * from "./frontmatter-rules.js";
export * from "./arbitration.js";
export * from "./frontmatter.js";
export * from "./content.js";
export * from "./merge-engram.js";
export * from "./data-root.js";
export * from "./driver-main.js";
export * from "./onboard.js";
```

- [ ] **Step 4: Wire the barrel into the core package's main index**

Check `packages/core/src/index.ts` exists (it does — see Map in CLAUDE.md). Read the file to find the existing export pattern, then add:

```typescript
export * from "./merge/index.js";
```

Run: `cd packages/core && pnpm typecheck`
Expected: pass — no new errors.

- [ ] **Step 5: Run the entire merge test suite + full core tests**

Run: `cd packages/core && pnpm test src/merge/ && pnpm test`
Expected: ALL tests pass.

- [ ] **Step 6: Run typecheck + format**

Run: `cd packages/core && pnpm typecheck && pnpm format:check`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
git add packages/core/src/merge/driver-failure.test.ts packages/core/src/merge/index.ts packages/core/src/index.ts
git commit -m "test+feat(core/merge): add failure-mode coverage + barrel export"
```

---

## Phase 1 Acceptance Checklist

After all 12 tasks land, verify each item below. Each must be demonstrably true via tests in this plan.

- [ ] **Spec §12 Phase 1 acceptance: "engram 文件冲突能被 driver 处理,统计字段累加正确"**
  - Task 7 test `clean-merges non-overlapping frontmatter + content changes` proves retrievalCount additive merge.
  - Task 11 e2e test proves real git merge produces correct additive count.

- [ ] **Spec §12 Phase 1 acceptance: "输方备份落盘,7 天 TTL 工作"**
  - Task 2 test `cleanupOldBackups` proves 7-day TTL.
  - Task 7 test `snapshots loser when content falls back to theirs` proves backup creation.

- [ ] **Spec §12 Phase 1 acceptance: "driver 崩溃时 git 正确 fallback 到默认 merge"**
  - Task 11 e2e test `falls back to git default behavior when driver script missing` proves fallback.
  - Task 12 test `exits 1 with conflict markers when engram parse fails` proves error path leaves markers.

- [ ] **Spec §3 architecture: driver route by path (engram vs non-engram .md)**
  - Task 8 test `transparently falls back to git merge-file for non-engram .md files` proves routing.

- [ ] **Spec §10.1 error handling: any uncertainty → leave git markers**
  - Task 7 test `escalates when updatedAt collides` proves markers on collision.
  - Task 12 failure tests prove parse errors leave markers.

- [ ] **Spec §4.4 updatedAt arbitration + §4.2 field classification**
  - Task 3 (classification + simple rules), Task 4 (arbitration + tiebreaker), Task 5 (orchestrator) collectively cover this.

- [ ] **Spec §8 onboard: bundle to `~/.co-engram/merge-driver.js`, write `.gitattributes`, write `.git/config`**
  - Task 10 tests each prove one of the three artifacts.

## Final Verification

- [ ] Run full test suite: `cd packages/core && pnpm test`
- [ ] Run typecheck: `cd packages/core && pnpm typecheck`
- [ ] Run format: `cd packages/core && pnpm format:check`
- [ ] Run build (includes bundle): `cd packages/core && pnpm build`
- [ ] Manual smoke test: run the e2e test scenario by hand in a real repo

## Out of Scope (Deferred to Later Phases)

The following are explicitly **NOT** in Phase 1 — they belong to Phase 2-4 per spec §12:

- **Synapse merge** (Phase 2): SynapseMerger, evidence union, resolutionState state machine
- **Auto-onboard** (Phase 2): plugin startup detection + auto-install; `co-engram git enable` CLI subcommand
- **LLM arbitration** (Phase 3): LlmArbiter, provider adapters, prompt template, confidence threshold
- **Cross-file coordination** (Phase 3): CrossFileCoordinator, post-merge consistency pass
- **`post-merge` git hook** (Phase 3)
- **Stress test scripts** (Phase 4): 50-person concurrency simulator
- **Viewer "Merges" tab** (Phase 4)
- **`co-engram merge stats` CLI** (Phase 4)
- **Cross-platform validation** (Phase 4)

When the implementer encounters edge cases the spec didn't cover, the spec §17 default principles apply:

1. Data safety > auto-rate → fallback to markers
2. Reuse existing mechanisms (MaintenanceEngine / AuditLog / LlmClient) over new components
3. All fallbacks/degradations land in audit
