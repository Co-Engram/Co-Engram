import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { applyConfidenceSignal } from "../src/reinforcement/confidence.js";

describe("verification 升级 → confidence +0.2", () => {
  it("升级后 confidence 上升(上限 0.95)", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const e = repo.createEngram({
        title: "t",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      repo.updateConfidence(
        e.id,
        applyConfidenceSignal(repo.readEngram(e.id).confidence, "verify"),
      );
      expect(repo.readEngram(e.id).confidence).toBeCloseTo(
        Math.min(0.95, 0.85 + 0.2),
        5,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
