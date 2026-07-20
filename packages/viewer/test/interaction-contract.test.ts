/**
 * 第 4 层回归网:交互契约(2026-07)
 *
 * 背景:dd96d13 的「三层扫描网」(i18n-ui-regression.test.ts)只覆盖渲染/翻译层——
 * 它能证明「按钮 HTML 存在 + i18n 文案存在」,但证明不了「按钮可点」。
 * 可用还需要:事件绑定 + 运行时全局挂载 + 后端 endpoint。
 *
 * 本文件补的是「交互契约」层:在 node:vm 里执行与浏览器端完全相同的
 * APP_RUNTIME + GRAPH_RUNTIME + TABS_RUNTIME(配 mock DOM),执行后断言——
 *   源码(tabs.ts / app.ts / html.ts)里每一个 onclick="MODULE.method(...)" 引用,
 *   其 MODULE 在运行时确实挂载到 window,且 method 是可调用函数。
 *
 * 这守住的 bug 类(三层网全盲):
 *   - 方法名漂移:重构改了定义名(如 gotoPage→gotoPageX),onclick 没跟上 → 死按钮
 *   - IIFE 执行失败:某个 runtime 顶层抛错,导致后续 window.CO_ENGRAM_XXX 未挂载
 *   - 挂载丢失:return 语句漏导出某方法,onclick 引用 undefined
 *   - 版本漂移期间最易复发的「点了没反应」类回归
 *
 * 设计取舍(第一性原理):
 *   - 为什么用 vm 执行而非 jsdom?项目零额外依赖(node:vm 内置),与现有
 *     i18n-ui-regression.test.ts 同构,且我们只需验证「挂载契约」而非真实点击效果。
 *   - 为什么扫源码字符串而非执行 render()?tab 内按钮的 onclick 是 render() 运行时
 *     动态生成插入 DOM 的,不在静态 HTML 里;扫 .ts 源码能覆盖全部动态按钮。
 *   - 为什么断言「运行时挂载」而非「源码里有定义」?源码有定义 ≠ 运行时挂载成功
 *     (IIFE 可能抛错、return 可能漏导出)。只有 vm 执行后的 window 状态是真相。
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zh, en } from "@co-engram/core";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";
import { APP_RUNTIME } from "../src/runtime/app.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// 浏览器内置全局(非项目代码),onclick 引用它们时无需挂载检查
const BROWSER_BUILTINS = new Set(["location", "window", "document", "history", "navigator"]);

// ============================================================
// mock DOM —— 让 runtime 顶层语句能无异常执行
// 设计:Proxy 捕获任意属性访问,方法返回 noop、DOM 查询返回空,
// 保证 IIFE / 顶层赋值 / addEventListener 不因 mock 缺失而抛错。
// 真实浏览器语义不在本测试范围(那是 e2e 的事);本测试只验「挂载契约」。
// ============================================================
function makeEl(): any {
  return new Proxy(
    { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, style: {}, hidden: false },
    {
      get(t: any, k: string) {
        if (k in t) return t[k];
        // 属性读默认 undefined;方法读返回 noop,避免「undefined is not a function」
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
  // sandbox === window(浏览器里 window===globalThis)
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

// 执行全部 runtime,返回 sandbox(其上 window.CO_ENGRAM* 已挂载)
function execRuntime(): Record<string, any> {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  // 注入顺序与 html.ts <script> 块完全一致
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

// 扫描源码,提取所有 onclick="MODULE.method(...)" 的 (MODULE, method) 对
// 覆盖静态 html.ts + 动态 tabs.ts/app.ts 生成的全部按钮
function extractOnclickRefs(): Array<{ mod: string; method: string; where: string }> {
  const files = ["runtime/tabs.ts", "runtime/app.ts", "html.ts"];
  const refs: Array<{ mod: string; method: string; where: string }> = [];
  const re = /onclick="([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const f of files) {
    const src = readFileSync(join(SRC_DIR, f), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      refs.push({ mod: m[1], method: m[2], where: f });
    }
  }
  return refs;
}

describe("第 4 层 交互契约:onclick 引用的 MODULE.method 运行时必须挂载", () => {
  // 执行一次,所有 it 共享;若顶层抛错,这个 eval 本身会在加载时失败 → 全红
  const sandbox = execRuntime();
  const refs = extractOnclickRefs();

  it("vm 执行 APP+GRAPH+TABS runtime 无异常(顶层不抛错)", () => {
    // 到这里 execRuntime 已成功;显式断言关键全局在位
    expect(typeof sandbox.CO_ENGRAM).toBe("object");
    expect(sandbox.CO_ENGRAM).not.toBeNull();
  });

  it("扫描到的 onclick 引用数 > 0(防止扫描器失效导致空通过)", () => {
    expect(refs.length, "onclick 引用为 0 → 可能扫描正则失效,测试将恒真").toBeGreaterThan(0);
  });

  it("每个 onclick 引用的 MODULE 在 window 上有挂载(非浏览器内置)", () => {
    const missing: string[] = [];
    for (const r of refs) {
      if (BROWSER_BUILTINS.has(r.mod)) continue;
      if (!sandbox[r.mod]) missing.push(`${r.where}: onclick 引用 window.${r.mod},但运行时未挂载`);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("每个 onclick 引用的 MODULE.method 是可调用函数", () => {
    const dead: string[] = [];
    for (const r of refs) {
      if (BROWSER_BUILTINS.has(r.mod)) continue;
      const mod = sandbox[r.mod];
      if (!mod) continue; // 上一条已覆盖
      const fn = mod[r.method];
      if (typeof fn !== "function") {
        dead.push(
          `${r.where}: onclick="CO_ENGRAM…${r.mod.replace("CO_ENGRAM", "")}.${r.method}(...)" → 运行时 typeof === ${typeof fn}`,
        );
      }
    }
    expect(dead, "以下 onclick 引用的方法运行时不可调用(死按钮):\n" + dead.join("\n")).toEqual([]);
  });

  // 兜底:即使未来有人加了新模块(如 CO_ENGRAM_HEALTH),只要它被 onclick 引用,
  // 上面的断言自动覆盖,无需改测试。这是「随源码扩展」的契约网。
});
