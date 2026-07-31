// packages/core/test/skill-conflict-resilience.test.ts
//
// Bug 回归验证：scanForExternalMarkdown 的解冲突原先依赖 collectSkillDirs 预扫描
// (readdirSync walk)。在 skill 目录**创建瞬间**(daemon 运行中用户新粘贴 skill 目录),
// collectSkillDirs 的目录列举(getdents)可能与 collectMarkdownFiles 的文件可见性
// 有时效差——collectMarkdownFiles 那一刻已能看到新目录下的 SKILL.md,但 collectSkillDirs
// 的 walk 可能还没列举到该新目录(readdir 缓存/竞态),导致 skillRoots 漏判,SKILL.md 被
// 一次性、持久地误判为 external-markdown 提案(误提案不可撤销,下一轮 scanForSkills 即使
// 发现真实 skill 也撤不回已发的误提案)。本地 ext3/4 也可复现(非 NFS 特有)。
//
// 修复：scanForExternalMarkdown 改用 isInSkillId(每文件向上 existsSync 查祖先 SKILL.md),
// 正确性不再依赖 collectSkillDirs 预扫描。
//
// 本文件用 vi.mock 强制 collectSkillDirs 返回空(模拟创建瞬间漏判最坏情况),验证
// scanForExternalMarkdown 仍正确排除 skill 下的 .md(靠 isInSkillId)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.mock 被 vitest hoist 到所有 import 之前；只覆盖 collectSkillDirs,其余导出
// (isInSkillId / SKILL_MD_FILENAME / parseSkillMd 等)保留实际实现——这正是修复关键:
// 解冲突走 isInSkillId(未被 mock),不再走 collectSkillDirs。
vi.mock("../src/skill/skill-detector.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, collectSkillDirs: () => [] };
});

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";

let root: string;
let repo: EngramRepository;
let extMdCalls: { absPath: string; relPath: string; raw: string; parsed: unknown }[];
let skillCalls: { absPath: string; relPath: string; raw: string }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-conflict-"));
  repo = new EngramRepository({ rootPath: root });
  extMdCalls = [];
  skillCalls = [];
  repo.setExternalMarkdownHook((p) => extMdCalls.push(p));
  repo.setSkillHook((p) => skillCalls.push(p));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface ScanInternals {
  scanForExternalMarkdown: () => void;
  scanForSkills: () => void;
}

describe("解冲突韧性：collectSkillDirs 创建瞬间漏判时仍正确", () => {
  it("collectSkillDirs 返回空(模拟创建瞬间漏判)→ scanForSkills 扫不到,但 scanForExternalMarkdown 仍排除 skill 下 .md", () => {
    mkdirSync(join(root, "shared", "pasted-skill"), { recursive: true });
    writeFileSync(join(root, "shared", "pasted-skill", "SKILL.md"), "---\nname: pasted\n---\nb");
    writeFileSync(join(root, "shared", "pasted-skill", "notes.md"), "附属笔记");

    const r = repo as unknown as ScanInternals;
    // 对照:scanForSkills 因 collectSkillDirs 漏判而扫不到 skill(证明 mock 生效)
    r.scanForSkills();
    expect(skillCalls.length).toBe(0);

    // 核心:scanForExternalMarkdown 不依赖 collectSkillDirs,用 isInSkillId 正确排除
    r.scanForExternalMarkdown();
    expect(extMdCalls.length).toBe(0);
    expect(extMdCalls.map((c) => c.relPath)).not.toContain("shared/pasted-skill/notes.md");
    expect(extMdCalls.map((c) => c.relPath)).not.toContain("shared/pasted-skill/SKILL.md");
  });

  it("漏判窗口期:非 skill 文件仍正常进 ext-md(解冲突未误伤正常提案)", () => {
    writeFileSync(join(root, "loose.md"), "# 裸 md");
    mkdirSync(join(root, "shared", "pasted-skill"), { recursive: true });
    writeFileSync(join(root, "shared", "pasted-skill", "SKILL.md"), "---\nname: pasted\n---\nb");

    const r = repo as unknown as ScanInternals;
    r.scanForExternalMarkdown();
    // loose.md 不是 skill 文件 → 正常提案;pasted-skill 下的文件被排除
    expect(extMdCalls.length).toBe(1);
    expect(extMdCalls[0].relPath).toBe("loose.md");
  });

  it("漏判窗口期:深层嵌套 skill 文件仍排除(isInSkillId 向上查祖先,不受目录深度影响)", () => {
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(join(root, "a", "b", "SKILL.md"), "---\nname: deep\n---\nb");
    writeFileSync(join(root, "a", "b", "c", "file.md"), "深层文件");

    const r = repo as unknown as ScanInternals;
    r.scanForExternalMarkdown();
    expect(extMdCalls.length).toBe(0);
    expect(extMdCalls.map((c) => c.relPath)).not.toContain("a/b/c/file.md");
  });
});
