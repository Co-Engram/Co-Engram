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
import type { SkillPolicy } from "../src/types/skill.js";

let tmpDir: string;
let repo: EngramRepository;
let audit: AuditLog;
let engine: ProposalEngine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-skill-proposal-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  audit = new AuditLog(tmpDir);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: tmpDir,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
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
  const mockPolicy: SkillPolicy = { kind: "prompt", ref: "SKILL.md" };
  const mockInput = {
    sourcePath: "tools/a",
    skillId: "a",
    initiationSet: "用时：",
    termination: "结束",
    policy: mockPolicy,
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
