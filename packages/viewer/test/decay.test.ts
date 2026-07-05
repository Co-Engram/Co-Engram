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
 *
 * D1 之后(decayHalfLifeDays 字段删除):衰退起点仍取 lastEffectiveAt ?? createdAt,
 * 半衰期由 importance 实时派生 — deriveHalfLifeDays(importance) = 50 * (imp + 0.1)^2.5。
 * 没有"永不衰退"概念;null 仅在时间戳损坏时出现,renderDecayBar(null) 返回空字符串。
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
      createdAt: string,
      importance: number,
      now?: Date,
    ) => {
      progressPct: number;
      currentLevel: string;
      daysToNext: number | null;
    } | null;
    renderDecayBar: (
      decay:
        | {
            progressPct: number;
            currentLevel: string;
            daysToNext: number | null;
          }
        | null,
    ) => string;
    deriveHalfLifeDays: (importance: number) => number;
  };
}

const IMP = 1.0; // importance=1.0 → halfLife ≈ 63.45 天(深度巩固)
const NOW = new Date("2026-06-27T00:00:00Z");
const CREATED_AT = NOW.toISOString(); // 默认 createdAt = now(新建 engram)

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("viewer runtime / deriveHalfLifeDays 公式(D1 机制 D)", () => {
  const decay = loadDecayRuntime();

  it("importance=0 → halfLife 仍 > 0(快速遗忘但不为零)", () => {
    // 50 * 0.1^2.5 ≈ 0.158
    expect(decay.deriveHalfLifeDays(0)).toBeGreaterThan(0);
    expect(decay.deriveHalfLifeDays(0)).toBeCloseTo(0.158, 2);
  });

  it("importance=0.5 → halfLife ≈ 14 天(中等记忆)", () => {
    // 50 * 0.6^2.5 ≈ 13.93
    expect(decay.deriveHalfLifeDays(0.5)).toBeCloseTo(13.93, 1);
  });

  it("importance=1.0 → halfLife ≈ 63 天(深度巩固)", () => {
    // 50 * 1.1^2.5 ≈ 63.45
    expect(decay.deriveHalfLifeDays(1.0)).toBeCloseTo(63.45, 1);
  });

  it("halfLife 随 importance 单调递增", () => {
    expect(decay.deriveHalfLifeDays(0)).toBeLessThan(decay.deriveHalfLifeDays(0.5));
    expect(decay.deriveHalfLifeDays(0.5)).toBeLessThan(decay.deriveHalfLifeDays(1.0));
  });
});

