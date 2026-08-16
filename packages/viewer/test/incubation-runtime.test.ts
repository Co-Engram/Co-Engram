/**
 * 夜思实验室 runtime(vm)回归(T10 评审修复):
 * 1. conclude 错误分流 —— apiJson throw 的 message 含状态码(形如
 *    「POST /api/incubations/x/conclude → 409」):4xx = 服务端确定性失败 →
 *    concludeFailed(含状态码,长消息截断);网络失败 / 5xx / 超时 →
 *    concludePendingHint(不判死、不重试)
 * 2. 草案展开态跨 30s 轮询保留 —— toggleDraft 后 renderCard 重建 DOM 仍展开
 *
 * 附带守护:conclude 的 4xx 判定正则写在 TABS_RUNTIME(template literal)里,
 * 反斜杠若单写会被模板转义破坏(\\b→退格、\\d→d),409 用例会在此暴露。
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

/** 构造一个 active、含 2 轮 timeline(带 answerDraft)的条目(renderCard 全路径) */
function makeEntry(id = "inc-vm-1") {
  return {
    id,
    question: "vm 测试问题:夜思卡片渲染",
    status: "active",
    rounds: 2,
    timeline: [
      { round: 1, trigger: "scheduled", summaries: ["第一轮摘要"], answerDraft: "草稿一" },
      { round: 2, trigger: "manual", summaries: ["第二轮摘要"], answerDraft: "草稿二" },
    ],
  };
}

/** 跑一次 conclude,返回 (alerts, fetchCalls);fetch 行为由 status/reject 控制 */
async function runConclude(opts: {
  status?: number;
  reject?: boolean;
  confirm?: boolean;
  id?: string;
}): Promise<{ alerts: string[]; fetchCalls: number }> {
  const sandbox = execRuntime();
  const alerts: string[] = [];
  let fetchCalls = 0;
  sandbox.alert = (m: string) => alerts.push(m);
  sandbox.confirm = () => opts.confirm ?? true;
  sandbox.fetch = async () => {
    fetchCalls += 1;
    if (opts.reject) throw new TypeError("fetch failed");
    const status = opts.status ?? 500;
    return { ok: status < 400, status, json: async () => ({}) };
  };
  await sandbox.CO_ENGRAM_INCUBATIONS.conclude(opts.id ?? "inc-1");
  return { alerts, fetchCalls };
}

const CONCLUDE_FAILED = zh["viewer.incubations.concludeFailed"];
const CONCLUDE_PENDING = zh["viewer.incubations.concludePendingHint"];

