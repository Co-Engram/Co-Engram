import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";

let root: string;
let repo: SkillRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-repo-"));
  repo = new SkillRepository(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const input = {
  skillId: "icenter-contacts",
  sourcePath: "tools/icenter-contacts",
  initiationSet: "查询通讯录",
  allowedTools: ["Read", "Bash"],
  license: "MIT",
  skillVersion: "1.0",
  compatibility: "Claude Code",
  createdBy: "tester",
};

describe("SkillRepository CRUD", () => {
  it("create → read 往返", () => {
    const s = repo.createSkill(input);
    expect(s.skillId).toBe("icenter-contacts");
    expect(s.acquisitionStage).toBe("draft");
    expect(s.utility).toBe(0.5);
    expect(s.allowedTools).toEqual(["Read", "Bash"]);
    expect(s.license).toBe("MIT");
    expect(s.skillVersion).toBe("1.0");
    expect(s.compatibility).toBe("Claude Code");
    expect(repo.readSkill("icenter-contacts").skillId).toBe("icenter-contacts");
  });

  it("create 重复 skillId 抛 VALIDATION", () => {
    repo.createSkill(input);
    expect(() => repo.createSkill(input)).toThrow(/already exists|VALIDATION/);
  });

  it("read 不存在抛 NOT_FOUND", () => {
    expect(() => repo.readSkill("nope")).toThrow(/not found|NOT_FOUND/);
  });

  it("list 返回所有 skill", () => {
    repo.createSkill(input);
    repo.createSkill({ ...input, skillId: "b", sourcePath: "tools/b" });
    expect(repo.listSkills().map((s) => s.skillId).sort()).toEqual(["b", "icenter-contacts"]);
  });

  it("update initiationSet + version++", () => {
    repo.createSkill(input);
    const u = repo.updateSkill("icenter-contacts", { initiationSet: "新情境" });
    expect(u.initiationSet).toBe("新情境");
    expect(u.version).toBe(2);
  });

  it("update 手动迁移习得 draft→compiled 合法", () => {
    repo.createSkill(input);
    expect(repo.updateSkill("icenter-contacts", { acquisitionStage: "compiled" }).acquisitionStage).toBe("compiled");
  });

  it("update 非法迁移 tuned→draft 抛错", () => {
    repo.createSkill(input);
    repo.updateSkill("icenter-contacts", { acquisitionStage: "compiled" });
    repo.updateSkill("icenter-contacts", { acquisitionStage: "tuned" });
    expect(() => repo.updateSkill("icenter-contacts", { acquisitionStage: "draft" })).toThrow();
  });

  it("recordUse 更新 utility(Rescorla-Wagner) + 统计 + retentionStage", () => {
    repo.createSkill(input);
    const after = repo.recordUse("icenter-contacts", { success: true, effectiveness: 1.0 });
    expect(after.successCount).toBe(1);
    expect(after.utility).toBeGreaterThan(0.5);
    expect(after.lastUsedAt).not.toBeNull();
  });

  it("delete 后 read 抛 NOT_FOUND", () => {
    repo.createSkill(input);
    repo.deleteSkill("icenter-contacts");
    expect(() => repo.readSkill("icenter-contacts")).toThrow();
  });

  it("持久化：新 repo 实例能读到旧数据", () => {
    repo.createSkill(input);
    const repo2 = new SkillRepository(root);
    expect(repo2.readSkill("icenter-contacts").skillId).toBe("icenter-contacts");
  });

  it("update 不存在 skillId 抛 NOT_FOUND", () => {
    expect(() => repo.updateSkill("nope", { initiationSet: "x" })).toThrow(/not found|NOT_FOUND/);
  });

  it("recordUse 不存在 skillId 抛 NOT_FOUND", () => {
    expect(() => repo.recordUse("nope", { success: true })).toThrow(/not found|NOT_FOUND/);
  });

  it("recordUse failure 路径（failureCount++ + utility 下降）", () => {
    repo.createSkill(input);
    const after = repo.recordUse("icenter-contacts", { success: false });
    expect(after.failureCount).toBe(1);
    expect(after.successCount).toBe(0);
    expect(after.utility).toBeLessThan(0.5); // reward=0 → Rescorla-Wagner 下降
  });
});
