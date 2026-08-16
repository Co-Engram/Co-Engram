/**
 * Viewer v2 CSS — 科幻神经元风格。
 *
 * 设计理念:
 * - 深邃的太空背景 + 神经元脉冲光晕
 * - 玻璃态卡片(backdrop-filter blur + 半透明)
 * - 青色主色 (#5eead4) + 紫色辅色 (#c084fc),代表 AI + 神经元
 * - 信号感发光、流光边框
 *
 * @module @co-engram/claude-code/viewer
 */

export const VIEWER_CSS = `
:root {
  /* === 暖纸浅色主题(2026-08 改版:与原神经暗色同变量名,值整体换肤) === */
  --bg-deep: #F5F3ED;                              /* 页面最底层(纸面) */
  --bg: #FBFAF8;                                    /* 内容底 */
  --bg-elev: #FFFFFF;                               /* 卡片/面板 */
  --fg: #2D2A26;
  --fg-bright: #1F1C17;
  --fg-muted: #6A655D;
  --fg-dim: #8B857B;
  --border: rgba(45, 42, 38, 0.12);
  --border-strong: rgba(45, 42, 38, 0.22);
  --border-glow: rgba(15, 118, 110, 0.35);
  --accent: #0F766E;         /* 青绿 → 深青(浅底上的可读主色) */
  --accent-2: #0D9488;       /* 主色渐变端(缺定义曾让全部 .btn 渐变失效变透明) */
  --accent-soft: #EDF7F5;
  --accent-warm: #B45309;    /* 琥珀 → 深琥珀 */
  --accent-fg: #FFFFFF;
  --panel-bg: #FFFFFF;
  --panel-bg-solid: #FFFFFF;
  --panel-bg-alt: rgba(15, 118, 110, 0.05);
  --chip-bg: #F0EDE7;
  --shadow: 0 1px 3px rgba(45, 42, 38, 0.06), 0 0 0 1px rgba(45, 42, 38, 0.05);
  --shadow-lift: 0 4px 14px rgba(45, 42, 38, 0.10), 0 0 0 1px rgba(45, 42, 38, 0.07);
  --glow-cyan: 0 0 0 1px rgba(15, 118, 110, 0.18);
  --glow-purple: 0 0 0 1px rgba(124, 58, 237, 0.16);
  --radius: 8px;
  --radius-lg: 14px;

  /* 关系族配色(浅底可读版) */
  --fam-structural: #2563EB;
  --fam-causal: #D7730D;
  --fam-evidential: #0E9F6E;
  --fam-temporal: #7163C4;
  --fam-modulatory: #6B655D;
  --fam-contradicts: #E02424;

  /* kind 配色(浅底可读版) */
  --kind-fact: #0E9F6E;
  --kind-observation: #2563EB;
  --kind-pattern: #7163C4;
  --kind-procedure: #D7730D;
  --kind-hypothesis: #E02424;

  /* 审计动作色 */
  --audit-state: #2563EB;
  --audit-effective: #0E9F6E;
  --audit-contradicted: #E02424;
  --audit-proposal: #7163C4;
}


* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  margin: 0;
  color: var(--fg);
  line-height: 1.55;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  background: var(--bg-deep);
  min-height: 100vh;
}

/* === Layout:侧栏 + 主区(2026-08 改版) === */
.app {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 100vh;
}
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .side-nav {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }
  .side-admin { margin-left: auto; }
}

.side-nav {
  background: var(--bg);
  border-right: 1px solid var(--border);
  padding: 1.25rem 0.75rem 0.75rem;
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
/* 品牌区纵向布局(2026-08-16 用户定稿):logo 最上,下面 Co-Engram,
   再下「自进化的团队记忆」—— 横排时 120px logo 挤压标题导致换行。
   间距收紧:logo span 改 flex 消除 inline svg 基线留白,gap 压到 0.05rem */
.side-nav .brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.05rem;
  padding: 0 0.25rem 1rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.5rem;
}
.side-nav .brand-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  min-width: 0;
}
.side-nav .brand h1 {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.2;
  font-weight: 700;
  color: var(--fg-bright);
  background: none;
  -webkit-text-fill-color: currentColor;
  letter-spacing: -0.01em;
}
.side-nav .brand-slogan {
  font-size: 0.7rem;
  color: #B8941D;
  font-weight: 600;
  letter-spacing: 0.04em;
}
/* 品牌徽标(2026-08 用户反馈):当前为浅色纸面主题,只显示 light 变体;
   dark 变体保留在 DOM(html.ts 注入)但隐藏,防双徽标同显。尺寸放大一倍(40→80)。 */
.brand-logo { width: 120px; height: 120px; flex-shrink: 0; display: flex; }
.brand-logo svg { width: 100%; height: 100%; }
.brand-logo-dark { display: none; }

.side-sec {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--fg-dim);
  letter-spacing: 0.07em;
  margin: 0.8rem 0.5rem 0.25rem;
}
.side-group { display: flex; flex-direction: column; gap: 2px; }

/* 侧栏导航条目(复用 .tab,作用域限定侧栏) */
.side-nav .tab {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--fg-muted);
  padding: 0.42rem 0.6rem;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 500;
  transition: background .15s, color .15s;
  position: relative;
  font-family: inherit;
}
.side-nav .tab:hover { background: #F2EFEA; color: var(--fg); }
.side-nav .tab.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.side-nav .tab.active::after { display: none; }

.side-admin {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
  display: flex;
  gap: 2px;
  justify-content: space-around;
}
.side-admin-btn {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--fg-dim);
}
.side-admin-btn:hover { background: #F2EFEA; color: var(--fg-muted); }
.side-admin-btn.active { background: var(--accent-soft); color: var(--accent); }
.side-ico { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

/* 屏幕阅读器文本(视觉隐藏,i18n 契约要求文案可渲染) */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap; border: 0;
}

.auth-bar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
  flex-wrap: wrap;
}
.auth-bar input {
  flex: 1;
  min-width: 90px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 0.3rem 0.55rem;
  color: var(--fg);
  font-size: 0.78rem;
}

/* === Proposals tab badge ===
 * 有待审批的候选记忆时,在「记忆提案」tab 上显示带数字的脉动徽标,
 * 引导用户进入审批。徽标复用主色(青绿)而非红色,保持页面配色克制。
 */
.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.15rem;
  height: 1.15rem;
  padding: 0 0.4rem;
  margin-left: 0.4rem;
  font-size: 0.68rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  color: #F5F3ED;
  background: var(--accent);
  border-radius: 999px;
  box-shadow: none;
  animation: tab-badge-pulse 2.4s ease-in-out infinite;
  vertical-align: middle;
}
.tab-badge[hidden] { display: none; }
@keyframes tab-badge-pulse {
  0%, 100% { box-shadow: none; }
  50%      { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.18); }
}
@media (prefers-reduced-motion: reduce) {
  .tab-badge { animation: none; }
}

/* === 「更多」下拉菜单 ===
 * 二级工具(merges/audit/trash/health/config/help)折叠到 header 右侧下拉,
 * 降低主页面心智负担。点击触发器展开,外部点击/Escape/选中 tab 后自动收起。
 */
.more-menu {
  position: relative;
  display: inline-flex;
}
.more-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.more-menu-caret {
  font-size: 0.7rem;
  opacity: 0.7;
  transition: transform .2s ease;
}
.more-menu.open .more-menu-caret {
  transform: rotate(180deg);
}
.more-menu-dropdown {
  position: absolute;
  top: calc(100% + 0.45rem);
  right: 0;
  min-width: 12rem;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(15, 118, 110, 0.08);
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  z-index: 25;
  animation: more-menu-fade .18s ease-out;
}
.more-menu-dropdown[hidden] { display: none; }
@keyframes more-menu-fade {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.more-menu-dropdown .tab {
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  font-size: 0.8rem;
  padding: 0.45rem 0.75rem;
}
/* 当某个二级 tab 处于 active 时,触发器高亮(替代之前的圆点——圆点被用户误认为
   "有新信息"的 notification badge,实际含义是"当前页面在更多菜单里") */
.more-menu.has-active .more-menu-trigger {
  color: var(--accent, #5eead4);
  border-bottom-color: var(--accent, #5eead4);
}
.auth-bar {
  margin-top: 0;
  font-size: 0.78rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--fg-muted);
}
.auth-bar input {
  background: rgba(15, 118, 110, 0.05);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.3rem 0.6rem;
  border-radius: 4px;
  font-size: 0.78rem;
  font-family: inherit;
}
.auth-bar input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.15);
}

/* === 概览(2026-08 改版):KPI + 脉搏 + 动态 + 右侧榜单 === */
.ov-layout { display: grid; grid-template-columns: minmax(0, 780px) 300px; justify-content: space-between; gap: 1.5rem; }
@media (max-width: 1000px) { .ov-layout { grid-template-columns: 1fr; } .ov-side { order: 2; } }
.ov-stats-block {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem 1.25rem 0.9rem;
  margin-bottom: 0.9rem;
}
.ov-kpi-row { display: flex; flex-wrap: wrap; }
.ov-kpi { padding: 0 1.6rem; border-right: 1px solid var(--border); cursor: pointer; min-width: 118px; }
.ov-kpi:first-child { padding-left: 0; }
.ov-kpi:last-child { border-right: none; }
.ov-kpi:hover .ov-kpi-value { color: var(--accent); }
.ov-kpi-value { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; font-variant-numeric: tabular-nums; }
.ov-kpi-label { font-size: 0.72rem; color: var(--fg-dim); }
.ov-kpi-sub { font-size: 0.68rem; color: var(--fg-dim); margin-top: 1px; }
.ov-up { color: var(--accent); font-size: 0.78rem; font-weight: 600; }
.ov-pulse-h { font-size: 0.78rem; font-weight: 700; color: var(--fg-muted); border-top: 1px solid var(--border); margin-top: 0.8rem; padding-top: 0.7rem; margin-bottom: 0.5rem; display: flex; align-items: baseline; gap: 0.5rem; }
.ov-pulse-h small { font-weight: 400; color: var(--fg-dim); font-size: 0.68rem; margin-left: auto; }
.ov-pulse { display: flex; align-items: flex-end; gap: 3px; height: 50px; }
.ov-pulse i { flex: 1; background: var(--panel-bg-alt); border-radius: 2px 2px 0 0; min-height: 3px; }
.ov-pulse i.hot { background: var(--accent); }
/* 记忆更新(2026-08):每日数量,无峰值高亮;有数据的柱子可点弹当日明细 */
.ov-pulse.ov-pulse-clickable i[role="option"] { cursor: pointer; background: color-mix(in srgb, var(--accent) 42%, var(--panel-bg-alt)); }
.ov-pulse.ov-pulse-clickable i[role="option"]:hover { background: var(--accent); }
.ov-pulse-axis { display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--fg-dim); margin-top: 0.3rem; }
.ov-pulse-axis .peak { color: var(--accent); font-weight: 600; }

/* 当日记忆弹卡(记忆更新图点击) */
.day-pop { position: fixed; inset: 0; background: rgba(45, 42, 38, 0.32); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.day-pop-card { background: var(--panel-bg, #fff); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 18px 50px rgba(45, 42, 38, 0.22); width: 520px; max-width: 92vw; max-height: 70vh; display: flex; flex-direction: column; padding: 1.1rem 1.3rem; position: relative; }
.day-pop-card h3 { margin: 0 2rem 0.7rem 0; font-size: 1rem; }
.day-pop-close { position: absolute; top: 0.8rem; right: 0.8rem; background: transparent; border: none; cursor: pointer; color: var(--fg-dim); font-size: 0.9rem; padding: 0.2rem 0.4rem; border-radius: 6px; }
.day-pop-close:hover { background: var(--chip-bg); color: var(--fg); }
.day-pop-body { overflow-y: auto; }
.day-pop-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.42rem 0.2rem; border-bottom: 1px dotted var(--border); font-size: 0.8rem; }
.day-pop-item:last-child { border-bottom: none; }
.day-pop-item.clickable { cursor: pointer; }
.day-pop-item.clickable:hover .day-pop-title { color: var(--accent); }
.day-pop-type { font-size: 0.66rem; font-weight: 600; border-radius: 5px; padding: 1px 6px; flex-shrink: 0; }
.day-pop-type.t-engram { background: rgba(15, 118, 110, 0.12); color: var(--accent); }
.day-pop-type.t-synapse { background: rgba(37, 99, 235, 0.12); color: #2563EB; }
.day-pop-type.t-skill { background: rgba(113, 99, 196, 0.12); color: #7163C4; }
.day-pop-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--fg); }
.day-pop-act { font-size: 0.68rem; color: var(--fg-dim); flex-shrink: 0; }

/* 榜单行内类型小徽标(DEMO kd-mini):覆盖 .chip 默认内边距,缩成小方徽标 */
.chip.kd-mini { font-size: 10.5px; padding: 1px 6px; border-radius: 5px; flex-shrink: 0; align-self: center; line-height: 1.5; }
.ov-top-row .ov-top-title { cursor: pointer; }

.ov-feed-h { font-size: 1.05rem; font-weight: 700; margin: 1.3rem 0 0.6rem; display: flex; align-items: baseline; gap: 0.6rem; }
.ov-feed-h small { font-weight: 400; color: var(--fg-dim); font-size: 0.72rem; }
.ov-feed-day { font-size: 0.72rem; font-weight: 700; color: var(--fg-dim); margin: 0.9rem 0 0.4rem; display: flex; gap: 0.6rem; align-items: center; }
.ov-feed-day::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.ov-feed-item { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 0.65rem; padding: 0.55rem 0.75rem; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 0.4rem; }
.ov-feed-body { min-width: 0; }
.ov-feed-ext { font-size: 0.66rem; color: var(--accent-warm, #B45309); background: rgba(180, 83, 9, 0.09); border-radius: 4px; padding: 0 4px; }
.ov-feed-times { font-size: 0.68rem; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.ov-feed-sentinel { text-align: center; color: var(--fg-dim); font-size: 0.72rem; padding: 0.6rem 0; }
.ov-feed-more { text-align: center; padding: 0.5rem 0 0.2rem; font-size: 0.74rem; }
.ov-feed-ico { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; background: var(--chip-bg); color: var(--fg-muted); }
.ov-feed-title { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-feed-title[onclick] { cursor: pointer; }
.ov-feed-title[onclick]:hover { color: var(--accent); }
.ov-feed-meta { font-size: 0.7rem; color: var(--fg-dim); }
.ov-feed-meta b { font-weight: 600; color: var(--fg-muted); }
.ov-feed-excerpt { font-size: 0.74rem; color: var(--fg-dim); line-height: 1.5; margin-top: 0.15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-feed-chips { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.25rem; }
.ov-feed-link { font-size: 0.7rem; color: var(--accent); cursor: pointer; }
.ov-feed-link:hover { text-decoration: underline; }
.feed-create .ov-feed-ico { background: rgba(14, 159, 110, 0.12); color: #0E9F6E; }
.feed-reinforce .ov-feed-ico { background: rgba(113, 99, 196, 0.12); color: #7163C4; }
.feed-contradicted .ov-feed-ico { background: rgba(224, 36, 36, 0.10); color: #E02424; }
.feed-retrieval .ov-feed-ico { background: var(--accent-soft); color: var(--accent); }
.feed-maintenance .ov-feed-ico { background: rgba(180, 83, 9, 0.10); color: #B45309; }
.feed-skill .ov-feed-ico { background: rgba(180, 83, 9, 0.12); color: #B45309; }
.feed-update .ov-feed-ico { background: rgba(37, 99, 235, 0.10); color: #2563EB; }

.ov-side { display: flex; flex-direction: column; gap: 0.9rem; }
.ov-card { background: var(--panel-bg); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.85rem 1rem; cursor: pointer; transition: box-shadow .15s; }
.ov-card:hover { box-shadow: var(--shadow-lift); }
.ov-card h3 { font-size: 0.78rem; margin: 0 0 0.55rem; display: flex; align-items: baseline; gap: 0.5rem; }
.ov-card h3 small { font-weight: 400; color: var(--fg-dim); font-size: 0.68rem; margin-left: auto; }
.ov-card h3 small::after { content: '▾'; margin-left: 0.4rem; font-size: 0.6rem; }
.ov-card.expanded h3 small::after { content: '▴'; }
.ov-more-wrap { display: none; }
.ov-card.expanded .ov-more-wrap { display: block; }
.ov-heat-row { display: flex; align-items: center; gap: 0.55rem; font-size: 0.78rem; color: var(--fg-muted); padding: 0.22rem 0; }
.ov-heat-name { width: 88px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-heat-bar { flex: 1; height: 5px; border-radius: 3px; background: var(--chip-bg); overflow: hidden; }
.ov-heat-bar span { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #14B8A6, var(--accent)); }
.ov-heat-val { width: 30px; text-align: right; font-size: 0.7rem; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.ov-top-row { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.3rem 0; border-bottom: 1px dotted var(--border); font-size: 0.78rem; }
.ov-top-row:last-child { border-bottom: none; }
.ov-top-title { font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ov-top-row:hover .ov-top-title { color: var(--accent); }
.ov-top-val { font-size: 0.7rem; color: var(--fg-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ov-top-val b { font-weight: 600; color: var(--fg-muted); }
.ov-cool { color: #B45309; }
.ov-contrib-row { display: grid; grid-template-columns: 14px 1fr 34px; gap: 0.5rem; align-items: center; font-size: 0.78rem; padding: 0.22rem 0; }
.ov-rank { color: var(--fg-dim); font-size: 0.7rem; font-variant-numeric: tabular-nums; }
.ov-contrib-name { font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-contrib-name small { display: block; font-weight: 400; color: var(--fg-dim); font-size: 0.65rem; }
.ov-contrib-bar { grid-column: 2 / 4; height: 5px; border-radius: 3px; background: var(--chip-bg); overflow: hidden; }
.ov-contrib-bar span { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #B8941D, #D4AF37); }
.ov-contrib-val { grid-column: 3; grid-row: 1; text-align: right; font-size: 0.7rem; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.kind-dot-fact, .kind-dot-observation, .kind-dot-pattern, .kind-dot-procedure, .kind-dot-hypothesis {
  width: 8px; height: 8px; border-radius: 3px; flex-shrink: 0; align-self: center; padding: 0;
}
.kind-dot-fact { background: var(--kind-fact); }
.kind-dot-observation { background: var(--kind-observation); }
.kind-dot-pattern { background: var(--kind-pattern); }
.kind-dot-procedure { background: var(--kind-procedure); }
.kind-dot-hypothesis { background: var(--kind-hypothesis); }

main {
  /* 2026-08 改版(DEMO):内容页版心 960px(印迹/技能/提案/审计等)。
     概览页例外 —— :has 加宽到 1200px,ov-layout 主列 780 + 侧列 300。 */
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
  position: relative;
  z-index: 1;
  width: 100%;
}
main:has(> section.tab-panel[data-tab="stats"].active) {
  max-width: 1200px;
}
section.tab-panel { display: none; }
section.tab-panel.active { display: block; animation: fade-in .25s ease-out; }
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* === Search === */
.search-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}
/* 概览搜索栏顶吸(DEMO g2-overview .sline):统计卡随滚动滑走,
   搜索栏 sticky 顶吸;stuck 态(已吸附)加底边线 + 投影 */
#search-form.search-bar {
  position: sticky;
  top: 0;
  z-index: 30;
  padding: 0.5rem 0;
  margin-bottom: 1rem;
  background: var(--bg);
  border-bottom: 1px solid transparent;
}
#search-form.search-bar.stuck {
  border-bottom-color: var(--border);
  box-shadow: 0 4px 12px rgba(45, 42, 38, 0.04);
}
.search-bar input {
  flex: 1;
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.6rem 1rem;
  border-radius: var(--radius);
  font-size: 0.88rem;
  font-family: inherit;
  transition: all .2s;
}
.search-bar input::placeholder { color: var(--fg-dim); }
.search-bar input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12), var(--glow-cyan);
}
.search-bar button {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-fg);
  border: none;
  padding: 0.6rem 1.4rem;
  border-radius: var(--radius);
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
  font-size: 0.85rem;
  transition: all .2s;
}
.search-bar button:hover {
  filter: brightness(1.15);
  box-shadow: var(--glow-cyan);
}
.search-bar button[type=button] {
  background: transparent;
  color: var(--fg-dim);
  border: 1px solid var(--border);
  padding: 0.55rem 1.1rem;
  font-weight: 500;
}
.search-bar button[type=button]:hover {
  color: var(--fg);
  border-color: var(--accent);
  filter: none;
  box-shadow: none;
}

/* === Cards & Grid === */
.grid {
  display: grid;
  gap: 0.85rem;
}
.grid.cols-3 { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.grid.cols-4 { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }

.card {
  background: var(--panel-bg);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 0.875rem 1rem; /* DEMO 精确值 14px 16px */
  box-shadow: var(--shadow);
  transition: all .2s;
  position: relative;
  overflow: hidden;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(94, 234, 212, 0) 0%, rgba(15, 118, 110, 0.04) 100%);
  pointer-events: none;
  opacity: 0;
  transition: opacity .25s;
}
.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}
.card:hover::before { opacity: 1; }
.card-title {
  font-weight: 600;
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
  cursor: pointer;
  color: var(--fg-bright);
  transition: color .15s;
}
.card-title:hover { color: var(--accent); }
.card-meta {
  font-size: 0.75rem;
  color: var(--fg-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.85rem;
  margin-top: 0.6rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 500;
  background: var(--chip-bg);
  color: var(--fg);
  border: 1px solid transparent;
  font-family: inherit;
}
.chip.kind-fact { background: rgba(52, 211, 153, 0.12); color: var(--kind-fact); border-color: rgba(52, 211, 153, 0.25); }
.chip.kind-observation { background: rgba(96, 165, 250, 0.12); color: var(--kind-observation); border-color: rgba(96, 165, 250, 0.25); }
.chip.kind-pattern { background: rgba(167, 139, 250, 0.12); color: var(--kind-pattern); border-color: rgba(167, 139, 250, 0.25); }
.chip.kind-procedure { background: rgba(251, 146, 60, 0.12); color: var(--kind-procedure); border-color: rgba(251, 146, 60, 0.25); }
.chip.kind-hypothesis { background: rgba(244, 63, 94, 0.12); color: var(--kind-hypothesis); border-color: rgba(244, 63, 94, 0.25); }

/* Engram visibility badge(详情面板显示)—— private 用警告色突出 */
.visibility-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 500;
  border: 1px solid transparent;
  background: var(--chip-bg);
  color: var(--fg);
}
.visibility-badge.visibility-public {
  background: rgba(148, 163, 184, 0.10);
  color: #94a3b8;
  border-color: rgba(148, 163, 184, 0.25);
}
.visibility-badge.visibility-team {
  background: rgba(96, 165, 250, 0.10);
  color: #60a5fa;
  border-color: rgba(96, 165, 250, 0.25);
}
.visibility-badge.visibility-restricted {
  background: rgba(251, 191, 36, 0.10);
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.25);
}
.visibility-badge.visibility-private {
  background: rgba(244, 63, 94, 0.12);
  color: #f43f5e;
  border-color: rgba(244, 63, 94, 0.30);
}
/* chip.visibility-* — renderVisibilityBadge 输出 alias,与 visibility-badge.visibility-* 同色 */
.chip.visibility-public {
  background: rgba(148, 163, 184, 0.10);
  color: #94a3b8;
  border-color: rgba(148, 163, 184, 0.25);
}
.chip.visibility-team {
  background: rgba(96, 165, 250, 0.10);
  color: #60a5fa;
  border-color: rgba(96, 165, 250, 0.25);
}
.chip.visibility-restricted {
  background: rgba(251, 191, 36, 0.10);
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.25);
}
.chip.visibility-private {
  background: rgba(244, 63, 94, 0.12);
  color: #f43f5e;
  border-color: rgba(244, 63, 94, 0.30);
}
/* 列表卡片标题前的 🔒 图标 */
.lock-icon {
  display: inline-block;
  margin-right: 0.2rem;
  font-size: 0.85em;
  cursor: help;
}
.chip.dot::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 2px;
  box-shadow: 0 0 4px currentColor;
}

/* === Filter bar === */
.filter-bar {
  /* 2026-08-16 用户要求:记忆印迹等功能栏吸顶 —— 滚动长列表时筛选/操作常驻 */
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
  margin-bottom: 1rem;
  padding: 0.75rem 1rem;
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.filter-bar select, .filter-bar input[type=text], .filter-bar input[type=search] {
  background: rgba(15, 118, 110, 0.04);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.35rem 0.6rem;
  border-radius: 4px;
  font-size: 0.8rem;
  min-width: 100px;
  font-family: inherit;
}
.filter-bar select:focus, .filter-bar input:focus {
  outline: none;
  border-color: var(--accent);
}
.filter-bar label {
  font-size: 0.75rem;
  color: var(--fg-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.filter-bar .spacer { flex: 1; }

/* === KPI (stats) === */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.9rem;
  margin-bottom: 1.75rem;
}
.kpi {
  background: var(--panel-bg);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem 1.15rem;
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: all .2s;
  position: relative;
  overflow: hidden;
}
.kpi::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  opacity: 0;
  transition: opacity .25s;
}
.kpi::after {
  content: '→';
  position: absolute;
  right: 1rem;
  bottom: 0.85rem;
  color: var(--fg-dim);
  font-size: 1rem;
  opacity: 0;
  transition: all .2s;
}
.kpi:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lift), var(--glow-cyan);
  transform: translateY(-2px);
}
.kpi:hover::before { opacity: 1; }
.kpi:hover::after { opacity: 1; right: 0.85rem; color: var(--accent); }
.kpi-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
  margin-bottom: 0.35rem;
  font-weight: 500;
}
.kpi-value {
  font-size: 1.85rem;
  font-weight: 700;
  color: var(--fg-bright);
  font-variant-numeric: tabular-nums;
  background: linear-gradient(135deg, var(--fg-bright) 0%, var(--accent) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.kpi-sub {
  font-size: 0.7rem;
  color: var(--fg-muted);
  margin-top: 0.2rem;
}

/* === Bars (stats distribution) === */
.bar-row {
  display: grid;
  grid-template-columns: 110px 1fr 40px;
  gap: 0.6rem;
  align-items: center;
  font-size: 0.8rem;
  margin-bottom: 0.4rem;
}
.bar-row .bar-label { color: var(--fg-muted); }
.bar-row .bar-track {
  background: rgba(15, 118, 110, 0.06);
  border-radius: 4px;
  height: 14px;
  overflow: hidden;
  position: relative;
}
.bar-row .bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width .4s;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.4);
}
.bar-row .bar-value { text-align: right; color: var(--fg-muted); font-variant-numeric: tabular-nums; }

/* === Graph 功能栏(2026-08 v3:功能性筛选独立于图例,置于舞台上方)=== */
.graph-funcbar {
  /* 2026-08-16:吸顶(与印迹 filter-bar 一致) */
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  background: var(--panel-bg-solid, #FFF);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.6rem 0.9rem;
  margin-bottom: 0.8rem;
  box-shadow: var(--shadow);
  font-size: 0.8rem;
}
.graph-funcbar .gt { font-weight: 600; font-size: 0.9rem; margin-right: 0.4rem; white-space: nowrap; }
.graph-funcbar .gt small { font-weight: 400; color: var(--fg-dim); font-size: 0.7rem; margin-left: 0.4rem; }
.graph-funcbar .ftext { width: 200px; margin-top: 0; }
.graph-funcbar .pathbtn { width: auto; margin-top: 0; }
.graph-funcbar .fselect { width: auto; margin-top: 0; }
.graph-funcbar .graph-slider { flex-direction: row; align-items: center; gap: 0.45rem; padding: 0; }
.graph-funcbar .graph-slider input[type=range] { width: 96px; margin: 0; flex: 0 0 96px; }
/* 数值在滑杆右侧 + 固定宽度:拖动时文本宽度变化不再挤压滑杆(此前左置
   变宽文本会让滑杆整体位移,拇指看似「扭动」难操作) */
.graph-funcbar .graph-slider .slider-val {
  flex: 0 0 auto;
  min-width: 8.5rem;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.graph-funcbar .tb { font: inherit; font-size: 0.76rem; padding: 0.3rem 0.7rem; border-radius: 7px; border: 1px solid var(--border); background: none; color: var(--fg-dim); cursor: pointer; white-space: nowrap; }
.graph-funcbar .tb:hover { background: #F2EFEA; color: var(--fg); }
.graph-funcbar .tb.on { background: var(--accent-soft); color: var(--accent); border-color: var(--border-glow); }

/* === Graph stage(2026-08 DEMO g2-synapses 定稿:点阵纸面舞台 + 浮层)=== */
main:has(> section.tab-panel[data-tab="graph"].active) { max-width: none; }
.graph-container {
  position: relative;
  height: calc(100vh - 120px);
  min-height: 560px;
  border-radius: 20px;
  overflow: hidden;
  --sv-bg: #F7F4EC;
  --sv-line: #E3DDD0;
  --sv-ink: #3A362E;
  --sv-ink2: #6A655D;
  --sv-ink3: #8B857B;
  background: var(--sv-bg);
  background-image: radial-gradient(var(--sv-line) 1px, transparent 1px);
  background-size: 26px 26px;
  border: 1px solid var(--border);
  box-shadow: 0 8px 30px rgba(45, 42, 38, 0.08);
}
.graph-container.night {
  --sv-bg: #0E1226;
  --sv-line: #1C2340;
  --sv-ink: #DFE6F5;
  --sv-ink2: #B9C3E2;
  --sv-ink3: #7580A8;
  background: radial-gradient(ellipse 70% 55% at 62% 22%, #1A2140 0%, #0E1226 65%);
  border-color: #232A4A;
  box-shadow: 0 20px 60px rgba(20, 26, 58, 0.35);
}
#graph-canvas { width: 100%; height: 100%; position: relative; }
#graph-canvas .vis-network { background: transparent !important; }

/* 左:图例筛选浮层 */
.graph-legend {
  position: absolute;
  left: 14px;
  top: 60px;
  width: 196px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 13px;
  z-index: 20;
  color: var(--sv-ink2);
  box-shadow: 0 4px 18px rgba(45, 42, 38, 0.10);
  max-height: calc(100% - 140px);
  overflow-y: auto;
  font-size: 12.5px;
}
.graph-container.night .graph-legend { background: rgba(14, 18, 38, 0.88); color: var(--sv-ink2); }
.graph-legend h4 { font-size: 10.5px; color: var(--sv-ink3); letter-spacing: 0.09em; margin: 2px 0 7px; font-weight: 600; }
.fk { display: flex; align-items: center; gap: 8px; padding: 2.5px 0; cursor: pointer; font-size: 12.5px; }
.fk:hover { color: var(--sv-ink); }
.fk.off { opacity: 0.42; }
.fk .d { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.fk .d.sq { border-radius: 2px; }
.fk .c { margin-left: auto; font-size: 11px; color: var(--sv-ink3); font-variant-numeric: tabular-nums; }
.graph-slider { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.2rem 0; }
.graph-slider .slider-val { font-size: 11px; color: var(--accent); font-family: ui-monospace, Consolas, monospace; }
.graph-slider input[type=range] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, #D8D2C4, var(--accent));
  outline: none;
  margin: 6px 0 3px;
}
.graph-slider input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 5px rgba(15, 118, 110, 0.5);
  cursor: pointer;
}
.pathbtn {
  width: 100%;
  font: inherit;
  font-size: 11.5px;
  background: none;
  border: 1px dashed var(--border-strong);
  border-radius: 7px;
  padding: 4px 9px;
  color: var(--sv-ink3);
  cursor: pointer;
  margin-top: 4px;
  text-align: left;
}
.pathbtn:hover { color: var(--accent); border-color: var(--accent); }
.ftext {
  width: 100%;
  font: inherit;
  font-size: 11.5px;
  background: var(--sv-bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 4px 9px;
  color: var(--sv-ink);
  outline: none;
  margin-top: 4px;
}
.ftext::placeholder { color: var(--sv-ink3); }
.fselect {
  width: 100%;
  font: inherit;
  font-size: 11.5px;
  background: var(--sv-bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 4px 6px;
  color: var(--sv-ink);
  outline: none;
  margin-top: 4px;
}
.graph-legend .read-hint { font-size: 11px; color: var(--sv-ink3); line-height: 1.8; }

/* 右:检查器 */
.graph-insp {
  position: absolute;
  right: 14px;
  top: 60px;
  width: 264px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  z-index: 20;
  color: var(--sv-ink2);
  box-shadow: 0 4px 18px rgba(45, 42, 38, 0.10);
  max-height: calc(100% - 140px);
  overflow-y: auto;
}
.graph-container.night .graph-insp { background: rgba(14, 18, 38, 0.9); }
.graph-insp .kind {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  border-radius: 5px;
  padding: 1.5px 8px;
  display: inline-block;
  margin-bottom: 6px;
  background: rgba(37, 99, 235, 0.1);
}
.graph-insp h3 { font-size: 14.5px; line-height: 1.5; margin-bottom: 7px; color: var(--sv-ink); font-weight: 600; }
.graph-insp .irow { display: flex; justify-content: space-between; font-size: 12px; padding: 2.5px 0; color: var(--sv-ink2); gap: 8px; }
.graph-insp .irow b { font-weight: 500; color: var(--sv-ink); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.graph-insp .neigh { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 9px; }
.graph-insp .neigh h5 { font-size: 10.5px; color: var(--sv-ink3); margin-bottom: 5px; letter-spacing: 0.06em; font-weight: 600; }
.graph-insp .nl { display: flex; align-items: center; gap: 7px; padding: 2.5px 0; font-size: 12px; color: var(--sv-ink2); cursor: pointer; }
.graph-insp .nl:hover { color: var(--sv-ink); }
.graph-insp .nl .d { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.graph-insp .nl .nl-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-insp .nl .ek { margin-left: auto; font-size: 10px; color: var(--sv-ink3); font-family: ui-monospace, Consolas, monospace; }
.graph-insp .iacts { display: flex; gap: 6px; margin-top: 12px; }
.graph-insp .ab {
  flex: 1;
  font: inherit;
  font-size: 11.5px;
  text-align: center;
  border-radius: 8px;
  padding: 5px 0;
  cursor: pointer;
  border: 1px solid var(--border);
  background: none;
  color: var(--sv-ink2);
}
.graph-insp .ab:hover { border-color: var(--accent); color: var(--accent); }

/* 底部:时间回放 + 工具(居中浮层) */
.graph-bottombar {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 14px;
  align-items: center;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 10px 18px;
  z-index: 20;
  width: min(680px, 92%);
  box-shadow: 0 4px 18px rgba(45, 42, 38, 0.10);
}
.graph-container.night .graph-bottombar { background: rgba(14, 18, 38, 0.9); }
.graph-bottombar .tl-lab { font-size: 11.5px; color: var(--sv-ink3); white-space: nowrap; }
.graph-bottombar .tl-lab b { color: var(--sv-ink); display: block; font-size: 12px; }
.graph-bottombar .tl {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, #D8D2C4, var(--accent));
  outline: none;
}
.graph-bottombar .tl::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 6px rgba(15, 118, 110, 0.5);
  cursor: pointer;
}
.graph-bottombar .tl-val { font-size: 12px; color: var(--accent); font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
.graph-bottombar .tools { display: flex; gap: 2px; }
.graph-bottombar .tb { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; border: none; background: none; color: var(--sv-ink3); cursor: pointer; white-space: nowrap; }
.graph-bottombar .tb:hover { background: #F2EFEA; color: var(--sv-ink); }
.graph-bottombar .tb.on { background: var(--accent-soft); color: var(--accent); }

/* SVG 覆盖层:呼吸凸包(DEMO 虚线三色)/ 发光脉冲 / 流动边 */
.graph-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 4; overflow: visible; }
.hull { fill: rgba(37, 99, 235, 0.05); stroke: rgba(37, 99, 235, 0.22); stroke-width: 1; stroke-dasharray: 5 5; animation: hullbreathe 5s ease-in-out infinite; }
.hull.h2 { fill: rgba(14, 159, 110, 0.05); stroke: rgba(14, 159, 110, 0.22); animation-delay: -1.6s; }
.hull.h3 { fill: rgba(215, 115, 13, 0.04); stroke: rgba(215, 115, 13, 0.2); animation-delay: -3.2s; }
@keyframes hullbreathe { 0%, 100% { fill-opacity: 0.55; } 50% { fill-opacity: 1.15; } }
.flow { fill: none; stroke-width: 2; stroke-dasharray: 5 9; animation: flowdash 1.2s linear infinite; }
@keyframes flowdash { to { stroke-dashoffset: -28; } }
.cluster-lab { font-size: 11.5px; fill: #57514A; letter-spacing: 0.12em; font-weight: 600; paint-order: stroke; stroke: #F7F4EC; stroke-width: 3px; }
.graph-container.night .cluster-lab { fill: #C6D0EC; stroke: #0A0D1C; }
@media (prefers-reduced-motion: reduce) { .hull, .flow { animation: none !important; } }

/* 操作按钮行:横排 */
.graph-toolbar .toolbar-actions {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.3rem;
}
.graph-toolbar .toolbar-actions button.mini {
  padding: 0.3rem 0.2rem;
  text-align: center;
  font-size: 0.68rem;
}

.graph-toolbar .group { display: flex; flex-direction: column; gap: 0.2rem; }
.graph-toolbar .group.kind-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.2rem 0.4rem;
}
.graph-toolbar .group-title {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
  margin-top: 0.4rem;
  font-weight: 500;
  padding-bottom: 0.2rem;
  border-bottom: 1px dashed var(--border);
}
.graph-toolbar .group-title:first-child { margin-top: 0; }

/* 族分组(fieldset) */
.graph-toolbar .family-group {
  border: none;
  margin: 0;
  padding: 0;
  border-left: 2px solid var(--border);
  padding-left: 0.4rem;
}
.graph-toolbar .family-group legend {
  font-size: 0.66rem;
  font-weight: 500;
  color: var(--fg);
  padding: 0;
  margin-bottom: 0.2rem;
  cursor: default;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.graph-toolbar .family-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 4px currentColor;
}
.graph-toolbar .family-kinds {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.18rem 0.35rem;
}
.graph-toolbar .family-kinds label {
  font-size: 0.68rem;
}

.graph-toolbar label {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  user-select: none;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.graph-toolbar label:hover { color: var(--accent); }
.graph-toolbar .swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
  box-shadow: 0 0 4px currentColor;
}
.graph-toolbar input[type=checkbox] {
  accent-color: var(--accent);
  flex-shrink: 0;
}
.graph-toolbar button.mini {
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.25rem 0.55rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.7rem;
  font-family: inherit;
  transition: all .15s;
}
.graph-toolbar button.mini:hover {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.2);
}

/* === Detail drawer (right side) === */
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 480px;
  max-width: 92vw;
  height: 100vh;
  background: rgba(255, 255, 255, 0.97);
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  border-left: 1px solid var(--border-strong);
  /* 2026-08 用户反馈:去掉旧阴影里的 -1px accent 绿线(纸面主题下突兀);
     改为中性分层投影 + 细渐变,拉开与主区的层次而不抢色。 */
  box-shadow:
    -1px 0 0 rgba(45, 42, 38, 0.06),
    -8px 0 24px rgba(45, 42, 38, 0.08),
    -24px 0 64px rgba(45, 42, 38, 0.14);
  transform: translateX(100%);
  transition: transform .3s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 100;
  overflow-y: auto;
  padding: 1.5rem 1.75rem;
}
.drawer.open { transform: translateX(0); }
.drawer-close {
  position: absolute;
  top: 0.85rem;
  right: 0.85rem;
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fg-muted);
  padding: 0.25rem 0.6rem;
  font-size: 0.85rem;
  transition: all .15s;
}
.drawer-close:hover {
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.2);
}
.drawer h2 {
  margin: 0 0 0.6rem;
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--fg-bright);
}
.drawer h3 {
  margin: 1.2rem 0 0.5rem;
  font-size: 0.75rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}
.drawer .field { margin-bottom: 0.6rem; font-size: 0.82rem; }
.drawer .field-label {
  color: var(--fg-muted);
  margin-right: 0.45rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.drawer label.field-label {
  display: block;
  margin: 0 0 0.3rem;
  color: var(--accent);
  text-transform: none;
  letter-spacing: 0.02em;
  font-size: 0.78rem;
}
.section-title {
  margin: 0 0 0.7rem;
  font-size: 0.78rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}
.drawer .field-value { color: var(--fg); }
.drawer .editable-input,
.drawer .editable-textarea,
.drawer input[type=text],
.drawer input[type=number],
.drawer textarea,
.drawer select {
  background: rgba(15, 118, 110, 0.04);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.45rem 0.65rem;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.82rem;
  width: 100%;
  transition: all .15s;
}
.drawer textarea { resize: vertical; min-height: 80px; font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace; }
.drawer input:focus, .drawer textarea:focus, .drawer select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.15);
}

/* === Audit timeline === */
.timeline { display: flex; flex-direction: column; gap: 0.5rem; }
.timeline-row {
  display: grid;
  grid-template-columns: 110px 24px 160px 1fr auto;
  gap: 0.7rem;
  align-items: center;
  padding: 0.6rem 0.9rem;
  background: var(--panel-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.8rem;
  transition: all .15s;
}
.timeline-row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow);
}
.timeline-row .ts {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  font-size: 0.74rem;
  cursor: help;
}
.timeline-row .actor-icon {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.68rem;
  font-weight: 700;
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.timeline-row .actor-icon.user { background: linear-gradient(135deg, #3b82f6, #60a5fa); }
.timeline-row .actor-icon.llm { background: linear-gradient(135deg, #8b5cf6, #c084fc); }
.timeline-row .actor-icon.system { background: linear-gradient(135deg, #475569, #94a3b8); }
.timeline-row .action {
  font-weight: 600;
  font-size: 0.72rem;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  display: inline-block;
  text-align: center;
  border: 1px solid transparent;
}
.timeline-row .action.audit-state { background: rgba(96, 165, 250, 0.12); color: var(--audit-state); border-color: rgba(96, 165, 250, 0.25); }
.timeline-row .action.audit-effective { background: rgba(52, 211, 153, 0.12); color: var(--audit-effective); border-color: rgba(52, 211, 153, 0.25); }
.timeline-row .action.audit-contradicted { background: rgba(244, 63, 94, 0.12); color: var(--audit-contradicted); border-color: rgba(244, 63, 94, 0.25); }
.timeline-row .action.audit-proposal { background: rgba(167, 139, 250, 0.12); color: var(--audit-proposal); border-color: rgba(167, 139, 250, 0.25); }
.timeline-row .engram-link {
  color: var(--accent);
  cursor: pointer;
  font-size: 0.75rem;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
.timeline-row .engram-link:hover { text-decoration-style: solid; }
.timeline-row .metadata {
  font-size: 0.7rem;
  color: var(--fg-muted);
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* === Audit row v2 (structured target cell + metadata) === */
.timeline-row.audit-row {
  grid-template-columns: 100px 22px 140px minmax(160px, 240px) 1fr;
  align-items: start;
}
.timeline-row.audit-row .action {
  /* action 列内容可能比 140px 长(如 update_lifecycle),允许 wrap */
  white-space: normal;
  word-break: break-word;
  line-height: 1.2;
}
/* 可点击的 action 标签:点击后按 action 精确过滤 */
.timeline-row.audit-row .action.action-button {
  cursor: pointer;
  font-family: inherit;
  transition: transform 0.08s ease, filter 0.08s ease;
}
.timeline-row.audit-row .action.action-button:hover {
  filter: brightness(1.18);
  transform: translateY(-1px);
}
.timeline-row.audit-row .action.action-button:active {
  transform: translateY(0);
}
.timeline-row.audit-row .action.action-button.active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* 当前生效的 action 过滤 chip */
.audit-action-chip {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.72rem;
  background: var(--accent);
  color: var(--bg);
  align-items: center;
  gap: 0.25rem;
}
.audit-action-chip code {
  background: rgba(0, 0, 0, 0.18);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  color: var(--bg);
}
.audit-meta-cell {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.72rem;
  min-width: 0;
}
.audit-meta-empty { color: var(--fg-muted); opacity: 0.6; }

/* 目标 cell:可点按钮 / 灰色删除线 / 占位 */
.btn-link {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--accent);
  padding: 0.2rem 0.5rem;
  border-radius: var(--radius);
  font-size: 0.7rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-family: inherit;
  transition: all .15s;
}
.btn-link:hover {
  background: rgba(15, 118, 110, 0.08);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.12);
}
.btn-link code {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.68rem;
  color: var(--accent);
}
.audit-target-gone {
  font-size: 0.7rem;
  color: var(--fg-muted);
  opacity: 0.7;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.audit-target-gone code { font-family: 'SF Mono', monospace; }
.audit-target-gone em { font-style: italic; font-size: 0.66rem; opacity: 0.8; }
.audit-target-none { color: var(--fg-muted); opacity: 0.5; }

/* update 类:changed fields 列表 */
.audit-changes {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
  border-left: 2px solid var(--border-strong);
  padding-left: 0.6rem;
}
.audit-change-row {
  display: grid;
  grid-template-columns: minmax(80px, 130px) 1fr auto 1fr;
  gap: 0.4rem;
  align-items: baseline;
  font-size: 0.7rem;
}
.audit-field {
  font-weight: 600;
  color: var(--accent);
  font-family: inherit;
}
.audit-from {
  color: var(--fg-muted);
  text-decoration: line-through;
  text-decoration-color: rgba(244, 63, 94, 0.5);
  word-break: break-word;
}
.audit-arrow {
  color: var(--fg-muted);
  font-weight: 700;
}
.audit-to {
  color: var(--fg);
  word-break: break-word;
}
.audit-meta-extra {
  margin-top: 0.3rem;
  font-size: 0.66rem;
  opacity: 0.75;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

/* synapse 类 / 通用 chips */
.audit-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}
.audit-chips .chip {
  font-size: 0.66rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border-strong);
  color: var(--fg);
  font-family: 'SF Mono', monospace;
}
.audit-chips .chip.synapse-chip {
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.3);
  color: #c4b5fd;
  font-weight: 600;
}
.audit-chips .chip.kind-contradicts {
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.3);
  color: #fca5a5;
}
.audit-kv {
  font-size: 0.68rem;
  font-family: 'SF Mono', monospace;
  color: var(--fg);
}
.audit-kv b { color: var(--accent); font-weight: 600; }

/* === Table (trash) === */
table.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
table.data-table th, table.data-table td {
  text-align: left;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--border);
}
table.data-table th {
  font-weight: 600;
  color: var(--accent);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: rgba(15, 118, 110, 0.04);
}
table.data-table tr:hover td { background: rgba(15, 118, 110, 0.03); }

/* === Buttons === */
.btn {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-fg);
  border: none;
  padding: 0.4rem 0.95rem;
  border-radius: 8px; /* DEMO .btn 圆角 */
  cursor: pointer;
  font-size: 0.76rem;
  font-weight: 600;
  font-family: inherit;
  transition: all .2s;
}
.btn:hover {
  filter: brightness(1.15);
  box-shadow: var(--glow-cyan);
}
.btn.secondary {
  background: rgba(15, 118, 110, 0.06);
  color: var(--fg);
  border: 1px solid var(--border);
}
.btn.secondary:hover {
  border-color: var(--accent);
  color: var(--accent);
  filter: none;
  box-shadow: 0 0 8px rgba(15, 118, 110, 0.15);
}
.btn.danger {
  background: transparent;
  color: var(--audit-contradicted);
  border: 1px solid var(--audit-contradicted);
}
.btn.danger:hover {
  background: rgba(244, 63, 94, 0.1);
  box-shadow: 0 0 8px rgba(244, 63, 94, 0.2);
}

/* === Empty / Loading states === */
.empty, .loading {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--fg-muted);
  font-size: 0.88rem;
}
.empty .icon {
  font-size: 2rem;
  opacity: .5;
  margin-bottom: 0.75rem;
  display: block;
}
.loading {
  position: relative;
}
.loading::after {
  content: '';
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 0.5rem;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* === Footer === */
footer.app-footer {
  text-align: center;
  padding: 1.25rem;
  border-top: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 0.72rem;
  margin-top: 2.5rem;
  position: relative;
  z-index: 1;
}

/* === Misc === */
.pre-compact {
  background: rgba(15, 118, 110, 0.04);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.6rem;
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.74rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
  color: var(--fg);
}

/* === Markdown body (engram/synapse 内容渲染) ===
 * marked + DOMPurify 后的 HTML 在此容器内排版。
 * 限定常见 markdown 标签的样式,避免污染主 UI。
 */
.markdown-body {
  color: var(--fg);
  font-size: 0.85rem;
  line-height: 1.65;
  word-break: break-word;
}
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin: 1.2em 0 0.5em;
  line-height: 1.3;
  color: var(--fg);
}
.markdown-body h1 { font-size: 1.35em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
.markdown-body h2 { font-size: 1.2em; }
.markdown-body h3 { font-size: 1.05em; }
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 { font-size: 0.95em; color: var(--fg-muted, var(--fg)); }
.markdown-body p { margin: 0.6em 0; }
.markdown-body ul,
.markdown-body ol { margin: 0.5em 0; padding-left: 1.5em; }
.markdown-body li { margin: 0.2em 0; }
.markdown-body li > ul,
.markdown-body li > ol { margin: 0.2em 0; }
.markdown-body a {
  color: var(--accent-cool, #60a5fa);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.markdown-body a:hover { text-decoration-thickness: 2px; }
.markdown-body strong { font-weight: 700; }
.markdown-body em { font-style: italic; }
.markdown-body del { opacity: 0.7; }
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}
.markdown-body blockquote {
  margin: 0.6em 0;
  padding: 0.2em 0.8em;
  border-left: 3px solid var(--accent-cool, #60a5fa);
  color: var(--fg-muted, var(--fg));
  background: rgba(96, 165, 250, 0.06);
  border-radius: 0 4px 4px 0;
}
.markdown-body blockquote > :first-child { margin-top: 0; }
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body code {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
}
.markdown-body pre {
  background: rgba(15, 118, 110, 0.04);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.6rem;
  overflow-x: auto;
  margin: 0.6em 0;
}
.markdown-body pre code {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 0.8em;
  line-height: 1.5;
}
.markdown-body table {
  border-collapse: collapse;
  margin: 0.6em 0;
  font-size: 0.85em;
  display: block;
  overflow-x: auto;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid var(--border);
  padding: 0.35em 0.6em;
  text-align: left;
}
.markdown-body th { background: rgba(15, 118, 110, 0.08); font-weight: 700; }
.markdown-body img { max-width: 100%; border-radius: 4px; }
.importance-bar {
  display: inline-block;
  width: 60px;
  height: 5px;
  background: rgba(15, 118, 110, 0.10);
  border-radius: 3px;
  overflow: hidden;
  vertical-align: middle;
}
.importance-bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 6px rgba(94, 234, 212, 0.4);
}
.importance-chip {
  display: inline-block;
  padding: 1px 6px;
  margin-left: 0.35rem;
  font-size: 0.78em;
  font-weight: 600;
  border-radius: 8px;
  vertical-align: middle;
  cursor: help;
  border: 1px solid transparent;
}
.importance-chip.imp-high {
  color: var(--accent);
  background: rgba(94, 234, 212, 0.14);
  border-color: rgba(15, 118, 110, 0.35);
}
.importance-chip.imp-medium {
  color: var(--fg-muted);
  background: rgba(148, 163, 184, 0.12);
  border-color: rgba(148, 163, 184, 0.32);
}
.importance-chip.imp-low {
  color: var(--fg-muted);
  background: transparent;
  border-color: rgba(148, 163, 184, 0.22);
}
.importance-chip.imp-none {
  color: var(--fg-muted);
  background: transparent;
}

/* === Decay visualization (详情面板的衰退进度) === */
.decay-block {
  display: inline-block;
  vertical-align: middle;
  min-width: 180px;
  margin-left: 0.5rem;
}
.decay-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.3rem;
  font-size: 12px;
}
.decay-level {
  font-weight: 600;
  letter-spacing: 0.02em;
}
.decay-level.freshness-fresh { color: var(--accent); }
.decay-level.freshness-aging { color: var(--accent-warm); }
.decay-level.freshness-stale { color: #fb923c; }
.decay-level.freshness-forgotten { color: var(--fg-dim); }
.decay-countdown {
  color: var(--fg-muted);
  font-size: 11px;
}
.decay-bar {
  width: 100%;
  height: 6px;
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.decay-fill {
  height: 100%;
  transition: width .3s ease;
}
.decay-fill.freshness-fresh {
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 6px rgba(94, 234, 212, 0.4);
}
.decay-fill.freshness-aging {
  background: var(--accent-warm);
  box-shadow: 0 0 4px rgba(251, 191, 36, 0.4);
}
.decay-fill.freshness-stale {
  background: #fb923c;
  box-shadow: 0 0 4px rgba(251, 146, 60, 0.35);
}
.decay-fill.freshness-forgotten {
  background: var(--fg-dim);
}
.decay-empty {
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
}

/* === Config form === */
.config-section {
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem 1.4rem;
  margin-bottom: 1rem;
}
.config-section h3 {
  margin: 0 0 0.85rem;
  font-size: 0.78rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}
/* DEMO g2-config .fr:左标签列 170px + 右控件,hint 占第二行整行(2026-08 重设计) */
.config-row {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 0.75rem;
  align-items: center;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--border);
}
.config-row:last-child { border-bottom: none; }
.config-row .config-label {
  color: var(--fg-muted);
  font-size: 0.81rem;
}
.config-row .hint {
  grid-column: 2;
  color: var(--fg-dim);
  font-size: 0.72rem;
  margin-top: -0.35rem;
  line-height: 1.5;
}
.config-row .hint .runtime-diff {
  color: #B45309;
  margin-left: 0.4rem;
}
.config-row .config-control input[type=text],
.config-row .config-control input[type=number],
.config-row .config-control select {
  background: var(--panel-bg, #fff);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.38rem 0.62rem;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.81rem;
  width: 100%;
  max-width: 420px;
}
.config-row .config-control input:focus, .config-row .config-control select:focus {
  outline: none;
  border-color: var(--accent);
}
/* 下拉选项:纸面浅色主题用浅色选项(旧深藏青 #0a0f1f 是暗色主题残留) */
.config-row select option,
.drawer select option,
.filter-bar select option {
  background: #fff;
  color: var(--fg);
}
.config-row select option:checked,
.drawer select option:checked,
.filter-bar select option:checked {
  background: var(--accent-soft, #EDF7F5);
  color: var(--accent);
}

/* === Range slider (importance/weight/confidence editors) === */
.config-row input[type=range],
.drawer input[type=range],
.field input[type=range] {
  -webkit-appearance: none;
  appearance: none;
  width: 200px;
  height: 6px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  border-radius: 3px;
  outline: none;
  vertical-align: middle;
}
.config-row input[type=range]::-webkit-slider-thumb,
.drawer input[type=range]::-webkit-slider-thumb,
.field input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.5);
}
.config-row input[type=range]::-moz-range-thumb,
.drawer input[type=range]::-moz-range-thumb,
.field input[type=range]::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
}

/* === Toggle switch (runtime state editor) === */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
}
.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(148, 163, 184, 0.25);
  border: 1px solid var(--border);
  border-radius: 22px;
  transition: all .2s;
}
.toggle-slider::before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--fg-muted);
  border-radius: 50%;
  transition: all .2s;
}
.toggle-switch input:checked + .toggle-slider {
  background: rgba(94, 234, 212, 0.3);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.3);
}
.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(18px);
  background: var(--accent);
}
.toggle-state {
  font-size: 0.78rem;
  font-weight: 500;
}
.toggle-state.on { color: var(--accent); }
.toggle-state.off { color: var(--fg-muted); }
.config-row.readonly .config-label::after {
  content: '只读';
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.05rem 0.4rem;
  font-size: 0.65rem;
  background: rgba(15, 118, 110, 0.08);
  color: var(--fg-muted);
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  vertical-align: middle;
}
.config-row.readonly .config-control input,
.config-row.readonly .config-control select {
  background: rgba(15, 118, 110, 0.02);
  color: var(--fg-muted);
  cursor: not-allowed;
}
/* 保存栏(2026-08 重设计):旧深藏青渐变是暗色主题残留,页底一块黑影;
   改纸面浅色:同底色 + 顶部分隔线,主按钮在左(DEMO 顺序),右侧淡提示 */
.config-save-bar {
  position: sticky;
  bottom: 0;
  background: var(--bg);
  border-top: 1px solid var(--border);
  padding: 0.85rem 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.config-save-bar .save-bar-hint {
  margin-left: auto;
  font-size: 0.72rem;
  color: var(--fg-dim);
}

/* === Editable indicator === */
.edit-banner {
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.25);
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  font-size: 0.78rem;
  color: var(--accent-warm);
  margin-bottom: 1rem;
}

/* === Directory reveal banner(详情页「打开目录」操作反馈)=== */
/* 成功态(opened)用绿色、2.5s 自动消失;降级态(无桌面/命令缺失/目录不存在)
   用蓝色信息色并保留,内含目录绝对路径 + 复制按钮。 */
.dir-banner {
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.06), rgba(15, 118, 110, 0.04));
  border-left: 3px solid rgba(56, 189, 248, 0.45);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 2rem 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin-bottom: 1rem;
  line-height: 1.5;
  position: relative;
}
.dir-banner-success {
  background: linear-gradient(135deg, rgba(15, 118, 110, 0.08), rgba(34, 197, 94, 0.05));
  border-left-color: rgba(34, 197, 94, 0.5);
}
.dir-banner code {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent);
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  font-size: 0.85em;
  font-family: var(--font-mono, monospace);
}
.dir-banner-close {
  position: absolute;
  top: 0.3rem;
  right: 0.5rem;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  opacity: 0.55;
}
.dir-banner-close:hover {
  opacity: 1;
}
.pending-banner {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.06), rgba(139, 92, 246, 0.04));
  border-left: 3px solid rgba(99, 102, 241, 0.45);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.pending-banner-icon {
  font-size: 1.05rem;
  opacity: 0.65;
}

/* === Section-level banners (config tab 等) === */
/* 中性信息提示:运行时开关说明、dataRoot 只读说明等 */
.info-banner {
  background: linear-gradient(135deg, rgba(15, 118, 110, 0.05), rgba(56, 189, 248, 0.04));
  border-left: 3px solid rgba(56, 189, 248, 0.45);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin-bottom: 1rem;
  line-height: 1.5;
}
.info-banner code,
.info-banner kbd {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent);
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  font-size: 0.85em;
  font-family: var(--font-mono, monospace);
}

/* 操作成功:保存成功提示 */
.success-banner {
  background: linear-gradient(135deg, rgba(52, 211, 153, 0.08), rgba(15, 118, 110, 0.06));
  border-left: 3px solid rgba(52, 211, 153, 0.5);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: var(--accent);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 柔和警告:真正需要注意的场景(synapse kind 变更、dataRoot 路径无效等) */
.warn-banner {
  background: linear-gradient(135deg, rgba(251, 146, 60, 0.08), rgba(251, 191, 36, 0.05));
  border-left: 3px solid rgba(251, 146, 60, 0.5);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: #fbbf24;
  margin-bottom: 1rem;
  line-height: 1.5;
}

/* pending-banner 在 config tab 作为"重启生效"提示时的变体 */
.pending-banner.restart-banner {
  margin-bottom: 1rem;
}
.pending-banner.restart-banner .restart-now-btn {
  margin-left: auto;
  font-size: 0.78rem;
  padding: 0.3rem 0.7rem;
}
.pending-banner.restart-banner .restart-unavailable-hint {
  margin-left: auto;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}

/* 单个 toggle 的"待重启生效"chip(柔和提示,与 .pending-banner 同色调) */
.chip.restart-pending {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  font-size: 0.72rem;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.12);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.25);
  vertical-align: middle;
}
.edit-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

/* === Scrollbar === */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(15, 118, 110, 0.15);
  border-radius: 5px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(94, 234, 212, 0.3); }

/* === vis-network dark overrides === */
div.vis-tooltip {
  background: rgba(255, 255, 255, 0.97) !important;
  color: var(--fg) !important;
  border: 1px solid var(--border-strong) !important;
  border-radius: 4px !important;
  padding: 0.5rem 0.7rem !important;
  font-size: 0.78rem !important;
  box-shadow: var(--shadow-lift) !important;
}

/* === 视图切换按钮组(engrams 卡片/目录) === */
.view-toggle {
  display: inline-flex;
  gap: 0.15rem;
  padding: 0.15rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.04);
}
.view-toggle button {
  padding: 0.25rem 0.7rem;
  font-size: 0.8rem;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  border-radius: 4px;
}
.view-toggle button.active {
  background: rgba(15, 118, 110, 0.15);
  color: var(--accent);
}

/* === 目录视图(engrams tree) === */
.tree-view {
  background: rgba(148, 163, 184, 0.04);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}
.tree-view details { margin: 0.15rem 0; }
.tree-view summary {
  cursor: pointer;
  padding: 0.35rem 0.25rem;
  font-weight: 500;
  font-size: 0.9rem;
  border-radius: 4px;
  user-select: none;
  list-style: none;
}
.tree-view summary::-webkit-details-marker { display: none; }
.tree-view summary:hover { background: rgba(15, 118, 110, 0.06); }
.tree-view summary::before {
  content: '▸';
  display: inline-block;
  width: 1rem;
  color: var(--fg-muted);
  transition: transform 0.15s;
}
.tree-view details[open] > summary::before { transform: rotate(90deg); }
.tree-group > summary { font-size: 0.95rem; font-weight: 600; }
.tree-subgroup > summary { padding-left: 1.5rem; font-size: 0.85rem; color: var(--fg); }
.tree-folder-icon { margin-right: 0.35rem; }
.tree-count {
  display: inline-block;
  padding: 0 0.4rem;
  font-size: 0.7rem;
  color: var(--fg-muted);
  background: rgba(148, 163, 184, 0.12);
  border-radius: 8px;
  margin-left: 0.4rem;
}
.tree-group-body {
  padding-left: 0.5rem;
  border-left: 1px dashed var(--border);
  margin-left: 0.5rem;
}
.tree-leaf-group { padding-left: 2.5rem; }
.tree-leaf {
  padding: 0.3rem 0.5rem;
  cursor: pointer;
  font-size: 0.85rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.tree-leaf:hover { background: rgba(15, 118, 110, 0.10); color: var(--accent); }

/* path-tree 新版样式(2026-07) */
.tree-leaf-dir {
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: 4px;
}
.tree-leaf-dir:hover { background: rgba(15, 118, 110, 0.06); }
.tree-dir-name { color: var(--fg-bright); }
.tree-direct {
  display: inline-block;
  padding: 0 0.4rem;
  font-size: 0.65rem;
  color: var(--accent);
  background: rgba(15, 118, 110, 0.12);
  border-radius: 8px;
  margin-left: 0.3rem;
}

/* 目录内联展开的直属文件行(2026-07) */
.tree-direct-files { margin: 0.15rem 0 0.25rem 0.15rem; }
.tree-file {
  padding: 0.28rem 0.5rem;
  font-size: 0.82rem;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fg);
}
.tree-file:hover { background: rgba(15, 118, 110, 0.08); color: var(--accent); }
.tree-file-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-file-meta {
  flex: 0 0 auto;
  font-size: 0.68rem;
  color: var(--fg-muted);
  white-space: nowrap;
}
.tree-more { margin: 0.25rem 0.5rem; }

/* === 2026-08 印迹卡片信息密度 + 整体目录树(DEMO g2-engrams)=== */
/* 卡片解剖:.c-head 徽标行 / .c-sum 两行摘要 / .c-tags / .c-foot 五要素脚注 */
.e-card { display: flex; flex-direction: column; gap: 0.45rem; }
.c-head { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.c-head .kd { font-size: 0.68rem; font-weight: 700; border-radius: 5px; padding: 1px 8px; }
.c-state { margin-left: auto; font-size: 0.68rem; font-weight: 600; color: var(--fg-dim); }
.c-state.ver-verified { color: #0F766E; }
.c-state.ver-probable { color: #0E7490; }
.c-state.ver-plausible { color: #B45309; }
.c-state.ver-refuted { color: #DC2626; }
.c-sum {
  font-size: 0.78rem;
  color: var(--fg-dim);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.c-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; }
.tg {
  font-size: 0.68rem;
  color: var(--fg-dim);
  background: #F5F2EC;
  border-radius: 5px;
  padding: 0 7px;
}
.c-foot {
  display: flex;
  gap: 0.75rem;
  font-size: 0.7rem;
  color: var(--fg-dim);
  align-items: center;
  border-top: 1px dashed var(--border);
  padding-top: 0.5rem;
  margin-top: auto;
  flex-wrap: wrap;
}
.c-foot .imp { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--fg-muted); cursor: help; }
.syn-n { color: var(--fg-dim); }
.t-up { color: var(--accent); }
.t-flat { color: var(--fg-dim); }
.t-down { color: #B45309; }

/* 整体目录树:根节点行 + 组统计头 + leaf 元数据 */
.tree-view summary { display: flex; align-items: center; gap: 0.3rem; }
.tree-view summary .tmeta { margin-left: auto; display: flex; gap: 0.55rem; font-size: 0.68rem; color: var(--fg-dim); white-space: nowrap; }
.tree-view summary .tmeta b { color: var(--fg-muted); }
.tree-root > summary { font-size: 1rem; }
.tree-root > summary .tree-dir-name.root { font-weight: 700; }
.tree-avg { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.tree-file .kd2 {
  width: 8px;
  height: 8px;
  border-radius: 3px;
  flex: 0 0 auto;
  align-self: center;
}
.tree-file .leaf-m { display: flex; gap: 0.6rem; font-size: 0.68rem; color: var(--fg-dim); white-space: nowrap; }
.tree-file .leaf-m .imp2 { font-variant-numeric: tabular-nums; color: var(--fg-muted); }

/* === 2026-08 技能卡片解剖(DEMO g2-skills .sk)=== */
.card.sk { display: flex; flex-direction: column; gap: 0.5rem; }
.sk-head { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
.sk-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--fg-bright, var(--fg));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.sk-head .chip { font-size: 0.65rem; font-weight: 700; padding: 1px 8px; }
.sk-desc {
  font-size: 0.78rem;
  color: var(--fg-dim);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.util-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem; color: var(--fg-dim); }
.util-row b { font-variant-numeric: tabular-nums; }
.util-b { flex: 1; height: 7px; background: #F0EDE7; border-radius: 4px; overflow: hidden; }
.util-f { display: block; height: 100%; border-radius: 4px; }
.sk-meta { display: flex; gap: 0.7rem; font-size: 0.7rem; color: var(--fg-dim); flex-wrap: wrap; }
.sk-meta .ok { color: var(--accent); }
.sk-meta .fail { color: #B45309; }
.sk-extra { display: flex; gap: 0.35rem; flex-wrap: wrap; border-top: 1px dashed var(--border); padding-top: 0.45rem; margin-top: auto; }
.ex {
  font-size: 0.65rem;
  color: var(--fg-dim);
  background: #F5F2EC;
  border-radius: 5px;
  padding: 0 7px;
}
.ex code { font-size: 0.65rem; background: none; }

/* === 2026-08 治理页页头(DEMO 各 tab h1 + sub)=== */
/* 回收站行卡片(DEMO g2-trash .t-row) */
.t-row {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--border);
}
.t-row:last-child { border-bottom: none; }
.t-row:hover { background: rgba(15, 118, 110, 0.03); }
.t-row .t-body { flex: 1; min-width: 0; }
.t-row .t-t { font-weight: 600; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-row .t-s { font-size: 0.72rem; color: var(--fg-dim); margin-top: 2px; }
.t-row .days { font-size: 0.72rem; color: var(--fg-dim); white-space: nowrap; }
.t-row .days b { display: inline; font-size: 0.95rem; color: var(--accent-warm); font-variant-numeric: tabular-nums; }
.tag {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  border-radius: 5px;
  padding: 1px 8px;
}

/* === 治理页页头 === */
/* === 夜思实验室(incubations,2026-08 重设计:纸面主题,去内联样式) === */
.inc-notice { margin-bottom: 0.9rem; }
.inc-sow-card { margin-bottom: 1.1rem; padding: 1rem 1.2rem; }
.inc-sow-title { margin: 0 0 0.7rem; font-size: 0.92rem; color: var(--accent); font-weight: 700; }
.inc-form { display: flex; flex-direction: column; gap: 0.6rem; }
.inc-form textarea {
  font: inherit; font-size: 0.88rem; width: 100%; resize: vertical;
  border: 1px solid var(--border); border-radius: 8px; padding: 0.55rem 0.7rem;
  background: var(--panel-bg, #fff); color: var(--fg); line-height: 1.6;
}
.inc-form textarea:focus { outline: none; border-color: var(--accent); }
.inc-form-row { display: flex; gap: 0.7rem; align-items: center; flex-wrap: wrap; }
.inc-form-row input[type=text] {
  flex: 1; min-width: 240px; font: inherit; font-size: 0.82rem;
  border: 1px solid var(--border); border-radius: 8px; padding: 0.38rem 0.62rem;
  background: var(--panel-bg, #fff); color: var(--fg);
}
.inc-form-row input[type=text]:focus { outline: none; border-color: var(--accent); }
.inc-web-toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--fg-muted); white-space: nowrap; }
.inc-form-actions { display: flex; align-items: center; gap: 0.75rem; }
.inc-form-actions .hint { font-size: 0.72rem; color: var(--fg-dim); }
.inc-empty { text-align: center; padding: 2.4rem 0; color: var(--fg-dim); font-size: 0.85rem; }
.inc-empty .icon { font-size: 1.8rem; margin-bottom: 0.4rem; }
.inc-card { margin-bottom: 0.8rem; padding: 0.95rem 1.1rem; }
.inc-card-head { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 0.45rem; }
.inc-card-head .card-title { flex: 1; min-width: 0; margin: 0; }
.inc-st.st-active { color: var(--accent); background: var(--accent-soft, #EDF7F5); }
.inc-st.st-flight { color: #B45309; background: #FDF3E3; }
.inc-st.st-resolve { color: #7163C4; background: #EFEDF8; }
.inc-st.st-dim { color: var(--fg-dim); background: var(--chip-bg); }
.inc-hatched { font-size: 0.72rem; color: var(--fg-dim); }
.inc-job { margin-bottom: 0.4rem; font-size: 0.8rem; }
/* in-flight 过程信息:呼吸点 + 开始时间 + 阶段说明 */
.inc-progress { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.45rem; padding: 0.5rem 0.7rem; background: #FDF3E3; border: 1px solid rgba(180, 83, 9, 0.2); border-radius: 8px; font-size: 0.78rem; color: #B45309; }
.inc-progress-dot { width: 8px; height: 8px; border-radius: 50%; background: #B45309; align-self: center; animation: inc-breath 1.6s ease-in-out infinite; }
@keyframes inc-breath { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .inc-progress-dot { animation: none; } }
.inc-progress-hint { flex-basis: 100%; color: #8B857B; font-size: 0.72rem; line-height: 1.5; }
.btn.mini.disabled, .btn.disabled { opacity: 0.45; cursor: not-allowed; }
.inc-card-acts { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
.inc-last-round { margin-top: 0.45rem; padding: 0.5rem 0.7rem; background: var(--chip-bg, #F0EDE7); border-radius: 8px; font-size: 0.78rem; }
.inc-last-round .ilr-h { font-weight: 600; color: var(--fg-muted); font-size: 0.72rem; margin-bottom: 0.25rem; }
.inc-last-round .ilr-s { color: var(--fg); line-height: 1.55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inc-last-round .ilr-s.ilr-none { color: var(--fg-dim); font-style: italic; }
.inc-timeline { margin-top: 0.6rem; }
.inc-timeline summary { cursor: pointer; font-size: 0.85rem; color: var(--fg-muted); }
.inc-timeline ul { padding-left: 1.1rem; font-size: 0.84rem; line-height: 1.6; margin: 0.4rem 0 0; }
.inc-archived { margin-top: 0.9rem; }
.inc-archived summary { cursor: pointer; color: var(--fg-dim); font-size: 0.82rem; }

/* === 帮助页(DEMO g2-help:四卡快速上手 + 深入参考折叠) === */
.help-card { margin-bottom: 0.65rem; padding: 0.95rem 1.15rem; }
.help-card .h2 { font-size: 0.95rem; margin: 0 0 0.5rem; font-weight: 700; }
.help-card p { font-size: 0.82rem; color: var(--fg-muted); line-height: 1.7; margin: 0 0 0.4rem; }
.help-card p:last-child { margin-bottom: 0; }
.help-card ul, .help-card ol { padding-left: 1.2rem; font-size: 0.82rem; color: var(--fg-muted); line-height: 1.7; }
.help-card li { margin-bottom: 0.25rem; }
.help-card code { font-family: ui-monospace, Consolas, monospace; font-size: 0.75rem; background: #F0EDE7; border-radius: 4px; padding: 0 5px; }
.kbd { display: inline-block; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; font-size: 0.72rem; background: var(--panel-bg, #fff); font-family: inherit; color: var(--fg); }
.help-ref { background: var(--panel-bg, #fff); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 0.5rem; }
.help-ref > summary { cursor: pointer; padding: 0.7rem 1.05rem; font-size: 0.85rem; font-weight: 600; color: var(--fg); list-style: none; }
.help-ref > summary::before { content: '▸'; margin-right: 0.5rem; color: var(--fg-dim); }
.help-ref[open] > summary::before { content: '▾'; }
.help-ref-body { padding: 0 1.05rem 0.9rem; font-size: 0.82rem; color: var(--fg-muted); line-height: 1.7; }
.help-ref-body p { margin: 0 0 0.5rem; }
.help-ref-body ul, .help-ref-body ol { padding-left: 1.2rem; }
.help-ref-body li { margin-bottom: 0.3rem; }
.help-dl dt { font-weight: 600; color: var(--fg); margin-top: 0.5rem; }
.help-dl dd { margin: 0.1rem 0 0.3rem; }
.help-ref-jump { color: var(--accent); cursor: pointer; }
.help-ref-jump:hover { text-decoration: underline; }

/* 提案卡 REM 族徽标(2026-08 统一纸面风格,替换旧紫色 #a78bfa):
   洞察=琥珀(夜思/梦境族语义,与 .inc-progress/.st-flight 同色系);
   模式=青绿 soft;critic 三档=深色可读语义色(旧 #34d399/#fbbf24 是
   暗底亮色,浅纸上刺眼) */
.chip.insight-chip { background: #FDF3E3; color: #B45309; border-color: rgba(180, 83, 9, 0.25); }
.chip.moon-chip { background: var(--accent-soft, #EDF7F5); color: var(--accent, #0F766E); border-color: rgba(15, 118, 110, 0.25); }
.chip.critic-hi { background: rgba(14, 159, 110, 0.10); color: #0E9F6E; }
.chip.critic-mid { background: rgba(180, 83, 9, 0.10); color: #B45309; }
.chip.critic-lo { background: rgba(224, 36, 36, 0.08); color: #E02424; }

/* 提案卡来源彩色小徽标(DEMO g2-proposals .src) */
.proposal-source-line { font-size: 0.78rem; color: var(--fg-muted); margin: 0.2rem 0 0.35rem; display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
.src-badge { font-size: 10.5px; font-weight: 600; border-radius: 5px; padding: 1px 8px; }
.src-badge.src-ext { background: #EEF3FE; color: #2563EB; }
.src-badge.src-conv { background: #EFEDF8; color: #7163C4; }
.src-badge.src-auto { background: #F0EDE7; color: #6A655D; }
.src-badge.src-skill { background: #FDF3E3; color: #B45309; }

/* 合并 tab(DEMO g2-merges:摘要行 + .mg 冲突行卡) */
.mg-summary { font-size: 0.82rem; color: var(--fg-muted); margin: 0 0 0.8rem; }
.mg-summary b { color: var(--accent); font-weight: 600; }
.mg-card { margin-bottom: 0.7rem; padding: 0.9rem 1.1rem; }
.mg-card h3 { margin: 0 0 0.6rem; font-size: 0.85rem; font-weight: 700; }
.mg { padding: 0.6rem 0; border-bottom: 1px solid var(--border); }
.mg:last-child { border-bottom: none; }
.mg-t { font-size: 0.82rem; font-weight: 600; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
.mg-s { font-size: 0.72rem; color: var(--fg-dim); margin: 0.15rem 0 0.35rem; }

.page-h { font-size: 1.45rem; margin: 0 0 0.2rem; letter-spacing: -0.01em; }
.page-sub { font-size: 0.78rem; color: var(--fg-dim); margin-bottom: 1.1rem; }

/* === 2026-08 梦境睡眠报告(DEMO g2-dream)=== */
.slp-head { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.6rem; }
.slp-head .when { font-size: 0.78rem; color: var(--fg-dim); flex: 1; min-width: 200px; }
.slp-head .nums { display: flex; gap: 1.2rem; flex-wrap: wrap; }
.slp-head .nm { text-align: center; }
.slp-head .nm b { display: block; font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.slp-head .nm span { font-size: 0.68rem; color: var(--fg-dim); }
.c-ac { color: var(--accent); }
.c-rd { color: #BE3B3B; }
.c-am { color: var(--accent-warm); }
.c-pu { color: #7163C4; }
.slp-h { font-size: 1.02rem; margin: 1.1rem 0 0.5rem; }
.slp-h small { font-weight: 400; font-size: 0.72rem; color: var(--fg-dim); margin-left: 0.4rem; }
.slp-card { padding: 0.6rem 0.9rem; margin-bottom: 0.45rem; }
.slp-card .ct { display: flex; gap: 0.7rem; align-items: baseline; }
.slp-card .delta { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 0.78rem; }

/* === 2026-08 提案勾选批量 + 5 秒撤销 toast(DEMO g2-proposals)=== */
/* 勾选框置于左上角并为卡片内容让位(2026-08-15 修复:原右上角与标题/状态
   chip 重合)。padding-left 只在可勾选卡片上生效。 */
.prop-selectable { position: relative; padding-left: 2.1rem; }
.prop-check {
  position: absolute;
  top: 0.7rem;
  left: 0.55rem;
  z-index: 2;
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent);
  cursor: pointer;
}
#prop-select-bar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  background: var(--accent-soft, rgba(15, 118, 110, 0.08));
  border: 1px solid var(--border);
  border-radius: 8px;
}
.undo-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.6rem 1rem;
  background: rgba(45, 42, 38, 0.92);
  color: #FBFAF8;
  border-radius: 10px;
  font-size: 0.82rem;
  box-shadow: 0 8px 24px rgba(45, 42, 38, 0.25);
  animation: fade-in 0.2s ease-out;
}
.btn.mini {
  padding: 0.15rem 0.5rem;
  font-size: 0.7rem;
  background: rgba(15, 118, 110, 0.08);
  border: 1px solid var(--border);
  color: var(--accent);
  border-radius: 4px;
  cursor: pointer;
  margin-left: 0.4rem;
  font-family: inherit;
}
.btn.mini:hover { background: rgba(94, 234, 212, 0.18); border-color: var(--accent); }

/* === 贡献者排名表格 === */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.data-table th, .data-table td {
  padding: 0.4rem 0.6rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.data-table th {
  font-weight: 600;
  color: var(--fg-muted);
  font-size: 0.8rem;
  background: rgba(148, 163, 184, 0.05);
}

/* === 突触编辑器:optgroup 分组样式 === */
.drawer select optgroup {
  background: rgba(10, 15, 31, 1);
  color: var(--accent);
  font-weight: 600;
  font-style: normal;
}
.drawer select option {
  background: rgba(10, 15, 31, 1);
  color: var(--fg);
  padding-left: 0.8rem;
}

/* Health tab (ROI #1) — 与 co-engram status CLI 共用 computeStatus 真相源 */
.meta-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1rem;
  margin: 0;
}
.meta-grid dt {
  color: var(--muted, #94a3b8);
  font-size: 0.85rem;
}
.meta-grid dd {
  margin: 0;
  word-break: break-all;
}
.health-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  min-width: 3.5rem;
  text-align: center;
}
.health-ok {
  background: rgba(94, 234, 212, 0.18);
  color: #5eead4;
  border: 1px solid rgba(15, 118, 110, 0.35);
}
.health-warn {
  background: rgba(250, 204, 21, 0.18);
  color: #facc15;
  border: 1px solid rgba(250, 204, 21, 0.35);
}
.health-error {
  background: rgba(248, 113, 113, 0.18);
  color: #f87171;
  border: 1px solid rgba(248, 113, 113, 0.4);
}
.health-info {
  background: rgba(96, 165, 250, 0.18);
  color: #60a5fa;
  border: 1px solid rgba(96, 165, 250, 0.35);
}
.health-check-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0 0;
}
.health-check-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.health-check-item:last-child {
  border-bottom: none;
}
.health-check-body {
  flex: 1;
  min-width: 0;
}
.health-check-label {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.15rem;
}
.health-check-message {
  color: var(--fg);
  font-size: 0.85rem;
}
.health-check-detail {
  margin: 0.4rem 0 0 0;
  padding: 0.5rem 0.65rem;
  background: rgba(148, 163, 184, 0.08);
  border-radius: 4px;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--muted, #94a3b8);
}

/* warn/error 可展开 details(problem 卡片) */
.health-check-problem {
  flex-direction: column;
}
.health-check-details > summary {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  cursor: pointer;
  list-style: none;
}
.health-check-details > summary::-webkit-details-marker {
  display: none;
}
.health-check-details[open] > summary {
  margin-bottom: 0.5rem;
}
.health-check-expand-hint {
  margin-left: auto;
  align-self: center;
  color: var(--muted, #94a3b8);
  font-size: 0.75rem;
  white-space: nowrap;
}
.health-check-details[open] .health-check-expand-hint::after {
  content: " ▾";
}
.health-check-details:not([open]) .health-check-expand-hint::after {
  content: " ▸";
}
.health-check-expand-body {
  padding: 0.5rem 0 0 0;
  margin-left: 0;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.health-why-block,
.health-fix-block {
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.06);
  border-left: 3px solid rgba(148, 163, 184, 0.35);
}
.health-fix-block {
  border-left-color: rgba(94, 234, 212, 0.5);
}
.health-why-label,
.health-fix-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted, #94a3b8);
  margin-bottom: 0.3rem;
}
.health-why-text {
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--fg);
}
.health-fix-desc {
  font-size: 0.85rem;
  color: var(--fg);
  margin-bottom: 0.45rem;
}
.health-fix-cmd-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.health-fix-cmd {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  background: rgba(15, 23, 42, 0.45);
  padding: 0.4rem 0.55rem;
  border-radius: 4px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  word-break: break-all;
  color: #5eead4;
}
.btn-mini {
  font-size: 0.72rem;
  padding: 0.3rem 0.55rem;
  border-radius: 4px;
  background: rgba(15, 118, 110, 0.12);
  border: 1px solid rgba(94, 234, 212, 0.3);
  color: #5eead4;
  cursor: pointer;
  white-space: nowrap;
}
.btn-mini:hover {
  background: rgba(94, 234, 212, 0.22);
}
.health-fix-tool {
  margin-top: 0.4rem;
  font-size: 0.78rem;
  color: var(--muted, #94a3b8);
}
.health-fix-tool code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #c084fc;
}

/* doctor 联动卡片 */
.health-doctor-card {
  margin-top: 1rem;
}
.health-doctor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.health-doctor-kpis {
  display: flex;
  gap: 0.75rem;
  margin: 0.75rem 0;
  flex-wrap: wrap;
}
.health-doctor-kpi {
  padding: 0.45rem 0.75rem;
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.08);
  font-size: 0.85rem;
}
.health-doctor-kpi strong {
  margin-right: 0.3rem;
  font-size: 1rem;
}
.health-doctor-issue {
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  background: rgba(250, 204, 21, 0.06);
  border-left: 3px solid rgba(250, 204, 21, 0.4);
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.health-doctor-issue-kind {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #94a3b8);
}
.health-doctor-issue-msg {
  margin: 0.2rem 0 0.4rem 0;
  color: var(--fg);
  line-height: 1.45;
}
.health-doctor-nextaction {
  font-size: 0.8rem;
  color: var(--muted, #94a3b8);
}
.health-doctor-nextaction code {
  color: #5eead4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
`;
