/**
 * 沉思 runtime(vm)回归(2026-08-17 重设计):
 * 1. renderCard 三态(queued/thinking/done)——按钮组、进度条、依据区、报告区
 * 2. 报告/依据展开态跨 30s 轮询保留(_expanded/_expandedEvidence)
 * 3. reportHtml 各节:回答/洞察提案/过程(plan+trace)/诊断/历史(时间戳,无轮次概念)
 * 4. create(创建即深思)/rethink/remove 的请求面与 confirm 行为
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";

import { zh } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

// ============================================================
// mock DOM —— 与 rem-synapse-card.test.ts 完全一致
// ============================================================
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

/** 构造一个 done、含 2 次 timeline(带 answer/资源申报)的条目(renderCard 全路径) */
function makeEntry(id = "inc-vm-1", status = "done") {
  return {
    id,
    question: "vm 测试问题:沉思卡片渲染",
    status,
    rounds: 2,
    createdAt: "2026-08-17T02:00:00.000Z",
    lastRunAt: "2026-08-17T04:00:00.000Z",
    answer: "回答正文:方向 A 有据。",
    timeline: [
      { at: "2026-08-16T20:00:00.000Z", round: 1, trigger: "manual", summaries: ["第一次摘要"], answer: "第一次回答" },
      {
        at: "2026-08-17T04:00:00.000Z", round: 2, trigger: "manual",
        summaries: ["第二次摘要"],
        proposalEntityIds: ["rem-insight:x"],
        plan: ["盘点 — engram_search"],
        trace: ["s1: engram_search — 命中 3 条"],
        resourcesUsed: { engrams: ["AIOS/co-engram/方法论"], skills: ["图谱页配置"], logs: ["/tmp/.co-engram/audit.jsonl"] },
        answer: "回答正文:方向 A 有据。",
        diagnosis: { drafts: 2, dupVetoed: 0, validateRejected: 1, criticRejected: 0, llmClientMissing: false, rejectReasons: ["[validate] 弱草稿: 引用缺失"] },
      },
    ],
  };
}

describe("renderCard 三态(2026-08-17 重设计)", () => {
  it("done 条目:状态徽标 + 回答预览 + 再思/依据/删除按钮 + 报告区默认收起", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry());
    expect(html).toContain(zh["viewer.contemplation.status.done"]);
    expect(html).toContain("回答正文:方向 A 有据。");
    expect(html).toContain(zh["viewer.contemplation.rethinkBtn"]);
    expect(html).toContain(zh["viewer.contemplation.evidenceBtn"]);
    expect(html).toContain(zh["viewer.contemplation.deleteBtn"]);
    // 报告区存在且默认收起
    expect(html).toContain('id="inc-report-inc-vm-1"');
    expect(html).toContain(" hidden");
    // 旧概念不复存在:排程 chip / 轮数 chip / resolve 仪式 / 档位词「全量盘点」
    expect(html).not.toContain("scheduleChipTip");
    expect(html).not.toContain("resolveGuidance");
    expect(html).not.toContain("全量盘点");
  });

  it("thinking 条目:进度区 + 阶段说明 + 删除置灰(thinkingCantDelete),无回答预览", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry("inc-vm-2", "thinking"));
    expect(html).toContain(zh["viewer.contemplation.status.thinking"]);
    expect(html).toContain(zh["viewer.contemplation.thinkingHint"]);
    expect(html).toContain(zh["viewer.contemplation.thinkingCantDelete"]);
    expect(html).not.toContain(zh["viewer.contemplation.rethinkBtn"]);
    expect(html).not.toContain(zh["viewer.contemplation.answerLabel"]);
  });

  it("queued 条目:灰徽标;无报告可展开,但有再思/删除", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry("inc-vm-3", "queued"));
    expect(html).toContain(zh["viewer.contemplation.status.queued"]);
    expect(html).toContain(zh["viewer.contemplation.rethinkBtn"]);
  });
});

describe("报告各节(reportHtml)", () => {
  it("回答全文 + 洞察提案列表 + 过程(plan/trace)+ 诊断 + 历史时间戳", () => {
    const sb = execRuntime();
    const e = makeEntry();
    const html = sb.CO_ENGRAM_CONTEMPLATION.reportHtml(e);
    expect(html).toContain(zh["viewer.contemplation.section.answer"]);
    expect(html).toContain("回答正文:方向 A 有据。");
    expect(html).toContain(zh["viewer.contemplation.section.insights"]);
    expect(html).toContain("第二次摘要");
    expect(html).toContain(zh["viewer.contemplation.section.process"]);
    expect(html).toContain("思考计划（1 步）");
    expect(html).toContain("执行轨迹（1 步）");
    expect(html).toContain(zh["viewer.contemplation.section.diagnosis"]);
    expect(html).toContain("[validate] 弱草稿");
    expect(html).toContain(zh["viewer.contemplation.section.history"]);
    expect(html).toContain("第一次回答");
    // 无「第几夜/Round」概念:历史按时间戳呈现
    expect(html).not.toContain("Round 1");
    expect(html).not.toContain("timelineRound");
  });

  it("无 resourcesUsed 的旧条目:不出「依据」按钮", () => {
    const sb = execRuntime();
    const e = makeEntry();
    delete e.timeline[1].resourcesUsed;
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(e);
    expect(html).not.toContain(zh["viewer.contemplation.evidenceBtn"]);
  });
});

