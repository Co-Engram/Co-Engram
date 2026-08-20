/**
 * rem-insight 卡片渲染回归测试（2026-08-18）
 *
 * 背景:用户报告 rem-insight 提案卡片四个缺陷 ——
 *   1. 来源行落入 conversation 兜底,误显「对话聚类」+ 原始 rem-insight 徽标
 *   2. 与「💡 深度洞察」chip 语义重复(同一标识两遍)
 *   3. critic chip 硬编码英文裸词「critic 0.90」
 *   4. 💬「N 条样本」chip 计数失真(sampleQuotes 曾为引擎调试串)
 * 本测试在 vm 中执行真实 runtime,构造与生产同形的 proposal 数据做功能断言,
 * 防止 _sourceLine / _whyBlock / 卡片 chip 行再度回归。
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { zh, en } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

// ============================================================
// mock DOM —— 与 rem-synapse-card.test.ts 一致
// ============================================================
function makeEl(): any {
  return new Proxy(
    { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, style: {}, hidden: false, querySelectorAll: () => [] },
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
  sandbox.alert = () => {};
  return sandbox;
}

function execRuntime(): Record<string, any> {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  const script = [
    `window.CO_ENGRAM_I18N = ${JSON.stringify({ zh, en })};`,
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

// 与生产 proposals.jsonl 同形的 rem-insight 提案(2026-08-17 用户实测样本形状)
const REM_INSIGHT_PROPOSAL = {
  entityId: "rem-insight:ce87d30fdaca1f98",
  occurrences: 1,
  // 修复后 sampleQuotes = 来源记忆标题(core proposeInsight 保证)
  sampleQuotes: ["LLM agent 协作硬规则(active verify / 自答 trade-off)", "co-engram viewer 端口门控方案"],
  centroidExcerpt: "外部守门人模式:从 LLM harness 到端口门控",
  firstSeenAt: "2026-08-17T08:59:28.159Z",
  lastSeenAt: "2026-08-17T08:59:28.159Z",
  createdAt: "2026-08-17T08:59:28.159Z",
  status: "pending",
  source: "rem-insight",
  payload: {
    title: "外部守门人模式:从 LLM harness 到端口门控",
    content: "LLM 系统把约束外化给 harness hook,与 viewer 端口漂移治理共享同一关系结构。",
    summary: "把不可靠的自我协调替换为显式外部中介的结构,在 LLM 约束外化与端口门控两个域同构。",
    domainTags: ["LLM约束外化", "端口漂移治理"],
    kind: "pattern",
    sourceType: "inferred",
    importance: 0.7,
    remConfidence: 0.9,
    insightMode: "inspiration",
    insightType: "analogy",
    criticScore: 0.9,
    criticRationale: "类比有结构基础,引用了两个真实来源。",
    incubationId: "inc-1",
  },
};

describe("rem-insight 卡片渲染回归测试", () => {
  const sandbox = execRuntime();

  it("vm 执行成功,CO_ENGRAM_PROPOSALS 已挂载", () => {
    expect(typeof sandbox.CO_ENGRAM_PROPOSALS).toBe("object");
    expect(sandbox.CO_ENGRAM_PROPOSALS).not.toBeNull();
  });

  it("_sourceLine:rem-insight 显示「夜思洞察」,不显示「对话聚类」与原始 rem-insight 徽标", () => {
    const html = sandbox.CO_ENGRAM_PROPOSALS._sourceLine(REM_INSIGHT_PROPOSAL);
    expect(html).toContain("夜思洞察");
    expect(html).not.toContain("对话聚类");
    // 原始 source 串只允许出现在 entityId 里;来源行不应再有 src-badge 英文串
    expect(html).not.toContain("src-badge");
    expect(html).not.toContain(">rem-insight<");
  });

  it("_sourceLine:rem-pattern 显示「模式提炼」,不落对话聚类兜底", () => {
    const html = sandbox.CO_ENGRAM_PROPOSALS._sourceLine({ ...REM_INSIGHT_PROPOSAL, source: "rem-pattern" });
    expect(html).toContain("模式提炼");
    expect(html).not.toContain("对话聚类");
  });

  it("_whyBlock:rem-insight 显示夜思来源与独立评审说明,不显「N 条独立样本」", () => {
    const html = sandbox.CO_ENGRAM_PROPOSALS._whyBlock(REM_INSIGHT_PROPOSAL);
    expect(html).toContain("夜思洞察");
    expect(html).toContain("独立 AI 评审");
    expect(html).not.toContain("条独立样本");
    expect(html).not.toContain("对话聚类");
  });

  it("来源细分:insightTrigger=manual 显示「沉思洞察」,夜思与沉思互斥(2026-08-20)", () => {
    const manual = { ...REM_INSIGHT_PROPOSAL, payload: { ...REM_INSIGHT_PROPOSAL.payload, insightTrigger: "manual" } };
    // 列表来源行
    expect(sandbox.CO_ENGRAM_PROPOSALS._sourceLine(manual)).toContain("沉思洞察");
    expect(sandbox.CO_ENGRAM_PROPOSALS._sourceLine(manual)).not.toContain("夜思洞察");
    // 「为什么生成」详情面板
    expect(sandbox.CO_ENGRAM_PROPOSALS._whyBlock(manual)).toContain("沉思洞察");
    expect(sandbox.CO_ENGRAM_PROPOSALS._whyBlock(manual)).not.toContain("夜思洞察");
    // 无 trigger(历史提案/夜思调度)→ 夜思
    expect(sandbox.CO_ENGRAM_PROPOSALS._sourceLine(REM_INSIGHT_PROPOSAL)).toContain("夜思洞察");
  });

  it("整卡渲染(fetch mock):critic chip 为「评审 0.90」且无 💬 样本 chip / 无对话聚类 / 无重复徽标", async () => {
    // 拦截分页器 apiGet → fetch;vm 沙箱无 URLSearchParams,注入 node 实现
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [REM_INSIGHT_PROPOSAL], nextCursor: null, total: 1 }),
    });
    const el = sandbox.document.getElementById("proposals-content");
    await sandbox.CO_ENGRAM_PROPOSALS.render(el);
    const html = String(el.innerHTML);

    // ① 专属标识:💡 深度洞察 chip 存在(唯一标识,不再叠加英文徽标)
    expect(html).toContain("深度洞察");
    expect(html).not.toContain("src-badge");
    // ② 来源行:夜思洞察,而非对话聚类
    expect(html).toContain("夜思洞察");
    expect(html).not.toContain("对话聚类");
    // ③ critic chip:i18n 白话文案,不再是英文裸词「critic 0.90」
    expect(html).toContain("评审 0.90");
    expect(html).not.toContain(">critic ");
    // ④ 样本 chip:rem-insight 不显示「N 条样本」(sampleQuotes 非对话样本)
    expect(html).not.toContain("💬");
    // ⑤ 描述:payload.summary 优先(卡片预览可读中文)
    expect(html).toContain("显式外部中介");
  });
});
