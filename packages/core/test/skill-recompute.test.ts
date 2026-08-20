import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";

let root: string;
let repo: SkillRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-recompute-"));
  repo = new SkillRepository(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("recomputeRetentionAll", () => {
  it("刚创建（lastUsedAt=null）+ now=创建时 → retentionStage 不变（active）", () => {
    repo.createSkill({
      skillId: "fresh",
      sourcePath: "tools/fresh",
      initiationSet: "x",
      createdBy: "t",
    });
    const r = repo.recomputeRetentionAll(Date.now());
    expect(r.scanned).toBe(1);
    expect(r.changed).toBe(0);
    expect(repo.readSkill("fresh").retentionStage).toBe("active");
  });

  it("长期未用（lastUsedAt 远 past）→ retentionStage 衰退 + changed 计数", () => {
    repo.createSkill({
      skillId: "old",
      sourcePath: "tools/old",
      initiationSet: "x",
      createdBy: "t",
    });
    // recordUse 一次（设 lastUsedAt=现在）
    repo.recordUse("old", { success: true });
    // 推进时间到 1 年后
    const futureMs = Date.now() + 365 * 86_400_000;
    const r = repo.recomputeRetentionAll(futureMs);
    expect(r.changed).toBe(1);
    const stage = repo.readSkill("old").retentionStage;
    expect(["aging", "stale", "forgotten"]).toContain(stage);
  });

  it("多个 skill：never-used 从 createdAt 起算也衰退 → changed 计入两者", () => {
    repo.createSkill({
      skillId: "fresh",
      sourcePath: "tools/fresh",
      initiationSet: "x",
      createdBy: "t",
    });
    repo.createSkill({
      skillId: "old",
      sourcePath: "tools/old",
      initiationSet: "x",
      createdBy: "t",
    });
    repo.recordUse("old", { success: true });
    const futureMs = Date.now() + 365 * 86_400_000;
    const r = repo.recomputeRetentionAll(futureMs);
    expect(r.scanned).toBe(2);
    // 两者都衰退:old 距上次使用、fresh 距创建(never-used 不再冻结 active)
    expect(r.changed).toBe(2);
    expect(repo.readSkill("fresh").retentionStage).toBe("forgotten");
    expect(repo.readSkill("old").retentionStage).toBe("forgotten");
  });

  it("空仓库 → scanned=0 changed=0", () => {
    const r = repo.recomputeRetentionAll();
    expect(r).toEqual({ scanned: 0, changed: 0 });
  });
});
