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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 读取构建时间(scripts/gen-build-info.mjs 在 build 后写入 dist/build-info.json)。
 * 随 dist 部署,跨 cp 仍准(比读 mtime 可靠)。文件缺失(如直接跑 src 未 build)→ "unknown"。
 * 模块级缓存,只读一次。
 */
let _buildTime: string | undefined;
function readBuildTime(): string {
  if (_buildTime !== undefined) return _buildTime;
  let v = "";
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "build-info.json");
    if (existsSync(p)) v = String(JSON.parse(readFileSync(p, "utf8")).buildTime ?? "");
  } catch {
    /* ignore — 降级 unknown */
  }
  _buildTime = v || "unknown";
  return _buildTime;
}

/** ISO(2026-07-21T14:58:17.123Z)→ 精确到秒的可读形式 2026-07-21 14:58:17Z */
function formatBuildTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : iso;
}

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
  const builtLabel = t(language, "viewer.buildTime");
  const buildTime = formatBuildTime(readBuildTime());

  const searchPlaceholder = t(language, "viewer.search.placeholder");
  const searchBtn = t(language, "viewer.search.button");
  const searchClearBtn = t(language, "viewer.search.clear");
  const searchClearTitle = t(language, "viewer.search.clear_title");
  const authPrompt = options.tokenRequired
    ? t(language, "viewer.auth.prompt")
    : "";
  const authPlaceholder = t(language, "viewer.auth.placeholder");

  // 侧栏导航(2026-08 改版):按使用频率与治理语义分组。
  // 主功能:高频浏览入口;治理:需要人裁决的入口;管理:低频工具(图标行,极度降权)。
  // .tab 类与 data-tab 属性保持不变 —— app.ts 的 showTab 依赖这两个选择器。
  const primaryTabs = [
    ["stats", t(language, "viewer.tab.stats"), t(language, "viewer.tab.stats.tip")],
    ["engrams", t(language, "viewer.tab.engrams"), t(language, "viewer.tab.engrams.tip")],
    ["graph", t(language, "viewer.tab.graph"), t(language, "viewer.tab.graph.tip")],
    ["skills", t(language, "viewer.tab.skills"), t(language, "viewer.tab.skills.tip")],
  ] as const;

  const governanceTabs = [
    ["proposals", t(language, "viewer.tab.proposals"), t(language, "viewer.tab.proposals.tip"), true],
    ["maintenance", t(language, "viewer.tab.maintenance"), t(language, "viewer.tab.maintenance.tip"), false],
    ["audit", t(language, "viewer.tab.audit"), t(language, "viewer.tab.audit.tip"), false],
    ["trash", t(language, "viewer.tab.trash"), t(language, "viewer.tab.trash.tip"), false],
    ["incubations", t(language, "viewer.tab.incubations") + `<sup class="tab-exp">${t(language, "viewer.tab.experimentalSuffix")}</sup>`, t(language, "viewer.tab.incubations.tip"), false],
  ] as const;

  // 低频管理入口:仅图标,标签以 title + 屏幕阅读器文本呈现(i18n 契约要求文案可渲染)
  const adminTabs = [
    ["merges", t(language, "viewer.tab.merges"), t(language, "viewer.tab.merges.tip"), "i-merge"],
    ["health", t(language, "viewer.tab.health"), t(language, "viewer.tab.health.tip"), "i-pulse"],
    ["config", t(language, "viewer.tab.config"), t(language, "viewer.tab.config.tip"), "i-gear"],
    ["help", t(language, "viewer.tab.help"), t(language, "viewer.tab.help.tip"), "i-help"],
  ] as const;

  const navButton = ([id, label, tip, badge]: readonly [string, string, string, boolean?]) => {
    const badgeHtml = badge
      ? `<span class="tab-badge" data-badge="proposals" hidden>0</span>`
      : "";
    return `<button data-tab="${id}" class="tab" title="${tip.replace(/"/g, "&quot;")}">${label}${badgeHtml}</button>`;
  };

  const primaryTabButtons = primaryTabs.map(navButton).join("\n      ");
  const governanceTabButtons = governanceTabs.map(navButton).join("\n      ");
  const adminTabButtons = adminTabs
    .map(
      ([id, label, tip, icon]) =>
        `<button data-tab="${id}" class="tab side-admin-btn" title="${tip.replace(/"/g, "&quot;")}"><svg class="side-ico" viewBox="0 0 16 16" aria-hidden="true"><use href="#${icon}"/></svg><span class="sr-only">${label}</span></button>`,
    )
    .join("\n        ");

  // 侧栏图标集(内联 symbol,stroke 随 currentColor;替代 emoji,跨平台一致)
  const SIDE_ICONS = `
  <svg style="display:none" aria-hidden="true">
    <symbol id="i-merge" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="8" r="1.8"/><path d="M4 5.3v5.4M5.7 4.3L10 7M5.7 11.7L10 9"/></symbol>
    <symbol id="i-pulse" viewBox="0 0 16 16"><path d="M1.5 8h3L6.5 4l2.5 8 1.5-4h3"/></symbol>
    <symbol id="i-gear" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"/></symbol>
    <symbol id="i-help" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M6.3 6.3A1.8 1.8 0 1 1 8 8.7v.8"/><circle cx="8" cy="11.4" r="0.4"/></symbol>
  </svg>`;

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
<body>
${SIDE_ICONS}
<div class="app">
  <aside class="side-nav">
    <div class="brand">
      <span class="brand-logo brand-logo-light" aria-hidden="true">${COENGRAMLOGO_SVG}</span>
      <span class="brand-logo brand-logo-dark" aria-hidden="true">${COENGRAMLOGODARK_SVG}</span>
      <div class="brand-text">
        <h1>${title}</h1>
        <span class="brand-slogan">${slogan}</span>
      </div>
    </div>

    <nav class="side-group" aria-label="${t(language, "viewer.nav.primary")}">
      ${primaryTabButtons}
    </nav>

    <div class="side-sec">${t(language, "viewer.nav.governance")}</div>
    <nav class="side-group" aria-label="${t(language, "viewer.nav.governance")}">
      ${governanceTabButtons}
    </nav>

    <div class="side-admin">
      ${adminTabButtons}
    </div>
    ${
      options.tokenRequired
        ? `<div class="auth-bar">${authPrompt} <input id="token-input" type="password" placeholder="${authPlaceholder}"/></div>`
        : ""
    }
  </aside>

  <main>
    <!-- Stats -->
    <section class="tab-panel" data-tab="stats">
      <!--
        2026-08 改版(DEMO g2-overview):统计块在上、搜索栏顶吸、动态流在下。
        统计块与动态流由 stats-content 渲染。搜索栏这对节点常驻 #search-dock
        (stats-content 之外,重渲染 innerHTML 不会销毁它们),每次 stats 渲染后
        被 tabs.ts 插到「统计块与动态流之间」的标记位,父级是全高的 ov-main,
        position: sticky 才能跨越动态流全程顶吸。
      -->
      <div id="stats-content"></div>
      <div id="search-dock" hidden>
        <form id="search-form" class="search-bar">
          <input id="search-input" type="text" name="q" placeholder="${searchPlaceholder}" autocomplete="off"/>
          <button type="submit">${searchBtn}</button>
          <button type="button" id="search-clear" title="${searchClearTitle}" onclick="CO_ENGRAM.clearSearch()">${searchClearBtn}</button>
        </form>
        <div id="search-results" class="panel" style="margin-bottom:1.5rem;display:none"></div>
      </div>
    </section>

    <!-- Engrams -->
    <section class="tab-panel" data-tab="engrams">
      <div id="engrams-content"></div>
    </section>

    <!-- Skills (D10 对称 engrams tab) -->
    <section class="tab-panel" data-tab="skills">
      <div id="skills-content"></div>
    </section>

    <!-- Graph -->
    <section class="tab-panel" data-tab="graph">
      <!--
        2026-08 v3(用户反馈重排):功能性筛选(搜索/路径/状态/重要度阈值/着色/夜览)
        独立到舞台上方的功能栏;舞台内只留视觉图例(KIND 点选 + 关系族)与检查器。
        发光脉冲已删(心智负担);重置视图已删。
      -->
      <div class="graph-funcbar">
        <div class="gt">${t(language, "viewer.tab.graph")}</div>
        <input type="search" class="ftext" id="graph-q" placeholder="${t(language, "viewer.graph.filter.searchPlaceholder2")}" oninput="CO_ENGRAM_GRAPH.applyTextFilter(this.value)">
        <button class="pathbtn" onclick="CO_ENGRAM_GRAPH.openPathPicker()">📂 ${t(language, "viewer.graph.filter.pathBtn2")}</button>
        <span class="chip removable" id="graph-path-chip" style="display:none" onclick="CO_ENGRAM_GRAPH.clearPathFilter()"></span>
        <span class="chip removable" id="graph-text-chip" style="display:none" onclick="CO_ENGRAM_GRAPH.clearTextFilter()"></span>
        <select class="fselect" id="graph-status" onchange="CO_ENGRAM_GRAPH.setStatusFilter(this.value)" title="${t(language, "viewer.graph.status.tip")}">
          <option value="active">${t(language, "viewer.graph.status.activeOnly")}</option>
          <option value="all">${t(language, "viewer.graph.status.all")}</option>
          <option value="contradictions">${t(language, "viewer.graph.status.contradictionsOnly")}</option>
        </select>
        <select class="fselect" id="graph-color-mode" onchange="CO_ENGRAM_GRAPH.setColorMode(this.value)" title="${t(language, "viewer.graph.modes.title")}">
          <option value="structure">${t(language, "viewer.graph.modes.structure")}</option>
          <option value="vitality">${t(language, "viewer.graph.modes.vitality")}</option>
          <option value="conflict">${t(language, "viewer.graph.modes.conflict")}</option>
          <option value="heat">${t(language, "viewer.graph.modes.heat")}</option>
        </select>
        <div class="graph-slider">
          <input type="range" id="graph-imp-range" min="0" max="100" value="0" aria-label="${t(language, "viewer.graph.filter.impTitle")}" oninput="CO_ENGRAM_GRAPH.setImportance(this.value)">
          <span class="slider-val" id="graph-imp-val"></span>
        </div>
        <span class="chip" id="graph-filter-count"></span>
        <span class="spacer"></span>
        <button class="tb" onclick="CO_ENGRAM_GRAPH.fit()" title="${t(language, "viewer.graph.toolbar.fitTitle")}">⤢ ${t(language, "viewer.graph.toolbar.fit")}</button>
        <button class="tb" onclick="CO_ENGRAM_GRAPH.togglePhysics()" title="${t(language, "viewer.graph.toolbar.physicsTitle")}">⚛ ${t(language, "viewer.graph.toolbar.physics")}</button>
        <button class="btn secondary mini" id="graph-night-btn" onclick="CO_ENGRAM_GRAPH.toggleNight()" title="${t(language, "viewer.graph.night.title")}">🌙 ${t(language, "viewer.graph.night.enable")}</button>
      </div>
      <div class="graph-container" id="graph-stage">
        <div class="graph-legend">
          <h4>KIND · ${t(language, "viewer.graph.legend.pickFilter")}</h4>
          <div id="legend-kinds"></div>
          <h4 style="margin-top:9px">${t(language, "viewer.graph.synapseKindsTitle")}</h4>
          <div id="legend-families"></div>
          <h4 style="margin-top:9px">${t(language, "viewer.graph.reading.title")}</h4>
          <div class="read-hint">${t(language, "viewer.graph.reading.hint")}</div>
        </div>
        <div id="graph-canvas">
          <div class="loading">${t(language, "viewer.loading.graph")}</div>
        </div>
        <div class="graph-insp" id="graph-insp" hidden></div>
        <div class="graph-bottombar">
          <div class="tl-lab"><b>${t(language, "viewer.graph.replay.title")}</b>${t(language, "viewer.graph.replay.sub")}</div>
          <input type="range" class="tl" id="graph-time-range" min="0" max="100" value="100" aria-label="${t(language, "viewer.graph.replay.title")}" oninput="CO_ENGRAM_GRAPH.setTimeReplay(this.value)">
          <span class="tl-val" id="graph-time-val"></span>
        </div>
      </div>
    </section>

    <!-- Proposals -->
    <section class="tab-panel" data-tab="proposals">
      <div id="proposals-content"></div>
    </section>

    <!-- Merges (P4.3) -->
    <section class="tab-panel" data-tab="merges">
      <h1 class="page-h">${t(language, "viewer.page.merges.title")}</h1>
      <div class="page-sub">${t(language, "viewer.page.merges.sub")}</div>
      <div id="merges-content"></div>
    </section>

    <!-- Audit -->
    <section class="tab-panel" data-tab="audit">
      <div id="audit-content"></div>
    </section>

    <!-- Maintenance (REM/daily/light/deep 状态) -->
    <section class="tab-panel" data-tab="maintenance">
      <div id="maintenance-content"></div>
    </section>

    <!-- Trash -->
    <section class="tab-panel" data-tab="trash">
      <h1 class="page-h">${t(language, "viewer.page.trash.title")}</h1>
      <div class="page-sub">${t(language, "viewer.page.trash.sub")}</div>
      <div id="trash-content"></div>
    </section>

    <!-- Incubations(夜思实验室,spec §四/§六) -->
    <section class="tab-panel" data-tab="incubations">
      <div id="incubations-content"></div>
    </section>

    <!-- Health -->
    <section class="tab-panel" data-tab="health">
      <h1 class="page-h">${t(language, "viewer.page.health.title")}</h1>
      <div class="page-sub">${t(language, "viewer.page.health.sub")}</div>
      <div id="health-content"></div>
    </section>

    <!-- Config -->
    <section class="tab-panel" data-tab="config">
      <h1 class="page-h">${t(language, "viewer.page.config.title")}</h1>
      <div class="page-sub">${t(language, "viewer.page.config.sub")}</div>
      <div id="config-content"></div>
    </section>

    <!-- Help -->
    <section class="tab-panel" data-tab="help">
      <div id="help-content"></div>
    </section>
  </main>
</div>

  <!-- Detail drawer (right side) -->
  <aside id="detail-drawer" class="drawer">
    <button class="drawer-close" aria-label="${t(language, "action.close")}">✕</button>
    <div class="drawer-body"></div>
  </aside>

  <footer class="app-footer">
    <small>${footer}</small>
    <small class="app-build-time" style="display:block;opacity:.4;font-size:.72em;margin-top:.15rem">${builtLabel} ${buildTime}</small>
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
