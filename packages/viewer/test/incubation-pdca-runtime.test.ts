/**
 * 沉思 PDCA runtime(vm)渲染回归(Phase1-3):
 * 1. renderCard:repairing 徽标 / degraded 徽标 + 未闭合清单 + 下轮验证任务(P8)
 * 2. reportHtml:闭合校验段(openGaps / 探测豁免 / 收窄拦截 / 答案复读标记 /
 *    降级占比)+ 主张抽取段(P7)
 * 3.(隔离区渲染经 API 级测试覆盖:proposals-quarantine-api.test.ts 三分支;
 *   渲染层为纯模板字符串,键引用受 i18n 一致性测试保障)
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";

import { zh } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

function makeEl(): any {
  return new Proxy(
    { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, style: {}, hidden: false },
    {
      get(t: any, k: string) {
        if (k in t) return t[k];
        return () => {};
      },
      set(t: any, k: string, v: any) {
        t[k] = v;
        return true;
      },
    },
  );
}

function makeSandbox(): Record<string, any> {
  const idMap: Record<string, any> = {};
  const doc = {
    getElementById(id: string) {
      return (idMap[id] ??= makeEl());
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    createElement() {
      return makeEl();
    },
    addEventListener() {},
    documentElement: makeEl(),
    body: makeEl(),
    head: makeEl(),
    readyState: "complete",
  };
  const sandbox: Record<string, any> = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearInterval = () => {};
  sandbox.alert = () => {};
  sandbox.confirm = () => true;
  return sandbox;
}

function execRuntime(): Record<string, any> {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  const script = [
    `window.CO_ENGRAM_I18N = ${JSON.stringify({ zh, en: {} })};`,
    `window.CO_ENGRAM_LANG = "zh";`,
    I18N_RUNTIME,
    DECAY_RUNTIME,
    APP_RUNTIME,
    GRAPH_RUNTIME,
    TABS_RUNTIME,
  ].join("\n;\n");
  vm.runInContext(script, sandbox, { filename: "viewer-runtime.js" });
  return sandbox;
}

/** 带 PDCA 产物的 done 条目(degraded + pdca + 主张清单) */
function makePdcaEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "inc-pdca-1",
    question: "PDCA 渲染验证问题",
    status: "done",
    rounds: 1,
    createdAt: "2026-08-19T02:00:00.000Z",
    lastRunAt: "2026-08-19T04:00:00.000Z",
    answer: "带主张的回答正文。",
    degraded: {
      at: "2026-08-19T04:00:00.000Z",
      reason: "repair-budget-exhausted",
      unclosedGaps: ["未闭合的外部检索需求"],
      nextTasks: ["用 web 检索验证业界基准 X", "复查记忆图谱引用链"],
    },
    timeline: [
      {
        at: "2026-08-19T04:00:00.000Z", round: 1, trigger: "manual",
        summaries: [], proposalEntityIds: [],
        answer: "带主张的回答正文。",
        pdca: {
          repairRound: 6,
          openGaps: ["未闭合的外部检索需求"],
          closedThisRound: 3,
          degraded: true,
          narrowed: ["被删除的计划项甲"],
          exempted: ["探测皆空自动豁免的计划项乙"],
          answerRepeat: true,
          answerDowngradeRatio: 0.75,
        },
        answerClaims: [
          { claim: "有据主张一", status: "evidenced" },
          { claim: "无据推测二", status: "downgraded" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("renderCard:PDCA 状态与 degraded 差分", () => {
  it("repairing 条目:状态徽标 + 进行中可终止/可删(2026-08-19)+ 30s 轮询条件兼容", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makePdcaEntry({ status: "repairing", degraded: undefined }));
    expect(html).toContain(zh["viewer.contemplation.status.repairing"]);
    // 进行中:终止 + 可用删除(不再是置灰禁用)
    expect(html).toContain("CO_ENGRAM_CONTEMPLATION.cancelRun");
    expect(html).toContain("CO_ENGRAM_CONTEMPLATION.remove");
    expect(html).not.toContain("disabled");
  });

  it("degraded 条目:降级徽标 + 成因 + 未闭合清单 + 下轮验证任务(P8)", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makePdcaEntry());
    expect(html).toContain(zh["viewer.contemplation.degradedBadge"]);
    expect(html).toContain(zh["viewer.contemplation.degradedReason.repair-budget-exhausted"]);
    expect(html).toContain("未闭合的外部检索需求");
    expect(html).toContain(zh["viewer.contemplation.nextTasks"]);
    expect(html).toContain("用 web 检索验证业界基准 X");
  });

  it("reportHtml:闭合校验段六要素(修复轮/闭合数/开放缺口/豁免/收窄/复读+占比)+ 主张抽取段", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.reportHtml(makePdcaEntry());
    expect(html).toContain(zh["viewer.contemplation.section.pdca"]);
    expect(html).toContain(zh["viewer.contemplation.pdca.repairRound"].replace("${n}", "6"));
    expect(html).toContain("探测皆空自动豁免的计划项乙");
    expect(html).toContain("被删除的计划项甲");
    expect(html).toContain(zh["viewer.contemplation.pdca.answerRepeat"]);
    expect(html).toContain(zh["viewer.contemplation.pdca.claimsWeak"]);
    // 主张抽取(P7)
    expect(html).toContain(zh["viewer.contemplation.section.claims"]);
    expect(html).toContain("有据主张一");
    expect(html).toContain("无据推测二");
  });
});

