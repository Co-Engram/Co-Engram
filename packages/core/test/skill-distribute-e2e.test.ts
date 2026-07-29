import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  SKILL_PROPOSAL_PREFIX,
} from "../src/observability/proposal-engine.js";
import { distributeSkill } from "../src/skill/skill-distributor.js";
import { SKILL_MD_FILENAME } from "../src/skill/skill-detector.js";

let dataRoot: string;
let hostSkillsDir: string;
let repo: EngramRepository;
let skillRepo: SkillRepository;
let audit: AuditLog;
let engine: ProposalEngine;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "skill-dist-e2e-data-"));
  hostSkillsDir = mkdtempSync(join(tmpdir(), "skill-dist-e2e-host-"));
  repo = new EngramRepository({ rootPath: dataRoot });
  skillRepo = new SkillRepository(dataRoot);
  audit = new AuditLog(dataRoot);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
    skillRepository: skillRepo,
  });
  repo.setSkillHook(engine.createSkillHook());
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(hostSkillsDir, { recursive: true, force: true });
});

function placeSkillInDataRoot(relDir: string, name: string, desc = "用时") {
  const dir = join(dataRoot, ...relDir.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_MD_FILENAME),
    `---\nname: ${name}\ndescription: ${desc}\n---\nbody`
  );
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "run.py"), "print('hi')");
}

describe("skill distribute e2e（accept → distribute → D11）", () => {
  it("accept skill 提案 → distribute 到宿主目录 → 复制 SKILL.md + scripts", () => {
    placeSkillInDataRoot("tools/a", "a");
    repo.startWatching();

    const all = engine.listAll();
    const skillProposal = all.find((p) => p.source === "skill");
    expect(skillProposal).toBeDefined();
    expect(skillProposal!.entityId.startsWith(SKILL_PROPOSAL_PREFIX)).toBe(true);

    const entityId = skillProposal!.entityId;
    const skillId = engine.accept(entityId, { createdBy: "t" });
    expect(skillId).toBe("a");

    // 分发到模拟宿主目录
    const r = distributeSkill({
      sourceDir: join(dataRoot, "tools/a"),
      targetDir: hostSkillsDir,
      skillId: "a",
    });
    expect(r.action).toBe("distributed");
    expect(existsSync(join(hostSkillsDir, "a", SKILL_MD_FILENAME))).toBe(true);
    expect(existsSync(join(hostSkillsDir, "a", "scripts", "run.py"))).toBe(true);
  });

  it("D11：宿主目录已有同名 skill → distribute 不覆盖（工作目录为主）", () => {
    placeSkillInDataRoot("tools/a", "a");
    // 宿主目录预先有同名 skill（工作目录原有）
    mkdirSync(join(hostSkillsDir, "a"), { recursive: true });
    writeFileSync(
      join(hostSkillsDir, "a", SKILL_MD_FILENAME),
      "---\nname: a\ndescription: 原有的\n---\n原有内容"
    );

    const r = distributeSkill({
      sourceDir: join(dataRoot, "tools/a"),
      targetDir: hostSkillsDir,
      skillId: "a",
    });
    expect(r.action).toBe("skipped-existing");
    expect(
      readFileSync(join(hostSkillsDir, "a", SKILL_MD_FILENAME), "utf8")
    ).toContain("原有内容"); // 未覆盖
  });

  it("多 skill 分发：各自独立目录", () => {
    placeSkillInDataRoot("tools/a", "a");
    placeSkillInDataRoot("tools/b", "b");

    // accept 两个 skill
    repo.startWatching();
    const all = engine.listAll();
    const skillProposals = all.filter((p) => p.source === "skill");
    expect(skillProposals.length).toBe(2);

    for (const proposal of skillProposals) {
      engine.accept(proposal.entityId, { createdBy: "multi-test" });
    }

    // 分发两个 skill
    for (const id of ["a", "b"]) {
      const r = distributeSkill({
        sourceDir: join(dataRoot, `tools/${id}`),
        targetDir: hostSkillsDir,
        skillId: id,
      });
      expect(r.action).toBe("distributed");
    }

    expect(existsSync(join(hostSkillsDir, "a", SKILL_MD_FILENAME))).toBe(true);
    expect(existsSync(join(hostSkillsDir, "b", SKILL_MD_FILENAME))).toBe(true);
    expect(existsSync(join(hostSkillsDir, "a", "scripts", "run.py"))).toBe(true);
    expect(existsSync(join(hostSkillsDir, "b", "scripts", "run.py"))).toBe(true);
  });
});
