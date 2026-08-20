import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
  skillRetireEntityId,
} from "../src/observability/proposal-engine.js";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { writeImprint } from "../src/skill/imprint.js";
import { isRetireCandidate } from "../src/skill/dynamics.js";
import { collectSkillCatalog } from "../src/skill/skill-catalog.js";
import { MaintenanceEngine } from "../src/maintenance/index.js";
import { MemorySignalSink } from "../src/signals/file-sink.js";
import { skillListTool, skillInvokeTool } from "../src/tools/skill-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

/**
 * 技能退役回路(2026-08)回归测试。
 *
 * 覆盖:
 *   - isRetireCandidate 纯函数判据(零调用 / 天数 / stale|forgotten / 未退役)
 *   - syncSkillRetireProposals:提案生成、幂等、tombstone、僵尸撤销
 *   - accept:写 retiredAt;skill_list 语义由 retiredAt 驱动;catalog 不注入
 *   - dismiss:touch lastUsedAt(reactivate 语义)→ retention 回 active
 *   - 复活:recordUse 清 retiredAt + withdrawSkillRetire 撤 pending 提案
 *   - maintenance runLight 集成:light 周期触发提案生成
 */

const DAY = 86_400_000;

let tmpDir: string;
let repo: EngramRepository;
let audit: AuditLog;
let engine: ProposalEngine;
let skillRepo: SkillRepository;

function setup(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-skill-retire-"));
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
}

beforeEach(() => setup());

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 造一个「daysAgo 天前注册、零调用」的技能 */
function seedSkill(skillId: string, daysAgo: number): void {
  skillRepo.createSkill({
    skillId,
    sourcePath: `.claude/skills/${skillId}`,
    initiationSet: `Use ${skillId} when doing ${skillId} things`,
    createdBy: "test",
  });
  // 回拨 createdAt:改写印迹(writeImprint 保持其余字段)
  const skill = skillRepo.readSkill(skillId);
  writeImprint(tmpDir, {
    ...skill,
    createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  });
}

describe("isRetireCandidate(纯判据)", () => {
  const base = {
    invocationCount: 0,
    lastUsedAt: null,
    createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
    retentionStage: "forgotten" as const,
  };
  const now = Date.now();

  it("全部满足 → 候选", () => {
    expect(isRetireCandidate(base, now, 30)).toBe(true);
  });
  it("stale 也算候选(倒挂防护:forgotten 是 stale 的后继)", () => {
    expect(
      isRetireCandidate({ ...base, retentionStage: "stale" }, now, 30),
    ).toBe(true);
  });
  it("用过(invocationCount > 0)→ 非候选(用过后来忘了不属退役范畴)", () => {
    expect(isRetireCandidate({ ...base, invocationCount: 3 }, now, 30)).toBe(
      false,
    );
  });
  it("retention 仍 active/aging → 非候选", () => {
    expect(
      isRetireCandidate({ ...base, retentionStage: "active" }, now, 30),
    ).toBe(false);
    expect(
      isRetireCandidate({ ...base, retentionStage: "aging" }, now, 30),
    ).toBe(false);
  });
  it("锚点不够久 → 非候选", () => {
    expect(
      isRetireCandidate(
        { ...base, createdAt: new Date(Date.now() - 10 * DAY).toISOString() },
        now,
        30,
      ),
    ).toBe(false);
  });
  it("已 retired → 非候选(不重复提案)", () => {
    expect(
      isRetireCandidate(
        { ...base, retiredAt: new Date().toISOString() },
        now,
        30,
      ),
    ).toBe(false);
  });
});

describe("syncSkillRetireProposals(提案生命周期)", () => {
  it("零调用 + forgotten + 30 天 → 生成提案 + 审计 skill_retire_proposed", () => {
    seedSkill("pr-page-generator", 40);
    skillRepo.recomputeRetentionAll(Date.now()); // 40 天 never-used → forgotten
    const r = engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(r.proposed).toBe(1);
    const pending = engine.listPending();
    const target = pending.find(
      (p) => p.entityId === skillRetireEntityId("pr-page-generator"),
    );
    expect(target).toBeDefined();
    expect(target?.source).toBe("skill-retire");
    expect(target?.payload?.skillId).toBe("pr-page-generator");
    // 审计可达(专用 action)
    const auditLines = audit.query({
      action: "skill_retire_proposed",
      limit: 10,
    });
    expect(
      auditLines.some((e) => e.metadata?.skillId === "pr-page-generator"),
    ).toBe(true);
  });

  it("幂等:同状态再 sync 不重复提案", () => {
    seedSkill("old-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    const skills = skillRepo.listSkills();
    engine.syncSkillRetireProposals({ skills, minZeroUseDays: 30 });
    const r2 = engine.syncSkillRetireProposals({ skills, minZeroUseDays: 30 });
    expect(r2.proposed).toBe(0);
    expect(
      engine.listPending().filter((p) => p.source === "skill-retire").length,
    ).toBe(1);
  });

  it("近期注册(天数不足)→ 不提案", () => {
    seedSkill("young-skill", 10);
    skillRepo.recomputeRetentionAll(Date.now()); // 10 天 never-used → retention≈0.33 → stale
    const r = engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(r.proposed).toBe(0);
  });

  it("被使用后 → 僵尸 pending 提案被撤销(withdrawn)", () => {
    seedSkill("revived-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      true,
    );

    skillRepo.recordUse("revived-skill", { success: true });
    const r2 = engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(r2.withdrawn).toBe(1);
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      false,
    );
  });

  it("dismiss 后再 sync → 不复活(tombstone 永久屏蔽)", () => {
    seedSkill("kept-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    engine.dismiss(skillRetireEntityId("kept-skill"), "keep it");

    // 回拨到「很久以前」再 sync:tombstone 仍挡住
    const r2 = engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(r2.proposed).toBe(0);
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      false,
    );
  });
});

