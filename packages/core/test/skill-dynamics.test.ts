import { describe, it, expect } from "vitest";
import type { Skill, SkillImprint, AcquisitionStage, RetentionStage } from "../src/types/skill.js";

describe("Skill types", () => {
  it("Skill 含 spec v2 精简字段", () => {
    const s: Skill = {
      skillId: "icenter-contacts",
      sourcePath: "tools/icenter-contacts",
      contentHash: "sha256:abc",
      initiationSet: "查询 iCenter 通讯录时",
      termination: "拿到工号或群 ID 后",
      policy: { kind: "claude-skill", ref: "SKILL.md" },
      utility: 0.5,
      sampleSize: 0,
      invocationCount: 0, successCount: 0, failureCount: 0,
      lastUsedAt: null,
      acquisitionStage: "draft",
      retentionStage: "active",
      visibility: "team",
      createdBy: "tester", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z",
      version: 1,
    };
    expect(s.skillId).toBe("icenter-contacts");
  });
});
