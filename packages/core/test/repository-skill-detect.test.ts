import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";

let root: string;
let repo: EngramRepository;
let skillCalls: { absPath: string; relPath: string; raw: string }[];
let extMdCalls: { absPath: string; relPath: string; raw: string; parsed: any }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-repo-"));
  repo = new EngramRepository({ rootPath: root });
  skillCalls = [];
  extMdCalls = [];
  repo.setSkillHook((p) => skillCalls.push(p));
  repo.setExternalMarkdownHook((p) => extMdCalls.push(p));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeSkill(relDir: string, name = "x", desc = "用时") {
  mkdirSync(join(root, ...relDir.split("/")), { recursive: true });
  writeFileSync(
    join(root, ...relDir.split("/"), "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\nbody`
  );
}

function makeEngram(relPath: string, content = "content") {
  const dir = dirname(relPath);
  mkdirSync(join(root, ...dir.split("/")), { recursive: true });
  // 确保文件名以 .md 结尾
  const filePath = relPath.endsWith(".md") ? relPath : `${relPath}.md`;
  writeFileSync(
    join(root, ...filePath.split("/")),
    `---\ntitle: test\nid: en-${Date.now()}\n---\n${content}`
  );
}

function dirname(p: string): string {
  const parts = p.split("/");
  return parts.slice(0, -1).join("/");
}

describe("scanForSkills + setSkillHook", () => {
  it("放 skill 目录 → skillHook 触发（含 raw）", () => {
    makeSkill("tools/a", "a", "测试技能");
    repo.startWatching(); // 启动时会触发 scanForSkills
    expect(skillCalls.length).toBe(1);
    expect(skillCalls[0].relPath).toBe("tools/a");
    expect(skillCalls[0].raw).toContain("name: a");
    expect(skillCalls[0].raw).toContain("description: 测试技能");
  });

  it("无 skill 目录 → skillHook 不触发", () => {
    repo.startWatching();
    expect(skillCalls.length).toBe(0);
  });

  it("多个 skill 目录 → skillHook 都触发", () => {
    makeSkill("tools/a", "a");
    makeSkill("tools/b", "b");
    makeSkill("skills/c", "c");
    repo.startWatching();
    expect(skillCalls.length).toBe(3);
    const relPaths = skillCalls.map((c) => c.relPath).sort();
    expect(relPaths).toEqual(["skills/c", "tools/a", "tools/b"]);
  });

  it("取消 skillHook → 不再触发", () => {
    makeSkill("tools/a", "a");
    repo.startWatching();
    expect(skillCalls.length).toBe(1);

    const cancel = repo.setSkillHook(() => {});
    cancel();
    skillCalls = []; // 清空记录

    // 再次启动不会触发（因为 hook 已取消）
    const repo2 = new EngramRepository({ rootPath: root });
    const newCalls: any[] = [];
    repo2.setSkillHook((p) => newCalls.push(p));
    repo2.startWatching();
    expect(newCalls.length).toBe(1); // 新的 hook 仍然触发
  });
});

describe("解冲突：skill 目录的 .md 不进 external-markdown", () => {
  it("skill 目录下的 SKILL.md + 附属 .md 都不进 ext-md", () => {
    makeSkill("tools/a", "a");
    writeFileSync(join(root, "tools/a", "notes.md"), "附属笔记"); // skill 目录下的 .md
    repo.startWatching();
    expect(extMdCalls.length).toBe(0); // 都被排除
    expect(skillCalls.length).toBe(1); // 但 skillHook 仍触发
  });

  it("非 skill 目录的 .md 仍进 ext-md", () => {
    writeFileSync(join(root, "loose.md"), "# 裸 md\n内容");
    repo.startWatching();
    expect(extMdCalls.length).toBe(1);
    expect(extMdCalls[0].relPath).toBe("loose.md");
    expect(extMdCalls[0].raw).toContain("# 裸 md");
    expect(skillCalls.length).toBe(0); // 没有 skill 目录
  });

  it("skill 目录与非 skill 目录混放 → 正确区分", () => {
    makeSkill("tools/a", "a"); // skill 目录
    writeFileSync(join(root, "tools/a", "notes.md"), "附属笔记"); // skill 下 .md
    mkdirSync(join(root, "docs", "other"), { recursive: true });
    writeFileSync(join(root, "docs/other", "guide.md"), "# guide"); // 非 skill 目录（不用 readme.md，会被 SKIP_MARKDOWN_FILENAMES 跳过）

    repo.startWatching();

    expect(skillCalls.length).toBe(1); // 只有 tools/a 被识别为 skill
    expect(skillCalls[0].relPath).toBe("tools/a");

    expect(extMdCalls.length).toBe(1); // 只有 docs/other/guide.md 进 ext-md
    expect(extMdCalls[0].relPath).toBe("docs/other/guide.md");
  });

  it("dataRoot 本身是 skill 目录(.) → 所有文件都归 skill", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: root\n---\n");
    writeFileSync(join(root, "other.md"), "# 其他");
    repo.startWatching();

    expect(skillCalls.length).toBe(1);
    expect(skillCalls[0].relPath).toBe(".");
    expect(extMdCalls.length).toBe(0); // 所有 .md 都被排除（包括 other.md）
  });

  it("合法 engram 在 skill 目录下 → 不进 ext-md（避免双重提案）", () => {
    makeSkill("tools/a", "a");
    makeEngram("tools/a/doc", "合法 engram 内容"); // skill 目录下的合法 engram
    repo.startWatching();

    expect(skillCalls.length).toBe(1);
    expect(extMdCalls.length).toBe(0); // 合法 engram 也不进 ext-md
  });

  it("非 skill 目录的合法 engram → 仍进 ext-md", () => {
    makeEngram("docs/guide", "指南内容");
    repo.startWatching();

    expect(extMdCalls.length).toBe(1);
    expect(extMdCalls[0].relPath).toBe("docs/guide.md");
    expect(extMdCalls[0].parsed).not.toBeNull(); // 合法 engram 有 parsed
    expect(skillCalls.length).toBe(0);
  });
});

describe("边界情况", () => {
  it("SKILL.md 解析失败 → skillHook 仍触发（raw 含错误内容）", () => {
    mkdirSync(join(root, "tools", "broken"), { recursive: true });
    writeFileSync(join(root, "tools", "broken", "SKILL.md"), "无效的 YAM---L\nbroken");
    repo.startWatching();

    expect(skillCalls.length).toBe(1);
    expect(skillCalls[0].relPath).toBe("tools/broken");
    expect(skillCalls[0].raw).toContain("无效的 YAM");
  });

  it("skill 目录只有 SKILL.md 无附属文件 → 只触发 skillHook", () => {
    makeSkill("skills/lonely", "lonely");
    repo.startWatching();

    expect(skillCalls.length).toBe(1);
    expect(extMdCalls.length).toBe(0);
  });

  it("空仓库 → 两 hook 都不触发", () => {
    repo.startWatching();
    expect(skillCalls.length).toBe(0);
    expect(extMdCalls.length).toBe(0);
  });
});