describe("conclude 错误分流(T10 评审:4xx 确定性失败不再提示「后台进行中」)", () => {
  it("409(in-flight 锁)→ concludeFailed,含状态码,非 pendingHint", async () => {
    const { alerts } = await runConclude({ status: 409 });
    const expected = CONCLUDE_FAILED.replace(
      "${msg}",
      "POST /api/incubations/inc-1/conclude → 409",
    );
    expect(alerts).toEqual([expected]);
    expect(alerts[0]).not.toBe(CONCLUDE_PENDING);
  });

  it("400(参数非法)同样走 concludeFailed(4xx 全类)", async () => {
    const { alerts } = await runConclude({ status: 400 });
    expect(alerts[0]).toContain("收束失败");
    expect(alerts[0]).toContain("400");
  });

  it("超长 message 截断到 120 字符 + 省略号", async () => {
    const longId = "x".repeat(200);
    const { alerts } = await runConclude({ status: 409, id: longId });
    const raw = `POST /api/incubations/${longId}/conclude → 409`;
    const expected = CONCLUDE_FAILED.replace(
      "${msg}",
      raw.slice(0, 120) + "…",
    );
    expect(alerts).toEqual([expected]);
  });

  it("网络失败(fetch reject)→ 保留 pendingHint(不判死、不重试)", async () => {
    const { alerts } = await runConclude({ reject: true });
    expect(alerts).toEqual([CONCLUDE_PENDING]);
  });

  it("5xx(502)→ 服务端异常但非确定性失败,保留 pendingHint", async () => {
    const { alerts } = await runConclude({ status: 502 });
    expect(alerts).toEqual([CONCLUDE_PENDING]);
  });

  it("confirm 取消 → 不发请求、不弹窗", async () => {
    const { alerts, fetchCalls } = await runConclude({ status: 409, confirm: false });
    expect(alerts).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});

describe("草案展开态跨 30s 轮询保留(T10 评审)", () => {
  /** renderCard 输出中草案区 div 的开标签(含 hidden 与否) */
  function draftsOpenTag(sandbox: Record<string, any>, entry: ReturnType<typeof makeEntry>): string {
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(entry) as string;
    const m = html.match(new RegExp(`id="inc-drafts-${entry.id}"[^>]*>`));
    if (!m) throw new Error("renderCard 输出中未找到草案区 div 开标签");
    return m[0] ?? "";
  }

  it("默认收起(hidden)", () => {
    const sandbox = execRuntime();
    expect(draftsOpenTag(sandbox, makeEntry())).toBe(
      'id="inc-drafts-inc-vm-1" hidden>',
    );
  });

  it("展开 → 模拟 30s 轮询 re-render(renderCard 重建)→ 仍可见", () => {
    const sandbox = execRuntime();
    const entry = makeEntry();
    sandbox.CO_ENGRAM_INCUBATIONS.toggleDraft(entry.id);
    // 30s 轮询走 render() → 整卡 innerHTML 重建 → renderCard 重新输出:
    // 展开态必须由 _expandedDrafts 恢复,否则被打回 hidden
    expect(draftsOpenTag(sandbox, entry)).toBe('id="inc-drafts-inc-vm-1">');
  });

  it("展开后再 toggle → 收起(hidden)", () => {
    const sandbox = execRuntime();
    const entry = makeEntry();
    sandbox.CO_ENGRAM_INCUBATIONS.toggleDraft(entry.id);
    sandbox.CO_ENGRAM_INCUBATIONS.toggleDraft(entry.id);
    expect(draftsOpenTag(sandbox, entry)).toBe(
      'id="inc-drafts-inc-vm-1" hidden>',
    );
  });

  it("展开态按条目隔离:A 展开不影响 B", () => {
    const sandbox = execRuntime();
    const a = makeEntry("inc-a");
    const b = makeEntry("inc-b");
    sandbox.CO_ENGRAM_INCUBATIONS.toggleDraft("inc-a");
    expect(draftsOpenTag(sandbox, a)).toBe('id="inc-drafts-inc-a">');
    expect(draftsOpenTag(sandbox, b)).toBe('id="inc-drafts-inc-b" hidden>');
  });
});

// ============================================================
// T17(2026-08-17 第二批):暂停/恢复/删除按钮、待裁决引导、过滤与折叠、
// trace 展示、排程 chip 悬停、提案页已删条目守护
// ============================================================
const PAUSE_BTN = zh["viewer.incubations.pauseBtn"];
const RESUME_BTN = zh["viewer.incubations.resumeBtn"];
const GUIDANCE = zh["viewer.incubations.resolveGuidance"];

/** 挂 fetch(返回指定 items)→ 跑一次 render → 返回 incubations-content 的 innerHTML */
async function renderList(
  sandbox: Record<string, any>,
  items: unknown[],
): Promise<string> {
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ enabled: true, scheduler: { alive: false }, items }),
  });
  const root = sandbox.document.getElementById("incubations-content");
  await sandbox.CO_ENGRAM_INCUBATIONS.render(root);
  return String(root.innerHTML);
}

/** 指定状态的条目(makeEntry 轻量扩展,不动共用 fixture) */
function entryAs(status: string, id = `inc-${status}`): ReturnType<typeof makeEntry> {
  return { ...makeEntry(id), status };
}

describe("T17:卡片动作按钮(暂停/恢复/删除 + 待裁决引导)", () => {
  it("active 条目:暂停与删除可点,无恢复按钮", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(makeEntry("inc-btn-a")) as string;
    expect(html).toContain("CO_ENGRAM_INCUBATIONS.pause('inc-btn-a')");
    expect(html).toContain("CO_ENGRAM_INCUBATIONS.remove('inc-btn-a')");
    expect(html).toContain("⏸ " + PAUSE_BTN);
    expect(html).not.toContain(RESUME_BTN);
  });

  it("paused 条目:恢复走 resolve(id,false);无暂停按钮;删除仍可用", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(entryAs("paused", "inc-btn-p")) as string;
    expect(html).toContain("CO_ENGRAM_INCUBATIONS.resolve('inc-btn-p', false)");
    expect(html).toContain("▶ " + RESUME_BTN);
    expect(html).not.toContain("CO_ENGRAM_INCUBATIONS.pause(");
    expect(html).toContain("CO_ENGRAM_INCUBATIONS.remove('inc-btn-p')");
  });

  it("suggested-resolve 条目:待裁决引导 chip + 暂停可用", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(
      entryAs("suggested-resolve", "inc-btn-s"),
    ) as string;
    expect(html).toContain("inc-guidance");
    expect(html).toContain(GUIDANCE);
    expect(html).toContain("CO_ENGRAM_INCUBATIONS.pause('inc-btn-s')");
  });

  it("in-flight 条目:立即夜思/暂停/删除三按钮均置灰(无 onclick,带 inFlightTip)", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(
      entryAs("in-flight", "inc-btn-f"),
    ) as string;
    expect((html.match(/disabled title=/g) ?? []).length).toBe(3);
    expect(html).not.toContain("CO_ENGRAM_INCUBATIONS.pause(");
    expect(html).not.toContain("CO_ENGRAM_INCUBATIONS.remove(");
  });

  it("active 条目排程 chip 带 scheduleChipTip 悬停(单次执行语义)", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(makeEntry("inc-tip")) as string;
    expect(html).toContain('title="' + zh["viewer.incubations.scheduleChipTip"] + '"');
  });
});

