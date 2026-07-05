import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  computeFreshnessBatch,
  effectiveAge,
} from "../src/lifecycle/freshness.js";
import { deriveHalfLifeDays } from "../src/importance/dynamics.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const FIXED_CREATED_AT = "2020-01-01T00:00:00Z";

describe("effectiveAge", () => {
  const now = new Date("2026-06-20T00:00:00Z");

  it("lastEffectiveAt 优先于 createdAt", () => {
    const lastEffective = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    const createdAt = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    expect(effectiveAge(lastEffective, createdAt, now)).toBeCloseTo(10, 5);
  });

  it("lastEffectiveAt=null/undefined → 用 createdAt", () => {
    const createdAt = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    expect(effectiveAge(null, createdAt, now)).toBeCloseTo(30, 5);
    expect(effectiveAge(undefined, createdAt, now)).toBeCloseTo(30, 5);
  });

  it("损坏 lastEffectiveAt 字符串 → fallback 到 createdAt", () => {
    const createdAt = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    expect(effectiveAge("not-a-date", createdAt, now)).toBeCloseTo(30, 5);
  });

  it("两者都损坏/缺失 → 0(视为 fresh)", () => {
    expect(effectiveAge("not-a-date", "not-a-date-either", now)).toBe(0);
    expect(effectiveAge(null, "", now)).toBe(0);
  });

  it("未来时间(时钟偏差)→ 0", () => {
    const future = new Date(now.getTime() + 1000 * DAY_MS).toISOString();
    expect(effectiveAge(future, FIXED_CREATED_AT, now)).toBe(0);
  });
});

describe("computeFreshness", () => {
  it("未生效 engram 用 createdAt 兜底,新记忆从编码完成起开始衰退", () => {
    // importance=0.5 → deriveHalfLifeDays(0.5) ≈ 14 天
    const halfLife = deriveHalfLifeDays(0.5);
    const now = new Date("2026-06-20T00:00:00Z");
    const recent = new Date(now.getTime() - 5 * DAY_MS).toISOString();
    const withinAging = new Date(
      now.getTime() - (halfLife + 1) * DAY_MS,
    ).toISOString();
    const withinStale = new Date(
      now.getTime() - (halfLife * 2 + 1) * DAY_MS,
    ).toISOString();
    const forgotten = new Date(
      now.getTime() - (halfLife * 4 + 1) * DAY_MS,
    ).toISOString();

    expect(computeFreshness(recent, FIXED_CREATED_AT, 0.5, now)).toBe("fresh");
    expect(computeFreshness(withinAging, FIXED_CREATED_AT, 0.5, now)).toBe(
      "aging",
    );
    expect(computeFreshness(withinStale, FIXED_CREATED_AT, 0.5, now)).toBe(
      "stale",
    );
    expect(computeFreshness(forgotten, FIXED_CREATED_AT, 0.5, now)).toBe(
      "forgotten",
    );
  });

  it("importance 越高 → halflife 越长 → 衰退越慢(高 importance 在更老年龄仍 fresh)", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    // 30 天前生效
    const lastEff = new Date(now.getTime() - 30 * DAY_MS).toISOString();

    // 低 importance:halflife 短,30 天可能已 forgotten
    const low = computeFreshness(lastEff, FIXED_CREATED_AT, 0.05, now);
    // 高 importance:halflife 长,30 天仍 fresh
    const high = computeFreshness(lastEff, FIXED_CREATED_AT, 0.9, now);

    // 验收:high 比 low 更 fresh(low 字典序在前 = forgotten 先于 fresh)
    const order = ["fresh", "aging", "stale", "forgotten"];
    expect(order.indexOf(high)).toBeLessThan(order.indexOf(low));
  });

  it("halfLife 内 → fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const recent = new Date(
      now.getTime() - (halfLife - 1) * DAY_MS,
    ).toISOString();
    expect(computeFreshness(recent, FIXED_CREATED_AT, 0.5, now)).toBe("fresh");
  });

  it("1×~2×halfLife → aging", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const age = new Date(
      now.getTime() - (halfLife * 1.5) * DAY_MS,
    ).toISOString();
    expect(computeFreshness(age, FIXED_CREATED_AT, 0.5, now)).toBe("aging");
  });

  it("2×~4×halfLife → stale", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const age = new Date(
      now.getTime() - (halfLife * 3) * DAY_MS,
    ).toISOString();
    expect(computeFreshness(age, FIXED_CREATED_AT, 0.5, now)).toBe("stale");
  });

  it("4×+halfLife → forgotten", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const age = new Date(
      now.getTime() - (halfLife * 5) * DAY_MS,
    ).toISOString();
    expect(computeFreshness(age, FIXED_CREATED_AT, 0.5, now)).toBe("forgotten");
  });

  it("未来时间(时钟偏差)→ fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const future = new Date(now.getTime() + 1000 * DAY_MS).toISOString();
    expect(computeFreshness(future, FIXED_CREATED_AT, 0.5, now)).toBe("fresh");
  });

  it("非法 lastEffectiveAt → fallback 到 createdAt 衰退", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const createdStale = new Date(
      now.getTime() - (halfLife * 3) * DAY_MS,
    ).toISOString();
    expect(computeFreshness("not-a-date", createdStale, 0.5, now)).toBe("stale");
  });
});

describe("computeFreshnessBatch", () => {
  it("批量计算(含未生效 engram)", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const halfLife = deriveHalfLifeDays(0.5);
    const items = [
      // 未生效 + 5 天前创建 → fresh
      {
        lastEffectiveAt: null,
        createdAt: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
        importance: 0.5,
      },
      // 已生效 + 3×halfLife → stale
      {
        lastEffectiveAt: new Date(
          now.getTime() - (halfLife * 3) * DAY_MS,
        ).toISOString(),
        createdAt: FIXED_CREATED_AT,
        importance: 0.5,
      },
      // 已生效 + 5×halfLife → forgotten
      {
        lastEffectiveAt: new Date(
          now.getTime() - (halfLife * 5) * DAY_MS,
        ).toISOString(),
        createdAt: FIXED_CREATED_AT,
        importance: 0.5,
      },
    ];
    const result = computeFreshnessBatch(items, now);
    expect(result).toEqual(["fresh", "stale", "forgotten"]);
  });
});
