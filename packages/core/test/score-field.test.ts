import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatScoreField } from "../src/concepts/dictionary.js";
import { engramCreateTool, engramReinforceTool } from "../src/tools/engram-tools.js";
import { EngramRepository } from "../src/storage/repository.js";
import type { ToolContext } from "../src/tools/tool.js";

describe("formatScoreField", () => {
  it("rounds to 2 decimals (kills float noise)", () => {
    expect(formatScoreField(0.018000000000000002).raw).toBe(0.02);
    expect(formatScoreField(0.7719155626908514).raw).toBe(0.77);
    expect(formatScoreField(0.1 + 0.2).raw).toBe(0.3);
  });

  it("assigns band by threshold: high ≥0.7, medium ≥0.3, low <0.3", () => {
    expect(formatScoreField(0.95).band).toBe("high");
    expect(formatScoreField(0.7).band).toBe("high");
    expect(formatScoreField(0.69).band).toBe("medium");
    expect(formatScoreField(0.3).band).toBe("medium");
    expect(formatScoreField(0.29).band).toBe("low");
    expect(formatScoreField(0).band).toBe("low");
  });

  it("clamps negative to low band (defensive)", () => {
    expect(formatScoreField(-0.5).band).toBe("low");
    expect(formatScoreField(-0.5).raw).toBe(-0.5);
  });

  it("JSON.stringify does not leak float noise", () => {
    const field = formatScoreField(0.018000000000000002);
    const json = JSON.stringify(field);
    expect(json).not.toMatch(/0\.01800/);
    expect(json).toMatch(/0\.02/);
  });
});

describe("engramReinforceTool result bands", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let ctx: ToolContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-score-field-"));
    repo = new EngramRepository({ rootPath: tmpDir });
    ctx = { repository: repo };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("result includes band fields + rounded raw (no float noise)", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "A",
        content: "a",
        kind: "fact",
        domainTags: ["t"],
        importance: 0.5,
        createdBy: "y",
      },
      ctx,
    );
    const result = engramReinforceTool.execute(
      { id, effectiveness: 0.8 },
      ctx,
    );

    // Band fields present
    expect(["high", "medium", "low"]).toContain(result.importanceBand);
    expect(["high", "medium", "low"]).toContain(result.importanceDeltaBand);
    expect(["high", "medium", "low"]).toContain(result.reinforcementScoreBand);

    // importance starts at 0.5 → band "medium"
    expect(result.importanceBand).toBe("medium");
    // delta = effectiveness × ltpGain = 0.8 × 0.02 = 0.016 → rounds to 0.02 → band "low"
    expect(result.importanceDelta).toBeCloseTo(0.02, 2);
    expect(result.importanceDeltaBand).toBe("low");

    // No float noise in serialized output
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/0\.0160000/);
    expect(json).not.toMatch(/0\.0180000000/);
  });

  it("repeated reinforcement accumulates + bands update to high", () => {
    const { id } = engramCreateTool.execute(
      {
        title: "B",
        content: "b",
        kind: "fact",
        domainTags: ["t"],
        importance: 0.5,
        createdBy: "y",
      },
      ctx,
    );

    // 10 effective reinforcements at effectiveness=1.0 → importance 0.5 → 0.7
    for (let i = 0; i < 10; i++) {
      engramReinforceTool.execute({ id, effectiveness: 1.0 }, ctx);
    }
    const result = engramReinforceTool.execute({ id, effectiveness: 1.0 }, ctx);

    expect(result.importance).toBeGreaterThanOrEqual(0.7);
    expect(result.importanceBand).toBe("high");
  });
});
