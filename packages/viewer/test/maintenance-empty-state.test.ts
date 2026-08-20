// 防回归:maintenance 空态 crash
// 历史 bug:tabs.ts 直接访问 lastResult.downstreamSummary,当 maintenance
// 从未跑过(state.stages 空)时 lastResult=null → null.downstreamSummary
// → TypeError → maintenance tab 白屏无法访问。
// 2026-08-19 重排后:产物明细统一在睡眠报告(renderSleepReport),数据访问
// 经 ds() 函数防御(stages[s] && lastResult && downstreamSummary || {});
// 梦境状态行(renderHtml)不再访问 lastResult 产物字段。
// 这个测试验证防御代码存在 + crash 代码不存在(TABS_RUNTIME 字符串检查)。
import { describe, it, expect } from "vitest";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

describe("maintenance renderHtml 空 state 防御(防 crash 回归)", () => {
  it("产物数组访问用 ds() 防御抽取 + || [] 兜底,不裸访问", () => {
    // renderSleepReport:ds() 三重防御 + 各产物数组 || [] 兜底
    expect(TABS_RUNTIME).toContain(
      "stages[s] && stages[s].lastResult && stages[s].lastResult.downstreamSummary",
    );
    expect(TABS_RUNTIME).toContain("(remDs.remModified || [])");
    expect(TABS_RUNTIME).toContain("lightDs.lightModified || []");
    expect(TABS_RUNTIME).toContain("deepMods = deepDs.deepModified || []");
  });

  it("不应再有裸 lastResult.downstreamSummary.xxx(crash 根因)", () => {
    // crash 形态:直接 lastResult.downstreamSummary.remModified → null crash
    expect(TABS_RUNTIME).not.toContain(
      "lastResult.downstreamSummary.remModified",
    );
    expect(TABS_RUNTIME).not.toContain(
      "lastResult.downstreamSummary.lightModified",
    );
    expect(TABS_RUNTIME).not.toContain(
      "lastResult.downstreamSummary.deepModified",
    );
  });
});
