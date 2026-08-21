/**
 * 首页「记忆动态」技能条目标题测试(2026-08-22)
 *
 * 背景:skill_create / skill_update 事件无 engramId/engramTitle,renderFeed 的
 * 标题兜底链全落空,动态条目只显示动作名「创建技能」,看不出创建了哪个技能。
 * 修复:标题链追加 metadata.skillId 层(技能的标题即 skillId,与 skills tab
 * 卡片/详情同名展示),并支持点击打开技能详情、同技能多条动态合并 ×N。
 *
 * 这里在 vm 中执行 TABS_RUNTIME 后直接调 renderFeed,断言生成的 HTML;
 * 并真执行 openSkillDetail,验证 showTab('skills') + CO_ENGRAM_SKILLS.open 链路。
 */
import { describe, it, expect, beforeEach } from "vitest";
import vm from "node:vm";
import { zh, en } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

// ============================================================
// mock DOM —— 与 rem-synapse-onclick-execution.test.ts 一致
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
  sandbox.navigator = { userAgent: "node-vm" };
  sandbox.location = { href: "http://localhost/", origin: "http://localhost", reload() {} };
  sandbox.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.fetch = () => Promise.reject(new Error("no fetch in vm"));
  sandbox.requestAnimationFrame = (fn: Function) => setTimeout(fn, 0);
  sandbox.cancelAnimationFrame = (h: any) => clearTimeout(h);
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

/** 生成一条 audit 条目(本机 /api/audit 返回形状) */
function entry(action: string, metadata: Record<string, unknown>, tsOffsetMin = 0): Record<string, any> {
  return {
    ts: new Date(Date.now() - tsOffsetMin * 60000).toISOString(),
    actor: "user",
    action,
    metadata,
  };
}

describe("首页记忆动态 · 技能条目标题", () => {
  const sandbox = execRuntime();
  let root: any;

  beforeEach(() => {
    root = makeEl();
    // actionLabel 恒等 stub:isolated 断言标题文本,不掺 i18n 动作名
    sandbox.CO_ENGRAM_AUDIT = { _actionLabel: (a: string) => a };
  });

  it("skill_create 条目标题 = metadata.skillId(而非动作名),且可点开技能详情", () => {
    sandbox.CO_ENGRAM.renderFeed(root, [
      entry("skill_create", { skillId: "patent-drafter", sourcePath: "skills/patent-drafter/SKILL.md" }),
    ]);
    const html = root.innerHTML as string;
    // 标题行显示 skillId
    expect(html).toContain(">patent-drafter</div>");
    // 标题可点:onclick 走 openSkillDetail
    expect(html).toContain("CO_ENGRAM.openSkillDetail('patent-drafter')");
  });

  it("skill_update 条目同样显示 skillId 标题", () => {
    sandbox.CO_ENGRAM.renderFeed(root, [
      entry("skill_update", { skillId: "meeting-minutes", patch: ["initiationSet"] }),
    ]);
    const html = root.innerHTML as string;
    expect(html).toContain(">meeting-minutes</div>");
    expect(html).toContain("CO_ENGRAM.openSkillDetail('meeting-minutes')");
  });

  it("老数据(skillId 缺失,如白名单补齐前的跨机事件)回退动作名,不抛错", () => {
    sandbox.CO_ENGRAM.renderFeed(root, [
      entry("skill_create", { sourcePath: "skills/x/SKILL.md" }),
    ]);
    const html = root.innerHTML as string;
    // 兜底链最后一层 = actionLabel(stub 恒等 → 动作名本身)
    expect(html).toContain(">skill_create</div>");
  });

  it("同 skillId 多条 skill_update 合并为 ×N(与 engram 按 engramId 去重同口径)", () => {
    sandbox.CO_ENGRAM.renderFeed(root, [
      entry("skill_update", { skillId: "patent-drafter", patch: ["initiationSet"] }, 5),
      entry("skill_update", { skillId: "patent-drafter", patch: ["visibility"] }, 3),
    ]);
    const html = root.innerHTML as string;
    expect(html).toContain("×2");
    // 只渲染一条该技能的条目
    expect(html.split("openSkillDetail('patent-drafter')").length - 1).toBe(1);
  });

  it("engram 条目回归:标题与 openEngramDetail onclick 不受影响", () => {
    sandbox.CO_ENGRAM.renderFeed(root, [
      entry("create", { title: "某条印迹标题" }, 10),
    ]);
    const html = root.innerHTML as string;
    expect(html).toContain(">某条印迹标题</div>");
    expect(html).not.toContain("openSkillDetail");
  });

  it("真执行 openSkillDetail:showTab('skills') + CO_ENGRAM_SKILLS.open(skillId)", async () => {
    let showTabCalled: string | null = null;
    let skillsOpenCalled: string | null = null;
    sandbox.CO_ENGRAM.showTab = (tab: string) => { showTabCalled = tab; };
    sandbox.CO_ENGRAM_SKILLS.open = (id: string) => { skillsOpenCalled = id; };

    sandbox.CO_ENGRAM.openSkillDetail("patent-drafter");

    expect(showTabCalled).toBe("skills");
    // setTimeout(50) 异步开抽屉,等它触发
    await new Promise((r) => setTimeout(r, 120));
    expect(skillsOpenCalled).toBe("patent-drafter");
  });
});
