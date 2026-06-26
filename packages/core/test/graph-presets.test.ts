import { describe, it, expect } from "vitest";
import {
  knowledgeExploration,
  domainOverview,
  hubIdentification,
  contradictions,
  orphans,
  lineage,
  contributor,
  temporal,
  SCENE_PRESETS,
  findScenePreset,
  listScenePresetIds,
  DEFAULT_HUB_MIN_INCOMING,
  type ScenePresetId,
} from "../src/graph/index.js";

// ============================================================
// 8 个场景预设
// ============================================================

describe("场景 1：knowledgeExploration", () => {
  it("默认：minImportance = 0", () => {
    const f = knowledgeExploration();
    expect(f.minImportance).toBe(0);
  });

  it("自定义阈值", () => {
    const f = knowledgeExploration({ minImportance: 0.5 });
    expect(f.minImportance).toBe(0.5);
  });
});

describe("场景 2：domainOverview", () => {
  it("按 domain 过滤", () => {
    const f = domainOverview({ domainTags: ["mobile", "web"] });
    expect(f.domainTags).toEqual(["mobile", "web"]);
  });

  it("含 kinds 限制", () => {
    const f = domainOverview({ domainTags: ["x"], kinds: ["fact", "pattern"] });
    expect(f.kinds).toEqual(["fact", "pattern"]);
  });
});

describe("场景 3：hubIdentification", () => {
  it("默认 minIncoming = 10", () => {
    const f = hubIdentification();
    expect(f.minIncoming).toBe(DEFAULT_HUB_MIN_INCOMING);
    expect(DEFAULT_HUB_MIN_INCOMING).toBe(10);
  });

  it("自定义阈值", () => {
    const f = hubIdentification({ minIncoming: 5 });
    expect(f.minIncoming).toBe(5);
  });
});

describe("场景 4：contradictions", () => {
  it("contradictionsOnly = true", () => {
    const f = contradictions();
    expect(f.contradictionsOnly).toBe(true);
  });
});

describe("场景 5：orphans", () => {
  it("orphansOnly = true", () => {
    const f = orphans();
    expect(f.orphansOnly).toBe(true);
  });
});

describe("场景 6：lineage", () => {
  it("默认：包含三种血统 kind", () => {
    const f = lineage();
    expect(f.synapseKinds).toEqual([
      "derives_from",
      "consolidates",
      "supersedes",
    ]);
    expect(f.hideContradicts).toBe(true);
  });

  it("自定义 kinds", () => {
    const f = lineage({ kinds: ["derives_from"] });
    expect(f.synapseKinds).toEqual(["derives_from"]);
  });

  it("可关闭 hideContradicts", () => {
    const f = lineage({ hideContradicts: false });
    expect(f.hideContradicts).toBe(false);
  });
});

describe("场景 7：contributor", () => {
  it("按 createdBy 过滤", () => {
    const f = contributor({ createdBy: ["alice", "bob"] });
    expect(f.createdBy).toEqual(["alice", "bob"]);
  });
});

describe("场景 8：temporal", () => {
  it("时间范围 + freshness", () => {
    const f = temporal({
      createdAfter: "2026-01-01",
      createdBefore: "2026-06-01",
      freshness: ["fresh", "aging"],
    });
    expect(f.createdAfter).toBe("2026-01-01");
    expect(f.createdBefore).toBe("2026-06-01");
    expect(f.freshness).toEqual(["fresh", "aging"]);
  });

  it("全部可选 → 空 filter", () => {
    const f = temporal();
    expect(f).toEqual({});
  });
});

// ============================================================
// SCENE_PRESETS 表
// ============================================================

describe("SCENE_PRESETS 表", () => {
  it("包含 8 个预设", () => {
    expect(SCENE_PRESETS.length).toBe(8);
  });

  it("按 spec §12.7 顺序排列", () => {
    const ids = listScenePresetIds();
    expect(ids).toEqual([
      "knowledge_exploration",
      "domain_overview",
      "hub_identification",
      "contradictions",
      "orphans",
      "lineage",
      "contributor",
      "temporal",
    ]);
  });

  it("每个预设包含必要元信息", () => {
    for (const p of SCENE_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.description.length).toBeGreaterThan(5);
      expect(Array.isArray(p.requiresInput)).toBe(true);
    }
  });

  it("findScenePreset 已知 ID → 返回 meta", () => {
    const p = findScenePreset("lineage");
    expect(p).toBeDefined();
    expect(p!.label).toBe("进化血统");
  });

  it("findScenePreset 未知 ID → undefined", () => {
    const p = findScenePreset("unknown" as ScenePresetId);
    expect(p).toBeUndefined();
  });
});
