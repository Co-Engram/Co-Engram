/**
 * Co-Engram Viewer v2 SPA HTML
 *
 * 拼装骨架 HTML + styles.ts(CSS)+ vendor(vis-network 内联)+
 * runtime/{app,graph,tabs}.ts(浏览器端 JS)。
 *
 * 各 tab 通过 CO_ENGRAM.on(name, fn) 注册渲染函数,在 showTab() 切换时调用。
 * 整页不依赖任何外部 CDN(Alpine/htmx 已移除),完全离线可用。
 *
 * @module @co-engram/claude-code/viewer
 */

import { t, zh, en, DEFAULT_LANGUAGE, type Language } from "@co-engram/core";
import { VIEWER_CSS } from "./styles.js";
import { VIS_NETWORK_SOURCE } from "./vendor/vis-network-source.js";
import { MARKED_SOURCE } from "./vendor/marked-source.js";
import { DOMPURIFY_SOURCE } from "./vendor/dompurify-source.js";
import { I18N_RUNTIME } from "./runtime/i18n.js";
import { DECAY_RUNTIME } from "./runtime/decay.js";
import { APP_RUNTIME } from "./runtime/app.js";
import { GRAPH_RUNTIME } from "./runtime/graph.js";
import { TABS_RUNTIME } from "./runtime/tabs.js";
import {
  COENGRAMLOGO_SVG,
  COENGRAMLOGODARK_SVG,
  COENGRAMFAVICON_SVG,
} from "./brand-logos.js";

export interface SpaHtmlOptions {
  /** 是否要求 token 认证 */
  readonly tokenRequired?: boolean;
  /** UI 语言(默认 en) */
  readonly language?: Language;
}

/** 渲染完整 SPA HTML */
export function renderSpaHtml(options: SpaHtmlOptions = {}): string {
  const language = options.language ?? DEFAULT_LANGUAGE;
  const title = t(language, "viewer.title");
  const slogan = t(language, "viewer.slogan");
  const footer = t(language, "viewer.footer");

  const searchPlaceholder = t(language, "viewer.search.placeholder");
  const searchBtn = t(language, "viewer.search.button");
  const searchClearBtn = t(language, "viewer.search.clear");
  const searchClearTitle = t(language, "viewer.search.clear_title");
  const authPrompt = options.tokenRequired
    ? t(language, "viewer.auth.prompt")
    : "";
  const authPlaceholder = t(language, "viewer.auth.placeholder");

  const tabs = [
    ["stats", t(language, "viewer.tab.stats")],
    ["engrams", t(language, "viewer.tab.engrams")],
    ["graph", t(language, "viewer.tab.graph")],
    ["proposals", t(language, "viewer.tab.proposals")],
    ["audit", t(language, "viewer.tab.audit")],
    ["trash", t(language, "viewer.tab.trash")],
    ["config", t(language, "viewer.tab.config")],
    ["help", t(language, "viewer.tab.help")],
  ] as const;

  const tabButtons = tabs
    .map(
      ([id, label]) => `<button data-tab="${id}" class="tab">${label}</button>`,
    )
    .join("\n      ");

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="color-scheme" content="light dark">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(COENGRAMFAVICON_SVG)}">
  <style>${VIEWER_CSS}</style>
  <script>${VIS_NETWORK_SOURCE}</script>
  <script>${MARKED_SOURCE}</script>
  <script>${DOMPURIFY_SOURCE}</script>