describe("viewer runtime / computeDecayState 边界", () => {
  const decay = loadDecayRuntime();
  const halfLife = decay.deriveHalfLifeDays(IMP); // ≈ 63.45

  it("lastEffectiveAt=null + createdAt 存在 → 用 createdAt 兜底算衰退", () => {
    // 新建 engram(lastEffectiveAt=null, createdAt=10 天前)→ 还在 fresh 阶段
    const r = decay.computeDecayState(null, daysAgo(10), IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.daysToNext).toBe(Math.ceil(halfLife - 10));
  });

  it("lastEffectiveAt=undefined + createdAt 存在 → 用 createdAt 兜底", () => {
    const r = decay.computeDecayState(undefined, daysAgo(10), IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
  });

  it("lastEffectiveAt=null + createdAt 也缺失 → 返回 null", () => {
    expect(decay.computeDecayState(null, "", IMP, NOW)).toBeNull();
  });

  it("lastEffectiveAt 非法 + createdAt 合法 → 用 createdAt 兜底", () => {
    // lastEffectiveAt 损坏,fallback 到 createdAt
    const r = decay.computeDecayState("not-a-date", daysAgo(30), IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
  });

  it("lastEffectiveAt 优先于 createdAt", () => {
    // lastEffectiveAt=10 天前,createdAt=100 天前 → 应该用 lastEffectiveAt
    const r = decay.computeDecayState(daysAgo(10), daysAgo(100), IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.daysToNext).toBe(Math.ceil(halfLife - 10));
  });

  it("ageDays = 0(刚生效)→ fresh, progressPct=0, daysToNext=halfLife", () => {
    const r = decay.computeDecayState(NOW.toISOString(), CREATED_AT, IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeCloseTo(0, 1);
    expect(r!.daysToNext).toBe(Math.ceil(halfLife));
  });

  it("ageDays < halfLife(还在 fresh 阶段)→ fresh", () => {
    const ageDays = halfLife * 0.3; // 30% of halfLife
    const r = decay.computeDecayState(daysAgo(ageDays), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeGreaterThan(0);
    expect(r!.progressPct).toBeLessThan(25);
    expect(r!.daysToNext).toBe(Math.ceil(halfLife - ageDays));
  });

  it("ageDays 略小于 halfLife(0.99×,明确在 fresh 内)→ fresh", () => {
    // 浮点边界不可靠(halfLife≈63.45 不是整数),用 0.99× 明确在内侧
    const r = decay.computeDecayState(daysAgo(halfLife * 0.99), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBeCloseTo(25, 0); // 接近 25%(fresh 上界)
    expect(r!.daysToNext).toBeLessThanOrEqual(1); // 接近 0 即可
  });

  it("ageDays 略大于 halfLife(1.01×,明确进入 aging)→ aging", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 1.01), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("aging");
    expect(r!.progressPct).toBeGreaterThan(25);
    expect(r!.progressPct).toBeLessThan(50);
  });

  it("ageDays 略小于 halfLife*2(1.99×,明确在 aging 内)→ aging", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 1.99), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("aging");
    expect(r!.progressPct).toBeCloseTo(50, 0);
  });

  it("ageDays 略大于 halfLife*2(2.01×,明确进入 stale)→ stale", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 2.01), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("stale");
    expect(r!.progressPct).toBeGreaterThan(50);
    expect(r!.progressPct).toBeLessThan(100);
  });

  it("ageDays 略小于 halfLife*4(3.99×,明确在 stale 内)→ stale", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 3.99), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("stale");
    expect(r!.progressPct).toBeCloseTo(100, 0);
  });

  it("ageDays 略大于 halfLife*4(4.01×,明确进入 forgotten)→ forgotten", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 4.01), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });

  it("ageDays 刚超过 halfLife*4(> 阈值)→ forgotten, daysToNext=null", () => {
    const r = decay.computeDecayState(
      daysAgo(halfLife * 4 + 1),
      CREATED_AT,
      IMP,
      NOW,
    );
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });

  it("ageDays 远超 halfLife*4 → forgotten, progressPct clamp 到 100", () => {
    const r = decay.computeDecayState(daysAgo(halfLife * 10), CREATED_AT, IMP, NOW);
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });

  it("ageDays < 0(时钟偏差,极少见)→ 按 fresh 处理, ageDays 视为 0", () => {
    // lastEffectiveAt 在 now 之后 1 天 → 视为 fresh
    const future = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const r = decay.computeDecayState(future, CREATED_AT, IMP, NOW);
    expect(r).not.toBeNull();
    expect(r!.currentLevel).toBe("fresh");
    expect(r!.progressPct).toBe(0);
    expect(r!.daysToNext).toBe(Math.ceil(halfLife));
  });

  it("importance=0(极低重要性)→ halfLife 很小,几乎立即 forgotten", () => {
    // importance=0 → halfLife ≈ 0.158 天;10 天前 → 远超 halfLife*4
    const r = decay.computeDecayState(daysAgo(10), CREATED_AT, 0, NOW);
    expect(r!.currentLevel).toBe("forgotten");
    expect(r!.progressPct).toBe(100);
    expect(r!.daysToNext).toBeNull();
  });
});

