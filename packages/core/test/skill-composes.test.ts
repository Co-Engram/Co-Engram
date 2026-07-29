import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { scanAllImprints, SIDECAR_DIR, SIDECAR_FILE } from "../src/skill/imprint.js";

let root: string;
let repo: SkillRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-comp-"));
  repo = new SkillRepository(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const create = (id: string) =>
  repo.createSkill({
    skillId: id,
    sourcePath: `tools/${id}`,
    initiationSet: "x",
    termination: "y",
    policy: { kind: "prompt", ref: "SKILL.md" },
    createdBy: "t",
  });

describe("composes/relatedEngrams", () => {
  it("新 skill composes/relatedEngrams 默认 []", () => {
    const s = create("a");
    expect(s.composes).toEqual([]);
    expect(s.relatedEngrams).toEqual([]);
  });

  it("createSkill 传 composes 初始化", () => {
    const s = repo.createSkill({
      skillId: "a",
      sourcePath: "tools/a",
      initiationSet: "x",
      termination: "y",
      policy: { kind: "prompt", ref: "SKILL.md" },
      createdBy: "t",
      composes: ["b", "c"],
    });
    expect(s.composes).toEqual(["b", "c"]);
  });

  it("向后兼容：旧 imprint（无 composes 字段）读取默认 []", () => {
    // 手写一个 S1 时代的旧 imprint（无 composes/relatedEngrams）
    const dir = join(root, "tools", "legacy");
    mkdirSync(join(dir, SIDECAR_DIR), { recursive: true });
    const legacy = {
      schemaVersion: 1,
      skillId: "legacy",
      sourcePath: "tools/legacy",
      contentHash: "sha256:x",
      initiationSet: "x",
      termination: "y",
      policy: { kind: "prompt", ref: "SKILL.md" },
      utility: 0.5,
      sampleSize: 0,
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
      acquisitionStage: "draft",
      retentionStage: "active",
      visibility: "team",
      createdBy: "t",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      version: 1,
    };
    writeFileSync(join(dir, SIDECAR_DIR, SIDECAR_FILE), JSON.stringify(legacy));
    const read = repo.readSkill("legacy");
    expect(read.composes).toEqual([]); // 旧 imprint 兜底
    expect(read.relatedEngrams).toEqual([]);
  });
});
