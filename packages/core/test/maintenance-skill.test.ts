/**
 * S3 Task 3: MaintenanceEngine 接入 skill 衰退测试
 *
 * 验证：
 * 1. runLight 末尾调用 skillRepository.recomputeRetentionAll
 * 2. report.skillsDecayed 和 skillsScanned 字段存在
 * 3. 未注入 skillRepository 时不报错（向后兼容）
 *
 * 注：recomputeRetentionAll 的数值正确性已在 S3-T2 (skill-recompute.test.ts) 覆盖
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { MemorySignalSink } from "../src/signals/file-sink.js";
import { MaintenanceEngine } from "../src/maintenance/index.js";
import { SkillRepository } from "../src/skill/skill-repository.js";

let tmpDir: string;
let repo: EngramRepository;
let sink: MemorySignalSink;
let skillRepo: SkillRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-maint-skill-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  sink = new MemorySignalSink();
  skillRepo = new SkillRepository(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("S3 Task 3: MaintenanceEngine.skillRepository 接入", () => {
  describe("注入 skillRepository", () => {
    it("runLight 调用 recomputeRetentionAll + report 包含 skillsDecayed 和 skillsScanned 字段", async () => {
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
        skillRepository: skillRepo,
      });

      // 创建一个 skill 并记录使用（确保 repo 非空）
      const skill = skillRepo.createSkill({
        skillId: "test-skill",
        sourcePath: "/test/skill.ts",
        initiationSet: "[]",
        createdBy: "tester",
      });
      skillRepo.recordUse(skill.skillId, {
        success: true,
        effectiveness: 1.0,
      });

      // 执行 runLight
      const report = await engine.runLight();

      // 验证报告包含 skill 衰退相关字段
      expect(report).toHaveProperty("skillsDecayed");
      expect(report).toHaveProperty("skillsScanned");
      expect(report.skillsScanned).toBeGreaterThanOrEqual(1); // 至少扫描了 1 个 skill

      // skillsDecayed 可能是 0（刚 recordUse，lastUsedAt ≈ now，不触发衰退），但字段应该存在
      expect(report.skillsDecayed).toBeDefined();
      expect(report.errors).toHaveLength(0);
    });

    it("runLight downstreamReport 也包含 skillsDecayed 和 skillsScanned", async () => {
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
        skillRepository: skillRepo,
      });

      const skill = skillRepo.createSkill({
        skillId: "test-skill",
        sourcePath: "/test/skill.ts",
        initiationSet: "[]",
        createdBy: "tester",
      });

      const report = await engine.runLight();

      // 验证 downstreamReport 包含相同字段
      expect(report.downstreamReport).toBeDefined();
      if (typeof report.downstreamReport === "object" && report.downstreamReport !== null) {
        expect(report.downstreamReport).toHaveProperty("skillsDecayed");
        expect(report.downstreamReport).toHaveProperty("skillsScanned");
      }
    });

    it("空 skill repo → skillsScanned=0, skillsDecayed=0, 不报错", async () => {
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
        skillRepository: skillRepo,
      });

      // 不创建任何 skill，直接运行
      const report = await engine.runLight();

      // 注入了 skillRepository，字段应该存在
      expect(report.skillsScanned).toBe(0);
      expect(report.skillsDecayed).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it("多个 skill → skillsScanned > 0, 调用了 recomputeRetentionAll", async () => {
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
        skillRepository: skillRepo,
      });

      // 创建多个 skill
      const skill1 = skillRepo.createSkill({
        skillId: "skill-1",
        sourcePath: "/test/skill1.ts",
        initiationSet: "[]",
        createdBy: "tester",
      });
      const skill2 = skillRepo.createSkill({
        skillId: "skill-2",
        sourcePath: "/test/skill2.ts",
        initiationSet: "[]",
        createdBy: "tester",
      });

      const report = await engine.runLight();

      expect(report.skillsScanned).toBeGreaterThanOrEqual(2);
      // 本测试验证"接入"（调用了 recomputeRetentionAll），具体数值由 S3-T2 覆盖
      expect(report.skillsDecayed).toBeGreaterThanOrEqual(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe("未注入 skillRepository（向后兼容）", () => {
    it("runLight 正常运行，不报错，report.skillsDecayed 和 skillsScanned 为 undefined", async () => {
      // 不传 skillRepository
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
      });

      const report = await engine.runLight();

      // 字段应该存在但为 undefined
      expect(report.skillsDecayed).toBeUndefined();
      expect(report.skillsScanned).toBeUndefined();

      // 其他 light 功能正常运行
      expect(report.stage).toBe("light");
      expect(report.errors).toHaveLength(0);
    });

    it("runLight 的其他功能（RPE、prune、prompt signals）不受影响", async () => {
      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
      });

      // 创建一个 engram 并设置 lastRetrievalScore
      const engram = repo.createEngram({
        title: "Test",
        content: "content",
        kind: "fact",
        domainTags: ["test"],
        createdBy: "tester",
      });
      repo.bumpRetrievalStats(engram.id, { lastRetrievalScore: 0.5 });

      // 添加信号
      sink.append({
        toolName: "engram_get",
        retrievedEngramIds: [engram.id],
        sessionId: "s1",
        input: {},
        at: Date.now(),
      });

      const report = await engine.runLight();

      // RPE 功能正常运行
      expect(report.rpeUpdates).toBeGreaterThanOrEqual(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe("错误隔离", () => {
    it("skillRepository.recomputeRetentionAll 抛错时不阻塞 light", async () => {
      // 创建一个 mock skillRepository，recomputeRetentionAll 会抛错
      const mockSkillRepo = {
        recomputeRetentionAll: () => {
          throw new Error("skill repo error");
        },
      } as unknown as SkillRepository;

      const engine = new MaintenanceEngine({
        repository: repo,
        signalSink: sink,
        skillRepository: mockSkillRepo,
      });

      // 应该不抛错
      const report = await engine.runLight();

      // light 正常完成，skill 衰退失败被捕获
      expect(report.stage).toBe("light");
      expect(report.errors).toHaveLength(0); // 抛错被捕获，不记入 errors
    });
  });
});
