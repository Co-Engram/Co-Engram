import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeImprint, readImprint, deleteImprint, scanAllImprints, sidecarPath, fallbackPath, computeImprintHash } from "../src/skill/imprint.js";
import type { SkillImprint } from "../src/types/skill.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "skill-imprint-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function sample(over: Partial<SkillImprint> = {}): SkillImprint {
  return {
    schemaVersion: 1, skillId: "s1", sourcePath: "tools/s1", contentHash: "sha256:x",
    initiationSet: "when X", termination: "until Y", policy: { kind: "prompt", ref: "SKILL.md" },
    utility: 0.5, sampleSize: 0, invocationCount: 0, successCount: 0, failureCount: 0,
    lastUsedAt: null, acquisitionStage: "draft", retentionStage: "active",
    visibility: "team", createdBy: "t", createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z", version: 1, ...over,
  };
}

describe("sidecar storage", () => {
  it("可写目录 → 写到 sourcePath/.co-engram/imprint.json", () => {
    writeImprint(root, sample());
    const p = sidecarPath(root, "tools/s1");
    expect(existsSync(p)).toBe(true);
  });
  it("读写往返一致", () => {
    writeImprint(root, sample({ utility: 0.7 }));
    const got = readImprint(root, "s1", "tools/s1");
    expect(got?.utility).toBe(0.7);
  });
  it("非法 sourcePath（路径逃逸）→ safeJoinWithinRoot 抛 → 回退到 dataRoot skill-imprints/<hash>", () => {
    writeImprint(root, sample({ skillId: "ro", sourcePath: "../escape/s1" }));
    expect(existsSync(fallbackPath(root, "ro"))).toBe(true);
    const got = readImprint(root, "ro", "../escape/s1");
    expect(got?.skillId).toBe("ro");
  });
  it("read 不存在返回 null", () => {
    expect(readImprint(root, "nope", "tools/nope")).toBeNull();
  });
  it("delete 删 sidecar 与 fallback", () => {
    writeImprint(root, sample());
    deleteImprint(root, "s1", "tools/s1");
    expect(readImprint(root, "s1", "tools/s1")).toBeNull();
  });
  it("scanAllImprints 收集所有印迹（sidecar 为真理源，覆盖 fallback）", () => {
    writeImprint(root, sample({ skillId: "a", sourcePath: "tools/a" }));
    writeImprint(root, sample({ skillId: "b", sourcePath: "tools/b" }));
    const ids = scanAllImprints(root).map((i) => i.skillId).sort();
    expect(ids).toEqual(["a", "b"]);
  });
  it("computeImprintHash 对 skillId+sourcePath 稳定", () => {
    expect(computeImprintHash("s1", "tools/s1")).toBe(computeImprintHash("s1", "tools/s1"));
  });
});
