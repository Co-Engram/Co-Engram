import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { skillInvokeTool } from "../src/tools/skill-tools.js";
import { writeImprint } from "../src/skill/imprint.js";
import type { ToolContext } from "../src/tools/tool.js";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-invoke-"));
  ctx = {
    repository: { rootPath: root } as never,
    skillRepository: new SkillRepository(root),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const create = (id = "s1") =>
  ctx.skillRepository!.createSkill({
    skillId: id,
    sourcePath: `tools/${id}`,
    initiationSet: "x",
    termination: "y",
    policy: { kind: "prompt" as const, ref: "SKILL.md" },
    createdBy: "t",
  });

describe("skill_invoke", () => {
  it("success → utility 升 + successCount+1 + output 含更新后状态", async () => {
    create();
    const r = await skillInvokeTool.execute(
      { id: "s1", success: true, effectiveness: 0.9 },
      ctx
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("utility=");
    const skill = ctx.skillRepository!.readSkill("s1");
    expect(skill.successCount).toBe(1);
    expect(skill.failureCount).toBe(0);
    expect(skill.utility).toBeGreaterThan(0.5);
    expect(r.output).toContain("successCount=1");
    expect(r.output).toContain("failureCount=0");
    expect(r.effectiveness).toBe(0.9);
  });

  it("failure → utility 降 + failureCount+1", async () => {
    create();
    const r = await skillInvokeTool.execute({ id: "s1", success: false }, ctx);
    expect(r.success).toBe(false);
    const skill = ctx.skillRepository!.readSkill("s1");
    expect(skill.failureCount).toBe(1);
    expect(skill.successCount).toBe(0);
    expect(skill.utility).toBeLessThan(0.5);
    expect(r.output).toContain("successCount=0");
    expect(r.output).toContain("failureCount=1");
  });

  it("不存在 skillId → 抛 NOT_FOUND", async () => {
    await expect(
      skillInvokeTool.execute({ id: "nope", success: true }, ctx)
    ).rejects.toThrow(/not found|NOT_FOUND/);
  });

  it("success 无 effectiveness → 默认 1.0", async () => {
    create();
    const r = await skillInvokeTool.execute({ id: "s1", success: true }, ctx);
    expect(r.success).toBe(true);
    const skill = ctx.skillRepository!.readSkill("s1");
    expect(skill.utility).toBeGreaterThan(0.5); // reward = 1.0
    expect(r.effectiveness).toBeUndefined();
  });

  it("forgotten skill → success:false + error", async () => {
    create();
    // 手动构造 forgotten skill（直接写 imprint）
    const skill = ctx.skillRepository!.readSkill("s1");
    const forgottenSkill = {
      ...skill,
      retentionStage: "forgotten" as const,
      utility: 0.01,
    };
    writeImprint(root, forgottenSkill);

    const r = await skillInvokeTool.execute({ id: "s1", success: true }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/decayed to forgotten/);
  });

  it("连续成功 → utility 持续上升", async () => {
    create();
    await skillInvokeTool.execute({ id: "s1", success: true, effectiveness: 0.8 }, ctx);
    await skillInvokeTool.execute({ id: "s1", success: true, effectiveness: 0.9 }, ctx);
    const skill = ctx.skillRepository!.readSkill("s1");
    expect(skill.successCount).toBe(2);
    expect(skill.utility).toBeGreaterThan(0.55);
  });

  it("连续失败 → utility 持续下降", async () => {
    create();
    await skillInvokeTool.execute({ id: "s1", success: false }, ctx);
    await skillInvokeTool.execute({ id: "s1", success: false }, ctx);
    const skill = ctx.skillRepository!.readSkill("s1");
    expect(skill.failureCount).toBe(2);
    expect(skill.utility).toBeLessThan(0.45);
  });
});
