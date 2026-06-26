import { describe, it, expect } from "vitest";
import { zh, en } from "@co-engram/core";
import { renderSpaHtml } from "../src/index.js";

// Viewer runtime 使用的枚举类别(对应 enum.<category>.<value> 命名空间)。
// 每个类别列出 Engram 数据模型的所有合法值;任何一个在 zh/en 缺翻译都会被捕获。
const ENUM_COVERAGE: Record<string, readonly string[]> = {
  kind: ["observation", "fact", "pattern", "procedure", "hypothesis"],
  freshness: ["fresh", "aging", "stale", "forgotten"],
  status: ["draft", "active", "archived", "forgotten"],
  sourceType: ["firsthand", "secondhand", "inferred"],
  emotionalValence: ["positive", "neutral", "negative"],
  verificationStatus: [
    "unverified",
    "plausible",
    "probable",
    "verified",
    "refuted",
  ],
};

// 详情面板/卡片视图使用的 field.label.* / section.* / action.* / decay.* / engrams.* 键。
// 这是本 PR 新增的命名空间,任何一个 key 在 zh/en 任一语言里漏翻译都会被捕获。
const VIEWER_RUNTIME_KEYS = [
  // field labels(详情面板)
  "field.label.id",
  "field.label.title",
  "field.label.domainTags",
  "field.label.contextTags",
  "field.label.content",
  "field.label.stats",
  "field.label.retrievals",
  "field.label.effective",
  "field.label.failures",
  "field.label.creator",
  "field.label.time",
  "field.label.confidence",
  "field.label.status",
  "field.label.freshness",
  "field.label.importance",
  "field.label.valueAssessment",
  "field.label.multiDimImportance",
  "field.label.encodingContext",
  "field.label.encodingContextValue",
  "field.label.perspective",
  "field.label.decayProgress",
  "field.label.evidenceCount",
  "field.label.lastEffective",
  "field.label.reinforcementScore",
  "field.label.emotionalValence",
  "field.label.sourceType",
  "field.label.verificationStatus",
  "field.label.decayHalfLife",

  // section titles
  "section.content",
  "section.stats",
  "section.valueAssessment",
  "section.multiDimImportance",
  "section.encodingContext",

  // action buttons
  "action.edit",
  "action.delete",
  "action.close",
  "action.detailView",

  // common
  "common.none",
  "common.never",
  "common.unknown",
  "common.totalCount",

  // decay visualization
  "decay.daysToNext",
  "decay.forgotten",
  "decay.neverDecays",
  "decay.neverDecaysTip",
  "decay.neverEffective",
  "decay.neverEffectiveTip",
  "decay.levelLabel",

  // engrams list view
  "engrams.searchPlaceholder",
  "engrams.filter.kind",
  "engrams.filter.kindAll",
  "engrams.filter.sort",
  "engrams.filter.sortNewest",
  "engrams.filter.sortOldest",
  "engrams.filter.sortImportance",
  "engrams.filter.sortRetrievals",
  "engrams.view.card",
  "engrams.view.tree",
  "engrams.countTotal",
  "engrams.countFiltered",
  "engrams.empty",
  "engrams.retrievalsCount",
  "engrams.untagged",
] as const;

describe("viewer i18n / dictionary coverage", () => {
  it("zh 与 en 的 key 集合完全相等(core 已断言,这里 sanity check)", () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("所有 enum.<category>.<value> 在两种语言都有翻译(不返回 key 本身)", () => {
    for (const [category, values] of Object.entries(ENUM_COVERAGE)) {
      for (const value of values) {
        const key = `enum.${category}.${value}`;
        const zhVal = zh[key];
        const enVal = en[key];
        expect(zhVal, `zh.${key} 缺翻译`).toBeTruthy();
        expect(enVal, `en.${key} 缺翻译`).toBeTruthy();
        expect(zhVal, `zh.${key} 误填成 key 本身`).not.toBe(key);
        expect(enVal, `en.${key} 误填成 key 本身`).not.toBe(key);
      }
    }
  });

  it("viewer runtime 使用的所有 key 在两种语言都有翻译", () => {
    for (const key of VIEWER_RUNTIME_KEYS) {
      const zhVal = zh[key as keyof typeof zh];
      const enVal = en[key as keyof typeof en];
      expect(zhVal, `zh.${key} 缺翻译`).toBeTruthy();
      expect(enVal, `en.${key} 缺翻译`).toBeTruthy();
      expect(zhVal, `zh.${key} 误填成 key 本身`).not.toBe(key);
      expect(enVal, `en.${key} 误填成 key 本身`).not.toBe(key);
    }
  });

  it("中英翻译确实不同(防止复制粘贴漏改)", () => {
    // 已知中英通用的短 token(技术术语、缩写)— 允许相同。
    const ALLOW_SAME = new Set<string>([
      "field.label.id", // 'ID:' 中英都是
    ]);
    for (const key of VIEWER_RUNTIME_KEYS) {
      if (ALLOW_SAME.has(key)) continue;
      const zhVal = zh[key as keyof typeof zh];
      const enVal = en[key as keyof typeof en];
      if (zhVal && enVal) {
        expect(
          zhVal !== enVal,
          `zh.${key} 与 en.${key} 完全相同("${zhVal}"),可能漏改`,
        ).toBe(true);
      }
    }
  });
});

describe("viewer i18n / renderSpaHtml 注入", () => {
  it("注入 window.CO_ENGRAM_I18N = { zh, en } 完整字典", () => {
    const html = renderSpaHtml({ language: "zh" });
    // 全局字典注入
    expect(html).toContain("window.CO_ENGRAM_I18N");
    // 至少包含若干关键 key 的翻译,确认走的是 JSON.stringify(zh)
    expect(html).toContain("自进化的团队记忆印迹");
    expect(html).toContain("Self-evolving team memory engrams");
  });

  it('language=zh 注入 window.CO_ENGRAM_LANG = "zh"', () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain('window.CO_ENGRAM_LANG = "zh"');
  });

  it('language=en 注入 window.CO_ENGRAM_LANG = "en"', () => {
    const html = renderSpaHtml({ language: "en" });
    expect(html).toContain('window.CO_ENGRAM_LANG = "en"');
  });

  it("默认 language=zh(DEFAULT_LANGUAGE 是 zh)", () => {
    const html = renderSpaHtml();
    expect(html).toContain('window.CO_ENGRAM_LANG = "zh"');
  });

  it("注入 CO_ENGRAM_T 和 CO_ENGRAM_DECAY runtime(顺序在 app/graph/tabs 之前)", () => {
    const html = renderSpaHtml();
    const i18nIdx = html.indexOf("window.CO_ENGRAM_T");
    const decayIdx = html.indexOf("window.CO_ENGRAM_DECAY");
    expect(i18nIdx).toBeGreaterThan(-1);
    expect(decayIdx).toBeGreaterThan(-1);
    // 关键:i18n + decay 必须在 app/graph/tabs runtime 之前初始化,
    // 否则后面运行时调用 CO_ENGRAM_T.t 会拿到 undefined。
    const i18nGlobalIdx = html.indexOf("window.CO_ENGRAM_I18N");
    expect(i18nGlobalIdx).toBeLessThan(i18nIdx);
    expect(i18nIdx).toBeLessThan(decayIdx);
  });
});
