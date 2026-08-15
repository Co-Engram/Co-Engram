/**
 * 中英文配置下「所有按钮和显示」回归测试(2026-07)
 *
 * 用户诉求:viewer UI 在中(zh)、英(en)两种语言配置下,所有按钮与显示文案
 * 都必须正确渲染,纳入回归测试项,防止以下三类事故再次发生:
 *   1. 按钮/显示回退成裸 i18n key(如 purgeConfirm 事故,见 i18n.test.ts 注释)
 *   2. 按钮/显示在 zh 模式漏出英文(如 audit 按钮 accept/dismiss 事故)
 *   3. 新加按钮只测一种语言、或硬编码某一语言文案,另一种语言配置下破版
 *
 * 与 i18n.test.ts 的分工:
 *   - i18n.test.ts 验证「字典覆盖」——key 在 zh/en 字典里是否有翻译。
 *   - 本文件验证「渲染产物」——renderSpaHtml 输出的 HTML 与浏览器端真实执行的
 *     I18N_RUNTIME,在每种语言配置下是否真的把每个按钮/显示渲染成对应语言文案。
 *   字典有翻译 ≠ UI 显示正确(html.ts 可能漏调 t()、runtime fallback 链可能失效)。
 *
 * 三层结构,全部自动扫描源码、随源码扩展,新按钮/新显示自动进网:
 *   Layer 1 静态骨架:扫描 html.ts 全部 t(language, "key") 调用,
 *           对 zh/en 各渲染一次,断言每个 key 的译文出现在 UI 区域,
 *           且另一语言的译文不出现在 UI 区域(跨语言泄漏检测)。
 *   Layer 2 运行时显示:用 node:vm 执行真实的 I18N_RUNTIME(浏览器端同一份代码),
 *           对 zh/en 各实例化一次,断言扫描到的所有字面 key / 动态前缀家族
 *           解析结果 === 当前语言字典值(不落到 fallback、不落裸 key)。
 *   Layer 3 数据模型驱动的按钮家族完备性:visibility/maintenance stage/audit action
 *           /rem band/health badge/scoreBand 等枚举值 × 属性组合,双语言全量解析。
 *
 * 关键实现细节:UI 区域切片。
 *   renderSpaHtml 把 zh+en 完整字典以 window.CO_ENGRAM_I18N 内联进 HTML,
 *   所以「html.contains(某译文)」恒真、无法证明按钮渲染正确。所有静态断言都切到
 *   字典注入点之前(<body 起,window.CO_ENGRAM_I18N 止)的 UI 区域做。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { zh, en } from "@co-engram/core";
import { renderSpaHtml } from "../src/index.js";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";

type Lang = "zh" | "en";
const DICTS: Record<Lang, Record<string, string>> = {
  zh: zh as Record<string, string>,
  en: en as Record<string, string>,
};

const VIEWER_SRC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

// ============================================================
// 公共 helper
// ============================================================

/**
 * 译文在 HTML 里的可能形态。html.ts 对 title 属性值做 `"` → `&quot;` 转义,
 * 对元素文本/placeholder 不转义,两种形态都接受。
 */