describe("accept / dismiss / 复活(端到端语义)", () => {
  function proposeFor(skillId: string): void {
    seedSkill(skillId, 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
  }

  it("accept → 写 retiredAt;skill_get 可读;catalog 不注入;listSkills 印迹保留", () => {
    proposeFor("retire-me");
    const entityId = skillRetireEntityId("retire-me");
    engine.accept(entityId, { createdBy: "tester" });

    const skill = skillRepo.readSkill("retire-me");
    expect(skill.retiredAt).toBeDefined();
    // 印迹仍在物理层(scanAllImprints 不过滤 retired)
    expect(skillRepo.listSkills().some((s) => s.skillId === "retire-me")).toBe(
      true,
    );
    // catalog 不注入
    const catalog = collectSkillCatalog(skillRepo, tmpDir);
    expect(catalog.some((c) => c.skillId === "retire-me")).toBe(false);
    // 提案 accepted
    const row = engine.findProposalByEntityId(entityId);
    expect(row?.status).toBe("accepted");
    // 幂等:已 retired 再 accept 不抛
    expect(() =>
      engine.accept(entityId, { createdBy: "tester" }),
    ).not.toThrow();
  });

  it("dismiss → touch lastUsedAt,retention 回 active", () => {
    proposeFor("dismiss-me");
    const before = skillRepo.readSkill("dismiss-me");
    expect(before.retentionStage).toBe("forgotten");

    engine.dismiss(skillRetireEntityId("dismiss-me"), "keep");
    const after = skillRepo.readSkill("dismiss-me");
    expect(after.retentionStage).toBe("active");
    expect(after.invocationCount).toBe(0); // touch 不是使用
    expect(after.lastUsedAt).not.toBeNull();
  });

  it("被使用 → 清 retiredAt + 撤销 pending 提案(使用即复活)", () => {
    proposeFor("revive-me");
    engine.accept(skillRetireEntityId("revive-me"), { createdBy: "tester" });
    expect(skillRepo.readSkill("revive-me").retiredAt).toBeDefined();

    // 重新造一个 pending 提案场景:withdrawSkillRetire 定点撤销
    seedSkill("revive-me-2", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    const before = skillRepo.readSkill("revive-me-2");
    const after = skillRepo.recordUse("revive-me-2", { success: true });
    expect(after.retiredAt).toBeUndefined();
    expect(after.retentionStage).toBe("active");
    // 定点撤 API(工具层与 viewer reactivate 走这条)
    const withdrew = engine.withdrawSkillRetire("revive-me-2", "revived");
    expect(withdrew).toBe(true);
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      false,
    );
    expect(before.invocationCount).toBe(0);
  });

  it("reactivateSkill(viewer 恢复)→ 清 retiredAt", () => {
    proposeFor("manual-restore");
    engine.accept(skillRetireEntityId("manual-restore"), {
      createdBy: "tester",
    });
    expect(skillRepo.readSkill("manual-restore").retiredAt).toBeDefined();
    const after = skillRepo.reactivateSkill("manual-restore");
    expect(after.retiredAt).toBeUndefined();
    expect(after.retentionStage).toBe("active");
  });

  it("目标技能已被删 → accept 自愈为 accepted(skillGone),不抛", () => {
    proposeFor("gone-skill");
    skillRepo.deleteSkill("gone-skill");
    expect(() =>
      engine.accept(skillRetireEntityId("gone-skill"), { createdBy: "tester" }),
    ).not.toThrow();
    const row = engine.findProposalByEntityId(
      skillRetireEntityId("gone-skill"),
    );
    expect(row?.status).toBe("accepted");
  });
});

describe("maintenance runLight 集成", () => {
  it("light 周期注入 skillRepository + proposalEngine → 退役提案生成并计入报告", async () => {
    seedSkill("light-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());

    const maint = new MaintenanceEngine(
      {
        repository: repo,
        signalSink: new MemorySignalSink(),
        skillRepository: skillRepo,
        proposalEngine: engine,
      },
      {
        enabledStages: ["light"],
        skillRetire: { enabled: true, staleZeroUseDays: 30 },
      },
    );
    const report = await maint.runLight();
    expect(report.skillsRetireProposed).toBe(1);
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      true,
    );
  });

  it("skillRetire.enabled=false → 不提案(报告无该字段)", async () => {
    seedSkill("disabled-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());

    const maint = new MaintenanceEngine(
      {
        repository: repo,
        signalSink: new MemorySignalSink(),
        skillRepository: skillRepo,
        proposalEngine: engine,
      },
      { enabledStages: ["light"], skillRetire: { enabled: false } },
    );
    const report = await maint.runLight();
    expect(report.skillsRetireProposed).toBeUndefined();
    expect(engine.listPending().some((p) => p.source === "skill-retire")).toBe(
      false,
    );
  });
});

describe("工具层场景(MCP 装配路径)", () => {
  const makeCtx = (): ToolContext =>
    ({
      repository: { rootPath: tmpDir } as never,
      skillRepository: skillRepo,
      proposalEngine: engine,
      auditLog: audit,
    }) as ToolContext;

  it("完整用户路径:light 出提案 → skill_list 仍列 → accept → 默认不列/includeRetired 可查", async () => {
    seedSkill("scenario-skill", 40);
    skillRepo.recomputeRetentionAll(Date.now());

    // 1) light 周期生成退役提案(真实 MaintenanceEngine + ProposalEngine)
    const maint = new MaintenanceEngine(
      {
        repository: repo,
        signalSink: new MemorySignalSink(),
        skillRepository: skillRepo,
        proposalEngine: engine,
      },
      { enabledStages: ["light"] },
    );
    const report = await maint.runLight();
    expect(report.skillsRetireProposed).toBe(1);

    // 2) 退役前 skill_list 可见
    const ctx = makeCtx();
    const before = skillListTool.execute({}, ctx) as {
      items: { skillId: string }[];
    };
    expect(before.items.some((s) => s.skillId === "scenario-skill")).toBe(true);

    // 3) accept(用户裁决)→ 默认不列;includeRetired 可查且带 retiredAt
    engine.accept(skillRetireEntityId("scenario-skill"), {
      createdBy: "scenario",
    });
    const after = skillListTool.execute({}, ctx) as {
      items: { skillId: string }[];
    };
    expect(after.items.some((s) => s.skillId === "scenario-skill")).toBe(false);
    const withRetired = skillListTool.execute(
      { includeRetired: true },
      ctx,
    ) as { items: { skillId: string; retiredAt?: string }[] };
    const row = withRetired.items.find((s) => s.skillId === "scenario-skill");
    expect(row?.retiredAt).toBeDefined();

    // 4) 审计链路:propose → accept 均可查(engram_audit_query 的 action 过滤可达)
    expect(
      audit.query({ action: "skill_retire_proposed" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      audit
        .query({ action: "accept" })
        .some((e) => e.metadata?.source === "skill-retire"),
    ).toBe(true);
  });

  it("retired 技能经 skill_invoke 工具复活:清 retiredAt + pending 提案即时撤销", async () => {
    seedSkill("scenario-revive", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    engine.accept(skillRetireEntityId("scenario-revive"), {
      createdBy: "scenario",
    });
    expect(skillRepo.readSkill("scenario-revive").retiredAt).toBeDefined();

    // 另造一个 pending 提案技能,验证 invoke 的即时撤销通道
    seedSkill("scenario-pending", 40);
    skillRepo.recomputeRetentionAll(Date.now());
    engine.syncSkillRetireProposals({
      skills: skillRepo.listSkills(),
      minZeroUseDays: 30,
    });
    expect(
      engine
        .listPending()
        .some((p) => p.payload?.skillId === "scenario-pending"),
    ).toBe(true);

    const ctx = makeCtx();
    const result = await skillInvokeTool.execute(
      { id: "scenario-pending", success: true, effectiveness: 0.9 },
      ctx,
    );
    // 使用即复活:retention 回 active;pending 退役提案被撤销
    expect(result.output).toContain("retentionStage=active");
    expect(skillRepo.readSkill("scenario-pending").retentionStage).toBe(
      "active",
    );
    expect(
      engine
        .listPending()
        .some((p) => p.payload?.skillId === "scenario-pending"),
    ).toBe(false);

    // retired 技能被使用:清 retiredAt + 审计标注 revivedFrom=retired
    const revived = await skillInvokeTool.execute(
      { id: "scenario-revive", success: true },
      ctx,
    );
    expect(revived.output).toContain("revivedFrom=retired");
    expect(skillRepo.readSkill("scenario-revive").retiredAt).toBeUndefined();
    expect(
      audit
        .query({ action: "skill_invoke" })
        .some(
          (e) =>
            e.metadata?.revivedFrom === "retired" &&
            e.metadata?.skillId === "scenario-revive",
        ),
    ).toBe(true);
  });
});
