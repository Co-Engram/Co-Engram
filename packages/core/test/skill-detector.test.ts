import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMd, collectSkillDirs, isInSkillId, inferSkillFields, inferSkillFieldsWithLlm, SKILL_MD_FILENAME } from "../src/skill/skill-detector.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "skill-det-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("parseSkillMd", () => {
  it("解析标准 SKILL.md（name + description + body）", () => {
    const raw = "---\nname: icenter-contacts\ndescription: 查询通讯录\n---\n\n## 功能\n说明";
    const p = parseSkillMd(raw, "tools/icenter-contacts");
    expect(p?.skillId).toBe("icenter-contacts");
    expect(p?.description).toBe("查询通讯录");
    expect(p?.body).toContain("## 功能");
    expect(p?.sourcePath).toBe("tools/icenter-contacts");
  });
  it("name 缺失 → 用目录名作 skillId", () => {
    const raw = "---\ndescription: 仅描述\n---\nbody";
    expect(parseSkillMd(raw, "tools/foo")?.skillId).toBe("foo");
  });
  it("无 frontmatter → null", () => {
    expect(parseSkillMd("纯正文无 frontmatter", "tools/x")).toBeNull();
  });
  it("YAML 损坏 → null", () => {
    expect(parseSkillMd("---\n: invalid yaml\n: : :\n---\nbody", "tools/x")).toBeNull();
  });
});

describe("collectSkillDirs", () => {
  it("扫到含 SKILL.md 的目录", () => {
    mkdirSync(join(root, "tools", "a"), { recursive: true });
    writeFileSync(join(root, "tools", "a", SKILL_MD_FILENAME), "---\nname: a\n---\nb");
    expect(collectSkillDirs(root)).toEqual(["tools/a"]);
  });
  it("最浅层判定：某目录有 SKILL.md 就不下钻（不收子目录的 skill）", () => {
    mkdirSync(join(root, "parent"), { recursive: true });
    writeFileSync(join(root, "parent", SKILL_MD_FILENAME), "---\nname: p\n---\nb");
    mkdirSync(join(root, "parent", "child"), { recursive: true });
    writeFileSync(join(root, "parent", "child", SKILL_MD_FILENAME), "---\nname: c\n---\nb");
    // parent 有 SKILL.md → 不下钻，只收 parent
    expect(collectSkillDirs(root).sort()).toEqual(["parent"]);
  });
  it("多个独立 skill 目录全收", () => {
    for (const s of ["a", "b"]) {
      mkdirSync(join(root, "tools", s), { recursive: true });
      writeFileSync(join(root, "tools", s, SKILL_MD_FILENAME), `---\nname: ${s}\n---\nb`);
    }
    expect(collectSkillDirs(root).sort()).toEqual(["tools/a", "tools/b"]);
  });
  it("跳过 .git/node_modules/.co-engram 等目录", () => {
    mkdirSync(join(root, ".git", "x"), { recursive: true });
    writeFileSync(join(root, ".git", "x", SKILL_MD_FILENAME), "---\nname: x\n---\nb");
    expect(collectSkillDirs(root)).toEqual([]);
  });
  it("无 skill → []", () => {
    mkdirSync(join(root, "empty"), { recursive: true });
    expect(collectSkillDirs(root)).toEqual([]);
  });
});

