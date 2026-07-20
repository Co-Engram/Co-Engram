// packages/core/test/importance-kind.test.ts
import { describe, it, expect } from "vitest";
import { deriveHalfLifeDays, applyDailyDecay } from "../src/importance/dynamics.js";
import { computeFreshness } from "../src/lifecycle/freshness.js";
import type { EngramKind } from "../src/types/engram.js";

// ============================================================
// deriveHalfLifeDays: kind 倍率
// ============================================================

describe("deriveHalfLifeDays + kind 倍率", () => {
  it("fact(kind 默认)与不传 kind 一致", () => {
    const withKind = deriveHalfLifeDays(0.5, "fact");
    const withoutKind = deriveHalfLifeDays(0.5);
    expect(withKind).toBeCloseTo(withoutKind, 5);
  });

  it("fact 倍率 = 1.0(基准)", () => {
    expect(deriveHalfLifeDays(0.5, "fact")).toBeCloseTo(
      deriveHalfLifeDays(0.5),
      5,
    );
  });

  it("observation × 0.6(最快衰退)", () => {
    const fact = deriveHalfLifeDays(0.5, "fact");
    const obs = deriveHalfLifeDays(0.5, "observation");
    expect(obs).toBeCloseTo(fact * 0.6, 2);
  });

  it("hypothesis × 0.7", () => {
    const fact = deriveHalfLifeDays(0.5, "fact");
    const hyp = deriveHalfLifeDays(0.5, "hypothesis");
    expect(hyp).toBeCloseTo(fact * 0.7, 2);
  });

  it("procedure × 0.8(在 observation 和 fact 之间)", () => {
    const fact = deriveHalfLifeDays(0.5, "fact");
    const obs = deriveHalfLifeDays(0.5, "observation");
    const proc = deriveHalfLifeDays(0.5, "procedure");
    expect(proc).toBeCloseTo(fact * 0.8, 2);
    expect(proc).toBeGreaterThan(obs);
    expect(proc).toBeLessThan(fact);
  });

  it("pattern × 1.5(最持久)", () => {
    const fact = deriveHalfLifeDays(0.5, "fact");
    const pat = deriveHalfLifeDays(0.5, "pattern");
    expect(pat).toBeCloseTo(fact * 1.5, 2);
  });

  it("排序正确: observation < hypothesis < procedure < fact < pattern", () => {
    const imp = 0.5;
    const vals: Record<EngramKind, number> = {
      observation: deriveHalfLifeDays(imp, "observation"),
      hypothesis: deriveHalfLifeDays(imp, "hypothesis"),
      procedure: deriveHalfLifeDays(imp, "procedure"),
      fact: deriveHalfLifeDays(imp, "fact"),
      pattern: deriveHalfLifeDays(imp, "pattern"),
    };
    expect(vals.observation).toBeLessThan(vals.hypothesis);
    expect(vals.hypothesis).toBeLessThan(vals.procedure);
    expect(vals.procedure).toBeLessThan(vals.fact);
    expect(vals.fact).toBeLessThan(vals.pattern);
  });
});

// ============================================================
// computeFreshness: kind 影响 freshness 老化速度
// ============================================================

describe("computeFreshness + kind", () => {
  const createdAt = "2025-01-01T00:00:00.000Z";
  const lastEff = "2025-01-01T00:00:00.000Z";
  const now = new Date("2025-01-25T00:00:00.000Z"); // 24 天后

  it("importance=0.5 + fact → 24 天应为 aging(halfLife=23,24<2×23=46)", () => {
    const f = computeFreshness(lastEff, createdAt, 0.5, "fact", now);
    expect(f).toBe("aging");
  });

  it("importance=0.5 + observation → 24 天应为 stale(halfLife=14,24>2×14=28... 不,24<28→aging)", () => {
    // observation × 0.6 → halfLife = 23 × 0.6 = 13.8
    // 24 > 1×13.8(not fresh), 24 < 2×13.8=27.6 → aging
    const f = computeFreshness(lastEff, createdAt, 0.5, "observation", now);
    expect(f).toBe("aging");
  });

  it("importance=0.5 + pattern → 24 天应为 fresh(halfLife=35,24<35)", () => {
    const f = computeFreshness(lastEff, createdAt, 0.5, "pattern", now);
    expect(f).toBe("fresh");
  });

  it("pattern 比 observation 更抗衰退(同 importance + 同 age)", () => {
    const fObs = computeFreshness(lastEff, createdAt, 0.5, "observation", now);
    const fPat = computeFreshness(lastEff, createdAt, 0.5, "pattern", now);
    // pattern 应该比 observation 更"新鲜"或相等
    const order = ["fresh", "aging", "stale", "forgotten"];
    expect(order.indexOf(fPat)).toBeLessThanOrEqual(order.indexOf(fObs));
  });
});

// ============================================================
// applyDailyDecay 已移除(importance 不再时间驱动)
// ============================================================

describe("applyDailyDecay 已移除", () => {
  it("函数不存在(从模块导出中消失)", async () => {
    // applyDailyDecay 不再从 dynamics.ts 导出
    const dynamics = await import("../src/importance/dynamics.js");
    expect((dynamics as Record<string, unknown>).applyDailyDecay).toBeUndefined();
  });
});