function renderedForms(v: string): string[] {
  const escaped = v.replaceAll('"', "&quot;");
  return escaped === v ? [v] : [v, escaped];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 「显示形态」匹配:完整元素文本(>文案<)或完整属性值(="文案")。
 * 只在这两种形态下,一个字符串才算「按钮/显示文案」;
 * 长文案中间的术语子串(如 zh tip 里的 (contradicts))不算显示。
 */
function displayPattern(v: string): RegExp {
  const forms = renderedForms(v).map(escapeRegExp).join("|");
  return new RegExp(`>\\s*(?:${forms})\\s*<|="(?:${forms})"`);
}

/**
 * 切出 HTML 的 UI 区域:<body 起,window.CO_ENGRAM_I18N 字典注入点止。
 * 字典注入点之后是 runtime JS(含 zh+en 全量字典),不属于渲染产物。
 * 同时剥掉 HTML 注释(如 <!-- Health -->)—— 注释不是显示,
 * 留着会让「泄漏检测」误报、让「存在检测」经注释假通过。
 */
function uiRegionOf(html: string): string {
  const bodyIdx = html.indexOf("<body");
  const dictIdx = html.indexOf("window.CO_ENGRAM_I18N");
  expect(bodyIdx, "HTML 应含 <body").toBeGreaterThan(-1);
  expect(dictIdx, "HTML 应注入 window.CO_ENGRAM_I18N").toBeGreaterThan(-1);
  expect(bodyIdx, "UI 区域起止顺序应正确").toBeLessThan(dictIdx);
  return html.slice(bodyIdx, dictIdx).replace(/<!--[\s\S]*?-->/g, "");
}

interface RuntimeT {
  t(key: string, vars?: Record<string, unknown>): string;
  enumLabel(category: string, value: string): string;
  fieldLabel(name: string): string;
  sectionLabel(name: string): string;
  actionLabel(name: string): string;
  decayLabel(days: number | null | undefined): string;
  formatScoreBand(value: number | null | undefined): string;
  describeImportance(value: number | null | undefined): {
    band: string;
    label: string;
    valueText: string;
    tipText: string;
  };
  bandLabel(value: number | null | undefined): string;
  currentLang(): string;
}

/**
 * 用 node:vm 执行与浏览器端完全相同的 I18N_RUNTIME 代码,
 * 返回该语言配置下的 CO_ENGRAM_T 实例。
 */
function makeRuntime(
  lang: Lang,
  dicts: Record<string, Record<string, string>> = DICTS,
): RuntimeT {
  const sandbox: { window: Record<string, unknown> } = {
    window: { CO_ENGRAM_I18N: dicts, CO_ENGRAM_LANG: lang },
  };
  vm.runInNewContext(I18N_RUNTIME, sandbox);
  return sandbox.window.CO_ENGRAM_T as RuntimeT;
}

// ============================================================
// Layer 1:静态骨架(html.ts)—— 所有按钮/显示 × zh/en
// ============================================================

const HTML_TS_SRC = readFileSync(join(VIEWER_SRC_DIR, "html.ts"), "utf8");

// html.ts 里所有 t(language, "key") 调用 —— 即服务端渲染的全部静态按钮/显示。
// 新增任何按钮(tab、toolbar、filter、footer 等)都会进入本扫描。
const STATIC_KEYS = Array.from(
  new Set(
    Array.from(HTML_TS_SRC.matchAll(/\bt\(language,\s*"([^"]+)"\)/g)).map(
      (m) => m[1],
    ),
  ),
).sort();

describe("Layer 1 / 静态骨架:所有按钮与显示在 zh/en 下全量渲染", () => {
  it("扫描器 sanity:≥ 80 个静态 key(防 regex 失效静默通过)", () => {
    expect(STATIC_KEYS.length).toBeGreaterThanOrEqual(80);
  });

  it("扫描覆盖已知锚点按钮(tab / 搜索 / graph toolbar / more-menu)", () => {
    const anchors = [
      "viewer.tab.stats",
      "viewer.nav.governance",
      "viewer.search.button",
      "viewer.search.clear",
      "viewer.graph.toolbar.fit",
      "viewer.graph.toolbar.physics",
      "viewer.graph.toolbar.reset",
      "viewer.graph.filter.pathBtn",
      "viewer.footer",
    ];
    for (const a of anchors) {
      expect(STATIC_KEYS, `html.ts 应调用 t(language, "${a}")`).toContain(a);
    }
  });

  for (const lang of ["zh", "en"] as const) {
    it(`${lang}:每个静态 key 的译文都渲染进 UI 区域(共 ${STATIC_KEYS.length} 个)`, () => {
      // tokenRequired: true —— 让 auth bar 等条件渲染的按钮/显示也进入产物,
      // 保证「所有按钮」是最大集合而非默认路径子集。
      const region = uiRegionOf(
        renderSpaHtml({ language: lang, tokenRequired: true }),
      );
      expect(
        region.length,
        "UI 区域应非平凡(切片标记失效时会退化成空串)",
      ).toBeGreaterThan(1000);
      const dict = DICTS[lang];
      for (const key of STATIC_KEYS) {
        const value = dict[key];
        expect(value, `字典缺 ${lang}.${key}`).toBeTruthy();
        const hit = renderedForms(value).some((form) =>
          region.includes(form),
        );
        expect(
          hit,
          `${lang} 模式 UI 区域缺「${key}」的译文「${value}」` +
            `——按钮/显示未渲染或 html.ts 未对该处调用 t()`,
        ).toBe(true);
      }
    });
  }

  it("zh UI 区域无英文文案泄漏,en UI 区域无中文文案泄漏", () => {
    // 对「中英译文不同」的每个静态 key,另一语言的译文不得以「显示形态」
    // (完整元素文本 >文案< / 完整属性值 ="文案")出现在当前语言 UI 区域 ——
    // 直接捕获「zh 模式按钮显示英文」「硬编码英文按钮」两类事故。
    // 译文相同的 key(如 ID / Co-Engram)天然无泄漏语义,跳过。
    // 防误报设计:
    //   1. uiRegionOf 已剥 HTML 注释;
    //   2. 这里再剥 on* 事件 handler 属性 —— 里面是 JS 接线代码
    //      (如 onchange="...toggleSynapseKind('causes', ...)"),其字符串是
    //      数据模型 id 而非显示文案;
    //   3. 用 displayPattern 边界匹配而非子串匹配 —— zh tip 里引用
    //      「(contradicts)」作为术语不算泄漏,整个按钮文本是英文才算。
    for (const lang of ["zh", "en"] as const) {
      const other: Lang = lang === "zh" ? "en" : "zh";
      const region = uiRegionOf(
        renderSpaHtml({ language: lang, tokenRequired: true }),
      ).replace(/\son\w+="[^"]*"/g, "");
      for (const key of STATIC_KEYS) {
        const value = DICTS[lang][key];
        const otherValue = DICTS[other][key];
        if (!value || !otherValue || otherValue === value) continue;
        const leaked = displayPattern(otherValue).test(region);
        expect(
          leaked,
          `${lang} 模式 UI 区域混入 ${other} 文案「${otherValue}」(${key})` +
            `——该按钮/显示疑似硬编码了 ${other} 或 fallback 链失效`,
        ).toBe(false);
      }
    }
  });

  it("zh/en UI 区域都无裸 i18n key 泄漏(>viewer.xxx< / title=\"enum.xxx\" 等)", () => {
    // 裸 key 出现在可见文本/title 属性里 = 字典漏译 + fallback 到 key 本身。
    // key 形态:全小写命名空间开头、含 ≥1 个点、无空格。
    const RAW_KEY_RE = /[>"']\s*(?:viewer|enum|field|action|section|common|decay|engrams|tip)\.[a-z][\w.]*[a-z]/g;
    for (const lang of ["zh", "en"] as const) {
      const region = uiRegionOf(
        renderSpaHtml({ language: lang, tokenRequired: true }),
      );
      const leaks = Array.from(region.matchAll(RAW_KEY_RE)).map((m) =>
        m[0].trim(),
      );
      expect(leaks, `${lang} 模式 UI 区域发现裸 i18n key`).toEqual([]);
    }
  });
});

// ============================================================
// Layer 2:运行时显示(tabs/app/graph/decay)—— 真实 I18N_RUNTIME × zh/en
// ============================================================

const RUNTIME_FILES = ["tabs.ts", "app.ts", "graph.ts", "decay.ts", "i18n.ts"]
  .map((f) => join(VIEWER_SRC_DIR, "runtime", f))
  .map((p) => ({ name: basename(p), src: readFileSync(p, "utf8") }));

// 字面量调用:T.t('viewer.xxx', ...) / T.t('viewer.xxx')
const T_LITERAL_CALLS = RUNTIME_FILES.flatMap(({ name, src }) => {
  const re = /T\.t\(['"]([^'"]+)['"]\s*[,)]/g;
  const out: { file: string; key: string }[] = [];
  for (const m of src.matchAll(re)) out.push({ file: name, key: m[1] });
  return out;
});
const T_LITERAL_KEYS = Array.from(
  new Set(T_LITERAL_CALLS.map((c) => c.key)),
).sort();

// 动态前缀家族:'viewer.xxx.' + 变量 的拼接(含先赋变量再 T.t(key) 的形式,
// 如 tabs.ts 的 const key = 'viewer.audit.actionLabel.' + action)。
// 限定 i18n 命名空间开头,排除普通字符串拼接。
const DYNAMIC_PREFIXES = Array.from(
  new Set(
    RUNTIME_FILES.flatMap(({ src }) =>
      Array.from(
        src.matchAll(
          /['"]((?:viewer|enum|field|action|section|common|decay|engrams|tip)\.[a-z][\w.]*\.)['"]\s*\+/g,
        ),
      ).map((m) => m[1]),
    ),
  ),
).sort();

// helper 调用:T.fieldLabel('xxx') / T.sectionLabel('xxx') / T.actionLabel('xxx')
const HELPER_CALLS = RUNTIME_FILES.flatMap(({ name, src }) => {
  const re = /T\.(fieldLabel|sectionLabel|actionLabel)\(['"]([^'"]+)['"]\)/g;
  const out: { file: string; helper: string; name: string }[] = [];
  for (const m of src.matchAll(re))
    out.push({ file: name, helper: m[1], name: m[2] });
  return out;
});
const HELPER_KEY_PREFIX: Record<string, string> = {
  fieldLabel: "field.label.",
  sectionLabel: "section.",
  actionLabel: "action.",
};

describe("Layer 2 / 运行时显示:真实 I18N_RUNTIME 在 zh/en 下解析所有按钮与显示", () => {
  it("扫描器 sanity:字面 key ≥ 200、动态前缀 ≥ 5、helper 调用 ≥ 5(防 regex 失效)", () => {
    expect(T_LITERAL_KEYS.length).toBeGreaterThanOrEqual(200);
    expect(DYNAMIC_PREFIXES.length).toBeGreaterThanOrEqual(5);
    expect(HELPER_CALLS.length).toBeGreaterThanOrEqual(5);
  });

  it("动态前缀扫描覆盖已知家族(audit / visibilityBadge / maintenance / rem band)", () => {
    const families = [
      "viewer.audit.actionLabel.",
      "viewer.audit.actionTip.",
      "viewer.engram.visibilityBadge.",
      "viewer.maintenance.stage.",
      "viewer.proposals.rem.band.",
    ];
    for (const f of families) {
      expect(DYNAMIC_PREFIXES, `runtime 应存在 '${f}...' + 变量 拼接`).toContain(
        f,
      );
    }
  });

  for (const lang of ["zh", "en"] as const) {
    it(`${lang}:所有字面 key 经运行时解析 === 当前语言字典值(共 ${T_LITERAL_KEYS.length} 个)`, () => {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const key of T_LITERAL_KEYS) {
        const expected = dict[key];
        expect(expected, `字典缺 ${lang}.${key}`).toBeTruthy();
        const actual = T.t(key);
        expect(
          actual,
          `${lang} 模式 T.t('${key}') 解析为「${actual}」,应为当前语言译文「${expected}」` +
            `——落到了 en fallback 或裸 key`,
        ).toBe(expected);
      }
    });

    it(`${lang}:所有动态前缀家族的全量 dict key 经运行时解析正确`, () => {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const prefix of DYNAMIC_PREFIXES) {
        const keys = Object.keys(dict).filter((k) => k.startsWith(prefix));
        expect(
          keys.length,
          `字典应至少有 1 个 ${prefix}* key(runtime 存在该拼接)`,
        ).toBeGreaterThan(0);
        for (const key of keys) {
          expect(T.t(key), `${lang} 模式 T.t('${key}') 解析错误`).toBe(
            dict[key],
          );
        }
      }
    });

    it(`${lang}:所有 helper 调用(fieldLabel/sectionLabel/actionLabel)解析正确`, () => {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const { helper, name } of HELPER_CALLS) {
        const key = HELPER_KEY_PREFIX[helper] + name;
        const expected = dict[key];
        expect(
          expected,
          `字典缺 ${lang}.${key}(runtime 调用了 T.${helper}('${name}'))`,
        ).toBeTruthy();
        const actual = (
          T[helper as "fieldLabel" | "sectionLabel" | "actionLabel"] as (
            n: string,
          ) => string
        )(name);
        expect(actual, `${lang} 模式 T.${helper}('${name}') 解析错误`).toBe(
          expected,
        );
      }
    });
  }

  it("fallback 链:当前语言缺 key → 英文;双语都缺 → key 本身", () => {
    // 用构造字典直接钉死 fallback 语义,防止 runtime 改动静默破坏降级行为
    const dicts = {
      zh: { "x.only.en": "不应读到" },
      en: { "x.only.en": "EN fallback" },
    };
    // zh 缺 x.only.en → 读 en(注意:构造里 zh 有值,再造一个真缺失的)
    const missingInZh = makeRuntime("zh", { zh: {}, en: dicts.en });
    expect(missingInZh.t("x.only.en")).toBe("EN fallback");
    const missingEverywhere = makeRuntime("zh", { zh: {}, en: {} });
    expect(missingEverywhere.t("x.unknown.key")).toBe("x.unknown.key");
    // 双语都有 → 读当前语言,不读 fallback
    const both = makeRuntime("zh", {
      zh: { "x.k": "中文" },
      en: { "x.k": "English" },
    });
    expect(both.t("x.k")).toBe("中文");
    expect(both.currentLang()).toBe("zh");
  });

  it("变量插值(${days}/${value})在 zh/en 下都正确替换", () => {
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      const daysText = T.decayLabel(3);
      const expectedDays = dict["decay.daysToNext"].replace("${days}", "3");
      expect(daysText).toBe(expectedDays);
      expect(daysText).not.toContain("${days}");
      const imp = T.describeImportance(0.82);
      expect(imp.tipText).toContain("0.82");
      expect(imp.tipText).not.toContain("${value}");
    }
  });

  it("显示 helper 双语言:decayLabel / formatScoreBand / enumLabel 边界值", () => {
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      // decayLabel 边界:null → forgotten 文案
      expect(T.decayLabel(null)).toBe(dict["decay.forgotten"]);
      // formatScoreBand 三档 + 空值
      expect(T.formatScoreBand(0.72)).toContain(dict["viewer.scoreBand.high"]);
      expect(T.formatScoreBand(0.5)).toContain(
        dict["viewer.scoreBand.medium"],
      );
      expect(T.formatScoreBand(0.1)).toContain(dict["viewer.scoreBand.low"]);
      expect(T.formatScoreBand(null)).toBe("—");
      // describeImportance 档位 label 跟随语言
      expect(T.describeImportance(0.9).label).toBe(
        dict["viewer.scoreBand.high"],
      );
      expect(T.describeImportance(null).label).toBe("—");
      // enumLabel:空值 → common.unknown;正常值 → enum 译文
      expect(T.enumLabel("kind", "fact")).toBe(dict["enum.kind.fact"]);
      expect(T.enumLabel("kind", "")).toBe(dict["common.unknown"]);
    }
  });
});

