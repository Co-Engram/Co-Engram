import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { recordRetrievalFailure } from "../src/reinforcement/ltd.js";

describe("LTD confidence 调制", () => {
  it("低置信+错→加速衰减(delta 更负);高置信正常衰减", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltd-conf-"));
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
      repo.updateConfidence(a.id, 0.85); // 正常置信(default)
      repo.updateConfidence(b.id, 0.2); // 低置信
      const ra = recordRetrievalFailure(repo, a.id); // 正常→×1
      const rb = recordRetrievalFailure(repo, b.id); // 低置信→加速
      expect(rb.importanceDelta).toBeLessThan(ra.importanceDelta); // rb 更负
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
