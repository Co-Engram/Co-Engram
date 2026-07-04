// packages/core/test/importance-dynamics.test.ts
import { describe, expect, it } from "vitest";
import {
  updateOnCreate,
  updateOnReinforce,
  updateOnRetrieveHit,
  updateOnReportFailure,
  updateOnTaskSuccess,
  updateOnTaskFailure,
  applyDailyDecay,
  deriveHalfLifeDays,
  effectiveImportance,
} from "../src/importance/dynamics.js";

describe("importance dynamics", () => {
  describe("updateOnCreate", () => {
    it("defaults to 0.5 when no initial", () => {
      expect(updateOnCreate()).toBe(0.5);
    });
    it("clamps to [0, 1]", () => {
      expect(updateOnCreate(-0.5)).toBe(0);
      expect(updateOnCreate(1.5)).toBe(1);
    });
  });

  describe("updateOnReinforce", () => {
    it("increases by eff * LTP_GAIN (default 0.10)", () => {
      expect(updateOnReinforce(0.5, 1.0)).toBeCloseTo(0.6);
    });
    it("clamps to 1", () => {
      expect(updateOnReinforce(0.95, 1.0)).toBe(1);
    });
  });

  describe("updateOnRetrieveHit", () => {
    it("increases by RETRIEVAL_GAIN (0.05)", () => {
      expect(updateOnRetrieveHit(0.5)).toBeCloseTo(0.55);
    });
  });

  describe("updateOnReportFailure", () => {
    it("decreases by FAILURE_LOSS (0.10)", () => {
      expect(updateOnReportFailure(0.5)).toBeCloseTo(0.4);
    });
    it("clamps to 0", () => {
      expect(updateOnReportFailure(0.05)).toBe(0);
    });
  });

  describe("updateOnTaskSuccess", () => {
    it("increases by value * TASK_SUCCESS_GAIN (0.15)", () => {
      expect(updateOnTaskSuccess(0.5, 1.0)).toBeCloseTo(0.65);
    });
  });

  describe("updateOnTaskFailure", () => {
    it("decreases by TASK_FAILURE_LOSS (0.05)", () => {
      expect(updateOnTaskFailure(0.5)).toBeCloseTo(0.45);
    });
  });

  describe("applyDailyDecay", () => {
    it("multiplies by DAILY_DECAY (0.95)", () => {
      expect(applyDailyDecay(0.5)).toBeCloseTo(0.475);
    });
  });

  describe("deriveHalfLifeDays", () => {
    it("returns base 7 days at importance=0.5", () => {
      expect(deriveHalfLifeDays(0.5)).toBeCloseTo(14, 0);
    });
    it("returns longer halflife for higher importance", () => {
      expect(deriveHalfLifeDays(0.9)).toBeGreaterThan(deriveHalfLifeDays(0.5));
    });
    it("returns very short halflife for low importance", () => {
      expect(deriveHalfLifeDays(0.05)).toBeLessThan(1);
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
