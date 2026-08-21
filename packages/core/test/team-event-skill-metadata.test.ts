/**
 * 团队事件 metadata 投影 · skillId 白名单测试(2026-08-22)
 *
 * 背景:跨机技能动态(skill_create/skill_update)经 projectMetadata 白名单
 * 投影后 metadata 里 skillId 被丢弃,viewer 动态流只能显示动作名,看不出
 * 是哪个技能。修复:METADATA_ALLOW_KEYS 补 skillId。
 *
 * 验证:skillId 保留、非白名单键(sourcePath/patch)仍被投影掉(内容最小化
 * 原则不回退)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamEventStore } from "../src/observability/team-event-store.js";

const dataRoot = mkdtempSync(join(tmpdir(), "team-event-skill-"));
const store = new TeamEventStore(dataRoot, { origin: "alice-zte" });

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("TeamEventStore · skill 动态 metadata 投影", () => {
  it("skill_create 事件保留 skillId,sourcePath 被投影掉", () => {
    store.record({
      ts: new Date().toISOString(),
      actor: "user",
      action: "skill_create",
      metadata: {
        skillId: "patent-drafter",
        sourcePath: "skills/patent-drafter/SKILL.md",
      },
    });
    const events = store.query({ action: "skill_create" });
    expect(events.length).toBe(1);
    const meta = events[0]!.metadata ?? {};
    expect(meta.skillId).toBe("patent-drafter");
    expect("sourcePath" in meta).toBe(false);
  });

  it("skill_update 事件保留 skillId,patch/acquisitionStage 被投影掉", () => {
    store.record({
      ts: new Date().toISOString(),
      actor: "user",
      action: "skill_update",
      metadata: {
        skillId: "meeting-minutes",
        patch: ["initiationSet"],
        acquisitionStage: "compiled",
        retentionStage: "active",
      },
    });
    const events = store.query({ action: "skill_update" });
    expect(events.length).toBe(1);
    const meta = events[0]!.metadata ?? {};
    expect(meta.skillId).toBe("meeting-minutes");
    expect("patch" in meta).toBe(false);
    expect("acquisitionStage" in meta).toBe(false);
  });
});
