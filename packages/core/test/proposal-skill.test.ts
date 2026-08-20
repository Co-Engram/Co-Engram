import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  skillEntityId,
  SKILL_PROPOSAL_PREFIX,
} from "../src/observability/proposal-engine.js";
import { SkillRepository } from "../src/skill/skill-repository.js";

let tmpDir: string;
let repo: EngramRepository;
let audit: AuditLog;
let engine: ProposalEngine;
let skillRepo: SkillRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-skill-proposal-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  audit = new AuditLog(tmpDir);
  skillRepo = new SkillRepository(tmpDir);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: tmpDir,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
    skillRepository: skillRepo,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("skillEntityId", () => {
  it("前缀 skill: + 16 hex", () => {
    const id = skillEntityId("tools/a");
    expect(id.startsWith(SKILL_PROPOSAL_PREFIX)).toBe(true);
    expect(id.length).toBe(SKILL_PROPOSAL_PREFIX.length + 16);
  });
  it("稳定（同输入同输出）", () => {
    expect(skillEntityId("tools/a")).toBe(skillEntityId("tools/a"));
  });
  it("不同 sourcePath 不同 id", () => {
    expect(skillEntityId("tools/a")).not.toBe(skillEntityId("tools/b"));
  });
});

describe("proposeSkill", () => {
  const mockInput = {
    sourcePath: "tools/a",
    skillId: "a",
    initiationSet: "用时：",
  };

  it("首次 → proposed", () => {
    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("proposed");

    const proposals = engine.readProposals();
    const skillProposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"));
    expect(skillProposal).toBeDefined();
    expect(skillProposal?.source).toBe("skill");
    expect(skillProposal?.status).toBe("pending");
    expect(skillProposal?.payload?.kind).toBe("procedure");
    expect(skillProposal?.payload?.domainTags).toEqual(["skill"]);
    expect(skillProposal?.payload?.skillId).toBe("a");
  });

  it("重复同 payload → no-change", () => {
    engine.proposeSkill(mockInput);
    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("no-change");

    const proposals = engine.readProposals();
    expect(proposals.filter((p) => p.entityId === skillEntityId("tools/a")).length).toBe(1);
  });

  it("payload 变 → updated", () => {
    engine.proposeSkill(mockInput);
    const changedInput = { ...mockInput, initiationSet: "新用法：" };
    const result = engine.proposeSkill(changedInput);
    expect(result).toBe("updated");

    const proposals = engine.readProposals();
    const skillProposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"));
    expect(skillProposal?.centroidExcerpt).toBe("新用法：");
  });

  it("accepted 后再 propose → no-change", () => {
    engine.proposeSkill(mockInput);
    const proposals = engine.readProposals();
    const proposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"))!;

    // 模拟 accept（直接修改 status）
    engine.writeProposals(
      proposals.map((p) =>
        p.entityId === proposal.entityId
          ? { ...p, status: "accepted" as const }
          : p
      )
    );

    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("no-change");
  });

  it("dismissed 后不复活", () => {
    engine.proposeSkill(mockInput);
    const proposals = engine.readProposals();
    const proposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"))!;

    // 模拟 dismiss
    engine.writeProposals(
      proposals.map((p) =>
        p.entityId === proposal.entityId
          ? { ...p, status: "dismissed" as const, dismissedUntil: undefined, dismissReason: "test" }
          : p
      )
    );

    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("no-change");
  });

  it("proposeSkill 透传 SKILL.md 原生字段到 payload", () => {
    engine.proposeSkill({
      sourcePath: "skills/t", skillId: "t", initiationSet: "when X",
      allowedTools: ["Read", "Bash"], license: "MIT", skillVersion: "1.0",
      metadata: { author: "a" }, compatibility: "Claude Code",
    });
    const p = engine.listPending().find((x) => x.entityId.startsWith("skill:"));
    expect(p?.payload?.allowedTools).toEqual(["Read", "Bash"]);
    expect(p?.payload?.license).toBe("MIT");
    expect(p?.payload?.skillVersion).toBe("1.0");
    expect(p?.payload?.compatibility).toBe("Claude Code");
  });

  // —— 2026-08-16 purge-复活 bug 回归(血案:viewer「清空已接受」删掉 accepted 行
  //    后,watcher 重扫把 9 个已注册技能当新发现重新提议) ——
  it("purgeAccepted 删行后重扫 → 印迹已注册,不复活为 pending", () => {
    engine.proposeSkill(mockInput);
    engine.accept(skillEntityId("tools/a"), { createdBy: "test-user" });
    expect(skillRepo.exists("a")).toBe(true);

    // 模拟 viewer「清空已接受」:物理删除 accepted 行,不留 tombstone
    const purged = engine.purgeAccepted();
    expect(purged.length).toBe(1);
    expect(
      engine.readProposals().find((p) => p.entityId === skillEntityId("tools/a"))
    ).toBeUndefined();

    // watcher 重扫同一 skill 目录 → 印迹级幂等拦截,不新建 pending
    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("no-change");
    expect(
      engine.readProposals().find((p) => p.entityId === skillEntityId("tools/a"))
    ).toBeUndefined();
  });

  it("印迹已注册 + 存量 pending 复活行 → 自愈对齐为 accepted", () => {
    engine.proposeSkill(mockInput);
    // 模拟印迹已注册但 proposal 行是 purge 后复活的 pending
    skillRepo.createSkill({
      skillId: "a",
      sourcePath: "tools/a",
      initiationSet: "用时：",
      createdBy: "test-user",
    });

    const result = engine.proposeSkill(mockInput);
    expect(result).toBe("no-change");

    const proposals = engine.readProposals();
    const healed = proposals.find((p) => p.entityId === skillEntityId("tools/a"));
    expect(healed?.status).toBe("accepted");
    expect(healed?.acceptedEngramId).toBe("a");

    // 自愈留 audit 痕迹
    const healedAudit = audit
      .query()
      .find((e) => e.action === "propose" && e.metadata.selfHealed === "imprint-exists");
    expect(healedAudit).toBeDefined();
  });
});

