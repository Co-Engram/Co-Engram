import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";

describe("evidenceCount 派生(从 derives_from synapse verdict evidence 算)", () => {
  let dir: string;
  let repo: EngramRepository;
  let a: string;
  let b: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ev-count-"));
    repo = new EngramRepository({ rootPath: dir });
    a = repo.createEngram({
      title: "a",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    b = repo.createEngram({
      title: "b",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "u",
    }).id;
    repo.createSynapse({
      from: a,
      to: b,
      kind: "derives_from",
      createdBy: "u",
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("无 verdict evidence → evidenceCount 0", () => {
    expect(repo.readEngram(a).evidenceCount).toBe(0);
  });

  it("追加 [verified] evidence → evidenceCount 1(派生,不读 frontmatter)", () => {
    const syn = repo
      .readSynapses(a)
      .outgoing.find((s) => s.kind === "derives_from")!;
    repo.replaceSynapseEvidence(a, syn.id, [
      {
        description: "[verified] 测试证据",
        addedBy: "tester",
        addedAt: new Date().toISOString(),
      },
    ]);
    expect(repo.readEngram(a).evidenceCount).toBe(1);
  });

  it("非 verdict evidence(无 [verdict] 前缀)不计入", () => {
    const syn = repo
      .readSynapses(a)
      .outgoing.find((s) => s.kind === "derives_from")!;
    repo.replaceSynapseEvidence(a, syn.id, [
      {
        description: "普通证据(非 verdict)",
        addedBy: "tester",
        addedAt: new Date().toISOString(),
      },
    ]);
    expect(repo.readEngram(a).evidenceCount).toBe(0);
  });
});
