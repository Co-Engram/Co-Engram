import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  computeRpe,
  applyRpeUpdate,
  DEFAULT_RPE_LEARNING_RATE,
  RPE_DEAD_ZONE,
} from "../src/signals/rpe.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rpe-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(lastRetrievalScore?: number) {
  const engram = repo.createEngram({
    title: "Test engram",
    content: "hello world",
    kind: "fact",
    domainTags: ["dev"],
    createdBy: "tester",
  });
  if (lastRetrievalScore !== undefined) {
    repo.bumpRetrievalStats(engram.id, { lastRetrievalScore });
  }
  return engram;
}

// ============================================================
// computeRpe 纯函数
// ============================================================

describe("computeRpe 纯函数", () => {
  it("无信号（signalCount=0）→ 返回 0", () => {
    const eff = computeRpe({
      expected: 0.5,
      signalWeight: 0.8,
      signalCount: 0,
    });
    expect(eff).toBe(0);
  });

  it("signalWeight=+1, expected=0.5 → +0.5（超预期）", () => {
    const eff = computeRpe({ expected: 0.5, signalWeight: 1, signalCount: 1 });
    // actual = (1+1)/2 = 1; rpe = 1 - 0.5 = 0.5
    expect(eff).toBeCloseTo(0.5, 5);
  });

  it("signalWeight=-1, expected=0.5 → -0.5（失望）", () => {
    const eff = computeRpe({ expected: 0.5, signalWeight: -1, signalCount: 1 });
    // actual = (-1+1)/2 = 0; rpe = 0 - 0.5 = -0.5
    expect(eff).toBeCloseTo(-0.5, 5);
  });

  it("signalWeight=0, expected=0.5 → 0（中立）", () => {
    const eff = computeRpe({ expected: 0.5, signalWeight: 0, signalCount: 1 });
    // actual = 0.5; rpe = 0
    expect(eff).toBeCloseTo(0, 5);
  });

  it("signalWeight=+1, expected=1 → 0（满分+强信号，没超预期）", () => {
    const eff = computeRpe({ expected: 1, signalWeight: 1, signalCount: 1 });
    expect(eff).toBeCloseTo(0, 5);
  });

  it("signalWeight=+1, expected=0 → +1（满分超预期，最低期望）", () => {
    const eff = computeRpe({ expected: 0, signalWeight: 1, signalCount: 1 });
    expect(eff).toBeCloseTo(1, 5);
  });

  it("signalWeight clamp 到 [-1,1]", () => {
    const eff = computeRpe({ expected: 0.5, signalWeight: 5, signalCount: 1 });
    expect(eff).toBeCloseTo(0.5, 5);
  });

  it("expected clamp 到 [0,1]", () => {
    const eff = computeRpe({ expected: 2, signalWeight: 1, signalCount: 1 });
    // expected=1 after clamp; rpe = 1 - 1 = 0
    expect(eff).toBeCloseTo(0, 5);
  });

  it("返回值始终 ∈ [-1, 1]", () => {
    for (const expected of [-1, 0, 0.5, 1, 2]) {
      for (const sw of [-5, -1, 0, 0.5, 1, 5]) {
        const eff = computeRpe({ expected, signalWeight: sw, signalCount: 1 });
        expect(eff).toBeGreaterThanOrEqual(-1);
        expect(eff).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ============================================================
// applyRpeUpdate 写库
// ============================================================

describe("applyRpeUpdate 写库", () => {
  it("eff > 0 → effectiveRetrievals+1, reinforcementScore 增加", () => {
    const e = makeEngram(0.5);
    const result = applyRpeUpdate(repo, e.id, 0.5);
    expect(result.action).toBe("reinforced");
    expect(result.delta).toBeCloseTo(0.5 * DEFAULT_RPE_LEARNING_RATE, 5);
    const updated = repo.readEngram(e.id);
    expect(updated.effectiveRetrievals).toBe(1);
    expect(updated.failedUses).toBe(0);
    expect(updated.reinforcementScore).toBeCloseTo(0.05, 5);
  });

  it("eff < 0 → failedUses+1, reinforcementScore 减少", () => {
    const e = makeEngram(0.5);
    const result = applyRpeUpdate(repo, e.id, -0.5);
    expect(result.action).toBe("penalized");
    expect(result.delta).toBeCloseTo(-0.05, 5);
    const updated = repo.readEngram(e.id);
    expect(updated.failedUses).toBe(1);
    expect(updated.effectiveRetrievals).toBe(0);
    expect(updated.reinforcementScore).toBeCloseTo(-0.05, 5);
  });

  it("|eff| ≤ dead zone → 不更新", () => {
    const e = makeEngram(0.5);
    const result = applyRpeUpdate(repo, e.id, 0.04);
    expect(result.action).toBe("neutral");
    expect(result.delta).toBe(0);
    const updated = repo.readEngram(e.id);
    expect(updated.effectiveRetrievals).toBe(0);
    expect(updated.failedUses).toBe(0);
    expect(updated.reinforcementScore).toBe(0);
  });

  it("dead zone 边界（刚好等于）→ 不更新", () => {
    const e = makeEngram(0.5);
    const result = applyRpeUpdate(repo, e.id, RPE_DEAD_ZONE);
    expect(result.action).toBe("neutral");
  });

  it("略大于 dead zone → 触发更新", () => {
    const e = makeEngram(0.5);
    const result = applyRpeUpdate(repo, e.id, RPE_DEAD_ZONE + 0.001);
    expect(result.action).toBe("reinforced");
  });

  it("不触发 version++", () => {
    const e = makeEngram(0.5);
    const before = repo.readEngram(e.id).version;
    applyRpeUpdate(repo, e.id, 0.5);
    const after = repo.readEngram(e.id).version;
    expect(after).toBe(before);
  });

  it("多次累积调用 → reinforcementScore 单调（正信号）", () => {
    const e = makeEngram(0.5);
    applyRpeUpdate(repo, e.id, 0.5);
    applyRpeUpdate(repo, e.id, 0.3);
    applyRpeUpdate(repo, e.id, 0.2);
    const updated = repo.readEngram(e.id);
    expect(updated.effectiveRetrievals).toBe(3);
    // 累积 (0.5+0.3+0.2) * 0.1 = 0.1
    expect(updated.reinforcementScore).toBeCloseTo(0.1, 5);
  });

  it("正负交替 → reinforcementScore 净增/净减", () => {
    const e = makeEngram(0.5);
    applyRpeUpdate(repo, e.id, 0.5); // +0.05
    applyRpeUpdate(repo, e.id, -0.3); // -0.03
    const updated = repo.readEngram(e.id);
    expect(updated.effectiveRetrievals).toBe(1);
    expect(updated.failedUses).toBe(1);
    expect(updated.reinforcementScore).toBeCloseTo(0.02, 5);
  });

  it("reinforced 时写 lastEffectiveAt 时间戳", () => {
    const e = makeEngram(0.5);
    const before = Date.now();
    applyRpeUpdate(repo, e.id, 0.5);
    const updated = repo.readEngram(e.id);
    expect(updated.lastEffectiveAt).toBeTruthy();
    const t = new Date(updated.lastEffectiveAt!).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("penalized 时不更新 lastEffectiveAt", () => {
    const e = makeEngram(0.5);
    applyRpeUpdate(repo, e.id, -0.5);
    const updated = repo.readEngram(e.id);
    expect(updated.lastEffectiveAt).toBeUndefined();
  });

  it("自定义 learningRate 生效", () => {
    const e = makeEngram(0.5);
    applyRpeUpdate(repo, e.id, 0.5, 0.5); // lr = 0.5
    const updated = repo.readEngram(e.id);
    expect(updated.reinforcementScore).toBeCloseTo(0.25, 5);
  });

  it("默认 learningRate = 0.1", () => {
    expect(DEFAULT_RPE_LEARNING_RATE).toBe(0.1);
  });

  it("engramId 不存在 → 不抛错（bumpRetrievalStats 早退）", () => {
    expect(() => applyRpeUpdate(repo, "nonexistent-id", 0.5)).not.toThrow();
  });
});
