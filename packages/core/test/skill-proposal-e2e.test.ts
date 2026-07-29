import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  skillEntityId,
  SKILL_PROPOSAL_PREFIX,
} from "../src/observability/proposal-engine.js";

let root: string;
let repo: EngramRepository;
let skillRepo: SkillRepository;
let audit: AuditLog;
let engine: ProposalEngine;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-e2e-"));
  repo = new EngramRepository({ rootPath: root });
  skillRepo = new SkillRepository(root);
  audit = new AuditLog(root);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: root,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
    skillRepository: skillRepo,
  });
  repo.setSkillHook(engine.createSkillHook());
  repo.setExternalMarkdownHook(engine.createExternalMarkdownHook());
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeSkill(relDir: string, name: string, desc: string, extraFile?: string) {
  const parts = relDir.split("/");
  const dirPath = join(root, ...parts);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(
    join(dirPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n说明`
  );
  if (extraFile) {
    writeFileSync(join(dirPath, extraFile), "附属");
  }
}

describe("skill memory S2 e2e", () => {
  it("放 skill 目录 → 检测 → skill 提案（source=skill，payload 含推断字段）", () => {
    makeSkill("tools/a", "a", "查询通讯录时");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposal = all.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();
    expect(skillProposal!.entityId.startsWith(SKILL_PROPOSAL_PREFIX)).toBe(true);
    expect(skillProposal!.payload?.skillId).toBe("a");
    expect(skillProposal!.payload?.initiationSet).toContain("查询通讯录");
    expect(skillProposal!.payload?.policy?.kind).toBe("prompt"); // sourcePath "tools/a" 不含 claude/openclaw → prompt
  });

  it("解冲突：skill 目录下的 SKILL.md + 附属 .md 不进 external-markdown", () => {
    makeSkill("tools/a", "a", "x", "notes.md");
    repo.startWatching();

    const all = engine.listAll();
    const extMdProposals = all.filter((p) => p.source === "external-markdown");
    const skillProposals = all.filter((p) => p.source === "skill");

    expect(extMdProposals).toEqual([]);
    expect(skillProposals.length).toBe(1);
    expect(skillProposals[0].entityId).toBe(skillEntityId("tools/a"));
  });

  it("accept → Skill 实体（draft/active）+ proposal accepted", () => {
    makeSkill("tools/a", "a", "x");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposal = all.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();

    const entityId = skillProposal!.entityId;
    const skillId = engine.accept(entityId, { createdBy: "tester" });

    expect(skillId).toBe("a");
    const skill = skillRepo.readSkill("a");
    expect(skill.acquisitionStage).toBe("draft");
    expect(skill.retentionStage).toBe("active");
    expect(skill.initiationSet).toContain("x");

    // proposal accepted
    const accepted = engine.listAll().find((p) => p.entityId === entityId);
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.acceptedEngramId).toBe("a");
  });

  it("dismiss 后重新 startWatching 不复活", () => {
    makeSkill("tools/a", "a", "x");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposal = all.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();

    const entityId = skillProposal!.entityId;
    engine.dismiss(entityId, "不需要", 0); // 永久 dismiss

    // 重新扫
    const repo2 = new EngramRepository({ rootPath: root });
    const skillRepo2 = new SkillRepository(root);
    const audit2 = new AuditLog(root);
    const engine2 = new ProposalEngine({
      repository: repo2,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog: audit2,
      dataRoot: root,
      config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
      skillRepository: skillRepo2,
    });
    repo2.setSkillHook(engine2.createSkillHook());
    repo2.setExternalMarkdownHook(engine2.createExternalMarkdownHook());

    repo2.startWatching();

    const still = engine2.listAll().find((p) => p.entityId === entityId);
    expect(still?.status).toBe("dismissed"); // 不复活成 pending
  });

  it("多 skill 目录 → 多提案 → acceptBatch 全部接受", () => {
    makeSkill("tools/a", "a", "技能 A");
    makeSkill("tools/b", "b", "技能 B");
    makeSkill("skills/c", "c", "技能 C");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposals = all.filter((p) => p.source === "skill");
    expect(skillProposals.length).toBe(3);

    // acceptBatch 全部接受
    const result = engine.acceptBatch({ source: "skill", limit: 10 }, { createdBy: "batch-tester" });

    expect(result.acceptedIds.length).toBe(3);
    expect(result.engramIds).toContain("a");
    expect(result.engramIds).toContain("b");
    expect(result.engramIds).toContain("c");
    expect(result.failures.length).toBe(0);

    // 验证 Skill 实体已创建
    expect(skillRepo.exists("a")).toBe(true);
    expect(skillRepo.exists("b")).toBe(true);
    expect(skillRepo.exists("c")).toBe(true);

    // 验证 proposals 状态已更新
    const after = engine.listAll().filter((p) => p.source === "skill");
    expect(after.every((p) => p.status === "accepted")).toBe(true);
  });

  it("skill payload 推断：tools/ → prompt，tools/claude/ → claude-skill，tools/openclaw/ → openclaw-skill", () => {
    makeSkill("tools/generic", "generic", "通用技能");
    makeSkill("tools/claude/builtin", "claude-skill", "Claude 技能");
    makeSkill("tools/openclaw/plugin", "openclaw-skill", "OpenClaw 技能");
    repo.startWatching();

    const all = engine.listAll();
    const genericProp = all.find((p) => p.payload?.skillId === "generic");
    const claudeProp = all.find((p) => p.payload?.skillId === "claude-skill");
    const openclawProp = all.find((p) => p.payload?.skillId === "openclaw-skill");

    expect(genericProp?.payload?.policy?.kind).toBe("prompt"); // tools/generic 不含 claude/openclaw → prompt
    expect(claudeProp?.payload?.policy?.kind).toBe("claude-skill"); // tools/claude/ → claude-skill
    expect(openclawProp?.payload?.policy?.kind).toBe("openclaw-skill"); // tools/openclaw/ → openclaw-skill
  });

  it("完整流程：放 skill → 检测 → 提案 → accept → 记录使用 → utility 更新", () => {
    makeSkill("tools/calculator", "calculator", "计算时");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposal = all.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();

    // accept
    const skillId = engine.accept(skillProposal!.entityId, { createdBy: "tester" });
    expect(skillId).toBe("calculator");

    // 验证初始状态
    const skill = skillRepo.readSkill("calculator");
    expect(skill.utility).toBe(0.5);
    expect(skill.invocationCount).toBe(0);
    expect(skill.successCount).toBe(0);

    // 记录成功使用
    skillRepo.recordUse("calculator", { success: true, effectiveness: 0.9 });
    const updated = skillRepo.readSkill("calculator");

    // 验证 utility 更新（Rescorla-Wagner）
    expect(updated.invocationCount).toBe(1);
    expect(updated.successCount).toBe(1);
    expect(updated.utility).toBeGreaterThan(0.5); // 成功 → utility 上升
    expect(updated.lastUsedAt).not.toBeNull();
  });
});
