import { describe, it, expect } from "vitest";
import { zh, en } from "@co-engram/core";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";
import { VIEWER_CSS } from "../src/styles.js";

/**
 * Health tab 结构化 why/fix + doctor 联动卡片 smoke test
 *
 * 完整 DOM 渲染测试成本高(需要 mock document / CO_ENGRAM 对象),
 * 但本次改动的核心契约可以在字符串层稳定断言:
 *   1. TABS_RUNTIME 含可展开 details + _copyHealthCmd + _healthDoctorScan 入口
 *   2. STYLES 含对应样式 class
 *   3. zh / en 翻译表里所有 why/fix/doctor 文案 key 齐全(无渲染时回退到 key)
 *
 * 如果未来重构 tabs.ts / styles.ts,这些断言能立即暴露回归。
 */

const WHY_KEYS = [
  "data_root_missing",
  "data_root_not_warehouse",
  "config_unreadable",
  "config_missing_fields",
  "index_missing",
  "proposals_pending_high",
  "git_not_repo",
  "git_dirty_high",
  "merge_driver_missing",
] as const;

const FIX_DESCRIPTION_KEYS = [
  "data_root_missing",
  "data_root_not_warehouse",
  "config_unreadable",
  "config_missing_fields",
  "index_missing",
  "proposals_pending_high",
  "git_not_repo",
  "git_dirty_high",
  "merge_driver_missing",
] as const;

const UI_KEYS = [
  "viewer.health.check.why",
  "viewer.health.check.howToFix",
  "viewer.health.check.copyCommand",
  "viewer.health.check.commandCopied",
  "viewer.health.check.orCallTool",
  "viewer.health.check.expand",
  "viewer.health.doctor.title",
  "viewer.health.doctor.subtitle",
  "viewer.health.doctor.autoFixed",
  "viewer.health.doctor.pendingReview",
  "viewer.health.doctor.empty",
  "viewer.health.doctor.runScan",
  "viewer.health.doctor.loading",
  "viewer.health.doctor.nextAction",
  "viewer.health.doctor.noPending",
] as const;

describe("health tab / 翻译表 zh + en 双版本齐全", () => {
  for (const k of WHY_KEYS) {
    const fullKey = `viewer.health.why.${k}`;
    it(`zh.${fullKey} 有翻译`, () => {
      expect(zh[fullKey as keyof typeof zh], `zh.${fullKey} 缺翻译`).toBeTruthy();
    });
    it(`en.${fullKey} 有翻译`, () => {
      expect(en[fullKey as keyof typeof en], `en.${fullKey} 缺翻译`).toBeTruthy();
    });
  }

  for (const k of FIX_DESCRIPTION_KEYS) {
    const fullKey = `viewer.health.fix.${k}.description`;
    it(`zh.${fullKey} 有翻译`, () => {
      expect(zh[fullKey as keyof typeof zh], `zh.${fullKey} 缺翻译`).toBeTruthy();
    });
    it(`en.${fullKey} 有翻译`, () => {
      expect(en[fullKey as keyof typeof en], `en.${fullKey} 缺翻译`).toBeTruthy();
    });
  }

  for (const k of UI_KEYS) {
    it(`zh.${k} 有翻译`, () => {
      expect(zh[k as keyof typeof zh], `zh.${k} 缺翻译`).toBeTruthy();
    });
    it(`en.${k} 有翻译`, () => {
      expect(en[k as keyof typeof en], `en.${k} 缺翻译`).toBeTruthy();
    });
  }

  it("zh 与 en 的 why 翻译不同(防复制粘贴漏改)", () => {
    for (const k of WHY_KEYS) {
      const full = `viewer.health.why.${k}`;
      expect(zh[full as keyof typeof zh]).not.toBe(en[full as keyof typeof en]);
    }
  });
});

describe("health tab / TABS_RUNTIME 含必要片段", () => {
  it("warn/error 渲染为可展开 details", () => {
    expect(TABS_RUNTIME).toContain("health-check-details");
    expect(TABS_RUNTIME).toContain("health-check-expand-body");
    expect(TABS_RUNTIME).toContain("<details");
    expect(TABS_RUNTIME).toContain("<summary>");
  });

  it("引用 why / fix i18n keys(经 T.t())", () => {
    expect(TABS_RUNTIME).toContain("viewer.health.check.why");
    expect(TABS_RUNTIME).toContain("viewer.health.check.howToFix");
    expect(TABS_RUNTIME).toContain("viewer.health.check.copyCommand");
    expect(TABS_RUNTIME).toContain("viewer.health.check.orCallTool");
  });

  it("暴露 _copyHealthCmd helper(clipboard + fallback)", () => {
    expect(TABS_RUNTIME).toContain("CO_ENGRAM._copyHealthCmd");
    expect(TABS_RUNTIME).toContain("navigator.clipboard.writeText");
    // 非 HTTPS 上下文 fallback
    expect(TABS_RUNTIME).toContain("execCommand('copy')");
  });

  it("暴露 doctor 联动卡片 + _healthDoctorScan helper", () => {
    expect(TABS_RUNTIME).toContain("health-doctor-card");
    expect(TABS_RUNTIME).toContain("CO_ENGRAM._healthDoctorScan");
    expect(TABS_RUNTIME).toContain("/api/doctor");
    expect(TABS_RUNTIME).toContain("viewer.health.doctor.title");
    expect(TABS_RUNTIME).toContain("viewer.health.doctor.runScan");
    // 列出 pendingManualReview 的 issue 含 nextAction
    expect(TABS_RUNTIME).toContain("issue.nextAction");
    expect(TABS_RUNTIME).toContain("viewer.health.doctor.nextAction");
  });

  it("ok/info check 走原样扁平渲染(不被 details 包裹)", () => {
    // hasStructured false 分支应保留扁平 li
    expect(TABS_RUNTIME).toMatch(/else\s*{[\s\S]*health-check-item(?!\s+health-check-problem)/m);
  });
});

describe("health tab / STYLES 含配套样式", () => {
  it("problem details 展开样式存在", () => {
    expect(VIEWER_CSS).toContain(".health-check-problem");
    expect(VIEWER_CSS).toContain(".health-check-details");
    expect(VIEWER_CSS).toContain(".health-check-expand-body");
    expect(VIEWER_CSS).toContain(".health-why-block");
    expect(VIEWER_CSS).toContain(".health-fix-block");
  });

  it("复制命令按钮样式存在", () => {
    expect(VIEWER_CSS).toContain(".health-fix-cmd-row");
    expect(VIEWER_CSS).toContain(".health-fix-cmd");
    expect(VIEWER_CSS).toContain(".btn-mini");
  });

  it("doctor 联动卡片样式存在", () => {
    expect(VIEWER_CSS).toContain(".health-doctor-card");
    expect(VIEWER_CSS).toContain(".health-doctor-issue");
    expect(VIEWER_CSS).toContain(".health-doctor-nextaction");
    expect(VIEWER_CSS).toContain(".health-doctor-kpi");
  });
});
