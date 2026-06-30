import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { zh, en } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { renderSpaHtml } from "../src/index.js";

/**
 * formatScoreBand 内嵌在 I18N_RUNTIME 字符串里(浏览器端 JS),不能直接 import。
 * 这里复用 decay.test.ts 的 pattern:用 node:vm 模拟 window context 执行整段 runtime,
 * 然后断言 window.CO_ENGRAM_T.formatScoreBand 暴露的接口。
 *
 * 阈值必须与 core formatScoreField 一致(≥0.7 high / ≥0.3 medium / <0.3 low),
 * 否则网页 band 标签与 MCP 工具返回的 *Band 字段会矛盾。
 */

function loadI18nRuntime(lang: "zh" | "en" = "zh") {
  const require = createRequire(import.meta.url);
  const vm = require("node:vm") as typeof import("node:vm");
  const sandbox: Record<string, unknown> = {
    CO_ENGRAM_I18N: { zh, en },
    CO_ENGRAM_LANG: lang,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(I18N_RUNTIME, sandbox, { filename: "i18n.runtime.js" });
  return (sandbox.CO_ENGRAM_T as {
    formatScoreBand: (value: number | null | undefined) => string;
  }).formatScoreBand;
}

describe("viewer i18n / scoreBand dictionary", () => {
  it("viewer.scoreBand.{high,medium,low} 在 zh 和 en 都有翻译(不返回 key 本身)", () => {
    for (const band of ["high", "medium", "low"] as const) {
      const key = `viewer.scoreBand.${band}`;
      const zhVal = zh[key as keyof typeof zh];
      const enVal = en[key as keyof typeof en];
      expect(zhVal, `zh.${key} 缺翻译`).toBeTruthy();
      expect(enVal, `en.${key} 缺翻译`).toBeTruthy();
      expect(zhVal, `zh.${key} 误填成 key`).not.toBe(key);
      expect(enVal, `en.${key} 误填成 key`).not.toBe(key);
    }
  });

  it("zh 与 en 翻译不同(防止复制粘贴漏改)", () => {
    expect(zh["viewer.scoreBand.high"]).not.toBe(en["viewer.scoreBand.high"]);
    expect(zh["viewer.scoreBand.medium"]).not.toBe(en["viewer.scoreBand.medium"]);
    expect(zh["viewer.scoreBand.low"]).not.toBe(en["viewer.scoreBand.low"]);
  });
});

describe("viewer runtime / formatScoreBand 阈值与 core 一致", () => {
  const formatScoreBand = loadI18nRuntime("zh");

  it("null / undefined / NaN 返回 '—'", () => {
    expect(formatScoreBand(null)).toBe("—");
    expect(formatScoreBand(undefined)).toBe("—");
    expect(formatScoreBand(Number.NaN)).toBe("—");
  });

  it("value ≥ 0.7 → high band", () => {
    expect(formatScoreBand(0.7)).toContain("高");
    expect(formatScoreBand(0.95)).toContain("高");
    expect(formatScoreBand(1)).toContain("高");
  });

  it("0.3 ≤ value < 0.7 → medium band", () => {
    expect(formatScoreBand(0.3)).toContain("中");
    expect(formatScoreBand(0.5)).toContain("中");
    expect(formatScoreBand(0.69)).toContain("中");
  });

  it("value < 0.3 → low band", () => {
    expect(formatScoreBand(0)).toContain("低");
    expect(formatScoreBand(0.29)).toContain("低");
  });

  it("边界精确:0.7 是 high,0.69 是 medium;0.3 是 medium,0.29 是 low", () => {
    expect(formatScoreBand(0.7)).toMatch(/高/);
    expect(formatScoreBand(0.69)).toMatch(/中/);
    expect(formatScoreBand(0.3)).toMatch(/中/);
    expect(formatScoreBand(0.29)).toMatch(/低/);
  });

  it("保留 2 位小数(杀浮点噪声 0.018000000000000002)", () => {
    expect(formatScoreBand(0.018000000000000002)).toBe("0.02 · 低");
    expect(formatScoreBand(0.7719155626908514)).toBe("0.77 · 高");
  });

  it("英文环境下输出英文 band label", () => {
    const formatScoreBandEn = loadI18nRuntime("en");
    expect(formatScoreBandEn(0.95)).toBe("0.95 · High");
    expect(formatScoreBandEn(0.5)).toBe("0.50 · Medium");
    expect(formatScoreBandEn(0.1)).toBe("0.10 · Low");
  });
});

describe("viewer runtime / renderSpaHtml 注入 formatScoreBand", () => {
  it("SPA HTML 含 formatScoreBand helper 暴露", () => {
    const html = renderSpaHtml({ language: "zh" });
    expect(html).toContain("formatScoreBand: formatScoreBand");
  });
});
