/**
 * 印迹 tab 新鲜度过滤 + 翻页基数回归测试(2026-08-20)
 *
 * 背景:用户报「记忆印迹中新鲜度按钮的功能不正常」。根因:applyFilter 的
 * 翻页控件(totalPages / pageInfo / 页码按钮)以 server 全库 total 为基数,
 * 而 tab 内过滤(新鲜度/kind/visibility/搜索/path:)全是 client-side ——
 * 过滤激活时页码虚高(如 week 命中 33 条却显示 3 页/104 条),越界页码
 * 点击被 maxStart clamp 静默吞掉,表现为「点击无反应」。
 *
 * 修复:翻页基数改为 filtered.length;dormant 档排除 lastRetrievedAt=null
 * (从未取用不算「沉睡」,否则刚创建未被检索的新记忆误入沉睡列表)。
 *
 * 本测试用 vm 执行真实 TABS_RUNTIME + mock DOM/pager,覆盖:
 * 1. 过滤后 totalPages/pageInfo 基于命中数,虚页码不再渲染
 * 2. 无过滤时页码按全量渲染(旧行为中唯一正确的一半)
 * 3. dormant 语义:null 排除、>30 天命中、<30 天排除
 * 4. week/month 时间边界数值
 * 5. gotoPage 越界 clamp 安全(不抛错、viewStart 合法)
 * 6. 过滤无命中 → 空态
 */
import { describe, it, expect, beforeEach } from "vitest";
import vm from "node:vm";
import { zh, en } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

const DAY = 86400000;