describe("inferSkillFields", () => {
  it("description → initiationSet", () => {
    const p = { skillId: "s", description: "需要查通讯录时", body: "", sourcePath: "tools/s" };
    expect(inferSkillFields(p).initiationSet).toBe("需要查通讯录时");
  });
  it("description 空 → 默认 initiationSet", () => {
    const p = { skillId: "s", description: "", body: "", sourcePath: "tools/s" };
    expect(inferSkillFields(p).initiationSet).toContain("s");
  });
  it("body/description 含完成关键词 → termination 匹配", () => {
    const p = { skillId: "s", description: "", body: "拿到工号后结束", sourcePath: "tools/s" };
    expect(inferSkillFields(p).termination).toContain("拿到");
  });
  it("无关键词 → 默认 termination", () => {
    const p = { skillId: "s", description: "", body: "无关键词", sourcePath: "tools/s" };
    expect(inferSkillFields(p).termination).toContain("完成");
  });
  it("policy kind 按 sourcePath 启发（claude/openclaw/prompt）", () => {
    expect(inferSkillFields({ skillId:"a", description:"", body:"", sourcePath:"x/claude/a" }).policy.kind).toBe("claude-skill");
    expect(inferSkillFields({ skillId:"b", description:"", body:"", sourcePath:"x/openclaw/b" }).policy.kind).toBe("openclaw-skill");
    expect(inferSkillFields({ skillId:"c", description:"", body:"", sourcePath:"x/c" }).policy.kind).toBe("prompt");
  });
  it("policy.ref = SKILL.md", () => {
    expect(inferSkillFields({ skillId:"s", description:"", body:"", sourcePath:"tools/s" }).policy.ref).toBe(SKILL_MD_FILENAME);
  });
});

describe("inferSkillFieldsWithLlm (S2.x trigger 推断)", () => {
  it("LLM 返回有效 JSON → 解析 initiationSet/termination", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => '{"initiationSet": "需要测试时", "termination": "测试完成后"}',
    };
    const result = await inferSkillFieldsWithLlm(p, mockLlmClient);
    expect(result.initiationSet).toBe("需要测试时");
    expect(result.termination).toBe("测试完成后");
    expect(result.policy.kind).toBe("prompt");
    expect(result.policy.ref).toBe(SKILL_MD_FILENAME);
  });

  it("LLM 返回带 markdown fence 的 JSON → 正确解析", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => '```json\n{"initiationSet": "启动测试", "termination": "测试结束"}\n```',
    };
    const result = await inferSkillFieldsWithLlm(p, mockLlmClient);
    expect(result.initiationSet).toBe("启动测试");
    expect(result.termination).toBe("测试结束");
  });

  it("LLM 返回无效 JSON → 抛错（由调用方降级到规则版）", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => "not a json",
    };
    await expect(inferSkillFieldsWithLlm(p, mockLlmClient)).rejects.toThrow("LLM response has no JSON object");
  });

  it("LLM 返回空字符串 → 抛错", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => "",
    };
    await expect(inferSkillFieldsWithLlm(p, mockLlmClient)).rejects.toThrow("LLM returned non-string output");
  });

  it("LLM 返回 JSON 缺少 initiationSet → 抛错", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => '{"termination": "测试结束"}',
    };
    await expect(inferSkillFieldsWithLlm(p, mockLlmClient)).rejects.toThrow("LLM response missing valid initiationSet");
  });

  it("LLM 返回 JSON 缺少 termination → 抛错", async () => {
    const p = { skillId: "test-skill", description: "测试技能", body: "这是测试内容", sourcePath: "tools/test-skill" };
    const mockLlmClient: LlmClient = {
      complete: async () => '{"initiationSet": "启动测试"}',
    };
    await expect(inferSkillFieldsWithLlm(p, mockLlmClient)).rejects.toThrow("LLM response missing valid termination");
  });

  it("policy kind 按 sourcePath 启发（claude/openclaw）", async () => {
    const claudeSkill = { skillId: "claude-test", description: "Claude 技能", body: "内容", sourcePath: "tools/claude/claude-test" };
    const openclawSkill = { skillId: "openclaw-test", description: "OpenClaw 技能", body: "内容", sourcePath: "tools/openclaw/openclaw-test" };
    const mockLlmClient: LlmClient = {
      complete: async () => '{"initiationSet": "需要时", "termination": "完成后"}',
    };

    const claudeResult = await inferSkillFieldsWithLlm(claudeSkill, mockLlmClient);
    expect(claudeResult.policy.kind).toBe("claude-skill");

    const openclawResult = await inferSkillFieldsWithLlm(openclawSkill, mockLlmClient);
    expect(openclawResult.policy.kind).toBe("openclaw-skill");
  });
});

