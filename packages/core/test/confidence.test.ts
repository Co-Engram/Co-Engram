import { describe, it, expect } from "vitest";
import {
  applyConfidenceSignal,
  lowConfidencePenalty,
} from "../src/reinforcement/confidence.js";

describe("applyConfidenceSignal (A3 混合速率)", () => {
  it("refute 即时大幅下跌 ×0.3", () => {
    expect(applyConfidenceSignal(0.85, "refute")).toBeCloseTo(0.255, 5);
  });
  it("verify 即时大幅上升 +0.2,上限 0.95", () => {
    expect(applyConfidenceSignal(0.6, "verify")).toBeCloseTo(0.8, 5);
    expect(applyConfidenceSignal(0.9, "verify")).toBeCloseTo(0.95, 5);
  });
  it("effective 缓升 +0.05", () => {
    expect(applyConfidenceSignal(0.5, "effective")).toBeCloseTo(0.55, 5);
  });
  it("failure 缓降 −0.05", () => {
    expect(applyConfidenceSignal(0.5, "failure")).toBeCloseTo(0.45, 5);
  });
  it("clamp [0,1]:failure 不低于 0,effective 不高于 1", () => {
    expect(applyConfidenceSignal(0.02, "failure")).toBe(0);
    expect(applyConfidenceSignal(0.98, "effective")).toBe(1);
  });
});

describe("lowConfidencePenalty", () => {
  it("confidence≥0.5 无惩罚", () => {
    expect(lowConfidencePenalty(0.5)).toBe(0);
    expect(lowConfidencePenalty(0.85)).toBe(0);
  });
  it("confidence<0.5 线性惩罚 (0.5−c)×0.1", () => {
    expect(lowConfidencePenalty(0.3)).toBeCloseTo(0.02, 5);
    expect(lowConfidencePenalty(0)).toBeCloseTo(0.05, 5);
  });
});