// ============================================================
// Layer 3:数据模型驱动的按钮家族完备性(zh+en)
//
// 这些家族的「值域」由 core 数据模型/后端 API 决定,不是前端字面量,
// 扫描抓不到全量 —— 显式钉死值域 × 属性组合,缺一个翻译 CI 即红。
// ============================================================

describe("Layer 3 / 按钮家族完备性:数据模型值域 × zh/en", () => {
  // EngramVisibility(core/src/types/engram.ts)= public|team|private|restricted
  // tabs.ts 三处渲染 visibility badge + tip + filter option
  const VISIBILITY_VALUES = ["public", "team", "private", "restricted"];

  it("EngramVisibility 4 值 × (badge + tip),双语言全量解析", () => {
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const v of VISIBILITY_VALUES) {
        for (const suffix of ["", ".tip"]) {
          const key = `viewer.engram.visibilityBadge.${v}${suffix}`;
          expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
          expect(T.t(key)).toBe(dict[key]);
        }
      }
    }
  });

  it("enum.visibility / enum.synapseKind 全值,双语言经 enumLabel 解析", () => {
    // enum.synapseKind 13 值 = 12 正式族 + related_to(历史数据 fallback)
    const SYNAPSE_KINDS = [
      "extends",
      "part_of",
      "similar_to",
      "depends_on",
      "causes",
      "follows",
      "derives_from",
      "exemplifies",
      "contradicts",
      "supersedes",
      "consolidates",
      "contextualizes",
      "related_to",
    ];
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const v of VISIBILITY_VALUES) {
        expect(T.enumLabel("visibility", v)).toBe(
          dict[`enum.visibility.${v}`],
        );
      }
      for (const k of SYNAPSE_KINDS) {
        expect(T.enumLabel("synapseKind", k)).toBe(
          dict[`enum.synapseKind.${k}`],
        );
      }
    }
  });

  // MaintenanceStage(core/src/maintenance/types.ts)= light|deep|rem
  // (3604dbb 移除 daily stage,与 importance/freshness 正交化同步)
  // tabs.ts maintenance tab 渲染 stage 图标/名称/副标题/tip + 4 种 status
  const MAINTENANCE_STAGES = ["light", "deep", "rem"];
  const MAINTENANCE_STATUS = ["healthy", "never", "overdue", "soon"];

  it("maintenance 3 stage × 4 属性 + 4 status,双语言全量解析", () => {
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const stage of MAINTENANCE_STAGES) {
        for (const attr of ["stage", "stageIcon", "stageSubtitle", "stageTip"]) {
          const key = `viewer.maintenance.${attr}.${stage}`;
          expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
          expect(T.t(key)).toBe(dict[key]);
        }
      }
      for (const s of MAINTENANCE_STATUS) {
        const key = `viewer.maintenance.status.${s}`;
        expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
        expect(T.t(key)).toBe(dict[key]);
      }
    }
  });

  it("audit 全量 action × (actionLabel + actionTip),双语言解析且非裸 key", () => {
    // action 值域取字典全量(28 个,后端 emit 的 action 合集);
    // 反向(代码 emit 但字典缺)由 i18n.test.ts 的 AUDIT_ACTION_KEYS 钉死。
    const actions = Object.keys(zh)
      .filter((k) => k.startsWith("viewer.audit.actionLabel."))
      .map((k) => k.slice("viewer.audit.actionLabel.".length));
    expect(actions.length).toBeGreaterThanOrEqual(27);
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const action of actions) {
        for (const attr of ["actionLabel", "actionTip"]) {
          const key = `viewer.audit.${attr}.${action}`;
          expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
          expect(T.t(key)).toBe(dict[key]);
          expect(T.t(key)).not.toBe(key);
        }
      }
    }
  });

  it("rem band 5 档 / health badge 4 档 / scoreBand 3 档,双语言解析", () => {
    const REM_BANDS = ["veryLow", "low", "medium", "high", "veryHigh"];
    const HEALTH_BADGES = ["ok", "info", "warn", "error"];
    const SCORE_BANDS = ["low", "medium", "high"];
    for (const lang of ["zh", "en"] as const) {
      const T = makeRuntime(lang);
      const dict = DICTS[lang];
      for (const b of REM_BANDS) {
        const key = `viewer.proposals.rem.band.${b}`;
        expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
        expect(T.t(key)).toBe(dict[key]);
      }
      for (const b of HEALTH_BADGES) {
        const key = `viewer.health.badge.${b}`;
        expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
        expect(T.t(key)).toBe(dict[key]);
      }
      for (const b of SCORE_BANDS) {
        const key = `viewer.scoreBand.${b}`;
        expect(dict[key], `字典缺 ${lang}.${key}`).toBeTruthy();
        expect(T.t(key)).toBe(dict[key]);
      }
    }
  });

  // zh 配置下,每个被使用的 key 的译文必须含 CJK 字符 —— 防「zh 字典漏译、
  // 直接抄英文」类事故(事故实例:viewer.detail.searching zh 曾是 "Searching...")。
  // 合法拉丁词走白名单,每条注明理由;新增需 review。
  const ZH_LATIN_ALLOWLIST: Record<string, string> = {
    "host.label.openclaw": "产品名",
    "host.label.mcp": "产品名",
    "host.process.openclaw": "产品名",
    "host.process.mcp": "产品名",
    "viewer.common.langEn": "语言名 English,双语同形是有意的",
    "viewer.title": "品牌名 Co-Engram",
    "viewer.auth.placeholder": "HTTP 协议术语 Bearer token",
    "viewer.proposals.sourceLine.autoMemory": "功能专名 auto-memory(Claude Code / OpenClaw 宿主系统记忆机制),zh/en 同形有意",
  };
  const CJK_RE = /[一-鿿]/;
  const LATIN_WORD_RE = /[a-zA-Z]{4,}/;

  it("zh 配置下所有被使用的 key 译文必须含 CJK(白名单除外)", () => {
    const allKeys = new Set([...STATIC_KEYS, ...T_LITERAL_KEYS]);
    for (const key of allKeys) {
      if (ZH_LATIN_ALLOWLIST[key]) continue;
      const value = DICTS.zh[key];
      expect(value, `字典缺 zh.${key}`).toBeTruthy();
      // 纯符号/数字/短缩写(REM、ID、OK、emoji)无翻译语义,只看拉丁词 ≥4 字母的
      if (!LATIN_WORD_RE.test(value)) continue;
      expect(
        CJK_RE.test(value),
        `zh.${key} 译文「${value}」是纯拉丁文本,疑似漏译直接抄英文` +
          `(若为合法专有名词,需加入 ZH_LATIN_ALLOWLIST 并注明理由)`,
      ).toBe(true);
    }
  });
});
