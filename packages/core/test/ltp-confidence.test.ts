import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { recordRetrievalSuccess } from "../src/reinforcement/ltp.js";

describe("LTP confidence 调制", () => {
  it("高置信→强化全效;低置信→强化被抑制", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltp-conf-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const a = repo.createEngram({
        title: "a",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      const b = repo.createEngram({
        title: "b",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      repo.updateConfidence(a.id, 1.0); // 高置信
      repo.updateConfidence(b.id, 0.2); // 低置信
      const ra = recordRetrievalSuccess(repo, a.id, 1.0);
      const rb = recordRetrievalSuccess(repo, b.id, 1.0);
      // 高置信 delta 显著大于低置信 delta(低置信被 ×0.2 抑制)
      expect(ra.importanceDelta).toBeGreaterThan(rb.importanceDelta * 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
