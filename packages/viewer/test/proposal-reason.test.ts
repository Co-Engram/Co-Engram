import { describe, it, expect } from "vitest";
import { zh, en } from "@co-engram/core";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

const NEW_KEYS = [
  "viewer.proposals.sourceLine.conversation",
  "viewer.proposals.sourceLine.external",
  "viewer.proposals.sourceLine.autoMemory",
  "viewer.proposals.sourceLine.times",
  "viewer.proposals.why.title",
  "viewer.proposals.why.source",
  "viewer.proposals.why.window",
  "viewer.proposals.why.necessity",
  "viewer.proposals.why.samples",
  "viewer.proposals.why.necessity.conversation",
  "viewer.proposals.why.necessity.fallback",
  "viewer.proposals.why.necessity.external",
  "viewer.proposals.why.necessity.autoMemory",
  "viewer.proposals.why.sourceLabel.conversation",
  "viewer.proposals.why.sourceLabel.external",
  "viewer.proposals.why.sourceLabel.autoMemory",
  "viewer.proposals.why.window.within",
  "viewer.proposals.why.window.minute",
  "viewer.proposals.why.window.hour",
  "viewer.proposals.why.window.day",
  "viewer.proposals.why.advanced",
  "viewer.proposals.why.advancedReason",
  "viewer.proposals.why.advancedRule",
];

describe("提案生成原因 i18n key 双语对等", () => {
  it("zh 与 en 字典都含全部新 key", () => {
    for (const k of NEW_KEYS) {
      expect(zh[k], `zh 缺 ${k}`).toBeTruthy();
      expect(en[k], `en 缺 ${k}`).toBeTruthy();
    }
  });
});

describe("formatWindow / _shortTs helper 存在且被引用", () => {
  it("CO_ENGRAM_PROPOSALS 定义 _shortTs 与 formatWindow", () => {
    expect(TABS_RUNTIME).toContain("_shortTs(iso)");
    expect(TABS_RUNTIME).toContain("formatWindow(firstSeenAt, lastSeenAt, occurrences, opts)");
  });

  it("formatWindow 双时间分支计算时长差(lastMs - firstMs)", () => {
    expect(TABS_RUNTIME).toContain("lastMs - firstMs");
  });

  it("formatWindow 内部用 this._shortTs 处理单点/退化", () => {
    expect(TABS_RUNTIME).toContain("this._shortTs(");
  });

  it("formatWindow 时长单位引用 why.window.minute/hour/day/within key", () => {
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.window.minute'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.window.hour'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.window.day'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.window.within'");
  });
});

describe("_sourceLine 卡片来源行", () => {
  it("CO_ENGRAM_PROPOSALS 定义 _sourceLine(p)", () => {
    expect(TABS_RUNTIME).toContain("_sourceLine(p) {");
  });

  it("按 source 分模板,引用 sourceLine.* key", () => {
    expect(TABS_RUNTIME).toContain("'viewer.proposals.sourceLine.conversation'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.sourceLine.external'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.sourceLine.autoMemory'");
  });

  it("卡片循环在普通卡片段调用 this._sourceLine(p)", () => {
    // 普通卡片段以 _inferMeta 为标志(_sourceLine 必须在其后,即 rem continue 之后)
    const metaIdx = TABS_RUNTIME.indexOf("const meta = this._inferMeta(p)");
    const callIdx = TABS_RUNTIME.indexOf("this._sourceLine(p)");
    expect(metaIdx, "应存在 _inferMeta 锚点").toBeGreaterThan(-1);
    expect(callIdx, "应调用 this._sourceLine(p)").toBeGreaterThan(metaIdx);
  });

  it("_sourceLine 内部用 this.formatWindow 取时间范围", () => {
    expect(TABS_RUNTIME).toContain("this.formatWindow(p.firstSeenAt, p.lastSeenAt, occ, { compact: true })");
  });
});

describe("_whyBlock drawer 结构化块", () => {
  it("CO_ENGRAM_PROPOSALS 定义 _whyBlock(p)", () => {
    expect(TABS_RUNTIME).toContain("_whyBlock(p) {");
  });

  it("drawer open() 调用 this._whyBlock(p)", () => {
    expect(TABS_RUNTIME).toContain("this._whyBlock(p)");
  });

  it("四段标题引用 why.source/window/necessity/samples key", () => {
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.source'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.window'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.necessity'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.samples'");
  });

  it("必要性按 source 分模板(含 fallback)", () => {
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.necessity.conversation'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.necessity.external'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.necessity.autoMemory'");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.necessity.fallback'");
  });

  it("高级区折叠展示原始 necessityReason(<details>)", () => {
    expect(TABS_RUNTIME).toContain("<details");
    expect(TABS_RUNTIME).toContain("'viewer.proposals.why.advanced'");
    expect(TABS_RUNTIME).toContain("p.necessityReason");
  });
});
