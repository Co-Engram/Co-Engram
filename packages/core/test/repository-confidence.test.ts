import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";

describe("EngramRepository.updateConfidence", () => {
  let dir: string;
  let repo: EngramRepository;
  let id: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-engram-conf-"));
    repo = new EngramRepository({ rootPath: dir });
    const created = repo.createEngram({
      title: "t",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    });
    id = created.id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("写入 confidence 到 frontmatter", () => {
    repo.updateConfidence(id, 0.42);
    expect(repo.readEngram(id).confidence).toBeCloseTo(0.42, 5);
  });
  it("clamp [0,1]", () => {
    repo.updateConfidence(id, -0.5);
    expect(repo.readEngram(id).confidence).toBe(0);
    repo.updateConfidence(id, 2);
    expect(repo.readEngram(id).confidence).toBe(1);
  });
});