function makeEl(id = ""): any {
  const el: any = {
    dataset: {},
    style: {},
    hidden: false,
    innerHTML: "",
    textContent: "",
    tagName: "DIV",
    id,
    className: "",
    value: "",
    disabled: false,
    children: [],
    classList: {
      _set: new Set<string>(),
      add(c: string) { el.classList._set.add(c); },
      remove(c: string) { el.classList._set.delete(c); },
      toggle(c: string, f?: boolean) {
        const has = el.classList._set.has(c);
        const force = f === undefined ? !has : f;
        if (force) el.classList._set.add(c); else el.classList._set.delete(c);
      },
      contains(c: string) { return el.classList._set.has(c); },
    },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(child: any) { el.children.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    remove() {},
  };
  return el;
}

/** 构造 EngramQueryRow 形状的测试数据(时间字段一律 epoch ms,与 API 一致) */
function row(overrides: Record<string, any>) {
  const now = Date.now();
  return {
    id: "e-" + Math.random().toString(36).slice(2, 8),
    title: "记忆",
    kind: "fact",
    importance: 0.5,
    confidence: 0.8,
    updatedAt: now,
    createdAt: now,
    contentSize: 100,
    domainTagsCsv: "测试",
    createdBy: "tester",
    verificationStatus: null,
    lastRetrievedAt: null,
    synapseCount: 0,
    visibility: "public",
    status: "active",
    summary: "摘要",
    retrievalCount: 0,
    ...overrides,
  };
}

function makeSandbox() {
  const idMap: Record<string, any> = {};
  const body = makeEl("engrams-body");
  const count = makeEl("engrams-count");
  const q = makeEl("engrams-q");
  const kind = makeEl("engrams-kind");
  const visibility = makeEl("engrams-visibility");
  const freshness = makeEl("engrams-freshness");
  const sort = makeEl("engrams-sort");
  sort.value = "createdAt-desc";
  Object.assign(idMap, {
    "engrams-body": body,
    "engrams-count": count,
    "engrams-q": q,
    "engrams-kind": kind,
    "engrams-visibility": visibility,
    "engrams-freshness": freshness,
    "engrams-sort": sort,
  });

  const doc = {
    getElementById(id: string) { return idMap[id] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag: string) { return makeEl(tag); },
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
  sandbox.navigator = { userAgent: "node-vm" };
  sandbox.location = { href: "http://localhost/", origin: "http://localhost" };
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.console = console;
  // applyFilter/_trend 用 Date.now;vm 上下文无宿主全局,显式透传
  sandbox.Date = Date;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.Number = Number;
  sandbox.String = String;
  sandbox.isNaN = isNaN;
  sandbox.setTimeout = (fn: Function) => { return 0; };
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.fetch = () => Promise.reject(new Error("no fetch in vm"));
  sandbox.requestAnimationFrame = (fn: Function) => setTimeout(fn, 0);

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

  return { sandbox, idMap, body, count, freshness, q };
}

/** 注入 pager mock:items 为已加载集合,total 为 server 全库总量 */
function injectPager(sandbox: any, items: any[], total: number, hasMore = false) {
  sandbox.CO_ENGRAM._engramsPager = {
    getItems: () => items,
    getTotal: () => total,
    hasMore: () => hasMore,
    isLoading: () => false,
    load: async () => {},
    loadMore: async () => {},
  };
  sandbox.CO_ENGRAM._engramsTotal = total;
}

/** navRow = body.children 里最后一个 appendChild 的元素(pager-nav) */
function navRow(body: any) {
  return body.children[body.children.length - 1];
}

describe("印迹 tab 过滤 × 翻页基数(2026-08-20 修复回归)", () => {
  let ctx: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    ctx = makeSandbox();
  });

  it("过滤激活时:pageInfo/页码基于命中数,虚页码不渲染", () => {
    const now = Date.now();
    // 33 条 week 命中 + 71 条老数据 = 104 条全库(复现用户场景)
    const items = [
      ...Array.from({ length: 33 }, (_, i) => row({ id: "w" + i, title: "本周" + i, createdAt: now - 2 * DAY })),
      ...Array.from({ length: 71 }, (_, i) => row({ id: "o" + i, title: "老记忆" + i, createdAt: now - 60 * DAY })),
    ];
    injectPager(ctx.sandbox, items, 104);
    ctx.freshness.value = "week";

    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();

    const nav = navRow(ctx.body);
    // 修复前:第 1 / 3 页(共 104 条);修复后:第 1 / 1 页(共 33 条)
    expect(nav.innerHTML).toContain("第 1 / 1 页(共 33 条)");
    // 虚页码 2/3 不再渲染(其 onclick 是 gotoPage(1)/gotoPage(2))
    expect(nav.innerHTML).not.toContain("gotoPage");
    // 卡片全部来自命中集
    expect(ctx.body.innerHTML).toContain("本周0");
    expect(ctx.body.innerHTML).not.toContain("老记忆0");
  });

  it("无过滤时:页码按已加载全量渲染(多页可点)", () => {
    const now = Date.now();
    const items = Array.from({ length: 75 }, (_, i) => row({ id: "a" + i, title: "条目" + i }));
    injectPager(ctx.sandbox, items, 75);
    ctx.freshness.value = "";

    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();

    const nav = navRow(ctx.body);
    expect(nav.innerHTML).toContain("第 1 / 2 页(共 75 条)");
    // 页码 2 可点(onclick gotoPage(1))
    expect(nav.innerHTML).toContain("gotoPage(1)");
  });

  it("dormant:排除从未取用(null),命中 >30 天未取用", () => {
    const now = Date.now();
    const items = [
      row({ id: "d-null", title: "从未取用的新记忆", createdAt: now - 1 * DAY, lastRetrievedAt: null }),
      row({ id: "d-old", title: "真沉睡", createdAt: now - 90 * DAY, lastRetrievedAt: now - 40 * DAY }),
      row({ id: "d-recent", title: "活跃记忆", createdAt: now - 90 * DAY, lastRetrievedAt: now - 3 * DAY }),
    ];
    injectPager(ctx.sandbox, items, 3);
    ctx.freshness.value = "dormant";

    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();

    // 修复前:null → idle=Infinity 误入「沉睡」
    expect(ctx.body.innerHTML).toContain("真沉睡");
    expect(ctx.body.innerHTML).not.toContain("从未取用的新记忆");
    expect(ctx.body.innerHTML).not.toContain("活跃记忆");
    expect(navRow(ctx.body).innerHTML).toContain("共 1 条");
  });

  it("week/month 时间边界:6/8/29/31 天归属正确", () => {
    const now = Date.now();
    const items = [
      row({ id: "b-6d", title: "六天前", createdAt: now - 6 * DAY }),
      row({ id: "b-8d", title: "八天前", createdAt: now - 8 * DAY }),
      row({ id: "b-29d", title: "廿九天前", createdAt: now - 29 * DAY }),
      row({ id: "b-31d", title: "卅一天前", createdAt: now - 31 * DAY }),
    ];
    injectPager(ctx.sandbox, items, 4);

    ctx.freshness.value = "week";
    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();
    expect(ctx.body.innerHTML).toContain("六天前");
    expect(ctx.body.innerHTML).not.toContain("八天前");

    ctx.freshness.value = "month";
    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();
    expect(ctx.body.innerHTML).toContain("六天前"); // month 含 30 天内全部
    expect(ctx.body.innerHTML).toContain("八天前");
    expect(ctx.body.innerHTML).toContain("廿九天前");
    expect(ctx.body.innerHTML).not.toContain("卅一天前");
  });

  it("过滤无命中 → 空态而非崩溃", () => {
    const items = [row({ id: "x1", title: "仅一条", createdAt: Date.now() - 90 * DAY, lastRetrievedAt: Date.now() - 1 * DAY })];
    injectPager(ctx.sandbox, items, 1);
    ctx.freshness.value = "dormant";

    ctx.sandbox.CO_ENGRAM_ENGRAMS.applyFilter();

    expect(ctx.body.innerHTML).toContain("empty");
  });

  it("gotoPage 越界:clamp 安全,不抛错且 viewStart 合法", async () => {
    const items = Array.from({ length: 3 }, (_, i) => row({ id: "g" + i, title: "命中" + i, createdAt: Date.now() - i * DAY }));
    injectPager(ctx.sandbox, items, 3);
    ctx.freshness.value = "week";

    await expect(ctx.sandbox.CO_ENGRAM_ENGRAMS.gotoPage(5)).resolves.toBeUndefined();
    expect(ctx.sandbox.CO_ENGRAM._engramsViewStart).toBe(0);
  });
});
