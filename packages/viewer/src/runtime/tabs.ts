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
// Stats
// ============================================================
CO_ENGRAM.on('stats', async function() {
  const el = document.getElementById('stats-content');
  if (!el) return;
  if (CO_ENGRAM._statsLoaded) return;
  const T = CO_ENGRAM_T;
  el.innerHTML = '<div class="loading">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loading')) + '</div>';
  let data;
  try { data = await CO_ENGRAM.apiGet('/api/stats'); }
  catch (e) { el.innerHTML = '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>'; return; }

  const kpiClickable = (label, value, sub, tab) => '<div class="kpi"' + (tab ? ' onclick="CO_ENGRAM.showTab(\\'' + tab + '\\')"' : '') + '>'
    + '<div class="kpi-label">' + CO_ENGRAM.escapeHtml(label) + '</div>'
    + '<div class="kpi-value">' + CO_ENGRAM.escapeHtml(value) + '</div>'
    + (sub ? '<div class="kpi-sub">' + CO_ENGRAM.escapeHtml(sub) + '</div>' : '') + '</div>';

  const barRow = (label, count, max, color, onclick, tipAttr) => '<div class="bar-row">'
    + '<div class="bar-label"' + (tipAttr || '') + (onclick ? ' onclick="' + onclick + '"' : '') + '>' + CO_ENGRAM.escapeHtml(label) + '</div>'
    + '<div class="bar-track"><div class="bar-fill" style="width:' + (max ? (count / max * 100) : 0).toFixed(1) + '%;background:' + (color || '#5eead4') + '"></div></div>'
    + '<div class="bar-value">' + count + '</div></div>';

  const kindMap = data.byKind || {};
  const kindKeys = Object.keys(kindMap);
  const kindMax = Math.max(1, ...kindKeys.map(k => kindMap[k] || 0));
  const statusMap = data.byStatus || {};
  const statusKeys = Object.keys(statusMap);
  const statusMax = Math.max(1, ...statusKeys.map(k => statusMap[k] || 0));
  const synKindMap = data.bySynapseKind || {};
  const synKindKeys = Object.keys(synKindMap);
  const synKindMax = Math.max(1, ...synKindKeys.map(k => synKindMap[k] || 0));
  const tagArr = data.topTags || [];
  const tagMax = tagArr.length ? Math.max(1, ...tagArr.map(t => t.count || 0)) : 1;
  const contribArr = data.topContributors || [];
  const contribMax = contribArr.length ? Math.max(1, ...contribArr.map(c => c.total || 0)) : 1;

  let html = '<div class="kpi-grid">'
    + kpiClickable(T.t('viewer.stats.totalEngrams'), data.totalEngrams || 0, T.t('viewer.stats.clickToViewAll'), 'engrams')
    + kpiClickable(T.t('viewer.stats.totalSynapses'), data.totalSynapses || 0, T.t('viewer.stats.clickToViewGraph'), 'graph')
    + kpiClickable(T.t('viewer.stats.pendingProposals'), data.pendingProposals || 0, T.t('viewer.stats.clickToHandle'), 'proposals')
    + '</div>';

  // 记忆印迹区(独立一块)
  html += '<div class="card" style="margin-top:1.25rem"><h3 class="section-title"' + CO_ENGRAM.tip('kind.fact') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.kindDistribution')) + '</h3>';
  if (!kindKeys.length) html += '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.empty')) + '</div>';
  else kindKeys.forEach(k => html += barRow(T.enumLabel('kind', k), kindMap[k], kindMax, CO_ENGRAM.kindColor(k), 'CO_ENGRAM.showTab(\\'engrams\\')', CO_ENGRAM.tip('kind.' + k)));
  html += '</div>';

  html += '<div class="card" style="margin-top:1rem"><h3 class="section-title"' + CO_ENGRAM.tip('status.active') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.statusDistribution')) + '</h3>';
  if (!statusKeys.length) html += '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.empty')) + '</div>';
  else statusKeys.forEach(k => html += barRow(T.enumLabel('status', k), statusMap[k], statusMax, '#94a3b8', '', CO_ENGRAM.tip('status.' + k)));
  html += '</div>';

  // 记忆突触区(独立一块,与印迹分开)
  html += '<div class="card" style="margin-top:1rem"><h3 class="section-title"' + CO_ENGRAM.tip('family.structural') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.synapseKindDistribution')) + '</h3>';
  if (!synKindKeys.length) html += '<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.synapsesEmpty')) + '</div>';
  else synKindKeys.forEach(k => html += barRow(T.enumLabel('synapseKind', k), synKindMap[k], synKindMax, CO_ENGRAM.edgeColor(k), 'CO_ENGRAM.showTab(\\'graph\\')', CO_ENGRAM.tip('synapse.' + k)));
  html += '</div>';

  // 贡献者排名
  if (contribArr.length) {
    html += '<div class="card" style="margin-top:1rem"><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.contributorRanking')) + '</h3>';
    html += '<table class="data-table"><thead><tr><th>#</th><th>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.contributorCol')) + '</th><th>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.engramCol')) + '</th><th>' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.synapseCol')) + '</th><th style="width:35%">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.totalCol')) + '</th></tr></thead><tbody>';
    contribArr.forEach((c, i) => {
      const pct = (c.total / contribMax * 100).toFixed(1);
      html += '<tr>'
        + '<td>' + (i + 1) + '</td>'
        + '<td><code>' + CO_ENGRAM.escapeHtml(c.actor) + '</code></td>'
        + '<td>' + c.engramCount + '</td>'
        + '<td>' + c.synapseCount + '</td>'
        + '<td><div class="bar-track" style="min-width:120px"><div class="bar-fill" style="width:' + pct + '%;background:#5eead4"></div></div> <span style="margin-left:.4rem">' + c.total + '</span></td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    html += '</div>';
  }

  if (tagArr.length) {
    html += '<div class="card" style="margin-top:1rem"><h3 class="section-title">' + CO_ENGRAM.escapeHtml(T.t('viewer.stats.topTags')) + '</h3>';
    tagArr.slice(0, 10).forEach(t => { html += barRow(t.tag, t.count, tagMax, '#c084fc'); });
    html += '</div>';
  }

  el.innerHTML = html;
  CO_ENGRAM._statsLoaded = true;
});

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
    if (!CO_ENGRAM._engramsPager) {
      CO_ENGRAM._engramsPager = CO_ENGRAM.createPaginator({
        endpoint: '/api/engrams',
        pageSize: 200,
      });
    }

    try { await CO_ENGRAM._engramsPager.load(); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    const all = CO_ENGRAM._engramsPager.getItems();
    CO_ENGRAM._engramsCache = all;
    CO_ENGRAM._engramsTotal = CO_ENGRAM._engramsPager.getTotal();
    CO_ENGRAM._engramsViewMode = CO_ENGRAM._engramsViewMode || 'card';

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
      + '<span class="chip" id="engrams-count">已加载 ' + all.length + ' / 共 ' + CO_ENGRAM._engramsTotal + '</span>'
      + '</div>'
      + '<div id="engrams-body"></div>';

    root.innerHTML = filterBar;
    this.applyFilter();
  },

  setMode(mode) {
    CO_ENGRAM._engramsViewMode = mode;
    const toggle = document.querySelector('.view-toggle');
    if (toggle) toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    this.applyFilter();
  },

  // 兼容旧调用名
  setView(mode) { this.setMode(mode); },

  applyFilter() {
    const pager = CO_ENGRAM._engramsPager;
    const cache = pager ? pager.getItems() : (CO_ENGRAM._engramsCache || []);
    const q = ((document.getElementById('engrams-q') || {}).value || '').toLowerCase();
    const kind = (document.getElementById('engrams-kind') || {}).value || '';
    const visibility = (document.getElementById('engrams-visibility') || {}).value || '';
    const sort = ((document.getElementById('engrams-sort') || {}).value || 'createdAt-desc').split('-');
    const [sortKey, sortDir] = sort;
    const T = CO_ENGRAM_T;
    const mode = CO_ENGRAM._engramsViewMode || 'card';

    let filtered = cache.filter(e => {
      if (kind && e.kind !== kind) return false;
      // visibility 过滤:
      // - 'team' → 显示 public/team/restricted(团队可见的非 private)
      // - 'private' → 仅显示 visibility === 'private'
      if (visibility === 'private' && e.visibility !== 'private') return false;
      if (visibility === 'team' && e.visibility === 'private') return false;
      if (q) {
        const title = (e.title || '').toLowerCase();
        const tags = (e.domainTags || []).join(' ').toLowerCase();
        if (!title.includes(q) && !tags.includes(q)) return false;
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
    const countEl = document.getElementById('engrams-count');
    if (countEl) countEl.textContent = '已显示 ' + filtered.length + ' / 已加载 ' + cache.length + ' / 共 ' + total;

    if (!filtered.length) {
      body.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('engrams.empty')) + '</div>';
      return;
    }

    if (mode === 'tree') {
      // 目录视图:按 domainTags[0] 或 kind 分组
      CO_ENGRAM_ENGRAMS._renderTree(filtered, body);
    } else {
      // 卡片视图
      this._renderCards(filtered, body);
    }

    // 末尾追加 load-more 按钮(cursor 分页)
    if (hasMore) {
      const moreRow = document.createElement('div');
      moreRow.className = 'load-more-row';
      moreRow.style.cssText = 'text-align:center;padding:1rem 0;grid-column:1/-1';
      moreRow.innerHTML = '<button class="btn" onclick="CO_ENGRAM_ENGRAMS.loadMore()">加载更多(已加载 ' + cache.length + ' / 共 ' + total + ')</button>';
      body.appendChild(moreRow);
    }
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
        + CO_ENGRAM.importanceBar(e.importance) + '</div>'
        + '<div class="card-meta">'
        + (e.retrievalCount != null ? '<span' + CO_ENGRAM.tip('retrievalCount') + '>' + CO_ENGRAM.escapeHtml(T.t('engrams.retrievalsCount', { n: e.retrievalCount })) + '</span>' : '')
        + createdCell
        + '</div>'
        + (tags ? '<div class="card-meta">' + tags + more + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  },

  async loadMore() {
    const pager = CO_ENGRAM._engramsPager;
    if (!pager || !pager.hasMore()) return;
    try { await pager.loadMore(); }
    catch (e) { alert('加载更多失败:' + (e.message || e)); return; }
    this.applyFilter();
  },

  // 目录视图:按 domainTags[0](无则归入"未分类")→ kind 两层结构
  _renderTree(items, body) {
    const T = CO_ENGRAM_T;
    const groups = new Map(); // groupKey → { display, items: [] }
    for (const e of items) {
      const topTag = (e.domainTags || [])[0] || '__untagged__';
      const display = topTag === '__untagged__' ? T.t('engrams.untagged') : topTag;
      if (!groups.has(topTag)) groups.set(topTag, { display, items: [] });
      groups.get(topTag).items.push(e);
    }
    // 排序:未分类最后,其他按字母
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === '__untagged__') return 1;
      if (b[0] === '__untagged__') return -1;
      return a[1].display.localeCompare(b[1].display);
    });

    let html = '<div class="tree-view">';
    sortedGroups.forEach(([key, group], gi) => {
      const gid = 'tree-group-' + gi;
      const kindSubGroups = new Map();
      for (const e of group.items) {
        if (!kindSubGroups.has(e.kind)) kindSubGroups.set(e.kind, []);
        kindSubGroups.get(e.kind).push(e);
      }
      const kindKeys = Array.from(kindSubGroups.keys()).sort();
      const subRows = kindKeys.map(k => {
        const subItems = kindSubGroups.get(k);
        const subId = gid + '-k-' + k;
        const itemRows = subItems.map(e =>
          '<div class="tree-leaf" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\')"' + CO_ENGRAM.tip('kind.' + e.kind) + '>'
          + '<span class="chip kind-' + e.kind + '">' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', e.kind)) + '</span> '
          + CO_ENGRAM.escapeHtml(e.title)
          + '</div>'
        ).join('');
        return '<details class="tree-subgroup" open>'
          + '<summary><span class="chip kind-' + k + '"' + CO_ENGRAM.tip('kind.' + k) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k)) + '</span> <span class="tree-count">' + subItems.length + '</span></summary>'
          + '<div class="tree-leaf-group">' + itemRows + '</div>'
          + '</details>';
      }).join('');

      html += '<details class="tree-group" open>'
        + '<summary><span class="tree-folder-icon">📁</span> ' + CO_ENGRAM.escapeHtml(group.display) + ' <span class="tree-count">' + group.items.length + '</span></summary>'
        + '<div class="tree-group-body">' + subRows + '</div>'
        + '</details>';
    });
    html += '</div>';
    body.innerHTML = html;
  },

  async open(id) {
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(id)); }
    catch (e) { CO_ENGRAM.openDrawer('<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'); return; }
    CO_ENGRAM._currentEngram = d;
    this._renderView(d);
  },

  _renderView(d) {
    const T = CO_ENGRAM_T;
    const D = CO_ENGRAM_DECAY;
    const id = CO_ENGRAM.escapeHtml(d.id);
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
      ? D.computeDecayState(d.lastEffectiveAt, d.createdAt, d.importance)
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

    // 多维重要性段(可选)
    const iv = d.importanceVector;
    const ivSection = iv
      ? '<h3' + CO_ENGRAM.tip('importanceVector') + '>' + T.sectionLabel('multiDimImportance') + '</h3>'
        + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('importanceDim.personal') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.personal')) + '</span>' + (iv.personal || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.team') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.team')) + '</span>' + (iv.team || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.project') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.project')) + '</span>' + (iv.project || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.network') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.network')) + '</span>' + (iv.network || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.temporal') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.temporal')) + '</span>' + (iv.temporal || 0).toFixed(2)
        + ' <span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.dim.composite')) + '</span>' + T.formatScoreBand(iv.composite) + '</div>'
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

    const body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + T.actionLabel('detailView') + '</strong>'
      + '<button class="btn" onclick="CO_ENGRAM_ENGRAMS.edit()">' + T.actionLabel('edit') + '</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.confirmDelete()">' + T.actionLabel('delete') + '</button>'
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(d.title) + '</h2>'
      + '<div class="field"><span class="chip kind-' + d.kind + '"' + CO_ENGRAM.tip('kind.' + d.kind) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', d.kind)) + '</span> '
      + CO_ENGRAM.importanceBar(d.importance) + ' <span class="kpi-sub"' + CO_ENGRAM.tip('importance') + '>' + T.fieldLabel('importance') + ' ' + T.formatScoreBand(d.importance) + '</span></div>'
      + '<div class="field"><span class="field-label">' + T.fieldLabel('id') + '</span><code>' + id + '</code></div>'
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
            + ' <button class="btn secondary mini" onclick="CO_ENGRAM_ENGRAMS.updateVisibility(\\'' + id + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.visibility.changeBtn')) + '</button>'
            + '</div></details>';
        })()
      + valueSection
      + ivSection
      + encSection;
    CO_ENGRAM.openDrawer(body);
  },

  edit() {
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    const T = CO_ENGRAM_T;
    const id = CO_ENGRAM.escapeHtml(d.id);
    const kindKeys = ['observation', 'fact', 'pattern', 'procedure', 'hypothesis'];
    const kindOptions = kindKeys.map(k => '<option value="' + k + '"' + (d.kind === k ? ' selected' : '') + CO_ENGRAM.tip('kind.' + k) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k)) + '</option>').join('');
    const visKeys = ['public', 'team', 'private', 'restricted'];
    const visOptions = visKeys.map(v => '<option value="' + v + '"' + (d.visibility === v ? ' selected' : '') + CO_ENGRAM.tip('visibility.' + v) + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('visibility', v)) + '</option>').join('');

    const body = '<div class="edit-banner"><strong>' + CO_ENGRAM.escapeHtml(T.t('viewer.common.editMode')) + '</strong> · ' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.editModeHint')) + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.editEngramTitle')) + '</h2>'
      + '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.fieldLabel('id')) + '</span><code>' + id + '</code></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.titleLabel')) + '</label><input id="ef-title" type="text" value="' + CO_ENGRAM.escapeHtml(d.title || '') + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('kind.fact') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.kindLabel')) + '</label><select id="ef-kind"' + CO_ENGRAM.tip('kind.fact') + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('importance') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.importanceLabel')) + '</label><input id="ef-importance-range" type="range" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance\\').value=this.value"><input id="ef-importance" type="number" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('confidence') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.confidenceLabel')) + '</label><input id="ef-confidence-range" type="range" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence\\').value=this.value"><input id="ef-confidence" type="number" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.tagsLabel')) + '</label><input id="ef-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.domainTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.ctxTagsLabel')) + '</label><input id="ef-ctx-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.contextTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('visibility.public') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.detail.visibilityLabel')) + '</label><select id="ef-visibility"' + CO_ENGRAM.tip('visibility.public') + '>' + visOptions + '</select>'
      + '<div class="kpi-sub"' + CO_ENGRAM.tip('engram.visibilityEdit') + '>' + CO_ENGRAM.escapeHtml(T.t('viewer.engram.tip.visibilityEdit')) + '</div>'
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
   * 启发式推断 proposal 的标题和类型(后端 Proposal 没有这两个字段)。
   *
   * 标题:取 centroidExcerpt 首句,超过 50 字截断;空时回退 entityId。
   * 类型:基于关键词匹配。中英双语关键词覆盖 5 种 EngramKind。
   *   - procedure:步骤/流程/how to/step
   *   - fact:应该/必须/always/never/事实
   *   - hypothesis:也许/可能/maybe/probably/假设
   *   - pattern:规律/总是/usually/pattern
   *   - observation:观察到/noticed/看到
   *   默认 observation(中性、不强行猜)。
   */
  _inferMeta(p) {
    const text = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
    const lower = text.toLowerCase();

    let kind = 'observation';
    if (/(步骤|流程|怎么|如何|how to|step|procedure|process|算法|流程图)/i.test(text)) kind = 'procedure';
    else if (/(应该|必须|总是|事实|always|never|must|fact|规则|定律)/i.test(text)) kind = 'fact';
    else if (/(也许|可能|猜测|假设|maybe|probably|hypoth|hypo|猜测)/i.test(text)) kind = 'hypothesis';
    else if (/(规律|模式|通常|惯|pattern|usually|tend to|often)/i.test(text)) kind = 'pattern';
    else if (/(观察|看到|发现|noticed|observed|saw|found)/i.test(text)) kind = 'observation';

    let title = text.trim();
    if (title) {
      const firstClause = title.split(/[。.!?\\n??;；]/)[0].trim();
      title = firstClause || title;
      if (title.length > 50) title = title.slice(0, 50) + '…';
    }
    if (!title) title = p.entityId;

    return { title, kind };
  },

  async _setStatus(status) {
    this._currentStatus = status;
    if (CO_ENGRAM._proposalsPager) {
      try { await CO_ENGRAM._proposalsPager.load(); }
      catch (e) { /* 加载失败保留当前 items,_render 会展示 */ }
    }
    this._render();
  },

  async loadMore() {
    const pager = CO_ENGRAM._proposalsPager;
    if (!pager || !pager.hasMore()) return;
    try { await pager.loadMore(); }
    catch (e) { alert('加载更多失败:' + (e.message || e)); return; }
    this._render();
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

    const buttons = ['pending', 'accepted', 'dismissed', 'all'].map(s =>
      '<button class="tab ' + (s === currentStatus ? 'active' : '') + '" onclick="CO_ENGRAM_PROPOSALS._setStatus(\\'' + s + '\\')">'
      + CO_ENGRAM.escapeHtml(statusLabel(s)) + '</button>'
    ).join('');

    let html = '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">' + buttons
      + '<span class="chip">已加载 ' + items.length + ' / 共 ' + total + '</span></div>';
    if (!items.length) {
      html += '<div class="empty"><div class="icon">✓</div>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.empty', { status: statusLabel(currentStatus) })) + '</div>';
    } else {
      html += '<div class="grid cols-3">';
      for (const p of items) {
        const meta = this._inferMeta(p);
        const kindLabel = T.enumLabel('kind', meta.kind);
        const preview = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
        const previewClip = preview.length > 120 ? preview.slice(0, 120) + '…' : preview;
        const cardClick = ' style="cursor:pointer" onclick="CO_ENGRAM_PROPOSALS.open(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')"';

        html += '<div class="card"' + cardClick + '>'
          + '<div class="card-title" title="' + CO_ENGRAM.escapeHtml(p.entityId) + '">' + CO_ENGRAM.escapeHtml(meta.title) + '</div>';
        html += '<div class="card-meta" style="margin-bottom:0.4rem">'
          + '<span class="chip kind-' + meta.kind + '">' + CO_ENGRAM.escapeHtml(kindLabel) + '</span>'
          + '<span>×' + (p.occurrences || 0) + '</span>'
          + (p.createdAt ? '<span>' + CO_ENGRAM.relativeTime(p.createdAt) + '</span>' : '')
          + '<span class="chip">' + CO_ENGRAM.escapeHtml(statusLabel(p.status)) + '</span>'
          + (p.payload && p.payload.visibility ? CO_ENGRAM.renderVisibilityBadge(p.payload.visibility) : '')
          + '</div>';
        if (previewClip) html += '<div style="font-size:0.8rem;color:var(--fg-muted);margin-bottom:0.4rem">' + CO_ENGRAM.escapeHtml(previewClip) + '</div>';
        if (p.status === 'accepted' && p.acceptedEngramId) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(16,185,129,.12);color:var(--accent)">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.convertedTo')) + ' ▸ ' + CO_ENGRAM.escapeHtml(p.acceptedEngramId.slice(0, 12)) + '</span></div>';
        }
        if (p.status === 'dismissed' && p.dismissReason) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(239,68,68,.12);color:#ef4444">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.dismissedReason')) + ': ' + CO_ENGRAM.escapeHtml((p.dismissReason || '').slice(0, 40)) + '</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
      if (pager.hasMore()) {
        html += '<div class="load-more-row" style="text-align:center;padding:1rem 0;grid-column:1/-1">'
          + '<button class="btn" onclick="CO_ENGRAM_PROPOSALS.loadMore()">加载更多(已加载 ' + items.length + ' / 共 ' + total + ')</button></div>';
      }
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
    const samples = (p.sampleQuotes || []).map(s => '<pre class="pre-compact" style="margin:0.3rem 0">' + CO_ENGRAM.escapeHtml(s) + '</pre>').join('');
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

    const body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.detailTitle')) + '</strong>'
      + '<code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(p.entityId) + '</code>'
      + '</div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.titleLabel') : T.t('viewer.proposals.titleLabelReadonly')) + '</label>'
      + '<input id="pf-title" type="text" value="' + CO_ENGRAM.escapeHtml(meta.title) + '"' + (editable ? '' : ' readonly') + '></div>'
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
      + '<input id="pf-tags" type="text" placeholder="' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.tagsPlaceholder')) + '"' + (editable ? '' : ' readonly') + '></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">' + CO_ENGRAM.escapeHtml(editable ? T.t('viewer.proposals.contentLabel') : T.t('viewer.proposals.contentLabelReadonly')) + '</label>'
      + '<textarea id="pf-content" rows="6"' + (editable ? '' : ' readonly') + '>' + CO_ENGRAM.escapeHtml(p.centroidExcerpt || '') + '</textarea></div>'
      + '<h3>' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.samples', { n: (p.occurrences || 0) })) + '</h3>'
      + (samples || '<div class="empty" style="padding:1rem">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.noSamples')) + '</div>')
      + '<div class="field"><span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.firstSeen')) + '</span>' + CO_ENGRAM.escapeHtml(p.firstSeenAt || '—')
      + ' <span class="field-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.lastSeen')) + '</span>' + CO_ENGRAM.escapeHtml(p.lastSeenAt || '—') + '</div>'
      + actionBtns;

    CO_ENGRAM.openDrawer(body);
  },

  async acceptFromForm() {
    const T = CO_ENGRAM_T;
    const p = CO_ENGRAM._currentProposal;
    if (!p) return;
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
      const engramId = r && r.engramId ? r.engramId : '';
      alert(T.t('viewer.proposals.acceptedToast') + (engramId ? '\\n' + T.t('viewer.proposals.createdEngramToast', { id: engramId }) : ''));
    } catch (e) { alert(T.t('viewer.proposals.acceptFailed', { err: (e.message || e) })); }
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
  }
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
    + '<option value="">' + T.t('viewer.audit.actorAll') + '</option><option value="user">' + T.t('viewer.audit.actorUser') + '</option><option value="llm">' + T.t('viewer.audit.actorLlm') + '</option><option value="system">' + T.t('viewer.audit.actorSystem') + '</option></select></label>'
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
      // 并行:audit 走 paginator + engrams 直接拿 id 集(后者判断 engramId 是否仍存在)
      [engramsData] = await Promise.all([
        CO_ENGRAM._auditPager.load(),
        CO_ENGRAM.apiGet('/api/engrams?limit=500').catch(() => ({ results: [] })),
      ]);
    } catch (e) { tl.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>'; return; }

    const lastResp = CO_ENGRAM._auditPager.getLastResponse();
    if (lastResp && lastResp.enabled === false) {
      tl.innerHTML = '<div class="empty"><div class="icon">💤</div>' + T.t('viewer.audit.disabledHint') + '</div>';
      return;
    }
    this._existingIds = new Set((engramsData.results || []).map(e => e.id));
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
      tl.innerHTML = '<div class="empty"><div class="icon">—</div>' + CO_ENGRAM_T.t('viewer.audit.empty') + '</div>';
      return;
    }

    const ACTOR_LETTER = { user: 'U', llm: 'L', system: 'S' };
    let html = filtered.slice(0, 300).map(e => {
      return CO_ENGRAM_AUDIT.renderRow(e, ACTOR_LETTER);
    }).join('');
    if (filtered.length > 300) {
      html += '<div class="muted" style="text-align:center;padding:0.5rem">仅显示前 300 条过滤结果(共 ' + filtered.length + ' 条匹配,加载更多可扩大范围)</div>';
    }
    if (CO_ENGRAM._auditPager && CO_ENGRAM._auditPager.hasMore()) {
      const items = CO_ENGRAM._auditPager.getItems();
      const total = CO_ENGRAM._auditPager.getTotal();
      html += '<div class="load-more-row" style="text-align:center;padding:1rem 0">'
        + '<button class="btn" onclick="CO_ENGRAM_AUDIT.loadMore()">加载更多(已加载 ' + items.length + ' / 共 ' + total + ')</button></div>';
    }
    tl.innerHTML = html;
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
  renderRow(e, ACTOR_LETTER) {
    const T = CO_ENGRAM_T;
    const ts = CO_ENGRAM.relativeTime(e.ts);
    const tsFull = CO_ENGRAM.escapeHtml(e.ts);
    const cls = CO_ENGRAM.auditActionClass(e.action);
    const actorLetter = ACTOR_LETTER[e.actor] || '?';
    const actorTipKey = 'viewer.audit.actorTip.' + (e.actor || '');
    const actorTip = T.t(actorTipKey) === actorTipKey ? (e.actor || '') : T.t(actorTipKey);
    const actionTipKey = 'viewer.audit.actionTip.' + (e.action || '');
    const actionTip = T.t(actionTipKey) === actionTipKey ? (e.action || '') : T.t(actionTipKey);

    const existing = this._existingIds || new Set();
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
      + '<button type="button" class="' + actionBtnClass + '" title="' + CO_ENGRAM.escapeHtml(actionTip) + T.t('viewer.audit.filterActionHint') + '" onclick="CO_ENGRAM_AUDIT.filterByAction(\\'' + CO_ENGRAM.escapeHtml(e.action) + '\\')">' + CO_ENGRAM.escapeHtml(e.action) + '</button>'
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
      '<div class="bar-track"><div class="bar-fill" style="width:' + (max ? (count / max * 100).toFixed(1) : 0) + '%;background:' + (color || '#5eead4') + '"></div></div>' +
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
        html += bar(name, count, max, '#5eead4');
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
  async render(root) {
    const T = CO_ENGRAM_T;
    root.innerHTML = '<div class="loading">' + T.t('viewer.loading.trash') + '</div>';
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/trash'); }
    catch (e) { root.innerHTML = '<div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>'; return; }

    const items = data.results || [];
    if (!items.length) {
      root.innerHTML = '<div class="empty"><div class="icon">🗑️</div>' + T.t('viewer.trash.empty') + '</div>';
      return;
    }
    // 顶部工具栏:统计 + 分区筛选 + 一键清空
    const partitions = [...new Set(items.map((t) => t.partition).filter(Boolean))].sort();
    const total = items.length;
    let html = '<div class="card" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:1rem">'
      + '<strong style="margin-right:auto">' + T.t('viewer.trash.titleCount', { n: total }) + '</strong>';
    if (partitions.length > 1) {
      html += '<label style="font-weight:normal;font-size:0.9rem">' + T.t('viewer.trash.partitionLabel')
        + '<select id="trash-partition-filter" onchange="CO_ENGRAM_TRASH.applyFilter()" style="margin-left:0.4rem">'
        + '<option value="">' + T.t('viewer.trash.all') + '</option>'
        + partitions.map((p) => '<option value="' + CO_ENGRAM.escapeHtml(p) + '">' + CO_ENGRAM.escapeHtml(p) + '</option>').join('')
        + '</select></label>';
    }
    html += '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.purgeAll(false)">' + T.t('viewer.trash.purgeAllBtn') + '</button>'
      + '</div>';

    html += '<table class="data-table" id="trash-table"><thead><tr>'
      + '<th>' + T.t('viewer.trash.colId') + '</th><th>' + T.t('viewer.trash.colPartition') + '</th><th>' + T.t('viewer.trash.colTrashedAt') + '</th><th></th>'
      + '</tr></thead><tbody>';
    for (const t of items) {
      const part = t.partition || '';
      html += '<tr data-partition="' + CO_ENGRAM.escapeHtml(part) + '">'
        + '<td><code>' + CO_ENGRAM.escapeHtml(t.id) + '</code></td>'
        + '<td>' + CO_ENGRAM.escapeHtml(t.partition || '—') + '</td>'
        + '<td>' + CO_ENGRAM.escapeHtml(t.trashedAt || '—') + '</td>'
        + '<td>'
        + '<button class="btn-link" onclick="CO_ENGRAM_TRASH.preview(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">' + T.t('viewer.trash.previewBtn') + '</button> '
        + '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.restore(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">' + T.t('viewer.trash.restoreBtn') + '</button>'
        + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
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

  // 预览单条回收站内容(只读 drawer)
  async preview(id) {
    const T = CO_ENGRAM_T;
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/trash/' + encodeURIComponent(id)); }
    catch (e) { alert(T.t('viewer.common.loadFailed', { err: e.message || String(e) })); return; }

    const fm = d.frontmatter || {};
    const kind = fm.kind ? T.enumLabel('kind', fm.kind) : '';
    const status = fm.status ? T.enumLabel('status', fm.status) : '';
    const source = fm.sourceType ? T.enumLabel('sourceType', fm.sourceType) : '';

    const body = '<div class="warn-banner" style="padding:0.6rem 0.8rem;margin-bottom:0.8rem">'
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
      + '<div class="field"><span class="field-label">' + T.t('viewer.trash.partitionField') + '</span>' + CO_ENGRAM.escapeHtml(d.partition || '—')
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
    let preview;
    try {
      const url = '/api/trash?dryRun=1' + (part ? '&partition=' + encodeURIComponent(part) : '');
      preview = await CO_ENGRAM.apiGet(url);
    } catch (e) { alert(T.t('viewer.trash.prescanFailed', { err: e.message || String(e) })); return; }

    const n = preview.count || 0;
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

  // 统计快览
  if (snap.stats) {
    html += '<div class="kpi-grid" style="margin-top:1rem">'
      + '<div class="kpi"><div class="kpi-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.stats.total')) + '</div><div class="kpi-value">' + (snap.stats.total ?? 0) + '</div></div>'
      + '<div class="kpi"><div class="kpi-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.stats.archived')) + '</div><div class="kpi-value">' + (snap.stats.archived ?? 0) + '</div></div>'
      + '<div class="kpi"><div class="kpi-label">' + CO_ENGRAM.escapeHtml(T.t('viewer.health.stats.forgotten')) + '</div><div class="kpi-value">' + (snap.stats.forgotten ?? 0) + '</div></div>'
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
    const HOST_SUPPORTS_RESTART = !isPlugin;

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
    html += '<div class="info-banner" style="margin-bottom:.8rem">' + T.t('viewer.config.runtimeSection.hint', { host: HOST_LABEL }) + (HOST_SUPPORTS_RESTART ? '' : T.t('viewer.config.runtimeSection.openclawExtra')) + '</div>';
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
    const id = CO_ENGRAM.escapeHtml(d.id);
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
      + '<div class="field"><span class="field-label">' + T.t('viewer.synapses.idField') + '</span><code>' + id + '</code></div>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.detail.sourceToTargetField') + '</span><span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.from) + '">' + CO_ENGRAM.escapeHtml(d.from) + '</span> → <span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.to) + '">' + CO_ENGRAM.escapeHtml(d.to) + '</span></div>'
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
    const dirKeys = ['directional', 'bidirectional'];
    const dirOptions = dirKeys.map(k => '<option value="' + k + '"' + (d.direction === k ? ' selected' : '') + CO_ENGRAM.tip('synapseDirection.' + k) + '>' + (T.enumLabel('synapseDirection', k) || k) + '</option>').join('');

    const body = '<div class="edit-banner"><strong>' + T.t('viewer.common.editMode') + '</strong> · ' + T.t('viewer.detail.editModeHint') + '</div>'
      + '<h2>' + T.t('viewer.detail.editSynapseTitle') + '</h2>'
      + '<div class="field"><span class="field-label">' + T.t('viewer.synapses.idField') + '</span><code>' + CO_ENGRAM.escapeHtml(d.id) + '</code></div>'
      + '<div class="warn-banner">' + T.t('viewer.synapses.kindChangeHint') + '</div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + T.t('viewer.detail.kindLabel') + '</label><select id="sf-kind"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>' + T.t('viewer.detail.directionField').replace(/:$/, '') + '</label><select id="sf-direction"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>' + dirOptions + '</select></div>'
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
    const nextDirection = document.getElementById('sf-direction').value;
    const patch = {
      weight: Number(document.getElementById('sf-weight').value),
      direction: nextDirection
    };
    // 仅当 kind/direction 变化时传 kind(避免无谓的删除+重建)
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
      + '<li>' + T.t('viewer.help.tabGraph') + '</li>'
      + '<li>' + T.t('viewer.help.tabProposals') + '</li>'
      + '<li>' + T.t('viewer.help.tabAudit') + '</li>'
      + '<li>' + T.t('viewer.help.tabTrash') + '</li>'
      + '<li>' + T.t('viewer.help.tabConfig') + '</li>'
      + '</ul>'

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
`;
