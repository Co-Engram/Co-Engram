import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  computeFreshnessBatch,
  DEFAULT_HALF_LIFE_DAYS,
} from "../src/lifecycle/freshness.js";

const DAY_MS = 1000 * 60 * 60 * 24;

describe("computeFreshness", () => {
  it("decayHalfLifeDays=null → 永远 fresh", () => {
    const old = new Date("2020-01-01").toISOString();
    expect(computeFreshness(old, null)).toBe("fresh");
  });

  it("从未有效检索 → fresh（新建 engram）", () => {
    expect(computeFreshness(null, 90)).toBe("fresh");
    expect(computeFreshness(undefined, 90)).toBe("fresh");
  });

  it("halfLife 内 → fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const recent = new Date(now.getTime() - 10 * DAY_MS).toISOString(); // 10 天前
    expect(computeFreshness(recent, 90, now)).toBe("fresh");
  });

  it("1×~2×halfLife → aging", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age100Days = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    expect(computeFreshness(age100Days, 90, now)).toBe("aging");
  });

  it("2×~4×halfLife → stale", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age200Days = new Date(now.getTime() - 200 * DAY_MS).toISOString();
    expect(computeFreshness(age200Days, 90, now)).toBe("stale");
  });

  it("4×+halfLife → forgotten", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const age400Days = new Date(now.getTime() - 400 * DAY_MS).toISOString();
    expect(computeFreshness(age400Days, 90, now)).toBe("forgotten");
  });

  it("未来时间（时钟偏差）→ fresh", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const future = new Date(now.getTime() + 1000 * DAY_MS).toISOString();
    expect(computeFreshness(future, 90, now)).toBe("fresh");
  });

  it("非法时间戳 → fresh", () => {
    expect(computeFreshness("not-a-date", 90)).toBe("fresh");
  });

  it("DEFAULT_HALF_LIFE_DAYS = 90", () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(90);
  });
});

describe("computeFreshnessBatch", () => {
  it("批量计算", () => {
    const now = new Date("2026-06-20T00:00:00Z");
    const items = [
      { lastEffectiveAt: null, decayHalfLifeDays: 90 }, // fresh
      {
        lastEffectiveAt: new Date(now.getTime() - 200 * DAY_MS).toISOString(),
        decayHalfLifeDays: 90,
      }, // stale
      {
        lastEffectiveAt: new Date(now.getTime() - 400 * DAY_MS).toISOString(),
        decayHalfLifeDays: 90,
      }, // forgotten
    ];
    const result = computeFreshnessBatch(items, now);
    expect(result).toEqual(["fresh", "stale", "forgotten"]);
  });
});
