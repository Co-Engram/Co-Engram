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
