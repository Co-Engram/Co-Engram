/**
 * Viewer v2 runtime — stats / engrams / proposals / audit / trash / config 六个 tab。
 * Graph tab 单独在 graph.ts(需要 vis-network)。
 *
 * @module @co-engram/claude-code/viewer/runtime/tabs
 */

export const TABS_RUNTIME = `
// ============================================================
// Helpers — renderVisibilityBadge(供列表 / 详情 / 提案复用)
// ============================================================
// 图标映射(emoji 简洁、零依赖,且与已存在的 🔒 private 锁图标风格一致)
CO_ENGRAM._VISIBILITY_ICON = { public: '🌍', team: '👥', private: '🔒', restricted: '⚠️' };
CO_ENGRAM.renderVisibilityBadge = function(visibility) {
  // visibility 缺省时回退到 'public'(与 EngramVisibility 默认值一致)
  var v = visibility || 'public';
  var icon = CO_ENGRAM._VISIBILITY_ICON[v] || '';
  var T = CO_ENGRAM_T;
  var label = T.t('viewer.engram.visibilityBadge.' + v);
  var tip = T.t('viewer.engram.visibilityBadge.' + v + '.tip');
  // chip 基类 + visibility-{level} 颜色类;visibility-badge 老类名向后兼容
  return '<span class="chip visibility-badge visibility-' + v + '" title="' + CO_ENGRAM.escapeHtml(tip) + '">'
    + icon + ' ' + CO_ENGRAM.escapeHtml(label)
    + '</span>';
};

// ============================================================
// Stats → 概览(2026-08 改版:KPI + 记忆脉搏 + 记忆动态 + 右侧 TOP 榜卡)
// 性能:全部数据来自 /api/stats 单次 SQL 聚合 + /api/audit?limit=50,
// 无 N+1、无全量扫描;榜单卡默认 TOP5,点击整卡展开 TOP20(纯 CSS 类切换)。
// ============================================================
CO_ENGRAM.on('stats', async function() {
  const el = document.getElementById('stats-content');
  if (!el) return;
  // 重渲染保护(必须在任何 innerHTML 覆盖之前):上次渲染已把搜索栏 form/results
  // 插进 stats-content 子树,先撤回 #search-dock,否则下面 loading 覆盖即销毁
  // (销毁则 app.ts 绑定的 submit 监听丢失,搜索栏假死)
  const dock = document.getElementById('search-dock');
  const prevForm = document.getElementById('search-form');
  const prevResults = document.getElementById('search-results');
  if (dock) {
    if (prevForm) dock.appendChild(prevForm);
    if (prevResults) dock.appendChild(prevResults);
  }
  // 不缓存:stats 数据会被 batch accept / 单条 accept / dismiss / delete / git pull
  // 等多源改变,维护 invalidate 列表易漏。后端 /api/stats ~24ms,每次进 tab 都拉
  // 最新数据,避免用户看到陈旧计数(2026-07 修复:batch accept 30 条后切到 stats
  // tab 显示的还是旧 totalEngrams)。
  const T = CO_ENGRAM_T;
  el.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loading')) + '</div>';
  let data;
  try { data = await CO_ENGRAM.apiGet('/api/stats'); }
  catch (e) { el.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>'; return; }

  // ---- KPI 行(五格:印迹/突触/技能/印迹检索/有效率并入副行) ----
  const totalEngrams = data.totalEngrams || 0;
  const activeEngrams = data.activeEngrams != null ? (data.activeEngrams || 0) : (data.byStatus?.active || 0);
  const archivedCount = (data.byStatus?.frozen || 0) + (data.byStatus?.archived || 0) + (data.byStatus?.forgotten || 0);
  const weekly = data.weeklyNewEngrams || 0;
  const totalRetrievals = data.totalRetrievals || 0;
  const effective = data.effectiveRetrievals || 0;
  const effPct = totalRetrievals > 0 ? Math.round((effective / totalRetrievals) * 100) : 0;
  const skillInvocations = data.totalSkillInvocations || 0;
  const skillPct = skillInvocations > 0 ? Math.round(((data.skillSuccessCount || 0) / skillInvocations) * 100) : 0;

  const kpi = (label, value, sub, tab, tipText, upText) => '<div class="ov-kpi"'
    + (tipText ? ' title="' + CO_ENGRAM.escapeHtml(tipText).replaceAll('"', '&quot;') + '"' : '')
    + (tab ? ' onclick="CO_ENGRAM.showTab(\\'' + tab + '\\')"' : '') + '>'
    + '<div class="ov-kpi-value">' + CO_ENGRAM.escapeHtml(value) + (upText ? ' <span class="ov-up">' + CO_ENGRAM.escapeHtml(upText) + '</span>' : '') + '</div>'
    + '<div class="ov-kpi-label">' + CO_ENGRAM.escapeHtml(label) + '</div>'
    + (sub ? '<div class="ov-kpi-sub">' + CO_ENGRAM.escapeHtml(sub) + '</div>' : '') + '</div>';

  const engramsSub = (archivedCount > 0)
    ? T.t('viewer.stats.activeEngrams') + ' ' + activeEngrams + ' · ' + T.t('viewer.stats.frozenCount') + ' ' + archivedCount
    : T.t('viewer.stats.activeEngrams') + ' ' + activeEngrams;

  let html = '<div class="ov-stats-block">'
    + '<div class="ov-kpi-row">'
    + kpi(T.t('viewer.stats.totalEngrams'), String(totalEngrams), engramsSub, 'engrams', T.t('viewer.stats.totalEngramsTip'), weekly > 0 ? T.t('viewer.stats.weeklyNew', { n: weekly }) : '')
    + kpi(T.t('viewer.stats.totalSynapses'), String(data.totalSynapses || 0), '', 'graph', null, '')
    + kpi(T.t('viewer.stats.totalSkills'), String(data.totalSkills || 0), '', 'skills', T.t('viewer.stats.totalSkillsTip'), '')
    + kpi(T.t('viewer.stats.retrievalTotal'), String(totalRetrievals), T.t('viewer.stats.effectiveRate', { pct: effPct }), 'engrams', null, '')
    // 第五框:技能调用(与印迹检索分开统计,DEMO g2-overview 五格 KPI)
    + kpi(T.t('viewer.stats.skillInvocations'), String(data.totalSkillInvocations || 0),
        (data.totalSkillInvocations || 0) > 0 ? T.t('viewer.stats.skillSuccessRate', { pct: skillPct }) : '', 'skills',
        T.t('viewer.stats.skillInvocationsTip'), '')
    + '</div>';

  // ---- 记忆脉搏(30 天柱状,峰值高亮;服务端已补零,直接等宽渲染) ----
  const pulse = data.createdLast30d || [];
  if (pulse.length) {
    const maxCount = Math.max(1, ...pulse.map(d => d.count || 0));
    let peakIdx = 0;
    pulse.forEach((d, i) => { if ((d.count || 0) > (pulse[peakIdx].count || 0)) peakIdx = i; });
    const peak = pulse[peakIdx];
    html += '<div class="ov-pulse-h">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.pulseTitle'))
      + '<small>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.pulseSub')) + '</small></div>'
      + '<div class="ov-pulse" role="img" aria-label="' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.pulseTitle')) + '">';
    pulse.forEach((d) => {
      const h = Math.max(3, Math.round(((d.count || 0) / maxCount) * 100));
      html += '<i style="height:' + h + '%"' + (d.count ? ' title="' + d.date + ' · ' + d.count + '"' : '') + (d === peak ? ' class="hot"' : '') + '></i>';
    });
    html += '</div><div class="ov-pulse-axis"><span>' + pulse[0].date.slice(5) + '</span>'
      + (peak && peak.count ? '<span class="peak">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.pulsePeak', { date: peak.date.slice(5), n: peak.count })) + '</span>' : '')
      + '<span>' + pulse[pulse.length - 1].date.slice(5) + '</span></div>';
  }
  html += '</div>';

  // ---- 右侧榜单卡列(TOP5 默认,点击整卡展开 TOP20) ----
  const expandCard = (title, sub, rowsHtml, cardId) => '<div class="ov-card" id="' + cardId + '" onclick="CO_ENGRAM.toggleTopCard(\\'' + cardId + '\\')" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.expandTip')) + '">'
    + '<h3>' + CO_ENGRAM.escapeHtml(title) + '<small>' + CO_ENGRAM.escapeHtml(sub) + '</small></h3>' + rowsHtml + '</div>';

  // 领域热度(topTags:默认 5,展开 20)
  const tagArr = data.topTags || [];
  const tagMax = tagArr.length ? Math.max(1, ...tagArr.map(t => t.count || 0)) : 1;
  let tagRows = '';
  tagArr.slice(0, 5).forEach(t => {
    tagRows += '<div class="ov-heat-row"><span class="ov-heat-name">' + CO_ENGRAM.escapeHtml(t.tag) + '</span>'
      + '<span class="ov-heat-bar"><span style="width:' + ((t.count / tagMax) * 100).toFixed(1) + '%"></span></span>'
      + '<span class="ov-heat-val">' + t.count + '</span></div>';
  });
  let tagMore = '';
  tagArr.slice(5, 20).forEach(t => {
    tagMore += '<div class="ov-heat-row ov-more-rows"><span class="ov-heat-name">' + CO_ENGRAM.escapeHtml(t.tag) + '</span>'
      + '<span class="ov-heat-bar"><span style="width:' + ((t.count / tagMax) * 100).toFixed(1) + '%"></span></span>'
      + '<span class="ov-heat-val">' + t.count + '</span></div>';
  });

  // 检索热点(topRetrieved)
  const hot = data.topRetrieved || [];
  let hotRows = '', hotMore = '';
  hot.slice(0, 5).forEach(e => {
    hotRows += '<div class="ov-top-row"><span class="chip kind-dot-' + e.kind + '"></span>'
      + '<span class="ov-top-title">' + CO_ENGRAM.escapeHtml(e.title) + '</span>'
      + '<span class="ov-top-val"><b>' + e.retrievalCount + '</b> ' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.retrievalsShort', { n: e.retrievalCount }).replace(String(e.retrievalCount), '').trim()) + '</span></div>';
  });
  hot.slice(5, 20).forEach(e => {
    hotMore += '<div class="ov-top-row ov-more-rows"><span class="chip kind-dot-' + e.kind + '"></span>'
      + '<span class="ov-top-title">' + CO_ENGRAM.escapeHtml(e.title) + '</span>'
      + '<span class="ov-top-val"><b>' + e.retrievalCount + '</b></span></div>';
  });

  // 冷却榜(topCooling):最久未取用 · 重要度
  const cool = data.topCooling || [];
  const dayMs = 86400000;
  let coolRows = '', coolMore = '';
  const coolRow = (e) => {
    const days = e.lastRetrievedAt ? Math.max(1, Math.floor((Date.now() - e.lastRetrievedAt) / dayMs)) : null;
    return '<div class="ov-top-row"><span class="chip kind-dot-' + e.kind + '"></span>'
      + '<span class="ov-top-title">' + CO_ENGRAM.escapeHtml(e.title) + '</span>'
      + '<span class="ov-top-val ov-cool">' + (days ? CO_ENGRAM.escapeHtml(T.t('viewer.stats.daysAgo', { n: days })) : CO_ENGRAM.escapeHtml(T.t('viewer.stats.neverRetrieved'))) + ' · ' + e.importance.toFixed(2) + ' ▾</span></div>';
  };
  cool.slice(0, 5).forEach(e => { coolRows += coolRow(e); });
  cool.slice(5, 20).forEach(e => { coolMore += coolRow(e); });

  // 贡献者排行(topContributors)
  const contribArr = data.topContributors || [];
  const contribMax = contribArr.length ? Math.max(1, ...contribArr.map(c => c.total || 0)) : 1;
  let contribRows = '', contribMore = '';
  const contribRow = (c, i) => '<div class="ov-contrib-row"><span class="ov-rank">' + (i + 1) + '</span>'
    + '<span class="ov-contrib-name">' + CO_ENGRAM.escapeHtml(c.actor) + '<small>' + c.engramCount + ' + ' + c.synapseCount + '</small></span>'
    + '<span class="ov-contrib-bar"><span style="width:' + ((c.total / contribMax) * 100).toFixed(1) + '%"></span></span>'
    + '<span class="ov-contrib-val">' + c.total + '</span></div>';
  contribArr.slice(0, 5).forEach((c, i) => { contribRows += contribRow(c, i); });
  contribArr.slice(5, 20).forEach((c, i) => { contribMore += contribRow(c, i + 5); });

  const sideCol = expandCard(T.t('viewer.stats.domainHeat'), T.t('viewer.stats.domainHeatSub'), tagRows + '<div class="ov-more-wrap">' + tagMore + '</div>', 'ov-card-heat')
    + (hot.length ? expandCard(T.t('viewer.stats.monthlyHot'), T.t('viewer.stats.monthlyHotSub'), hotRows + '<div class="ov-more-wrap">' + hotMore + '</div>', 'ov-card-hot') : '')
    + (cool.length ? expandCard(T.t('viewer.stats.monthlyCool'), T.t('viewer.stats.monthlyCoolSub'), coolRows + '<div class="ov-more-wrap">' + coolMore + '</div>', 'ov-card-cool') : '')
    + (contribArr.length ? expandCard(T.t('viewer.stats.contributorRanking2'), '', contribRows + '<div class="ov-more-wrap">' + contribMore + '</div>', 'ov-card-contrib') : '');

  // ---- 布局:左列(KPI+脉搏+动态) + 右列(榜单) ----
  // ov-search-mount:搜索栏挂载点,位于统计块与动态流之间(DEMO sline 位)。
  // stats 渲染后把静态 search-form 移进来 → 统计卡随滚动滑走,搜索栏 sticky 顶吸。
  html = '<div class="ov-layout"><div class="ov-main">' + html
    + '<div id="ov-search-mount"></div>'
    + '<div class="ov-feed-h">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.feedTitle')) + '<small>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.feedSub')) + '</small></div>'
    + '<div id="ov-feed" class="ov-feed"><div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loading')) + '</div></div>'
    + '</div><aside class="ov-side">' + sideCol + '</aside></div>';

  el.innerHTML = html;

  // ---- 搜索栏顶吸(DEMO .sline):插入统计块与动态流之间 + stuck 滚动态 ----
  // form/results 常驻 #search-dock(section 内、stats-content 外),handler 顶部
  // 已撤回;插入标记位后父级是全高的 ov-main,sticky 才能跨动态流全程吸顶。
  // insertBefore 移动已有节点(非重建),app.ts 绑定的 submit 监听保留。
  const marker = document.getElementById('ov-search-mount');
  const form = document.getElementById('search-form');
  const resultsEl = document.getElementById('search-results');
  if (marker && form && dock) {
    marker.parentNode.insertBefore(form, marker);
    if (resultsEl) marker.parentNode.insertBefore(resultsEl, marker);
    marker.remove();
    // 占位符带总数(DEMO:「在 914 条记忆中检索标题、标签、全文」)
    const input = document.getElementById('search-input');
    if (input && totalEngrams > 0) input.placeholder = T.t('viewer.search.placeholderCount', { n: totalEngrams });
    // stuck 态(顶吸生效时)加底边线 + 投影;监听只绑一次
    if (!CO_ENGRAM._searchStuckBound) {
      CO_ENGRAM._searchStuckBound = true;
      const toggle = () => form.classList.toggle('stuck', form.getBoundingClientRect().top <= 1);
      window.addEventListener('scroll', toggle, { passive: true });
      toggle();
    }
  }

  // stats 已经拉到 pendingProposals,顺手更新「记忆提案」tab 上的徽标。
  if (typeof CO_ENGRAM.setProposalsBadge === 'function') {
    CO_ENGRAM.setProposalsBadge(data.pendingProposals || 0);
  }

  // ---- 记忆动态:audit 事件流(limit=50,游标语义;渲染为按天分组的轻量时间线) ----
  try {
    const auditData = await CO_ENGRAM.apiGet('/api/audit?limit=50');
    CO_ENGRAM.renderFeed(document.getElementById('ov-feed'), (auditData && auditData.results) || []);
  } catch (e) {
    const feedEl = document.getElementById('ov-feed');
    if (feedEl) feedEl.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>';
  }
});

// 榜单卡展开/收起(点击整卡;h3 箭头 ▾/▴ 由 CSS ::after 呈现)
CO_ENGRAM.toggleTopCard = function(id) {
  var card = document.getElementById(id);
  if (card) card.classList.toggle('expanded');
};

// 记忆动态渲染:按天分组 + 动作色点。只展示用户关心的动作子集,
// 其余(retrieve_hit 高频噪声等)折叠在「其余 N 条」内,防淹没。
CO_ENGRAM.FEED_ACTIONS = {
  create: { cls: 'feed-create', icon: '＋' },
  update: { cls: 'feed-update', icon: '✎' },
  reinforce: { cls: 'feed-reinforce', icon: '↗' },
  contradicted: { cls: 'feed-contradicted', icon: '⚖' },
  accept: { cls: 'feed-create', icon: '＋' },
  maintenance_run: { cls: 'feed-maintenance', icon: '☾' },
  retrieve_effective: { cls: 'feed-retrieval', icon: '↻' }
};
CO_ENGRAM.renderFeed = function(root, entries) {
  if (!root) return;
  const T = CO_ENGRAM_T;
  if (!entries.length) {
    root.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.feedEmpty')) + '</div>';
    return;
  }
  // 稳健性:倒序(最新在前),按本地日期分组
  const sorted = entries.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  let html = '';
  let lastDay = '';
  let dayCount = 0;
  for (const e of sorted) {
    const meta = CO_ENGRAM.FEED_ACTIONS[e.action];
    if (!meta) continue;
    const day = (e.ts || '').slice(0, 10);
    if (day !== lastDay) {
      if (lastDay !== '') html += '</div>';
      html += '<div class="ov-feed-day">' + CO_ENGRAM.escapeHtml(day) + '</div><div class="ov-feed-group">';
      lastDay = day;
      dayCount++;
      if (dayCount > 3) break; // 概览只渲染最近 3 天,更早去审计 tab 看
    }
    html += '<div class="ov-feed-item ' + meta.cls + '">'
      + '<span class="ov-feed-ico">' + meta.icon + '</span>'
      + '<div class="ov-feed-body"><div class="ov-feed-title">'
      + CO_ENGRAM.escapeHtml(e.metadata?.title || e.engramId || e.action)
      + '</div><div class="ov-feed-meta">' + CO_ENGRAM.escapeHtml(e.action) + ' · ' + CO_ENGRAM.escapeHtml(e.actor || '') + ' · ' + CO_ENGRAM.escapeHtml((e.ts || '').slice(11, 16)) + '</div></div></div>';
  }
  if (lastDay !== '') html += '</div>';
  root.innerHTML = html;
};

// ============================================================
// Engrams
// ============================================================
CO_ENGRAM.on('engrams', async function() {
  const root = document.getElementById('engrams-content');
  if (!root) return;
  if (CO_ENGRAM._engramsLoaded) return;
  CO_ENGRAM._engramsLoaded = true;
  await CO_ENGRAM_ENGRAMS.render(root);
});

window.CO_ENGRAM_ENGRAMS = {
  async render(root) {
    root.innerHTML = '<div class="loading">加载记忆印迹中</div>';

    // 初始化 paginator(只在首次创建;后续 tab 切换 / PATCH 后 reload 复用)
    // pageSize 200:repository.queryEngramsForList 内部 cap=200,设更大无收益;
    // 1026 条需 6 次 loadMore(_loadRemainingInBackground 后台渐进,不阻塞首屏)
    if (!CO_ENGRAM._engramsPager) {
      CO_ENGRAM._engramsPager = CO_ENGRAM.createPaginator({
        endpoint: '/api/engrams',
        pageSize: 200,
        // 2026-07 Bug B:engrams tab 只显示 status=active 的 engram。
        // 删除(soft delete → forgotten)/ 冻结(archived/frozen)/ 草稿(draft)
        // 都不在此显示 —— 用户心智「这里看到的是当前活跃的记忆」。
        // forgotten/frozen 在回收站看;draft 在草稿/单独入口看(若未来加)。
        getExtraParams: function() { return { status: 'active' }; },
      });
      CO_ENGRAM._engramsViewStart = 0;
    }

    try { await CO_ENGRAM._engramsPager.load(); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    const all = CO_ENGRAM._engramsPager.getItems();
    CO_ENGRAM._engramsCache = all;
    CO_ENGRAM._engramsTotal = CO_ENGRAM._engramsPager.getTotal();
    CO_ENGRAM._engramsViewMode = CO_ENGRAM._engramsViewMode || 'card';

    // 后台渐进加载剩余批次,让 totalPages 准确(不阻塞首屏渲染)
    // 用户在首批 200 条内翻页时无需等待;翻到边界时 nextPage 会按需 await loadMore
    if (CO_ENGRAM._engramsPager.hasMore()) {
      this._loadRemainingInBackground();
    }

    const T = CO_ENGRAM_T;
    const kindKeys = ['observation', 'fact', 'pattern', 'procedure', 'hypothesis'];
    const kindOptions = kindKeys.map(k => '<option value="' + k + '"' + CO_ENGRAM.tip('kind.' + k) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k)) + '</option>').join('');

    const filterBar = '<div class="filter-bar">'
      + '<input type="search" placeholder="' + CO_ENGRAM.escapeHtml(T.t('engrams.searchPlaceholder')) + '" id="engrams-q" oninput="CO_ENGRAM_ENGRAMS.applyFilter()">'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.kind')) + ' <select id="engrams-kind" onchange="CO_ENGRAM_ENGRAMS.applyFilter()">'
      + '<option value="">' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.kindAll')) + '</option>' + kindOptions + '</select></label>'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.sort')) + ' <select id="engrams-sort" onchange="CO_ENGRAM_ENGRAMS.applyFilter()">'
      + '<option value="createdAt-desc">' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.sortNewest')) + '</option>'
      + '<option value="createdAt-asc">' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.sortOldest')) + '</option>'
      + '<option value="importance-desc">' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.sortImportance')) + '</option>'
      + '<option value="retrievalCount-desc">' + CO_ENGRAM.escapeHtml(T.t('engrams.filter.sortRetrievals')) + '</option>'
      + '</select></label>'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.filter.visibility')) + ' <select id="engrams-visibility" onchange="CO_ENGRAM_ENGRAMS.applyFilter()">'
      + '<option value="">' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.filter.allVisibilities')) + '</option>'
      + '<option value="team"' + CO_ENGRAM.tip('engram.gitIsolation.teamScope') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.filter.team')) + '</option>'
      + '<option value="private"' + CO_ENGRAM.tip('engram.gitIsolation') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.filter.private')) + '</option>'
      + '</select></label>'
      + '<span class="spacer"></span>'
      + '<div class="view-toggle" role="group" aria-label="' + CO_ENGRAM.escapeHtml(T.t('engrams.view.card') + ' / ' + T.t('engrams.view.tree')) + '">'
      + '<button class="tab' + (CO_ENGRAM._engramsViewMode === 'card' ? ' active' : '') + '" onclick="CO_ENGRAM_ENGRAMS.setView(\\'card\\')">' + CO_ENGRAM.escapeHtml(T.t('engrams.view.card')) + '</button>'
      + '<button class="tab' + (CO_ENGRAM._engramsViewMode === 'tree' ? ' active' : '') + '" onclick="CO_ENGRAM_ENGRAMS.setView(\\'tree\\')">' + CO_ENGRAM.escapeHtml(T.t('engrams.view.tree')) + '</button>'
      + '</div>'
      + '<span class="chip" id="engrams-count">已加载 ' + all.length + ' / 共 ' + CO_ENGRAM._engramsTotal + (CO_ENGRAM._engramsPager && CO_ENGRAM._engramsPager.hasMore() ? ' · ' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.loadingHint')) : '') + '</span>'
      + '</div>'
      + '<div id="engrams-body"></div>';

    root.innerHTML = filterBar;
    this.applyFilter();
  },

  setMode(mode) {
    CO_ENGRAM._engramsViewMode = mode;
    CO_ENGRAM._engramsViewStart = 0;  // 切换视图模式时回第一页
    const toggle = document.querySelector('.view-toggle');
    if (toggle) toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    this.applyFilter();
  },

  // 兼容旧调用名
  setView(mode) { this.setMode(mode); },

  // 展开/折叠全部目录树(details.open 批量切换)
  treeAll(open) {
    document.querySelectorAll('#engrams-body details').forEach(function(d) { d.open = !!open; });
  },

  applyFilter() {
    const pager = CO_ENGRAM._engramsPager;
    const cache = pager ? pager.getItems() : (CO_ENGRAM._engramsCache || []);
    const qRaw = ((document.getElementById('engrams-q') || {}).value || '');
    const q = qRaw.toLowerCase();
    const kind = (document.getElementById('engrams-kind') || {}).value || '';
    const visibility = (document.getElementById('engrams-visibility') || {}).value || '';
    const sort = ((document.getElementById('engrams-sort') || {}).value || 'createdAt-desc').split('-');
    const [sortKey, sortDir] = sort;
    const T = CO_ENGRAM_T;
    const mode = CO_ENGRAM._engramsViewMode || 'card';

    // path: 前缀语法 — 由 tree 视图的"查看"按钮设置,按 id 路径前缀过滤
    // 例:"path:python/async " → 只显示 id 以 "python/async/" 开头的 engram
    // 空 path (path:) → 显示根目录直属的散落 engram(无目录前缀)
    let pathPrefix = null;
    let textQ = q;
    if (q.startsWith('path:')) {
      const rest = qRaw.slice(5);
      // 取第一个空格分隔前缀;后续内容当作普通文本查询
      const sp = rest.indexOf(' ');
      if (sp >= 0) {
        pathPrefix = rest.slice(0, sp);
        textQ = rest.slice(sp + 1).toLowerCase().trim();
      } else {
        pathPrefix = rest;
        textQ = '';
      }
    }

    // filter signature 变化时自动回第一页(用户改 filter 后,旧 viewStart 索引的页面内容不再相关)
    const filterSig = qRaw + '|' + kind + '|' + visibility + '|' + sortKey + '-' + sortDir + '|' + (pathPrefix ?? '');
    if (CO_ENGRAM._engramsLastFilterSig !== filterSig) {
      CO_ENGRAM._engramsLastFilterSig = filterSig;
      CO_ENGRAM._engramsViewStart = 0;
    }

    let filtered = cache.filter(e => {
      if (kind && e.kind !== kind) return false;
      // visibility 过滤:
      // - 'team' → 显示 public/team/restricted(团队可见的非 private)
      // - 'private' → 仅显示 visibility === 'private'
      if (visibility === 'private' && e.visibility !== 'private') return false;
      if (visibility === 'team' && e.visibility === 'private') return false;
      // path 前缀过滤:用 id→path Map(2026-07 修复,ULID id 不再当作路径)
      // pathPrefix === '' 表示 root 直属:匹配 path 中无 '/' 的根级 engram
      // pathPrefix !== '' 匹配 path === pathPrefix 或 path 以 pathPrefix + '/' 开头
      if (pathPrefix !== null) {
        const locMap = CO_ENGRAM._engramLocations;
        const ep = locMap ? locMap.get(e.id) : null;
        if (ep == null) return false; // 没有 path 数据 → 不匹配任何目录过滤
        if (pathPrefix === '') {
          if (ep.includes('/')) return false;
        } else if (ep !== pathPrefix && !ep.startsWith(pathPrefix + '/')) {
          return false;
        }
      }
      if (textQ) {
        const title = (e.title || '').toLowerCase();
        const tags = (e.domainTags || []).join(' ').toLowerCase();
        if (!title.includes(textQ) && !tags.includes(textQ)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      const av = a[sortKey] || 0;
      const bv = b[sortKey] || 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });

    const body = document.getElementById('engrams-body');
    if (!body) return;
    const total = pager ? pager.getTotal() : (CO_ENGRAM._engramsTotal ?? cache.length);
    const hasMore = pager ? pager.hasMore() : false;
    const isLoading = pager ? pager.isLoading() : false;
    const countEl = document.getElementById('engrams-count');
    if (countEl) {
      const hint = (hasMore || isLoading) ? ' · ' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.loadingHint')) : '';
      countEl.textContent = '已加载 ' + cache.length + ' / 共 ' + total + hint;
    }

    if (!filtered.length) {
      body.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('engrams.empty')) + '</div>';
      return;
    }

    if (mode === 'tree') {
      // 目录视图:全量渲染(filtered 不分页,树形折叠已优化性能)
      CO_ENGRAM_ENGRAMS._renderTree(filtered, body);
      return;
    }

    // 卡片视图:客户端虚拟分页(每页 50),翻到边界时 gotoPage 触发 loadMore 扩容
    const VIEW_SIZE = 50;
    const maxStart = Math.max(0, filtered.length - VIEW_SIZE);
    let viewStart = CO_ENGRAM._engramsViewStart || 0;
    if (viewStart > maxStart) viewStart = maxStart;
    if (viewStart < 0) viewStart = 0;
    CO_ENGRAM._engramsViewStart = viewStart;
    const visible = filtered.slice(viewStart, viewStart + VIEW_SIZE);
    this._renderCards(visible, body);

    // 翻页控件:« 上一页  1 2 3 … 22  下一页 »(数字页码可点击直达)
    // totalPages 基于 server total(整个仓库的总量),让用户感知全貌
    // 跳到未加载的页时 gotoPage 会按需 await loadMore 扩容
    const totalPages = Math.max(1, Math.ceil(total / VIEW_SIZE));
    const currentPage = Math.floor(viewStart / VIEW_SIZE) + 1;
    const canPrev = viewStart > 0;
    // canNext:filter 后当前页未到末尾,或 server 还有更多未加载
    const filteredHasMoreInView = (viewStart + VIEW_SIZE) < filtered.length;
    const canNext = filteredHasMoreInView || hasMore;
    const navRow = document.createElement('div');
    navRow.className = 'pager-nav';
    navRow.style.cssText = 'text-align:center;padding:1rem 0;grid-column:1/-1;display:flex;gap:.4rem;justify-content:center;align-items:center;flex-wrap:wrap';
    const prevDisabled = canPrev ? '' : ' disabled';
    const nextDisabled = canNext ? '' : ' disabled';

    // 数字页码:总页数 ≤ 9 全显;否则显示首末 + 当前页前后 2 页 + 省略号
    const pageList = [];
    if (totalPages <= 9) {
      for (let i = 1; i <= totalPages; i++) pageList.push(i);
    } else {
      pageList.push(1);
      if (currentPage > 4) pageList.push('ellipsis');
      const start = Math.max(2, currentPage - 2);
      const end = Math.min(totalPages - 1, currentPage + 2);
      for (let i = start; i <= end; i++) pageList.push(i);
      if (currentPage < totalPages - 3) pageList.push('ellipsis');
      pageList.push(totalPages);
    }
    let pageButtonsHtml = '';
    for (const p of pageList) {
      if (p === 'ellipsis') {
        pageButtonsHtml += '<span class="pager-ellipsis" style="padding:0 .3rem;color:var(--muted,#666)">…</span>';
      } else if (p === currentPage) {
        pageButtonsHtml += '<button class="btn pager-current" disabled style="font-weight:700;cursor:default;min-width:2.2rem">' + p + '</button>';
      } else {
        pageButtonsHtml += '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.gotoPage(' + (p - 1) + ')" style="min-width:2.2rem">' + p + '</button>';
      }
    }

    navRow.innerHTML =
      '<button class="btn secondary"' + prevDisabled + ' onclick="CO_ENGRAM_ENGRAMS.prevPage()">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.prev')) + '</button>'
      + pageButtonsHtml
      + '<button class="btn secondary"' + nextDisabled + ' onclick="CO_ENGRAM_ENGRAMS.nextPage()">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.next')) + '</button>'
      + '<span class="pager-info" style="margin-left:.6rem;color:var(--muted,#666);font-size:.85em">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.pageInfo', { current: currentPage, total: totalPages, itemTotal: total })) + '</span>';
    body.appendChild(navRow);
  },

  _renderCards(filtered, body) {
    const T = CO_ENGRAM_T;
    body.innerHTML = '<div class="grid cols-3">' + filtered.map(e => {
      const tags = (e.domainTags || []).slice(0, 4)
        .map(t => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ');
      const more = (e.domainTags || []).length > 4 ? '<span class="chip">+' + ((e.domainTags || []).length - 4) + '</span>' : '';
      const kindTip = CO_ENGRAM.tip('kind.' + e.kind);
      const createdCell = e.createdAt
        ? '<span title="' + CO_ENGRAM.escapeHtml(e.createdAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(e.createdAt)) + '</span>'
        : '';
      // private engram 卡片显示 🔒 提示已隔离出团队 git
      const privateIcon = e.visibility === 'private'
        ? '<span class="lock-icon"' + CO_ENGRAM.tip('engram.gitIsolation') + '>🔒</span> '
        : '';
      return '<div class="card">'
        + '<div class="card-title" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\')">' + privateIcon + CO_ENGRAM.escapeHtml(e.title) + '</div>'
        + '<div><span class="chip kind-' + e.kind + '"' + kindTip + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', e.kind)) + '</span> '
        + CO_ENGRAM.renderVisibilityBadge(e.visibility)
        + CO_ENGRAM.importanceBar(e.importance)
        + CO_ENGRAM.renderImportanceChip(e.importance) + '</div>'
        + '<div class="card-meta">'
        + (e.retrievalCount != null ? '<span' + CO_ENGRAM.tip('retrievalCount') + '>' + CO_ENGRAM.escapeHtml(T.t('engrams.retrievalsCount', { n: e.retrievalCount })) + '</span>' : '')
        + createdCell
        + '</div>'
        + (tags ? '<div class="card-meta">' + tags + more + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  },

  // 后台渐进加载剩余批次,让 totalPages 尽早准确
  // 不阻塞首屏(用户在首批内翻页无需等待),并发安全(pager 内部 isLoading 守护)
  async _loadRemainingInBackground() {
    const pager = CO_ENGRAM._engramsPager;
    if (!pager) return;
    while (pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) { break; }
      // 每拉一批刷新 count chip + nav,让用户感知加载进度
      this._refreshCountChip();
    }
    this._refreshCountChip();
    // 如果当前页因新数据出现而仍然有效,也刷新 nav
    this.applyFilter();
  },

  // 刷新 count chip 文案(不打扰当前 card 渲染)
  _refreshCountChip() {
    const pager = CO_ENGRAM._engramsPager;
    if (!pager) return;
    const T = CO_ENGRAM_T;
    const el = document.getElementById('engrams-count');
    if (!el) return;
    const hint = (pager.hasMore() || pager.isLoading()) ? ' · ' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.loadingHint')) : '';
    el.textContent = '已加载 ' + pager.getItems().length + ' / 共 ' + pager.getTotal() + hint;
  },

  prevPage() {
    const VIEW_SIZE = 50;
    const current = CO_ENGRAM._engramsViewStart || 0;
    if (current <= 0) return;
    CO_ENGRAM._engramsViewStart = Math.max(0, current - VIEW_SIZE);
    this.applyFilter();
    // 滚到列表顶部,让用户看到新页
    const body = document.getElementById('engrams-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // 跳到任意页(0-based index);已加载不足时按需 await loadMore 扩容
  // 用户点击数字页码 1/2/3/.../22 时调用,允许跨多页跳转
  async gotoPage(zeroBasedPage) {
    const VIEW_SIZE = 50;
    const pager = CO_ENGRAM._engramsPager;
    if (!pager) return;
    if (zeroBasedPage < 0) zeroBasedPage = 0;
    const target = zeroBasedPage * VIEW_SIZE;
    // 顺序 loadMore 直到已加载覆盖目标起点,或 server 数据耗尽
    while (target >= pager.getItems().length && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) {
        alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e })));
        return;
      }
    }
    CO_ENGRAM._engramsViewStart = target;
    this.applyFilter();
    const body = document.getElementById('engrams-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async nextPage() {
    const VIEW_SIZE = 50;
    const pager = CO_ENGRAM._engramsPager;
    if (!pager) return;
    const current = CO_ENGRAM._engramsViewStart || 0;
    const loaded = pager.getItems().length;
    // 当前 filter 是 client-side,翻到下一页需要先确认有数据
    // 如果当前已加载不够覆盖下一页起点,且 server 还有更多 → loadMore 再前进
    if (current + VIEW_SIZE >= loaded && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) { alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e }))); return; }
    }
    CO_ENGRAM._engramsViewStart = current + VIEW_SIZE;
    this.applyFilter();
    const body = document.getElementById('engrams-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // 兼容旧调用名 / 旧 onclick 引用 — 等价于 nextPage
  async loadMore() {
    await this.nextPage();
  },

  // 目录视图:基于 /api/path-tree 物理目录树(2026-07 改版)
  // 大规模(1000+ engram)下,旧版 domainTags[0] 分组存在两个问题:
  //   1. 全 <details open> 一次性渲染所有 engram 卡片行 → DOM 巨大,tab 切换卡
  //   2. 语义分组丢失物理结构,用户无法按目录浏览
  // 新版渲染递归目录树(默认折叠,只展开 root),目录行显示 engramCount(累积);
  // 点"查看"按钮 → 切回 card 视图 + 路径前缀过滤,真正展示 engram 卡片。
  async _renderTree(items, body) {
    const T = CO_ENGRAM_T;
    body.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loading')) + '</div>';

    // path-tree 是目录树(不含 engram 叶子),目录数据相对稳定,可缓存整个 tab 生命周期。
    // files=1 让 engramLocations 带上 title/kind/domainTags/createdAt,用于内联展开直属文件行。
    if (!CO_ENGRAM._pathTree) {
      try {
        const resp = await CO_ENGRAM.apiGet('/api/path-tree?maxDepth=10&files=1');
        if (!resp || !resp.enabled || !resp.root) {
          CO_ENGRAM._pathTree = null;
        } else {
          CO_ENGRAM._pathTree = resp.root;
          // 缓存 id→path Map(2026-07 修复):applyFilter 用它做目录前缀过滤,
          // 替代已失效的 id.startsWith(prefix) 假设(ULID id 无 '/')
          if (Array.isArray(resp.engramLocations)) {
            CO_ENGRAM._engramLocations = new Map(
              resp.engramLocations.map((x) => [x.id, x.path]),
            );
            // 预计算「目录 → 直属 engram」Map(全量,与计数同源):
            // 展开目录时用它懒填充直属文件行,O(n) 一次。
            CO_ENGRAM._engramsByDir = CO_ENGRAM_ENGRAMS._buildEngramsByDir(resp.engramLocations);
          }
        }
      } catch (e) {
        body.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>';
        return;
      }
    }
    const root = CO_ENGRAM._pathTree;
    if (!root || (!root.engramCount && !(root.children || []).length)) {
      body.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('engrams.empty')) + '</div>';
      return;
    }

    // 累积计数 tooltip。注意:CO_ENGRAM.tip() 读硬编码 TOOLTIPS、不含 engrams.tree.*,
    // 故这里直接用 T.t() 内联生成 title(顺带修掉原先 tip('...cumulativeCount') 的空 title)。
    const cumTitle = ' title="' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.cumulativeCount')) + '"';

    // 2026-08 改版:目录树顶部提供 展开/折叠全部(一棵整体树的全局操作)
body.innerHTML = ''
var treeBar = document.createElement('div');
treeBar.className = 'filter-bar';
treeBar.innerHTML = '<button class="btn mini" onclick="CO_ENGRAM_ENGRAMS.treeAll(true)">' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.expandAll')) + '</button>'
  + '<button class="btn mini" onclick="CO_ENGRAM_ENGRAMS.treeAll(false)">' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.collapseAll')) + '</button>'
  + '<span class="spacer"></span><span class="chip">' + CO_ENGRAM.escapeHtml(T.t('engrams.view.tree')) + '</span>';
body.appendChild(treeBar);
var treeHost = document.createElement('div');
body.appendChild(treeHost);
body = treeHost;
// 递归渲染目录节点;每个目录都是可展开 <details>,展开后内联显示「直属文件 + 子目录」。
    // depth=0(顶层目录)默认展开,其余默认折叠;直属文件占位由 toggle 监听器懒填充。
    const renderNode = (node, depth) => {
      const children = node.children || [];
      // 直属 engram 数 = 累积 engramCount - 直系子目录累积数
      let childSum = 0;
      for (const c of children) childSum += (c.engramCount || 0);
      const direct = Math.max(0, (node.engramCount || 0) - childSum);

      const segs = (node.path || '').split('/').filter(Boolean);
      const basename = segs.length ? segs[segs.length - 1] : '/';
      const pathForFilter = node.path && node.path !== '/' ? node.path : '';
      const isOpen = depth === 0;

      const summary = '<summary>'
        + '<span class="tree-folder-icon">📁</span> '
        + '<span class="tree-dir-name">' + CO_ENGRAM.escapeHtml(basename) + '</span> '
        + '<span class="tree-count"' + cumTitle + '>' + (node.engramCount || 0) + '</span>'
        + (direct > 0 ? ' <span class="tree-direct">' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.directHere', { n: direct })) + '</span>' : '')
        + '</summary>';
      // 直属文件占位(展开时懒填充)+ 子目录;直属在前,符合「点目录看本目录文件」心智
      const directFiles = '<div class="tree-direct-files" data-dir="' + CO_ENGRAM.escapeHtml(pathForFilter) + '"></div>';
      const childHtml = children.length
        ? '<div class="tree-group-body">' + children.map(c => renderNode(c, depth + 1)).join('') + '</div>'
        : '';

      return '<details class="tree-group"' + (isOpen ? ' open' : '') + '>'
        + summary + directFiles + childHtml
        + '</details>';
    };

    let html = '<div class="tree-view">';
    const rootChildren = root.children || [];
    if (rootChildren.length === 0 && (root.engramCount || 0) === 0) {
      html += '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('engrams.empty')) + '</div>';
    } else {
      // root 的直属散落 engram("路径为空")显示为顶部虚拟目录,data-dir="" 对应根散落
      const rootDirect = (root.engramCount || 0) - rootChildren.reduce((s, c) => s + (c.engramCount || 0), 0);
      if (rootDirect > 0) {
        html += '<details class="tree-group" open>'
          + '<summary><span class="tree-folder-icon">🏠</span> '
          + '<span class="tree-dir-name">' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.rootDirect')) + '</span> '
          + '<span class="tree-count"' + cumTitle + '>' + rootDirect + '</span>'
          + '</summary>'
          + '<div class="tree-direct-files" data-dir=""></div>'
          + '</details>';
      }
      for (const child of rootChildren) {
        html += renderNode(child, 0);
      }
    }
    html += '</div>';
    body.innerHTML = html;

    // toggle 事件不冒泡 → 监听器必须 capture;挂在持久的 #engrams-body 上,
    // 用 _treeToggleBound 守卫只挂一次(innerHTML 只换子节点,元素本身不变)。
    if (!CO_ENGRAM._treeToggleBound) {
      CO_ENGRAM._treeToggleBound = true;
      body.addEventListener('toggle', function (ev) {
        const d = ev.target;
        if (!d || d.tagName !== 'DETAILS' || !d.classList.contains('tree-group') || !d.open) return;
        const ph = d.querySelector(':scope > .tree-direct-files');
        if (ph && ph.getAttribute('data-filled') !== '1') {
          CO_ENGRAM_ENGRAMS._fillTreeDirectFiles(ph);
          ph.setAttribute('data-filled', '1');
        }
      }, true);
    }
    // 初始 open 的目录不会触发 toggle → 渲染后主动填一次(幂等:data-filled 守卫)
    body.querySelectorAll('details.tree-group[open] > .tree-direct-files').forEach(ph => {
      if (ph.getAttribute('data-filled') !== '1') {
        CO_ENGRAM_ENGRAMS._fillTreeDirectFiles(ph);
        ph.setAttribute('data-filled', '1');
      }
    });
  },

  // 把增补后的 engramLocations 按 parent 目录分组成 Map<dirPath, engram[]>。
  // key='' 表示根散落(路径无 '/');value 按 createdAt 降序。O(n) 一次,全量(与计数同源)。
  _buildEngramsByDir(locations) {
    const byDir = new Map();
    for (const loc of locations) {
      if (!loc || !loc.path) continue;
      const slash = loc.path.lastIndexOf('/');
      const dir = slash < 0 ? '' : loc.path.slice(0, slash);
      let bucket = byDir.get(dir);
      if (!bucket) { bucket = []; byDir.set(dir, bucket); }
      bucket.push({ id: loc.id, title: loc.title, kind: loc.kind, domainTags: loc.domainTags, createdAt: loc.createdAt });
    }
    for (const bucket of byDir.values()) {
      bucket.sort((a, b) => {
        const ac = a.createdAt || '';
        const bc = b.createdAt || '';
        if (ac < bc) return 1;
        if (ac > bc) return -1;
        return 0;
      });
    }
    return byDir;
  },

  // 单条直属文件行(复用 _renderCards 的 chip 模式;onclick 复用 open(id) 打开同一详情抽屉)
  _treeEngramRow(e) {
    const T = CO_ENGRAM_T;
    return '<div class="tree-file" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\')">'
      + '<span class="chip kind-' + CO_ENGRAM.escapeHtml(e.kind) + '"' + CO_ENGRAM.tip('kind.' + e.kind) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', e.kind)) + '</span>'
      + '<span class="tree-file-name">' + CO_ENGRAM.escapeHtml(e.title) + '</span>'
      + (e.createdAt ? '<span class="tree-file-meta">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(e.createdAt)) + '</span>' : '')
      + '</div>';
  },

  // 填充某目录的直属文件占位:>50 截断 + 溢出入口(切卡片视图展开该目录全部后代)。
  // 无直属文件(仅子目录 / 空目录)时占位留空,不显示任何提示。
  _fillTreeDirectFiles(ph) {
    const T = CO_ENGRAM_T;
    const dir = ph.getAttribute('data-dir') || '';
    const all = (CO_ENGRAM._engramsByDir && CO_ENGRAM._engramsByDir.get(dir)) || [];
    if (!all.length) {
      return;
    }
    const LIMIT = 50;
    let h = all.slice(0, LIMIT).map(e => CO_ENGRAM_ENGRAMS._treeEngramRow(e)).join('');
    if (all.length > LIMIT) {
      h += '<button class="btn mini tree-more" onclick="CO_ENGRAM_ENGRAMS._filterByPath(\\'' + CO_ENGRAM.escapeHtml(dir) + '\\')">'
        + CO_ENGRAM.escapeHtml(T.t('engrams.tree.viewAllInCards', { n: all.length })) + '</button>';
    }
    ph.innerHTML = h;
  },

  // path-tree 子目录"查看"按钮 → 切回 card 视图 + 路径前缀过滤
  _filterByPath(prefix) {
    const input = document.getElementById('engrams-q');
    if (input) {
      // 路径前缀语法:用 "path:" 前缀让 applyFilter 识别(下方 applyFilter 已支持)
      input.value = prefix ? 'path:' + prefix + ' ' : '';
    }
    CO_ENGRAM._engramsViewMode = 'card';
    const toggle = document.querySelector('.view-toggle');
    if (toggle) toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    const cardBtn = document.querySelector('.view-toggle button:nth-child(1)');
    if (cardBtn) cardBtn.classList.add('active');
    CO_ENGRAM_ENGRAMS.applyFilter();
  },

  async open(id) {
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(id)); }
    catch (e) { CO_ENGRAM.openDrawer('<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'); return; }
    CO_ENGRAM._currentEngram = d;
    // 额外拉突触(失败降级空)
    try { d._synapses = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(id) + '/synapses'); }
    catch { d._synapses = { outgoing: [], incoming: [] }; }
    this._renderView(d);
  },

  _renderView(d) {
    const T = CO_ENGRAM_T;
    const D = CO_ENGRAM_DECAY;
    const engramId = CO_ENGRAM.escapeHtml(d.id); // 重命名避免与edit函数中的id冲突
    const tags = (d.domainTags || []).map(t => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ');
    const ctxTags = (d.contextTags || []).map(t => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ');

    // 价值评估段(sourceType + verificationStatus + 衰退进度 + 强化信号)
    const source = d.sourceType;
    const sourceLine = source
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('sourceType.' + source) + '>' + T.fieldLabel('sourceType') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('sourceType', source)) + '</div>'
      : '';
    const verif = d.verificationStatus;
    const verifLine = verif
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('verification.' + verif) + '>' + T.fieldLabel('verificationStatus') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('verificationStatus', verif)) + '</div>'
      : '';

    // 衰退进度段:半衰期从 importance 实时派生(机制 D)
    const hasImportance = d.importance !== undefined && d.importance !== null;
    const decay = hasImportance
      ? D.computeDecayState(d.lastEffectiveAt, d.createdAt, d.importance, undefined, d.kind)
      : null;
    const decayLine = hasImportance
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('decayProgress') + '>' + T.fieldLabel('decayProgress') + '</span><div class="decay-block">' + D.renderDecayBar(decay) + '</div></div>'
      : '';

    const evidenceLine = d.evidenceCount !== undefined
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('evidenceCount') + '>' + T.fieldLabel('evidenceCount') + '</span>' + (d.evidenceCount || 0) + '</div>'
      : '';
    const lastEffLine = d.lastEffectiveAt
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('lastEffectiveAt') + '>' + T.fieldLabel('lastEffective') + '</span><span title="' + CO_ENGRAM.escapeHtml(d.lastEffectiveAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(d.lastEffectiveAt)) + '</span></div>'
      : '';
    const scoreLine = (d.reinforcementScore !== undefined && d.reinforcementScore !== 0)
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('reinforcementScore') + '>' + T.fieldLabel('reinforcementScore') + '</span>' + T.formatScoreBand(d.reinforcementScore) + '</div>'
      : '';
    const valueSection = (sourceLine || verifLine || decayLine || evidenceLine || lastEffLine || scoreLine)
      ? '<h3>' + T.sectionLabel('valueAssessment') + '</h3>' + sourceLine + verifLine + decayLine + evidenceLine + lastEffLine + scoreLine
      : '';

    // 记忆产生情境段(可选)— section 标题已说明,内嵌 field-label 冗余,直接渲染内容
    const encCtx = d.encodingContext;
    const persp = d.perspective;
    const encSection = (encCtx || persp)
      ? '<h3' + CO_ENGRAM.tip('encodingContext') + '>' + T.sectionLabel('encodingContext') + '</h3>'
        + (persp ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('perspective') + '>' + T.fieldLabel('perspective') + '</span>' + CO_ENGRAM.escapeHtml(persp) + '</div>' : '')
        + (encCtx ? '<div class="field markdown-body"><div>' + CO_ENGRAM.renderMarkdown(encCtx) + '</div></div>' : '')
      : '';

    // 时间字段补 title 显示完整 ISO
    const createdAtDisplay = d.createdAt
      ? '<span title="' + CO_ENGRAM.escapeHtml(d.createdAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(d.createdAt)) + '</span>'
      : CO_ENGRAM.escapeHtml(d.createdAt || '');

    var body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + T.actionLabel('detailView') + '</strong>'
      + '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.openDir()">' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.openDir')) + '</button>'
      + '<button class="btn" onclick="CO_ENGRAM_ENGRAMS.edit()">' + T.actionLabel('edit') + '</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.confirmDelete()">' + T.actionLabel('delete') + '</button>'
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(d.title) + '</h2>'
      + '<div class="field"><span class="chip kind-' + d.kind + '"' + CO_ENGRAM.tip('kind.' + d.kind) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', d.kind)) + '</span> '
      + CO_ENGRAM.importanceBar(d.importance) + ' <span class="kpi-sub"' + CO_ENGRAM.tip('importance') + '>' + T.fieldLabel('importance') + ' ' + CO_ENGRAM.renderImportanceChip(d.importance) + '</span></div>'
      + '<div class="field"><span class="field-label">' + T.fieldLabel('id') + '</span><code>' + engramId + '</code></div>'
      + (tags ? '<div class="field"><span class="field-label">' + T.fieldLabel('domainTags') + '</span>' + tags + '</div>' : '')
      + (ctxTags ? '<div class="field"><span class="field-label">' + T.fieldLabel('contextTags') + '</span>' + ctxTags + '</div>' : '')
      + '<h3>' + T.sectionLabel('content') + '</h3><div class="markdown-body">' + CO_ENGRAM.renderMarkdown(d.content || '') + '</div>'
      + '<h3>' + T.sectionLabel('stats') + '</h3>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('retrievalCount') + '>' + T.fieldLabel('retrievals') + '</span>' + (d.retrievalCount || 0)
      + ' <span class="field-label"' + CO_ENGRAM.tip('effectiveRetrievals') + '>' + T.fieldLabel('effective') + '</span>' + (d.effectiveRetrievals || 0)
      + ' <span class="field-label"' + CO_ENGRAM.tip('failedUses') + '>' + T.fieldLabel('failures') + '</span>' + (d.failedUses || 0) + '</div>'
      + '<div class="field"><span class="field-label">' + T.fieldLabel('creator') + '</span>' + CO_ENGRAM.escapeHtml(d.createdBy || '')
      + ' <span class="field-label">' + T.fieldLabel('time') + '</span>' + createdAtDisplay + '</div>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('confidence') + '>' + T.fieldLabel('confidence') + '</span>' + T.formatScoreBand(d.confidence)
      + ' <span class="field-label"' + CO_ENGRAM.tip('status.' + (d.status || 'active')) + '>' + T.fieldLabel('status') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('status', d.status))
      + ' <span class="field-label"' + CO_ENGRAM.tip('freshness.' + (d.freshness || 'fresh')) + '>' + T.fieldLabel('freshness') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('freshness', d.freshness))
      + (d.freshness === 'forgotten' ? ' <button class="btn mini" onclick="CO_ENGRAM_ENGRAMS.restoreFromForgotten(\\'' + engramId + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.restoreBtn')) + '</button>' : '')
      + ' <span class="field-label"' + CO_ENGRAM.tip('visibility.' + (d.visibility || 'public')) + '>' + T.fieldLabel('visibility') + '</span>' + CO_ENGRAM.renderVisibilityBadge(d.visibility)
      + '</div>'
      // Task 4:visibility 快捷切换器(折叠的 <details>,默认收起)
      // - 4 个 option 复用 viewer.engram.visibilityBadge.<v> 的标签
      // - 当前 visibility 默认选中
      // - 切换按钮调 CO_ENGRAM_ENGRAMS.updateVisibility(id),内部走 PATCH /api/engrams/:id
      + (function() {
          var visKeys = ['public', 'team', 'private', 'restricted'];
          var curVis = d.visibility || 'public';
          var visOpts = visKeys.map(function(v) {
            return '<option value="' + v + '"' + (curVis === v ? ' selected' : '') + '>'
              + CO_ENGRAM.escapeHtml(T.t('viewer.engram.visibilityBadge.' + v))
              + '</option>';
          }).join('');
          return '<details class="visibility-editor"><summary>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.visibility.changeBtn')) + '</summary>'
            + '<div class="field"><select name="visibility">' + visOpts + '</select>'
            + ' <button class="btn secondary mini" onclick="CO_ENGRAM_ENGRAMS.updateVisibility(\\'' + engramId + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.visibility.changeBtn')) + '</button>'
            + '</div></details>';
        })()
      + valueSection
      + encSection;

    // 突触栏
    var synOut = (d._synapses && d._synapses.outgoing) || [];
    var synInc = (d._synapses && d._synapses.incoming) || [];
    var synRow = function(list, isOut) {
      if (!list.length) return '<div class="kpi-sub"><em>' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.noSynapses')) + '</em></div>';
      return list.map(function(s) {
        var otherId = isOut ? s.to : s.from;
        var kindLabel = T.enumLabel('synapseKind', s.kind) || s.kind;
        var kindColor = CO_ENGRAM.edgeColor(s.kind);
        return '<div class="field" style="display:flex;align-items:center;gap:.4rem">'
          + '<span class="chip" style="border-left:3px solid ' + kindColor + ';color:' + kindColor + '">' + CO_ENGRAM.escapeHtml(kindLabel) + '</span>'
          + '<span style="color:var(--accent);cursor:pointer;text-decoration:underline" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM.showTab(&quot;engrams&quot;);setTimeout(function(){CO_ENGRAM_ENGRAMS.open(&quot;' + CO_ENGRAM.escapeHtml(otherId) + '&quot;)},50)">' + CO_ENGRAM.escapeHtml(isOut ? '→ ' : '← ') + CO_ENGRAM.escapeHtml(otherId.slice(-12)) + '</span>'
          + '</div>';
      }).join('');
    };
    var synSection = '<div class="card" style="margin-top:1rem"><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.synapses')) + ' (' + (synOut.length + synInc.length) + ')</h3>'
      + '<div class="kpi-sub">' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.outgoingSynapses')) + ' (' + synOut.length + ')</div>'
      + synRow(synOut, true)
      + '<div class="kpi-sub" style="margin-top:.5rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.incomingSynapses')) + ' (' + synInc.length + ')</div>'
      + synRow(synInc, false)
      + '</div>';

    body += synSection;
    CO_ENGRAM.openDrawer(body);
  },

  edit() {
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    const T = CO_ENGRAM_T;
    const editId = CO_ENGRAM.escapeHtml(d.id); // 重命名避免与其他函数中的id冲突
    const kindKeys = ['observation', 'fact', 'pattern', 'procedure', 'hypothesis'];
    const kindOptions = kindKeys.map(k => '<option value="' + k + '"' + (d.kind === k ? ' selected' : '') + CO_ENGRAM.tip('kind.' + k) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k)) + '</option>').join('');
    const visKeys = ['public', 'team', 'private', 'restricted'];
    const visOptions = visKeys.map(v => '<option value="' + v + '"' + (d.visibility === v ? ' selected' : '') + CO_ENGRAM.tip('visibility.' + v) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('visibility', v)) + '</option>').join('');

    const body = '<div class="edit-banner"><strong>' + CO_ENGRAM.escapeHtml(T.t('viewer.common.editMode')) + '</strong> · ' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.editModeHint')) + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.editEngramTitle')) + '</h2>'
      + '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.fieldLabel('id')) + '</span><code>' + editId + '</code></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.titleLabel')) + '</label><input id="ef-title" type="text" value="' + CO_ENGRAM.escapeHtml(d.title || '') + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('kind.fact') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.kindLabel')) + '</label><select id="ef-kind"' + CO_ENGRAM.tip('kind.fact') + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('importance') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.importanceLabel')) + '</label><input id="ef-importance-range" type="range" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance\\').value=this.value"><input id="ef-importance" type="number" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('confidence') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.confidenceLabel')) + '</label><input id="ef-confidence-range" type="range" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence\\').value=this.value"><input id="ef-confidence" type="number" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.tagsLabel')) + '</label><input id="ef-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.domainTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.ctxTagsLabel')) + '</label><input id="ef-ctx-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.contextTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('visibility.public') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.visibilityLabel')) + '</label><select id="ef-visibility"' + CO_ENGRAM.tip('visibility.public') + '>' + visOptions + '</select>'
      + '<div class="kpi-sub"' + CO_ENGRAM.tip('engram.visibilityEdit') + '>' + CO_ENGRAM.escapeHtml(T.t('tip.engram.visibilityEdit')) + '</div>'
      + '</div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.contentLabel')) + ' '
      + '<button type="button" class="btn secondary mini" id="ef-preview-toggle" onclick="CO_ENGRAM_ENGRAMS.togglePreview()">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.preview')) + '</button>'
      + '<span id="ef-content-mode" class="kpi-sub">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.editMode')) + '</span></label>'
      + '<textarea id="ef-content" rows="12">' + CO_ENGRAM.escapeHtml(d.content || '') + '</textarea>'
      + '<div id="ef-content-preview" class="markdown-body" style="display:none;margin-top:0.5rem"></div></div>'
      + '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.cancel()">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.cancel')) + '</button>'
      + '<button class="btn" onclick="CO_ENGRAM_ENGRAMS.save()">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.save')) + '</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  togglePreview() {
    const T = CO_ENGRAM_T;
    const ta = document.getElementById('ef-content');
    const preview = document.getElementById('ef-content-preview');
    const toggleBtn = document.getElementById('ef-preview-toggle');
    const modeLabel = document.getElementById('ef-content-mode');
    if (!ta || !preview || !toggleBtn || !modeLabel) return;
    if (ta.style.display === 'none') {
      ta.style.display = '';
      preview.style.display = 'none';
      toggleBtn.textContent = T.t('viewer.common.preview');
      modeLabel.textContent = T.t('viewer.common.editMode');
    } else {
      preview.innerHTML = CO_ENGRAM.renderMarkdown(ta.value);
      ta.style.display = 'none';
      preview.style.display = '';
      toggleBtn.textContent = T.t('viewer.common.edit');
      modeLabel.textContent = T.t('viewer.common.previewMode');
    }
  },

  cancel() {
    const d = CO_ENGRAM._currentEngram;
    if (d) this._renderView(d);
  },

  async save() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    const patch = {
      title: (document.getElementById('ef-title').value || '').trim(),
      kind: document.getElementById('ef-kind').value,
      importance: Number(document.getElementById('ef-importance').value),
      confidence: Number(document.getElementById('ef-confidence').value),
      domainTags: (document.getElementById('ef-tags').value || '').split(',').map(s => s.trim()).filter(Boolean),
      contextTags: (document.getElementById('ef-ctx-tags').value || '').split(',').map(s => s.trim()).filter(Boolean),
      visibility: document.getElementById('ef-visibility').value,
      content: document.getElementById('ef-content').value
    };
    try {
      const updated = await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(d.id), 'PATCH', patch);
      CO_ENGRAM._currentEngram = updated;
      this._renderView(updated);
      try {
        if (CO_ENGRAM._engramsPager) { await CO_ENGRAM._engramsPager.load(); }
        this.applyFilter();
      } catch {}
    } catch (e) { alert(T.t('viewer.common.saveFailed', { err: (e.message || e) })); }
  },

  // Task 4:visibility 快捷切换 handler(详情页 <details> 内的 select + 按钮触发)
  // 与 edit form 的 save() 共用 PATCH /api/engrams/:id,但只透传 visibility 字段。
  // server.ts 的 parseUpdateInput 已支持 visibility 透传 + updatedBy 自动注入为 "viewer"。
  async updateVisibility(engramId) {
    const T = CO_ENGRAM_T;
    var d = CO_ENGRAM._currentEngram;
    if (!d && engramId) {
      try { d = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(engramId)); }
      catch (e) { alert(CO_ENGRAM.escapeHtml(e.message || e)); return; }
    }
    if (!d) return;
    // 找到详情页 <details class="visibility-editor"> 内的 <select name="visibility">
    var editor = document.querySelector('.visibility-editor select[name="visibility"]');
    var newVisibility = editor && editor.value ? editor.value : (d.visibility || 'public');
    if (newVisibility === (d.visibility || 'public')) {
      // 未变化,仅提示
      alert(T.t('viewer.detail.visibility.changeBtn'));
      return;
    }
    if (!window.confirm(T.t('viewer.detail.visibility.confirm'))) return;
    try {
      var updated = await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(d.id), 'PATCH', { visibility: newVisibility });
      CO_ENGRAM._currentEngram = updated;
      alert(T.t('viewer.detail.visibility.changed'));
      // 重新渲染当前详情页(徽章 + selector 都要刷新)
      this._renderView(updated);
      // 刷新列表缓存,确保 badge 同步
      try {
        if (CO_ENGRAM._engramsPager) { await CO_ENGRAM._engramsPager.load(); }
        this.applyFilter();
      } catch {}
    } catch (e) {
      alert(CO_ENGRAM.escapeHtml(T.t('viewer.common.saveFailed', { err: (e.message || e) })));
    }
  },

  /**
   * 恢复 forgotten engram:清 forcedFreshness 锁定 + status active,让 freshness 回派生。
   * 用于详情面板 forgotten 状态旁的"恢复"按钮。
   */
  async restoreFromForgotten(engramId) {
    const T = CO_ENGRAM_T;
    if (!window.confirm(T.t('viewer.engram.restoreConfirm'))) return;
    try {
      await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(engramId) + '/restore', 'POST', null);
      var updated = await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(engramId), 'GET', null);
      CO_ENGRAM._currentEngram = updated;
      this._renderView(updated);
      try { if (CO_ENGRAM._engramsPager) { await CO_ENGRAM._engramsPager.load(); } this.applyFilter(); } catch {}
    } catch (e) {
      alert(CO_ENGRAM.escapeHtml(T.t('viewer.common.saveFailed', { err: (e.message || e) })));
    }
  },

  async confirmDelete() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    if (!confirm(T.t('viewer.common.confirmDeleteEngram', { title: (d.title || d.id) }))) return;
    try {
      await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(d.id), 'DELETE', null);
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._currentEngram = null;
      const root = document.getElementById('engrams-content');
      if (root) {
        CO_ENGRAM._engramsLoaded = false;
        CO_ENGRAM._engramsCache = null;
        await CO_ENGRAM_ENGRAMS.render(root);
      }
    } catch (e) { alert(T.t('viewer.common.deleteFailed', { err: (e.message || e) })); }
  },

  // 「打开目录」:POST /api/engrams/:id/reveal,server 端 spawn 系统文件管理器。
  // 成功(opened=true)→ drawer 顶部短暂成功提示;降级(无桌面 / 命令缺失 / 目录不存在)
  // → 展示目录绝对路径 + 复制按钮,保证远程 / 容器场景也能拿到路径手动定位。
  async openDir() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    var res;
    try {
      res = await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(d.id) + '/reveal', 'POST', null);
    } catch (e) {
      // err 走 innerHTML 渲染,先 escape 防注入(_showDirBanner 的 message 当 trusted HTML,不二次 escape)
      CO_ENGRAM_ENGRAMS._showDirBanner(T.t('viewer.engram.openDirFailed', { err: CO_ENGRAM.escapeHtml(String(e.message || e)) }), null);
      return;
    }
    if (res && res.opened) {
      CO_ENGRAM_ENGRAMS._showDirBanner(T.t('viewer.engram.openDirOpened'), null, true);
    } else {
      // 降级:按 reason 选文案,展示路径 + 复制按钮
      var reasonKey = (res && res.reason) ? ('viewer.engram.openDirReason.' + res.reason) : 'viewer.engram.openDirReason.fallback';
      var reasonText = T.t(reasonKey);
      CO_ENGRAM_ENGRAMS._showDirBanner(reasonText, res && res.dir ? res.dir : null);
    }
  },

  // 在 drawer 顶部插一条目录操作反馈 banner。
  // dirPath 提供时附带「复制路径」按钮;isSuccess=true 时 2.5s 后自动消失(不打扰),
  // 降级提示保留(用户要复制路径)。重复点击先清旧 banner,避免堆叠。
  _showDirBanner(message, dirPath, isSuccess) {
    var drawer = document.getElementById('detail-drawer');
    if (!drawer) return;
    var body = drawer.querySelector('.drawer-body');
    if (!body) return;
    var existing = body.querySelector('.dir-banner');
    if (existing) existing.remove();
    var copyBtn = dirPath
      ? ' <button class="btn mini secondary" onclick="CO_ENGRAM_ENGRAMS._copyDirPath(this)" data-dir="' + CO_ENGRAM.escapeHtml(dirPath) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.engram.openDirCopy')) + '</button>'
      : '';
    var banner = document.createElement('div');
    banner.className = isSuccess ? 'dir-banner dir-banner-success' : 'dir-banner';
    // message 是 i18n 文案(trusted HTML,含 <strong>/<code> 格式标签,与 _renderView 一致不 escape);
    // dirPath 是动态数据(目录绝对路径),必须 escape 防 XSS。
    banner.innerHTML = '<span>' + message + '</span>'
      + (dirPath ? '<code style="display:block;margin-top:.3rem;font-size:.8em;word-break:break-all">' + CO_ENGRAM.escapeHtml(dirPath) + '</code>' : '')
      + copyBtn
      + '<button class="dir-banner-close" onclick="this.parentElement.remove()" aria-label="close">×</button>';
    body.insertBefore(banner, body.firstChild);
    if (isSuccess) {
      setTimeout(function() { if (banner.parentNode) banner.remove(); }, 2500);
    }
  },

  // 复制目录路径到剪贴板(navigator.clipboard 优先,降级 execCommand)
  _copyDirPath(btn) {
    var path = btn.getAttribute('data-dir') || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(path);
      } else {
        var ta = document.createElement('textarea');
        ta.value = path; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      btn.textContent = CO_ENGRAM_T.t('viewer.engram.openDirCopied');
      setTimeout(function() { btn.textContent = CO_ENGRAM_T.t('viewer.engram.openDirCopy'); }, 1500);
    } catch (e) {
      btn.textContent = CO_ENGRAM_T.t('viewer.engram.openDirCopyFailed');
    }
  }
};

// ============================================================
// Skills（D10 对称 engrams tab）
// ============================================================
CO_ENGRAM.on('skills', async function() {
  const root = document.getElementById('skills-content');
  if (!root) return;
  if (CO_ENGRAM._skillsLoaded) return;
  CO_ENGRAM._skillsLoaded = true;
  await CO_ENGRAM_SKILLS.render(root);
});

window.CO_ENGRAM_SKILLS = {
  async render(root) {
    root.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.skill.loading')) + '</div>';

    // 初始化 paginator(参照 engrams tab 结构)
    if (!CO_ENGRAM._skillsPager) {
      CO_ENGRAM._skillsPager = CO_ENGRAM.createPaginator({
        endpoint: '/api/skills',
        pageSize: 100,
      });
      CO_ENGRAM._skillsViewStart = 0;
    }

    try { await CO_ENGRAM._skillsPager.load(); }
    catch (e) { root.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.skill.loadFailed', { err: e.message })) + '</div>'; return; }

    const all = CO_ENGRAM._skillsPager.getItems();
    CO_ENGRAM._skillsCache = all;
    CO_ENGRAM._skillsTotal = CO_ENGRAM._skillsPager.getTotal();

    // 后台渐进加载剩余批次
    if (CO_ENGRAM._skillsPager.hasMore()) {
      this._loadRemainingInBackground();
    }

    const T = CO_ENGRAM_T;
    const acquisitionStageKeys = ['draft', 'compiled', 'tuned'];
    const acquisitionStageOptions = acquisitionStageKeys.map(k => '<option value="' + k + '">' + CO_ENGRAM.escapeHtml(T.enumLabel('acquisitionStage', k)) + '</option>').join('');

    const retentionStageKeys = ['active', 'aging', 'stale', 'forgotten'];
    const retentionStageOptions = retentionStageKeys.map(k => '<option value="' + k + '">' + CO_ENGRAM.escapeHtml(T.enumLabel('retentionStage', k)) + '</option>').join('');

    const filterBar = '<div class="filter-bar">'
      + '<input type="search" placeholder="' + CO_ENGRAM.escapeHtml(T.t('skills.searchPlaceholder')) + '" id="skills-q" oninput="CO_ENGRAM_SKILLS.applyFilter()">'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('skills.filter.acquisitionStage')) + ' <select id="skills-acquisition-stage" onchange="CO_ENGRAM_SKILLS.applyFilter()">'
      + '<option value="">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.allStages')) + '</option>' + acquisitionStageOptions + '</select></label>'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('skills.filter.retentionStage')) + ' <select id="skills-retention-stage" onchange="CO_ENGRAM_SKILLS.applyFilter()">'
      + '<option value="">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.allRetentionStages')) + '</option>' + retentionStageOptions + '</select></label>'
      + '<label>' + CO_ENGRAM.escapeHtml(T.t('skills.filter.sort')) + ' <select id="skills-sort" onchange="CO_ENGRAM_SKILLS.applyFilter()">'
      + '<option value="createdAt-desc">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.sortNewest')) + '</option>'
      + '<option value="createdAt-asc">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.sortOldest')) + '</option>'
      + '<option value="utility-desc">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.sortUtility')) + '</option>'
      + '<option value="invocationCount-desc">' + CO_ENGRAM.escapeHtml(T.t('skills.filter.sortInvocations')) + '</option>'
      + '</select></label>'
      + '<span class="spacer"></span>'
      + '<span class="chip" id="skills-count">已加载 ' + all.length + ' / 共 ' + CO_ENGRAM._skillsTotal + (CO_ENGRAM._skillsPager && CO_ENGRAM._skillsPager.hasMore() ? ' · ' + CO_ENGRAM.escapeHtml(T.t('skills.pager.loadingHint')) : '') + '</span>'
      + '</div>'
      + '<div id="skills-body"></div>';

    root.innerHTML = filterBar;
    this.applyFilter();
  },

  applyFilter() {
    const pager = CO_ENGRAM._skillsPager;
    const cache = pager ? pager.getItems() : (CO_ENGRAM._skillsCache || []);
    const qRaw = ((document.getElementById('skills-q') || {}).value || '');
    const q = qRaw.toLowerCase();
    const acquisitionStage = (document.getElementById('skills-acquisition-stage') || {}).value || '';
    const retentionStage = (document.getElementById('skills-retention-stage') || {}).value || '';
    const sort = ((document.getElementById('skills-sort') || {}).value || 'createdAt-desc').split('-');
    const [sortKey, sortDir] = sort;
    const T = CO_ENGRAM_T;

    const filterSig = qRaw + '|' + acquisitionStage + '|' + retentionStage + '|' + sortKey + '-' + sortDir;
    if (CO_ENGRAM._skillsLastFilterSig !== filterSig) {
      CO_ENGRAM._skillsLastFilterSig = filterSig;
      CO_ENGRAM._skillsViewStart = 0;
    }

    let filtered = cache.filter(s => {
      if (acquisitionStage && s.acquisitionStage !== acquisitionStage) return false;
      if (retentionStage && s.retentionStage !== retentionStage) return false;
      if (q) {
        const id = (s.skillId || '').toLowerCase();
        const path = (s.sourcePath || '').toLowerCase();
        if (!id.includes(q) && !path.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const av = a[sortKey] || 0;
      const bv = b[sortKey] || 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });

    const body = document.getElementById('skills-body');
    if (!body) return;
    const total = pager ? pager.getTotal() : (CO_ENGRAM._skillsTotal ?? cache.length);
    const hasMore = pager ? pager.hasMore() : false;
    const isLoading = pager ? pager.isLoading() : false;
    const countEl = document.getElementById('skills-count');
    if (countEl) {
      const hint = (hasMore || isLoading) ? ' · ' + CO_ENGRAM.escapeHtml(T.t('skills.pager.loadingHint')) : '';
      countEl.textContent = '已加载 ' + cache.length + ' / 共 ' + total + hint;
    }

    if (!filtered.length) {
      body.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('skills.empty')) + '</div>';
      return;
    }

    // 卡片视图:客户端虚拟分页(每页 50)
    const VIEW_SIZE = 50;
    const maxStart = Math.max(0, filtered.length - VIEW_SIZE);
    let viewStart = CO_ENGRAM._skillsViewStart || 0;
    if (viewStart > maxStart) viewStart = maxStart;
    if (viewStart < 0) viewStart = 0;
    CO_ENGRAM._skillsViewStart = viewStart;
    const visible = filtered.slice(viewStart, viewStart + VIEW_SIZE);
    this._renderCards(visible, body);

    // 翻页控件(参照 engrams tab)
    const totalPages = Math.max(1, Math.ceil(total / VIEW_SIZE));
    const currentPage = Math.floor(viewStart / VIEW_SIZE) + 1;
    const canPrev = viewStart > 0;
    const filteredHasMoreInView = (viewStart + VIEW_SIZE) < filtered.length;
    const canNext = filteredHasMoreInView || hasMore;
    const navRow = document.createElement('div');
    navRow.className = 'pager-nav';
    navRow.style.cssText = 'text-align:center;padding:1rem 0;grid-column:1/-1;display:flex;gap:.4rem;justify-content:center;align-items:center;flex-wrap:wrap';
    const prevDisabled = canPrev ? '' : ' disabled';
    const nextDisabled = canNext ? '' : ' disabled';

    // 数字页码
    const pageList = [];
    if (totalPages <= 9) {
      for (let i = 1; i <= totalPages; i++) pageList.push(i);
    } else {
      pageList.push(1);
      if (currentPage > 4) pageList.push('ellipsis');
      const start = Math.max(2, currentPage - 2);
      const end = Math.min(totalPages - 1, currentPage + 2);
      for (let i = start; i <= end; i++) pageList.push(i);
      if (currentPage < totalPages - 3) pageList.push('ellipsis');
      pageList.push(totalPages);
    }
    let pageButtonsHtml = '';
    for (const p of pageList) {
      if (p === 'ellipsis') {
        pageButtonsHtml += '<span class="pager-ellipsis" style="padding:0 .3rem;color:var(--muted,#666)">…</span>';
      } else if (p === currentPage) {
        pageButtonsHtml += '<button class="btn pager-current" disabled style="font-weight:700;cursor:default;min-width:2.2rem">' + p + '</button>';
      } else {
        pageButtonsHtml += '<button class="btn secondary" onclick="CO_ENGRAM_SKILLS.gotoPage(' + (p - 1) + ')" style="min-width:2.2rem">' + p + '</button>';
      }
    }

    navRow.innerHTML =
      '<button class="btn secondary"' + prevDisabled + ' onclick="CO_ENGRAM_SKILLS.prevPage()">' + CO_ENGRAM.escapeHtml(T.t('skills.pager.prev')) + '</button>'
      + pageButtonsHtml
      + '<button class="btn secondary"' + nextDisabled + ' onclick="CO_ENGRAM_SKILLS.nextPage()">' + CO_ENGRAM.escapeHtml(T.t('skills.pager.next')) + '</button>'
      + '<span class="pager-info" style="margin-left:.6rem;color:var(--muted,#666);font-size:.85em">' + CO_ENGRAM.escapeHtml(T.t('skills.pager.pageInfo', { current: currentPage, total: totalPages, itemTotal: total })) + '</span>';
    body.appendChild(navRow);
  },

  _renderCards(filtered, body) {
    const T = CO_ENGRAM_T;
    body.innerHTML = '<div class="grid cols-3">' + filtered.map(s => {
      // acquisitionStage 徽标颜色映射
      const stageColors = {
        draft: '#8B857B',
        compiled: '#0F766E',
        tuned: '#B45309'
      };
      const stageColor = stageColors[s.acquisitionStage] || '#8B857B';

      // retentionStage 衰退条颜色映射
      const retentionColors = {
        active: '#0F766E',
        aging: '#B45309',
        stale: '#D7730D',
        forgotten: '#E02424'
      };
      const retentionColor = retentionColors[s.retentionStage] || '#8B857B';

      // utility 进度条 + 可信度(N<3 时 utility 不可靠 → 灰色 + 样本不足标记)
      const utilityPercent = Math.round((s.utility || 0) * 100);
      const _succ = s.successCount || 0, _fail = s.failureCount || 0;
      const _N = _succ + _fail;
      const _lowConf = _N < 3;
      const utilityBar = '<div class="bar-track" style="width:100px;height:8px;background:#F0EDE7;border-radius:4px;overflow:hidden"><div class="bar-fill" style="width:' + utilityPercent + '%;background:' + (_lowConf ? '#8B857B' : '#0F766E') + '"></div></div>';
      const lowConfBadge = _lowConf ? ' <span style="font-size:0.75rem;color:var(--muted,#666)"' + CO_ENGRAM.tip('skills.lowConfidence.tip') + '>' + CO_ENGRAM.escapeHtml(T.t('skills.lowConfidence')) + '</span>' : '';
      // 成功率(替代 raw success/failure 计数:用户真正关心"靠谱吗")
      const _rate = _N > 0 ? Math.round(_succ / _N * 100) : null;
      // 衰退风险(技能虽耐遗忘,半衰期~11 月,但久不用仍衰退 —— 可视化是差异化卖点)
      const _dr = CO_ENGRAM_SKILLS._decayRisk(s.retentionStage, s.lastUsedAt);
      const decayRow = _dr ? '<div class="card-meta" style="color:' + _dr.color + '">⏳ ' + CO_ENGRAM.escapeHtml(_dr.text) + '</div>' : '';

      // 统计数据:成功率 + 调用次数 + 最近使用(raw failureCount 融入成功率,不再单独显示)
      const stats = [];
      if (_rate != null) stats.push('<span title="' + CO_ENGRAM.escapeHtml(T.t('skills.successRate.tip')) + '">✓ ' + _rate + '%</span>');
      if (s.invocationCount != null) stats.push('<span title="' + CO_ENGRAM.escapeHtml(T.t('skills.invocationCount.tip')) + '">🔄 ' + s.invocationCount + '</span>');
      if (s.lastUsedAt) stats.push('<span title="' + CO_ENGRAM.escapeHtml(s.lastUsedAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(s.lastUsedAt)) + '</span>');

      // initiationSet 摘要(显示为「描述」:规则版内容即 SKILL.md description)
      let triggerInfo = '';
      if (s.initiationSet && s.initiationSet.length) {
        triggerInfo += '<div class="card-meta"><span class="card-meta-label">' + CO_ENGRAM.escapeHtml(T.t('skills.initiationSet')) + ':</span> ' + CO_ENGRAM.escapeHtml(s.initiationSet) + '</div>';
      }

      // composes 计数
      const composesBadge = s.composes && s.composes.length
        ? '<span class="chip" title="' + CO_ENGRAM.escapeHtml(T.t('skills.composes.tip')) + '">🔗 ' + s.composes.length + '</span>'
        : '';

      // SKILL.md 原生 version chip(A+1:内部字段 skillVersion,SKILL.md frontmatter version 经 parseSkillMd 映射)
      const versionChip = s.skillVersion
        ? '<span class="chip" style="border-left:3px solid var(--muted,#666)" title="' + CO_ENGRAM.escapeHtml(T.t('skills.version')) + '">v' + CO_ENGRAM.escapeHtml(s.skillVersion) + '</span> '
        : '';

      // 来源标识(展示层从 compatibility 推断,不存 sourceType 字段;YAGNI)
      const _compat = (s.compatibility || '').toLowerCase();
      const _srcTip = _compat.includes('openclaw') ? T.t('skills.sourceIcon.openclaw')
        : _compat.includes('claude') ? T.t('skills.sourceIcon.claude')
        : T.t('skills.sourceIcon.generic');
      const sourceIcon = '<span title="' + CO_ENGRAM.escapeHtml(_srcTip) + '">'
        + (_compat.includes('openclaw') ? '🦾' : _compat.includes('claude') ? '🧩' : '🌐') + '</span> ';

      // sourcePath 副标题
      const sourcePathHtml = s.sourcePath
        ? '<div class="card-meta"><span class="card-meta-label">' + CO_ENGRAM.escapeHtml(T.t('skills.sourcePath')) + ':</span> <code>' + CO_ENGRAM.escapeHtml(s.sourcePath) + '</code></div>'
        : '';

      return '<div class="card" style="cursor:pointer" onclick="CO_ENGRAM_SKILLS.open(\\'' + CO_ENGRAM.escapeHtml(s.skillId) + '\\')">'
        + '<div class="card-title">' + sourceIcon + CO_ENGRAM.escapeHtml(s.skillId) + '</div>'
        + sourcePathHtml
        + '<div>'
        + '<span class="chip" style="background:' + stageColor + '"' + CO_ENGRAM.tip('acquisitionStage.' + s.acquisitionStage) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('acquisitionStage', s.acquisitionStage)) + '</span> '
        + '<span class="chip" style="background:' + retentionColor + '"' + CO_ENGRAM.tip('retentionStage.' + s.retentionStage) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('retentionStage', s.retentionStage)) + '</span> '
        + composesBadge
        + versionChip
        + '</div>'
        + '<div class="card-meta" style="align-items:center;gap:0.5rem">'
        + '<span class="card-meta-label">' + CO_ENGRAM.escapeHtml(T.t('skills.utility')) + ':</span> '
        + utilityBar
        + '<span>' + utilityPercent + '%</span>'
        + lowConfBadge
        + '</div>'
        + (stats.length ? '<div class="card-meta">' + stats.join(' · ') + '</div>' : '')
        + triggerInfo
        + decayRow
        + '</div>';
    }).join('') + '</div>';
  },

  // 衰退风险文案:retentionStage 为主,active 时按 lastUsedAt 算天数预警
  // 认知科学:程序性记忆半衰期~11 月(Tatel 2025),远耐于事实记忆,但仍衰退 —— 可视化是 co-engram 差异化卖点
  _decayRisk(retentionStage, lastUsedAt) {
    const T = CO_ENGRAM_T;
    if (retentionStage === 'forgotten') return { color: '#E02424', text: T.t('skills.decayRisk.forgotten') };
    if (retentionStage === 'stale') return { color: '#D7730D', text: T.t('skills.decayRisk.stale') };
    if (retentionStage === 'aging') return { color: '#B45309', text: T.t('skills.decayRisk.aging') };
    if (retentionStage === 'active' && lastUsedAt) {
      const days = CO_ENGRAM_SKILLS._daysSince(lastUsedAt);
      if (days > 180) return { color: '#B45309', text: T.t('skills.decayRisk.soonAging', { days: days }) };
    }
    return null;
  },

  _daysSince(iso) {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return 0;
    return Math.floor((Date.now() - t) / 86400000);
  },

  // 打开 skill 详情 drawer（点击卡片触发）
  async open(skillId) {
    const T = CO_ENGRAM_T;
    let skill;
    try {
      skill = await CO_ENGRAM.apiGet('/api/skills/' + encodeURIComponent(skillId));
    } catch (e) {
      CO_ENGRAM.openDrawer('<h2>' + CO_ENGRAM.escapeHtml(skillId) + '</h2><div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>');
      return;
    }
    const stageColors = { draft: '#8B857B', compiled: '#0F766E', tuned: '#B45309' };
    const retentionColors = { active: '#0F766E', aging: '#B45309', stale: '#D7730D', forgotten: '#E02424' };
    const sc = stageColors[skill.acquisitionStage] || '#8B857B';
    const rc = retentionColors[skill.retentionStage] || '#8B857B';
    const up = Math.round((skill.utility || 0) * 100);
    const ub = '<div class="bar-track" style="width:120px;height:8px;background:#F0EDE7;border-radius:4px;overflow:hidden"><div class="bar-fill" style="width:' + up + '%;background:#0F766E"></div></div>';
    const _sc = skill.successCount || 0, _fc = skill.failureCount || 0;
    const _rateStr = (_sc + _fc) > 0 ? Math.round(_sc / (_sc + _fc) * 100) + '%' : '—';
    const body = '<div class="edit-banner" style="display:flex;gap:.5rem;align-items:center"><strong style="margin-right:auto">' + CO_ENGRAM.escapeHtml(T.t('viewer.skill.detailTitle')) + '</strong><code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(skill.skillId) + '</code><button class="btn secondary" onclick="CO_ENGRAM_SKILLS.openDir(\\\'' + CO_ENGRAM.escapeHtml(skill.skillId) + '\\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.skill.openDir')) + '</button></div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(skill.skillId) + '</h2>'
      + '<div class="field"><span class="chip" style="background:' + sc + '"' + CO_ENGRAM.tip('acquisitionStage.' + skill.acquisitionStage) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('acquisitionStage', skill.acquisitionStage)) + '</span> <span class="chip" style="background:' + rc + '"' + CO_ENGRAM.tip('retentionStage.' + skill.retentionStage) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('retentionStage', skill.retentionStage)) + '</span>'
      + (skill.retentionStage === 'forgotten' ? ' <button class="btn mini" onclick="CO_ENGRAM_SKILLS.restoreFromForgotten(\\\'' + CO_ENGRAM.escapeHtml(skill.skillId) + '\\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.restoreBtn')) + '</button>' : '')
      + '</div>'
      + '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.utility')) + '</span> ' + ub + ' <span>' + up + '%</span></div>'
      + (skill.initiationSet ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.initiationSet')) + '</span><div style="font-size:0.9rem;line-height:1.5">' + CO_ENGRAM.escapeHtml(skill.initiationSet) + '</div></div>' : '')
      + (skill.sourcePath ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.sourcePath')) + '</span><code>' + CO_ENGRAM.escapeHtml(skill.sourcePath) + '</code></div>' : '')
      + '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.successRate')) + '</span> ' + _rateStr + ' <span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.successCount')) + '</span> ' + _sc + ' <span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.failureCount')) + '</span> ' + _fc + ' <span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.invocationCount')) + '</span> ' + (skill.invocationCount || 0) + '</div>'
      + (skill.allowedTools && skill.allowedTools.length ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.allowedTools')) + '</span> ' + skill.allowedTools.map((t) => '<code>' + CO_ENGRAM.escapeHtml(t) + '</code>').join(' ') + '</div>' : '')
      + (skill.license ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.license')) + '</span> ' + CO_ENGRAM.escapeHtml(skill.license) + '</div>' : '')
      + (skill.skillVersion ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.version')) + '</span> v' + CO_ENGRAM.escapeHtml(skill.skillVersion) + '</div>' : '')
      + (skill.compatibility ? '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.compatibility')) + '</span> ' + CO_ENGRAM.escapeHtml(skill.compatibility) + '</div>' : '');
    CO_ENGRAM.openDrawer(body);
  },

  /**
   * 恢复 forgotten 技能:touch lastUsedAt 让 retention 回满 → active。
   * 用于详情 drawer retention 徽章旁的"恢复"按钮(与 engram 的恢复按钮对称)。
   */
  async restoreFromForgotten(skillId) {
    const T = CO_ENGRAM_T;
    if (!window.confirm(T.t('viewer.skill.restoreConfirm'))) return;
    try {
      await CO_ENGRAM.apiJson('/api/skills/' + encodeURIComponent(skillId) + '/reactivate', 'POST', null);
      CO_ENGRAM_SKILLS.open(skillId);  // 重新拉详情刷新 drawer
      try {
        if (CO_ENGRAM._skillsPager) { await CO_ENGRAM._skillsPager.load(); }
        CO_ENGRAM_SKILLS.applyFilter();
      } catch {}
    } catch (e) {
      alert(CO_ENGRAM.escapeHtml(T.t('viewer.common.saveFailed', { err: (e.message || e) })));
    }
  },

  // 后台渐进加载剩余批次
  async _loadRemainingInBackground() {
    const pager = CO_ENGRAM._skillsPager;
    if (!pager) return;
    while (pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) { break; }
      this._refreshCountChip();
    }
    this._refreshCountChip();
    this.applyFilter();
  },

  // 刷新 count chip 文案
  _refreshCountChip() {
    const pager = CO_ENGRAM._skillsPager;
    if (!pager) return;
    const T = CO_ENGRAM_T;
    const el = document.getElementById('skills-count');
    if (!el) return;
    const hint = (pager.hasMore() || pager.isLoading()) ? ' · ' + CO_ENGRAM.escapeHtml(T.t('skills.pager.loadingHint')) : '';
    el.textContent = '已加载 ' + pager.getItems().length + ' / 共 ' + pager.getTotal() + hint;
  },

  async prevPage() {
    const VIEW_SIZE = 50;
    const pager = CO_ENGRAM._skillsPager;
    if (!pager) return;
    const current = CO_ENGRAM._skillsViewStart || 0;
    if (current <= 0) return;
    CO_ENGRAM._skillsViewStart = Math.max(0, current - VIEW_SIZE);
    this.applyFilter();
    const body = document.getElementById('skills-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async nextPage() {
    const VIEW_SIZE = 50;
    const pager = CO_ENGRAM._skillsPager;
    if (!pager) return;
    const current = CO_ENGRAM._skillsViewStart || 0;
    const loaded = pager.getItems().length;
    if (current + VIEW_SIZE >= loaded && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) { alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e }))); return; }
    }
    CO_ENGRAM._skillsViewStart = current + VIEW_SIZE;
    this.applyFilter();
    const body = document.getElementById('skills-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async gotoPage(zeroBasedPage) {
    const VIEW_SIZE = 50;
    const pager = CO_ENGRAM._skillsPager;
    if (!pager) return;
    const target = zeroBasedPage * VIEW_SIZE;
    while (target >= pager.getItems().length && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) {
        alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e })));
        return;
      }
    }
    CO_ENGRAM._skillsViewStart = target;
    this.applyFilter();
    const body = document.getElementById('skills-body');
    if (body && body.scrollIntoView) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // 「打开目录」:POST /api/skills/:id/reveal,server 端 spawn 系统文件管理器。
  // 对称 CO_ENGRAM_ENGRAMS.openDir;成功 → drawer 顶部成功 banner;降级 → 展示路径 + 复制按钮。
  async openDir(skillId) {
    const T = CO_ENGRAM_T;
    var res;
    try {
      res = await CO_ENGRAM.apiJson('/api/skills/' + encodeURIComponent(skillId) + '/reveal', 'POST', null);
    } catch (e) {
      CO_ENGRAM_SKILLS._showDirBanner(T.t('viewer.skill.openDirFailed', { err: CO_ENGRAM.escapeHtml(String(e.message || e)) }), null);
      return;
    }
    if (res && res.opened) {
      CO_ENGRAM_SKILLS._showDirBanner(T.t('viewer.skill.openDirOpened'), null, true);
    } else {
      var reasonKey = (res && res.reason) ? ('viewer.skill.openDirReason.' + res.reason) : 'viewer.skill.openDirReason.fallback';
      var reasonText = T.t(reasonKey);
      CO_ENGRAM_SKILLS._showDirBanner(reasonText, res && res.dir ? res.dir : null);
    }
  },

  // 在 drawer 顶部插目录操作反馈 banner(对称 CO_ENGRAM_ENGRAMS._showDirBanner)。
  // dirPath 提供时附带「复制路径」按钮;isSuccess=true 时 2.5s 后自动消失。
  _showDirBanner(message, dirPath, isSuccess) {
    var drawer = document.getElementById('detail-drawer');
    if (!drawer) return;
    var body = drawer.querySelector('.drawer-body');
    if (!body) return;
    var existing = body.querySelector('.dir-banner');
    if (existing) existing.remove();
    var copyBtn = dirPath
      ? ' <button class="btn mini secondary" onclick="CO_ENGRAM_SKILLS._copyDirPath(this)" data-dir="' + CO_ENGRAM.escapeHtml(dirPath) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.skill.openDirCopy')) + '</button>'
      : '';
    var banner = document.createElement('div');
    banner.className = isSuccess ? 'dir-banner dir-banner-success' : 'dir-banner';
    banner.innerHTML = '<span>' + message + '</span>'
      + (dirPath ? '<code style="display:block;margin-top:.3rem;font-size:.8em;word-break:break-all">' + CO_ENGRAM.escapeHtml(dirPath) + '</code>' : '')
      + copyBtn
      + '<button class="dir-banner-close" onclick="this.parentElement.remove()" aria-label="close">×</button>';
    body.insertBefore(banner, body.firstChild);
    if (isSuccess) {
      setTimeout(function() { if (banner.parentNode) banner.remove(); }, 2500);
    }
  },

  // 复制目录路径到剪贴板(对称 CO_ENGRAM_ENGRAMS._copyDirPath)。
  _copyDirPath(btn) {
    var path = btn.getAttribute('data-dir') || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(path);
      } else {
        var ta = document.createElement('textarea');
        ta.value = path; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      btn.textContent = CO_ENGRAM_T.t('viewer.skill.openDirCopied');
      setTimeout(function() { btn.textContent = CO_ENGRAM_T.t('viewer.skill.openDirCopy'); }, 1500);
    } catch (e) {
      btn.textContent = CO_ENGRAM_T.t('viewer.skill.openDirCopyFailed');
    }
  }
};

// ============================================================
// Proposals
// ============================================================
CO_ENGRAM.on('proposals', async function() {
  const root = document.getElementById('proposals-content');
  if (!root) return;
  if (CO_ENGRAM._proposalsLoaded) return;
  CO_ENGRAM._proposalsLoaded = true;
  await CO_ENGRAM_PROPOSALS.render(root);
});

window.CO_ENGRAM_PROPOSALS = {
  async render(root) {
    const T = CO_ENGRAM_T;
    root.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.loading.proposals')) + '</div>';

    // 初始化 paginator:status 作为 server-side filter(切 status 时 reset + load)
    this._currentStatus = this._currentStatus || 'pending';
    if (!CO_ENGRAM._proposalsPager) {
      CO_ENGRAM._proposalsPager = CO_ENGRAM.createPaginator({
        endpoint: '/api/proposals',
        pageSize: 50,
        getExtraParams: function() { return { status: CO_ENGRAM_PROPOSALS._currentStatus }; },
      });
    }

    try { await CO_ENGRAM._proposalsPager.load(); }
    catch (e) { root.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>'; return; }

    // 检查 enabled=false(proposals engine 未启用)
    const lastResp = CO_ENGRAM._proposalsPager.getLastResponse();
    if (lastResp && lastResp.enabled === false) {
      root.innerHTML = '<div class="empty"><div class="icon">💤</div>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.disabledHint')) + '</div>';
      return;
    }

    this._render();
  },

  /**
   * 启发式推断 proposal 的卡片标题和类型。
   *
   * 优先级(p.payload 存在 = auto-memory / external-markdown 来源):
   *   - title:p.payload.title(完整,LLM 已生成)→ 否则从 centroidExcerpt 取首句(≤50 字)→ entityId
   *   - kind:p.payload.kind(明确)→ 否则基于关键词匹配 centroidExcerpt
   *
   * 类型关键词覆盖 5 种 EngramKind:
   *   - procedure:步骤/流程/how to/step
   *   - fact:应该/必须/always/never/事实
   *   - hypothesis:也许/可能/maybe/probably/假设
   *   - pattern:规律/总是/usually/pattern
   *   - observation:观察到/noticed/看到
   *   默认 observation(中性、不强行猜)。
   *
   * 注意:返回的 title 已为「卡片视图」截断到 50 字。drawer 详情用 _drawerTitle 拿全长。
   */
  _inferMeta(p) {
    const payload = p.payload;
    // kind:payload 明确 → 否则关键词推断
    let kind = (payload && payload.kind) || '';
    if (!kind) {
      const text = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
      if (/(步骤|流程|怎么|如何|how to|step|procedure|process|算法|流程图)/i.test(text)) kind = 'procedure';
      else if (/(应该|必须|总是|事实|always|never|must|fact|规则|定律)/i.test(text)) kind = 'fact';
      else if (/(也许|可能|猜测|假设|maybe|probably|hypoth|hypo|猜测)/i.test(text)) kind = 'hypothesis';
      else if (/(规律|模式|通常|惯|pattern|usually|tend to|often)/i.test(text)) kind = 'pattern';
      else kind = 'observation';
    }

    // title:payload.title(完整) → centroidExcerpt 首句截断 → entityId
    let title = '';
    if (payload && payload.title) {
      title = payload.title.trim();
      // 卡片视图仍要截断(避免单条标题撑爆卡片高度)
      if (title.length > 50) title = title.slice(0, 50) + '…';
    } else {
      const text = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
      title = text.trim();
      if (title) {
        const firstClause = title.split(/[。.!?\\n??;；]/)[0].trim();
        title = firstClause || title;
        if (title.length > 50) title = title.slice(0, 50) + '…';
      }
    }
    if (!title) title = p.entityId;

    return { title, kind };
  },

  /**
   * Drawer 详情页用的全长标题(不截断,用户可编辑)。
   * payload.title → centroidExcerpt 首句(无截断)→ entityId。
   */
  _drawerTitle(p) {
    const payload = p.payload;
    if (payload && payload.title) return payload.title;
    const text = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
    const trimmed = text.trim();
    if (trimmed) {
      const firstClause = trimmed.split(/[。.!?\\n??;；]/)[0].trim();
      return firstClause || trimmed;
    }
    return p.entityId;
  },

  /**
   * 卡片预览文本(140 字截断)。
   * 优先级:payload.summary → payload.content → centroidExcerpt → sampleQuotes[0]。
   */
  _previewClip(p) {
    const payload = p.payload;
    const preview = (
      (payload && payload.summary) ||
      (payload && payload.content) ||
      p.centroidExcerpt ||
      (p.sampleQuotes || [])[0] ||
      ''
    ).toString();
    return preview.length > 140 ? preview.slice(0, 140) + '…' : preview;
  },

  /**
   * ISO 时间 → MM-DD HH:mm 短时间(纯数字,中英通用,用于卡片紧凑行)。
   * 解析失败返回空串。
   */
  _shortTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '-' + dd + ' ' + hh + ':' + mi;
  },

  /**
   * 时间窗口描述。
   * compact=true(卡片用):返回 '{firstShort} → {lastShort}' 短范围;单点退化返回该点短值;皆空返回 ''。
   * compact=false/缺省(drawer 用):返回 '{firstShort} → {lastShort}({dur} 内 {n} 次出现)'。
   * 时长:<1 小时按分钟、<1 天按小时、否则按天(向下取整,最少 1 天)。
   */
  formatWindow(firstSeenAt, lastSeenAt, occurrences, opts) {
    const T = CO_ENGRAM_T;
    const occ = occurrences || 0;
    const compact = !!(opts && opts.compact);
    const first = firstSeenAt ? new Date(firstSeenAt) : null;
    const last = lastSeenAt ? new Date(lastSeenAt) : null;
    const firstOk = first && !isNaN(first.getTime());
    const lastOk = last && !isNaN(last.getTime());

    // 皆空:compact 给空串;完整给「N 次」
    if (!firstOk && !lastOk) {
      return compact ? '' : (occ ? (occ + ' ' + T.t('viewer.proposals.sourceLine.times')) : '');
    }
    // 双时间且不同:compact 给短范围;完整给「范围(时长内 N 次)」
    if (firstOk && lastOk && first.getTime() !== last.getTime()) {
      const range = this._shortTs(firstSeenAt) + ' → ' + this._shortTs(lastSeenAt);
      if (compact) return range;
      const firstMs = first.getTime();
      const lastMs = last.getTime();
      const diffMs = lastMs - firstMs;
      const mins = Math.max(1, Math.floor(diffMs / 60000));
      let dur;
      if (mins < 60) dur = mins + ' ' + T.t('viewer.proposals.why.window.minute');
      else if (mins < 1440) dur = Math.floor(mins / 60) + ' ' + T.t('viewer.proposals.why.window.hour');
      else dur = Math.max(1, Math.floor(mins / 1440)) + ' ' + T.t('viewer.proposals.why.window.day');
      return range + ' (' + T.t('viewer.proposals.why.window.within', { dur: dur, n: occ }) + ')';
    }
    // 两者相等或仅一个:compact 给该点短值;完整给「N 次」或该点短值
    const singleIso = firstOk ? firstSeenAt : lastSeenAt;
    return compact ? this._shortTs(singleIso) : (occ ? (occ + ' ' + T.t('viewer.proposals.sourceLine.times')) : (this._shortTs(singleIso) || ''));
  },

  /**
   * 卡片紧凑来源行(在 meta chip 行之后、previewClip 之前)。
   * 按 source 分模板;conversation 含时间范围 + 次数;external/auto-memory 含文件标识。
   * rem-* 走专属卡片,调用方已 continue 跳过,不进本函数。
   */
  _sourceLine(p) {
    const T = CO_ENGRAM_T;
    const src = p.source || 'conversation';
    const occ = p.occurrences || 0;
    const times = T.t('viewer.proposals.sourceLine.times');
    if (src === 'external-markdown') {
      const base = (p.sourcePath || '').split('/').pop();
      return '<div class="proposal-source-line" style="font-size:.78rem;color:var(--fg-muted);margin:.2rem 0 .35rem">📄 '
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.sourceLine.external'))
        + (base ? ' · ' + CO_ENGRAM.escapeHtml(base) : '') + '</div>';
    }
    if (src === 'auto-memory') {
      return '<div class="proposal-source-line" style="font-size:.78rem;color:var(--fg-muted);margin:.2rem 0 .35rem">🧠 '
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.sourceLine.autoMemory'))
        + (p.slug ? ' · ' + CO_ENGRAM.escapeHtml(p.slug) : '') + '</div>';
    }
    if (src === 'skill') {
      const pl = p.payload || {};
      const sp = p.sourcePath || pl.skillSourcePath || '';
      return '<div class="proposal-source-line" style="font-size:.78rem;color:var(--fg-muted);margin:.2rem 0 .35rem">📁 '
        + (sp ? '<code>' + CO_ENGRAM.escapeHtml(sp) + '</code>' : CO_ENGRAM.escapeHtml(T.t('viewer.proposals.sourceLine.skill'))) + '</div>';
    }
    // conversation(含 undefined 向前兼容)
    const range = this.formatWindow(p.firstSeenAt, p.lastSeenAt, occ, { compact: true });
    const parts = ['💬 ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.sourceLine.conversation'))];
    if (range) parts.push(CO_ENGRAM.escapeHtml(range));
    if (occ) parts.push(occ + ' ' + CO_ENGRAM.escapeHtml(times));
    return '<div class="proposal-source-line" style="font-size:.78rem;color:var(--fg-muted);margin:.2rem 0 .35rem">' + parts.join(' · ') + '</div>';
  },

  /**
   * drawer「为什么生成」结构化块:📍来源 / ⏱时间 / 🔍为什么 / 📝代表片段 + 折叠高级。
   * 必要性文案纯模板拼接,不解析 necessityReason 机器串;原始串进「高级」折叠区。
   */
  _whyBlock(p) {
    const T = CO_ENGRAM_T;
    const src = p.source || 'conversation';
    const sampleN = (p.sampleQuotes || []).length;

    // 📍 来源
    let sourceLabel;
    if (src === 'external-markdown') sourceLabel = T.t('viewer.proposals.why.sourceLabel.external')
      + (p.sourcePath ? '(' + p.sourcePath + ')' : '');
    else if (src === 'auto-memory') sourceLabel = T.t('viewer.proposals.why.sourceLabel.autoMemory')
      + (p.slug ? '(' + p.slug + ')' : '');
    else if (src === 'rem-pattern') sourceLabel = T.t('viewer.proposals.why.sourceLabel.remPattern');
    else if (src === 'rem-verification') sourceLabel = T.t('viewer.proposals.why.sourceLabel.remVerification');
    else if (src === 'skill') sourceLabel = T.t('viewer.proposals.why.sourceLabel.skill')
      + (p.sourcePath ? '(' + p.sourcePath + ')' : '');
    else sourceLabel = T.t('viewer.proposals.why.sourceLabel.conversation');

    // ⏱ 时间
    const window_ = this.formatWindow(p.firstSeenAt, p.lastSeenAt, p.occurrences, { compact: false });

    // 🔍 为什么(按 source 分模板)
    let why;
    if (src === 'external-markdown') why = T.t('viewer.proposals.why.necessity.external');
    else if (src === 'auto-memory') why = T.t('viewer.proposals.why.necessity.autoMemory');
    else if (src === 'rem-pattern') why = T.t('viewer.proposals.why.necessity.remPattern');
    else if (src === 'rem-verification') why = T.t('viewer.proposals.why.necessity.remVerification');
    else if (src === 'skill') why = T.t('viewer.proposals.why.necessity.skill');
    else why = sampleN
      ? T.t('viewer.proposals.why.necessity.conversation', { n: sampleN })
      : T.t('viewer.proposals.why.necessity.fallback');

    const field = (icon, label, val) => '<div style="margin:.25rem 0;font-size:.88rem;line-height:1.55">'
      + '<span style="color:var(--fg-muted)">' + icon + ' ' + CO_ENGRAM.escapeHtml(label) + ':</span> '
      + CO_ENGRAM.escapeHtml(val) + '</div>';

    let html = '<div class="proposal-why-block" style="background:rgba(125,125,125,.06);border:1px solid var(--border,rgba(125,125,125,.18));border-radius:.5rem;padding:.6rem .75rem;margin:.5rem 0">'
      + '<div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.why.title')) + '</div>'
      + field('📍', T.t('viewer.proposals.why.source'), sourceLabel)
      + (window_ ? field('⏱', T.t('viewer.proposals.why.window'), window_) : '')
      + field('🔍', T.t('viewer.proposals.why.necessity'), why);

    // 📝 代表片段(仅 conversation 的 sampleQuotes 是对话片段;ext/auto-memory 完整内容在表单区;rem-* 是元数据,不在此重复)
    const samples = p.sampleQuotes || [];
    if (samples.length && src === 'conversation') {
      html += '<div style="margin:.25rem 0;font-size:.88rem;line-height:1.55"><span style="color:var(--fg-muted)">📝 '
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.why.samples')) + ':</span></div>';
      for (const s of samples) {
        html += '<pre class="pre-compact" style="margin:.2rem 0">' + CO_ENGRAM.escapeHtml(s) + '</pre>';
      }
    }

    // ▸ 高级(折叠:necessityReason 原文 + necessityRule)
    if (p.necessityReason || p.necessityRule) {
      html += '<details style="margin-top:.4rem"><summary style="cursor:pointer;font-size:.8rem;color:var(--fg-muted)">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.why.advanced')) + '</summary>';
      if (p.necessityReason) {
        html += '<div style="font-size:.78rem;color:var(--fg-muted);margin:.3rem 0"><strong>'
          + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.why.advancedReason')) + ':</strong> '
          + CO_ENGRAM.escapeHtml(p.necessityReason) + '</div>';
      }
      if (p.necessityRule) {
        html += '<div style="font-size:.78rem;color:var(--fg-muted);margin:.3rem 0"><strong>'
          + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.why.advancedRule')) + ':</strong> '
          + CO_ENGRAM.escapeHtml(p.necessityRule) + '</div>';
      }
      html += '</details>';
    }
    html += '</div>';
    return html;
  },

  async _setStatus(status) {
    this._currentStatus = status;
    // 切 status 等于切 server-side filter,旧 viewStart 索引的页面不再相关 → 回第一页
    CO_ENGRAM._proposalsViewStart = 0;
    if (CO_ENGRAM._proposalsPager) {
      try { await CO_ENGRAM._proposalsPager.load(); }
      catch (e) { /* 加载失败保留当前 items,_render 会展示 */ }
    }
    this._render();
  },

  // 兼容旧 onclick 引用 — 等价于 nextPage
  async loadMore() {
    await this.nextPage();
  },

  prevPage() {
    const VIEW_SIZE = 30;
    const current = CO_ENGRAM._proposalsViewStart || 0;
    if (current <= 0) return;
    CO_ENGRAM._proposalsViewStart = Math.max(0, current - VIEW_SIZE);
    this._render();
    const root = document.getElementById('proposals-content');
    if (root && root.scrollIntoView) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async nextPage() {
    const VIEW_SIZE = 30;
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager) return;
    const current = CO_ENGRAM._proposalsViewStart || 0;
    const loaded = pager.getItems().length;
    // 当前已加载不够覆盖下一页起点,且 server 还有更多 → loadMore 再前进
    if (current + VIEW_SIZE >= loaded && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) { alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e }))); return; }
    }
    CO_ENGRAM._proposalsViewStart = current + VIEW_SIZE;
    this._render();
    const root = document.getElementById('proposals-content');
    if (root && root.scrollIntoView) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // 跳到任意页(0-based index);已加载不足时按需 await loadMore 扩容
  async gotoPage(zeroBasedPage) {
    const VIEW_SIZE = 30;
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager) return;
    if (zeroBasedPage < 0) zeroBasedPage = 0;
    const target = zeroBasedPage * VIEW_SIZE;
    while (target >= pager.getItems().length && pager.hasMore()) {
      try { await pager.loadMore(); }
      catch (e) {
        alert(CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loadFailed', { err: e.message || e })));
        return;
      }
    }
    CO_ENGRAM._proposalsViewStart = target;
    this._render();
    const root = document.getElementById('proposals-content');
    if (root && root.scrollIntoView) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  _render() {
    const T = CO_ENGRAM_T;
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager) return;
    const items = pager.getItems();
    const total = pager.getTotal();
    const currentStatus = this._currentStatus || 'pending';
    const root = document.getElementById('proposals-content');
    if (!root) return;

    const STATUS_KEY = { pending: 'viewer.proposals.status.pending', accepted: 'viewer.proposals.status.accepted', dismissed: 'viewer.proposals.status.dismissed', all: 'viewer.proposals.status.all' };
    const statusLabel = (s) => T.t(STATUS_KEY[s] || 'viewer.proposals.status.pending');

    // Bug 5: 从 last response 取 statusCounts,让按钮显示「已采纳(N) / 已驳回(N) / 全部(N)」。
    // 后端 GET /api/proposals 已注入该字段(proposal-engine.ts statusCounts())。
    const lastResp = pager.getLastResponse() || {};
    const statusCounts = (lastResp && lastResp.statusCounts) || {};
    const countFor = (s) => {
      const n = statusCounts[s];
      return (typeof n === 'number') ? ' (' + n + ')' : '';
    };

    const buttons = ['pending', 'accepted', 'dismissed', 'all'].map(s =>
      '<button class="tab ' + (s === currentStatus ? 'active' : '') + '" onclick="CO_ENGRAM_PROPOSALS._setStatus(\\'' + s + '\\')">'
      + CO_ENGRAM.escapeHtml(statusLabel(s) + countFor(s)) + '</button>'
    ).join('');

    // 客户端虚拟分页(2026-07):与 engrams tab 同款翻页模式。
    // 旧版"加载更多"按钮在 2044+ 条候选下点击一次要拉一批,UI 无页码概念;
    // 改为每页 30 条 + « 1 2 3 … » 翻页控件,pager 在边界按需 loadMore 扩容。
    const VIEW_SIZE = 30;
    const hasMore = pager.hasMore();
    const maxStart = Math.max(0, items.length - VIEW_SIZE);
    let viewStart = CO_ENGRAM._proposalsViewStart || 0;
    if (viewStart > maxStart) viewStart = maxStart;
    if (viewStart < 0) viewStart = 0;
    CO_ENGRAM._proposalsViewStart = viewStart;
    const visible = items.slice(viewStart, viewStart + VIEW_SIZE);

    // 批量操作(2026-07 新增):全部采纳 / 全部驳回,作用范围 = 当前已加载的 pending 提案
    // 仅显示当前页面这批(visible),用户翻页后范围随之变化,避免误操作整批 2000+ 条
    const visiblePending = visible.filter(p => p.status === 'pending');
    const batchBtns = visiblePending.length > 0
      ? '<button class="btn mini" style="margin-left:0.5rem" onclick="CO_ENGRAM_PROPOSALS.acceptAllLoaded()">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.batch.acceptAll', { n: visiblePending.length })) + '</button>'
        + '<button class="btn mini" style="margin-left:0.25rem" onclick="CO_ENGRAM_PROPOSALS.dismissAllLoaded()">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.batch.dismissAll', { n: visiblePending.length })) + '</button>'
      : '';

    // Bug 6:已驳回 tab 显示「彻底清空(N)」按钮 —— 把 dismissed 提案从磁盘 proposals.json 物理删除
    // 仅在 currentStatus=dismissed 且确实有 dismissed 提案时显示;物理删除不可恢复,需 confirm
    const dismissedCount = (typeof statusCounts.dismissed === 'number') ? statusCounts.dismissed : 0;
    const purgeBtn = (currentStatus === 'dismissed' && dismissedCount > 0)
      ? '<button class="btn mini" style="margin-left:0.25rem" onclick="CO_ENGRAM_PROPOSALS.purgeDismissed()">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.batch.purgeDismissed', { n: dismissedCount })) + '</button>'
      : '';

    // 仅在 currentStatus=accepted 且确实有 accepted 提案时显示;清空采纳记录但保留已创建的 engram
    const acceptedCount = (typeof statusCounts.accepted === 'number') ? statusCounts.accepted : 0;
    const purgeAcceptedBtn = (currentStatus === 'accepted' && acceptedCount > 0)
      ? '<button class="btn mini" style="margin-left:0.25rem" onclick="CO_ENGRAM_PROPOSALS.purgeAccepted()">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.batch.purgeAccepted', { n: acceptedCount })) + '</button>'
      : '';

    let html = '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">' + buttons
      + '<span class="chip">已加载 ' + items.length + ' / 共 ' + total + (hasMore ? ' · ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.pager.hasMoreHint', { n: total - items.length })) : '') + '</span>'
      + batchBtns + purgeBtn + purgeAcceptedBtn + '</div>';
    if (!items.length) {
      // pending 用 emptyHint（「系统在后台观察」教育性提示）；其他 tab 用 empty 反映 filter（如「没有 已采纳 提案」），避免 emptyHint 在 accepted/dismissed 下暗示「新提案会出现在这里」造成误导。
      const emptyText = currentStatus === 'pending'
        ? T.t('viewer.proposals.emptyHint')
        : T.t('viewer.proposals.empty', { status: statusLabel(currentStatus) });
      // Bug 7(2026-07):空状态提示居中 —— 给 inner div 加 margin:0 auto,
      // 让 max-width:480px 的盒子本身在 .empty 容器里水平居中(原来只对齐文字,
      // 盒子在宽容器里仍贴左,视觉不居中)。
      html += '<div class="empty"><div class="icon">🌱</div>'
        + '<div style="color:var(--fg-muted);font-size:0.95rem;max-width:480px;margin:0 auto;text-align:center">' + CO_ENGRAM.escapeHtml(emptyText) + '</div>'
        + '</div>';
    } else {
      html += '<div class="grid cols-3">';
      for (const p of visible) {
        // REM verification proposal: 专属卡片(改已有记忆状态,不创建新记忆)
        // centroidExcerpt 格式:title|before|action|score(action = 变更后状态)
        if (p.source === 'rem-verification') {
          var remParts = (p.centroidExcerpt || '').split('|');
          var remTitle = remParts[0] || '';
          var remBefore = remParts[1] || '';
          var remAction = remParts[2] || '';
          var remScore = parseFloat(remParts[3] || '0') || 0;
          var engId = (p.entityId || '').replace(/^rem:/, '');
          var isAccepted = p.status === 'accepted';
          var isDismissed = p.status === 'dismissed';
          var isRefute = remAction === 'refuted';

          // 验证状态:用 enumLabel(术语统一 + 中英双语)
          var beforeZh = T.enumLabel('verificationStatus', remBefore) || remBefore;
          var afterZh = T.enumLabel('verificationStatus', remAction) || remAction;

          // 可信度档位(i18n key + 颜色),裸分数值放 hover
          var bandKey, bandColor;
          if (remScore >= 0.85) { bandKey = 'veryHigh'; bandColor = '#34d399'; }
          else if (remScore >= 0.7) { bandKey = 'high'; bandColor = '#34d399'; }
          else if (remScore >= 0.5) { bandKey = 'medium'; bandColor = '#fbbf24'; }
          else if (remScore >= 0.3) { bandKey = 'low'; bandColor = '#fbbf24'; }
          else { bandKey = 'veryLow'; bandColor = '#E02424'; }
          var bandZh = T.t('viewer.proposals.rem.band.' + bandKey);
          var bandTip = T.t('viewer.proposals.rem.bandTip', { score: remScore.toFixed(2) });

          // 场景:反驳(红)/升级(青)
          var sceneColor = isRefute ? '#E02424' : 'var(--accent,#5DECD9)';
          var sceneLabel = T.t(isRefute ? 'viewer.proposals.rem.scene.refute' : 'viewer.proposals.rem.scene.verify');
          var reasonZh = T.t(isRefute ? 'viewer.proposals.rem.reason.refute' : 'viewer.proposals.rem.reason.verify');

          html += '<div class="card" style="border-left:3px solid ' + sceneColor + '">'
            + '<div class="card-title" style="cursor:pointer" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(engId) + '\\')">'
            + CO_ENGRAM.escapeHtml(remTitle || engId.slice(-8))
            + '</div>'
            + '<div class="card-meta" style="margin:.45rem 0;display:flex;flex-wrap:wrap;gap:.35rem;align-items:center">'
            + '<span class="chip" style="border-color:' + sceneColor + ';color:' + sceneColor + '">🌙 ' + CO_ENGRAM.escapeHtml(sceneLabel) + '</span>'
            + '<span class="chip" style="color:' + bandColor + '" title="' + CO_ENGRAM.escapeHtml(bandTip) + '">' + CO_ENGRAM.escapeHtml(bandZh) + '</span>'
            + '<span class="chip">' + CO_ENGRAM.escapeHtml(beforeZh) + ' → <strong style="color:' + sceneColor + '">' + CO_ENGRAM.escapeHtml(afterZh) + '</strong></span>'
            + '<span class="chip" style="margin-left:auto;opacity:.7">' + CO_ENGRAM.escapeHtml(statusLabel(p.status)) + '</span>'
            + '</div>'
            + '<div style="font-size:.83rem;color:var(--fg-muted);line-height:1.55">' + CO_ENGRAM.escapeHtml(reasonZh) + '</div>';
          if (isAccepted) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:var(--accent)">✓ ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.applied')) + '(' + CO_ENGRAM.escapeHtml(afterZh) + ')</span></div>';
          } else if (isDismissed) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.kept')) + '</span></div>';
          } else {
            var acceptLabel = T.t(isRefute ? 'viewer.proposals.rem.accept.refute' : 'viewer.proposals.rem.accept.verify');
            var dismissLabel = T.t('viewer.proposals.rem.dismiss');
            html += '<div style="margin-top:.55rem;display:flex;gap:.5rem">'
              + '<button class="btn mini" style="background:' + sceneColor + ';color:#050816;font-weight:600" onclick="CO_ENGRAM_PROPOSALS.acceptRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(acceptLabel) + '</button>'
              + '<button class="btn mini" onclick="CO_ENGRAM_PROPOSALS.dismissRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(dismissLabel) + '</button>'
              + '</div>';
          }
          html += '</div>';
          continue;
        }

        // REM synapse proposal:专属卡片(增/删/改 突触,不创建 engram)
        if (p.source === 'rem-synapse') {
          var op = (p.payload && p.payload.synapseOp) || 'add';
          var sKind = (p.payload && p.payload.synapseKind) || '';
          var sOldKind = (p.payload && p.payload.synapseOldKind) || '';
          var sConf = parseFloat((p.payload && p.payload.remSynapseConfidence)) || 0;
          var fromId = (p.payload && p.payload.synapseFrom) || '';
          var toId = (p.payload && p.payload.synapseTo) || '';
          var fromTitle = (p.payload && p.payload.synapseFromTitle) || fromId.slice(-8);
          var toTitle = (p.payload && p.payload.synapseToTitle) || toId.slice(-8);
          var isAccepted = p.status === 'accepted';
          var isDismissed = p.status === 'dismissed';

          // 可信度档位(复用 rem-verification 的 5 档逻辑)
          var bandKey, bandColor;
          if (sConf >= 0.85) { bandKey = 'veryHigh'; bandColor = '#34d399'; }
          else if (sConf >= 0.7) { bandKey = 'high'; bandColor = '#34d399'; }
          else if (sConf >= 0.5) { bandKey = 'medium'; bandColor = '#fbbf24'; }
          else if (sConf >= 0.3) { bandKey = 'low'; bandColor = '#fbbf24'; }
          else { bandKey = 'veryLow'; bandColor = '#E02424'; }
          var bandZh = T.t('viewer.proposals.rem.band.' + bandKey);
          var bandTip = T.t('viewer.proposals.rem.bandTip', { score: sConf.toFixed(2) });

          // 场景色:add 青 / delete 红 / retype 黄
          var sceneColor = op === 'add' ? 'var(--accent,#5DECD9)' : (op === 'delete' ? '#E02424' : '#fbbf24');
          var synapseKindLabel = T.enumLabel('synapseKind', sKind) || sKind;
          var synapseKindColor = CO_ENGRAM.edgeColor(sKind);

          html += '<div class="card" style="border-left:3px solid ' + sceneColor + '">'
            + '<div class="card-title" style="cursor:pointer" onclick="CO_ENGRAM_PROPOSALS.openSynapseDetail(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.op.' + op)) + '</div>'
            + '<div class="card-meta" style="margin:.45rem 0;display:flex;flex-wrap:wrap;gap:.35rem;align-items:center">'
            + '<span class="chip" style="border-color:' + sceneColor + ';color:' + sceneColor + '">🌙 ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.scene.synapse')) + '</span>'
            + '<span class="chip" style="color:' + bandColor + '" title="' + CO_ENGRAM.escapeHtml(bandTip) + '">' + CO_ENGRAM.escapeHtml(bandZh) + '</span>'
            + (op === 'delete'
                ? '<span class="chip">🔗 ' + CO_ENGRAM.escapeHtml(T.enumLabel('synapseKind', sOldKind) || sOldKind) + '</span>'
                : (op === 'retype'
                    ? '<span class="chip">' + CO_ENGRAM.escapeHtml(T.enumLabel('synapseKind', sOldKind) || sOldKind) + ' → <strong style="color:' + synapseKindColor + '">' + CO_ENGRAM.escapeHtml(synapseKindLabel) + '</strong></span>'
                    : '<span class="chip" style="border-left:3px solid ' + synapseKindColor + '">🔗 ' + CO_ENGRAM.escapeHtml(synapseKindLabel) + '</span>'))
            + '<span class="chip" style="cursor:pointer" onclick="CO_ENGRAM.showTab(&quot;engrams&quot;);setTimeout(function(){CO_ENGRAM_ENGRAMS.open(&quot;' + CO_ENGRAM.escapeHtml(fromId) + '&quot;)},50)">' + CO_ENGRAM.escapeHtml(fromTitle) + '</span>'
            + '<span style="opacity:.5">→</span>'
            + '<span class="chip" style="cursor:pointer" onclick="CO_ENGRAM.showTab(&quot;engrams&quot;);setTimeout(function(){CO_ENGRAM_ENGRAMS.open(&quot;' + CO_ENGRAM.escapeHtml(toId) + '&quot;)},50)">' + CO_ENGRAM.escapeHtml(toTitle) + '</span>'
            + '<span class="chip" style="margin-left:auto;opacity:.7">' + CO_ENGRAM.escapeHtml(statusLabel(p.status)) + '</span>'
            + '</div>'
            + '<div style="font-size:.83rem;color:var(--fg-muted);line-height:1.55">' + CO_ENGRAM.escapeHtml((p.payload && p.payload.remSynapseReason) || T.t('viewer.proposals.rem.synapse.reason.' + op)) + '</div>';
          if (isAccepted) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:var(--accent)">✓ ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.applied')) + '</span></div>';
          } else if (isDismissed) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.kept')) + '</span></div>';
          } else {
            html += '<div style="margin-top:.55rem;display:flex;gap:.5rem">'
              + '<button class="btn mini" style="background:' + sceneColor + ';color:#050816;font-weight:600" onclick="CO_ENGRAM_PROPOSALS.acceptRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.op.' + op)) + '</button>'
              + '<button class="btn mini" onclick="CO_ENGRAM_PROPOSALS.dismissRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.dismiss')) + '</button>'
              + '</div>';
          }
          html += '</div>';
          continue;
        }

        // REM tag-refresh proposal:专属卡片(改已有记忆的 domainTags,不创建 engram)
        if (p.source === 'rem-tag-refresh') {
          var tEngId = (p.payload && p.payload.tagEngramId) || '';
          var tOld = (p.payload && p.payload.tagOldTags) || [];
          var tNew = (p.payload && p.payload.tagNewTags) || [];
          var tReason = (p.payload && p.payload.tagReason) || '';
          var tDrift = parseFloat(p.payload && p.payload.tagDrift) || 0;
          var tTitle = (p.centroidExcerpt || tEngId).slice(0, 80);
          var isAccepted = p.status === 'accepted';
          var isDismissed = p.status === 'dismissed';

          var sceneColor = '#7C3AED';
          var sceneLabel = T.t('viewer.proposals.rem.scene.tagRefresh');

          // oldTags → newTags diff:删除(红,删除线)/ 保留(灰)/ 新增(绿,加粗)
          var oldSet = {}; (tOld || []).forEach(function (t) { oldSet[t] = true; });
          var newSet = {}; (tNew || []).forEach(function (t) { newSet[t] = true; });
          var removedTags = (tOld || []).filter(function (t) { return !newSet[t]; });
          var addedTags = (tNew || []).filter(function (t) { return !oldSet[t]; });
          var keptTags = (tOld || []).filter(function (t) { return newSet[t]; });

          html += '<div class="card" style="border-left:3px solid ' + sceneColor + '">'
            + '<div class="card-title" style="cursor:pointer" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(tEngId) + '\\')">'
            + CO_ENGRAM.escapeHtml(tTitle || tEngId.slice(-8))
            + '</div>'
            + '<div class="card-meta" style="margin:.45rem 0;display:flex;flex-wrap:wrap;gap:.35rem;align-items:center">'
            + '<span class="chip" style="border-color:' + sceneColor + ';color:' + sceneColor + '">🌙 ' + CO_ENGRAM.escapeHtml(sceneLabel) + '</span>'
            + (tDrift ? '<span class="chip" style="color:#fbbf24" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.tagRefresh.driftTip', { drift: tDrift.toFixed(2) })) + '">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.tagRefresh.drift', { drift: tDrift.toFixed(2) })) + '</span>' : '')
            + '<span class="chip" style="margin-left:auto;opacity:.7">' + CO_ENGRAM.escapeHtml(statusLabel(p.status)) + '</span>'
            + '</div>'
            + '<div style="font-size:.83rem;color:var(--fg-muted);margin:.3rem 0 .15rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.tagRefresh.from')) + '</div>'
            + '<div class="card-meta" style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.35rem">'
            + removedTags.map(function (t) { return '<span class="chip" style="color:#E02424;text-decoration:line-through">' + CO_ENGRAM.escapeHtml(t) + '</span>'; }).join('')
            + keptTags.map(function (t) { return '<span class="chip" style="opacity:.55">' + CO_ENGRAM.escapeHtml(t) + '</span>'; }).join('')
            + (removedTags.length === 0 && keptTags.length === 0 ? '<span class="chip" style="opacity:.4">∅</span>' : '')
            + '</div>'
            + '<div style="font-size:.83rem;color:var(--fg-muted);margin:.3rem 0 .15rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.tagRefresh.to')) + '</div>'
            + '<div class="card-meta" style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.35rem">'
            + addedTags.map(function (t) { return '<span class="chip" style="color:#34d399;font-weight:600">' + CO_ENGRAM.escapeHtml(t) + '</span>'; }).join('')
            + keptTags.map(function (t) { return '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>'; }).join('')
            + '</div>'
            + '<div style="font-size:.83rem;color:var(--fg-muted);line-height:1.55">' + CO_ENGRAM.escapeHtml(tReason) + '</div>';
          if (isAccepted) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:var(--accent)">✓ ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.applied')) + '</span></div>';
          } else if (isDismissed) {
            html += '<div class="card-meta" style="margin-top:.5rem"><span class="chip" style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.kept')) + '</span></div>';
          } else {
            html += '<div style="margin-top:.55rem;display:flex;gap:.5rem">'
              + '<button class="btn mini" style="background:' + sceneColor + ';color:#050816;font-weight:600" onclick="CO_ENGRAM_PROPOSALS.acceptRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.tagRefresh.accept')) + '</button>'
              + '<button class="btn mini" onclick="CO_ENGRAM_PROPOSALS.dismissRem(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.dismiss')) + '</button>'
              + '</div>';
          }
          html += '</div>';
          continue;
        }

        const meta = this._inferMeta(p);
        const kindLabel = T.enumLabel('kind', meta.kind);
        const kindColor = CO_ENGRAM.kindColor(meta.kind);
        const previewClip = this._previewClip(p);
        const cardClick = ' style="cursor:pointer;border-left:3px solid ' + kindColor + '" onclick="CO_ENGRAM_PROPOSALS.open(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')"';
        const sampleCount = (p.sampleQuotes || []).length;
        // rem-pattern 专属标识(dreaming 提炼的新模式记忆):梦境标识 + 提炼置信度 + 来源数
        var isRemPattern = p.source === 'rem-pattern';
        var rpConf = (p.payload && typeof p.payload.remConfidence === 'number') ? p.payload.remConfidence : 0;
        var rpBandKey = rpConf >= 0.85 ? 'veryHigh' : (rpConf >= 0.7 ? 'high' : (rpConf >= 0.5 ? 'medium' : (rpConf >= 0.3 ? 'low' : 'veryLow')));
        var rpConfColor = rpConf >= 0.7 ? '#34d399' : (rpConf >= 0.5 ? '#fbbf24' : '#E02424');
        var rpSrcN = (p.payload && p.payload.remSourceIds) ? p.payload.remSourceIds.length : 0;
        var remPatternChips = isRemPattern
          ? '<span class="chip" style="border-color:var(--accent,#5DECD9);color:var(--accent,#5DECD9)">🌙 ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.scene.pattern')) + '</span>'
            + '<span class="chip" style="color:' + rpConfColor + '" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.bandTip', { score: rpConf.toFixed(2) })) + '">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.band.' + rpBandKey)) + '</span>'
            + (rpSrcN ? '<span class="chip" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.pattern.sourceTip')) + '">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.pattern.sourceCount', { n: rpSrcN })) + '</span>' : '')
          : '';
        // skill 专属标识(程序性记忆提案,区别于 engram/ext-md/REM):🛠️ 醒目 chip
        var isSkill = p.source === 'skill';
        var skillChip = isSkill
          ? '<span class="chip" style="border-color:var(--kind-procedure,#D7730D);color:var(--kind-procedure,#D7730D)">🛠️ ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.skillBadge')) + '</span>'
          : '';
        // rem-insight 专属标识(深度思考/夜思洞察,spec §三/§五):模式 + critic 分
        var isRemInsight = p.source === 'rem-insight';
        var riMode = (p.payload && p.payload.insightMode) ? p.payload.insightMode : '';
        var riScore = (p.payload && typeof p.payload.criticScore === 'number') ? p.payload.criticScore : 0;
        var riColor = riScore >= 0.7 ? '#34d399' : (riScore >= 0.5 ? '#fbbf24' : '#E02424');
        var riHasInc = !!(p.payload && p.payload.incubationId);
        var remInsightChips = isRemInsight
          ? '<span class="chip" style="border-color:#a78bfa;color:#a78bfa">💡 ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.insight.badge')) + '</span>'
            + (riMode ? '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.insight.mode.' + riMode)) + '</span>' : '')
            + '<span class="chip" style="color:' + riColor + '" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.insight.criticTip')) + '">critic ' + riScore.toFixed(2) + '</span>'
            + (riHasInc ? '<span class="chip" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.insight.incubationTip')) + '">🌙</span>' : '')
          : '';
        // payload.domainTags(若有)+ occurrences/sample chip
        const payloadTags = (p.payload && Array.isArray(p.payload.domainTags)) ? p.payload.domainTags.slice(0, 4) : [];
        const moreTags = (p.payload && Array.isArray(p.payload.domainTags) && p.payload.domainTags.length > 4) ? (p.payload.domainTags.length - 4) : 0;
        const tagsHtml = payloadTags.map(tg => '<span class="chip">' + CO_ENGRAM.escapeHtml(tg) + '</span>').join(' ')
          + (moreTags ? '<span class="chip">+' + moreTags + '</span>' : '');

        html += '<div class="card"' + cardClick + '>'
          + '<div class="card-title" title="' + CO_ENGRAM.escapeHtml(p.entityId) + '">' + CO_ENGRAM.escapeHtml(meta.title) + '</div>';
        html += '<div class="card-meta" style="margin-bottom:0.4rem;display:flex;flex-wrap:wrap;gap:.3rem;align-items:center">'
          + remPatternChips
          + remInsightChips
          + skillChip
          + '<span class="chip kind-' + meta.kind + '"' + CO_ENGRAM.tip('kind.' + meta.kind) + '>' + CO_ENGRAM.escapeHtml(kindLabel) + '</span>'
          + '<span class="chip" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.card.occurrences', { n: p.occurrences || 0 })) + '">⚡ ' + (p.occurrences || 0) + '</span>'
          + (sampleCount ? '<span class="chip" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.card.samples', { n: sampleCount })) + '">💬 ' + sampleCount + '</span>' : '')
          + (p.createdAt ? '<span title="' + CO_ENGRAM.escapeHtml(p.createdAt) + '">' + CO_ENGRAM.relativeTime(p.createdAt) + '</span>' : '')
          + '<span class="chip">' + CO_ENGRAM.escapeHtml(statusLabel(p.status)) + '</span>'
          + (p.payload && p.payload.visibility ? CO_ENGRAM.renderVisibilityBadge(p.payload.visibility) : '')
          + '</div>';
        html += this._sourceLine(p);
        if (previewClip) {
          if (isSkill) {
            // skill 的 previewClip = description(用途)——审批核心,突出显示(非通用灰色预览)
            html += '<div style="font-size:0.9rem;margin:.15rem 0 .4rem;line-height:1.55"><span style="color:var(--kind-procedure,#D7730D);font-weight:600">📌 ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.skill.usage')) + '</span> ' + CO_ENGRAM.escapeHtml(previewClip) + '</div>';
          } else {
            html += '<div style="font-size:0.82rem;color:var(--fg-muted);margin-bottom:0.4rem;line-height:1.5">' + CO_ENGRAM.escapeHtml(previewClip) + '</div>';
          }
        } else {
          html += '<div style="font-size:0.82rem;color:var(--fg-muted);margin-bottom:0.4rem;font-style:italic">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.card.noPreview')) + '</div>';
        }
        if (tagsHtml) {
          html += '<div class="card-meta" style="margin-bottom:0.3rem">' + tagsHtml + '</div>';
        }
        if (p.status === 'accepted' && p.acceptedEngramId) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(16,185,129,.12);color:var(--accent)">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.convertedTo')) + ' ▸ ' + CO_ENGRAM.escapeHtml(p.acceptedEngramId.slice(0, 12)) + '</span></div>';
        }
        if (p.status === 'dismissed' && p.dismissReason) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(239,68,68,.12);color:#ef4444">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.dismissedReason')) + ': ' + CO_ENGRAM.escapeHtml((p.dismissReason || '').slice(0, 40)) + '</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';

      // 翻页控件:« 上页  1 2 3 … 22  下页 »  + 页码信息(复用 engrams.pager.* 翻译键)
      const totalPages = Math.max(1, Math.ceil(total / VIEW_SIZE));
      const currentPage = Math.floor(viewStart / VIEW_SIZE) + 1;
      const canPrev = viewStart > 0;
      const canNext = (viewStart + VIEW_SIZE) < items.length || hasMore;
      const pageList = [];
      if (totalPages <= 9) {
        for (let i = 1; i <= totalPages; i++) pageList.push(i);
      } else {
        pageList.push(1);
        if (currentPage > 4) pageList.push('ellipsis');
        const start = Math.max(2, currentPage - 2);
        const end = Math.min(totalPages - 1, currentPage + 2);
        for (let i = start; i <= end; i++) pageList.push(i);
        if (currentPage < totalPages - 3) pageList.push('ellipsis');
        pageList.push(totalPages);
      }
      let pageButtonsHtml = '';
      for (const p of pageList) {
        if (p === 'ellipsis') {
          pageButtonsHtml += '<span class="pager-ellipsis" style="padding:0 .3rem;color:var(--muted,#666)">…</span>';
        } else if (p === currentPage) {
          pageButtonsHtml += '<button class="btn pager-current" disabled style="font-weight:700;cursor:default;min-width:2.2rem">' + p + '</button>';
        } else {
          pageButtonsHtml += '<button class="btn secondary" onclick="CO_ENGRAM_PROPOSALS.gotoPage(' + (p - 1) + ')" style="min-width:2.2rem">' + p + '</button>';
        }
      }
      const prevDisabled = canPrev ? '' : ' disabled';
      const nextDisabled = canNext ? '' : ' disabled';
      html += '<div class="pager-nav" style="text-align:center;padding:1rem 0;display:flex;gap:.4rem;justify-content:center;align-items:center;flex-wrap:wrap">'
        + '<button class="btn secondary"' + prevDisabled + ' onclick="CO_ENGRAM_PROPOSALS.prevPage()">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.prev')) + '</button>'
        + pageButtonsHtml
        + '<button class="btn secondary"' + nextDisabled + ' onclick="CO_ENGRAM_PROPOSALS.nextPage()">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.next')) + '</button>'
        + '<span class="pager-info" style="margin-left:.6rem;color:var(--muted,#666);font-size:.85em">' + CO_ENGRAM.escapeHtml(T.t('engrams.pager.pageInfo', { current: currentPage, total: totalPages, itemTotal: total })) + '</span>'
        + '</div>';
    }
    root.innerHTML = html;
  },

  /**
   * 打开 proposal 详情 drawer,提供完整编辑表单。
   * 用户可以在这里调整 title/kind/content/domainTags,然后 Accept 或 Dismiss。
   * 替代原来 prompt() 的简陋交互。
   */
  open(entityId) {
    const T = CO_ENGRAM_T;
    const cache = CO_ENGRAM._proposalsPager ? CO_ENGRAM._proposalsPager.getItems() : (CO_ENGRAM._proposalsCache || []);
    const p = cache.find(x => x.entityId === entityId);
    if (!p) { CO_ENGRAM.openDrawer('<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.notFound', { id: entityId })) + '</div>'); return; }
    CO_ENGRAM._currentProposal = p;

    const meta = this._inferMeta(p);
    const kindKeys = ['observation', 'fact', 'pattern', 'procedure', 'hypothesis'];
    const kindOptions = kindKeys.map(k =>
      '<option value="' + k + '"' + (meta.kind === k ? ' selected' : '') + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k)) + '</option>'
    ).join('');

    const accepted = p.status === 'accepted';
    const dismissed = p.status === 'dismissed';
    const editable = p.status === 'pending';

    // visibility 下拉:默认 public,payload 自带 visibility 时用它预选
    const visKeys = ['public', 'team', 'private', 'restricted'];
    const initialVis = (p.payload && p.payload.visibility) || 'public';
    const visOptions = visKeys.map(v =>
      '<option value="' + v + '"' + (initialVis === v ? ' selected' : '') + CO_ENGRAM.tip('visibility.' + v) + '>'
      + CO_ENGRAM.escapeHtml(T.t('viewer.engram.visibilityBadge.' + v))
      + '</option>'
    ).join('');

    let actionBtns = '';
    if (editable) {
      actionBtns = '<div class="config-save-bar">'
        + '<button class="btn secondary" onclick="CO_ENGRAM_PROPOSALS.dismissFromForm()">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.dismissBtn')) + '</button>'
        + '<button class="btn" onclick="CO_ENGRAM_PROPOSALS.acceptFromForm()">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.acceptBtn')) + '</button>'
        + '</div>';
    } else {
      actionBtns = '<div class="edit-banner">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.currentStatus')) + ' <strong>' + CO_ENGRAM.escapeHtml(T.enumLabel('status', p.status) || p.status) + '</strong>'
        + (accepted && p.acceptedEngramId ? '<br>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.createdEngram')) + ' <code>' + CO_ENGRAM.escapeHtml(p.acceptedEngramId) + '</code>' : '')
        + (dismissed && p.dismissedUntil ? '<br>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.dismissedUntil')) + ' ' + CO_ENGRAM.escapeHtml(p.dismissedUntil) : '')
        + '</div>';
    }

    // skill 提案:专属表单(skillId + 描述 只读 + visibility),
    // 隐藏 engram 的 kind/content/domainTags(skill accept 后端用 payload,这些字段无意义)
    if ((p.source || 'conversation') === 'skill') {
      const _pl = p.payload || {};
      const _skillBody = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
        + '<strong style="margin-right:auto">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.detailTitle')) + '</strong>'
        + '<code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(p.entityId) + '</code></div>'
        + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.skillIdLabel')) + '</label>'
        + '<input id="pf-title" type="text" value="' + CO_ENGRAM.escapeHtml(this._drawerTitle(p)) + '" readonly></div>'
        + '<div class="field" style="opacity:0.9"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('skills.initiationSet')) + '</label>'
        + '<div style="font-size:0.9rem;line-height:1.5">' + CO_ENGRAM.escapeHtml(_pl.initiationSet || '') + '</div></div>'
        + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
        + '<label class="field-label" for="pf-visibility"' + CO_ENGRAM.tip('visibility.public') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.visibility.label')) + '</label>'
        + '<select id="pf-visibility" name="visibility"' + (editable ? '' : ' disabled') + CO_ENGRAM.tip('visibility.public') + '>' + visOptions + '</select>'
        + '<div class="kpi-sub">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.visibility.hint')) + '</div></div>'
        + this._whyBlock(p)
        + actionBtns;
      CO_ENGRAM.openDrawer(_skillBody);
      return;
    }

    const body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.detailTitle')) + '</strong>'
      + '<code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(p.entityId) + '</code>'
      + '</div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.titleLabel') : T.t('viewer.proposals.titleLabelReadonly')) + '</label>'
      + '<input id="pf-title" type="text" value="' + CO_ENGRAM.escapeHtml(this._drawerTitle(p)) + '"' + (editable ? '' : ' readonly') + '></div>'
      + '<div class="field"'
      + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label"' + CO_ENGRAM.tip('kind.fact') + '>' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.kindLabel') : T.t('viewer.proposals.kindLabelReadonly')) + '</label>'
      + '<select id="pf-kind"' + (editable ? '' : ' disabled') + '>' + kindOptions + '</select></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label" for="pf-visibility"' + CO_ENGRAM.tip('visibility.public') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.visibility.label')) + '</label>'
      + '<select id="pf-visibility" name="visibility"' + (editable ? '' : ' disabled') + CO_ENGRAM.tip('visibility.public') + '>' + visOptions + '</select>'
      + '<div class="kpi-sub">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.visibility.hint')) + '</div></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.tagsLabel') : T.t('viewer.proposals.tagsLabelReadonly')) + '</label>'
      + '<input id="pf-tags" type="text" value="' + CO_ENGRAM.escapeHtml((p.payload && Array.isArray(p.payload.domainTags) ? p.payload.domainTags : []).join(',')) + '" placeholder="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.tagsPlaceholder')) + '"' + (editable ? '' : ' readonly') + '></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.contentLabel') : T.t('viewer.proposals.contentLabelReadonly')) + '</label>'
      + '<textarea id="pf-content" rows="6"' + (editable ? '' : ' readonly') + '>' + CO_ENGRAM.escapeHtml((p.payload && p.payload.content) || p.centroidExcerpt || '') + '</textarea></div>'
      + this._whyBlock(p)
      + actionBtns;

    CO_ENGRAM.openDrawer(body);
  },

  async acceptFromForm() {
    const T = CO_ENGRAM_T;
    const p = CO_ENGRAM._currentProposal;
    if (!p) return;
    // skill 提案:后端 accept 用 payload(skillId/initiationSet),
    // 表单只透传 visibility(engram 的 kind/content/domainTags 对 skill 无意义,不传)
    if ((p.source || 'conversation') === 'skill') {
      const _vis = (document.getElementById('pf-visibility') || {}).value || 'public';
      try {
        const _payload = (_vis && _vis !== 'public') ? { visibility: _vis } : {};
        await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/accept', 'POST', _payload);
        CO_ENGRAM.closeDrawer();
        CO_ENGRAM._proposalsLoaded = false;
        await this.render(document.getElementById('proposals-content'));
        if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
      } catch (e) {
        alert(T.t('viewer.common.loadFailed', { err: (e && e.message) || String(e) }));
      }
      return;
    }
    const title = (document.getElementById('pf-title').value || '').trim();
    const content = (document.getElementById('pf-content').value || '').trim();
    const kind = document.getElementById('pf-kind').value;
    const tags = (document.getElementById('pf-tags').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const visibility = document.getElementById('pf-visibility').value;
    if (!title) { alert(T.t('viewer.proposals.titleRequired')); return; }
    if (!content) { alert(T.t('viewer.proposals.contentRequired')); return; }
    try {
      // visibility === 'public' 时不传,让 accept() 走默认值;非 public 才透传(减少 audit 噪声)
      const payload = { title, content, kind, domainTags: tags, ...(visibility && visibility !== 'public' ? { visibility } : {}) };
      const r = await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/accept', 'POST', payload);
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
      const engramId = r && r.engramId ? r.engramId : '';
      alert(T.t('viewer.proposals.acceptedToast') + (engramId ? '\\n' + T.t('viewer.proposals.createdEngramToast', { id: engramId }) : ''));
    } catch (e) { alert(T.t('viewer.proposals.acceptFailed', { err: (e.message || e) })); }
  },

  /**
   * 批量采纳当前可见页面的 pending 提案(2026-07 新增)
   *
   * 设计要点:
   *   - 范围限定 visible(当前 30 条),避免误操作 2000+ 条整批
   *   - accept() 内部用 payload 兜底(auto-memory / external-markdown 来源自带完整字段)
   *   - 串行执行:每条 accept 写 proposals.json,后端单进程但 fetch 并发会触发文件
   *     race,串行 await 是最简单的正确性保证
   *   - 高 blast radius:每条创建一条 engram(不可一键撤销),需 confirm 对话框
   *   - 部分失败:逐条 try-catch,最终 alert 汇总(ok / fail)
   */
  async acceptAllLoaded() {
    const T = CO_ENGRAM_T;
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager) return;
    const items = pager.getItems();
    const VIEW_SIZE = 30;
    const viewStart = CO_ENGRAM._proposalsViewStart || 0;
    const visible = items.slice(viewStart, viewStart + VIEW_SIZE);
    const pending = visible.filter(p => p.status === 'pending');
    if (!pending.length) { alert(T.t('viewer.proposals.batch.noPending')); return; }
    if (!confirm(T.t('viewer.proposals.batch.acceptAllConfirm', { n: pending.length }))) return;

    let ok = 0, fail = 0;
    const errors = [];
    for (const p of pending) {
      try {
        // 不传任何字段 → accept() 走 payload 兜底(auto-memory/external-markdown 自带)
        // conversation 来源缺字段时会抛错,记入 fail 继续下一条
        await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/accept', 'POST', {});
        ok++;
      } catch (e) {
        fail++;
        errors.push(p.entityId + ': ' + (e.message || e));
      }
    }
    CO_ENGRAM._proposalsLoaded = false;
    await this.render(document.getElementById('proposals-content'));
    if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
    const summary = T.t('viewer.proposals.batch.acceptAllToast', { ok, fail })
      + (errors.length ? '\\n\\n' + errors.slice(0, 5).join('\\n') : '');
    alert(summary);
  },

  /**
   * 批量驳回当前可见页面的 pending 提案(2026-07 新增)
   *
   * dismiss 是低风险操作(只是状态标记 + audit 保留),但仍串行执行避免文件 race。
   * 范围同 acceptAllLoaded:visible 内的 pending。
   */
  async dismissAllLoaded() {
    const T = CO_ENGRAM_T;
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager) return;
    const items = pager.getItems();
    const VIEW_SIZE = 30;
    const viewStart = CO_ENGRAM._proposalsViewStart || 0;
    const visible = items.slice(viewStart, viewStart + VIEW_SIZE);
    const pending = visible.filter(p => p.status === 'pending');
    if (!pending.length) { alert(T.t('viewer.proposals.batch.noPending')); return; }
    if (!confirm(T.t('viewer.proposals.batch.dismissAllConfirm', { n: pending.length }))) return;

    let ok = 0, fail = 0;
    const errors = [];
    for (const p of pending) {
      try {
        await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/dismiss', 'POST', {});
        ok++;
      } catch (e) {
        fail++;
        errors.push(p.entityId + ': ' + (e.message || e));
      }
    }
    CO_ENGRAM._proposalsLoaded = false;
    await this.render(document.getElementById('proposals-content'));
    if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
    const summary = T.t('viewer.proposals.batch.dismissAllToast', { ok, fail })
      + (errors.length ? '\\n\\n' + errors.slice(0, 5).join('\\n') : '');
    alert(summary);
  },

  /**
   * 物理清空所有已驳回的 proposal(2026-07 新增 — Bug 6)
   *
   * 与 dismissAllLoaded 的关键差别:
   *   - dismissAllLoaded:把 visible 内 pending 标记为 dismissed(软删除,proposals.json 仍保留)
   *   - purgeDismissed:把所有 status=dismissed 的 proposal 从 proposals.json 物理删除
   *
   * 高 blast radius:物理删除不可恢复(audit log 保留),需 confirm 对话框。
   * 调用后端 POST /api/proposals/purge-dismissed,后端走 proposalEngine.purgeDismissed()。
   * 删除完成后 reload pager,trigger statusCounts 刷新(按钮上数字归零)。
   */
  async purgeDismissed() {
    const T = CO_ENGRAM_T;
    const lastResp = CO_ENGRAM._proposalsPager ? CO_ENGRAM._proposalsPager.getLastResponse() : null;
    const dismissedCount = (lastResp && lastResp.statusCounts && typeof lastResp.statusCounts.dismissed === 'number')
      ? lastResp.statusCounts.dismissed : 0;
    if (!dismissedCount) { alert(T.t('viewer.proposals.batch.purgeNoDismissed')); return; }
    if (!confirm(T.t('viewer.proposals.batch.purgeConfirm', { n: dismissedCount }))) return;

    try {
      const resp = await CO_ENGRAM.apiJson('/api/proposals/purge-dismissed', 'POST', {});
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      alert(T.t('viewer.proposals.batch.purgeToast', { n: resp.purgedCount || 0 }));
    } catch (e) {
      alert(T.t('viewer.proposals.batch.purgeFailed', { err: (e.message || e) }));
    }
  },

  async purgeAccepted() {
    const T = CO_ENGRAM_T;
    const lastResp = CO_ENGRAM._proposalsPager ? CO_ENGRAM._proposalsPager.getLastResponse() : null;
    const acceptedCount = (lastResp && lastResp.statusCounts && typeof lastResp.statusCounts.accepted === 'number')
      ? lastResp.statusCounts.accepted : 0;
    if (!acceptedCount) { alert(T.t('viewer.proposals.batch.purgeNoAccepted')); return; }
    if (!confirm(T.t('viewer.proposals.batch.purgeAcceptedConfirm', { n: acceptedCount }))) return;

    try {
      const resp = await CO_ENGRAM.apiJson('/api/proposals/purge-accepted', 'POST', {});
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
      alert(T.t('viewer.proposals.batch.purgeAcceptedToast', { n: resp.purgedCount || 0 }));
    } catch (e) {
      alert(T.t('viewer.proposals.batch.purgeFailed', { err: (e.message || e) }));
    }
  },

  async dismissFromForm() {
    const T = CO_ENGRAM_T;
    const p = CO_ENGRAM._currentProposal;
    if (!p) return;
    if (!confirm(T.t('viewer.proposals.dismissConfirm'))) return;
    try {
      await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/dismiss', 'POST', {});
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
    } catch (e) { alert(T.t('viewer.proposals.dismissFailed', { err: (e.message || e) })); }
  },

  /** @deprecated 保留旧 API 兼容(从其他地方调用),内部走 open() */
  async accept(entityId) {
    this.open(entityId);
  },

  async dismiss(entityId) {
    const p = (CO_ENGRAM._proposalsCache || []).find(x => x.entityId === entityId);
    if (!p) return;
    CO_ENGRAM._currentProposal = p;
    await this.dismissFromForm();
  },

  /**
   * REM verification 提案专用:直接 accept,跳过 conversation 抽屉。
   * rem-verification 后端 accept 分支无需 title/content 字段(只改 verificationStatus
   * + confidence),空 body POST 即可(同 acceptAllLoaded);成功后刷新提案列表 + 徽章。
   */
  async acceptRem(entityId) {
    try {
      await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(entityId) + '/accept', 'POST', {});
      // Invalidate 缓存:rem-synapse accept 后突触计数变化,engram 详情/graph 需重新拉取
      CO_ENGRAM._engramsLoaded = false;
      CO_ENGRAM._engramsCache = null;
      CO_ENGRAM._graphState = null; // graph 缓存失效
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
      CO_ENGRAM.closeDrawer(); // 关闭详情抽屉(acceptRem 从详情页调用时需关闭)
    } catch (e) { alert(CO_ENGRAM_T.t('viewer.proposals.rem.acceptFail') + ': ' + ((e && e.message) || e)); }
  },

  /** REM verification 提案专用:直接 dismiss(保持现状),跳过 conversation 抽屉。 */
  async dismissRem(entityId) {
    try {
      await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(entityId) + '/dismiss', 'POST', {});
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      if (typeof CO_ENGRAM.refreshProposalsBadge === 'function') CO_ENGRAM.refreshProposalsBadge();
      CO_ENGRAM.closeDrawer(); // 关闭详情抽屉(dismissRem 从详情页调用时需关闭)
    } catch (e) { alert(CO_ENGRAM_T.t('viewer.proposals.rem.dismissFail') + ': ' + ((e && e.message) || e)); }
  },

  /**
   * REM synapse 提案详情抽屉:显示突触两端记忆、操作类型、置信度、原因等完整信息。
   * 点击 rem-synapse 卡片的 card-title 触发。
   */
  openSynapseDetail(entityId) {
    const T = CO_ENGRAM_T;
    const cache = CO_ENGRAM._proposalsPager ? CO_ENGRAM._proposalsPager.getItems() : (CO_ENGRAM._proposalsCache || []);
    const p = cache.find(x => x.entityId === entityId);
    if (!p) { CO_ENGRAM.openDrawer('<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.notFound', { id: entityId })) + '</div>'); return; }

    const op = (p.payload && p.payload.synapseOp) || 'add';
    const fromId = (p.payload && p.payload.synapseFrom) || '';
    const toId = (p.payload && p.payload.synapseTo) || '';
    const fromTitle = (p.payload && p.payload.synapseFromTitle) || fromId.slice(-8);
    const toTitle = (p.payload && p.payload.synapseToTitle) || toId.slice(-8);
    const synapseKind = (p.payload && p.payload.synapseKind) || '';
    const synapseOldKind = (p.payload && p.payload.synapseOldKind) || '';
    const sConf = parseFloat((p.payload && p.payload.remSynapseConfidence)) || 0;
    const synapseReason = (p.payload && p.payload.remSynapseReason) || T.t('viewer.proposals.rem.synapse.reason.' + op);

    // 置信度档位(复用卡片逻辑)
    let bandKey, bandColor;
    if (sConf >= 0.85) { bandKey = 'veryHigh'; bandColor = '#34d399'; }
    else if (sConf >= 0.7) { bandKey = 'high'; bandColor = '#34d399'; }
    else if (sConf >= 0.5) { bandKey = 'medium'; bandColor = '#fbbf24'; }
    else if (sConf >= 0.3) { bandKey = 'low'; bandColor = '#fbbf24'; }
    else { bandKey = 'veryLow'; bandColor = '#E02424'; }
    const bandLabel = T.t('viewer.proposals.rem.band.' + bandKey);

    // 场景色
    const sceneColor = op === 'add' ? 'var(--accent,#5DECD9)' : (op === 'delete' ? '#E02424' : '#fbbf24');
    const synapseKindLabel = T.enumLabel('synapseKind', synapseKind) || synapseKind;
    const synapseKindColor = CO_ENGRAM.edgeColor(synapseKind);

    // 突触类型显示
    let kindDisplay = '';
    if (op === 'add') {
      kindDisplay = '<span class="chip" style="border-left:3px solid ' + synapseKindColor + '">🔗 ' + CO_ENGRAM.escapeHtml(synapseKindLabel) + '</span>';
    } else if (op === 'retype') {
      const oldKindLabel = T.enumLabel('synapseKind', synapseOldKind) || synapseOldKind;
      kindDisplay = '<span class="chip">' + CO_ENGRAM.escapeHtml(oldKindLabel) + ' → <strong style="color:' + synapseKindColor + '">' + CO_ENGRAM.escapeHtml(synapseKindLabel) + '</strong></span>';
    } else if (op === 'delete') {
      const oldKindLabel = T.enumLabel('synapseKind', synapseOldKind) || synapseOldKind;
      kindDisplay = '<span class="chip">🔗 ' + CO_ENGRAM.escapeHtml(oldKindLabel) + '</span>';
    }

    // 操作按钮
    const isAccepted = p.status === 'accepted';
    const isDismissed = p.status === 'dismissed';
    let actionBtns = '';
    if (isAccepted) {
      actionBtns = '<div class="config-save-bar"><span class="chip" style="color:var(--accent)">✓ ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.applied')) + '</span></div>';
    } else if (isDismissed) {
      actionBtns = '<div class="config-save-bar"><span class="chip" style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.kept')) + '</span></div>';
    } else {
      actionBtns = '<div class="config-save-bar">'
        + '<button class="btn" style="background:' + sceneColor + ';color:#050816;font-weight:600" onclick="CO_ENGRAM_PROPOSALS.acceptRem(\\'' + CO_ENGRAM.escapeHtml(entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.op.' + op)) + '</button>'
        + '<button class="btn secondary" onclick="CO_ENGRAM_PROPOSALS.dismissRem(\\'' + CO_ENGRAM.escapeHtml(entityId) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.dismiss')) + '</button>'
        + '</div>';
    }

    const body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.title')) + ' · ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.op.' + op)) + '</strong>'
      + '<code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(entityId) + '</code>'
      + '</div>'
      + '<div class="field">'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.fromLabel')) + '</label>'
      + '<div style="color:var(--accent);cursor:pointer;text-decoration:underline" onmouseover="this.style.opacity=0.7" onmouseout="this.style.opacity=1" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM.showTab(&quot;engrams&quot;);setTimeout(function(){CO_ENGRAM_ENGRAMS.open(&quot;' + CO_ENGRAM.escapeHtml(fromId) + '&quot;)},50)"><span style="margin-right:.3rem">🔗</span>' + CO_ENGRAM.escapeHtml(fromTitle) + '</div>'
      + '</div>'
      + '<div class="field">'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.toLabel')) + '</label>'
      + '<div style="color:var(--accent);cursor:pointer;text-decoration:underline" onmouseover="this.style.opacity=0.7" onmouseout="this.style.opacity=1" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM.showTab(&quot;engrams&quot;);setTimeout(function(){CO_ENGRAM_ENGRAMS.open(&quot;' + CO_ENGRAM.escapeHtml(toId) + '&quot;)},50)"><span style="margin-right:.3rem">🔗</span>' + CO_ENGRAM.escapeHtml(toTitle) + '</div>'
      + '</div>'
      + '<div class="field">'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.kindLabel')) + '</label>'
      + '<div>' + kindDisplay + '</div>'
      + '</div>'
      + '<div class="field">'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.confLabel')) + '</label>'
      + '<div><span class="chip" style="color:' + bandColor + '">' + CO_ENGRAM.escapeHtml(bandLabel) + '</span> <span style="font-size:0.9rem;opacity:0.8">' + sConf.toFixed(2) + '</span></div>'
      + '</div>'
      + '<div class="field">'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.rem.synapse.detail.reasonLabel')) + '</label>'
      + '<div style="font-size:0.95rem;line-height:1.6">' + CO_ENGRAM.escapeHtml(synapseReason) + '</div>'
      + '</div>'
      + actionBtns;

    CO_ENGRAM.openDrawer(body);
  }
};

// ============================================================
// 修改介绍卡片(REM/Deep/Light 修改项点击 → 说明这次修改 + 链接记忆)
// ============================================================

/**
 * 打开「修改介绍卡片」:maintenance 修改项(rem/light/deep)点击时,
 * 说明这次阶段对这条记忆做了什么修改,并链接到记忆详情。
 * 参考 REM 记忆提案卡片格式:stage 徽章 + 动作徽章 + 修改说明 + 查看记忆链接。
 */
CO_ENGRAM.openModifiedCard = async function(el) {
  const T = CO_ENGRAM_T;
  const stage = el.dataset.stage || '';
  const action = el.dataset.action || '';
  const engramId = el.dataset.engramId || '';
  const before = el.dataset.before || '';
  const delta = el.dataset.delta;
  const to = el.dataset.to || '';

  // 读记忆标题(async,失败回落 id 末 8 位)+ 检查是否存在(被删除的记忆不可跳转)
  let title = engramId.slice(-8);
  let engramExists = false;
  try {
    const eng = await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(engramId), 'GET');
    if (eng && eng.title) { title = eng.title; engramExists = true; }
  } catch { /* engram 已删 */ }

  // 根据 stage/action 生成 stage 徽章、动作徽章、修改说明
  let icon = '🌙', stageBadge = '', actionBadge = '', desc = '';
  if (stage === 'rem') {
    const isRefute = action === 'refuted';
    icon = isRefute ? '⚠️' : '🌙';
    stageBadge = T.t(isRefute ? 'viewer.proposals.rem.scene.refute' : 'viewer.proposals.rem.scene.verify');
    actionBadge = T.enumLabel('verificationStatus', action) || action;
    if (isRefute) {
      desc = T.t('viewer.maintenance.modCard.remRefute');
    } else {
      const beforeZh = T.enumLabel('verificationStatus', before) || before;
      const afterZh = T.enumLabel('verificationStatus', action) || action;
      desc = T.t('viewer.maintenance.modCard.remUpgrade', { before: beforeZh, after: afterZh });
    }
  } else if (stage === 'deep') {
    icon = '🧠';
    stageBadge = 'Deep(记忆整理)';
    actionBadge = T.t('viewer.maintenance.deepAction.' + action) || action;
    if (action === 'forgotten') desc = T.t('viewer.maintenance.modCard.deepForgotten');
    else if (action === 'archived') desc = T.t('viewer.maintenance.modCard.deepArchived');
    else if (action === 'merged') desc = T.t('viewer.maintenance.modCard.deepMerged') + (to ? '(→ ' + CO_ENGRAM.escapeHtml(to.slice(-8)) + ')' : '');
    else desc = action;
  } else if (stage === 'light') {
    icon = '⚡';
    stageBadge = 'Light(信号处理)';
    actionBadge = T.t('viewer.maintenance.lightModifiedLabel');
    desc = T.t('viewer.maintenance.modCard.lightRpe', { delta: delta });
  }

  const html = '<div style="padding:1.1rem">'
    + '<div style="display:flex;align-items:center;gap:.55rem;margin-bottom:.85rem">'
    + '<span style="font-size:1.4rem">' + icon + '</span>'
    + '<strong style="flex:1;line-height:1.4">' + CO_ENGRAM.escapeHtml(title) + '</strong>'
    + '</div>'
    + '<div class="card-meta" style="margin-bottom:.85rem;display:flex;gap:.4rem;flex-wrap:wrap">'
    + '<span class="chip" style="border-color:var(--accent,#5DECD9);color:var(--accent,#5DECD9)">' + CO_ENGRAM.escapeHtml(stageBadge) + '</span>'
    + '<span class="chip">' + CO_ENGRAM.escapeHtml(actionBadge) + '</span>'
    + '</div>'
    + '<div style="color:var(--fg-muted);line-height:1.65;margin-bottom:1.1rem">' + CO_ENGRAM.escapeHtml(desc) + '</div>'
    + (engramExists
      ? '<button class="btn" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM.showTab(\\'engrams\\');setTimeout(function(){CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(engramId) + '\\')},50)">' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.modCard.viewEngram')) + '</button>'
      : '<div style="color:var(--fg-muted);font-style:italic;padding:.5rem 0">⚠️ 该记忆已被删除,无法查看详情</div>')
    + '</div>';
  CO_ENGRAM.openDrawer(html);
};

// ============================================================
// Audit
// ============================================================
CO_ENGRAM.on('audit', async function() {
  const root = document.getElementById('audit-content');
  if (!root) return;
  if (CO_ENGRAM._auditLoaded) return;
  CO_ENGRAM._auditLoaded = true;

  const T = CO_ENGRAM_T;
  const filterBar = '<div class="filter-bar">'
    + '<label>' + T.t('viewer.audit.filter.actor') + ' <select id="audit-actor" onchange="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<option value="">' + T.t('viewer.audit.actorAll') + '</option><option value="user" title="' + T.t('viewer.audit.actorTip.user') + '">' + T.t('viewer.audit.actorUser') + '</option><option value="llm" title="' + T.t('viewer.audit.actorTip.llm') + '">' + T.t('viewer.audit.actorLlm') + '</option><option value="system" title="' + T.t('viewer.audit.actorTip.system') + '">' + T.t('viewer.audit.actorSystem') + '</option></select></label>'
    + '<label>' + T.t('viewer.audit.filter.category') + ' <select id="audit-cat" onchange="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<option value="">' + T.t('viewer.audit.catAll') + '</option>'
    + '<option value="state">' + T.t('viewer.audit.catState') + '</option>'
    + '<option value="effective">' + T.t('viewer.audit.catEffective') + '</option>'
    + '<option value="contradicted">' + T.t('viewer.audit.catContradicted') + '</option>'
    + '<option value="proposal">' + T.t('viewer.audit.catProposal') + '</option></select></label>'
    + '<input type="search" id="audit-engram" placeholder="' + T.t('viewer.audit.filter.engramPlaceholder') + '" oninput="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<span class="chip removable audit-action-chip" id="audit-action-chip" style="display:none" title="' + T.t('viewer.audit.filter.actionChipTitle') + '" onclick="CO_ENGRAM_AUDIT.clearActionFilter()"></span>'
    + '<span class="spacer"></span>'
    + '<span class="chip" id="audit-count">—</span>'
    // timing instrument(2026-07 修复 audit 慢的元思考):显示 filter/render/DOM 三段耗时
    // 让用户能在 chip 旁直接看到瓶颈在哪,无需打开 devtools
    + '<span class="chip" id="audit-timing" style="display:none;font-variant-numeric:tabular-nums;color:var(--fg-muted);font-size:0.75rem"></span>'
    + '</div>'
    + '<div id="audit-stats" class="kpi-grid" style="margin-bottom:1rem"></div>'
    + '<div id="audit-timeline" class="timeline"></div>';
  root.innerHTML = filterBar;
  await CO_ENGRAM_AUDIT.load();
});

window.CO_ENGRAM_AUDIT = {
  async load() {
    const T = CO_ENGRAM_T;
    const tl = document.getElementById('audit-timeline');
    if (!tl) return;
    tl.innerHTML = '<div class="loading">' + T.t('viewer.loading.audit') + '</div>';

    // 初始化 paginator(audit cursor 分页,默认 limit=100)
    if (!CO_ENGRAM._auditPager) {
      CO_ENGRAM._auditPager = CO_ENGRAM.createPaginator({
        endpoint: '/api/audit',
        pageSize: 100,
      });
    }

    let engramsData;
    try {
      // 并行:audit 走 paginator + engram ids 轻量端点(后者判断 engramId 是否仍存在)
      // 2026-07 改用 /api/engrams/ids:仅返回 id 数组(~30KB),替代旧 /api/engrams?limit=500
      // 拉 digest(~100KB) 的浪费,首屏加载提速 50-100ms
      [, engramsData] = await Promise.all([
        CO_ENGRAM._auditPager.load(),
        CO_ENGRAM.apiGet('/api/engrams/ids').catch(() => ({ ids: [] })),
      ]);
    } catch (e) { tl.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>'; return; }

    const lastResp = CO_ENGRAM._auditPager.getLastResponse();
    if (lastResp && lastResp.enabled === false) {
      tl.innerHTML = '<div class="empty"><div class="icon">💤</div>' + T.t('viewer.audit.disabledHint') + '</div>';
      return;
    }
    this._existingIds = new Set(engramsData.ids || []);
    this._cache = CO_ENGRAM._auditPager.getItems().slice();
    this._renderStats();
    this.applyFilter();
  },

  async loadMore() {
    const pager = CO_ENGRAM._auditPager;
    if (!pager || !pager.hasMore()) return;
    try { await pager.loadMore(); }
    catch (e) { alert('加载更多失败:' + (e.message || e)); return; }
    this._cache = pager.getItems().slice();
    this._renderStats();
    this.applyFilter();
  },

  _renderStats() {
    const T = CO_ENGRAM_T;
    const el = document.getElementById('audit-stats');
    if (!el) return;
    const cache = this._cache || [];
    const cat = { state: 0, effective: 0, contradicted: 0, proposal: 0 };
    for (const e of cache) {
      const cls = CO_ENGRAM.auditActionClass(e.action);
      if (cls === 'audit-state') cat.state++;
      else if (cls === 'audit-effective') cat.effective++;
      else if (cls === 'audit-contradicted') cat.contradicted++;
      else cat.proposal++;
    }
    const kpi = (label, n, color) => '<div class="kpi"><div class="kpi-label">' + label + '</div>'
      + '<div class="kpi-value" style="color:' + color + '">' + n + '</div></div>';
    el.innerHTML = kpi(T.t('viewer.audit.kpi.total'), cache.length, 'var(--fg)')
      + kpi(T.t('viewer.audit.kpi.state'), cat.state, '#3b82f6')
      + kpi(T.t('viewer.audit.kpi.effective'), cat.effective, '#10b981')
      + kpi(T.t('viewer.audit.kpi.contradicted'), cat.contradicted, '#ef4444')
      + kpi(T.t('viewer.audit.kpi.proposal'), cat.proposal, '#8b5cf6');
  },

  applyFilter() {
    // timing instrument(2026-07 修复 audit 慢的元思考):
    // 前几次「修了多次仍慢」是因为没做端到端测量,只单点 fast。现在显式测三段:
    //   1. filter(纯 JS 逻辑,小)
    //   2. renderRow × N(字符串拼接 + escapeHtml + renderMeta)
    //   3. innerHTML assignment(浏览器 parse + layout)
    // 结果写到 #audit-timing,用户能在 chip 旁直接看到,无需 devtools
    const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cache = this._cache || [];
    const actor = (document.getElementById('audit-actor') || {}).value || '';
    const cat = (document.getElementById('audit-cat') || {}).value || '';
    const engramQ = ((document.getElementById('audit-engram') || {}).value || '').toLowerCase();
    const actionFilter = this._actionFilter || '';

    const filtered = cache.filter(e => {
      if (actor && e.actor !== actor) return false;
      if (cat && CO_ENGRAM.auditActionClass(e.action) !== 'audit-' + cat) return false;
      if (engramQ && !(e.engramId || '').toLowerCase().includes(engramQ)) return false;
      if (actionFilter && e.action !== actionFilter) return false;
      return true;
    });

    const countEl = document.getElementById('audit-count');
    if (countEl) countEl.textContent = filtered.length + ' / ' + cache.length;

    // 同步 action chip 显示
    const chipEl = document.getElementById('audit-action-chip');
    if (chipEl) {
      if (actionFilter) {
        chipEl.style.display = 'inline-flex';
        chipEl.innerHTML = 'action=<code>' + CO_ENGRAM.escapeHtml(actionFilter) + '</code> ✕';
      } else {
        chipEl.style.display = 'none';
        chipEl.innerHTML = '';
      }
    }

    const tl = document.getElementById('audit-timeline');
    if (!tl) return;
    if (!filtered.length) {
      this._auditPage = 0;
      tl.innerHTML = '<div class="empty"><div class="icon">—</div>' + CO_ENGRAM_T.t('viewer.audit.empty') + '</div>';
      return;
    }

    // 客户端虚拟分页(每页 50,与 engrams tab 一致),替代旧"加载更多"按钮。
    // audit 数据量通常上千条,全量渲染会让 DOM 节点爆炸;分页 + 翻到边界自动扩容
    // 是 engrams tab 已验证过的模式。详见 CO_ENGRAM_ENGRAMS 的 pager 实现。
    const PAGE_SIZE = 50;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    // _auditPage 在首次 load 时是 undefined(对象字面量未初始化),
    // undefined >= N / undefined < 0 都是 false → 不钳制 → undefined * 50 = NaN
    // → filtered.slice(NaN, NaN) = [] → timeline 渲染 0 行(只有 pager-nav)。
    // 这里显式 fallback 到 0,避免 NaN 坑(2026-07 修复 audit tab 不渲染 bug)。
    if (typeof this._auditPage !== 'number' || isNaN(this._auditPage) || this._auditPage < 0) {
      this._auditPage = 0;
    }
    if (this._auditPage >= totalPages) this._auditPage = totalPages - 1;
    const currentPage = this._auditPage;
    const startIdx = currentPage * PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + PAGE_SIZE);

    const tFiltered = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const ACTOR_LETTER = { user: 'U', llm: 'L', system: 'S' };
    // 把 _existingIds 提到外层一次性算好(2026-07 优化):每行 Set.has 是 O(1)。
    const existingIds = this._existingIds || new Set();
    let html = pageItems.map(e => {
      return CO_ENGRAM_AUDIT.renderRow(e, ACTOR_LETTER, existingIds);
    }).join('');
    const tRendered = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // pager nav:« 上一页  1 2 3 … N  下一页 »(数字页码可点击直达,与印迹栏一致)
    // server cursor 还有更多 → next 到边界自动 await loadMore() 扩容
    // gotoPage(target) 跨多页跳转时按需多次 loadMore,直到覆盖 target
    const hasMoreServer = !!(CO_ENGRAM._auditPager && CO_ENGRAM._auditPager.hasMore());
    const atLastClientPage = currentPage >= totalPages - 1;
    const hint = hasMoreServer ? ' ' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.audit.pager.loadingHint')) : '';
    const prevDisabled = currentPage === 0 ? ' disabled' : '';
    const nextDisabled = (atLastClientPage && !hasMoreServer) ? ' disabled' : '';

    // 数字页码:与印迹栏同一套首末+当前页前后 2 页+省略号规则
    const pageList = [];
    if (totalPages <= 9) {
      for (let i = 1; i <= totalPages; i++) pageList.push(i);
    } else {
      pageList.push(1);
      if (currentPage + 1 > 4) pageList.push('ellipsis');
      const start = Math.max(2, currentPage);
      const end = Math.min(totalPages - 1, currentPage + 2);
      for (let i = start; i <= end; i++) pageList.push(i);
      if (currentPage + 1 < totalPages - 3) pageList.push('ellipsis');
      pageList.push(totalPages);
    }
    let pageButtonsHtml = '';
    for (const p of pageList) {
      if (p === 'ellipsis') {
        pageButtonsHtml += '<span class="pager-ellipsis" style="padding:0 .3rem;color:var(--muted,#666)">…</span>';
      } else if (p === currentPage + 1) {
        pageButtonsHtml += '<button class="btn pager-current" disabled style="font-weight:700;cursor:default;min-width:2.2rem">' + p + '</button>';
      } else {
        pageButtonsHtml += '<button class="btn secondary" onclick="CO_ENGRAM_AUDIT.gotoPage(' + (p - 1) + ')" style="min-width:2.2rem">' + p + '</button>';
      }
    }

    html += '<div class="pager-nav" style="text-align:center;padding:1rem 0;display:flex;justify-content:center;align-items:center;gap:0.4rem;flex-wrap:wrap">'
      + '<button class="btn secondary"' + prevDisabled + ' onclick="CO_ENGRAM_AUDIT.prevPage()">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.audit.pager.prev')) + '</button>'
      + pageButtonsHtml
      + '<button class="btn secondary"' + nextDisabled + ' onclick="CO_ENGRAM_AUDIT.nextPage()">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.audit.pager.next')) + '</button>'
      + '<span class="pager-info" style="margin-left:.6rem;color:var(--muted,#666);font-size:0.85em">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.audit.pager.pageInfo', { current: currentPage + 1, total: totalPages, itemTotal: filtered.length })) + hint + '</span>'
      + '</div>';
    tl.innerHTML = html;
    const tEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // timing instrument:默认隐藏,localStorage.auditDebug === '1' 才显示。
    // 用户反馈"filter/render/DOM 意义不明",生产 UI 不该暴露这种内部性能指标。
    const showTiming = (() => { try { return localStorage.getItem('auditDebug') === '1'; } catch { return false; } })();
    const timingEl = document.getElementById('audit-timing');
    if (timingEl) {
      if (showTiming) {
        const filterMs = (tFiltered - tStart).toFixed(1);
        const renderMs = (tRendered - tFiltered).toFixed(1);
        const domMs = (tEnd - tRendered).toFixed(1);
        timingEl.textContent = '⏱ filter ' + filterMs + 'ms · render ' + renderMs + 'ms · DOM ' + domMs + 'ms';
        timingEl.style.display = 'inline-flex';
      } else {
        timingEl.style.display = 'none';
      }
    }
  },

  /** 上一页 */
  prevPage() {
    if (this._auditPage > 0) {
      this._auditPage--;
      this.applyFilter();
    }
  },

  /**
   * 下一页。若已到当前已加载 _cache 的边界,且 server pager 还有更多数据,
   * 自动 await pager.loadMore() 扩容后再翻页。
   */
  async nextPage() {
    const cache = this._cache || [];
    const PAGE_SIZE = 50;
    const totalPages = Math.max(1, Math.ceil(cache.length / PAGE_SIZE));
    const atLastClientPage = this._auditPage >= totalPages - 1;
    if (atLastClientPage) {
      const pager = CO_ENGRAM._auditPager;
      if (pager && pager.hasMore()) {
        try { await pager.loadMore(); }
        catch (e) { alert('加载更多失败:' + (e.message || e)); return; }
        this._cache = pager.getItems().slice();
        this._renderStats();
      } else {
        return;
      }
    }
    this._auditPage++;
    this.applyFilter();
  },

  /**
   * 直达指定页(0-indexed)。若 target 超出当前已加载 _cache 的页范围,
   * 且 server pager 还有更多数据,自动多次 await loadMore() 扩容直到覆盖 target。
   * 与印迹栏 gotoPage 行为对齐。
   */
  async gotoPage(target) {
    if (!Number.isInteger(target) || target < 0) return;
    const pager = CO_ENGRAM._auditPager;
    const PAGE_SIZE = 50;
    // 扩容:直到 _cache 能覆盖 target 页,或 server 数据耗尽
    while (pager && pager.hasMore()) {
      const cache = this._cache || [];
      const totalPages = Math.max(1, Math.ceil(cache.length / PAGE_SIZE));
      if (target < totalPages) break;
      try { await pager.loadMore(); }
      catch (e) { alert('加载更多失败:' + (e.message || e)); return; }
      this._cache = pager.getItems().slice();
      this._renderStats();
    }
    const cache = this._cache || [];
    const totalPages = Math.max(1, Math.ceil(cache.length / PAGE_SIZE));
    this._auditPage = Math.min(target, totalPages - 1);
    this.applyFilter();
  },

  /** action 按钮 label:i18n 翻译,缺翻译时 fallback 到原始 action 字符串 */
  _actionLabel(action) {
    const key = 'viewer.audit.actionLabel.' + action;
    const t = CO_ENGRAM_T.t(key);
    return t === key ? action : t;
  },

  /** 点击 action 标签 → 按该 action 精确过滤;再次点同一个 → 清除 */
  filterByAction(action) {
    if (!action) return;
    this._actionFilter = this._actionFilter === action ? '' : action;
    this.applyFilter();
  },

  /** 清除 action 过滤(点击 chip 触发) */
  clearActionFilter() {
    this._actionFilter = '';
    this.applyFilter();
  },

  /** 把任意 metadata value 渲染为可读的短字符串(单值,用于 chip / kv) */
  _formatVal(v) {
    if (v == null) return 'null';
    if (typeof v === 'string') {
      const s = v.length > 60 ? v.slice(0, 57) + '…' : v;
      return '"' + s + '"';
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const sample = v.slice(0, 3).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ');
      return '[' + sample + (v.length > 3 ? ', …×' + (v.length - 3) : '') + ']';
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  },

  /** 结构化渲染 audit metadata */
  renderMeta(e) {
    const T = CO_ENGRAM_T;
    const m = e.metadata || {};
    const keys = Object.keys(m);
    if (keys.length === 0) return '<span class="audit-meta-empty">' + T.t('viewer.audit.metaEmpty') + '</span>';

    // 1. update 类:有 changes 字段 → 渲染 changed fields
    if (m.changes && typeof m.changes === 'object' && !Array.isArray(m.changes)) {
      const fields = Object.keys(m.changes);
      if (fields.length === 0) {
        return '<span class="audit-meta-empty">' + T.t('viewer.audit.noFieldChanges') + '</span>';
      }
      const rows = fields.map(f => {
        const ch = m.changes[f] || {};
        const from = CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._formatVal(ch.from));
        const to = CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._formatVal(ch.to));
        return '<div class="audit-change-row">'
          + '<span class="audit-field">' + CO_ENGRAM.escapeHtml(f) + '</span>'
          + '<span class="audit-from">' + from + '</span>'
          + '<span class="audit-arrow">→</span>'
          + '<span class="audit-to">' + to + '</span>'
          + '</div>';
      }).join('');
      // 如果还有其他 metadata(updatedBy 等),追加显示
      const extra = keys.filter(k => k !== 'changes').map(k =>
        '<span class="audit-kv"><b>' + CO_ENGRAM.escapeHtml(k) + '</b>='
        + CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._formatVal(m[k])) + '</span>'
      ).join(' ');
      return '<div class="audit-changes">' + rows + '</div>' + (extra ? '<div class="audit-meta-extra">' + extra + '</div>' : '');
    }

    // 2. synapse 类(target=synapse):渲染 synapse 关键字段
    if (m.target === 'synapse') {
      const chips = ['<span class="chip synapse-chip">' + T.t('viewer.audit.synapseChip') + '</span>'];
      if (m.kind) chips.push('<span class="chip kind-' + CO_ENGRAM.escapeHtml(m.kind) + '">' + CO_ENGRAM.escapeHtml(m.kind) + '</span>');
      if (m.direction) chips.push('<span class="chip">' + CO_ENGRAM.escapeHtml(m.direction) + '</span>');
      if (typeof m.weight === 'number') chips.push('<span class="chip">w=' + m.weight.toFixed(2) + '</span>');
      if (m.to) chips.push('<span class="chip">→ ' + CO_ENGRAM.escapeHtml(m.to.length > 18 ? m.to.slice(0, 16) + '…' : m.to) + '</span>');
      // 其它字段
      const extras = keys.filter(k => !['target', 'kind', 'direction', 'weight', 'to', 'from', 'synapseId', 'createdBy'].includes(k))
        .map(k => '<span class="audit-kv"><b>' + CO_ENGRAM.escapeHtml(k) + '</b>=' + CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._formatVal(m[k])) + '</span>').join(' ');
      return '<div class="audit-chips">' + chips.join(' ') + (extras ? ' <span class="audit-meta-extra">' + extras + '</span>' : '') + '</div>';
    }

    // 3. 通用 fallback:键值对
    const kvs = keys.map(k =>
      '<span class="audit-kv"><b>' + CO_ENGRAM.escapeHtml(k) + '</b>='
      + CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._formatVal(m[k])) + '</span>'
    ).join(' ');
    return '<div class="audit-chips">' + kvs + '</div>';
  },

  /** 渲染单条 audit row,判断 engram/synapse 是否仍存在,生成可点按钮或灰色文本 */
  renderRow(e, ACTOR_LETTER, existingIds) {
    const T = CO_ENGRAM_T;
    const ts = CO_ENGRAM.relativeTime(e.ts);
    const tsFull = CO_ENGRAM.escapeHtml(e.ts);
    const cls = CO_ENGRAM.auditActionClass(e.action);
    const actorLetter = ACTOR_LETTER[e.actor] || '?';
    const actorTipKey = 'viewer.audit.actorTip.' + (e.actor || '');
    const actorTip = T.t(actorTipKey) === actorTipKey ? (e.actor || '') : T.t(actorTipKey);
    const actionTipKey = 'viewer.audit.actionTip.' + (e.action || '');
    const actionTip = T.t(actionTipKey) === actionTipKey ? (e.action || '') : T.t(actionTipKey);

    // 2026-07 优化:existingIds 由 applyFilter 顶层传入(避免每行 new Set)
    const existing = existingIds || new Set();
    const m = e.metadata || {};
    const isSynapse = m.target === 'synapse' || !!m.synapseId;
    // synapse 类:目标 from engram(用 metadata.from 优先,fallback 到 engramId)
    // engram 类:目标 = engramId
    const targetId = isSynapse ? (m.from || e.engramId) : e.engramId;
    const targetExists = !!targetId && existing.has(targetId);

    let targetCell;
    if (!targetId) {
      targetCell = '<span class="audit-target-none">—</span>';
    } else if (targetExists) {
      const short = targetId.length > 22 ? targetId.slice(0, 20) + '…' : targetId;
      const label = isSynapse ? T.t('viewer.audit.targetOpenSourceEngram') : T.t('viewer.audit.targetOpenEngram');
      targetCell = '<button class="btn-link audit-target-exists" title="' + CO_ENGRAM.escapeHtml(targetId) + '" '
        + 'onclick="CO_ENGRAM.showTab(\\'engrams\\');setTimeout(()=>CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(targetId) + '\\'),50)">'
        + label + ' <code>' + CO_ENGRAM.escapeHtml(short) + '</code></button>';
    } else {
      // 目标已不存在(被 purge / delete)→ 灰色删除线
      const short = targetId.length > 22 ? targetId.slice(0, 20) + '…' : targetId;
      targetCell = '<span class="audit-target-gone" title="' + T.t('viewer.audit.targetGone', { id: targetId }) + '">'
        + (isSynapse ? '🌐 ' : '📄 ') + '<code><s>' + CO_ENGRAM.escapeHtml(short) + '</s></code> <em>' + T.t('viewer.audit.targetDeleted') + '</em></span>';
    }

    const metaHtml = this.renderMeta(e);

    const isActive = this._actionFilter === e.action;
    const actionBtnClass = 'action ' + cls + ' action-button' + (isActive ? ' active' : '');

    return '<div class="timeline-row audit-row">'
      + '<span class="ts" title="' + tsFull + '">' + ts + '</span>'
      + '<span class="actor-icon ' + e.actor + '" title="' + CO_ENGRAM.escapeHtml(actorTip) + '">' + actorLetter + '</span>'
      + '<button type="button" class="' + actionBtnClass + '" title="' + CO_ENGRAM.escapeHtml(actionTip) + T.t('viewer.audit.filterActionHint') + '" onclick="CO_ENGRAM_AUDIT.filterByAction(\\'' + CO_ENGRAM.escapeHtml(e.action) + '\\')">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_AUDIT._actionLabel(e.action)) + '</button>'
      + targetCell
      + '<div class="metadata audit-meta-cell">' + metaHtml + '</div>'
      + '</div>';
  }
};

// ============================================================
// Merges (P4.3) — git merge driver health dashboard
// ============================================================
CO_ENGRAM.on('merges', async function() {
  const root = document.getElementById('merges-content');
  if (!root) return;
  if (CO_ENGRAM._mergesLoaded) return;
  CO_ENGRAM._mergesLoaded = true;
  await CO_ENGRAM_MERGES.render(root);
});

window.CO_ENGRAM_MERGES = {
  async render(root) {
    const T = CO_ENGRAM_T;
    root.innerHTML = '<div class="loading">' + T.t('viewer.merges.loading') + '</div>';
    let payload;
    try {
      payload = await CO_ENGRAM.apiGet('/api/merge-stats?windowDays=7');
    } catch (e) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>';
      return;
    }
    if (!payload.enabled || !payload.stats) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.merges.auditDisabledHint') + '</div>';
      return;
    }

    // 异常告警横幅(spec §13.2)— 失败不阻塞主统计渲染
    let banner = '';
    try {
      const anom = await CO_ENGRAM.apiGet('/api/merge-anomalies?windowDays=7');
      if (anom.enabled && anom.anomalies && anom.anomalies.length > 0) {
        const items = anom.anomalies.map(function(a) {
          const cls = a.severity === 'critical' ? 'anom-critical' : (a.severity === 'warning' ? 'anom-warning' : 'anom-info');
          const icon = a.severity === 'critical' ? '✗' : (a.severity === 'warning' ? '⚠' : 'ℹ');
          return '<li class="' + cls + '"><span class="anom-icon">' + icon + '</span><strong>' + CO_ENGRAM.escapeHtml(a.kind) + '</strong>: ' + CO_ENGRAM.escapeHtml(a.message) + '</li>';
        }).join('');
        banner = '<div class="anomaly-banner"><h3>' + T.t('viewer.merges.anomalyBanner', { n: anom.anomalies.length }) + '</h3><ul>' + items + '</ul></div>';
      }
    } catch (_) { /* anomaly API 可选,失败静默 */ }

    root.innerHTML = banner + CO_ENGRAM_MERGES.renderHtml(payload.stats, payload.windowDays);
  },

  renderHtml(s, windowDays) {
    const T = CO_ENGRAM_T;
    const pct = (r) => (r * 100).toFixed(1) + '%';

    const kpi = (label, value, sub) =>
      '<div class="kpi">' +
      '<div class="kpi-label">' + CO_ENGRAM.escapeHtml(label) + '</div>' +
      '<div class="kpi-value">' + CO_ENGRAM.escapeHtml(String(value)) + '</div>' +
      (sub ? '<div class="kpi-sub">' + CO_ENGRAM.escapeHtml(sub) + '</div>' : '') +
      '</div>';

    const bar = (label, count, max, color) =>
      '<div class="bar-row">' +
      '<div class="bar-label">' + CO_ENGRAM.escapeHtml(label) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (max ? (count / max * 100).toFixed(1) : 0) + '%;background:' + (color || '#0F766E') + '"></div></div>' +
      '<div class="bar-value">' + count + '</div>' +
      '</div>';

    let html = '<div class="panel">';
    html += '<div class="panel-header"><h2>' + T.t('viewer.merges.title', { days: windowDays }) + '</h2></div>';
    html += '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:1.5rem">';
    html += kpi(T.t('viewer.merges.kpi.totalMerges'), s.totalMerges);
    html += kpi(T.t('viewer.merges.kpi.autoResolved'), s.autoResolved, pct(s.autoResolveRate));
    html += kpi(T.t('viewer.merges.kpi.escalatedToMarkers'), s.escalatedToMarkers);
    html += kpi(T.t('viewer.merges.kpi.backupFailures'), s.backupFailures);
    html += '</div>';

    // LLM 段
    html += '<h3 style="margin-top:1.5rem">' + T.t('viewer.merges.llmSection') + '</h3>';
    html += '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:1rem">';
    html += kpi(T.t('viewer.merges.llm.totalInvocations'), s.llm.totalInvocations);
    html += kpi(T.t('viewer.merges.llm.arbitrated'), s.llm.arbitrated);
    html += kpi(T.t('viewer.merges.llm.escalated'), s.llm.escalated);
    html += kpi(T.t('viewer.merges.llm.failed'), s.llm.failed);
    html += kpi(T.t('viewer.merges.llm.successRate'), pct(s.llm.successRate));
    html += '</div>';

    // 按策略
    const strategies = Object.entries(s.byStrategy || {}).sort((a, b) => b[1] - a[1]);
    if (strategies.length > 0) {
      const max = strategies[0][1];
      html += '<h3 style="margin-top:1.5rem">' + T.t('viewer.merges.byStrategy') + '</h3>';
      html += '<div style="margin-bottom:1rem">';
      for (const [name, count] of strategies.slice(0, 8)) {
        html += bar(name, count, max, '#0F766E');
      }
      html += '</div>';
    }

    // Hot paths
    const paths = Object.entries(s.byPath || {}).sort((a, b) => b[1] - a[1]);
    if (paths.length > 0) {
      const max = paths[0][1];
      html += '<h3 style="margin-top:1.5rem">' + T.t('viewer.merges.hotPaths') + '</h3>';
      html += '<div style="margin-bottom:1rem">';
      for (const [p, count] of paths.slice(0, 8)) {
        html += bar(p, count, max, '#fbbf24');
      }
      html += '</div>';
    }

    // 按天趋势
    const days = Object.entries(s.byDay || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length > 0) {
      const max = Math.max(...days.map((d) => d[1]));
      html += '<h3 style="margin-top:1.5rem">' + T.t('viewer.merges.byDay') + '</h3>';
      html += '<div style="margin-bottom:1rem">';
      for (const [day, count] of days) {
        html += bar(day, count, max, '#60a5fa');
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }
};

// ============================================================
// Trash
// ============================================================
CO_ENGRAM.on('trash', async function() {
  const root = document.getElementById('trash-content');
  if (!root) return;
  if (CO_ENGRAM._trashLoaded) return;
  CO_ENGRAM._trashLoaded = true;
  await CO_ENGRAM_TRASH.render(root);
});

window.CO_ENGRAM_TRASH = {
  _cache: [],
  _cursor: null,
  _hasMore: false,
  _total: 0,

  async render(root) {
    const T = CO_ENGRAM_T;
    this._cache = [];
    this._cursor = null;
    this._hasMore = false;
    this._total = 0;
    root.innerHTML = '<div class="loading">' + T.t('viewer.loading.trash') + '</div>';
    let first;
    try {
      first = await CO_ENGRAM.apiGet('/api/trash?limit=50');
    } catch (e) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>';
      return;
    }
    this._cache = first.results || [];
    this._cursor = first.nextCursor;
    this._hasMore = !!first.nextCursor;
    this._total = first.total || this._cache.length;
    this._renderList(root);
  },

  _renderList(root) {
    const T = CO_ENGRAM_T;
    const items = this._cache;
    if (!items.length) {
      root.innerHTML = '<div class="empty"><div class="icon">🗑️</div>' + T.t('viewer.trash.empty') + '</div>';
      return;
    }

    // 分区显示标签 + tooltip(2026-07 修复用户反馈):
    //   forgotten/frozen(旧值 archived)走 enumLabel 中文化 + tip 翻译
    //   YYYY-MM 物理清空分区用 "分区(物理清空)" 后缀 + tip 解释
    //   原先直接显示英文 enum 值,中文用户看不懂。
    const formatPartitionLabel = (p) => {
      if (!p) return '—';
      // 软删分区:forgotten / frozen / archived(旧值兼容)
      if (p === 'forgotten' || p === 'frozen' || p === 'archived') {
        return T.enumLabel('status', p);
      }
      // 物理清空分区:YYYY-MM 格式
      if (/^\d{4}-\d{2}$/.test(p)) {
        return p + ' ' + T.t('viewer.trash.partitionSweptSuffix');
      }
      return p;
    };
    const formatPartitionTip = (p, source) => {
      if (source === 'soft' || p === 'forgotten' || p === 'frozen' || p === 'archived') {
        return T.t('viewer.trash.partitionTipSoft');
      }
      return T.t('viewer.trash.partitionTipSwept');
    };

    // 顶部工具栏:统计 + 分区筛选 + 一键清空
    const partitions = [...new Set(items.map((t) => t.partition).filter(Boolean))].sort();
    let html = '<div class="card" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:1rem">'
      + '<strong style="margin-right:auto">' + T.t('viewer.trash.titleCount', { n: this._total }) + '</strong>';
    if (partitions.length > 1) {
      html += '<label style="font-weight:normal;font-size:0.9rem">' + T.t('viewer.trash.partitionLabel')
        + '<select id="trash-partition-filter" onchange="CO_ENGRAM_TRASH.applyFilter()" style="margin-left:0.4rem">'
        + '<option value="">' + T.t('viewer.trash.all') + '</option>'
        + partitions.map((p) => '<option value="' + CO_ENGRAM.escapeHtml(p) + '">' + CO_ENGRAM.escapeHtml(formatPartitionLabel(p)) + '</option>').join('')
        + '</select></label>';
    }
    html += '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.purgeAll(false)">' + T.t('viewer.trash.purgeAllBtn') + '</button>'
      + '</div>';

    html += '<table class="data-table" id="trash-table"><thead><tr>'
      + '<th>' + T.t('viewer.trash.colId') + '</th>'
      + '<th>' + T.t('viewer.trash.colTitle') + '</th>'
      + '<th>' + T.t('viewer.trash.colPartition') + '</th>'
      + '<th>' + T.t('viewer.trash.colTrashedAt') + '</th><th></th>'
      + '</tr></thead><tbody>';
    for (const t of items) {
      const part = t.partition || '';
      const sourceBadge = t.source === 'soft'
        ? '<span class="chip" style="background:rgba(251,191,36,0.12);color:#fbbf24;border-color:rgba(251,191,36,0.25)">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.sourceSoft')) + '</span> '
        : '<span class="chip" style="background:rgba(94,234,212,0.12);color:#0F766E;border-color:rgba(94,234,212,0.25)">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.sourceSwept')) + '</span> ';
      const titleCell = t.title
        ? CO_ENGRAM.escapeHtml(t.title).slice(0, 60) + (t.title.length > 60 ? '…' : '')
        : '<span style="color:var(--fg-dim)">—</span>';
      const trashedAt = t.trashedAt
        ? new Date(t.trashedAt).toLocaleString()
        : '—';
      const partTip = formatPartitionTip(part, t.source);
      const partTipAttr = ' title="' + CO_ENGRAM.escapeHtml(partTip).replaceAll('"', '&quot;') + '"';
      html += '<tr data-partition="' + CO_ENGRAM.escapeHtml(part) + '">'
        + '<td><code>' + CO_ENGRAM.escapeHtml(t.id) + '</code></td>'
        + '<td>' + sourceBadge + titleCell + '</td>'
        + '<td' + partTipAttr + '>' + CO_ENGRAM.escapeHtml(formatPartitionLabel(part)) + '</td>'
        + '<td style="font-size:0.8rem;color:var(--fg-muted)">' + CO_ENGRAM.escapeHtml(trashedAt) + '</td>'
        + '<td>'
        + '<button class="btn-link" onclick="CO_ENGRAM_TRASH.preview(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">' + T.t('viewer.trash.previewBtn') + '</button> '
        + '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.restore(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">' + T.t('viewer.trash.restoreBtn') + '</button>'
        + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    if (this._hasMore) {
      html += '<div style="margin-top:1rem;text-align:center">'
        + '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.loadMore()">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.loadMore', { loaded: items.length, total: this._total })) + '</button>'
        + '</div>';
    } else if (items.length > 50) {
      html += '<div style="margin-top:0.75rem;text-align:center;color:var(--fg-muted);font-size:0.85rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.allLoaded', { n: items.length })) + '</div>';
    }
    root.innerHTML = html;
  },

  async loadMore() {
    if (!this._cursor) return;
    const T = CO_ENGRAM_T;
    let next;
    try {
      next = await CO_ENGRAM.apiGet('/api/trash?limit=50&cursor=' + encodeURIComponent(this._cursor));
    } catch (e) {
      alert(T.t('viewer.common.loadFailed', { err: e.message || String(e) }));
      return;
    }
    this._cache = this._cache.concat(next.results || []);
    this._cursor = next.nextCursor;
    this._hasMore = !!next.nextCursor;
    this._renderList(document.getElementById('trash-content'));
  },

  // 分区筛选:隐藏不匹配的行
  applyFilter() {
    const sel = document.getElementById('trash-partition-filter');
    const v = sel ? sel.value : '';
    document.querySelectorAll('#trash-table tbody tr').forEach((tr) => {
      const p = tr.getAttribute('data-partition') || '';
      tr.style.display = (!v || p === v) ? '' : 'none';
    });
  },

  // 预览单条回收站内容(只读 drawer,双源兼容)
  async preview(id) {
    const T = CO_ENGRAM_T;
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/trash/' + encodeURIComponent(id)); }
    catch (e) { alert(T.t('viewer.common.loadFailed', { err: e.message || String(e) })); return; }

    const fm = d.frontmatter || {};
    const kind = fm.kind ? T.enumLabel('kind', fm.kind) : '';
    const status = fm.status ? T.enumLabel('status', fm.status) : '';
    const source = fm.sourceType ? T.enumLabel('sourceType', fm.sourceType) : '';
    const sourceBadge = d.source === 'soft'
      ? '<span class="chip" style="background:rgba(251,191,36,0.12);color:#fbbf24;border-color:rgba(251,191,36,0.25)" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.partitionTipSoft')).replaceAll('"', '&quot;') + '">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.sourceSoft')) + '</span> '
      : (d.source === 'swept'
        ? '<span class="chip" style="background:rgba(94,234,212,0.12);color:#0F766E;border-color:rgba(94,234,212,0.25)" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.partitionTipSwept')).replaceAll('"', '&quot;') + '">' + CO_ENGRAM.escapeHtml(T.t('viewer.trash.sourceSwept')) + '</span> '
        : '');

    // 分区显示:软删走 enumLabel,物理清空加 (swept) 后缀
    const formatPartLabel = (p) => {
      if (!p) return '—';
      if (p === 'forgotten' || p === 'frozen' || p === 'archived') return T.enumLabel('status', p);
      if (/^\d{4}-\d{2}$/.test(p)) return p + ' ' + T.t('viewer.trash.partitionSweptSuffix');
      return p;
    };
    const partLabel = formatPartLabel(d.partition);
    const partTipText = (d.source === 'soft' || d.partition === 'forgotten' || d.partition === 'frozen' || d.partition === 'archived')
      ? T.t('viewer.trash.partitionTipSoft')
      : T.t('viewer.trash.partitionTipSwept');
    const partTipAttr = ' title="' + CO_ENGRAM.escapeHtml(partTipText).replaceAll('"', '&quot;') + '"';

    const body = '<div class="warn-banner" style="padding:0.6rem 0.8rem;margin-bottom:0.8rem">'
      + sourceBadge
      + '<strong>' + T.t('viewer.trash.previewTitle') + '</strong> · ' + T.t('viewer.trash.previewHint')
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(fm.title || id) + '</h2>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.trash.colId') + ':</span><code>' + CO_ENGRAM.escapeHtml(id) + '</code></div>'
      + '<div class="field">'
      + (kind ? '<span class="chip kind-' + fm.kind + '"' + CO_ENGRAM.tip('kind.' + fm.kind) + '>' + kind + '</span> ' : '')
      + (status ? '<span class="field-label"' + CO_ENGRAM.tip('status.' + fm.status) + '>' + T.fieldLabel('status') + ':</span>' + CO_ENGRAM.escapeHtml(status) : '')
      + '</div>'
      + (fm.domainTags && fm.domainTags.length
        ? '<div class="field"><span class="field-label">' + T.fieldLabel('domainTags') + ':</span>' + fm.domainTags.map((t) => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ') + '</div>'
        : '')
      + '<div class="field"><span class="field-label"' + partTipAttr + '>' + T.t('viewer.trash.partitionField') + '</span>' + CO_ENGRAM.escapeHtml(partLabel)
      + ' <span class="field-label"' + CO_ENGRAM.tip('lastEffectiveAt') + '>' + T.t('viewer.trash.trashedAtField') + '</span>' + CO_ENGRAM.escapeHtml(d.trashedAt || '—') + '</div>'
      + (source ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('sourceType.' + fm.sourceType) + '>' + T.fieldLabel('sourceType') + ':</span>' + CO_ENGRAM.escapeHtml(source) + '</div>' : '')
      + (fm.createdBy ? '<div class="field"><span class="field-label">' + T.t('viewer.trash.creatorField') + '</span>' + CO_ENGRAM.escapeHtml(fm.createdBy) + '</div>' : '')
      + '<h3>' + T.t('viewer.trash.contentSection') + '</h3><div class="markdown-body">' + CO_ENGRAM.renderMarkdown(d.content || '') + '</div>'
      + '<div style="margin-top:1rem;display:flex;gap:0.5rem">'
      + '<button class="btn" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM_TRASH.restore(\\'' + CO_ENGRAM.escapeHtml(id) + '\\')">' + T.t('viewer.trash.restoreToMainBtn') + '</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM.closeDrawer()">' + T.t('viewer.trash.closeBtn') + '</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  async restore(id) {
    const T = CO_ENGRAM_T;
    if (!confirm(T.t('viewer.trash.restoreConfirm', { id }))) return;
    try {
      await CO_ENGRAM.apiJson('/api/trash/' + encodeURIComponent(id) + '/restore', 'POST', {});
      CO_ENGRAM._trashLoaded = false;
      await this.render(document.getElementById('trash-content'));
    } catch (e) { alert(T.t('viewer.trash.restoreFailed', { err: e.message || String(e) })); }
  },

  // 永久清空:byPartition=true 只清当前筛选分区,false=清全部
  async purgeAll(byPartition) {
    const T = CO_ENGRAM_T;
    const filterSel = document.getElementById('trash-partition-filter');
    const part = byPartition && filterSel ? filterSel.value : '';
    const scope = part ? T.t('viewer.trash.purgeAllScopePartition', { p: part }) : T.t('viewer.trash.purgeAllScopeAll');
    // 先 dryRun 看看会删多少条
    // 注意:dryRun 走 GET /api/trash(GF 方式无副作用),返回 { total, results, nextCursor }
    // 旧实现读 preview.count,但 GET 响应没有 count 字段 → 永远 0 → 提前 return "已空",
    // 让"永久清空全部"按钮看起来无效(2026-07 用户多次反馈)。现按 total / results.length 兜底。
    let preview;
    try {
      const url = '/api/trash?limit=500' + (part ? '&partition=' + encodeURIComponent(part) : '');
      preview = await CO_ENGRAM.apiGet(url);
    } catch (e) { alert(T.t('viewer.trash.prescanFailed', { err: e.message || String(e) })); return; }

    const n = preview.total ?? (preview.results && preview.results.length) ?? preview.count ?? 0;
    if (n === 0) { alert(T.t('viewer.trash.purgeEmpty')); return; }
    if (!confirm(T.t('viewer.trash.purgeConfirm1', { scope, n }))) return;
    if (!confirm(T.t('viewer.trash.purgeConfirm2', { scope, n }))) return;

    try {
      const url = '/api/trash' + (part ? '?partition=' + encodeURIComponent(part) : '');
      const r = await CO_ENGRAM.apiJson(url, 'DELETE', {});
      alert(T.t('viewer.trash.purgeDone', { n: r.count || 0 }));
      CO_ENGRAM._trashLoaded = false;
      await this.render(document.getElementById('trash-content'));
    } catch (e) { alert(T.t('viewer.trash.purgeFailed', { err: e.message || String(e) })); }
  }
};

// ============================================================
// Health — 仓库健康可视化(ROI #1)
// 与 'co-engram status' CLI 共用 core computeStatus 真相源。
// ============================================================
CO_ENGRAM.on('health', async function() {
  const root = document.getElementById('health-content');
  if (!root) return;
  const T = CO_ENGRAM_T;
  root.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loading')) + '</div>';
  let snap;
  try { snap = await CO_ENGRAM.apiGet('/api/status'); }
  catch (e) { root.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>'; return; }

  if (!snap.dataRoot) {
    root.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.empty')) + '</div>';
    return;
  }

  const badgeClass = { ok: 'health-ok', warn: 'health-warn', error: 'health-error', info: 'health-info' };
  const badgeLabel = (s) => T.t('viewer.health.badge.' + s);
  const badgeHtml = (s) => '<span class="health-badge ' + (badgeClass[s] || 'health-info') + '">' + CO_ENGRAM.escapeHtml(badgeLabel(s)) + '</span>';

  let html = '<div class="card">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem">'
    + '<div><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.title')) + '</h3>'
    + '<div class="muted" style="margin-top:.25rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.subtitle')) + '</div></div>'
    + '<div style="display:flex;align-items:center;gap:.75rem">'
    + badgeHtml(snap.overall)
    + '<button class="btn" onclick="CO_ENGRAM._healthRefresh()">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.refresh')) + '</button>'
    + '</div></div>'
    + '<dl class="meta-grid" style="margin-top:1rem">'
    + '<dt>' + CO_ENGRAM.escapeHtml(T.t('viewer.health.dataRoot')) + '</dt><dd><code>' + CO_ENGRAM.escapeHtml(snap.dataRoot) + '</code></dd>'
    + '<dt>' + CO_ENGRAM.escapeHtml(T.t('viewer.health.generatedAt')) + '</dt><dd>' + CO_ENGRAM.escapeHtml(snap.generatedAt) + '</dd>'
    + '</dl>';

  // 统计快览(2026-07 加 title 悬停说明:用户反馈"3 个数字意义不明 + 总数与统计栏对不上")
  if (snap.stats) {
    const healthKpi = (label, value, tipKey) => '<div class="kpi" title="' + CO_ENGRAM.escapeHtml(T.t(tipKey)).replaceAll('"', '&quot;') + '">'
      + '<div class="kpi-label">' + CO_ENGRAM.escapeHtml(label) + '</div>'
      + '<div class="kpi-value">' + (value ?? 0) + '</div></div>';
    html += '<div class="kpi-grid" style="margin-top:1rem">'
      + healthKpi(T.t('viewer.health.stats.total'), snap.stats.total, 'viewer.health.stats.totalTip')
      + healthKpi(T.t('viewer.health.stats.frozen'), snap.stats.archived, 'viewer.health.stats.frozenTip')
      + healthKpi(T.t('viewer.health.stats.forgotten'), snap.stats.forgotten, 'viewer.health.stats.forgottenTip')
      + '</div>';
  }
  html += '</div>';

  // 检查项列表 — warn/error 渲染为可展开 details(默认折叠)
  html += '<div class="card" style="margin-top:1rem"><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.checks')) + '</h3>';
  if (!snap.checks || !snap.checks.length) {
    html += '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.empty')) + '</div>';
  } else {
    html += '<ul class="health-check-list">';
    for (const c of snap.checks) {
      const isProblem = (c.status === 'warn' || c.status === 'error');
      const hasStructured = isProblem && (c.whyI18nKey || c.fix);
      if (hasStructured) {
        // warn/error + 有结构化指引 → 可展开卡片
        const whyText = c.whyI18nKey ? T.t(c.whyI18nKey) : '';
        const whyBlock = whyText
          ? '<div class="health-why-block"><div class="health-why-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.why')) + '</div><div class="health-why-text">' + CO_ENGRAM.escapeHtml(whyText) + '</div></div>'
          : '';
        let fixBlock = '';
        if (c.fix) {
          const desc = T.t(c.fix.descriptionI18nKey);
          // tool === 'commit' 时渲染「立即提交」按钮(POST /api/commit),其余 tool 走原"或调用工具"行
          const isCommitAction = c.fix.tool === 'commit';
          const primaryBtn = isCommitAction
            ? '<div class="health-fix-action-row"><button class="btn" onclick="CO_ENGRAM._healthCommitNow(this)">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.commitNow')) + '</button></div>'
            : '';
          const cmdRow = c.fix.command
            ? '<div class="health-fix-cmd-row"><code class="health-fix-cmd">' + CO_ENGRAM.escapeHtml(c.fix.command) + '</code>'
              + '<button class="btn-mini" onclick="CO_ENGRAM._copyHealthCmd(this, ' + JSON.stringify(c.fix.command) + ')">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.copyCommand')) + '</button></div>'
            : '';
          const toolLine = c.fix.tool && !isCommitAction
            ? '<div class="health-fix-tool">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.orCallTool')) + ': <code>' + CO_ENGRAM.escapeHtml(c.fix.tool) + (c.fix.argsHint ? ' ' + CO_ENGRAM.escapeHtml(c.fix.argsHint) : '') + '</code></div>'
            : '';
          fixBlock = '<div class="health-fix-block"><div class="health-fix-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.howToFix')) + '</div><div class="health-fix-desc">' + CO_ENGRAM.escapeHtml(desc) + '</div>' + primaryBtn + cmdRow + toolLine + '</div>';
        }
        const detailBlock = c.detail ? '<pre class="health-check-detail">' + CO_ENGRAM.escapeHtml(c.detail) + '</pre>' : '';
        html += '<li class="health-check-item health-check-problem">'
          + '<details class="health-check-details">'
          + '<summary>'
          + badgeHtml(c.status)
          + '<div class="health-check-body">'
          + '<div class="health-check-label">' + CO_ENGRAM.escapeHtml(c.label) + '</div>'
          + '<div class="health-check-message">' + CO_ENGRAM.escapeHtml(c.message) + '</div>'
          + '</div>'
          + '<span class="health-check-expand-hint">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.check.expand')) + '</span>'
          + '</summary>'
          + '<div class="health-check-expand-body">'
          + whyBlock
          + fixBlock
          + detailBlock
          + '</div>'
          + '</details>'
          + '</li>';
      } else {
        // ok/info 或无结构化指引 → 原样扁平渲染
        html += '<li class="health-check-item">'
          + badgeHtml(c.status)
          + '<div class="health-check-body">'
          + '<div class="health-check-label">' + CO_ENGRAM.escapeHtml(c.label) + '</div>'
          + '<div class="health-check-message">' + CO_ENGRAM.escapeHtml(c.message) + '</div>'
          + (c.detail ? '<pre class="health-check-detail">' + CO_ENGRAM.escapeHtml(c.detail) + '</pre>' : '')
          + '</div></li>';
      }
    }
    html += '</ul>';
  }
  html += '</div>';

  // doctor 联动卡片(深度排查,默认不调 API,用户点按钮才加载)
  html += '<div class="card health-doctor-card">'
    + '<div class="health-doctor-head">'
    + '<div><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.title')) + '</h3>'
    + '<div class="muted" style="margin-top:.25rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.subtitle')) + '</div></div>'
    + '<button class="btn" onclick="CO_ENGRAM._healthDoctorScan()">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.runScan')) + '</button>'
    + '</div>'
    + '<div id="health-doctor-body"><div class="muted" style="margin-top:.75rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.noPending')) + '</div></div>'
    + '</div>';

  root.innerHTML = html;
});

CO_ENGRAM._copyHealthCmd = async function(btn, cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
  } catch (e) {
    // fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = cmd;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
  const orig = btn.textContent;
  btn.textContent = CO_ENGRAM_T.t('viewer.health.check.commandCopied');
  setTimeout(function() { btn.textContent = orig; }, 1500);
};

CO_ENGRAM._healthCommitNow = async function(btn) {
  const T = CO_ENGRAM_T;
  const defaultMsg = T.t('viewer.health.check.commitDefaultMessage');
  const message = window.prompt(T.t('viewer.health.check.commitMessagePrompt'), defaultMsg);
  if (message === null) return; // 用户取消
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const resp = await CO_ENGRAM.apiJson('/api/commit', 'POST', { message });
    if (!resp.ok) {
      window.alert(T.t('viewer.health.check.commitFailed', { error: resp.error || 'unknown' }));
      return;
    }
    if (resp.nothingToCommit) {
      window.alert(T.t('viewer.health.check.commitNothing'));
    } else {
      const c = resp.commit || {};
      window.alert(T.t('viewer.health.check.commitSuccess', {
        files: String(c.filesChanged ?? 0),
        branch: c.branch || '',
        hash: (c.hash || '').slice(0, 7),
      }));
    }
    // 刷新 Health tab 让 warn 消失
    await CO_ENGRAM._healthRefresh();
  } catch (e) {
    window.alert(T.t('viewer.health.check.commitFailed', { error: e.message || String(e) }));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
};

CO_ENGRAM._healthDoctorScan = async function() {
  const body = document.getElementById('health-doctor-body');
  if (!body) return;
  const T = CO_ENGRAM_T;
  body.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.loading')) + '</div>';
  let report;
  try { report = await CO_ENGRAM.apiGet('/api/doctor?incremental=false'); }
  catch (e) { body.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>'; return; }

  const pending = (report.issues || []).filter(function(i) { return !i.autoFixed; });
  const autoFixed = (report.issues || []).filter(function(i) { return i.autoFixed; });

  let html = '<div class="health-doctor-kpis">'
    + '<div class="health-doctor-kpi"><strong>' + (report.autoFixesApplied ?? 0) + '</strong>' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.autoFixed')) + '</div>'
    + '<div class="health-doctor-kpi"><strong>' + (report.pendingManualReview ?? 0) + '</strong>' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.pendingReview')) + '</div>'
    + '</div>';

  if (!pending.length) {
    html += '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.empty')) + '</div>';
  } else {
    for (const issue of pending) {
      const na = issue.nextAction;
      const naHtml = na
        ? '<div class="health-doctor-nextaction">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.nextAction')) + ': <code>' + CO_ENGRAM.escapeHtml(na.tool) + (na.argsHint ? ' ' + CO_ENGRAM.escapeHtml(na.argsHint) : '') + '</code>'
          + (na.explanation ? '<br><span style="opacity:.8">' + CO_ENGRAM.escapeHtml(na.explanation) + '</span>' : '')
          + '</div>'
        : '';
      html += '<div class="health-doctor-issue">'
        + '<div class="health-doctor-issue-kind">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.doctor.fixKind.' + issue.kind) !== ('viewer.health.doctor.fixKind.' + issue.kind) ? T.t('viewer.health.doctor.fixKind.' + issue.kind) : issue.kind) + (issue.path ? ' · ' + CO_ENGRAM.escapeHtml(issue.path) : '') + '</div>'
        + '<div class="health-doctor-issue-msg">' + CO_ENGRAM.escapeHtml(issue.message) + '</div>'
        + naHtml
        + '</div>';
    }
  }
  body.innerHTML = html;
};

CO_ENGRAM._healthRefresh = async function() {
  const root = document.getElementById('health-content');
  if (root) root.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(CO_ENGRAM_T.t('viewer.common.loading')) + '</div>';
  // 强制重新渲染:触发 health 事件
  CO_ENGRAM.showTab('health');
};

// ============================================================
// Config
// ============================================================
CO_ENGRAM.on('config', async function() {
  const root = document.getElementById('config-content');
  if (!root) return;
  if (CO_ENGRAM._configLoaded) return;
  CO_ENGRAM._configLoaded = true;
  await CO_ENGRAM_CONFIG.render(root);
});

window.CO_ENGRAM_CONFIG = {
  async render(root) {
    const T = CO_ENGRAM_T;
    root.innerHTML = '<div class="loading">' + T.t('viewer.loading.config') + '</div>';
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/config'); }
    catch (e) { root.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>'; return; }

    CO_ENGRAM._configData = data;
    const persisted = data.persisted || {};
    const runtime = data.runtime || {};
    // hostType 决定重启相关的提示文字与按钮可见性
    //   'mcp-server' → 由 Claude Code 父进程管理,支持优雅重启
    //   'openclaw-plugin' → 是 OpenClaw gateway 的一部分,不支持自动重启
    const hostType = data.hostType || 'mcp-server';
    const isPlugin = hostType === 'openclaw-plugin';
    const HOST_LABEL = isPlugin ? T.t('host.label.openclaw') : T.t('host.label.mcp');
    const HOST_PARENT = isPlugin ? T.t('host.process.openclaw') : T.t('host.process.mcp');

    const LANG_LABEL = { zh: T.t('viewer.common.langZh'), en: T.t('viewer.common.langEn') };
    const langOptions = Object.keys(LANG_LABEL).map(k => '<option value="' + k + '"' + (persisted.language === k ? ' selected' : '') + '>' + LANG_LABEL[k] + '</option>').join('');
    const profileOptions = ['minimal', 'standard', 'full'].map(p => '<option value="' + p + '"' + (persisted.toolsProfile === p ? ' selected' : '') + '>' + p + '</option>').join('');

    let html = '';

    // 运行时提示:在每个持久化配置项下方显示当前运行时实际值
    const runtimeHint = (runtimeVal) => {
      return '<span style="font-size:.75rem;color:var(--text-muted);margin-left:.4rem">' + T.t('viewer.config.runtimeHintPrefix') + CO_ENGRAM.escapeHtml(String(runtimeVal)) + T.t('viewer.config.runtimeHintSuffix') + '</span>';
    };

    // 持久化配置:可编辑,保存后重启生效.
    // 当保存值与运行时值不一致时,在节标题下方显示一条提示横幅。
    const langChanged = (LANG_LABEL[persisted.language] || persisted.language || '') !== (LANG_LABEL[runtime.language] || runtime.language || '');
    const profileChanged = (persisted.toolsProfile || '') !== (runtime.profile || '');
    const createdByChanged = (persisted.defaultCreatedBy || '') !== (runtime.defaultCreatedBy || '');
    const hasPendingRestart = langChanged || profileChanged || createdByChanged;

    html += '<div class="config-section">';
    html += '<h3>' + T.t('viewer.config.sectionPersisted') + '</h3>';
    if (hasPendingRestart) {
      const pendingItems = [];
      if (langChanged) pendingItems.push(T.t('viewer.config.pendingField.language'));
      if (profileChanged) pendingItems.push(T.t('viewer.config.pendingField.toolsProfile'));
      if (createdByChanged) pendingItems.push(T.t('viewer.config.pendingField.defaultCreatedBy'));
      html += '<div class="pending-banner">'
        + '<span class="pending-banner-icon">&#8635;</span> '
        + T.t('viewer.config.pendingBanner', { fields: pendingItems.join('、'), host: HOST_LABEL })
        + '</div>';
    }
    html += '<div class="config-row"><div class="config-label">' + T.t('viewer.config.field.language') + '<span class="desc">' + T.t('viewer.config.field.language.desc') + runtimeHint(LANG_LABEL[runtime.language] || runtime.language || '—') + '</span></div>'
      + '<div class="config-control"><select id="cf-language">' + langOptions + '</select></div></div>';
    html += '<div class="config-row"><div class="config-label">' + T.t('viewer.config.field.defaultCreatedBy') + '<span class="desc">' + T.t('viewer.config.field.defaultCreatedBy.desc') + runtimeHint(runtime.defaultCreatedBy || T.t('viewer.config.runtimeNotSet')) + '</span></div>'
      + '<div class="config-control"><input id="cf-default-created-by" type="text" value="' + CO_ENGRAM.escapeHtml(persisted.defaultCreatedBy || '') + '" placeholder="' + T.t('viewer.config.field.defaultCreatedBy.placeholder') + '"></div></div>';
    html += '<div class="config-row"><div class="config-label">' + T.t('viewer.config.field.toolsProfile') + '<span class="desc">' + T.t('viewer.config.field.toolsProfile.desc') + runtimeHint(runtime.profile || 'standard') + '</span></div>'
      + '<div class="config-control"><select id="cf-tools-profile">' + profileOptions + '</select></div></div>';
    html += '</div>';

    // 运行时状态:可编辑(下次启动生效),viewer 自身只读避免 UI 自杀
    const toggle = (id, label, desc, currentOn, desiredOn, editable) => {
      const effective = (desiredOn !== undefined ? desiredOn : currentOn);
      const onClass = effective ? 'on' : 'off';
      const control = editable
        ? '<label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (effective ? ' checked' : '') + '><span class="toggle-slider"></span></label>'
          + '<span class="toggle-state ' + onClass + '">' + (effective ? T.t('viewer.common.enabled') : T.t('viewer.common.disabled')) + '</span>'
        : '<input type="text" value="' + (currentOn ? T.t('viewer.common.enabledState') : T.t('viewer.common.disabledState')) + '" readonly>';
      const badge = (desiredOn !== undefined && desiredOn !== currentOn)
        ? '<span class="chip restart-pending">' + T.t('viewer.common.restartToApply') + '</span>'
        : '';
      return '<div class="config-row"><div class="config-label">' + label + (desc ? '<span class="desc">' + desc + '</span>' : '') + badge + '</div>'
        + '<div class="config-control" style="display:flex;align-items:center;gap:.6rem">' + control + '</div></div>';
    };

    html += '<div class="config-section">';
    html += '<h3>' + T.t('viewer.config.sectionRuntime') + '</h3>';
    html += '<div class="info-banner" style="margin-bottom:.8rem">' + T.t('viewer.config.runtimeSection.hint', { host: HOST_LABEL }) + (isPlugin ? T.t('viewer.config.runtimeSection.openclawExtra') : T.t('viewer.config.runtimeSection.mcpExtra')) + '</div>';
    html += toggle('cf-audit', T.t('viewer.config.runtime.audit'), T.t('viewer.config.runtime.audit.desc'), runtime.auditEnabled, persisted.audit?.enabled, true);
    html += toggle('cf-proposals', T.t('viewer.config.runtime.proposals'), T.t('viewer.config.runtime.proposals.desc'), runtime.proposalEnabled, persisted.proposals?.enabled, true);
    html += toggle('cf-maintenance', T.t('viewer.config.runtime.maintenance'), T.t('viewer.config.runtime.maintenance.desc'), runtime.maintenanceEnabled, persisted.maintenance?.enabled, true);
    html += toggle(null, T.t('viewer.config.runtime.search'), T.t('viewer.config.runtime.search.desc'), runtime.searchEnabled, undefined, false);
    html += toggle(null, T.t('viewer.config.runtime.viewer'), T.t('viewer.config.runtime.viewer.desc'), runtime.viewerEnabled, undefined, false);
    html += '</div>';

    // 元数据:dataRoot 可编辑(写 ~/.co-engram/config.json bootstrap)
    html += '<div class="config-section">';
    html += '<h3>' + T.t('viewer.config.sectionMetadata') + '</h3>';
    const currentDataRoot = data.dataRoot || T.t('viewer.common.unknown');
    // 首次用户(dataRoot=null)展示欢迎引导卡片,推荐常用路径 + 解释 .co-engram/ 子目录
    // 已设置过 dataRoot 的用户跳过引导,只看下面的输入框
    if (!data.dataRoot) {
      html += '<div class="info-banner" style="margin:0 0 .8rem 0;padding:1rem;border-left:3px solid var(--accent,#4a90e2)">'
        + '<h4 style="margin:0 0 .5rem 0">' + T.t('viewer.config.dataRootWelcomeTitle') + '</h4>'
        + '<div style="font-size:.92em">' + T.t('viewer.config.dataRootWelcomeBody') + '</div>'
        + '<div style="margin-top:.6rem;display:flex;flex-direction:column;gap:.4rem">'
        + '<button class="btn" onclick="CO_ENGRAM_CONFIG.suggestDataRoot(1)">' + T.t('viewer.config.dataRootWelcomeSuggestHome') + '</button>'
        + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.suggestDataRoot(2)">' + T.t('viewer.config.dataRootWelcomeSuggestHidden') + '</button>'
        + '</div>'
        + '<div style="margin-top:.6rem;font-size:.85em;color:var(--muted,#666)">' + T.t('viewer.config.dataRootWelcomeCustom') + '</div>'
        + '</div>';
    }
    html += '<div class="config-row"><div class="config-label">' + T.t('viewer.config.field.dataRoot') + '<span class="desc">' + T.t('viewer.config.field.dataRoot.desc') + '</span></div>'
      + '<div class="config-control" style="display:flex;gap:.4rem;align-items:center">'
      + '<input id="cf-dataRoot-input" type="text" value="' + CO_ENGRAM.escapeHtml(currentDataRoot) + '" style="flex:1" placeholder="/home/USER/team-memory">'
      + '<button class="btn" onclick="CO_ENGRAM_CONFIG.saveDataRoot()">' + T.t('viewer.config.dataRootSave') + '</button>'
      + '</div></div>';
    html += '<div id="cf-dataRoot-banner" class="info-banner" style="margin:0 0 .8rem 0">' + T.t('viewer.config.dataRootEditableHint') + '</div>';
    html += '<div class="config-row readonly"><div class="config-label">' + T.t('viewer.config.field.configVersion') + '</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(String(persisted.version || 1)) + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">' + T.t('viewer.config.field.createdAt') + '</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(persisted.createdAt || '—') + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">' + T.t('viewer.config.field.updatedAt') + '</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(persisted.updatedAt || persisted.createdAt || '—') + '" readonly></div></div>';
    html += '</div>';

    html += '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.reload()">' + T.t('viewer.config.saveBar.reset') + '</button>'
      + '<button class="btn" onclick="CO_ENGRAM_CONFIG.save()">' + T.t('viewer.config.saveBar.save') + '</button>'
      + '</div>';

    root.innerHTML = html;
  },

  async reload() {
    CO_ENGRAM._configLoaded = false;
    const root = document.getElementById('config-content');
    if (root) await this.render(root);
  },

  /**
   * 保存 dataRoot(写 ~/.co-engram/config.json bootstrap)
   *
   * 行为:
   *   - 第一次点击 force=false,后端拒绝 non-engram 时返回现有文件清单
   *   - UI 弹"接管此目录"二次确认 banner(展示现有文件,co-engram 不会触碰它们)
   *   - 用户确认 → 带 force=true 重发请求
   *   - 成功后显示"重启生效"banner(hostType 区分 Claude Code / OpenClaw)
   */
  async saveDataRoot(force) {
    const T = CO_ENGRAM_T;
    const input = document.getElementById('cf-dataRoot-input');
    if (!input) return;
    const newValue = input.value.trim();
    if (!newValue) {
      this._showDataRootBanner(T.t('viewer.config.dataRootUpdateFailed', { error: T.t('viewer.config.dataRootRejectEmpty') }), 'warn');
      return;
    }
    const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
    const isPlugin = hostType === 'openclaw-plugin';
    const HOST_LABEL = isPlugin ? T.t('host.label.openclaw') : T.t('host.label.mcp');
    try {
      const resp = await CO_ENGRAM.apiJson('/api/config', 'PUT', { dataRoot: newValue, force: force === true });
      if (resp && resp.ok) {
        const restartHint = isPlugin
          ? T.t('viewer.config.dataRootUpdatedRestartRequired', { host: HOST_LABEL })
          : T.t('viewer.config.dataRootUpdatedRestartRequired', { host: HOST_LABEL });
        this._showDataRootBanner(restartHint, 'pending-restart');
        return;
      }
      // non-engram 失败:改弹二次确认 banner(展示现有文件,提供"接管此目录"按钮)
      // co-engram 接管只创建 .co-engram/ 子目录,不会触碰这些文件 → 二次确认后安全 force=true
      if (resp && resp.reason === 'non-engram') {
        const escapedPath = CO_ENGRAM.escapeHtml(newValue);
        const list = Array.isArray(resp.existingFiles) ? resp.existingFiles : [];
        const total = typeof resp.existingCount === 'number' ? resp.existingCount : list.length;
        const shown = list.slice(0, 10).map(f => '<code>' + CO_ENGRAM.escapeHtml(f) + '</code>').join('、');
        const more = total > list.length
          ? '<div style="margin-top:.4rem;font-size:.85em;color:var(--muted,#666)">' + T.t('viewer.config.dataRootNonEngramMore', { count: total - list.length }) + '</div>'
          : '';
        const fileList = shown
          ? '<div style="margin:.4rem 0">' + T.t('viewer.config.dataRootNonEngramExistingList', { count: total, files: shown }) + more + '</div>'
          : '';
        const body = '<strong>' + T.t('viewer.config.dataRootNonEngramConfirmTitle') + '</strong>'
          + '<div style="margin-top:.4rem">' + T.t('viewer.config.dataRootNonEngramConfirmBody', { path: newValue }) + '</div>'
          + fileList
          + '<div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap">'
          + '<button class="btn" onclick="CO_ENGRAM_CONFIG.saveDataRoot(true)">'
          + T.t('viewer.config.dataRootTakeOver') + '</button>'
          + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.cancelTakeOver()">'
          + T.t('viewer.config.saveBar.reset') + '</button>'
          + '</div>';
        this._showDataRootBanner(body, 'warn');
        return;
      }
      this._showDataRootBanner(
        T.t('viewer.config.dataRootUpdateFailed', { error: (resp && resp.error) || 'unknown' }),
        'warn',
      );
    } catch (e) {
      this._showDataRootBanner(
        T.t('viewer.config.dataRootUpdateFailed', { error: e.message || String(e) }),
        'warn',
      );
    }
  },

  cancelTakeOver() {
    const T = CO_ENGRAM_T;
    this._showDataRootBanner(T.t('viewer.config.dataRootCancelled'), 'success');
  },

  /**
   * 点击推荐路径按钮(home/hidden)时填入 input 并自动触发保存。
   * 路径来自后端 GET /api/config 的 suggestedPaths(后端有 process.env.HOME)。
   * 首次用户最自然的动作就是"点一下推荐路径 → 完成"。
   *
   * kind 用数字(1=home, 2=hidden)而非字符串字面量,避免 template literal
   * 把 onclick="...(\'home\')" 解析后变成裸 'home' 破坏 JS 字符串。
   */
  suggestDataRoot(kind) {
    const input = document.getElementById('cf-dataRoot-input');
    if (!input) return;
    const suggest = (CO_ENGRAM._configData && CO_ENGRAM._configData.suggestedPaths) || {};
    const path = kind === 2 ? suggest.hidden : suggest.home;
    if (!path) return;
    input.value = path;
    return this.saveDataRoot();
  },

  _showDataRootBanner(message, kind) {
    const banner = document.getElementById('cf-dataRoot-banner');
    if (!banner) return;
    const cls = kind === 'pending-restart'
      ? 'pending-banner restart-banner'
      : kind === 'warn'
        ? 'warn-banner'
        : 'success-banner';
    banner.className = cls;
    banner.style.margin = '0 0 .8rem 0';
    banner.innerHTML = message;
  },

  async save() {
    const T = CO_ENGRAM_T;
    const auditEl = document.getElementById('cf-audit');
    const proposalsEl = document.getElementById('cf-proposals');
    const maintenanceEl = document.getElementById('cf-maintenance');
    const auditOn = auditEl ? !!auditEl.checked : undefined;
    const proposalsOn = proposalsEl ? !!proposalsEl.checked : undefined;
    const maintenanceOn = maintenanceEl ? !!maintenanceEl.checked : undefined;
    const body = {
      language: document.getElementById('cf-language').value,
      defaultCreatedBy: document.getElementById('cf-default-created-by').value,
      toolsProfile: document.getElementById('cf-tools-profile').value,
      // 嵌套结构:与 config.json schema 一致
      ...(auditOn !== undefined ? { audit: { enabled: auditOn } } : {}),
      ...(proposalsOn !== undefined ? { proposals: { enabled: proposalsOn } } : {}),
      ...(maintenanceOn !== undefined ? { maintenance: { enabled: maintenanceOn } } : {}),
    };
    // 检测哪些字段需要重启生效,用于在 banner 里给用户更准确的提示。
    const before = CO_ENGRAM._configData?.persisted || {};
    const restartFields = [
      { section: 'audit', key: 'viewer.config.pendingField.audit' },
      { section: 'proposals', key: 'viewer.config.pendingField.proposals' },
      { section: 'maintenance', key: 'viewer.config.pendingField.maintenance' }
    ];
    const changed = restartFields.filter(f => {
      const oldVal = before[f.section]?.enabled;
      const newVal = body[f.section]?.enabled;
      return oldVal !== newVal && !(oldVal == null && newVal == null);
    });
    try {
      await CO_ENGRAM.apiJson('/api/config', 'PUT', body);
      const needsRestart = changed.length > 0;
      let banner;
      if (needsRestart) {
        const changedLabels = changed.map(c => T.t(c.key));
        const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
        const isPlugin = hostType === 'openclaw-plugin';
        const HOST_LABEL = isPlugin ? T.t('host.label.openclaw') : T.t('host.label.mcp');
        const HOST_PARENT = isPlugin ? T.t('host.process.openclaw') : T.t('host.process.mcp');
        const restartSupported = !isPlugin;
        const restartBtn = restartSupported
          ? '<button class="btn restart-now-btn" '
            + 'title="' + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartBtnTip', { host: HOST_LABEL, parent: HOST_PARENT })) + '" '
            + 'onclick="CO_ENGRAM_CONFIG.restartNow()">' + T.t('viewer.config.restartBtn') + '</button>'
          : '<span class="restart-unavailable-hint">' + T.t('viewer.config.restartOpenclawHint') + '</span>';
        banner = '<div class="pending-banner restart-banner" style="display:flex;flex-wrap:wrap;gap:.6rem;align-items:center">'
          + '<span>' + T.t('viewer.config.saveSuccessWithRestart', { host: HOST_LABEL }) + ' <strong>' + CO_ENGRAM.escapeHtml(changedLabels.join('、')) + '</strong></span>'
          + restartBtn
          + '</div>';
      } else {
        banner = '<div class="success-banner">' + T.t('viewer.config.saveSuccess') + '</div>';
      }
      const root = document.getElementById('config-content');
      if (root) root.insertAdjacentHTML('afterbegin', banner);
      // 重新加载持久化部分
      setTimeout(() => { CO_ENGRAM._configLoaded = false; this.render(document.getElementById('config-content')); }, 2000);
    } catch (e) { alert(T.t('viewer.common.saveFailed', { err: e.message || String(e) })); }
  },

  /**
   * Trigger graceful exit; parent process will auto-restart.
   *
   * Only available in mcp-server mode. In openclaw-plugin mode, /api/restart
   * returns 409 and we prompt the user to manually run 'openclaw gateway restart'.
   *
   * Flow:
   *   1. POST /api/restart - server process.exit(0) after 300ms
   *   2. Show "restarting" overlay
   *   3. Poll /api/stats every 500ms; 2 consecutive successes = recovered
   *   4. Reload page to re-render UI
   *
   * Fallback: if not recovered within 30s, prompt user to refresh manually.
   */
  async restartNow() {
    const T = CO_ENGRAM_T;
    const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
    const isPlugin = hostType === 'openclaw-plugin';
    const HOST_LABEL = isPlugin ? T.t('host.label.openclaw') : T.t('host.label.mcp');
    const HOST_PARENT = isPlugin ? T.t('host.process.openclaw') : T.t('host.process.mcp');
    if (!confirm(T.t('viewer.config.restartConfirmTitle', { host: HOST_LABEL }) + '\\n\\n' + T.t('viewer.config.restartConfirmBody'))) return;
    // openclaw-plugin 模式:服务端会拒绝,直接提示用户手动重启 gateway
    if (isPlugin) {
      alert(T.t('viewer.config.restartOpenclawHint'));
      return;
    }
    // 显示重启遮罩
    let mask = document.getElementById('restart-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'restart-mask';
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,31,0.85);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;color:var(--fg);font-size:1rem;flex-direction:column;gap:1rem';
      mask.innerHTML = '<div style="font-size:1.5rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartMask.title', { host: HOST_LABEL })) + '</div>'
        + '<div style="color:var(--fg-muted);font-size:.85rem;max-width:480px;text-align:center">'
        + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartMask.body', { parent: HOST_PARENT })) + '</div>'
        + '<div class="spinner" style="width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></div>';
      document.body.appendChild(mask);
    }
    try {
      await CO_ENGRAM.apiJson('/api/restart', 'POST');
    } catch {
      // 预期内:服务退出会导致 fetch 失败,继续 poll
    }
    // Poll until service comes back
    const start = Date.now();
    const deadline = start + 30000;
    let successCount = 0;
    const poll = async () => {
      if (Date.now() > deadline) {
        mask.innerHTML = '<div style="font-size:1.2rem;color:var(--accent-warm)">' + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartTimeout.title')) + '</div>'
          + '<div style="color:var(--fg-muted);font-size:.85rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartTimeout.body', { host: HOST_LABEL, parent: HOST_PARENT })) + '</div>'
          + '<button class="btn" onclick="location.reload()" style="margin-top:.5rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.config.restartTimeout.refreshBtn')) + '</button>';
        return;
      }
      try {
        await CO_ENGRAM.apiGet('/api/stats');
        successCount++;
        if (successCount >= 2) {
          location.reload();
          return;
        }
      } catch {
        successCount = 0;
      }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 800);
  }
};

// ============================================================
// Synapses(被 graph tab 调用,也可独立打开)
// ============================================================
window.CO_ENGRAM_SYNAPSES = {
  async open(id) {
    const T = CO_ENGRAM_T;
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/synapses/' + encodeURIComponent(id)); }
    catch (e) { CO_ENGRAM.openDrawer('<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>'); return; }
    CO_ENGRAM._currentSynapse = d;
    this._renderView(d);
  },

  _renderView(d) {
    const T = CO_ENGRAM_T;
    const synapseId = CO_ENGRAM.escapeHtml(d.id); // 重命名避免与其他函数中的id冲突
    const kindLabel = T.enumLabel('synapseKind', d.kind) || d.kind;
    const family = CO_ENGRAM.synapseFamily(d.kind);
    const familyLabel = T.enumLabel('family', family) || family;
    const dirLabel = d.direction ? (T.enumLabel('synapseDirection', d.direction) || T.t('viewer.synapses.directionDefault')) : T.t('viewer.synapses.directionDefault');
    const evidence = (d.evidence || []);
    const evidenceHtml = evidence.length
      ? '<h3>' + T.t('viewer.detail.evidenceCount', { n: evidence.length }) + '</h3>' + evidence.map(ev => '<div class="field markdown-body" style="padding-left:.5rem;border-left:2px solid var(--border);margin-bottom:.4rem">'
        + CO_ENGRAM.renderMarkdown(ev.description || '')
        + (ev.source ? ' <span class="chip">' + CO_ENGRAM.escapeHtml(ev.source) + '</span>' : '')
        + (ev.confidence != null ? ' <span class="kpi-sub">' + T.t('viewer.detail.confidenceEvidence', { n: Number(ev.confidence).toFixed(2) }) + '</span>' : '')
        + (ev.addedBy ? ' <span class="kpi-sub">· ' + CO_ENGRAM.escapeHtml(ev.addedBy) + '</span>' : '')
        + '</div>').join('')
      : '<div class="empty">' + T.t('viewer.detail.noEvidence') + '</div>';

    const body = '<div class="edit-banner" style="display:flex;gap:.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + T.t('viewer.detail.synapseDetailTitle') + '</strong>'
      + '<button class="btn" onclick="CO_ENGRAM_SYNAPSES.edit()">' + T.t('viewer.common.edit') + '</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM_SYNAPSES.confirmDelete()">' + T.t('viewer.common.delete') + '</button>'
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(kindLabel) + '</h2>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + T.t('viewer.synapses.kindField') + '</span>' + CO_ENGRAM.escapeHtml(kindLabel) + ' (' + CO_ENGRAM.escapeHtml(d.kind) + ')</div>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('family.' + family) + '>' + T.t('viewer.detail.familyField') + '</span><span class="chip dot" style="color:' + CO_ENGRAM.familyColor(family) + '">' + CO_ENGRAM.escapeHtml(familyLabel) + '</span></div>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>' + T.t('viewer.detail.directionField') + '</span>' + CO_ENGRAM.escapeHtml(dirLabel) + '</div>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.detail.weightField') + '</span>' + (d.weight != null ? Number(d.weight).toFixed(2) : '—') + '</div>'
      + (d.resolutionStatus ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('resolution.' + d.resolutionStatus) + '>' + T.t('viewer.detail.resolutionField') + '</span><span class="chip" style="background:rgba(239,68,68,.12);color:#ef4444">' + CO_ENGRAM.escapeHtml(T.enumLabel('resolution', d.resolutionStatus) || d.resolutionStatus) + '</span></div>' : '')
      + '<div class="field"><span class="field-label">' + T.t('viewer.synapses.idField') + '</span><code>' + synapseId + '</code></div>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.detail.sourceToTargetField') + '</span><span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.from) + '">' + CO_ENGRAM.escapeHtml(d.from) + '</span> ' + (d.direction === 'bidirectional' ? '↔' : '→') + ' <span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.to) + '">' + CO_ENGRAM.escapeHtml(d.to) + '</span></div>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.synapses.creatorField') + '</span>' + CO_ENGRAM.escapeHtml(d.createdBy || '')
      + ' <span class="field-label">' + T.t('viewer.synapses.timeField') + '</span>' + CO_ENGRAM.escapeHtml(d.createdAt || '') + '</div>'
      + evidenceHtml;
    CO_ENGRAM.openDrawer(body);
  },

  edit() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentSynapse;
    if (!d) return;
    // 12 种 kind,按族分组,与 stats/graph tab 一致
    const KINDS_BY_FAMILY = [
      { family: 'structural', kinds: ['extends', 'part_of', 'similar_to'] },
      { family: 'causal', kinds: ['depends_on', 'causes', 'follows'] },
      { family: 'evidential', kinds: ['derives_from', 'contradicts', 'exemplifies'] },
      { family: 'temporal', kinds: ['supersedes', 'consolidates'] },
      { family: 'modulatory', kinds: ['contextualizes'] }
    ];
    const kindOptions = KINDS_BY_FAMILY.map(group =>
      '<optgroup label="' + (T.enumLabel('family', group.family) || group.family) + '">' + group.kinds.map(k =>
        '<option value="' + k + '"' + (d.kind === k ? ' selected' : '') + CO_ENGRAM.tip('synapse.' + k) + '>' + (T.enumLabel('synapseKind', k) || k) + ' · ' + k + '</option>'
      ).join('') + '</optgroup>'
    ).join('');
    const body = '<div class="edit-banner"><strong>' + T.t('viewer.common.editMode') + '</strong> · ' + T.t('viewer.detail.editModeHint') + '</div>'
      + '<h2>' + T.t('viewer.detail.editSynapseTitle') + '</h2>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.synapses.idField') + '</span><code>' + CO_ENGRAM.escapeHtml(d.id) + '</code></div>'
      + '<div class="warn-banner">' + T.t('viewer.synapses.kindChangeHint') + '</div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + T.t('viewer.detail.kindLabel') + '</label><select id="sf-kind"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label">' + T.t('viewer.detail.weightLabel') + '</label><input id="sf-weight-range" type="range" min="0" max="1" step="0.01" value="' + (d.weight || 0) + '" oninput="document.getElementById(\\'sf-weight\\').value=this.value"><input id="sf-weight" type="number" min="0" max="1" step="0.01" value="' + (d.weight || 0) + '" oninput="document.getElementById(\\'sf-weight-range\\').value=this.value" style="width:80px;margin-left:.5rem"></div>'
      + '<div class="field"><label class="field-label">' + T.t('viewer.detail.evidenceDescLabel') + '</label><input id="sf-evidence-desc" type="text" placeholder="' + T.t('viewer.detail.evidenceDescPlaceholder') + '"></div>'
      + '<div class="field"><label class="field-label">' + T.t('viewer.detail.evidenceSourceLabel') + '</label><input id="sf-evidence-source" type="text" placeholder="' + T.t('viewer.detail.evidenceSourcePlaceholder') + '"></div>'
      + '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_SYNAPSES.cancel()">' + T.t('viewer.common.cancel') + '</button>'
      + '<button class="btn" onclick="CO_ENGRAM_SYNAPSES.save()">' + T.t('viewer.common.save') + '</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  cancel() {
    const d = CO_ENGRAM._currentSynapse;
    if (d) this._renderView(d);
  },

  async save() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentSynapse;
    if (!d) return;
    const nextKind = document.getElementById('sf-kind').value;
    const patch = {
      weight: Number(document.getElementById('sf-weight').value)
    };
    // 仅当 kind 变化时传 kind(避免无谓的删除+重建;direction 已移除,对称性派生自 kind)
    if (nextKind !== d.kind) patch.kind = nextKind;
    const desc = (document.getElementById('sf-evidence-desc').value || '').trim();
    if (desc) {
      const source = (document.getElementById('sf-evidence-source').value || '').trim();
      patch.evidence = [{ description: desc, ...(source ? { source } : {}), addedBy: 'viewer' }];
    }
    try {
      const updated = await CO_ENGRAM.apiJson('/api/synapses/' + encodeURIComponent(d.id), 'PATCH', patch);
      CO_ENGRAM._currentSynapse = updated;
      this._renderView(updated);
      // kind 变化 → 图谱中的边 id 已变,需要重载
      if (patch.kind && CO_ENGRAM._graphState) {
        CO_ENGRAM._graphState.initialized = false;
        CO_ENGRAM._graphState = null;
      }
    } catch (e) { alert(T.t('viewer.common.saveFailed', { err: e.message || String(e) })); }
  },

  async confirmDelete() {
    const T = CO_ENGRAM_T;
    const d = CO_ENGRAM._currentSynapse;
    if (!d) return;
    if (!confirm(T.t('viewer.synapses.deleteConfirm'))) return;
    try {
      await CO_ENGRAM.apiJson('/api/synapses/' + encodeURIComponent(d.id), 'DELETE', null);
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._currentSynapse = null;
      // 重新加载图谱(如果当前在图谱 tab)
      if (CO_ENGRAM._graphState) {
        CO_ENGRAM._graphState.initialized = false;
        CO_ENGRAM._graphState = null;
        const gc = document.getElementById('graph-canvas');
        if (gc) gc.innerHTML = '<div class="loading">' + T.t('viewer.synapses.reloadingGraph') + '</div>';
        CO_ENGRAM.onTabEnter('graph');
      }
    } catch (e) { alert(T.t('viewer.common.deleteFailed', { err: e.message || String(e) })); }
  }
};

// ============================================================
// Help — 帮助文档(概念入门 + 各 tab 速查)
// ============================================================
// ============================================================
// 夜思实验室(spec §四/§六):条目卡/立即夜思(异步任务+轮询)/梦境时间线
// ============================================================
CO_ENGRAM.on('incubations', async function() {
  const root = document.getElementById('incubations-content');
  if (!root) return;
  await CO_ENGRAM_INCUBATIONS.render(root);
});

window.CO_ENGRAM_INCUBATIONS = {
  _polling: {},

  async render(root) {
    const T = CO_ENGRAM_T;
    let payload;
    try {
      payload = await CO_ENGRAM.apiGet('/api/incubations');
    } catch (e) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.incubations.loadFailed', { err: e.message }) + '</div>';
      return;
    }
    if (!payload.enabled) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.incubations.unavailable') + '</div>';
      return;
    }
    let html = '<div class="panel" style="max-width:980px;margin:0 auto;padding:1.2rem 1.5rem">';
    html += '<h2 style="margin-top:0">' + T.t('viewer.incubations.title') + '</h2>';
    html += '<p style="color:var(--fg-muted)">' + T.t('viewer.incubations.intro') + '</p>';
    html += '<div style="border:1px dashed var(--border);border-radius:.5rem;padding:.8rem;margin-bottom:1rem;font-size:.85rem">' + T.t('viewer.incubations.l2BudgetNotice') + '</div>';

    // 播种表单
    html += '<h3>' + T.t('viewer.incubations.createTitle') + '</h3>'
      + '<div style="display:flex;flex-direction:column;gap:.5rem;max-width:640px;margin-bottom:1.5rem">'
      + '<textarea id="inc-q" rows="2" style="width:100%" placeholder="' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.questionPlaceholder')) + '"></textarea>'
      + '<input id="inc-seeds" type="text" style="width:100%" placeholder="' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.seedPlaceholder')) + '"/>'
      + '<label style="font-size:.85rem"><input type="checkbox" id="inc-web"/> ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.webOptIn')) + ' <span style="color:var(--fg-muted)">— ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.webOptInHint')) + '</span></label>'
      + '<div><button class="btn" onclick="CO_ENGRAM_INCUBATIONS.create()">🌱 ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.createBtn')) + '</button></div>'
      + '</div>';

    const items = payload.items || [];
    if (!items.length) {
      html += '<div class="empty">' + T.t('viewer.incubations.empty') + '</div>';
    } else {
      // resolved/paused 折叠为荣誉记录(spec §六)
      const active = items.filter(e => e.status !== 'resolved' && e.status !== 'paused');
      const archived = items.filter(e => e.status === 'resolved' || e.status === 'paused');
      html += active.map(e => CO_ENGRAM_INCUBATIONS.renderCard(e)).join('');
      if (archived.length) {
        html += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--fg-muted)">🏛️ ' + archived.length + ' × ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.status.resolved')) + '/' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.status.paused')) + '</summary>'
          + archived.map(e => CO_ENGRAM_INCUBATIONS.renderCard(e)).join('') + '</details>';
      }
    }
    html += '</div>';
    root.innerHTML = html;
  },

  renderCard(e) {
    const T = CO_ENGRAM_T;
    const statusKey = 'viewer.incubations.status.' + e.status;
    const statusLabel = T.t(statusKey) !== statusKey ? T.t(statusKey) : e.status;
    const color = e.status === 'active' ? '#34d399' : (e.status === 'in-flight' ? '#fbbf24' : (e.status === 'suggested-resolve' ? '#a78bfa' : 'var(--fg-muted)'));
    let html = '<div class="card" id="inc-card-' + CO_ENGRAM.escapeHtml(e.id) + '" style="margin-bottom:1rem;padding:1rem">'
      + '<div class="card-title">' + CO_ENGRAM.escapeHtml(e.question) + '</div>'
      + '<div class="card-meta" style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-bottom:.5rem">'
      + '<span class="chip" style="color:' + color + '">' + CO_ENGRAM.escapeHtml(statusLabel) + '</span>'
      + '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.rounds', { n: e.rounds })) + '</span>'
      + (e.webResearchOptIn ? '<span class="chip">🌐</span>' : '')
      + (e.lastHatchedAt ? '<span title="' + CO_ENGRAM.escapeHtml(e.lastHatchedAt) + '">' + CO_ENGRAM.relativeTime(e.lastHatchedAt) + '</span>' : '')
      + '</div>'
      + '<div id="inc-job-' + CO_ENGRAM.escapeHtml(e.id) + '" style="margin-bottom:.5rem"></div>'
      + '<div style="display:flex;gap:.4rem;flex-wrap:wrap">'
      + ((e.status === 'active' || e.status === 'in-flight') ? '<button class="btn mini" onclick="CO_ENGRAM_INCUBATIONS.runNow(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\')">🌙 ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.runNow')) + '</button>' : '')
      + (e.status === 'suggested-resolve'
        ? '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.resolvePrompt')) + '</span>'
          + '<button class="btn mini" onclick="CO_ENGRAM_INCUBATIONS.resolve(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\', true)">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.resolveYes')) + '</button>'
          + '<button class="btn mini secondary" onclick="CO_ENGRAM_INCUBATIONS.resolve(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\', false)">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.resolveNo')) + '</button>'
        : '')
      + '</div>';
    // 梦境时间线(过程透明是信任来源,spec §六)
    const tl = e.timeline || [];
    if (tl.length) {
      html += '<details style="margin-top:.6rem"><summary style="cursor:pointer;font-size:.9rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.timeline')) + ' (' + tl.length + ')</summary><ul style="padding-left:1.1rem;font-size:.88rem;line-height:1.6">';
      for (const t of tl) {
        const triggerKey = 'viewer.incubations.trigger.' + t.trigger;
        const trigger = T.t(triggerKey) !== triggerKey ? T.t(triggerKey) : t.trigger;
        html += '<li><strong>' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.timelineRound', { round: t.round, trigger: trigger })) + '</strong>'
          + (t.summaries && t.summaries.length ? '<ul>' + t.summaries.map(x => '<li>' + CO_ENGRAM.escapeHtml(x) + '</li>').join('') + '</ul>' : '')
          + (t.externalCallCount ? '<div style="color:var(--fg-muted);font-size:.82rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.externalCalls', { n: t.externalCallCount })) + '</div>' : '')
          + (t.note ? '<div style="color:var(--fg-muted);font-size:.82rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.note', { note: t.note })) + '</div>' : '')
          + '</li>';
      }
      html += '</ul></details>';
    }
    html += '</div>';
    return html;
  },

  async create() {
    const q = (document.getElementById('inc-q').value || '').trim();
    if (q.length < 4) return;
    const seedsRaw = (document.getElementById('inc-seeds').value || '').trim();
    const seedEngramIds = seedsRaw ? seedsRaw.split(',').map(x => x.trim()).filter(Boolean) : undefined;
    const webResearchOptIn = !!(document.getElementById('inc-web') && document.getElementById('inc-web').checked);
    try {
      await CO_ENGRAM.apiJson('/api/incubations', 'POST', { question: q, seedEngramIds, webResearchOptIn });
      const root = document.getElementById('incubations-content');
      if (root) await CO_ENGRAM_INCUBATIONS.render(root);
    } catch (e) {
      alert(e.message);
    }
  },

  /** 立即夜思:异步任务 + 轮询(不挂起 HTTP 请求,spec §六) */
  async runNow(id) {
    const T = CO_ENGRAM_T;
    const slot = document.getElementById('inc-job-' + id);
    if (slot) slot.innerHTML = '<span style="color:#fbbf24">⏳ ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.running')) + '</span>';
    try {
      const r = await CO_ENGRAM.apiJson('/api/incubations/' + encodeURIComponent(id) + '/run', 'POST');
      if (r.jobId) CO_ENGRAM_INCUBATIONS.poll(r.jobId, id);
    } catch (e) {
      if (slot) slot.innerHTML = '<span style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.jobError', { err: e.message })) + '</span>';
    }
  },

  poll(jobId, incubationId) {
    const T = CO_ENGRAM_T;
    const timer = setInterval(async function() {
      let job;
      try {
        job = await CO_ENGRAM.apiGet('/api/incubation-jobs/' + encodeURIComponent(jobId));
      } catch (_) { clearInterval(timer); return; }
      const slot = document.getElementById('inc-job-' + incubationId);
      if (job.status === 'done') {
        clearInterval(timer);
        if (slot) slot.innerHTML = '<span style="color:#34d399">✅ ' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.jobDone', { proposals: job.proposals || 0, level: job.level || '?' })) + '</span>';
        const root = document.getElementById('incubations-content');
        if (root) await CO_ENGRAM_INCUBATIONS.render(root);
      } else if (job.status === 'error') {
        clearInterval(timer);
        if (slot) slot.innerHTML = '<span style="color:#E02424">' + CO_ENGRAM.escapeHtml(T.t('viewer.incubations.jobError', { err: job.error || '?' })) + '</span>';
        const root = document.getElementById('incubations-content');
        if (root) await CO_ENGRAM_INCUBATIONS.render(root);
      }
    }, 3000);
    CO_ENGRAM_INCUBATIONS._polling[jobId] = timer;
  },

  async resolve(id, answered) {
    try {
      await CO_ENGRAM.apiJson('/api/incubations/' + encodeURIComponent(id) + '/resolve', 'POST', { answered: answered });
      const root = document.getElementById('incubations-content');
      if (root) await CO_ENGRAM_INCUBATIONS.render(root);
    } catch (e) {
      alert(e.message);
    }
  },
};

CO_ENGRAM.on('help', async function() {
  const el = document.getElementById('help-content');
  if (!el) return;
  if (CO_ENGRAM._helpLoaded) return;
  CO_ENGRAM._helpLoaded = true;
  el.innerHTML = CO_ENGRAM_HELP.render();
});

window.CO_ENGRAM_HELP = {
  render() {
    const T = CO_ENGRAM_T;
    return ''
      + '<div class="panel" style="max-width:900px;margin:0 auto;padding:1.5rem;line-height:1.7">'
      + '<h2 style="margin-top:0">' + T.t('viewer.help.title') + '</h2>'
      + '<p>' + T.t('viewer.help.intro') + '</p>'

      + '<h3>' + T.t('viewer.help.conceptsTitle') + '</h3>'
      + '<dl style="padding-left:0.5rem;border-left:3px solid var(--border)">'
      + '<dt>' + T.t('viewer.help.conceptEngram') + '</dt>'
      + '<dd style="margin-bottom:0.6rem">' + T.t('viewer.help.conceptEngramDesc') + '</dd>'
      + '<dt>' + T.t('viewer.help.conceptSynapse') + '</dt>'
      + '<dd style="margin-bottom:0.6rem">' + T.t('viewer.help.conceptSynapseDesc') + '</dd>'
      + '<dt>' + T.t('viewer.help.conceptImportance') + '</dt>'
      + '<dd style="margin-bottom:0.6rem">' + T.t('viewer.help.conceptImportanceDesc') + '</dd>'
      + '<dt>' + T.t('viewer.help.conceptVector') + '</dt>'
      + '<dd style="margin-bottom:0.6rem">' + T.t('viewer.help.conceptVectorDesc') + '</dd>'
      + '<dt>' + T.t('viewer.help.conceptLifecycle') + '</dt>'
      + '<dd style="margin-bottom:0.6rem">' + T.t('viewer.help.conceptLifecycleDesc') + '</dd>'
      + '</dl>'

      + '<h3>' + T.t('viewer.help.rulesTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.rulesIntro') + '</p>'
      + '<ul style="padding-left:1.2rem;line-height:1.7">'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.ruleLtp') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.ruleLtd') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.ruleHebbian') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.ruleWeights') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.ruleWindows') + '</li>'
      + '</ul>'

      + '<h3>' + T.t('viewer.help.stateMachineTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.stateMachineIntro') + '</p>'
      + '<ol style="padding-left:1.2rem;line-height:1.7">'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.stateUnverified') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.statePlausible') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.stateProbable') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.stateVerified') + '</li>'
      + '<li style="margin-bottom:0.4rem">' + T.t('viewer.help.stateRefuted') + '</li>'
      + '</ol>'

      + '<h3>' + T.t('viewer.help.tabsTitle') + '</h3>'
      + '<ul style="padding-left:1.2rem">'
      + '<li>' + T.t('viewer.help.tabStats') + '</li>'
      + '<li>' + T.t('viewer.help.tabEngrams') + '</li>'
      + '<li>' + T.t('viewer.help.tabSkills') + '</li>'
      + '<li>' + T.t('viewer.help.tabGraph') + '</li>'
      + '<li>' + T.t('viewer.help.tabProposals') + '</li>'
      + '<li>' + T.t('viewer.help.tabAudit') + '</li>'
      + '<li>' + T.t('viewer.help.tabTrash') + '</li>'
      + '<li>' + T.t('viewer.help.tabConfig') + '</li>'
      + '</ul>'

      + '<h3>' + T.t('viewer.help.nightThinkingTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.nightThinkingDesc') + '</p>'

      + '<h3>' + T.t('viewer.help.evolutionTitle') + '</h3>'
      + '<ol style="padding-left:1.2rem">'
      + '<li>' + T.t('viewer.help.evo1') + '</li>'
      + '<li>' + T.t('viewer.help.evo2') + '</li>'
      + '<li>' + T.t('viewer.help.evo3') + '</li>'
      + '<li>' + T.t('viewer.help.evo4') + '</li>'
      + '<li>' + T.t('viewer.help.evo5') + '</li>'
      + '<li>' + T.t('viewer.help.evo6') + '</li>'
      + '</ol>'

      + '<h3>' + T.t('viewer.help.tipsTitle') + '</h3>'
      + '<ul style="padding-left:1.2rem">'
      + '<li>' + T.t('viewer.help.tip1') + '</li>'
      + '<li>' + T.t('viewer.help.tip2') + '</li>'
      + '<li>' + T.t('viewer.help.tip3') + '</li>'
      + '<li>' + T.t('viewer.help.tip4') + '</li>'
      + '<li>' + T.t('viewer.help.tip5') + '</li>'
      + '<li>' + T.t('viewer.help.tip6') + '</li>'
      + '<li>' + T.t('viewer.help.tip7') + '</li>'
      + '</ul>'

      + '<h3>' + T.t('viewer.help.visibilityTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.visibilityBody') + '</p>'

      + '<h3>' + T.t('viewer.help.opsTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.opsPorts') + '</p>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.opsDataRoot') + '</p>'

      + '<h3>' + T.t('viewer.help.profilesTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.profilesBody') + '</p>'

      + '<h3>' + T.t('viewer.help.syncTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.syncBody') + '</p>'

      + '<h3>' + T.t('viewer.help.obsidianTitle') + '</h3>'
      + '<p style="margin-bottom:0.6rem">' + T.t('viewer.help.obsidianBody') + '</p>'

      + '</div>';
  }
};

// ============================================================
// Maintenance — REM/daily/light/deep 维护阶段状态(方案 A viewer tab)
// ============================================================
CO_ENGRAM.on('maintenance', async function() {
  const root = document.getElementById('maintenance-content');
  if (!root) return;
  if (CO_ENGRAM._maintenanceLoaded) return;
  CO_ENGRAM._maintenanceLoaded = true;
  await CO_ENGRAM_MAINTENANCE.render(root);
});

window.CO_ENGRAM_MAINTENANCE = {
  async render(root) {
    const T = CO_ENGRAM_T;
    root.innerHTML = '<div class="loading">' + T.t('viewer.maintenance.loading') + '</div>';
    // 洞察质量度量(spec §九):采纳率/后续使用率/critic 一致性,失败静默不阻塞
    let insightStats = null;
    try { insightStats = await CO_ENGRAM.apiGet('/api/insight-stats'); } catch (_) {}
    let payload;
    try {
      payload = await CO_ENGRAM.apiGet('/api/maintenance-state');
    } catch (e) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>';
      return;
    }
    if (!payload.enabled) {
      root.innerHTML = '<div class="empty">' + T.t('viewer.maintenance.disabledHint') + '</div>';
      return;
    }
    const insightHtml = CO_ENGRAM_MAINTENANCE.renderInsightStats(insightStats);
    root.innerHTML = insightHtml + CO_ENGRAM_MAINTENANCE.renderHtml(payload.state, payload.intervals);
  },

  renderInsightStats(st) {
    const T = CO_ENGRAM_T;
    if (!st || !st.enabled || !st.total) return '';
    const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '—');
    return '<div class="panel" style="margin-bottom:1rem;padding:1rem 1.2rem">'
      + '<h3 style="margin-top:0">💡 ' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.insightStats.title')) + '</h3>'
      + '<div class="card-meta" style="display:flex;flex-wrap:wrap;gap:.5rem">'
      + '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.insightStats.total', { n: st.total })) + '</span>'
      + '<span class="chip">✅ ' + st.accepted + ' · ✗ ' + st.dismissed + ' · ⏳ ' + st.pending + '</span>'
      + '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.insightStats.acceptance', { v: pct(st.acceptanceRate) })) + '</span>'
      + '<span class="chip">' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.insightStats.laterUse', { v: pct(st.laterUseRate) })) + '</span>'
      + (typeof st.criticCorrelation === 'number' ? '<span class="chip" title="critic score vs human accept">critic r=' + st.criticCorrelation.toFixed(2) + '</span>' : '')
      + '</div></div>';
  },

  renderHtml(state, intervals) {
    const T = CO_ENGRAM_T;
    // Daily(每日衰减)不属于梦境(固定 importance×0.95,无变化),不在此展示;engine 仍运行
    const STAGES = ['rem', 'deep', 'light'];
    const now = Date.now();

    function relTime(iso) {
      if (!iso) return T.t('viewer.maintenance.never');
      const t = new Date(iso).getTime();
      const diff = now - t;
      if (diff < 60 * 1000) return T.t('viewer.maintenance.justNow');
      if (diff < 60 * 60 * 1000) return T.t('viewer.maintenance.minutesAgo', { n: Math.floor(diff / 60000) });
      if (diff < 24 * 60 * 60 * 1000) return T.t('viewer.maintenance.hoursAgo', { n: Math.floor(diff / 3600000) });
      return T.t('viewer.maintenance.daysAgo', { n: Math.floor(diff / 86400000) });
    }

    // 把毫秒差值格式化为「N 天 / N 小时 / N 分钟」的可读时长
    function humanizeDuration(ms) {
      const abs = Math.abs(ms);
      if (abs < 60 * 1000) return Math.floor(abs / 1000) + 's';
      if (abs < 60 * 60 * 1000) return Math.floor(abs / 60000) + 'min';
      if (abs < 24 * 60 * 60 * 1000) return Math.floor(abs / 3600000) + 'h';
      return Math.floor(abs / 86400000) + 'd';
    }

    function pct(elapsed, interval) {
      if (!interval) return 0;
      return Math.min(100, (elapsed / interval) * 100).toFixed(1);
    }

    function statusKind(stage, lastRunAt, interval) {
      if (!lastRunAt) return stage === 'rem' || stage === 'daily' ? 'overdue' : 'never';
      const elapsed = now - new Date(lastRunAt).getTime();
      if (elapsed > interval) return 'overdue';
      if (elapsed > interval * 0.9) return 'soon';
      return 'healthy';
    }

    // 把 statusKind 翻译成 statusTip(含动态参数 n / pct)
    function statusTip(stage, kind, lastRunAt, interval) {
      if (kind === 'never') {
        return T.t('viewer.maintenance.statusTip.never');
      }
      const elapsed = lastRunAt ? now - new Date(lastRunAt).getTime() : 0;
      if (kind === 'healthy') {
        const remain = interval - elapsed;
        return T.t('viewer.maintenance.statusTip.healthy', { n: humanizeDuration(remain) });
      }
      if (kind === 'soon') {
        return T.t('viewer.maintenance.statusTip.soon', { pct: pct(elapsed, interval) });
      }
      // overdue
      const over = elapsed - interval;
      return T.t('viewer.maintenance.statusTip.overdue', { n: humanizeDuration(over) });
    }

    function stageRow(stage) {
      const interval = intervals[stage];
      const stageState = state.stages[stage];
      const lastRunAt = stageState ? stageState.lastRunAt : null;
      const elapsed = lastRunAt ? now - new Date(lastRunAt).getTime() : null;
      const kind = statusKind(stage, lastRunAt, interval);
      const statusLabel = T.t('viewer.maintenance.status.' + kind);
      const statusTipText = statusTip(stage, kind, lastRunAt, interval);
      const lastResult = stageState ? stageState.lastResult : null;
      const lastError = stageState ? stageState.lastError : null;
      const icon = T.t('viewer.maintenance.stageIcon.' + stage);
      const subtitle = T.t('viewer.maintenance.stageSubtitle.' + stage);
      const stageTipText = T.t('viewer.maintenance.stageTip.' + stage);
      const stageName = T.t('viewer.maintenance.stage.' + stage);

      // 进度条 tooltip
      let progressBarTip;
      const progressPctNum = elapsed ? Number(pct(elapsed, interval)) : 0;
      if (kind === 'overdue') {
        const overPct = ((elapsed - interval) / interval * 100).toFixed(1);
        progressBarTip = T.t('viewer.maintenance.progressBarTipOverdue', {
          pct: overPct,
          remain: humanizeDuration(elapsed - interval),
        });
      } else if (elapsed !== null) {
        const remain = interval - elapsed;
        progressBarTip = T.t('viewer.maintenance.progressBarTip', {
          pct: progressPctNum.toFixed(1),
          remain: humanizeDuration(remain),
        });
      } else {
        progressBarTip = T.t('viewer.maintenance.statusTip.never');
      }

      // 产物摘要:lastResult → 中文友好描述
      // 数组(如 remModified)不在此显示——由专门列表渲染,避免 String() 成 [object Object]
      var FIELD_LABELS = {
        metacognitionApplied: '元认知修改', metacognitionTotal: '元认知评估',
        signalsProcessed: '处理信号', rpeUpdates: 'RPE 更新', windowsClosed: '关闭窗口',
        promptSignalsUpdated: '提示信号已更新', clustersScanned: '聚类扫描',
        decayed: '衰减', archived: '归档', forgotten: '遗忘', merged: '合并',
        skillsScanned: '技能扫描', skillsDecayed: '技能衰退',
      };
      function fmtStageField(k, v) {
        if (k === 'stage' || k === 'at') return null; // 跳过技术字段(用户看不懂)
        var label = FIELD_LABELS[k] || k;
        if (typeof v === 'boolean') return v ? label : null;
        return label + ' ' + v;
      }
      // Light 特判:计数全 0 时给友好说明(本周期无新信号),而不是一串看不懂的 0
      var _ds = lastResult && lastResult.downstreamSummary;
      var lightAllZero = stage === 'light' && _ds
        && !(_ds.signalsProcessed > 0) && !(_ds.rpeUpdates > 0) && !(_ds.windowsClosed > 0)
        && !(_ds.skillsDecayed > 0) && !(_ds.skillsScanned > 0);

      const parts = [];
      if (lightAllZero) {
        parts.push(CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.lightNoSignal')));
      } else if (lastResult) {
        for (const k of Object.keys(lastResult)) {
          const v = lastResult[k];
          if (Array.isArray(v)) continue;
          if (v !== null && typeof v === 'object') {
            for (const sk of Object.keys(v)) {
              if (Array.isArray(v[sk])) continue;
              var sf = fmtStageField(sk, v[sk]);
              if (sf) parts.push(CO_ENGRAM.escapeHtml(sf));
            }
          } else {
            var f = fmtStageField(k, v);
            if (f) parts.push(CO_ENGRAM.escapeHtml(f));
          }
        }
      }
      const summaryHtml = parts.length > 0
        ? '<div class="kpi-sub" style="margin-top:0.4rem"><span style="opacity:0.6">' + T.t('viewer.maintenance.resultLabel') + ':</span> ' + parts.join(' · ') + '</div>'
        : '';

      const errorHtml = lastError
        ? '<div class="kpi-sub" style="margin-top:0.3rem;color:#b8405a"><span style="opacity:0.7">' + T.t('viewer.maintenance.errorLabel') + ':</span> ⚠ ' + CO_ENGRAM.escapeHtml(lastError) + '</div>'
        : '';

      // REM 加「梦睡眠」徽章(独特语义,需要明显视觉提示)
      const dreamBadge = stage === 'rem'
        ? ' <span class="dream-badge" title="' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.dreamBadgeTip')) + '" style="cursor:help;border:1px solid var(--border-strong);padding:1px 6px;border-radius:8px;font-size:0.7rem;background:var(--accent-soft,rgba(94,234,212,0.15));color:var(--accent,#0F766E);margin-left:0.4rem">☾ ' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.dreamBadge')) + '</span>'
        : '';

      // 顶部行:图标(带 tip)+ stage 名 + dream 徽章 + 状态徽章 + 时间
      // 图标用 emoji,加 title 属性提供 hover tip,无 JS 依赖
      const headerHtml =
          '<div class="bar-label" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">'
        + '<span class="stage-icon" title="' + CO_ENGRAM.escapeHtml(stageTipText) + '" style="font-size:1.4rem;cursor:help;line-height:1">' + icon + '</span>'
        + '<div style="flex:1;min-width:0">'
        + '<div><strong>' + CO_ENGRAM.escapeHtml(stageName) + '</strong>' + dreamBadge
        + ' <span class="maintenance-status status-badge-' + kind + '" title="' + CO_ENGRAM.escapeHtml(statusTipText) + '" style="cursor:help;margin-left:0.4rem;padding:1px 6px;border-radius:8px;font-size:0.72rem;border:1px solid var(--border-strong,rgba(94,234,212,0.22))">' + CO_ENGRAM.escapeHtml(statusLabel) + '</span></div>'
        + '<div style="font-size:0.78rem;opacity:0.65;line-height:1.35;margin-top:2px">' + CO_ENGRAM.escapeHtml(subtitle) + '</div>'
        + '</div>'
        + '<div class="bar-value" style="white-space:nowrap;text-align:right">' + relTime(lastRunAt) + '</div>'
        + '</div>';

      const barHtml = '<div class="bar-track" title="' + CO_ENGRAM.escapeHtml(progressBarTip) + '" style="margin-top:0.45rem;cursor:help"><div class="bar-fill" style="width:' + (elapsed ? pct(elapsed, interval) : 0) + '%"></div></div>';

      // 各 stage 的「修改的记忆」列表(rem/light/deep 通用),可点击跳详情;数量限制防撑爆
      var remModifiedHtml = '';
      var modifiedItems = null;
      var modifiedLabel = '';
      var actionText = null;
      if (stage === 'rem' && _ds && _ds.remModified && _ds.remModified.length > 0) {
        modifiedItems = _ds.remModified;
        modifiedLabel = T.t('viewer.maintenance.remModifiedLabel');
        actionText = function(m) {
          return m.action === 'evaluated'
            ? T.t('viewer.maintenance.remAction.evaluated')
            : (T.enumLabel('verificationStatus', m.action) || m.action);
        };
      } else if (stage === 'light' && _ds && _ds.lightModified && _ds.lightModified.length > 0) {
        modifiedItems = _ds.lightModified;
        modifiedLabel = T.t('viewer.maintenance.lightModifiedLabel');
        actionText = function(m) {
          return (m.delta >= 0 ? '+' : '') + Number(m.delta).toFixed(2);
        };
      } else if (stage === 'deep' && _ds && _ds.deepModified && _ds.deepModified.length > 0) {
        modifiedItems = _ds.deepModified;
        modifiedLabel = T.t('viewer.maintenance.deepModifiedLabel');
        actionText = function(m) {
          return T.t('viewer.maintenance.deepAction.' + m.action) || m.action;
        };
      }
      if (modifiedItems) {
        var MAX_REM_SHOW = 6; // 大量时防撑爆:最多显示 6 条,超出折叠为「等 N 条」
        var shownRem = modifiedItems.slice(0, MAX_REM_SHOW);
        remModifiedHtml = '<div class="kpi-sub" style="margin-top:0.4rem">' + CO_ENGRAM.escapeHtml(modifiedLabel) + ': ';
        remModifiedHtml += shownRem.map(function(m) {
          // 修改项携带完整 data 属性,点击打开「修改介绍卡片」(说明这次修改 + 链接记忆)
          return '<span class="rem-mod-item" data-engram-id="' + CO_ENGRAM.escapeHtml(m.engramId) + '"'
            + ' data-stage="' + stage + '"'
            + ' data-action="' + CO_ENGRAM.escapeHtml(String(m.action ?? '')) + '"'
            + ' data-before="' + CO_ENGRAM.escapeHtml(String(m.before ?? '')) + '"'
            + ' data-delta="' + (typeof m.delta === 'number' ? m.delta : '') + '"'
            + ' data-to="' + CO_ENGRAM.escapeHtml(String(m.to ?? '')) + '"'
            + ' style="cursor:pointer;color:var(--accent,#0F766E);text-decoration:underline">' + CO_ENGRAM.escapeHtml(actionText(m)) + ' · ' + CO_ENGRAM.escapeHtml(m.engramId.slice(-8)) + '</span>';
        }).join('、');
        if (modifiedItems.length > MAX_REM_SHOW) {
          remModifiedHtml += ' <span style="opacity:0.6">等 ' + modifiedItems.length + ' 条</span>';
        }
        remModifiedHtml += '</div>';
      }

      // 模式提炼提案(dreaming,REM 另一半产出):补 metacognition 升级/反驳之外的类型
      // 每项可点击 → 跳转「记忆提案」tab(那里有对应的 rem-pattern 提案可审批)
      var patternHtml = '';
      var patternProposals = lastResult && lastResult.downstreamSummary ? lastResult.downstreamSummary.patternProposals : null;
      if (stage === 'rem' && patternProposals && patternProposals.length > 0) {
        patternHtml = '<div class="kpi-sub" style="margin-top:0.3rem">🌙 ' + CO_ENGRAM.escapeHtml(T.t('viewer.maintenance.patternLabel')) + ': '
          + patternProposals.map(function(p) {
              // 点击 → 跳转到来源记忆(sourceIds[0]);data-stage=pattern 区分(app.ts 委托直跳 engram)
              var srcId = (p.sourceIds && p.sourceIds[0]) ? p.sourceIds[0] : '';
              return '<span class="rem-mod-item" data-engram-id="' + CO_ENGRAM.escapeHtml(srcId) + '" data-stage="pattern" style="cursor:pointer;color:var(--accent,#0F766E);text-decoration:underline" title="置信度 ' + p.confidence.toFixed(2) + ',源自 ' + p.sourceCount + ' 条记忆(点击查看来源记忆)">' + CO_ENGRAM.escapeHtml(p.title) + '</span>';
            }).join('、')
          + '</div>';
      }

      return '<div class="bar-row maintenance-row status-' + kind + '" style="display:block;padding:0.9rem 1rem;margin-bottom:0.6rem;border:1px solid var(--border,rgba(94,234,212,0.1));border-radius:8px">'
        + headerHtml
        + barHtml
        + summaryHtml
        + remModifiedHtml
        + patternHtml
        + errorHtml
        + '</div>';
    }

    let html = '<div class="panel">';
    html += '<div class="panel-header"><h2>' + T.t('viewer.maintenance.title') + '</h2></div>';
    html += '<p class="panel-hint">' + T.t('viewer.maintenance.intro') + '</p>';
    html += '<div class="maintenance-list">';
    for (const stage of STAGES) {
      html += stageRow(stage);
    }
    html += '</div>';

    if (state.updatedAt) {
      html += '<div class="metadata" style="margin-top:1.2rem;font-size:0.85rem;color:var(--fg-muted)">';
      html += T.t('viewer.maintenance.lastWrite', {
        at: relTime(state.updatedAt),
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }
};
`;