</head>
<body>
  <header class="app-header">
    <div class="brand">
      <span class="brand-logo brand-logo-light" aria-hidden="true">${COENGRAMLOGO_SVG}</span>
      <span class="brand-logo brand-logo-dark" aria-hidden="true">${COENGRAMLOGODARK_SVG}</span>
      <div class="brand-text">
        <h1>${title}</h1>
        <span class="brand-slogan">${slogan}</span>
      </div>
    </div>
    <nav>
      ${tabButtons}
    </nav>
    ${
      options.tokenRequired
        ? `<div class="auth-bar">${authPrompt} <input id="token-input" type="password" placeholder="${authPlaceholder}"/></div>`
        : ""
    }
  </header>

  <main>
    <!-- Stats -->
    <section class="tab-panel" data-tab="stats">
      <!-- Search bar 仅在 stats tab 显示 -->
      <form id="search-form" class="search-bar">
        <input id="search-input" type="text" name="q" placeholder="${searchPlaceholder}" autocomplete="off"/>
        <button type="submit">${searchBtn}</button>
        <button type="button" id="search-clear" title="${searchClearTitle}" onclick="CO_ENGRAM.clearSearch()">${searchClearBtn}</button>
      </form>
      <div id="search-results" class="panel" style="margin-bottom:1.5rem;display:none"></div>
      <div id="stats-content"></div>
    </section>

    <!-- Engrams -->
    <section class="tab-panel" data-tab="engrams">
      <div id="engrams-content"></div>
    </section>

    <!-- Graph -->
    <section class="tab-panel" data-tab="graph">
      <div class="graph-container">
        <div class="graph-toolbar">
          <div class="toolbar-actions">
            <button class="mini" onclick="CO_ENGRAM_GRAPH.fit()" title="适应视图:自动缩放并居中,让所有节点都可见">适应视图</button>
            <button class="mini" onclick="CO_ENGRAM_GRAPH.togglePhysics()" title="物理引擎:开启时节点按弹簧/斥力模型自动布局(会消耗 CPU 直到稳定);关闭时冻结当前位置,适合大图稳定后浏览">物理引擎</button>
            <button class="mini" onclick="CO_ENGRAM_GRAPH.reset()" title="重置过滤:恢复所有类型/族勾选,并重新适应视图">重置过滤</button>
          </div>

          <div class="group-title">突触类型 · 按族分类</div>
          ${[
            {
              family: "structural",
              familyColor: "#3b82f6",
              label: "结构族",
              desc: "描述知识间的组成/扩展关系",
              kinds: [
                [
                  "extends",
                  "扩展",
                  "#3b82f6",
                  "A 在 B 基础上扩展,继承 B 的语义并新增维度",
                ],
                ["part_of", "部分", "#60a5fa", "A 是 B 的组成部分(B has-a A)"],
                [
                  "similar_to",
                  "相似",
                  "#1e40af",
                  "A 与 B 语义相近,可互换或互援",
                ],
              ],
            },
            {
              family: "causal",
              familyColor: "#f97316",
              label: "因果族",
              desc: "描述触发/依赖关系",
              kinds: [
                [
                  "depends_on",
                  "依赖",
                  "#f97316",
                  "A 的成立依赖 B(B 是 A 的前置条件)",
                ],
                ["causes", "导致", "#fb923c", "A 触发或产生 B(正向因果)"],
                [
                  "follows",
                  "顺承",
                  "#c2410c",
                  "A 在时间/逻辑上跟随 B(无强因果)",
                ],
              ],
            },
            {
              family: "evidential",
              familyColor: "#10b981",
              label: "证据族",
              desc: "描述来源/冲突关系",
              kinds: [
                [
                  "derives_from",
                  "派生",
                  "#10b981",
                  "A 从 B 推导而来(B 是依据)",
                ],
                ["exemplifies", "例证", "#6ee7b7", "A 是 B 的具体实例/样本"],
                [
                  "contradicts",
                  "矛盾",
                  "#ef4444",
                  "A 与 B 相互冲突,进入裁决流程",
                ],
              ],
            },
            {
              family: "temporal",
              familyColor: "#8b5cf6",
              label: "时间族",
              desc: "描述版本/演化关系",
              kinds: [
                ["supersedes", "取代", "#8b5cf6", "A 取代过时的 B(版本更迭)"],
                ["consolidates", "整合", "#c4b5fd", "A 合并/精炼了 B 的内容"],
              ],
            },
            {
              family: "modulatory",
              familyColor: "#6b7280",
              label: "调节族",
              desc: "描述情境上下文关系",
              kinds: [
                [
                  "contextualizes",
                  "上下文",
                  "#6b7280",
                  "A 为 B 提供情境背景(非因果、非证据)",
                ],
              ],
            },
          ]
            .map(
              (group) => `
            <fieldset class="family-group">
              <legend title="${group.desc}"><span class="family-dot" style="background:${group.familyColor}"></span>${group.label}</legend>
              <div class="family-kinds">
                ${group.kinds
                  .map(
                    ([id, label, color, desc]) =>
                      `<label title="${desc}"><input type="checkbox" checked onchange="CO_ENGRAM_GRAPH.toggleSynapseKind('${id}', event.target.checked)"><span class="swatch" style="background:${color}"></span>${label}</label>`,
                  )
                  .join("")}
              </div>
            </fieldset>
          `,
            )
            .join("")}

          <div class="group-title">记忆印迹类型</div>
          <div class="group kind-grid">
            ${[
              ["fact", "事实", "#10b981", "被确认成立、可独立验证的客观陈述"],
              [
                "observation",
                "观察",
                "#3b82f6",
                "一次性感知到的事实,可能尚未沉淀为稳定结论",
              ],
              [
                "pattern",
                "模式",
                "#8b5cf6",
                "从多次观察归纳出的规律,可预测未来行为",
              ],
              ["procedure", "流程", "#f97316", "步骤序列,执行后可复现某结果"],
              [
                "hypothesis",
                "假设",
                "#ef4444",
                "待验证的猜测;在反例出现前可作工作假设",
              ],
            ]
              .map(
                ([k, label, color, desc]) =>
                  `<label title="${desc}"><input type="checkbox" checked onchange="CO_ENGRAM_GRAPH.toggleKind('${k}', event.target.checked)"><span class="swatch" style="background:${color}"></span>${label}</label>`,
              )
              .join("")}
          </div>
        </div>
        <div id="graph-canvas">
          <div class="loading">加载图谱中...</div>
        </div>
      </div>
    </section>

    <!-- Proposals -->
    <section class="tab-panel" data-tab="proposals">
      <div id="proposals-content"></div>
    </section>

    <!-- Audit -->
    <section class="tab-panel" data-tab="audit">
      <div id="audit-content"></div>
    </section>

    <!-- Trash -->
    <section class="tab-panel" data-tab="trash">
      <div id="trash-content"></div>
    </section>

    <!-- Config -->
    <section class="tab-panel" data-tab="config">
      <div id="config-content"></div>
    </section>

    <!-- Help -->
    <section class="tab-panel" data-tab="help">
      <div id="help-content"></div>
    </section>
  </main>

  <!-- Detail drawer (right side) -->
  <aside id="detail-drawer" class="drawer">
    <button class="drawer-close" aria-label="Close">✕</button>
    <div class="drawer-body"></div>
  </aside>

  <footer class="app-footer">
    <small>${footer}</small>
  </footer>

  <script>
    window.CO_ENGRAM_I18N = ${JSON.stringify({ zh, en })};
    window.CO_ENGRAM_LANG = ${JSON.stringify(language)};
    ${I18N_RUNTIME}
    ${DECAY_RUNTIME}
    ${APP_RUNTIME}
    ${GRAPH_RUNTIME}
    ${TABS_RUNTIME}
  </script>
</body>
</html>`;
}
