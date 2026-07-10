/**
 * Viewer v2 CSS — 神经元进化主题。
 *
 * 设计理念(2026-07 视觉深度重塑):
 * - 单色相:神经青 #5DECD9 为主,月白/雾灰为中性,朱砂仅用于 contradicts 语义
 * - 衬线高雅:系统衬线字体栈(Iowan/Baskerville/思源宋体),无 CDN 依赖
 * - 动效贯穿:呼吸/放电/极光/球体脉动 —— 不再只在 logo
 * - 大量负空间:容器内边距 +50%,克制信息密度
 *
 * @module @co-engram/claude-code/viewer
 */

export const VIEWER_CSS = `
:root {
  color-scheme: dark;
  /* 基础 - 深空 */
  --bg-deep: #050816;
  --bg: #0a0e1f;
  --bg-elev: #0f1530;

  /* 前景 - 月白/雾灰(去蓝化,显高雅) */
  --fg: #e8e6e1;
  --fg-bright: #f8fafc;
  --fg-muted: #8b92a8;
  --fg-dim: #4a5378;

  /* 主色 - 神经青单色 */
  --accent: #5DECD9;
  --accent-soft: rgba(93, 236, 217, 0.18);
  --accent-warm: #d4af37;     /* 古金(原琥珀 #d4af37) */
  --accent-fg: #050816;

  /* 边框 - 神经青派生 */
  --border: rgba(93, 236, 217, 0.10);
  --border-strong: rgba(93, 236, 217, 0.22);
  --border-glow: rgba(93, 236, 217, 0.45);

  /* 容器 */
  --panel-bg: rgba(15, 21, 48, 0.55);
  --panel-bg-solid: #0f1530;
  --panel-bg-alt: rgba(93, 236, 217, 0.04);
  --chip-bg: rgba(93, 236, 217, 0.08);

  /* Shadow/Glow - 神经青统一(移除 --glow-purple) */
  --shadow: 0 0 0 1px rgba(93,236,217,.06), 0 2px 8px rgba(0,0,0,.3);
  --shadow-lift: 0 0 0 1px rgba(93,236,217,.15), 0 12px 32px rgba(0,0,0,.5), 0 0 32px rgba(93,236,217,.08);
  --glow-cyan: 0 0 16px rgba(93, 236, 217, 0.35);

  --radius: 6px;
  --radius-lg: 12px;

  /* SynapseFamily - 神经青明度阶(原 5 色改单色阶) */
  --fam-structural: #5DECD9;    /* 主色 */
  --fam-causal: #93f3e7;         /* 浅一档 */
  --fam-evidential: #3a9c8f;     /* 深一档 */
  --fam-temporal: #c0c8d4;       /* 中性银 */
  --fam-modulatory: #6b7693;     /* 雾灰 */
  --fam-contradicts: #b8405a;    /* 唯一对比色 - 朱砂 */

  /* EngramKind - 神经青明度阶 */
  --kind-fact: #5DECD9;
  --kind-observation: #93f3e7;
  --kind-pattern: #c0c8d4;
  --kind-procedure: #d4af37;     /* 古金 */
  --kind-hypothesis: #b8405a;    /* 朱砂 */

  /* Audit - 同色系收敛 */
  --audit-state: #93f3e7;
  --audit-effective: #5DECD9;
  --audit-contradicted: #b8405a;
  --audit-proposal: #c0c8d4;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-weight: 300;
  margin: 0;
  color: var(--fg);
  line-height: 1.65;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(ellipse 80% 50% at 20% 0%, rgba(93, 236, 217, 0.06), transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 100%, rgba(93, 236, 217, 0.04), transparent 60%),
    radial-gradient(ellipse 100% 60% at 50% 50%, rgba(15, 21, 48, 0.4), transparent 70%),
    var(--bg-deep);
  background-attachment: fixed;
  min-height: 100vh;
}

/* === 字体系统(系统衬线栈,无 CDN 依赖)==
 * 标题:衬线高雅(Iowan/Baskerville/思源宋体),中英双覆盖
 * 正文:Inter Light 300,呼吸感(行距 1.65)
 * 数字/代码:保留等宽,可读性
 */
h1, h2, h3, .serif {
  font-family: 'Iowan Old Style', 'Apple Garamond', 'Baskerville',
               'Source Han Serif CN', 'Songti SC', 'STSong',
               'Noto Serif CJK SC', serif;
  font-weight: 400;
  letter-spacing: 0.01em;
}
code, .mono, .kpi-value {
  font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
}

/* 神经元星图背景(替换原 grid 网格)—— 多密度星点 + 缓慢漂移 */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(1px 1px at 20% 30%, rgba(93, 236, 217, 0.90), transparent 50%),
    radial-gradient(1px 1px at 60% 70%, rgba(93, 236, 217, 0.70), transparent 50%),
    radial-gradient(1px 1px at 80% 20%, rgba(139, 146, 168, 0.60), transparent 50%),
    radial-gradient(2px 2px at 40% 80%, rgba(93, 236, 217, 0.45), transparent 60%),
    radial-gradient(1px 1px at 90% 50%, rgba(93, 236, 217, 0.80), transparent 50%),
    radial-gradient(1px 1px at 10% 60%, rgba(139, 146, 168, 0.50), transparent 50%),
    radial-gradient(1px 1px at 50% 10%, rgba(93, 236, 217, 0.75), transparent 50%),
    radial-gradient(1.5px 1.5px at 30% 50%, rgba(93, 236, 217, 0.55), transparent 55%),
    radial-gradient(1px 1px at 70% 40%, rgba(139, 146, 168, 0.45), transparent 50%),
    radial-gradient(1px 1px at 15% 85%, rgba(93, 236, 217, 0.65), transparent 50%),
    radial-gradient(1px 1px at 85% 75%, rgba(139, 146, 168, 0.55), transparent 50%),
    radial-gradient(2px 2px at 55% 25%, rgba(93, 236, 217, 0.40), transparent 60%);
  background-size: 800px 600px;
  background-repeat: repeat;
  opacity: 0.55;
  animation: stars-drift 120s linear infinite;
  mask-image: radial-gradient(ellipse at center, black 30%, transparent 90%);
  -webkit-mask-image: radial-gradient(ellipse at center, black 30%, transparent 90%);
}
@keyframes stars-drift {
  0%   { background-position: 0 0; }
  100% { background-position: 800px 600px; }
}
@media (prefers-reduced-motion: reduce) {
  body::before { animation: none; }
}

/* === Layout === */
header.app-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: linear-gradient(180deg, rgba(10, 14, 31, 0.92) 0%, rgba(10, 14, 31, 0.78) 100%);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  border-bottom: 1px solid var(--border);
  padding: 0.85rem 1.5rem;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
}
header.app-header h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 500;
  display: inline-block;
  background: linear-gradient(90deg, #c0c8d4 0%, #5DECD9 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: 0.02em;
}
/* (h1::before 的 ◉ 装饰已由 .brand-logo 中的真实 logo 取代) */
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.7rem;
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  line-height: 1.15;
}
.brand-slogan {
  font-size: 1.05rem;
  font-weight: 400;
  color: var(--fg-muted);
  letter-spacing: 0.04em;
  opacity: 0.85;
  /* 不继承 h1 的渐变文字色 */
  -webkit-text-fill-color: var(--fg-muted);
}
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 94.5px;
  height: 94.5px;
  flex-shrink: 0;
}
.brand-logo svg {
  width: 100%;
  height: 100%;
  display: block;
  animation: brand-breathe 4s ease-in-out infinite;
}
/* 呼吸灯效果:opacity + 神经青 drop-shadow 同步脉动,模拟"记忆印迹在呼吸" */
@keyframes brand-breathe {
  0%, 100% {
    opacity: 0.82;
    filter: drop-shadow(0 0 3px rgba(93, 236, 217, 0.25)) drop-shadow(0 0 6px rgba(232, 230, 225, 0.15));
  }
  50% {
    opacity: 1;
    filter: drop-shadow(0 0 8px rgba(93, 236, 217, 0.55)) drop-shadow(0 0 16px rgba(147, 243, 231, 0.40));
  }
}

/* === 神经元动效系列 ===
 * 呼吸 / 放电 / 极光 / 球体脉动 —— 全部以神经青为主调,贯穿全页。
 * commit 2 会把这些 keyframes 应用到具体选择器(.kpi / .tab.active / .kpi-value / .hero-orb)。
 * 循环周期 ≥ 4s,transform/opacity 走 GPU;prefers-reduced-motion 下全部关闭。
 */
@keyframes synapse-pulse {
  0%, 100% { transform: scaleX(0.6); opacity: 0.4; }
  50%      { transform: scaleX(1);   opacity: 1; }
}
@keyframes orb-pulse {
  0%, 100% { transform: scale(1);    filter: drop-shadow(0 0 8px rgba(93,236,217,0.30)); }
  50%      { transform: scale(1.05); filter: drop-shadow(0 0 24px rgba(93,236,217,0.60)); }
}
@media (prefers-reduced-motion: reduce) {
  .brand-logo svg { animation: none; }
}
/* 浅色系统主题:隐藏 dark 版 logo */
.brand-logo-dark { display: none; }
/* 深色系统主题:切换为 dark 版 logo */
@media (prefers-color-scheme: dark) {
  .brand-logo-light { display: none; }
  .brand-logo-dark { display: inline-flex; }
}
header.app-header nav.primary-nav {
  display: inline-flex;
  gap: 0.15rem;
  margin-left: 1.5rem;
  flex-wrap: wrap;
}
.header-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
}

/* === Hero section(神经元进化主题)===
 * header 与 main 之间的中央神经节点装饰区,纯视觉无交互逻辑。
 *   - 中央神经节(8 条放射突触 + 8 个外圈节点 + 中央实心点 + 脉动光晕)
 *   - 标语:衬线 italic 月白,中文用思源宋体,英文用 Iowan/Baskerville
 *   - 大量负空间:整体上下 padding 1.2rem,克制信息密度
 * 响应 prefers-reduced-motion:orb-pulse 关闭,只剩静态 SVG。
 */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 1.2rem 1rem 0.6rem;
  position: relative;
  z-index: 1;
}
.hero-orb {
  width: 84px;
  height: 84px;
  animation: orb-pulse 6s ease-in-out infinite;
}
.hero-orb-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.hero-tagline {
  margin: 0;
  font-size: 0.92rem;
  font-style: italic;
  color: var(--fg-muted);
  letter-spacing: 0.02em;
  text-align: center;
  opacity: 0.85;
}
@media (prefers-reduced-motion: reduce) {
  .hero-orb { animation: none; }
}
.tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg-muted);
  padding: 0.4rem 0.85rem;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 500;
  transition: all .2s;
  position: relative;
  font-family: inherit;
}
.tab:hover {
  background: var(--chip-bg);
  color: var(--accent);
}
.tab.active {
  background: linear-gradient(135deg, rgba(93, 236, 217, 0.12), rgba(147, 243, 231, 0.04));
  color: var(--accent);
  border-color: var(--border-strong);
  box-shadow: inset 0 0 0 1px rgba(93, 236, 217, 0.15);
}
.tab.active::after {
  content: '';
  position: absolute;
  left: 20%;
  right: 20%;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  transform-origin: center;
  animation: synapse-pulse 3s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tab.active::after { animation: none; }
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
  color: #050816;
  background: linear-gradient(135deg, #5DECD9 0%, #93f3e7 100%);
  border-radius: 999px;
  box-shadow: 0 0 0 2px rgba(10, 14, 31, 0.85), 0 0 10px rgba(93, 236, 217, 0.55);
  animation: tab-badge-pulse 2.4s ease-in-out infinite;
  vertical-align: middle;
}
.tab-badge[hidden] { display: none; }
@keyframes tab-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(10, 14, 31, 0.85), 0 0 6px rgba(93, 236, 217, 0.45); }
  50%      { box-shadow: 0 0 0 2px rgba(10, 14, 31, 0.85), 0 0 16px rgba(93, 236, 217, 0.85); }
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
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(93, 236, 217, 0.08);
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
/* 当某个二级 tab 处于 active 时,触发器上加一个圆点提示用户「当前页在更多里」 */
.more-menu.has-active .more-menu-trigger::after {
  content: '';
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
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
  background: rgba(93, 236, 217, 0.05);
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
  box-shadow: 0 0 0 2px rgba(93, 236, 217, 0.15);
}

main {
  max-width: 1400px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 3rem;
  position: relative;
  z-index: 1;
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
  box-shadow: 0 0 0 3px rgba(93, 236, 217, 0.12), var(--glow-cyan);
}
.search-bar button {
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
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
  padding: 1rem 1.1rem;
  box-shadow: var(--shadow);
  transition: all .2s;
  position: relative;
  overflow: hidden;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(93, 236, 217, 0) 0%, rgba(93, 236, 217, 0.04) 100%);
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
.card-title:hover { color: var(--accent); text-shadow: 0 0 8px rgba(93, 236, 217, 0.4); }
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
.chip.kind-fact { background: rgba(93, 236, 217, 0.12); color: var(--kind-fact); border-color: rgba(93, 236, 217, 0.25); }
.chip.kind-observation { background: rgba(147, 243, 231, 0.12); color: var(--kind-observation); border-color: rgba(147, 243, 231, 0.25); }
.chip.kind-pattern { background: rgba(192, 200, 212, 0.12); color: var(--kind-pattern); border-color: rgba(192, 200, 212, 0.25); }
.chip.kind-procedure { background: rgba(212, 175, 55, 0.12); color: var(--kind-procedure); border-color: rgba(212, 175, 55, 0.25); }
.chip.kind-hypothesis { background: rgba(184, 64, 90, 0.12); color: var(--kind-hypothesis); border-color: rgba(184, 64, 90, 0.25); }

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
  background: rgba(139, 146, 168, 0.10);
  color: #8b92a8;
  border-color: rgba(139, 146, 168, 0.25);
}
.visibility-badge.visibility-team {
  background: rgba(147, 243, 231, 0.10);
  color: #93f3e7;
  border-color: rgba(147, 243, 231, 0.25);
}
.visibility-badge.visibility-restricted {
  background: rgba(212, 175, 55, 0.10);
  color: #d4af37;
  border-color: rgba(212, 175, 55, 0.25);
}
.visibility-badge.visibility-private {
  background: rgba(184, 64, 90, 0.12);
  color: #b8405a;
  border-color: rgba(184, 64, 90, 0.30);
}
/* chip.visibility-* — renderVisibilityBadge 输出 alias,与 visibility-badge.visibility-* 同色 */
.chip.visibility-public {
  background: rgba(139, 146, 168, 0.10);
  color: #8b92a8;
  border-color: rgba(139, 146, 168, 0.25);
}
.chip.visibility-team {
  background: rgba(147, 243, 231, 0.10);
  color: #93f3e7;
  border-color: rgba(147, 243, 231, 0.25);
}
.chip.visibility-restricted {
  background: rgba(212, 175, 55, 0.10);
  color: #d4af37;
  border-color: rgba(212, 175, 55, 0.25);
}
.chip.visibility-private {
  background: rgba(184, 64, 90, 0.12);
  color: #b8405a;
  border-color: rgba(184, 64, 90, 0.30);
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
  background: rgba(93, 236, 217, 0.04);
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
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
  opacity: 0;
  transition: opacity .25s;
  animation: node-breathe 5s ease-in-out infinite;
}
@keyframes node-breathe {
  0%, 100% { opacity: 0; }
  50%      { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .kpi::before { animation: none; }
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
.kpi:hover::before { opacity: 1; animation: none; }
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
  animation: digit-aurora 4s ease-in-out infinite;
}
@keyframes digit-aurora {
  0%, 100% { filter: drop-shadow(0 0 0 rgba(93, 236, 217, 0)); }
  50%      { filter: drop-shadow(0 0 6px rgba(93, 236, 217, 0.4)); }
}
@media (prefers-reduced-motion: reduce) {
  .kpi-value { animation: none; }
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
  background: rgba(93, 236, 217, 0.06);
  border-radius: 4px;
  height: 14px;
  overflow: hidden;
  position: relative;
}
.bar-row .bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width .4s;
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.4);
}
.bar-row .bar-value { text-align: right; color: var(--fg-muted); font-variant-numeric: tabular-nums; }

/* === Graph overlay === */
.graph-container {
  position: relative;
  background: var(--panel-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  height: calc(100vh - 200px);
  min-height: 480px;
  overflow: hidden;
}
#graph-canvas { width: 100%; height: 100%; }
#graph-canvas .vis-network {
  background: transparent !important;
}
.graph-toolbar {
  position: absolute;
  top: 0.85rem;
  left: 0.85rem;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  background: rgba(15, 21, 48, 0.82);
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.55rem 0.65rem;
  font-size: 0.72rem;
  box-shadow: var(--shadow);
  width: 240px;
  max-width: 260px;
  max-height: calc(100% - 1.7rem);
  overflow-y: auto;
  overflow-x: hidden;
}
.graph-toolbar::-webkit-scrollbar { width: 6px; }
.graph-toolbar::-webkit-scrollbar-track { background: transparent; }
.graph-toolbar::-webkit-scrollbar-thumb {
  background: rgba(93, 236, 217, 0.2);
  border-radius: 3px;
}
.graph-toolbar::-webkit-scrollbar-thumb:hover { background: rgba(93, 236, 217, 0.4); }

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
  background: rgba(93, 236, 217, 0.08);
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
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.2);
}

/* === Detail drawer (right side) === */
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 480px;
  max-width: 92vw;
  height: 100vh;
  background: linear-gradient(180deg, rgba(15, 21, 48, 0.95), rgba(10, 14, 31, 0.95));
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  border-left: 1px solid var(--border-strong);
  box-shadow: -20px 0 60px rgba(0, 0, 0, 0.5), -1px 0 0 var(--accent);
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
  background: rgba(93, 236, 217, 0.08);
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
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.2);
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
  background: rgba(93, 236, 217, 0.04);
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
  box-shadow: 0 0 0 2px rgba(93, 236, 217, 0.15);
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
.timeline-row .actor-icon.user { background: linear-gradient(135deg, #5DECD9, #93f3e7); }
.timeline-row .actor-icon.llm { background: linear-gradient(135deg, #93f3e7, #5DECD9); }
.timeline-row .actor-icon.system { background: linear-gradient(135deg, #4a5378, #8b92a8); }
.timeline-row .action {
  font-weight: 600;
  font-size: 0.72rem;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  display: inline-block;
  text-align: center;
  border: 1px solid transparent;
}
.timeline-row .action.audit-state { background: rgba(147, 243, 231, 0.12); color: var(--audit-state); border-color: rgba(147, 243, 231, 0.25); }
.timeline-row .action.audit-effective { background: rgba(93, 236, 217, 0.12); color: var(--audit-effective); border-color: rgba(93, 236, 217, 0.25); }
.timeline-row .action.audit-contradicted { background: rgba(184, 64, 90, 0.12); color: var(--audit-contradicted); border-color: rgba(184, 64, 90, 0.25); }
.timeline-row .action.audit-proposal { background: rgba(192, 200, 212, 0.12); color: var(--audit-proposal); border-color: rgba(192, 200, 212, 0.25); }
.timeline-row .engram-link {
  color: var(--accent);
  cursor: pointer;
  font-size: 0.75rem;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
.timeline-row .engram-link:hover { text-decoration-style: solid; text-shadow: 0 0 6px rgba(93, 236, 217, 0.5); }
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
  background: rgba(93, 236, 217, 0.08);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(93, 236, 217, 0.12);
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
  text-decoration-color: rgba(184, 64, 90, 0.5);
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
  background: rgba(93, 236, 217, 0.08);
  border: 1px solid var(--border-strong);
  color: var(--fg);
  font-family: 'SF Mono', monospace;
}
.audit-chips .chip.synapse-chip {
  background: rgba(192, 200, 212, 0.12);
  border-color: rgba(192, 200, 212, 0.3);
  color: #c0c8d4;
  font-weight: 600;
}
.audit-chips .chip.kind-contradicts {
  background: rgba(184, 64, 90, 0.12);
  border-color: rgba(184, 64, 90, 0.3);
  color: #d9a9b3;
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
  background: rgba(93, 236, 217, 0.04);
}
table.data-table tr:hover td { background: rgba(93, 236, 217, 0.03); }

/* === Buttons === */
.btn {
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
  color: var(--accent-fg);
  border: none;
  padding: 0.4rem 0.95rem;
  border-radius: 4px;
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
  background: rgba(93, 236, 217, 0.06);
  color: var(--fg);
  border: 1px solid var(--border);
}
.btn.secondary:hover {
  border-color: var(--accent);
  color: var(--accent);
  filter: none;
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.15);
}
.btn.danger {
  background: transparent;
  color: var(--audit-contradicted);
  border: 1px solid var(--audit-contradicted);
}
.btn.danger:hover {
  background: rgba(184, 64, 90, 0.1);
  box-shadow: 0 0 8px rgba(184, 64, 90, 0.2);
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
  background: rgba(93, 236, 217, 0.04);
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
  color: var(--accent);
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
  border-left: 3px solid var(--accent);
  color: var(--fg-muted, var(--fg));
  background: rgba(147, 243, 231, 0.06);
  border-radius: 0 4px 4px 0;
}
.markdown-body blockquote > :first-child { margin-top: 0; }
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body code {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: rgba(93, 236, 217, 0.08);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
}
.markdown-body pre {
  background: rgba(93, 236, 217, 0.04);
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
.markdown-body th { background: rgba(93, 236, 217, 0.08); font-weight: 700; }
.markdown-body img { max-width: 100%; border-radius: 4px; }
.importance-bar {
  display: inline-block;
  width: 60px;
  height: 5px;
  background: rgba(93, 236, 217, 0.1);
  border-radius: 3px;
  overflow: hidden;
  vertical-align: middle;
}
.importance-bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
  box-shadow: 0 0 6px rgba(93, 236, 217, 0.4);
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
  background: rgba(93, 236, 217, 0.14);
  border-color: rgba(93, 236, 217, 0.35);
}
.importance-chip.imp-medium {
  color: var(--fg-muted);
  background: rgba(139, 146, 168, 0.12);
  border-color: rgba(139, 146, 168, 0.32);
}
.importance-chip.imp-low {
  color: var(--fg-muted);
  background: transparent;
  border-color: rgba(139, 146, 168, 0.22);
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
.decay-level.freshness-stale { color: #d4af37; }
.decay-level.freshness-forgotten { color: var(--fg-dim); }
.decay-countdown {
  color: var(--fg-muted);
  font-size: 11px;
}
.decay-bar {
  width: 100%;
  height: 6px;
  background: rgba(93, 236, 217, 0.08);
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.decay-fill {
  height: 100%;
  transition: width .3s ease;
}
.decay-fill.freshness-fresh {
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
  box-shadow: 0 0 6px rgba(93, 236, 217, 0.4);
}
.decay-fill.freshness-aging {
  background: var(--accent-warm);
  box-shadow: 0 0 4px rgba(212, 175, 55, 0.4);
}
.decay-fill.freshness-stale {
  background: #d4af37;
  box-shadow: 0 0 4px rgba(212, 175, 55, 0.35);
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
.config-row {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 1rem;
  align-items: center;
  padding: 0.6rem 0;
  border-bottom: 1px dashed var(--border);
}
.config-row:last-child { border-bottom: none; }
.config-row .config-label {
  color: var(--fg);
  font-size: 0.85rem;
}
.config-row .config-label .desc {
  display: block;
  color: var(--fg-muted);
  font-size: 0.72rem;
  margin-top: 0.15rem;
}
.config-row .config-control input[type=text],
.config-row .config-control input[type=number],
.config-row .config-control select {
  background: rgba(93, 236, 217, 0.04);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.4rem 0.65rem;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.82rem;
  width: 100%;
  max-width: 320px;
}
.config-row .config-control input:focus, .config-row .config-control select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(93, 236, 217, 0.15);
}
/* dark dropdown options (browser default is white) */
.config-row select option,
.drawer select option,
.filter-bar select option {
  background: #0a0f1f;
  color: var(--fg);
}
.config-row select option:checked,
.drawer select option:checked,
.filter-bar select option:checked {
  background: rgba(93, 236, 217, 0.2);
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
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
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
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.5);
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
  background: rgba(139, 146, 168, 0.25);
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
  background: rgba(93, 236, 217, 0.3);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(93, 236, 217, 0.3);
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
  background: rgba(93, 236, 217, 0.08);
  color: var(--fg-muted);
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  vertical-align: middle;
}
.config-row.readonly .config-control input,
.config-row.readonly .config-control select {
  background: rgba(93, 236, 217, 0.02);
  color: var(--fg-muted);
  cursor: not-allowed;
}
.config-save-bar {
  position: sticky;
  bottom: 0;
  background: linear-gradient(180deg, transparent, rgba(5, 8, 22, 0.9) 30%);
  padding: 1rem 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* === Editable indicator === */
.edit-banner {
  background: rgba(212, 175, 55, 0.08);
  border: 1px solid rgba(212, 175, 55, 0.25);
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  font-size: 0.78rem;
  color: var(--accent-warm);
  margin-bottom: 1rem;
}
.pending-banner {
  background: linear-gradient(135deg, rgba(93, 236, 217, 0.06), rgba(147, 243, 231, 0.04));
  border-left: 3px solid rgba(93, 236, 217, 0.45);
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
  background: linear-gradient(135deg, rgba(93, 236, 217, 0.05), rgba(147, 243, 231, 0.04));
  border-left: 3px solid rgba(147, 243, 231, 0.45);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin-bottom: 1rem;
  line-height: 1.5;
}
.info-banner code,
.info-banner kbd {
  background: rgba(93, 236, 217, 0.12);
  color: var(--accent);
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  font-size: 0.85em;
  font-family: var(--font-mono, monospace);
}

/* 操作成功:保存成功提示 */
.success-banner {
  background: linear-gradient(135deg, rgba(93, 236, 217, 0.08), rgba(93, 236, 217, 0.06));
  border-left: 3px solid rgba(93, 236, 217, 0.5);
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
  background: linear-gradient(135deg, rgba(212, 175, 55, 0.08), rgba(212, 175, 55, 0.05));
  border-left: 3px solid rgba(212, 175, 55, 0.5);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.85rem;
  font-size: 0.82rem;
  color: #d4af37;
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
  background: rgba(93, 236, 217, 0.12);
  color: #93f3e7;
  border: 1px solid rgba(93, 236, 217, 0.25);
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
  background: rgba(93, 236, 217, 0.15);
  border-radius: 5px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(93, 236, 217, 0.3); }

/* === vis-network dark overrides === */
div.vis-tooltip {
  background: rgba(15, 21, 48, 0.95) !important;
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
  background: rgba(139, 146, 168, 0.04);
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
  background: rgba(93, 236, 217, 0.15);
  color: var(--accent);
}

/* === 目录视图(engrams tree) === */
.tree-view {
  background: rgba(139, 146, 168, 0.04);
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
.tree-view summary:hover { background: rgba(93, 236, 217, 0.06); }
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
  background: rgba(139, 146, 168, 0.12);
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
.tree-leaf:hover { background: rgba(93, 236, 217, 0.1); color: var(--accent); }

/* path-tree 新版样式(2026-07) */
.tree-leaf-dir {
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: 4px;
}
.tree-leaf-dir:hover { background: rgba(93, 236, 217, 0.06); }
.tree-dir-name { color: var(--fg-bright); }
.tree-direct {
  display: inline-block;
  padding: 0 0.4rem;
  font-size: 0.65rem;
  color: var(--accent);
  background: rgba(93, 236, 217, 0.12);
  border-radius: 8px;
  margin-left: 0.3rem;
}
.btn.mini {
  padding: 0.15rem 0.5rem;
  font-size: 0.7rem;
  background: rgba(93, 236, 217, 0.08);
  border: 1px solid var(--border);
  color: var(--accent);
  border-radius: 4px;
  cursor: pointer;
  margin-left: 0.4rem;
  font-family: inherit;
}
.btn.mini:hover { background: rgba(93, 236, 217, 0.18); border-color: var(--accent); }

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
  background: rgba(139, 146, 168, 0.05);
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
  color: var(--muted, #8b92a8);
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
  background: rgba(93, 236, 217, 0.18);
  color: #5DECD9;
  border: 1px solid rgba(93, 236, 217, 0.35);
}
.health-warn {
  background: rgba(212, 175, 55, 0.18);
  color: #d4af37;
  border: 1px solid rgba(212, 175, 55, 0.35);
}
.health-error {
  background: rgba(184, 64, 90, 0.18);
  color: #b8405a;
  border: 1px solid rgba(184, 64, 90, 0.4);
}
.health-info {
  background: rgba(147, 243, 231, 0.18);
  color: #93f3e7;
  border: 1px solid rgba(147, 243, 231, 0.35);
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
  border-bottom: 1px solid rgba(139, 146, 168, 0.12);
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
  background: rgba(139, 146, 168, 0.08);
  border-radius: 4px;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--muted, #8b92a8);
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
  color: var(--muted, #8b92a8);
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
  background: rgba(139, 146, 168, 0.06);
  border-left: 3px solid rgba(139, 146, 168, 0.35);
}
.health-fix-block {
  border-left-color: rgba(93, 236, 217, 0.5);
}
.health-why-label,
.health-fix-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted, #8b92a8);
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
  border: 1px solid rgba(139, 146, 168, 0.2);
  word-break: break-all;
  color: #5DECD9;
}
.btn-mini {
  font-size: 0.72rem;
  padding: 0.3rem 0.55rem;
  border-radius: 4px;
  background: rgba(93, 236, 217, 0.12);
  border: 1px solid rgba(93, 236, 217, 0.3);
  color: #5DECD9;
  cursor: pointer;
  white-space: nowrap;
}
.btn-mini:hover {
  background: rgba(93, 236, 217, 0.22);
}
.health-fix-tool {
  margin-top: 0.4rem;
  font-size: 0.78rem;
  color: var(--muted, #8b92a8);
}
.health-fix-tool code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #5DECD9;
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
  background: rgba(139, 146, 168, 0.08);
  font-size: 0.85rem;
}
.health-doctor-kpi strong {
  margin-right: 0.3rem;
  font-size: 1rem;
}
.health-doctor-issue {
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  background: rgba(212, 175, 55, 0.06);
  border-left: 3px solid rgba(212, 175, 55, 0.4);
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.health-doctor-issue-kind {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #8b92a8);
}
.health-doctor-issue-msg {
  margin: 0.2rem 0 0.4rem 0;
  color: var(--fg);
  line-height: 1.45;
}
.health-doctor-nextaction {
  font-size: 0.8rem;
  color: var(--muted, #8b92a8);
}
.health-doctor-nextaction code {
  color: #5DECD9;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
`;
