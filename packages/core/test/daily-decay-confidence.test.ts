import { describe, it, expect } from "vitest";
import { applyDailyDecay } from "../src/importance/dynamics.js";
import { lowConfidencePenalty } from "../src/reinforcement/confidence.js";

describe("daily decay + lowConfidencePenalty 组合", () => {
  it("高置信记忆:仅 ×0.95 衰减,无额外惩罚", () => {
    const next = applyDailyDecay(0.8) * (1 - lowConfidencePenalty(0.85));
    expect(next).toBeCloseTo(0.8 * 0.95, 5);
  });
  it("低置信记忆:额外加速衰减(比纯 decay 更低)", () => {
    const penalty = lowConfidencePenalty(0.2); // 0.03
    const next = applyDailyDecay(0.8) * (1 - penalty);
    expect(next).toBeLessThan(0.8 * 0.95);
    expect(penalty).toBeCloseTo(0.03, 5);
  });
  it("confidence≥0.5 无惩罚:与纯 applyDailyDecay 等价", () => {
    for (const c of [0.5, 0.7, 0.85, 1.0]) {
      expect(applyDailyDecay(0.6) * (1 - lowConfidencePenalty(c))).toBeCloseTo(
        applyDailyDecay(0.6),
        7,
      );
    }
  });
});
