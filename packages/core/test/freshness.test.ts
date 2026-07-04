import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  computeFreshnessBatch,
  effectiveAge,
  DEFAULT_HALF_LIFE_DAYS,
} from "../src/lifecycle/freshness.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const FIXED_CREATED_AT = "2020-01-01T00:00:00Z";

describe("effectiveAge", () => {
  const now = new Date("2026-06-20T00:00:00Z");

  it("lastEffectiveAt 优先于 createdAt", () => {
    const lastEffective = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    const createdAt = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    // 应该用 lastEffectiveAt(10 天前),不是 createdAt(100 天前)
    expect(effectiveAge(lastEffective, createdAt, now)).toBeCloseTo(10, 5);
  });

  it("lastEffectiveAt=null/undefined → 用 createdAt", () => {
    const createdAt = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    expect(effectiveAge(null, createdAt, now)).toBeCloseTo(30, 5);
    expect(effectiveAge(undefined, createdAt, now)).toBeCloseTo(30, 5);
  });

  it("损坏 lastEffectiveAt 字符串 → fallback 到 createdAt", () => {
    const createdAt = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    // lastEffectiveAt 是损坏字符串 → fallback 用 createdAt(30 天前)
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
  it("decayHalfLifeDays=null → 永远 fresh", () => {
    const old = new Date("2020-01-01").toISOString();
    expect(computeFreshness(old, FIXED_CREATED_AT, null)).toBe("fresh");
  });

  it("未生效 engram 用 createdAt 兜底,新记忆从编码完成起开始衰退", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const created10DaysAgo = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    const created100DaysAgo = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    const created200DaysAgo = new Date(now.getTime() - 200 * DAY_MS).toISOString();
    const created400DaysAgo = new Date(now.getTime() - 400 * DAY_MS).toISOString();

    expect(computeFreshness(null, created10DaysAgo, 90, now)).toBe("fresh");
    expect(computeFreshness(undefined, created10DaysAgo, 90, now)).toBe("fresh");
    expect(computeFreshness(null, created100DaysAgo, 90, now)).toBe("aging");
    expect(computeFreshness(null, created200DaysAgo, 90, now)).toBe("stale");
    expect(computeFreshness(null, created400DaysAgo, 90, now)).toBe("forgotten");
  });

  it("halfLife 内 → fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const recent = new Date(now.getTime() - 10 * DAY_MS).toISOString(); // 10 天前
    expect(computeFreshness(recent, FIXED_CREATED_AT, 90, now)).toBe("fresh");
  });

  it("1×~2×halfLife → aging", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age100Days = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    expect(computeFreshness(age100Days, FIXED_CREATED_AT, 90, now)).toBe("aging");
  });

  it("2×~4×halfLife → stale", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age200Days = new Date(now.getTime() - 200 * DAY_MS).toISOString();
    expect(computeFreshness(age200Days, FIXED_CREATED_AT, 90, now)).toBe("stale");
  });

  it("4×+halfLife → forgotten", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age400Days = new Date(now.getTime() - 400 * DAY_MS).toISOString();
    expect(computeFreshness(age400Days, FIXED_CREATED_AT, 90, now)).toBe("forgotten");
  });

  it("未来时间(时钟偏差)→ fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const future = new Date(now.getTime() + 1000 * DAY_MS).toISOString();
    expect(computeFreshness(future, FIXED_CREATED_AT, 90, now)).toBe("fresh");
  });

  it("非法 lastEffectiveAt → fallback 到 createdAt 衰退", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const created200DaysAgo = new Date(now.getTime() - 200 * DAY_MS).toISOString();
    // lastEffectiveAt 损坏 → fallback 到 createdAt(200 天前)→ freshness="stale"
    expect(computeFreshness("not-a-date", created200DaysAgo, 90, now)).toBe("stale");
  });

  it("DEFAULT_HALF_LIFE_DAYS = 90", () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(90);
  });
});

describe("computeFreshnessBatch", () => {
  it("批量计算(含未生效 engram)", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const items = [
      // 未生效 + 10 天前创建 → fresh
      {
        lastEffectiveAt: null,
        createdAt: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
        decayHalfLifeDays: 90,
      },
      // 已生效 + 200 天前 → stale
      {
        lastEffectiveAt: new Date(now.getTime() - 200 * DAY_MS).toISOString(),
        createdAt: FIXED_CREATED_AT,
        decayHalfLifeDays: 90,
      },
      // 已生效 + 400 天前 → forgotten
      {
        lastEffectiveAt: new Date(now.getTime() - 400 * DAY_MS).toISOString(),
        createdAt: FIXED_CREATED_AT,
        decayHalfLifeDays: 90,
      },
    ];
    const result = computeFreshnessBatch(items, now);
    expect(result).toEqual(["fresh", "stale", "forgotten"]);
  });
});