describe("T17:删除确认与请求(confirm 二次确认)", () => {
  async function runRemove(confirm: boolean): Promise<string[]> {
    const sandbox = execRuntime();
    const calls: string[] = [];
    sandbox.confirm = () => confirm;
    sandbox.fetch = async (url: unknown, opts: { method?: string } | undefined) => {
      calls.push(`${(opts && opts.method) || "GET"} ${String(url)}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await sandbox.CO_ENGRAM_INCUBATIONS.remove("inc-del-1");
    return calls;
  }

  it("confirm 取消 → 不发任何请求", async () => {
    expect(await runRemove(false)).toEqual([]);
  });

  it("confirm 确认 → POST :id/delete(成功后 re-render 再拉列表)", async () => {
    const calls = await runRemove(true);
    expect(calls[0]).toBe("POST /api/incubations/inc-del-1/delete");
    expect(calls.some((c) => c.endsWith("/api/incubations"))).toBe(true);
  });

  it("pause() → POST :id/pause", async () => {
    const sandbox = execRuntime();
    const calls: string[] = [];
    sandbox.fetch = async (url: unknown, opts: { method?: string } | undefined) => {
      calls.push(`${(opts && opts.method) || "GET"} ${String(url)}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await sandbox.CO_ENGRAM_INCUBATIONS.pause("inc-pz-1");
    expect(calls[0]).toBe("POST /api/incubations/inc-pz-1/pause");
  });
});

describe("T17:条目过滤(多条目管理,前端 filter)", () => {
  const TWO = [
    { ...makeEntry("inc-f-a"), question: "分布式团队如何避免知识孤岛" },
    { ...makeEntry("inc-f-b"), question: "Algorithm 优化路径分析" },
  ];

  it("过滤框渲染存在;无过滤词全量渲染", async () => {
    const sandbox = execRuntime();
    const html = await renderList(sandbox, TWO);
    expect(html).toContain('id="inc-filter"');
    expect(html).toContain("分布式团队如何避免知识孤岛");
    expect(html).toContain("Algorithm 优化路径分析");
  });

  it("_filterText 大小写不敏感:仅匹配条目渲染", async () => {
    const sandbox = execRuntime();
    sandbox.CO_ENGRAM_INCUBATIONS._filterText = "algorithm";
    const html = await renderList(sandbox, TWO);
    expect(html).not.toContain("分布式团队");
    expect(html).toContain("Algorithm 优化路径分析");
  });

  it("过滤无匹配 → filterNoMatch 空态(而非全量)", async () => {
    const sandbox = execRuntime();
    sandbox.CO_ENGRAM_INCUBATIONS._filterText = "不存在的关键词xyz";
    const html = await renderList(sandbox, TWO);
    expect(html).toContain(zh["viewer.incubations.filterNoMatch"]);
  });

  it("setFilter:存值并 re-render(过滤立即生效)", async () => {
    const sandbox = execRuntime();
    await renderList(sandbox, TWO);
    await sandbox.CO_ENGRAM_INCUBATIONS.setFilter("分布式");
    const html = String(
      sandbox.document.getElementById("incubations-content").innerHTML,
    );
    expect(sandbox.CO_ENGRAM_INCUBATIONS._filterText).toBe("分布式");
    expect(html).toContain("分布式团队");
    expect(html).not.toContain("Algorithm");
  });
});

describe("T17:活跃区折叠(默认只展开前 5 条)", () => {
  it("8 个 active:8 张卡全渲染,其余 3 条进折叠", async () => {
    const sandbox = execRuntime();
    const items = Array.from({ length: 8 }, (_, i) => makeEntry(`inc-fold-${i}`));
    const html = await renderList(sandbox, items);
    expect((html.match(/class="card inc-card"/g) ?? []).length).toBe(8);
    expect(html).toContain('class="inc-fold"');
    expect(html).toContain(
      zh["viewer.incubations.activeFoldSummary"].replace("${n}", "3"),
    );
  });

  it("恰好 5 个 active:不出现折叠", async () => {
    const sandbox = execRuntime();
    const items = Array.from({ length: 5 }, (_, i) => makeEntry(`inc-flat-${i}`));
    const html = await renderList(sandbox, items);
    expect(html).not.toContain('class="inc-fold"');
  });
});

describe("T17:timeline trace 展示(旧轮无字段不渲染)", () => {
  it("带 trace 数组的轮次:折叠列表逐条展示", () => {
    const sandbox = execRuntime();
    const entry = {
      ...makeEntry("inc-tr-1"),
      timeline: [
        {
          round: 1,
          trigger: "scheduled",
          summaries: ["第一轮摘要"],
          trace: ["plan: build protocol", "retrieve: read graph"],
        },
      ],
    };
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(entry) as string;
    expect(html).toContain(zh["viewer.incubations.traceSummary"].replace("${n}", "2"));
    expect(html).toContain("plan: build protocol");
    expect(html).toContain("retrieve: read graph");
  });

  it("旧轮无 trace 字段:不渲染轨迹块", () => {
    const sandbox = execRuntime();
    const html = sandbox.CO_ENGRAM_INCUBATIONS.renderCard(makeEntry()) as string;
    expect(html).not.toContain("执行轨迹");
  });
});

describe("T17:提案页已删条目守护(moon-chip 纯展示,不查条目)", () => {
  it("payload.incubationId 指向已删除条目:渲染不抛错,moon-chip 正常出现", () => {
    const sandbox = execRuntime();
    sandbox.CO_ENGRAM._proposalsPager = {
      getItems: () => [
        {
          entityId: "insight-ghost-inc",
          source: "rem-insight",
          status: "pending",
          occurrences: 1,
          sampleQuotes: [],
          centroidExcerpt: "",
          payload: {
            incubationId: "inc-deleted-x",
            insightMode: "integration",
            criticScore: 0.82,
            kind: "fact",
            title: "已删条目产出的洞察",
            summary: "条目已删,提案仍在",
          },
        },
      ],
      getTotal: () => 1,
      hasMore: () => false,
      getLastResponse: () => ({ statusCounts: {} }),
    };
    const root = sandbox.document.getElementById("proposals-content");
    // _render 尾部的卡片挂载查询:makeEl Proxy 对未定义方法返回 undefined,
    // 需显式 stub 成空数组(真实 DOM 里 querySelectorAll 恒返回 NodeList)
    root.querySelectorAll = () => [];
    expect(() => sandbox.CO_ENGRAM_PROPOSALS._render()).not.toThrow();
    const html = String(root.innerHTML);
    expect(html).toContain("moon-chip");
    expect(html).toContain("insight-ghost-inc");
  });
});

describe("T17 评审 P0 修复:过滤框焦点保持(render 全量重建后恢复焦点与光标)", () => {
  /** 拦截 getElementById('inc-filter') 返回可观察 input,记录 focus/setSelectionRange 调用 */
  function observeFilterInput(sandbox: Record<string, any>): {
    focusCalls: number[];
    selCalls: number[];
  } {
    const focusCalls: number[] = [];
    const selCalls: number[] = [];
    const realGet = sandbox.document.getElementById.bind(sandbox.document);
    sandbox.document.getElementById = (id: string) => {
      if (id === "inc-filter") {
        return {
          focus: () => focusCalls.push(1),
          setSelectionRange: (a: number) => selCalls.push(a),
          value: "",
        };
      }
      return realGet(id);
    };
    return { focusCalls, selCalls };
  }

  it("render 时 inc-filter 聚焦中 → 重建后 focus + 光标位恢复(IME 不被打断的前提)", async () => {
    const sandbox = execRuntime();
    // 旧 input(聚焦中,光标在第 3 位)= render 读取的 activeElement
    sandbox.document.activeElement = { id: "inc-filter", selectionStart: 3 };
    const { focusCalls, selCalls } = observeFilterInput(sandbox);
    await renderList(sandbox, [makeEntry("inc-focus-1")]);
    expect(focusCalls.length).toBeGreaterThanOrEqual(1);
    expect(selCalls[0]).toBe(3);
  });

  it("非过滤框聚焦(无焦点)→ 不抢焦点", async () => {
    const sandbox = execRuntime();
    sandbox.document.activeElement = undefined;
    const { focusCalls } = observeFilterInput(sandbox);
    await renderList(sandbox, [makeEntry("inc-focus-2")]);
    expect(focusCalls).toEqual([]);
  });
});