describe("createSkillHook", () => {
  const skillMdContent = `---
name: test-skill
description: 测试技能
---
这是一个测试技能的内容。`;

  const nonSkillMdContent = `# 普通 Markdown
这不是一个 skill 文件。`;

  it("SKILL.md → 提案（source=skill，payload 含推断字段）", () => {
    const hook = engine.createSkillHook();
    hook({
      absPath: "/tmp/tools/test/SKILL.md",
      relPath: "tools/test/SKILL.md",
      raw: skillMdContent,
    });

    const proposals = engine.readProposals();
    const skillProposal = proposals.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();
    expect(skillProposal?.sourcePath).toBe("tools/test/SKILL.md");
    expect(skillProposal?.payload?.skillId).toBe("test-skill");
    expect(skillProposal?.payload?.kind).toBe("procedure");
    expect(skillProposal?.payload?.domainTags).toEqual(["skill"]);
  });

  it("非 skill 格式（无 frontmatter）→ 跳过（noise_filtered，无 proposal）", () => {
    const hook = engine.createSkillHook();
    hook({
      absPath: "/tmp/tools/test/README.md",
      relPath: "tools/test/README.md",
      raw: nonSkillMdContent,
    });

    const proposals = engine.readProposals();
    const skillProposal = proposals.find((p) => p.source === "skill");
    expect(skillProposal).toBeUndefined();

    // 验证 audit 日志中有 noise_filtered 记录
    const auditEntries = audit.query().filter((e) => e.action === "noise_filtered");
    const skillNoise = auditEntries.find((e) => e.metadata.source === "skill");
    expect(skillNoise).toBeDefined();
    expect(skillNoise?.metadata.reason).toBe("not-a-skill-md");
  });
});

