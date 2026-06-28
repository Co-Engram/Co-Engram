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
    ["merges", t(language, "viewer.tab.merges")],
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
            <button class="mini" onclick="CO_ENGRAM_GRAPH.fit()" title="${t(language, "viewer.graph.toolbar.fitTitle")}">${t(language, "viewer.graph.toolbar.fit")}</button>
            <button class="mini" onclick="CO_ENGRAM_GRAPH.togglePhysics()" title="${t(language, "viewer.graph.toolbar.physicsTitle")}">${t(language, "viewer.graph.toolbar.physics")}</button>
            <button class="mini" onclick="CO_ENGRAM_GRAPH.reset()" title="${t(language, "viewer.graph.toolbar.resetTitle")}">${t(language, "viewer.graph.toolbar.reset")}</button>
          </div>

          <div class="group-title">${t(language, "viewer.graph.synapseKindsTitle")}</div>
          ${[
            {
              family: "structural",
              familyColor: "#3b82f6",
              label: t(language, "viewer.graph.familyGroupStructural"),
              desc: t(language, "viewer.graph.familyDesc.structural"),
              kinds: [
                ["extends", t(language, "enum.synapseKind.extends"), "#3b82f6", t(language, "viewer.graph.synapseDesc.extends")],
                ["part_of", t(language, "enum.synapseKind.part_of"), "#60a5fa", t(language, "viewer.graph.synapseDesc.part_of")],
                ["similar_to", t(language, "enum.synapseKind.similar_to"), "#1e40af", t(language, "viewer.graph.synapseDesc.similar_to")],
              ],
            },
            {
              family: "causal",
              familyColor: "#f97316",
              label: t(language, "viewer.graph.familyGroupCausal"),
              desc: t(language, "viewer.graph.familyDesc.causal"),
              kinds: [
                ["depends_on", t(language, "enum.synapseKind.depends_on"), "#f97316", t(language, "viewer.graph.synapseDesc.depends_on")],
                ["causes", t(language, "enum.synapseKind.causes"), "#fb923c", t(language, "viewer.graph.synapseDesc.causes")],
                ["follows", t(language, "enum.synapseKind.follows"), "#c2410c", t(language, "viewer.graph.synapseDesc.follows")],
              ],
            },
            {
              family: "evidential",
              familyColor: "#10b981",
              label: t(language, "viewer.graph.familyGroupEvidential"),
              desc: t(language, "viewer.graph.familyDesc.evidential"),
              kinds: [
                ["derives_from", t(language, "enum.synapseKind.derives_from"), "#10b981", t(language, "viewer.graph.synapseDesc.derives_from")],
                ["exemplifies", t(language, "enum.synapseKind.exemplifies"), "#6ee7b7", t(language, "viewer.graph.synapseDesc.exemplifies")],
                ["contradicts", t(language, "enum.synapseKind.contradicts"), "#ef4444", t(language, "viewer.graph.synapseDesc.contradicts")],
              ],
            },
            {
              family: "temporal",
              familyColor: "#8b5cf6",
              label: t(language, "viewer.graph.familyGroupTemporal"),
              desc: t(language, "viewer.graph.familyDesc.temporal"),
              kinds: [
                ["supersedes", t(language, "enum.synapseKind.supersedes"), "#8b5cf6", t(language, "viewer.graph.synapseDesc.supersedes")],
                ["consolidates", t(language, "enum.synapseKind.consolidates"), "#c4b5fd", t(language, "viewer.graph.synapseDesc.consolidates")],
              ],
            },
            {
              family: "modulatory",
              familyColor: "#6b7280",
              label: t(language, "viewer.graph.familyGroupModulatory"),
              desc: t(language, "viewer.graph.familyDesc.modulatory"),
              kinds: [
                ["contextualizes", t(language, "enum.synapseKind.contextualizes"), "#6b7280", t(language, "viewer.graph.synapseDesc.contextualizes")],
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

          <div class="group-title">${t(language, "viewer.graph.engramKindsTitle")}</div>
          <div class="group kind-grid">
            ${[
              ["fact", t(language, "enum.kind.fact"), "#10b981", t(language, "viewer.graph.kindDesc.fact")],
              ["observation", t(language, "enum.kind.observation"), "#3b82f6", t(language, "viewer.graph.kindDesc.observation")],
              ["pattern", t(language, "enum.kind.pattern"), "#8b5cf6", t(language, "viewer.graph.kindDesc.pattern")],
              ["procedure", t(language, "enum.kind.procedure"), "#f97316", t(language, "viewer.graph.kindDesc.procedure")],
              ["hypothesis", t(language, "enum.kind.hypothesis"), "#ef4444", t(language, "viewer.graph.kindDesc.hypothesis")],
            ]
              .map(
                ([k, label, color, desc]) =>
                  `<label title="${desc}"><input type="checkbox" checked onchange="CO_ENGRAM_GRAPH.toggleKind('${k}', event.target.checked)"><span class="swatch" style="background:${color}"></span>${label}</label>`,
              )
              .join("")}
          </div>
        </div>
        <div id="graph-canvas">
          <div class="loading">${t(language, "viewer.loading.graph")}</div>
        </div>
      </div>
    </section>

    <!-- Proposals -->
    <section class="tab-panel" data-tab="proposals">
      <div id="proposals-content"></div>
    </section>

    <!-- Merges (P4.3) -->
    <section class="tab-panel" data-tab="merges">
      <div id="merges-content"></div>
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
