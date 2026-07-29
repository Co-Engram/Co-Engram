import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distributeSkill } from "../src/skill/skill-distributor.js";
import { SKILL_MD_FILENAME } from "../src/skill/skill-detector.js";

let sourceRoot: string;
let targetRoot: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "skill-dist-src-"));
  targetRoot = mkdtempSync(join(tmpdir(), "skill-dist-tgt-"));
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(targetRoot, { recursive: true, force: true });
});

function makeSourceSkill(skillId: string, withScripts = true) {
  const dir = join(sourceRoot, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_MD_FILENAME),
    `---\nname: ${skillId}\ndescription: x\n---\nbody`
  );
  if (withScripts) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run.py"), "print('hi')");
  }
}

describe("distributeSkill", () => {
  it("分发新 skill → 复制 SKILL.md + scripts 到 targetDir/skillId/", () => {
    makeSourceSkill("a");
    const r = distributeSkill({
      sourceDir: join(sourceRoot, "a"),
      targetDir: targetRoot,
      skillId: "a",
    });
    expect(r.action).toBe("distributed");
    expect(r.targetPath).toBe(join(targetRoot, "a"));
    expect(existsSync(join(targetRoot, "a", SKILL_MD_FILENAME))).toBe(true);
    expect(existsSync(join(targetRoot, "a", "scripts", "run.py"))).toBe(true);
    expect(
      readFileSync(join(targetRoot, "a", SKILL_MD_FILENAME), "utf8")
    ).toContain("name: a");
  });

  it("D11：目标已有同名 skill（含 SKILL.md）→ 不覆盖（skipped-existing）", () => {
    makeSourceSkill("a");
    // 目标预先存在同名 skill（工作目录原有）
    mkdirSync(join(targetRoot, "a"), { recursive: true });
    writeFileSync(
      join(targetRoot, "a", SKILL_MD_FILENAME),
      "---\nname: a\ndescription: 原有的\n---\n原有内容"
    );
    const r = distributeSkill({
      sourceDir: join(sourceRoot, "a"),
      targetDir: targetRoot,
      skillId: "a",
    });
    expect(r.action).toBe("skipped-existing");
    // 原有内容未被覆盖
    expect(
      readFileSync(join(targetRoot, "a", SKILL_MD_FILENAME), "utf8")
    ).toContain("原有内容");
  });

  it("D6：分发不碰 sourceDir 原文件", () => {
    makeSourceSkill("a");
    distributeSkill({
      sourceDir: join(sourceRoot, "a"),
      targetDir: targetRoot,
      skillId: "a",
    });
    // sourceDir 内容仍在
    expect(existsSync(join(sourceRoot, "a", SKILL_MD_FILENAME))).toBe(true);
  });

  it("目标目录不存在 → 自动创建", () => {
    makeSourceSkill("a");
    const r = distributeSkill({
      sourceDir: join(sourceRoot, "a"),
      targetDir: join(targetRoot, "nested", "skills"),
      skillId: "a",
    });
    expect(r.action).toBe("distributed");
    expect(
      existsSync(join(targetRoot, "nested", "skills", "a", SKILL_MD_FILENAME))
    ).toBe(true);
  });
});
