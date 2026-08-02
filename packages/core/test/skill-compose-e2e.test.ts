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
});
