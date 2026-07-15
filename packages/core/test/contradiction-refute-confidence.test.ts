import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { applyConfidenceSignal } from "../src/reinforcement/confidence.js";

describe("contradiction refute → confidence 暴跌", () => {
  it("refute 信号把 confidence 从 0.85 降到 ~0.255", () => {
    const dir = mkdtempSync(join(tmpdir(), "refute-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const e = repo.createEngram({
        title: "t",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      // 模拟 resolver refute 分支应做的:confidence 暴跌
      repo.updateConfidence(
        e.id,
        applyConfidenceSignal(repo.readEngram(e.id).confidence, "refute"),
      );
      expect(repo.readEngram(e.id).confidence).toBeCloseTo(0.85 * 0.3, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
