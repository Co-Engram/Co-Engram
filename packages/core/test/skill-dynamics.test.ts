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

import { updateUtility, computeRetention, projectRetentionStage, canTransitionAcquisition } from "../src/skill/dynamics.js";

describe("updateUtility (Rescorla-Wagner)", () => {
  it("成功 reward=1 拉升 utility", () => {
    expect(updateUtility(0.5, 1.0, 0.1)).toBeCloseTo(0.55);
  });
  it("失败 reward=0 拉低 utility", () => {
    expect(updateUtility(0.5, 0.0, 0.1)).toBeCloseTo(0.45);
  });
  it("clamp 到 [0,1]", () => {
    expect(updateUtility(0.99, 1.0, 0.1)).toBeLessThanOrEqual(1);
    expect(updateUtility(0.01, 0.0, 0.1)).toBeGreaterThanOrEqual(0);
  });
});

describe("computeRetention (Oblivion exp(-n/S))", () => {
  const base = { utility: 0.5, invocationCount: 10, lastUsedAt: "2026-07-01T00:00:00.000Z" } as const;
  it("刚使用 retention 接近 1（n≈0）", () => {
    const r = computeRetention(base, new Date("2026-07-01T00:00:01.000Z").getTime());
    expect(r).toBeGreaterThan(0.99);
  });
  it("长期不用 retention 衰退", () => {
    const r = computeRetention(base, new Date("2026-08-01T00:00:00.000Z").getTime());
    expect(r).toBeLessThan(0.5);
  });
  it("高 utility 衰退更慢（S 更大）", () => {
    const low = computeRetention({ ...base, utility: 0.2 }, new Date("2026-07-15T00:00:00.000Z").getTime());
    const high = computeRetention({ ...base, utility: 0.9 }, new Date("2026-07-15T00:00:00.000Z").getTime());
    expect(high).toBeGreaterThan(low);
  });
});

describe("projectRetentionStage", () => {
  it("retention → stage 阈值", () => {
    expect(projectRetentionStage(0.9)).toBe("active");
    expect(projectRetentionStage(0.6)).toBe("aging");
    expect(projectRetentionStage(0.3)).toBe("stale");
    expect(projectRetentionStage(0.1)).toBe("forgotten");
  });
});

describe("canTransitionAcquisition", () => {
  it("draft→compiled→tuned 单向合法", () => {
    expect(canTransitionAcquisition("draft", "compiled")).toBe(true);
    expect(canTransitionAcquisition("compiled", "tuned")).toBe(true);
  });
  it("逆向 / 跳级非法", () => {
    expect(canTransitionAcquisition("tuned", "compiled")).toBe(false);
    expect(canTransitionAcquisition("draft", "tuned")).toBe(false);
  });
});
