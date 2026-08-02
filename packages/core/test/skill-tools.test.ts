import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { skillCreateTool, skillGetTool, skillListTool, skillUpdateTool, skillDeleteTool } from "../src/tools/skill-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-tools-"));
  ctx = {
    repository: { rootPath: root } as never,
    skillRepository: new SkillRepository(root),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const createInput = {
  skillId: "s1",
  sourcePath: "tools/s1",
  initiationSet: "when X",
  createdBy: "tester",
};

describe("skill tools", () => {
  it("skill_create → skill_get", async () => {
    const created = await skillCreateTool.execute(createInput, ctx);
    expect(created.skillId).toBe("s1");

    const got = await skillGetTool.execute({ id: "s1" }, ctx);
    expect(got.skillId).toBe("s1");
  });

  it("skill_list 过滤 acquisitionStage", async () => {
    await skillCreateTool.execute(createInput, ctx);
    const list = await skillListTool.execute({ acquisitionStage: "draft" }, ctx);
    expect(list.items.length).toBe(1);

    const empty = await skillListTool.execute({ acquisitionStage: "tuned" }, ctx);
    expect(empty.items.length).toBe(0);
  });

  it("skill_update 迁移 draft→compiled", async () => {
    await skillCreateTool.execute(createInput, ctx);
    const u = await skillUpdateTool.execute({ id: "s1", acquisitionStage: "compiled" }, ctx);
    expect(u.acquisitionStage).toBe("compiled");
  });

  it("skill_delete 后 get 抛 NOT_FOUND", async () => {
    await skillCreateTool.execute(createInput, ctx);
    await skillDeleteTool.execute({ id: "s1" }, ctx);

    expect(() => skillGetTool.execute({ id: "s1" }, ctx)).toThrow(/not found|NOT_FOUND/);
  });

  it("缺 skillRepository 抛 CONFIG", async () => {
    const noRepoCtx = { repository: { rootPath: root } as never } as ToolContext;
    expect(() => skillCreateTool.execute(createInput, noRepoCtx)).toThrow(/CONFIG|skillRepository/);
  });
});
