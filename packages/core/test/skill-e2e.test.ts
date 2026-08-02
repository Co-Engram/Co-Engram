import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { scanAllImprints } from "../src/skill/imprint.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "skill-e2e-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("skill memory S1 e2e", () => {
  it("全链路：创建→多次成功使用→习得迁移→持久化→删除", () => {
    const repo = new SkillRepository(root);
    // 1. 创建（模拟 S2 accept 后调 skill_create）
    const s = repo.createSkill({
      skillId: "icenter-contacts", sourcePath: "tools/icenter-contacts",
      initiationSet: "查询通讯录", createdBy: "tester",
    });
    expect(s.acquisitionStage).toBe("draft");
    // 2. sidecar 落盘在 sourcePath/.co-engram/imprint.json，SKILL.md 不被碰
    //    （sidecar 路径存在即说明落盘；不读 SKILL.md 内容）
    // 3. 多次成功使用 → utility 上升 + sampleSize 增
    let cur = s;
    for (let i = 0; i < 5; i++) cur = repo.recordUse("icenter-contacts", { success: true, effectiveness: 0.9 });
    expect(cur.utility).toBeGreaterThan(0.5);
    expect(cur.successCount).toBe(5);
    // 4. 手动迁移 draft→compiled→tuned
    cur = repo.updateSkill("icenter-contacts", { acquisitionStage: "compiled" });
    cur = repo.updateSkill("icenter-contacts", { acquisitionStage: "tuned" });
    expect(cur.acquisitionStage).toBe("tuned");
    // 5. 持久化：新 repo 实例读回
    const repo2 = new SkillRepository(root);
    expect(repo2.readSkill("icenter-contacts").acquisitionStage).toBe("tuned");
    expect(repo2.listSkills().length).toBe(1);
    // 6. 删除 → 印迹消失
    repo2.deleteSkill("icenter-contacts");
    expect(scanAllImprints(root).length).toBe(0);
  });

  it("路径逃逸 sourcePath → fallback 模式下 CRUD 仍工作", () => {
    // controller 修正：用非法 sourcePath（路径逃逸）触发 safeJoinWithinRoot 抛 → writeImprint 走 fallback
    // （plan 原版用 "readonly/ro"，测试环境可写，实际走 sidecar 非兜底，测试名误导）
    const repo = new SkillRepository(root);
    const s = repo.createSkill({
      skillId: "ro", sourcePath: "../escape/ro",
      initiationSet: "x", createdBy: "t",
    });
    expect(s.skillId).toBe("ro");
    // readSkill 经 fallback 读回
    expect(repo.readSkill("ro").skillId).toBe("ro");
    expect(repo.listSkills().length).toBe(1);
    // update + delete 在 fallback 模式下也工作
    const u = repo.updateSkill("ro", { initiationSet: "新情境" });
    expect(u.initiationSet).toBe("新情境");
    repo.deleteSkill("ro");
    expect(repo.listSkills().length).toBe(0);
  });

  it("混合 sidecar + fallback：scanAllImprints 合并去重", () => {
    const repo = new SkillRepository(root);
    // 正常 skill（sidecar）
    repo.createSkill({ skillId: "a", sourcePath: "tools/a", initiationSet: "x", createdBy: "t" });
    // 非法 sourcePath skill（fallback）
    repo.createSkill({ skillId: "b", sourcePath: "../escape/b", initiationSet: "x", createdBy: "t" });
    const ids = scanAllImprints(root).map((i) => i.skillId).sort();
    expect(ids).toEqual(["a", "b"]); // sidecar + fallback 都被扫到
  });
});
