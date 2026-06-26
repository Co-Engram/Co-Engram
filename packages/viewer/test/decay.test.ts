import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { zh, en } from "@co-engram/core";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";

/**
 * computeDecayState 和 renderDecayBar 都内嵌在 DECAY_RUNTIME 字符串里(浏览器端 JS),
 * 不能直接 import。这里通过 vm 模块模拟一个 window-like context 执行整段 runtime,
 * 然后断言 window.CO_ENGRAM_DECAY 暴露的接口。
 *
 * DECAY_RUNTIME 依赖 window.CO_ENGRAM_T(t / enumLabel / decayLabel),所以测试前先注入
 * 一个最小化的 stub(语义对齐 viewer/src/runtime/i18n.ts 的 fallback 逻辑)。
 */

function makeWindowStub(lang: "zh" | "en" = "zh") {
  const dict = lang === "zh" ? zh : en;
  const enFallback = en;
  return {
    CO_ENGRAM_I18N: { zh, en },
    CO_ENGRAM_LANG: lang,
    CO_ENGRAM_T: {
      t(key: string, vars?: Record<string, unknown>) {
        const tpl = dict[key] || enFallback[key] || key;
        if (!vars) return tpl;
        return tpl.replace(/\$\{(\w+)\}/g, (_, name) =>
          vars[name] !== undefined ? String(vars[name]) : "${" + name + "}",
        );
      },
      enumLabel(category: string, value: string) {
        if (!value) return dict["common.unknown"] || "Unknown";
        return dict["enum." + category + "." + value] || value;
      },
      decayLabel(days: number | null) {
        if (days === null || days === undefined)
          return dict["decay.forgotten"] || "";
        return dict["decay.daysToNext"].replace("${days}", String(days));
      },
    },
  };
}

function loadDecayRuntime(lang: "zh" | "en" = "zh") {
  // 用 require 拿到 vm,而不是 ESM 动态 import(避免测试启动慢)
  const require = createRequire(import.meta.url);
  const vm = require("node:vm") as typeof import("node:vm");
  const sandbox: Record<string, unknown> = makeWindowStub(lang);
  // 浏览器里 `window` 是全局自身引用;vm sandbox 不会自动加,
  // runtime 字符串中的 `window.CO_ENGRAM_T` / `window.CO_ENGRAM_I18N` 才能解析到。
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DECAY_RUNTIME, sandbox, { filename: "decay.runtime.js" });
  return sandbox.CO_ENGRAM_DECAY as {
    computeDecayState: (
      lastEffectiveAt: string | null | undefined,
      halfLifeDays: number | null | undefined,
      now?: Date,
    ) => {
      progressPct: number;
      currentLevel: string;
      daysToNext: number | null;
    } | null;
    renderDecayBar: (
      decay: {
        progressPct: number;
        currentLevel: string;
        daysToNext: number | null;
      } | null,
      halfLifeDays: number | null | undefined,
    ) => string;
  };
}

