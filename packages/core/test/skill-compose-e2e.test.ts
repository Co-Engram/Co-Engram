import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import {
  skillComposeAddTool,
  skillComposeRemoveTool,
  skillComposeListTool,
} from "../src/tools/skill-tools.js";
import { detectComposeCandidates } from "../src/skill/compose-detector.js";
import type { ToolContext } from "../src/tools/tool.js";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-comp-e2e-"));
  ctx = {
    repository: { rootPath: root } as never,
    skillRepository: new SkillRepository(root),
  };
});

afterEach(() =>
  rmSync(root, { recursive: true, force: true })
);

describe("skill compose e2e", () => {
  it("add→list→remove 全链路", async () => {
    ctx.skillRepository!.createSkill({
      skillId: "a",
      sourcePath: "tools/a",
      initiationSet: "x",
      termination: "y",
      policy: { kind: "prompt", ref: "SKILL.md" },
      createdBy: "t",
    });

    await skillComposeAddTool.execute({ skillId: "a", targetSkillId: "b" }, ctx);
    const list = await skillComposeListTool.execute({ skillId: "a" }, ctx);
    expect(list.composes).toEqual(["b"]);

    await skillComposeRemoveTool.execute(
      { skillId: "a", targetSkillId: "b" },
      ctx
    );
    const list2 = await skillComposeListTool.execute({ skillId: "a" }, ctx);
    expect(list2.composes).toEqual([]);
  });

  it("detectComposeCandidates 对实际 skill 集返回候选", () => {
    ctx.skillRepository!.createSkill({
      skillId: "a",
      sourcePath: "tools/a",
      initiationSet: "启动",
      termination: "拿到工号",
      policy: { kind: "prompt", ref: "SKILL.md" },
      createdBy: "t",
    });
    ctx.skillRepository!.createSkill({
      skillId: "b",
      sourcePath: "tools/b",
      initiationSet: "拿到工号后发消息",
      termination: "发送完成",
      policy: { kind: "prompt", ref: "SKILL.md" },
      createdBy: "t",
    });

    const cands = detectComposeCandidates(ctx.skillRepository!.listSkills());
    expect(
      cands.find((c) => c.from === "a" && c.to === "b")
    ).toBeDefined();
  });
});
