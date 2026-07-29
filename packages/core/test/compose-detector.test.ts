import { describe, it, expect } from "vitest";
import { tokenize, detectComposeCandidates } from "../src/skill/compose-detector.js";
import type { Skill } from "../src/types/skill.js";

function mkSkill(skillId: string, initiationSet: string, termination: string): Skill {
  return { schemaVersion: 1, skillId, sourcePath: `tools/${skillId}`, contentHash: "x", initiationSet, termination, policy: { kind: "prompt", ref: "SKILL.md" }, utility: 0.5, sampleSize: 0, invocationCount: 0, successCount: 0, failureCount: 0, lastUsedAt: null, acquisitionStage: "draft", retentionStage: "active", composes: [], relatedEngrams: [], visibility: "team", createdBy: "t", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z", version: 1 };
}

describe("tokenize", () => {
  it("英文分词 + 去停用词 + 小写", () => {
    const t = tokenize("When the user asks to search");
    expect(t.has("user")).toBe(true);
    expect(t.has("search")).toBe(true);
    expect(t.has("the")).toBe(false);  // 停用词
    expect(t.has("when")).toBe(false); // 停用词
  });
  it("中文 bigram", () => {
    const t = tokenize("查询通讯录");
    expect(t.has("查询")).toBe(true);
    expect(t.has("询通")).toBe(true);
    expect(t.has("通讯")).toBe(true);
  });
});

describe("detectComposeCandidates", () => {
  it("termination(A) 与 initiationSet(B) 重合 → 候选 A→B", () => {
    const a = mkSkill("a", "启动 a 时", "拿到工号");
    const b = mkSkill("b", "拿到工号后发消息", "消息发送完成");
    const cands = detectComposeCandidates([a, b]);
    const ab = cands.find((c) => c.from === "a" && c.to === "b");
    expect(ab).toBeDefined();  // termination(a)="拿到工号" ∩ initiationSet(b)="拿到工号后" 重合
    expect(ab?.overlap).toContain("拿到");
  });
  it("不重合 → 无候选", () => {
    const a = mkSkill("a", "查询", "完成后");
    const b = mkSkill("b", "部署时", "部署完成");
    const cands = detectComposeCandidates([a, b]);
    expect(cands.length).toBe(0);  // termination(a) 与 initiationSet(b) 无重合
  });
  it("不自环（A→A 不算）", () => {
    const a = mkSkill("a", "完成", "完成");
    const cands = detectComposeCandidates([a]);
    expect(cands.length).toBe(0);  // 单 skill，A→A 排除
  });
  it("minOverlap 控制", () => {
    const a = mkSkill("a", "x", "工号 拿到");
    const b = mkSkill("b", "工号 拿到 后", "y");
    const c1 = detectComposeCandidates([a, b], { minOverlap: 1 });
    expect(c1.length).toBeGreaterThan(0);
    const c2 = detectComposeCandidates([a, b], { minOverlap: 5 });
    expect(c2.length).toBe(0);  // 重合不够 5
  });
});