describe("viewer runtime / renderDecayBar DOM", () => {
  const decay = loadDecayRuntime("zh");
  const halfLife = decay.deriveHalfLifeDays(IMP);

  it("decay=null(时间戳损坏)→ 返回空字符串(不再有'永不衰退'概念)", () => {
    const html = decay.renderDecayBar(null);
    expect(html).toBe("");
  });

  it("fresh 状态 → 渲染进度条 + 倒计时 + freshness-fresh class", () => {
    const ageDays = halfLife * 0.3;
    const state = decay.computeDecayState(daysAgo(ageDays), CREATED_AT, IMP, NOW)!;
    const html = decay.renderDecayBar(state);
    expect(html).toContain("decay-bar");
    expect(html).toContain("decay-fill");
    expect(html).toContain("freshness-fresh");
    expect(html).toContain("decay-countdown");
    const expectedDays = Math.ceil(halfLife - ageDays);
    expect(html).toContain(String(expectedDays));
  });

  it('forgotten 状态 → 倒计时位置显示"已遗忘",进度条满', () => {
    const state = decay.computeDecayState(
      daysAgo(halfLife * 5),
      CREATED_AT,
      IMP,
      NOW,
    )!;
    const html = decay.renderDecayBar(state);
    expect(html).toContain("freshness-forgotten");
    expect(html).toContain("已遗忘");
    expect(html).toContain("width:100.0%");
  });

  it("progressPct 渲染时保留 1 位小数", () => {
    const ageDays = halfLife * 0.3;
    const state = decay.computeDecayState(daysAgo(ageDays), CREATED_AT, IMP, NOW)!;
    const html = decay.renderDecayBar(state);
    expect(html).toMatch(/width:\d+\.\d+%/);
  });

  it('英文 lang → 倒计时显示 "{days} days to next downgrade"', () => {
    const decayEn = loadDecayRuntime("en");
    const ageDays = halfLife * 0.3;
    const state = decayEn.computeDecayState(daysAgo(ageDays), CREATED_AT, IMP, NOW)!;
    const html = decayEn.renderDecayBar(state);
    const expectedDays = Math.ceil(halfLife - ageDays);
    expect(html).toContain(expectedDays + " days to next downgrade");
    expect(html).toContain("Fresh");
  });

  it('英文 lang + forgotten → "Forgotten"', () => {
    const decayEn = loadDecayRuntime("en");
    const state = decayEn.computeDecayState(
      daysAgo(halfLife * 5),
      CREATED_AT,
      IMP,
      NOW,
    )!;
    const html = decayEn.renderDecayBar(state);
    expect(html).toContain("Forgotten");
  });
});

describe("viewer runtime / 公式与 core computeFreshness 对齐", () => {
  const decay = loadDecayRuntime();
  const halfLife = decay.deriveHalfLifeDays(IMP);

  it("freshness 阈值:ageDays ≤ halfLife → fresh, ≤ 2× → aging, ≤ 4× → stale, > 4× → forgotten", () => {
    // 在阈值正中央各取一点,验证分级正确
    expect(
      decay.computeDecayState(daysAgo(halfLife * 0.5), CREATED_AT, IMP, NOW)!
        .currentLevel,
    ).toBe("fresh");
    expect(
      decay.computeDecayState(daysAgo(halfLife * 1.5), CREATED_AT, IMP, NOW)!
        .currentLevel,
    ).toBe("aging");
    expect(
      decay.computeDecayState(daysAgo(halfLife * 3), CREATED_AT, IMP, NOW)!
        .currentLevel,
    ).toBe("stale");
    expect(
      decay.computeDecayState(daysAgo(halfLife * 5), CREATED_AT, IMP, NOW)!
        .currentLevel,
    ).toBe("forgotten");
  });

  it("progressPct 在 fresh/aging/stale/forgotten 区间单调递增", () => {
    const pct = (d: number) =>
      decay.computeDecayState(daysAgo(d), CREATED_AT, IMP, NOW)!.progressPct;
    expect(pct(0)).toBeLessThanOrEqual(pct(halfLife * 0.5));
    expect(pct(halfLife * 0.5)).toBeLessThanOrEqual(pct(halfLife * 1.5));
    expect(pct(halfLife * 1.5)).toBeLessThanOrEqual(pct(halfLife * 3));
    expect(pct(halfLife * 3)).toBeLessThanOrEqual(pct(halfLife * 5));
    expect(pct(halfLife * 5)).toBeLessThanOrEqual(100);
  });
});
