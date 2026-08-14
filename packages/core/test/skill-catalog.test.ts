import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSkillCatalog,
  SkillRepository,
  SKILL_CATALOG_MAX_ENTRIES,
  SKILL_CATALOG_DESC_MAX_CHARS,
} from "../src/skill/index.js";

let root: string;
let repo: SkillRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-catalog-"));
  repo = new SkillRepository(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 在 dataRoot 下创建一个 skill 目录(SKILL.md)+ 注册 imprint */
function registerSkill(skillId: string, description: string): void {
  const dir = join(root, "skills", skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${description}\n---\n\nbody\n`,
    "utf8",
  );
  repo.createSkill({
    skillId,
    sourcePath: `skills/${skillId}`,
    initiationSet: description || `使用 ${skillId} 技能时`,
    createdBy: "test",
  });
}

/** 直写 imprint 覆盖字段(测试注入 utility/retentionStage 过滤与排序) */
function patchImprint(skillId: string, patch: Record<string, unknown>): void {
  const impPath = join(root, "skills", skillId, ".co-engram", "imprint.json");
  const imp = JSON.parse(readFileSync(impPath, "utf8")) as Record<string, unknown>;
  writeFileSync(impPath, JSON.stringify({ ...imp, ...patch }, null, 2));
}

describe("collectSkillCatalog", () => {
  it("收集已注册 skill 的 SKILL.md 原生 description", () => {
    registerSkill("demo-skill", "当用户需要演示时使用");
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.skillId).toBe("demo-skill");
    expect(catalog[0]!.description).toBe("当用户需要演示时使用");
  });

  it("forgotten 阶段的 skill 不注入(衰退联动)", () => {
    registerSkill("active-skill", "活跃技能");
    registerSkill("old-skill", "过期技能");
    patchImprint("old-skill", { retentionStage: "forgotten" });
    const catalog = collectSkillCatalog(repo, root);
    const ids = catalog.map((e) => e.skillId);
    expect(ids).toContain("active-skill");
    expect(ids).not.toContain("old-skill");
  });

  it("description 为空时兜底为「使用 X 技能时」", () => {
    registerSkill("no-desc", "");
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog[0]!.description).toBe("使用 no-desc 技能时");
  });

  it("超长 description 截断到上限字符", () => {
    registerSkill("long-desc", "x".repeat(200));
    const catalog = collectSkillCatalog(repo, root);
    // 截断 = 60 字符 + 省略号
    expect(catalog[0]!.description.length).toBe(SKILL_CATALOG_DESC_MAX_CHARS + 1);
    expect(catalog[0]!.description.endsWith("…")).toBe(true);
  });

  it("SKILL.md 被删(dangling)时跳过该条不抛错", () => {
    registerSkill("gone-skill", "目录被删的技能");
    rmSync(join(root, "skills", "gone-skill"), { recursive: true, force: true });
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog).toHaveLength(0);
  });

  it("按 utility 降序排序", () => {
    registerSkill("low", "低效用");
    registerSkill("high", "高效用");
    patchImprint("high", { utility: 0.9 });
    patchImprint("low", { utility: 0.1 });
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog.map((e) => e.skillId)).toEqual(["high", "low"]);
  });

  it("超过条数上限时按 utility 取前 N", () => {
    for (let i = 0; i < SKILL_CATALOG_MAX_ENTRIES + 5; i++) {
      const id = `skill-${String(i).padStart(2, "0")}`;
      registerSkill(id, `技能 ${i}`);
      // utility 与序号正相关:skill-14 最高,skill-00 最低
      patchImprint(id, { utility: i / 20 });
    }
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog).toHaveLength(SKILL_CATALOG_MAX_ENTRIES);
    // 保留的是 utility 最高的 10 个(05..14)
    expect(catalog[0]!.skillId).toBe("skill-14");
    expect(catalog[9]!.skillId).toBe("skill-05");
  });

  it("description 实时读 SKILL.md(改 SKILL.md 后注入内容跟着变,不读 imprint.initiationSet)", () => {
    registerSkill("drift-test", "原始描述");
    // imprint.initiationSet 保持旧值,SKILL.md description 更新
    const skillMd = join(root, "skills", "drift-test", "SKILL.md");
    writeFileSync(
      skillMd,
      "---\nname: drift-test\ndescription: 新描述\n---\n\nbody\n",
      "utf8",
    );
    const catalog = collectSkillCatalog(repo, root);
    expect(catalog[0]!.description).toBe("新描述");
  });
});