describe("accept skill proposal", () => {
  const mockInput = {
    sourcePath: "tools/a",
    skillId: "a",
    initiationSet: "用时：",
  };

  it("accept → skillRepository.createSkill + proposal accepted", () => {
    // 先创建 skill proposal
    engine.proposeSkill(mockInput);
    const proposals = engine.readProposals();
    const skillProposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"));
    expect(skillProposal?.status).toBe("pending");

    // accept skill proposal
    const entityId = skillEntityId("tools/a");
    const skillId = engine.accept(entityId, { createdBy: "test-user" });

    // 验证 Skill 实体已创建
    const skill = skillRepo.readSkill(skillId);
    expect(skill).toBeDefined();
    expect(skill.skillId).toBe("a");
    expect(skill.sourcePath).toBe("tools/a");
    expect(skill.acquisitionStage).toBe("draft");
    expect(skill.retentionStage).toBe("active");

    // 验证 proposal 状态已更新为 accepted
    const updatedProposals = engine.readProposals();
    const acceptedProposal = updatedProposals.find((p) => p.entityId === entityId);
    expect(acceptedProposal?.status).toBe("accepted");
    expect(acceptedProposal?.acceptedEngramId).toBe(skillId);
  });

  it("未注入 skillRepository → 抛 CONFIG", () => {
    // 创建不带 skillRepository 的 ProposalEngine
    const engineWithoutSkillRepo = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog: audit,
      dataRoot: tmpDir,
      config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
      // 不传 skillRepository
    });

    // 创建 skill proposal
    engineWithoutSkillRepo.proposeSkill(mockInput);
    const proposals = engineWithoutSkillRepo.readProposals();
    const skillProposal = proposals.find((p) => p.entityId === skillEntityId("tools/a"));

    expect(skillProposal?.status).toBe("pending");

    // accept 应该抛 configError
    expect(() => {
      engineWithoutSkillRepo.accept(skillEntityId("tools/a"), { createdBy: "test-user" });
    }).toThrow("skillRepository");
  });

  it("印迹已注册时 accept pending 提案 → 幂等成功,不抛 Skill already exists", () => {
    // 复活场景:purge 后提案回到 pending,但印迹早已注册
    engine.proposeSkill(mockInput);
    skillRepo.createSkill({
      skillId: "a",
      sourcePath: "tools/a",
      initiationSet: "用时：",
      createdBy: "test-user",
    });

    // 旧实现这里抛 validationError "Skill already exists: a"
    const skillId = engine.accept(skillEntityId("tools/a"), { createdBy: "test-user" });
    expect(skillId).toBe("a");

    // proposal 置 accepted,印迹不重复(skillList 仍只有一条 a)
    const proposal = engine
      .readProposals()
      .find((p) => p.entityId === skillEntityId("tools/a"));
    expect(proposal?.status).toBe("accepted");
    expect(proposal?.acceptedEngramId).toBe("a");
    expect(skillRepo.listSkills().filter((s) => s.skillId === "a").length).toBe(1);

    // 幂等路径留 audit 归因
    const idempotentAudit = audit
      .query()
      .find((e) => e.action === "accept" && e.metadata.idempotent === true);
    expect(idempotentAudit).toBeDefined();
  });

  it("acceptBatch source=skill", () => {
    // 创建两个 skill proposal
    const mockInput2 = { ...mockInput, skillId: "b", sourcePath: "tools/b" };
    engine.proposeSkill(mockInput);
    engine.proposeSkill(mockInput2);

    const proposalsBefore = engine.readProposals();
    const skillProposals = proposalsBefore.filter((p) => p.source === "skill");
    expect(skillProposals.length).toBe(2);
    expect(skillProposals.every((p) => p.status === "pending")).toBe(true);

    // acceptBatch source=skill
    const result = engine.acceptBatch({ source: "skill", limit: 10 }, { createdBy: "batch-test" });

    // 验证两个 skill 都被 accept
    expect(result.acceptedIds.length).toBe(2);
    expect(result.engramIds.length).toBe(2);
    expect(result.failures.length).toBe(0);

    // 验证 Skill 实体已创建
    const skillA = skillRepo.readSkill("a");
    const skillB = skillRepo.readSkill("b");
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();

    // 验证 proposal 状态已更新
    const proposalsAfter = engine.readProposals();
    const acceptedProposals = proposalsAfter.filter((p) => p.source === "skill" && p.status === "accepted");
    expect(acceptedProposals.length).toBe(2);
  });
});

describe("accept_proposals_by_source source=skill", () => {
  it("批量 accept skill 提案", () => {
    // 创建 2 个 skill proposal(pending)
    const mockInput1 = {
      sourcePath: "tools/test1",
      skillId: "test1",
      initiationSet: "测试1：",
    };
    const mockInput2 = {
      sourcePath: "tools/test2",
      skillId: "test2",
      initiationSet: "测试2：",
    };

    engine.proposeSkill(mockInput1);
    engine.proposeSkill(mockInput2);

    // 验证 2 个 skill proposal 都是 pending
    const proposalsBefore = engine.readProposals();
    const skillProposals = proposalsBefore.filter((p) => p.source === "skill" && p.status === "pending");
    expect(skillProposals.length).toBe(2);

    // acceptBatch({source:"skill"})
    const result = engine.acceptBatch({ source: "skill", limit: 200 }, { createdBy: "batch-user" });

    // 验证结果：2 个 Skill 实体 + proposals accepted
    expect(result.acceptedIds.length).toBe(2);
    expect(result.engramIds.length).toBe(2);
    expect(result.failures.length).toBe(0);

    // 验证 Skill 实体已创建
    const skill1 = skillRepo.readSkill("test1");
    const skill2 = skillRepo.readSkill("test2");
    expect(skill1).toBeDefined();
    expect(skill2).toBeDefined();

    // 验证 proposals 状态已更新为 accepted
    const proposalsAfter = engine.readProposals();
    const acceptedProposals = proposalsAfter.filter((p) => p.source === "skill" && p.status === "accepted");
    expect(acceptedProposals.length).toBe(2);
  });
});