describe("isInSkillId", () => {
  it("文件在 skill 根目录下 → true", () => {
    mkdirSync(join(root, "tools", "a"), { recursive: true });
    writeFileSync(join(root, "tools", "a", SKILL_MD_FILENAME), "---\nname: a\n---\nb");
    expect(isInSkillId("tools/a/notes.md", root)).toBe(true);
  });
  it("文件在 skill 深层子目录 → true（向上逐级查祖先命中 SKILL.md）", () => {
    mkdirSync(join(root, "skills", "x", "scripts", "deep"), { recursive: true });
    writeFileSync(join(root, "skills", "x", SKILL_MD_FILENAME), "---\nname: x\n---\nb");
    expect(isInSkillId("skills/x/scripts/run.md", root)).toBe(true);
    expect(isInSkillId("skills/x/scripts/deep/nested/file.md", root)).toBe(true);
  });
  it("SKILL.md 自身 → true（所在目录即 skill 根）", () => {
    mkdirSync(join(root, "tools", "a"), { recursive: true });
    writeFileSync(join(root, "tools", "a", SKILL_MD_FILENAME), "---\nname: a\n---\nb");
    expect(isInSkillId("tools/a/SKILL.md", root)).toBe(true);
  });
  it("非 skill 目录文件（无任何祖先 SKILL.md）→ false", () => {
    mkdirSync(join(root, "docs", "sub"), { recursive: true });
    expect(isInSkillId("docs/guide.md", root)).toBe(false);
    expect(isInSkillId("docs/sub/x.md", root)).toBe(false);
  });
  it("dataRoot 本身含 SKILL.md → 所有文件归 skill（对齐 collectSkillDirs 的 '.' 语义）", () => {
    writeFileSync(join(root, SKILL_MD_FILENAME), "---\nname: root\n---\nb");
    expect(isInSkillId("loose.md", root)).toBe(true);
    expect(isInSkillId("a/b/c.md", root)).toBe(true);
  });
  it("空相对路径 → false（防御）", () => {
    expect(isInSkillId("", root)).toBe(false);
  });
  it("嵌套 skill（parent 与 child 都有 SKILL.md）：child 下文件向上命中最近祖先 → true", () => {
    mkdirSync(join(root, "parent"), { recursive: true });
    writeFileSync(join(root, "parent", SKILL_MD_FILENAME), "---\nname: p\n---\nb");
    mkdirSync(join(root, "parent", "child"), { recursive: true });
    writeFileSync(join(root, "parent", "child", SKILL_MD_FILENAME), "---\nname: c\n---\nb");
    expect(isInSkillId("parent/child/notes.md", root)).toBe(true);
    expect(isInSkillId("parent/child/SKILL.md", root)).toBe(true);
    expect(collectSkillDirs(root)).toEqual(["parent"]); // 最浅层只收 parent
  });
  it("大小写敏感：小写 skill.md 不被识别 → false（与 collectSkillDirs 一致）", () => {
    mkdirSync(join(root, "tools", "a"), { recursive: true });
    writeFileSync(join(root, "tools", "a", "skill.md"), "---\nname: a\n---\nb");
    expect(isInSkillId("tools/a/notes.md", root)).toBe(false);
    expect(collectSkillDirs(root)).toEqual([]);
  });
  it("关键：以文件已知路径为锚 existsSync，不依赖 collectSkillDirs 预扫描（创建瞬间 readdirSync 竞态时仍正确）", () => {
    mkdirSync(join(root, "shared", "new-skill"), { recursive: true });
    writeFileSync(join(root, "shared", "new-skill", SKILL_MD_FILENAME), "---\nname: new\n---\nb");
    writeFileSync(join(root, "shared", "new-skill", "notes.md"), "附属笔记");
    expect(isInSkillId("shared/new-skill/notes.md", root)).toBe(true);
    expect(isInSkillId("shared/new-skill/SKILL.md", root)).toBe(true);
    expect(collectSkillDirs(root)).toContain("shared/new-skill");
  });
});
