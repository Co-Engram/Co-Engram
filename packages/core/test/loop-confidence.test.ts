import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { recordRetrievalSuccess } from "../src/reinforcement/ltp.js";
import { recordRetrievalFailure } from "../src/reinforcement/ltd.js";

describe("effective/failure → confidence 缓调(ltp/ltd 内统一接入)", () => {
  it("recordRetrievalSuccess 后 confidence +0.05(effective)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-conf-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const e = repo.createEngram({
        title: "t",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      const before = repo.readEngram(e.id).confidence;
      recordRetrievalSuccess(repo, e.id, 1.0);
      expect(repo.readEngram(e.id).confidence).toBeCloseTo(before + 0.05, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recordRetrievalFailure 后 confidence −0.05(failure)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-conf-"));
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const e = repo.createEngram({
        title: "t",
        content: "c",
        kind: "fact",
        domainTags: ["x"],
        createdBy: "u",
      });
      const before = repo.readEngram(e.id).confidence;
      recordRetrievalFailure(repo, e.id);
      expect(repo.readEngram(e.id).confidence).toBeCloseTo(before - 0.05, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
