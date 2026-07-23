// packages/core/test/importance-dynamics.test.ts
import { describe, expect, it } from "vitest";
import {
  deriveHalfLifeDays,
  effectiveImportance,
} from "../src/importance/dynamics.js";

describe("importance dynamics", () => {
  describe("deriveHalfLifeDays", () => {
    // 2026-07:指数从 2.5 降到 1.5(消除低 importance 坠落),数值随之调整
    it("returns ~23 days at importance=0.5", () => {
      expect(deriveHalfLifeDays(0.5)).toBeCloseTo(23, 0);
    });
    it("returns longer halflife for higher importance", () => {
      expect(deriveHalfLifeDays(0.9)).toBeGreaterThan(deriveHalfLifeDays(0.5));
    });
    it("returns short (but not extreme) halflife for low importance", () => {
      // 1.5 次方:importance=0.05 → ~2.9 天(原 2.5 次方 0.44 天,过于极端)
      expect(deriveHalfLifeDays(0.05)).toBeLessThan(5);
      expect(deriveHalfLifeDays(0.05)).toBeGreaterThan(1);
    });
  });

  describe("effectiveImportance", () => {
    it("returns importance * (0.3 + 0.7 * truth) per user correction", () => {
      expect(effectiveImportance(1.0, 1.0)).toBe(1.0);
      expect(effectiveImportance(1.0, 0.0)).toBeCloseTo(0.3);
      expect(effectiveImportance(0.5, 0.5)).toBeCloseTo(0.325);
    });
  });
});