const HALF_LIFE = 90; // 90 天半衰期(与 fixtures 常用值一致)
const NOW = new Date("2026-06-27T00:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("viewer runtime / computeDecayState 边界", () => {
  const decay = loadDecayRuntime();

  it("halfLifeDays null → 返回 null(永不衰退)", () => {
    expect(decay.computeDecayState(daysAgo(10), null, NOW)).toBeNull();
  });

  it("halfLifeDays undefined → 返回 null", () => {
    expect(decay.computeDecayState(daysAgo(10), undefined, NOW)).toBeNull();
  });

  it("halfLifeDays <= 0 → 返回 null", () => {
    expect(decay.computeDecayState(daysAgo(10), 0, NOW)).toBeNull();
    expect(decay.computeDecayState(daysAgo(10), -5, NOW)).toBeNull();
  });

  it("lastEffectiveAt null → 返回 null(未生效过)", () => {
    expect(decay.computeDecayState(null, HALF_LIFE, NOW)).toBeNull();
  });

  it("lastEffectiveAt undefined → 返回 null", () => {
    expect(decay.computeDecayState(undefined, HALF_LIFE, NOW)).toBeNull();
  });

  it("lastEffectiveAt 非法字符串 → 返回 null", () => {
    expect(decay.computeDecayState("not-a-date", HALF_LIFE, NOW)).toBeNull();
  });

  it("ageDays = 0(刚生效)→ fresh, progressPct=0, daysToNext=halfLife", () => {
    const r = decay.computeDecayState(NOW.toISOString(), HALF_LIFE, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeCloseTo(0, 1);
    expect(r!.daysToNext).toBe(HALF_LIFE);
  });

  it("ageDays < halfLife(还在 fresh 阶段)→ fresh", () => {
    const r = decay.computeDecayState(daysAgo(30), HALF_LIFE, NOW);
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeGreaterThan(0);
    expect(r!.progressPct).toBeLessThan(25);
    expect(r!.daysToNext).toBe(HALF_LIFE - 30);
  });

  it("ageDays = halfLife(刚好到 fresh 上界,<=)→ 仍 fresh", () => {
    // 边界归入当前阶段(对应 core/freshness.ts 的 <= 阈值)
    const r = decay.computeDecayState(daysAgo(HALF_LIFE), HALF_LIFE, NOW);
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeCloseTo(25, 1);
    expect(r!.daysToNext).toBe(0); // 刚到边界,距 aging 还剩 0
  });

  it("ageDays = halfLife*2(刚好到 aging 上界,<=)→ 仍 aging", () => {
    const r = decay.computeDecayState(daysAgo(HALF_LIFE * 2), HALF_LIFE, NOW);
    expect(r!.currentLevel).toBe("aging");
    expect(r!.progressPct).toBeCloseTo(50, 1);
    expect(r!.daysToNext).toBe(0);
  });

  it("ageDays = halfLife*4(刚好到 stale 上界,<=)→ 仍 stale", () => {
    const r = decay.computeDecayState(daysAgo(HALF_LIFE * 4), HALF_LIFE, NOW);
    expect(r!.currentLevel).toBe("stale");
    expect(r!.progressPct).toBeCloseTo(100, 1);
    expect(r!.daysToNext).toBe(0);
  });

  it("ageDays 刚超过 halfLife*4(> 阈值)→ forgotten, daysToNext=null", () => {
    const r = decay.computeDecayState(
      daysAgo(HALF_LIFE * 4 + 1),
      HALF_LIFE,
      NOW,
    );
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });

  it("ageDays 远超 halfLife*4 → forgotten, progressPct clamp 到 100", () => {
    const r = decay.computeDecayState(daysAgo(HALF_LIFE * 10), HALF_LIFE, NOW);
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });

  it("ageDays < 0(时钟偏差,极少见)→ 按 fresh 处理, ageDays 视为 0", () => {
    // lastEffectiveAt 在 now 之后 1 天 → 视为 fresh
    const future = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const r = decay.computeDecayState(future, HALF_LIFE, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBe(0);
    expect(r!.daysToNext).toBe(HALF_LIFE);
  });
});

describe("viewer runtime / renderDecayBar DOM", () => {
  const decay = loadDecayRuntime("zh");

  it('decay=null + halfLifeDays=null → 显示"永不衰退"文案', () => {
    const html = decay.renderDecayBar(null, null);
    expect(html).toContain("decay-empty");
    expect(html).toContain("永不衰退");
  });

  it('decay=null + halfLifeDays>0 → 显示"尚未被有效使用"文案 + 悬停说明', () => {
    const html = decay.renderDecayBar(null, HALF_LIFE);
    expect(html).toContain("decay-empty");
    expect(html).toContain("尚未被有效使用");
    // 悬停说明解释成因(包含 engram_reinforce 关键字)
    expect(html).toContain("title=");
    expect(html).toContain("engram_reinforce");
  });

  it("fresh 状态 → 渲染进度条 + 倒计时 + freshness-fresh class", () => {
    const state = decay.computeDecayState(daysAgo(30), HALF_LIFE, NOW)!;
    const html = decay.renderDecayBar(state, HALF_LIFE);
    expect(html).toContain("decay-bar");
    expect(html).toContain("decay-fill");
    expect(html).toContain("freshness-fresh");
    expect(html).toContain("decay-countdown");
    expect(html).toContain("60"); // daysToNext = 90 - 30
  });

  it('forgotten 状态 → 倒计时位置显示"已遗忘",进度条满', () => {
    const state = decay.computeDecayState(
      daysAgo(HALF_LIFE * 5),
      HALF_LIFE,
      NOW,
    )!;
    const html = decay.renderDecayBar(state, HALF_LIFE);
    expect(html).toContain("freshness-forgotten");
    expect(html).toContain("已遗忘");
    expect(html).toContain("width:100.0%");
  });

  it("progressPct 渲染时保留 1 位小数", () => {
    // ageDays=30, halfLife=90 → progressPct = 30/360 * 100 ≈ 8.3
    const state = decay.computeDecayState(daysAgo(30), HALF_LIFE, NOW)!;
    const html = decay.renderDecayBar(state, HALF_LIFE);
    expect(html).toMatch(/width:\d+\.\d+%/);
  });

  it('英文 lang → 倒计时显示 "${days} days to next downgrade"', () => {
    const decayEn = loadDecayRuntime("en");
    const state = decayEn.computeDecayState(daysAgo(30), HALF_LIFE, NOW)!;
    const html = decayEn.renderDecayBar(state, HALF_LIFE);
    expect(html).toContain("60 days to next downgrade");
    expect(html).toContain("Fresh");
  });

  it('英文 lang + forgotten → "Forgotten"', () => {
    const decayEn = loadDecayRuntime("en");
    const state = decayEn.computeDecayState(
      daysAgo(HALF_LIFE * 5),
      HALF_LIFE,
      NOW,
    )!;
    const html = decayEn.renderDecayBar(state, HALF_LIFE);
    expect(html).toContain("Forgotten");
  });

  it('英文 lang + halfLifeDays=null → "Never decays"', () => {
    const decayEn = loadDecayRuntime("en");
    const html = decayEn.renderDecayBar(null, null);
    expect(html).toContain("Never decays");
  });

  it('英文 lang + lastEffectiveAt=null → "Not yet effectively used" + 悬停说明', () => {
    const decayEn = loadDecayRuntime("en");
    const html = decayEn.renderDecayBar(null, HALF_LIFE);
    expect(html).toContain("Not yet effectively used");
    expect(html).toContain("title=");
    expect(html).toContain("engram_reinforce");
  });
});

describe("viewer runtime / 公式与 core computeFreshness 对齐", () => {
  const decay = loadDecayRuntime();

  it("freshness 阈值:ageDays ≤ halfLife → fresh, ≤ 2× → aging, ≤ 4× → stale, > 4× → forgotten", () => {
    // 在阈值正中央各取一点,验证分级正确
    expect(
      decay.computeDecayState(daysAgo(HALF_LIFE * 0.5), HALF_LIFE, NOW)!
        .currentLevel,
    ).toBe("fresh");
    expect(
      decay.computeDecayState(daysAgo(HALF_LIFE * 1.5), HALF_LIFE, NOW)!
        .currentLevel,
    ).toBe("aging");
    expect(
      decay.computeDecayState(daysAgo(HALF_LIFE * 3), HALF_LIFE, NOW)!
        .currentLevel,
    ).toBe("stale");
    expect(
      decay.computeDecayState(daysAgo(HALF_LIFE * 5), HALF_LIFE, NOW)!
        .currentLevel,
    ).toBe("forgotten");
  });

  it("progressPct 在 fresh/aging/stale/forgotten 区间单调递增", () => {
    const pct = (d: number) =>
      decay.computeDecayState(daysAgo(d), HALF_LIFE, NOW)!.progressPct;
    expect(pct(0)).toBeLessThanOrEqual(pct(HALF_LIFE * 0.5));
    expect(pct(HALF_LIFE * 0.5)).toBeLessThanOrEqual(pct(HALF_LIFE * 1.5));
    expect(pct(HALF_LIFE * 1.5)).toBeLessThanOrEqual(pct(HALF_LIFE * 3));
    expect(pct(HALF_LIFE * 3)).toBeLessThanOrEqual(pct(HALF_LIFE * 5));
    expect(pct(HALF_LIFE * 5)).toBeLessThanOrEqual(100);
  });
});
