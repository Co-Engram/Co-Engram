import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { skillInvokeTool } from "../src/tools/skill-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let root: string;
let repo: SkillRepository;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-decay-e2e-"));
  repo = new SkillRepository(root);
  ctx = {
    repository: { rootPath: root } as never,
    skillRepository: repo,
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const create = (id: string) =>
  repo.createSkill({
    skillId: id,
    sourcePath: `tools/${id}`,
    initiationSet: "x",
    createdBy: "t",
  });

describe("skill memory S3 decay e2e", () => {
  it("多次 success invoke → utility 升 → 时间推进 → recomputeRetentionAll → retentionStage 衰退", async () => {
    create("s1");
    // 多次成功使用
    for (let i = 0; i < 5; i++) {
      await skillInvokeTool.execute({ id: "s1", success: true, effectiveness: 0.9 }, ctx);
    }
    const afterUse = repo.readSkill("s1");
    expect(afterUse.utility).toBeGreaterThan(0.5);
    expect(afterUse.successCount).toBe(5);
    expect(afterUse.retentionStage).toBe("active"); // 刚用，active

    // 模拟 light stage 周期（时间推进 1 年）
    const futureMs = Date.now() + 365 * 86_400_000;
    const r = repo.recomputeRetentionAll(futureMs);
    expect(r.changed).toBe(1);
    const decayed = repo.readSkill("s1");
    expect(["aging", "stale", "forgotten"]).toContain(decayed.retentionStage);
  });

  it("forgotten skill → skill_invoke 返回 success:false + 不更新 utility", async () => {
    create("s1");
    await skillInvokeTool.execute({ id: "s1", success: true }, ctx); // 先用一次（lastUsedAt=now, utility>0.5）
    const utilityBefore = repo.readSkill("s1").utility;
    // 推进到 forgotten（recomputeRetentionAll 多次大跨度，或一次足够远）
    const veryFuture = Date.now() + 10 * 365 * 86_400_000; // 10 年后
    repo.recomputeRetentionAll(veryFuture);
    expect(repo.readSkill("s1").retentionStage).toBe("forgotten");
    // forgotten skill invoke → 拒绝（不更新 utility）
    const r = await skillInvokeTool.execute({ id: "s1", success: true }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("forgotten");
    // utility 未变（forgotten 分支在 recordUse 前返回）
    expect(repo.readSkill("s1").utility).toBe(utilityBefore);
  });

  it("持久化：新 repo 读回衰退后的 retentionStage", () => {
    create("s1");
    repo.recordUse("s1", { success: true });
    const futureMs = Date.now() + 365 * 86_400_000;
    repo.recomputeRetentionAll(futureMs);
    const stage1 = repo.readSkill("s1").retentionStage;
    // 新 repo 实例
    const repo2 = new SkillRepository(root);
    expect(repo2.readSkill("s1").retentionStage).toBe(stage1);
  });

  it("刚创建未用（lastUsedAt=null）→ 时间推进也不衰退（n=0）", () => {
    create("s1");
    const futureMs = Date.now() + 365 * 86_400_000;
    const r = repo.recomputeRetentionAll(futureMs);
    expect(r.changed).toBe(0); // null lastUsedAt → n=0 → active 不变
    expect(repo.readSkill("s1").retentionStage).toBe("active");
  });
});
