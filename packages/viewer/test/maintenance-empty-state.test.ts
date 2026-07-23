// 防回归:maintenance renderHtml 空 state crash
// 历史 bug:tabs.ts 行 3781/3789/3795 直接访问 lastResult.downstreamSummary,
// 当 maintenance 从未跑过(state.stages 空)时 lastResult=null → null.downstreamSummary
// → TypeError → maintenance tab 白屏无法访问。修复:改用已防御的 _ds
// (行 3725 定义 _ds = lastResult && lastResult.downstreamSummary)。
// 这个测试验证修复代码存在 + crash 代码已移除(TABS_RUNTIME 字符串检查)。
import { describe, it, expect } from "vitest";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

describe("maintenance renderHtml 空 state 防御(防 crash 回归)", () => {
  it("modifiedItems 访问用 _ds 防御,不裸访问 lastResult.downstreamSummary", () => {
    // 修复后:3 处 _ds && _ds.remModified / lightModified / deepModified
    expect(TABS_RUNTIME).toContain("_ds && _ds.remModified");
    expect(TABS_RUNTIME).toContain("_ds && _ds.lightModified");
    expect(TABS_RUNTIME).toContain("_ds && _ds.deepModified");
  });

  it("不应再有裸 lastResult.downstreamSummary.xxx(crash 根因)", () => {
    // 修复前:3 处直接 lastResult.downstreamSummary.remModified → null crash
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

  it("_ds 防御定义存在(lastResult && lastResult.downstreamSummary)", () => {
    expect(TABS_RUNTIME).toContain(
      "_ds = lastResult && lastResult.downstreamSummary",
    );
  });
});
