import { describe, it, expect } from "vitest";
import type { Skill, SkillImprint, AcquisitionStage, RetentionStage } from "../src/types/skill.js";

describe("Skill types", () => {
  it("Skill 含 spec v2 精简字段", () => {
    const s: Skill = {
      skillId: "icenter-contacts",
      sourcePath: "tools/icenter-contacts",
      contentHash: "sha256:abc",
      initiationSet: "查询 iCenter 通讯录时",
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
  const base = { utility: 0.5, invocationCount: 10, lastUsedAt: "2026-07-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" } as const;
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
  it("null lastUsedAt 从 createdAt 起算（never-used 不再冻结 active）", () => {
    const r = computeRetention(
      { utility: 0.5, invocationCount: 0, lastUsedAt: null, createdAt: "2026-07-01T00:00:00.000Z" },
      new Date("2026-07-15T00:00:00.000Z").getTime(),
    );
    // S=(0.5+0+0.1)×15=9,n=14 → exp(-14/9)≈0.21 → forgotten 区间
    expect(r).toBeLessThan(0.25);
    expect(r).toBeGreaterThan(0);
  });
  it("createdAt 与 lastUsedAt 同时存在时以 lastUsedAt 为锚", () => {
    const anchoredLast = computeRetention(base, new Date("2026-07-15T00:00:00.000Z").getTime());
    const anchoredCreate = computeRetention(
      { ...base, lastUsedAt: null },
      new Date("2026-07-15T00:00:00.000Z").getTime(),
    );
    // lastUsedAt(07-01)比 createdAt(06-01)近 → retention 更高
    expect(anchoredLast).toBeGreaterThan(anchoredCreate);
  });
  it("lastUsedAt/createdAt 双 null 兜底 nowMs（n=0）", () => {
    const r = computeRetention(
      { utility: 0.5, invocationCount: 10, lastUsedAt: null, createdAt: null },
      new Date("2026-07-15T00:00:00.000Z").getTime(),
    );
    expect(r).toBeGreaterThan(0.99);
  });
  it("时钟回拨（nowMs < lastUsedAt）钳到 n=0", () => {
    const r = computeRetention(
      { utility: 0.5, invocationCount: 10, lastUsedAt: "2026-07-20T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" },
      new Date("2026-07-15T00:00:00.000Z").getTime(), // 早于 lastUsedAt
    );
    expect(r).toBeGreaterThan(0.99); // Math.max(0, nDays) → 0 天
  });
  it("OBLIVION_T=15 数值锚定：用过 1 次的技能 7 天 aging / 14 天 stale / 29 天 forgotten", () => {
    // 用过 1 次成功(eff=1)：U=0.55,F=0.05 → S=(0.55+0.05+0.1)×15=10.5 天
    const used = { utility: 0.55, invocationCount: 1, lastUsedAt: "2026-07-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" };
    const at = (days: number) =>
      projectRetentionStage(computeRetention(used, new Date("2026-07-01T00:00:00.000Z").getTime() + days * 86_400_000));
    expect(at(7)).toBe("aging");   // exp(-7/10.5)≈0.51 → aging
    expect(at(14)).toBe("stale");  // exp(-14/10.5)≈0.26 → stale
    expect(at(29)).toBe("forgotten"); // exp(-29/10.5)≈0.063 → forgotten
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