describe("依据区(evidenceHtml)", () => {
  it("记忆 chips(可点开印迹)+ 技能 chips + 日志路径", () => {
    const sb = execRuntime();
    const html = sb.CO_ENGRAM_CONTEMPLATION.evidenceHtml(makeEntry());
    expect(html).toContain("读取的记忆（1，点击打开）");
    expect(html).toContain("使用的技能（1）");
    expect(html).toContain("读取的日志（1）");
    expect(html).toContain("AIOS/co-engram/方法论");
    expect(html).toContain("openEngramDetail");
    expect(html).toContain("图谱页配置");
    expect(html).toContain("/tmp/.co-engram/audit.jsonl");
  });
});

describe("展开态跨 30s 轮询保留", () => {
  it("报告展开 → renderCard 重建仍展开;再 toggle 收起;条目间隔离", () => {
    const sb = execRuntime();
    sb.CO_ENGRAM_CONTEMPLATION.toggleReport("inc-vm-1");
    let html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry());
    expect(html).not.toContain('id="inc-report-inc-vm-1" hidden');
    sb.CO_ENGRAM_CONTEMPLATION.toggleReport("inc-vm-1");
    html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry());
    expect(html).toContain('id="inc-report-inc-vm-1" hidden');
    // 隔离:A 展开不影响 B
    sb.CO_ENGRAM_CONTEMPLATION.toggleReport("inc-vm-1");
    const htmlB = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry("inc-vm-b"));
    expect(htmlB).toContain('id="inc-report-inc-vm-b" hidden');
  });

  it("依据展开同理(_expandedEvidence)", () => {
    const sb = execRuntime();
    sb.CO_ENGRAM_CONTEMPLATION.toggleEvidence("inc-vm-1");
    const html = sb.CO_ENGRAM_CONTEMPLATION.renderCard(makeEntry());
    expect(html).not.toContain('id="inc-evidence-inc-vm-1" hidden');
  });
});

describe("动作请求面", () => {
  async function withFetch(opts: { status?: number; json?: unknown; confirm?: boolean } = {}) {
    const sb = execRuntime();
    const calls: string[] = [];
    sb.confirm = () => opts.confirm ?? true;
    sb.fetch = async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => opts.json ?? {} };
    };
    return { sb, calls };
  }

  it("remove():confirm 取消 → 不发请求;确认 → POST /api/contemplations/:id/delete", async () => {
    const cancelled = await withFetch({ confirm: false });
    await cancelled.sb.CO_ENGRAM_CONTEMPLATION.remove("inc-1");
    expect(cancelled.calls).toHaveLength(0);
    const ok = await withFetch({});
    await ok.sb.CO_ENGRAM_CONTEMPLATION.remove("inc-1");
    expect(ok.calls.some((c) => c.startsWith("POST ") && c.includes("/api/contemplations/inc-1/delete"))).toBe(true);
  });

  it("rethink():confirm 确认 → POST :id/run,job 槽显示深思中", async () => {
    const { sb, calls } = await withFetch({ json: { jobId: "job-1" } });
    await sb.CO_ENGRAM_CONTEMPLATION.rethink("inc-1");
    expect(calls.some((c) => c.includes("POST") && c.includes("/api/contemplations/inc-1/run"))).toBe(true);
  });

  it("create():POST /api/contemplations(创建即深思),拿到 jobId 后轮询", async () => {
    const { sb, calls } = await withFetch({ json: { entry: { id: "inc-9" }, jobId: "job-9" } });
    sb.document.getElementById("inc-q").value = "创建即深思的问题?";
    sb.document.getElementById("inc-seeds").value = "";
    await sb.CO_ENGRAM_CONTEMPLATION.create();
    expect(calls.some((c) => c.includes("POST") && c.endsWith("/api/contemplations"))).toBe(true);
  });
});

describe("过滤(多条目管理)", () => {
  it("_filterText 大小写不敏感:仅匹配条目渲染", async () => {
    const sb = execRuntime();
    sb.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      enabled: true, limit: { total: 0, max: 50, warnAt: 45 },
      items: [
        { id: "a", question: "Co-Engram 采纳率问题?", status: "done", rounds: 1, lastRunAt: null, timeline: [] },
        { id: "b", question: "安卓性能优化?", status: "done", rounds: 1, lastRunAt: null, timeline: [] },
      ],
    }) });
    await sb.CO_ENGRAM_CONTEMPLATION.setFilter("co-engram");
    const html = sb.document.getElementById("contemplation-content").innerHTML;
    expect(html).toContain("采纳率问题");
    expect(html).not.toContain("安卓性能优化");
  });
});
