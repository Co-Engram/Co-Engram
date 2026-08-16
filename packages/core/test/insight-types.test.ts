import { describe, expect, it } from "vitest";

import {
  DEFAULT_REM_INSIGHT,
  GENERIC_DOMAIN_TAGS,
  INSIGHT_LIMITS,
  SPREAD_PARAMS,
  TRUTH_FACTOR,
  type DeepThoughtMode,
  type InsightDraft,
  type InsightType,
} from "../src/maintenance/insight/types.js";

describe("insight types and mode registry", () => {
  it("一期模式集合固定为整合/复盘/灵感(其余二期)", () => {
    const modes: readonly DeepThoughtMode[] = [
      "integration",
      "retrospective",
      "inspiration",
    ];
    expect(modes).toHaveLength(3);
  });

  it("笼统标签过滤集合覆盖 imported/uncategorized(防灵感模式恒假/恒真)", () => {
    expect(GENERIC_DOMAIN_TAGS.has("imported")).toBe(true);
    expect(GENERIC_DOMAIN_TAGS.has("uncategorized")).toBe(true);
    expect(GENERIC_DOMAIN_TAGS.has("co-engram")).toBe(false);
  });

  it("默认参数与 spec 冻结初值一致(enabled 默认 false,盲评校准后才可默认开启)", () => {
    expect(DEFAULT_REM_INSIGHT.enabled).toBe(false);
    expect(DEFAULT_REM_INSIGHT.modesPerRun).toBe(2);
    expect(DEFAULT_REM_INSIGHT.criticThreshold).toBe(0.6);
    expect(DEFAULT_REM_INSIGHT.maxSubgraphNodes).toBe(30);
    expect(DEFAULT_REM_INSIGHT.webResearch).toBe(false);
  });

  it("扩散/限制参数为待校准初值,结构与 spec §二/§三一致", () => {
    expect(SPREAD_PARAMS.w1).toBe(0.5);
    expect(SPREAD_PARAMS.w2).toBe(0.5);
    expect(SPREAD_PARAMS.hop1Decay).toBe(0.5);
    expect(SPREAD_PARAMS.hop2Decay).toBe(0.25);
    expect(SPREAD_PARAMS.minActivation).toBe(0.1);
    expect(INSIGHT_LIMITS.maxProposalsPerRun).toBe(5);
    expect(INSIGHT_LIMITS.jaccardDup).toBe(0.65);
    expect(INSIGHT_LIMITS.dreamJaccard).toBe(0.65);
    expect(INSIGHT_LIMITS.maxRoundsDefault).toBe(5);
    expect(INSIGHT_LIMITS.inFlightTtlMs).toBe(30 * 60_000);
  });

  it("真值因子覆盖全部 verificationStatus,refuted 归零", () => {
    expect(TRUTH_FACTOR.verified).toBe(1);
    expect(TRUTH_FACTOR.refuted).toBe(0);
    for (const s of ["verified", "probable", "plausible", "unverified", "refuted"]) {
      expect(TRUTH_FACTOR[s]).toBeDefined();
    }
  });

  it("InsightDraft 类型可构造且 type 联合与 spec §三输出类型一致", () => {
    const draft: InsightDraft = {
      mode: "retrospective",
      type: "lesson",
      title: "t",
      content: "c",
      summary: "s",
      sourceIds: ["a", "b"],
      domainTags: ["x"],
      reason: "r",
      aar: {
        expected: "e",
        actual: "a",
        cause: "c",
        improvement: "i",
      },
    };
    expect(draft.mode).toBe("retrospective");
    const types: readonly InsightType[] = [
      "theme",
      "lesson",
      "analogy",
      "hypothesis",
    ];
    expect(types).toHaveLength(4);
  });
});
