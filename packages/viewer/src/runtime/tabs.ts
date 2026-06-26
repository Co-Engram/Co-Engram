/**
 * Viewer v2 runtime — stats / engrams / proposals / audit / trash / config 六个 tab。
 * Graph tab 单独在 graph.ts(需要 vis-network)。
 *
 * @module @co-engram/claude-code/viewer/runtime/tabs
 */

export const TABS_RUNTIME = `
// ============================================================
// 全局映射表(中文标签)
// ============================================================
window.CO_ENGRAM_LABELS = {
  kind: { fact: '事实', observation: '观察', pattern: '模式', procedure: '流程', hypothesis: '假设' },
  status: { active: '活跃', dormant: '休眠', forgotten: '已遗忘', archived: '已归档' },
  freshness: { stable: '稳定', recent: '近期', fading: '衰减', stale: '过时' },
  visibility: { public: '公开', team: '团队', private: '私有', restricted: '受限' },
  emotionalValence: { positive: '积极', negative: '消极', neutral: '中性' },
  sourceType: { firsthand: '一手', secondhand: '二手', inferred: '推断' },
  verification: { unverified: '未验证', plausible: '貌似成立', probable: '较可能', verified: '已验证', refuted: '已反驳' },
  synapse: {
    extends: '扩展', part_of: '部分', similar_to: '相似',
    depends_on: '依赖', causes: '导致', follows: '跟随',
    derives_from: '派生', contradicts: '矛盾', exemplifies: '例证',
    supersedes: '取代', consolidates: '整合',
    contextualizes: '上下文'
  },
  synapseDirection: { directional: '单向', bidirectional: '双向' },
  resolution: { pending: '待处理', auto_resolved: '已自动裁决', escalated: '已升级', contested: '有争议', resolved: '已解决' }
};

// ============================================================
// Stats
// ============================================================
CO_ENGRAM.on('stats', async function() {
  const el = document.getElementById('stats-content');
  if (!el) return;
  if (CO_ENGRAM._statsLoaded) return;
  el.innerHTML = '<div class="loading">加载统计中</div>';
  let data;
  try { data = await CO_ENGRAM.apiGet('/api/stats'); }
  catch (e) { el.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

  const L = CO_ENGRAM_LABELS;
  const SYNAPSE_LABEL = {
    extends: '扩展', part_of: '部分', similar_to: '相似',
    depends_on: '依赖', causes: '导致', follows: '跟随',
    derives_from: '派生', contradicts: '矛盾', exemplifies: '例证',
    supersedes: '取代', consolidates: '整合',
    contextualizes: '上下文'
  };

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
    + kpiClickable('记忆印迹总数', data.totalEngrams || 0, '点击查看全部', 'engrams')
    + kpiClickable('记忆突触总数', data.totalSynapses || 0, '点击查看图谱', 'graph')
    + kpiClickable('待审提案', data.pendingProposals || 0, '点击处理', 'proposals')
    + '</div>';

  // 记忆印迹区(独立一块)
  html += '<div class="card" style="margin-top:1.25rem"><h3 class="section-title"' + CO_ENGRAM.tip('kind.fact') + '>记忆印迹 · 按类型分布</h3>';
  if (!kindKeys.length) html += '<div class="empty">暂无数据</div>';
  else kindKeys.forEach(k => html += barRow(L.kind[k] || k, kindMap[k], kindMax, CO_ENGRAM.kindColor(k), 'CO_ENGRAM.showTab(\\'engrams\\')', CO_ENGRAM.tip('kind.' + k)));
  html += '</div>';

  html += '<div class="card" style="margin-top:1rem"><h3 class="section-title"' + CO_ENGRAM.tip('status.active') + '>记忆印迹 · 按状态分布</h3>';
  if (!statusKeys.length) html += '<div class="empty">暂无数据</div>';
  else statusKeys.forEach(k => html += barRow(L.status[k] || k, statusMap[k], statusMax, '#94a3b8', '', CO_ENGRAM.tip('status.' + k)));
  html += '</div>';

  // 记忆突触区(独立一块,与印迹分开)
  html += '<div class="card" style="margin-top:1rem"><h3 class="section-title"' + CO_ENGRAM.tip('family.structural') + '>记忆突触 · 按类型分布</h3>';
  if (!synKindKeys.length) html += '<div class="empty">暂无突触</div>';
  else synKindKeys.forEach(k => html += barRow(SYNAPSE_LABEL[k] || k, synKindMap[k], synKindMax, CO_ENGRAM.edgeColor(k), 'CO_ENGRAM.showTab(\\'graph\\')', CO_ENGRAM.tip('synapse.' + k)));
  html += '</div>';

  // 贡献者排名
  if (contribArr.length) {
    html += '<div class="card" style="margin-top:1rem"><h3 class="section-title">贡献者排名 · 印迹 + 突触合计</h3>';
    html += '<table class="data-table"><thead><tr><th>#</th><th>贡献者</th><th>印迹</th><th>突触</th><th style="width:35%">合计</th></tr></thead><tbody>';
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
    html += '<div class="card" style="margin-top:1rem"><h3 class="section-title">高频领域标签</h3>';
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
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/engrams'); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    const all = data.results || [];
    CO_ENGRAM._engramsCache = all;
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
      + '<span class="spacer"></span>'
      + '<div class="view-toggle" role="group" aria-label="' + CO_ENGRAM.escapeHtml(T.t('engrams.view.card') + ' / ' + T.t('engrams.view.tree')) + '">'
      + '<button class="tab' + (CO_ENGRAM._engramsViewMode === 'card' ? ' active' : '') + '" onclick="CO_ENGRAM_ENGRAMS.setView(\\'card\\')">' + CO_ENGRAM.escapeHtml(T.t('engrams.view.card')) + '</button>'
      + '<button class="tab' + (CO_ENGRAM._engramsViewMode === 'tree' ? ' active' : '') + '" onclick="CO_ENGRAM_ENGRAMS.setView(\\'tree\\')">' + CO_ENGRAM.escapeHtml(T.t('engrams.view.tree')) + '</button>'
      + '</div>'
      + '<span class="chip" id="engrams-count">' + CO_ENGRAM.escapeHtml(T.t('engrams.countTotal', { n: all.length })) + '</span>'
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
    const cache = CO_ENGRAM._engramsCache || [];
    const q = ((document.getElementById('engrams-q') || {}).value || '').toLowerCase();
    const kind = (document.getElementById('engrams-kind') || {}).value || '';
    const sort = ((document.getElementById('engrams-sort') || {}).value || 'createdAt-desc').split('-');
    const [sortKey, sortDir] = sort;
    const T = CO_ENGRAM_T;
    const mode = CO_ENGRAM._engramsViewMode || 'card';

    let filtered = cache.filter(e => {
      if (kind && e.kind !== kind) return false;
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
    const countEl = document.getElementById('engrams-count');
    if (countEl) countEl.textContent = T.t('engrams.countFiltered', { shown: filtered.length, total: cache.length });

    if (!filtered.length) {
      body.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + CO_ENGRAM.escapeHtml(T.t('engrams.empty')) + '</div>';
      return;
    }

    if (mode === 'tree') {
      // 目录视图:按 domainTags[0] 或 kind 分组
      CO_ENGRAM_ENGRAMS._renderTree(filtered, body);
      return;
    }

    // 卡片视图
    body.innerHTML = '<div class="grid cols-3">' + filtered.map(e => {
      const tags = (e.domainTags || []).slice(0, 4)
        .map(t => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ');
      const more = (e.domainTags || []).length > 4 ? '<span class="chip">+' + ((e.domainTags || []).length - 4) + '</span>' : '';
      const kindTip = CO_ENGRAM.tip('kind.' + e.kind);
      const createdCell = e.createdAt
        ? '<span title="' + CO_ENGRAM.escapeHtml(e.createdAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(e.createdAt)) + '</span>'
        : '';
      return '<div class="card">'
        + '<div class="card-title" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(e.id) + '\\')">' + CO_ENGRAM.escapeHtml(e.title) + '</div>'
        + '<div><span class="chip kind-' + e.kind + '"' + kindTip + '>' + CO_ENGRAM.escapeHtml(T.enumLabel('kind', e.kind)) + '</span> '
        + CO_ENGRAM.importanceBar(e.importance) + '</div>'
        + '<div class="card-meta">'
        + (e.retrievalCount != null ? '<span' + CO_ENGRAM.tip('retrievalCount') + '>' + CO_ENGRAM.escapeHtml(T.t('engrams.retrievalsCount', { n: e.retrievalCount })) + '</span>' : '')
        + createdCell
        + '</div>'
        + (tags ? '<div class="card-meta">' + tags + more + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
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

    // 价值评估段(emotionalValence + sourceType + verificationStatus + 衰退进度 + 强化信号)
    const valence = d.emotionalValence;
    const valenceLine = valence
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('emotionalValence.' + valence) + '>' + T.fieldLabel('emotionalValence') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('emotionalValence', valence)) + '</div>'
      : '';
    const source = d.sourceType;
    const sourceLine = source
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('sourceType.' + source) + '>' + T.fieldLabel('sourceType') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('sourceType', source)) + '</div>'
      : '';
    const verif = d.verificationStatus;
    const verifLine = verif
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('verification.' + verif) + '>' + T.fieldLabel('verificationStatus') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('verificationStatus', verif)) + '</div>'
      : '';

    // 衰退进度段(替代固定半衰期显示)
    const hasHalfLife = d.decayHalfLifeDays !== undefined && d.decayHalfLifeDays !== null;
    const decay = hasHalfLife ? D.computeDecayState(d.lastEffectiveAt, d.decayHalfLifeDays) : null;
    const decayLine = hasHalfLife
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('decayHalfLifeDays') + '>' + T.fieldLabel('decayProgress') + '</span><div class="decay-block">' + D.renderDecayBar(decay, d.decayHalfLifeDays) + '</div></div>'
      : '';

    const evidenceLine = d.evidenceCount !== undefined
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('evidenceCount') + '>' + T.fieldLabel('evidenceCount') + '</span>' + (d.evidenceCount || 0) + '</div>'
      : '';
    const lastEffLine = d.lastEffectiveAt
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('lastEffectiveAt') + '>' + T.fieldLabel('lastEffective') + '</span><span title="' + CO_ENGRAM.escapeHtml(d.lastEffectiveAt) + '">' + CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(d.lastEffectiveAt)) + '</span></div>'
      : '';
    const scoreLine = (d.reinforcementScore !== undefined && d.reinforcementScore !== 0)
      ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('reinforcementScore') + '>' + T.fieldLabel('reinforcementScore') + '</span>' + (d.reinforcementScore || 0).toFixed(2) + '</div>'
      : '';
    const valueSection = (valenceLine || sourceLine || verifLine || decayLine || evidenceLine || lastEffLine || scoreLine)
      ? '<h3>' + T.sectionLabel('valueAssessment') + '</h3>' + valenceLine + sourceLine + verifLine + decayLine + evidenceLine + lastEffLine + scoreLine
      : '';

    // 多维重要性段(可选)
    const iv = d.importanceVector;
    const ivSection = iv
      ? '<h3' + CO_ENGRAM.tip('importanceVector') + '>' + T.sectionLabel('multiDimImportance') + '</h3>'
        + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('importanceDim.personal') + '>个人:</span>' + (iv.personal || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.team') + '>团队:</span>' + (iv.team || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.project') + '>项目:</span>' + (iv.project || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.network') + '>网络:</span>' + (iv.network || 0).toFixed(2)
        + ' <span class="field-label"' + CO_ENGRAM.tip('importanceDim.temporal') + '>时间:</span>' + (iv.temporal || 0).toFixed(2)
        + ' <span class="field-label">复合:</span>' + (iv.composite || 0).toFixed(2) + '</div>'
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
      + CO_ENGRAM.importanceBar(d.importance) + ' <span class="kpi-sub"' + CO_ENGRAM.tip('importance') + '>' + T.fieldLabel('importance') + ' ' + (d.importance || 0).toFixed(2) + '</span></div>'
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
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('confidence') + '>' + T.fieldLabel('confidence') + '</span>' + (d.confidence || 0).toFixed(2)
      + ' <span class="field-label"' + CO_ENGRAM.tip('status.' + (d.status || 'active')) + '>' + T.fieldLabel('status') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('status', d.status))
      + ' <span class="field-label"' + CO_ENGRAM.tip('freshness.' + (d.freshness || 'fresh')) + '>' + T.fieldLabel('freshness') + '</span>' + CO_ENGRAM.escapeHtml(T.enumLabel('freshness', d.freshness)) + '</div>'
      + valueSection
      + ivSection
      + encSection;
    CO_ENGRAM.openDrawer(body);
  },

  edit() {
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    const L = CO_ENGRAM_LABELS;
    const id = CO_ENGRAM.escapeHtml(d.id);
    const kindOptions = Object.keys(L.kind).map(k => '<option value="' + k + '"' + (d.kind === k ? ' selected' : '') + CO_ENGRAM.tip('kind.' + k) + '>' + L.kind[k] + '</option>').join('');
    const visOptions = Object.keys(L.visibility).map(v => '<option value="' + v + '"' + (d.visibility === v ? ' selected' : '') + CO_ENGRAM.tip('visibility.' + v) + '>' + L.visibility[v] + '</option>').join('');

    const body = '<div class="edit-banner"><strong>编辑模式</strong> · 修改后点击"保存"提交</div>'
      + '<h2>编辑记忆印迹</h2>'
      + '<div class="field"><span class="field-label">ID:</span><code>' + id + '</code></div>'
      + '<div class="field"><label class="field-label">标题</label><input id="ef-title" type="text" value="' + CO_ENGRAM.escapeHtml(d.title || '') + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('kind.fact') + '>类型</label><select id="ef-kind"' + CO_ENGRAM.tip('kind.fact') + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('importance') + '>重要性 (0-1,可拖动滑块)</label><input id="ef-importance-range" type="range" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance\\').value=this.value"><input id="ef-importance" type="number" min="0" max="1" step="0.01" value="' + (d.importance || 0) + '" oninput="document.getElementById(\\'ef-importance-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('confidence') + '>置信度 (0-1,可拖动滑块)</label><input id="ef-confidence-range" type="range" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence\\').value=this.value"><input id="ef-confidence" type="number" min="0" max="1" step="0.01" value="' + (d.confidence || 0) + '" oninput="document.getElementById(\\'ef-confidence-range\\').value=this.value" style="width:80px;margin-left:0.5rem"></div>'
      + '<div class="field"><label class="field-label">领域标签(逗号分隔)</label><input id="ef-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.domainTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label">上下文标签(逗号分隔)</label><input id="ef-ctx-tags" type="text" value="' + CO_ENGRAM.escapeHtml((d.contextTags || []).join(', ')) + '"></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('visibility.public') + '>可见性</label><select id="ef-visibility"' + CO_ENGRAM.tip('visibility.public') + '>' + visOptions + '</select></div>'
      + '<div class="field"><label class="field-label">内容(Markdown) '
      + '<button type="button" class="btn secondary mini" id="ef-preview-toggle" onclick="CO_ENGRAM_ENGRAMS.togglePreview()">预览</button>'
      + '<span id="ef-content-mode" class="kpi-sub">编辑模式</span></label>'
      + '<textarea id="ef-content" rows="12">' + CO_ENGRAM.escapeHtml(d.content || '') + '</textarea>'
      + '<div id="ef-content-preview" class="markdown-body" style="display:none;margin-top:0.5rem"></div></div>'
      + '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_ENGRAMS.cancel()">取消</button>'
      + '<button class="btn" onclick="CO_ENGRAM_ENGRAMS.save()">保存</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  togglePreview() {
    const ta = document.getElementById('ef-content');
    const preview = document.getElementById('ef-content-preview');
    const toggleBtn = document.getElementById('ef-preview-toggle');
    const modeLabel = document.getElementById('ef-content-mode');
    if (!ta || !preview || !toggleBtn || !modeLabel) return;
    if (ta.style.display === 'none') {
      // 当前是预览,切回编辑
      ta.style.display = '';
      preview.style.display = 'none';
      toggleBtn.textContent = '预览';
      modeLabel.textContent = '编辑模式';
    } else {
      // 当前是编辑,切到预览
      preview.innerHTML = CO_ENGRAM.renderMarkdown(ta.value);
      ta.style.display = 'none';
      preview.style.display = '';
      toggleBtn.textContent = '编辑';
      modeLabel.textContent = '预览模式';
    }
  },

  cancel() {
    const d = CO_ENGRAM._currentEngram;
    if (d) this._renderView(d);
  },

  async save() {
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
      // 刷新列表缓存
      try {
        const data = await CO_ENGRAM.apiGet('/api/engrams');
        CO_ENGRAM._engramsCache = data.results || [];
        this.applyFilter();
      } catch {}
    } catch (e) { alert('保存失败:' + (e.message || e)); }
  },

  async confirmDelete() {
    const d = CO_ENGRAM._currentEngram;
    if (!d) return;
    if (!confirm('确定要删除"' + (d.title || d.id) + '"?\\n此操作不可撤销。')) return;
    try {
      await CO_ENGRAM.apiJson('/api/engrams/' + encodeURIComponent(d.id), 'DELETE', null);
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._currentEngram = null;
      // 重新加载列表
      const root = document.getElementById('engrams-content');
      if (root) {
        CO_ENGRAM._engramsLoaded = false;
        CO_ENGRAM._engramsCache = null;
        await CO_ENGRAM_ENGRAMS.render(root);
      }
    } catch (e) { alert('删除失败:' + (e.message || e)); }
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
    root.innerHTML = '<div class="loading">加载提案中</div>';
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/proposals?status=all'); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    if (data.enabled === false) {
      root.innerHTML = '<div class="empty"><div class="icon">💤</div>提案引擎未启用。设置环境变量 CO_ENGRAM_PROPOSALS_ENABLED=1 可开启。</div>';
      return;
    }

    const all = data.results || [];
    CO_ENGRAM._proposalsCache = all;
    this._setStatus('pending');
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
      // 取首句作为标题。正则字面量里的换行转义在模板字符串里必须双重转义,
      // 否则被当成字符串级 escape,变成真实换行符,破坏正则语法。
      const firstClause = title.split(/[。.!?\\n??;；]/)[0].trim();
      title = firstClause || title;
      if (title.length > 50) title = title.slice(0, 50) + '…';
    }
    if (!title) title = p.entityId;

    return { title, kind };
  },

  _setStatus(status) {
    const cache = CO_ENGRAM._proposalsCache || [];
    const filtered = status === 'all' ? cache : cache.filter(p => p.status === status);
    const root = document.getElementById('proposals-content');
    if (!root) return;

    const L = CO_ENGRAM_LABELS;
    const STATUS_LABEL = { pending: '待审', accepted: '已采纳', dismissed: '已驳回', all: '全部' };

    const buttons = (current) => ['pending', 'accepted', 'dismissed', 'all'].map(s =>
      '<button class="tab ' + (s === current ? 'active' : '') + '" onclick="CO_ENGRAM_PROPOSALS._setStatus(\\'' + s + '\\')">'
      + STATUS_LABEL[s] + ' (' + (s === 'all' ? cache.length : cache.filter(p => p.status === s).length) + ')</button>'
    ).join('');

    let html = '<div style="margin-bottom:1rem">' + buttons(status) + '</div>';
    if (!filtered.length) {
      html += '<div class="empty"><div class="icon">✓</div>没有 ' + STATUS_LABEL[status] + ' 提案</div>';
    } else {
      html += '<div class="grid cols-3">';
      for (const p of filtered) {
        const meta = this._inferMeta(p);
        const kindLabel = (L.kind && L.kind[meta.kind]) || meta.kind;
        const preview = (p.centroidExcerpt || (p.sampleQuotes || [])[0] || '').toString();
        const previewClip = preview.length > 120 ? preview.slice(0, 120) + '…' : preview;
        const cardClick = p.status === 'pending'
          ? ' style="cursor:pointer" onclick="CO_ENGRAM_PROPOSALS.open(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')"'
          : ' style="cursor:pointer" onclick="CO_ENGRAM_PROPOSALS.open(\\'' + CO_ENGRAM.escapeHtml(p.entityId) + '\\')"';

        html += '<div class="card"' + cardClick + '>'
          + '<div class="card-title" title="' + CO_ENGRAM.escapeHtml(p.entityId) + '">' + CO_ENGRAM.escapeHtml(meta.title) + '</div>';
        html += '<div class="card-meta" style="margin-bottom:0.4rem">'
          + '<span class="chip kind-' + meta.kind + '">' + CO_ENGRAM.escapeHtml(kindLabel) + '</span>'
          + '<span>×' + (p.occurrences || 0) + '</span>'
          + (p.createdAt ? '<span>' + CO_ENGRAM.relativeTime(p.createdAt) + '</span>' : '')
          + '<span class="chip">' + (STATUS_LABEL[p.status] || p.status) + '</span>'
          + '</div>';
        if (previewClip) html += '<div style="font-size:0.8rem;color:var(--fg-muted);margin-bottom:0.4rem">' + CO_ENGRAM.escapeHtml(previewClip) + '</div>';
        if (p.status === 'accepted' && p.acceptedEngramId) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(16,185,129,.12);color:var(--accent)">已转 ▸ ' + CO_ENGRAM.escapeHtml(p.acceptedEngramId.slice(0, 12)) + '</span></div>';
        }
        if (p.status === 'dismissed' && p.dismissReason) {
          html += '<div class="card-meta"><span class="chip" style="background:rgba(239,68,68,.12);color:#ef4444">驳回:' + CO_ENGRAM.escapeHtml((p.dismissReason || '').slice(0, 40)) + '</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    root.innerHTML = html;
  },

  /**
   * 打开 proposal 详情 drawer,提供完整编辑表单。
   * 用户可以在这里调整 title/kind/content/domainTags,然后 Accept 或 Dismiss。
   * 替代原来 prompt() 的简陋交互。
   */
  open(entityId) {
    const cache = CO_ENGRAM._proposalsCache || [];
    const p = cache.find(x => x.entityId === entityId);
    if (!p) { CO_ENGRAM.openDrawer('<div class="empty">提案未找到:' + CO_ENGRAM.escapeHtml(entityId) + '</div>'); return; }
    CO_ENGRAM._currentProposal = p;

    const L = CO_ENGRAM_LABELS;
    const meta = this._inferMeta(p);
    const samples = (p.sampleQuotes || []).map(s => '<pre class="pre-compact" style="margin:0.3rem 0">' + CO_ENGRAM.escapeHtml(s) + '</pre>').join('');
    const kindOptions = Object.keys(L.kind || {}).map(k =>
      '<option value="' + k + '"' + (meta.kind === k ? ' selected' : '') + '>' + (L.kind[k] || k) + '</option>'
    ).join('');

    const accepted = p.status === 'accepted';
    const dismissed = p.status === 'dismissed';
    const editable = p.status === 'pending';

    let actionBtns = '';
    if (editable) {
      actionBtns = '<div class="config-save-bar">'
        + '<button class="btn secondary" onclick="CO_ENGRAM_PROPOSALS.dismissFromForm()">驳回</button>'
        + '<button class="btn" onclick="CO_ENGRAM_PROPOSALS.acceptFromForm()">采纳并保存</button>'
        + '</div>';
    } else {
      actionBtns = '<div class="edit-banner">该提案当前状态:<strong>' + (L.status && L.status[p.status] || p.status) + '</strong>'
        + (accepted && p.acceptedEngramId ? '<br>已创建记忆印迹:<code>' + CO_ENGRAM.escapeHtml(p.acceptedEngramId) + '</code>' : '')
        + (dismissed && p.dismissedUntil ? '<br>驳回至:' + CO_ENGRAM.escapeHtml(p.dismissedUntil) : '')
        + '</div>';
    }

    const body = '<div class="edit-banner" style="display:flex;gap:0.5rem;align-items:center">'
      + '<strong style="margin-right:auto">候选提案详情</strong>'
      + '<code style="font-size:0.75rem">' + CO_ENGRAM.escapeHtml(p.entityId) + '</code>'
      + '</div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">标题' + (editable ? '' : ' (只读)') + '</label>'
      + '<input id="pf-title" type="text" value="' + CO_ENGRAM.escapeHtml(meta.title) + '"' + (editable ? '' : ' readonly') + '></div>'
      + '<div class="field"'
      + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label"' + CO_ENGRAM.tip('kind.fact') + '>类型' + (editable ? '' : ' (只读)') + '</label>'
      + '<select id="pf-kind"' + (editable ? '' : ' disabled') + '>' + kindOptions + '</select></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">领域标签(逗号分隔)' + (editable ? '' : ' (只读)') + '</label>'
      + '<input id="pf-tags" type="text" placeholder="如:frontend, dark-mode, css"' + (editable ? '' : ' readonly') + '></div>'
      + '<div class="field"' + (editable ? '' : ' style="opacity:0.6"') + '>'
      + '<label class="field-label">内容(转成记忆印迹的正文)' + (editable ? '' : ' (只读)') + '</label>'
      + '<textarea id="pf-content" rows="6"' + (editable ? '' : ' readonly') + '>' + CO_ENGRAM.escapeHtml(p.centroidExcerpt || '') + '</textarea></div>'
      + '<h3>样本引用(' + (p.occurrences || 0) + ' 次累积)</h3>'
      + (samples || '<div class="empty" style="padding:1rem">(无样本)</div>')
      + '<div class="field"><span class="field-label">首次见到:</span>' + CO_ENGRAM.escapeHtml(p.firstSeenAt || '—')
      + ' <span class="field-label">最后见到:</span>' + CO_ENGRAM.escapeHtml(p.lastSeenAt || '—') + '</div>'
      + actionBtns;

    CO_ENGRAM.openDrawer(body);
  },

  async acceptFromForm() {
    const p = CO_ENGRAM._currentProposal;
    if (!p) return;
    const title = (document.getElementById('pf-title').value || '').trim();
    const content = (document.getElementById('pf-content').value || '').trim();
    const kind = document.getElementById('pf-kind').value;
    const tags = (document.getElementById('pf-tags').value || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!title) { alert('请填写标题'); return; }
    if (!content) { alert('请填写内容'); return; }
    try {
      const r = await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/accept', 'POST', { title, content, kind, domainTags: tags });
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
      const engramId = r && r.engramId ? r.engramId : '';
      alert('✓ 已采纳' + (engramId ? '\\n创建记忆印迹:' + engramId : ''));
    } catch (e) { alert('采纳失败:' + (e.message || e)); }
  },

  async dismissFromForm() {
    const p = CO_ENGRAM._currentProposal;
    if (!p) return;
    const reason = prompt('驳回理由(可选):', '') || '';
    const daysStr = prompt('驳回 N 天(默认 30):', '30') || '30';
    const dismissDays = Number(daysStr) || 30;
    try {
      await CO_ENGRAM.apiJson('/api/proposals/' + encodeURIComponent(p.entityId) + '/dismiss', 'POST', { reason, dismissDays });
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._proposalsLoaded = false;
      await this.render(document.getElementById('proposals-content'));
    } catch (e) { alert('驳回失败:' + (e.message || e)); }
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

  const filterBar = '<div class="filter-bar">'
    + '<label>发起者 <select id="audit-actor" onchange="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<option value="">全部</option><option value="user">用户</option><option value="llm">LLM</option><option value="system">系统</option></select></label>'
    + '<label>类别 <select id="audit-cat" onchange="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<option value="">全部</option>'
    + '<option value="state">状态变更</option>'
    + '<option value="effective">有效性</option>'
    + '<option value="contradicted">矛盾</option>'
    + '<option value="proposal">提案</option></select></label>'
    + '<input type="search" id="audit-engram" placeholder="按记忆印迹编号过滤..." oninput="CO_ENGRAM_AUDIT.applyFilter()">'
    + '<span class="chip removable audit-action-chip" id="audit-action-chip" style="display:none" title="点击清除 action 过滤" onclick="CO_ENGRAM_AUDIT.clearActionFilter()"></span>'
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
    const tl = document.getElementById('audit-timeline');
    if (!tl) return;
    tl.innerHTML = '<div class="loading">加载审计日志中</div>';
    let data, engramsData;
    try {
      // 并行拉 audit + engrams(后者用来判断 engramId 是否仍存在,决定显示可点 chip 还是灰色)
      [data, engramsData] = await Promise.all([
        CO_ENGRAM.apiGet('/api/audit?limit=500'),
        CO_ENGRAM.apiGet('/api/engrams?limit=10000').catch(() => ({ results: [] })),
      ]);
    } catch (e) { tl.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    if (data.enabled === false) {
      tl.innerHTML = '<div class="empty"><div class="icon">💤</div>审计日志未启用。</div>';
      return;
    }
    this._existingIds = new Set((engramsData.results || []).map(e => e.id));
    this._cache = (data.results || []).slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
    this._renderStats();
    this.applyFilter();
  },

  _renderStats() {
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
    el.innerHTML = kpi('总计', cache.length, 'var(--fg)')
      + kpi('状态变更', cat.state, '#3b82f6')
      + kpi('有效性信号', cat.effective, '#10b981')
      + kpi('矛盾', cat.contradicted, '#ef4444')
      + kpi('提案', cat.proposal, '#8b5cf6');
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
      tl.innerHTML = '<div class="empty"><div class="icon">—</div>没有匹配的事件</div>';
      return;
    }

    const ACTOR_LETTER = { user: 'U', llm: 'L', system: 'S' };
    const ACTOR_TIP = { user: '用户 (user):由人工触发的事件', llm: 'LLM (llm):由语言模型 agent 触发的事件', system: '系统 (system):由后台维护/自愈流程触发的事件' };
    const ACTION_TIP = {
      // 状态变更
      create: 'create:创建新记忆印迹',
      update: 'update:修改已有印迹的字段',
      update_lifecycle: 'update_lifecycle:状态迁移(archived/forgotten)',
      reinforce: 'reinforce:强化(LTP)— 检索有效、闭环成功',
      report_failure: 'report_failure:负向反馈(LTD)— 检索不准、闭环失败',
      forget: 'forget:标记为 forgotten',
      restore: 'restore:从 forgotten/archived 恢复为 active',
      sweep_to_trash: 'sweep_to_trash:forgotten 满 30 天,文件移到 .trash/',
      restore_from_trash: 'restore_from_trash:从 .trash/ 物理恢复',
      purge: 'purge:硬删除(内容 + 元 + 关联突触)',
      // 有效性
      retrieve_hit: 'retrieve_hit:搜索命中',
      retrieve_effective: 'retrieve_effective:命中后被实际采用',
      retrieve_inconclusive: 'retrieve_inconclusive:命中但不确定是否有效',
      // 矛盾
      contradicted: 'contradicted:检测到与其他印迹冲突,进入裁决流程',
      // 提案
      propose: 'propose:捕获到候选记忆',
      accept: 'accept:采纳候选,转化为正式印迹',
      dismiss: 'dismiss:驳回候选'
    };
    tl.innerHTML = filtered.slice(0, 300).map(e => {
      return CO_ENGRAM_AUDIT.renderRow(e, ACTOR_LETTER, ACTOR_TIP, ACTION_TIP);
    }).join('');
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
    const m = e.metadata || {};
    const keys = Object.keys(m);
    if (keys.length === 0) return '<span class="audit-meta-empty">—</span>';

    // 1. update 类:有 changes 字段 → 渲染 changed fields
    if (m.changes && typeof m.changes === 'object' && !Array.isArray(m.changes)) {
      const fields = Object.keys(m.changes);
      if (fields.length === 0) {
        return '<span class="audit-meta-empty">(无字段实际变化)</span>';
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
      const chips = ['<span class="chip synapse-chip">突触</span>'];
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
  renderRow(e, ACTOR_LETTER, ACTOR_TIP, ACTION_TIP) {
    const ts = CO_ENGRAM.relativeTime(e.ts);
    const tsFull = CO_ENGRAM.escapeHtml(e.ts);
    const cls = CO_ENGRAM.auditActionClass(e.action);
    const actorLetter = ACTOR_LETTER[e.actor] || '?';
    const actorTip = ACTOR_TIP[e.actor] || e.actor || '';
    const actionTip = ACTION_TIP[e.action] || e.action || '';

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
      const label = isSynapse ? '🌐 打开源印迹' : '📄 打开印迹';
      targetCell = '<button class="btn-link audit-target-exists" title="' + CO_ENGRAM.escapeHtml(targetId) + '" '
        + 'onclick="CO_ENGRAM.showTab(\\'engrams\\');setTimeout(()=>CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(targetId) + '\\'),50)">'
        + label + ' <code>' + CO_ENGRAM.escapeHtml(short) + '</code></button>';
    } else {
      // 目标已不存在(被 purge / delete)→ 灰色删除线
      const short = targetId.length > 22 ? targetId.slice(0, 20) + '…' : targetId;
      targetCell = '<span class="audit-target-gone" title="目标已不存在:' + CO_ENGRAM.escapeHtml(targetId) + '">'
        + (isSynapse ? '🌐 ' : '📄 ') + '<code><s>' + CO_ENGRAM.escapeHtml(short) + '</s></code> <em>(已删除)</em></span>';
    }

    const metaHtml = this.renderMeta(e);

    const isActive = this._actionFilter === e.action;
    const actionBtnClass = 'action ' + cls + ' action-button' + (isActive ? ' active' : '');

    return '<div class="timeline-row audit-row">'
      + '<span class="ts" title="' + tsFull + '">' + ts + '</span>'
      + '<span class="actor-icon ' + e.actor + '" title="' + CO_ENGRAM.escapeHtml(actorTip) + '">' + actorLetter + '</span>'
      + '<button type="button" class="' + actionBtnClass + '" title="' + CO_ENGRAM.escapeHtml(actionTip) + ' — 点击仅显示此类事件" onclick="CO_ENGRAM_AUDIT.filterByAction(\\'' + CO_ENGRAM.escapeHtml(e.action) + '\\')">' + CO_ENGRAM.escapeHtml(e.action) + '</button>'
      + targetCell
      + '<div class="metadata audit-meta-cell">' + metaHtml + '</div>'
      + '</div>';
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
    root.innerHTML = '<div class="loading">加载回收站中</div>';
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/trash'); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    const items = data.results || [];
    if (!items.length) {
      root.innerHTML = '<div class="empty"><div class="icon">🗑️</div>回收站为空</div>';
      return;
    }
    // 顶部工具栏:统计 + 分区筛选 + 一键清空
    const partitions = [...new Set(items.map((t) => t.partition).filter(Boolean))].sort();
    const total = items.length;
    let html = '<div class="card" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:1rem">'
      + '<strong style="margin-right:auto">回收站 · 共 ' + total + ' 条</strong>';
    if (partitions.length > 1) {
      html += '<label style="font-weight:normal;font-size:0.9rem">分区:'
        + '<select id="trash-partition-filter" onchange="CO_ENGRAM_TRASH.applyFilter()" style="margin-left:0.4rem">'
        + '<option value="">全部</option>'
        + partitions.map((p) => '<option value="' + CO_ENGRAM.escapeHtml(p) + '">' + CO_ENGRAM.escapeHtml(p) + '</option>').join('')
        + '</select></label>';
    }
    html += '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.purgeAll(false)">永久清空全部</button>'
      + '</div>';

    html += '<table class="data-table" id="trash-table"><thead><tr>'
      + '<th>ID</th><th>分区</th><th>回收时间</th><th></th>'
      + '</tr></thead><tbody>';
    for (const t of items) {
      const part = t.partition || '';
      html += '<tr data-partition="' + CO_ENGRAM.escapeHtml(part) + '">'
        + '<td><code>' + CO_ENGRAM.escapeHtml(t.id) + '</code></td>'
        + '<td>' + CO_ENGRAM.escapeHtml(t.partition || '—') + '</td>'
        + '<td>' + CO_ENGRAM.escapeHtml(t.trashedAt || '—') + '</td>'
        + '<td>'
        + '<button class="btn-link" onclick="CO_ENGRAM_TRASH.preview(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">查看</button> '
        + '<button class="btn secondary" onclick="CO_ENGRAM_TRASH.restore(\\'' + CO_ENGRAM.escapeHtml(t.id) + '\\')">恢复</button>'
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
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/trash/' + encodeURIComponent(id)); }
    catch (e) { alert('加载失败:' + (e.message || e)); return; }

    const fm = d.frontmatter || {};
    const L = CO_ENGRAM_LABELS;
    const kind = fm.kind ? (L.kind[fm.kind] || fm.kind) : '';
    const status = fm.status ? (L.status[fm.status] || fm.status) : '';
    const valence = fm.emotionalValence ? (L.emotionalValence[fm.emotionalValence] || fm.emotionalValence) : '';
    const source = fm.sourceType ? (L.sourceType[fm.sourceType] || fm.sourceType) : '';

    const body = '<div class="edit-banner" style="background:rgba(239,68,68,.08);border-left:3px solid #ef4444;padding:0.6rem 0.8rem;margin-bottom:0.8rem">'
      + '<strong>回收站预览</strong> · 此记忆已被移出主索引,需先"恢复"才能再次编辑或召回。'
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(fm.title || id) + '</h2>'
      + '<div class="field"><span class="field-label">ID:</span><code>' + CO_ENGRAM.escapeHtml(id) + '</code></div>'
      + '<div class="field">'
      + (kind ? '<span class="chip kind-' + fm.kind + '"' + CO_ENGRAM.tip('kind.' + fm.kind) + '>' + kind + '</span> ' : '')
      + (status ? '<span class="field-label"' + CO_ENGRAM.tip('status.' + fm.status) + '>状态:</span>' + CO_ENGRAM.escapeHtml(status) : '')
      + '</div>'
      + (fm.domainTags && fm.domainTags.length
        ? '<div class="field"><span class="field-label">领域标签:</span>' + fm.domainTags.map((t) => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ') + '</div>'
        : '')
      + '<div class="field"><span class="field-label">分区:</span>' + CO_ENGRAM.escapeHtml(d.partition || '—')
      + ' <span class="field-label"' + CO_ENGRAM.tip('lastEffectiveAt') + '>回收时间:</span>' + CO_ENGRAM.escapeHtml(d.trashedAt || '—') + '</div>'
      + (valence ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('emotionalValence.' + fm.emotionalValence) + '>情感极性:</span>' + CO_ENGRAM.escapeHtml(valence) + '</div>' : '')
      + (source ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('sourceType.' + fm.sourceType) + '>来源:</span>' + CO_ENGRAM.escapeHtml(source) + '</div>' : '')
      + (fm.createdBy ? '<div class="field"><span class="field-label">创建者:</span>' + CO_ENGRAM.escapeHtml(fm.createdBy) + '</div>' : '')
      + '<h3>内容</h3><div class="markdown-body">' + CO_ENGRAM.renderMarkdown(d.content || '') + '</div>'
      + '<div style="margin-top:1rem;display:flex;gap:0.5rem">'
      + '<button class="btn" onclick="CO_ENGRAM.closeDrawer();CO_ENGRAM_TRASH.restore(\\'' + CO_ENGRAM.escapeHtml(id) + '\\')">恢复到主索引</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM.closeDrawer()">关闭</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  async restore(id) {
    if (!confirm('恢复 ' + id + ' 到主索引?')) return;
    try {
      await CO_ENGRAM.apiJson('/api/trash/' + encodeURIComponent(id) + '/restore', 'POST', {});
      CO_ENGRAM._trashLoaded = false;
      await this.render(document.getElementById('trash-content'));
    } catch (e) { alert('恢复失败:' + (e.message || e)); }
  },

  // 永久清空:byPartition=true 只清当前筛选分区,false=清全部
  async purgeAll(byPartition) {
    const filterSel = document.getElementById('trash-partition-filter');
    const part = byPartition && filterSel ? filterSel.value : '';
    const scope = part ? '分区 ' + part + ' 内' : '全部(跨所有分区)';
    // 先 dryRun 看看会删多少条
    let preview;
    try {
      const url = '/api/trash?dryRun=1' + (part ? '&partition=' + encodeURIComponent(part) : '');
      preview = await CO_ENGRAM.apiGet(url);
    } catch (e) { alert('预扫描失败:' + (e.message || e)); return; }

    const n = preview.count || 0;
    if (n === 0) { alert('当前范围无内容可清空'); return; }
    if (!confirm('即将永久删除 ' + scope + ' 的 ' + n + ' 条记忆。\\n此操作不可撤销(物理 unlink),即使有 git 仓库也只能从历史 commit 恢复。\\n\\n确认继续?')) return;
    if (!confirm('二次确认:真的清空 ' + scope + ' 的全部 ' + n + ' 条?')) return;

    try {
      const url = '/api/trash' + (part ? '?partition=' + encodeURIComponent(part) : '');
      const r = await CO_ENGRAM.apiJson(url, 'DELETE', {});
      alert('已永久删除 ' + (r.count || 0) + ' 条记忆。');
      CO_ENGRAM._trashLoaded = false;
      await this.render(document.getElementById('trash-content'));
    } catch (e) { alert('清空失败:' + (e.message || e)); }
  }
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
    root.innerHTML = '<div class="loading">加载配置中</div>';
    let data;
    try { data = await CO_ENGRAM.apiGet('/api/config'); }
    catch (e) { root.innerHTML = '<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'; return; }

    CO_ENGRAM._configData = data;
    const persisted = data.persisted || {};
    const runtime = data.runtime || {};
    // hostType 决定重启相关的提示文字与按钮可见性
    //   'mcp-server' → 由 Claude Code 父进程管理,支持优雅重启
    //   'openclaw-plugin' → 是 openclaw gateway 的一部分,不支持自动重启
    const hostType = data.hostType || 'mcp-server';
    const HOST_LABEL = hostType === 'openclaw-plugin' ? 'openclaw gateway' : 'MCP server';
    const HOST_PARENT = hostType === 'openclaw-plugin' ? 'openclaw' : 'Claude Code';
    const HOST_SUPPORTS_RESTART = hostType !== 'openclaw-plugin';

    const LANG_LABEL = { zh: '中文', en: 'English' };
    const langOptions = Object.keys(LANG_LABEL).map(k => '<option value="' + k + '"' + (persisted.language === k ? ' selected' : '') + '>' + LANG_LABEL[k] + '</option>').join('');
    const profileOptions = ['minimal', 'standard', 'full'].map(p => '<option value="' + p + '"' + (persisted.toolsProfile === p ? ' selected' : '') + '>' + p + '</option>').join('');

    let html = '';

    // 持久化(可编辑)
    html += '<div class="config-section">';
    html += '<h3>持久化配置(可编辑,保存后重启生效)</h3>';
    html += '<div class="config-row"><div class="config-label">语言<span class="desc">UI / 工具描述 / 提示词所用语言</span></div>'
      + '<div class="config-control"><select id="cf-language">' + langOptions + '</select></div></div>';
    html += '<div class="config-row"><div class="config-label">默认创建者<span class="desc">新记忆印迹的默认 createdBy 字段;留空回退到 git 身份</span></div>'
      + '<div class="config-control"><input id="cf-default-created-by" type="text" value="' + CO_ENGRAM.escapeHtml(persisted.defaultCreatedBy || '') + '" placeholder="(留空使用 git 作者)"></div></div>';
    html += '<div class="config-row"><div class="config-label">工具 Profile<span class="desc">LLM 可见工具数量:minimal=最小 / standard=标准 / full=全部</span></div>'
      + '<div class="config-control"><select id="cf-tools-profile">' + profileOptions + '</select></div></div>';
    html += '</div>';

    // 运行时状态:可编辑(下次启动生效),viewer 自身只读避免 UI 自杀
    const toggle = (id, label, desc, currentOn, desiredOn, editable) => {
      const effective = (desiredOn !== undefined ? desiredOn : currentOn);
      const onClass = effective ? 'on' : 'off';
      const control = editable
        ? '<label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (effective ? ' checked' : '') + '><span class="toggle-slider"></span></label>'
          + '<span class="toggle-state ' + onClass + '">' + (effective ? '启用' : '禁用') + '</span>'
        : '<input type="text" value="' + (currentOn ? '已启用' : '未启用') + '" readonly>';
      const badge = (desiredOn !== undefined && desiredOn !== currentOn)
        ? '<span class="chip" style="background:rgba(251,191,36,.12);color:var(--accent-warm);margin-left:.5rem">重启后生效</span>'
        : '';
      return '<div class="config-row"><div class="config-label">' + label + (desc ? '<span class="desc">' + desc + '</span>' : '') + badge + '</div>'
        + '<div class="config-control" style="display:flex;align-items:center;gap:.6rem">' + control + '</div></div>';
    };

    html += '<div class="config-section">';
    html += '<h3>运行时状态(编辑后需重启 ' + HOST_LABEL + ' 生效)</h3>';
    html += '<div class="edit-banner" style="margin-bottom:.8rem">说明:这些开关把"下次启动时期望的状态"持久化到 config.json。当前正在运行的实例不会受影响——重启 ' + HOST_LABEL + ' 后,新值才会生效。' + (HOST_SUPPORTS_RESTART ? '' : ' openclaw 模式下请使用 <code>openclaw gateway restart</code> 命令。') + '</div>';
    html += toggle('cf-audit', '审计日志', '记录所有 API / 工具调用事件', runtime.auditEnabled, persisted.audit?.enabled, true);
    html += toggle('cf-proposals', '提案引擎', '隐式捕获候选记忆待审批', runtime.proposalEnabled, persisted.proposals?.enabled, true);
    html += toggle('cf-maintenance', '维护服务', '后台 light/deep/rem 三阶段维护', runtime.maintenanceEnabled, persisted.maintenance?.enabled, true);
    html += toggle(null, '搜索器', '语义 + 关键词检索', runtime.searchEnabled, undefined, false);
    html += toggle(null, 'Web 查看器', '本页面所在 HTTP 服务(不可关闭,否则 UI 失联)', runtime.viewerEnabled, undefined, false);
    html += '</div>';

    // 运行时元数据(只读)
    html += '<div class="config-section">';
    html += '<h3>运行时元数据(只读)</h3>';
    html += '<div class="config-row readonly"><div class="config-label">运行 Profile</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(runtime.profile || 'standard') + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">当前语言(运行时)</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(LANG_LABEL[runtime.language] || runtime.language || '') + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">运行时 createdBy</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(runtime.defaultCreatedBy || '(未设置)') + '" readonly></div></div>';
    html += '</div>';

    // 元数据
    html += '<div class="config-section">';
    html += '<h3>仓库元数据</h3>';
    // 数据根目录:当前值只读展示 + "切换"按钮打开 drawer 编辑下次启动的期望值
    const currentDataRoot = data.dataRoot || '(未知)';
    const desiredDataRoot = persisted.desiredDataRoot || '';
    const dataRootBadge = desiredDataRoot
      ? '<span class="chip" style="background:rgba(251,191,36,.12);color:var(--accent-warm);margin-left:.5rem">重启后切换到 ' + CO_ENGRAM.escapeHtml(desiredDataRoot) + '</span>'
      : '';
    html += '<div class="config-row"><div class="config-label">数据根目录<span class="desc">记忆印迹/突触/审计的实际落盘位置。env CO_ENGRAM_DATA_ROOT 优先于此处持久化值。</span>' + dataRootBadge + '</div>'
      + '<div class="config-control" style="display:flex;gap:.4rem;align-items:center">'
      + '<input type="text" value="' + CO_ENGRAM.escapeHtml(currentDataRoot) + '" readonly style="flex:1">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.editDataRoot()">切换…</button>'
      + '</div></div>';
    html += '<div class="config-row readonly"><div class="config-label">配置版本</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(String(persisted.version || 1)) + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">创建时间</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(persisted.createdAt || '—') + '" readonly></div></div>';
    html += '<div class="config-row readonly"><div class="config-label">最后更新</div>'
      + '<div class="config-control"><input type="text" value="' + CO_ENGRAM.escapeHtml(persisted.updatedAt || persisted.createdAt || '—') + '" readonly></div></div>';
    html += '</div>';

    html += '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.reload()">重置</button>'
      + '<button class="btn" onclick="CO_ENGRAM_CONFIG.save()">保存配置</button>'
      + '</div>';

    root.innerHTML = html;
  },

  async reload() {
    CO_ENGRAM._configLoaded = false;
    const root = document.getElementById('config-content');
    if (root) await this.render(root);
  },

  async save() {
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
      { section: 'audit', label: '审计日志' },
      { section: 'proposals', label: '提案引擎' },
      { section: 'maintenance', label: '维护服务' }
    ];
    const changed = restartFields.filter(f => {
      const oldVal = before[f.section]?.enabled;
      const newVal = body[f.section]?.enabled;
      return oldVal !== newVal && !(oldVal == null && newVal == null);
    });
    const dataRootChanged = !!document.querySelector('.edit-banner[data-dataroot-changed="1"]');
    try {
      await CO_ENGRAM.apiJson('/api/config', 'PUT', body);
      const needsRestart = changed.length > 0 || dataRootChanged;
      let banner;
      if (needsRestart) {
        const changedLabels = changed.map(c => c.label).concat(dataRootChanged ? ['数据根目录'] : []);
        const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
        const HOST_LABEL = hostType === 'openclaw-plugin' ? 'openclaw gateway' : 'MCP server';
        const HOST_PARENT = hostType === 'openclaw-plugin' ? 'openclaw' : 'Claude Code';
        const restartSupported = hostType !== 'openclaw-plugin';
        const restartBtn = restartSupported
          ? '<button class="btn" style="margin-left:auto;padding:.3rem .8rem;font-size:.8rem" '
            + 'title="点击后 ' + HOST_LABEL + ' 会优雅退出(退出码 0),由父进程(通常 ' + HOST_PARENT + ')自动重启。\\n\\n'
            + '影响范围:\\n'
            + '  • 工具会短暂断开(几秒内自动重连,不影响正在进行的对话)\\n'
            + '  • 浏览器会失联,本页面会在服务恢复后自动刷新\\n'
            + '  • 维护线程、proposal 引擎等后台任务会以新配置重新启动\\n\\n'
            + '不会丢失:\\n'
            + '  • 已保存的配置(刚刚写入 config.json)\\n'
            + '  • 已存在的 engram / synapse 数据(落盘持久化)\\n'
            + '  • 当前对话历史(由 ' + HOST_PARENT + ' 持有,与服务重启无关)" '
            + 'onclick="CO_ENGRAM_CONFIG.restartNow()">立即重启生效</button>'
          : '<span style="margin-left:auto;font-size:.8rem;color:var(--fg-muted)">openclaw 模式不支持自动重启,请手动执行 <code>openclaw gateway restart</code></span>';
        banner = '<div class="edit-banner" style="background:rgba(251,191,36,0.08);border-color:rgba(251,191,36,0.35);color:var(--accent-warm);display:flex;flex-wrap:wrap;gap:.6rem;align-items:center">'
          + '<span>✓ 配置已保存。以下改动需重启 ' + HOST_LABEL + ' 才能生效:<strong>' + changedLabels.join('、') + '</strong></span>'
          + restartBtn
          + '</div>';
      } else {
        banner = '<div class="edit-banner" style="background:rgba(94,234,212,0.08);border-color:rgba(94,234,212,0.25);color:var(--accent)">✓ 配置已保存。</div>';
      }
      const root = document.getElementById('config-content');
      if (root) root.insertAdjacentHTML('afterbegin', banner);
      // 重新加载持久化部分
      setTimeout(() => { CO_ENGRAM._configLoaded = false; this.render(document.getElementById('config-content')); }, 2000);
    } catch (e) { alert('保存失败:' + (e.message || e)); }
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
    const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
    const HOST_LABEL = hostType === 'openclaw-plugin' ? 'openclaw gateway' : 'MCP server';
    const HOST_PARENT = hostType === 'openclaw-plugin' ? 'openclaw' : 'Claude Code';
    if (!confirm('确认重启 ' + HOST_LABEL + '?\\n\\n  • 工具会短暂断开(几秒内自动重连)\\n  • 浏览器会失联,本页面会在服务恢复后自动刷新\\n  • 已保存的配置和 engram 数据不会丢失')) return;
    // openclaw-plugin 模式:服务端会拒绝,直接提示用户手动重启 gateway
    if (hostType === 'openclaw-plugin') {
      alert('openclaw plugin 模式不支持从 viewer 自动重启——这会杀掉整个 gateway 进程,影响其他 plugin/会话。\\n\\n请手动执行:\\n  openclaw gateway restart');
      return;
    }
    // 显示重启遮罩
    let mask = document.getElementById('restart-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'restart-mask';
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,31,0.85);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;color:var(--fg);font-size:1rem;flex-direction:column;gap:1rem';
      mask.innerHTML = '<div style="font-size:1.5rem">⟳ 正在重启 ' + HOST_LABEL + '…</div>'
        + '<div style="color:var(--fg-muted);font-size:.85rem;max-width:480px;text-align:center">'
        + '服务正在退出并由父进程(' + HOST_PARENT + ')重新拉起。页面会在恢复后自动刷新。</div>'
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
        mask.innerHTML = '<div style="font-size:1.2rem;color:var(--accent-warm)">重启超时(30s)</div>'
          + '<div style="color:var(--fg-muted);font-size:.85rem">请手动刷新页面;若 ' + HOST_LABEL + ' 仍未恢复,请检查 ' + HOST_PARENT + ' 状态。</div>'
          + '<button class="btn" onclick="location.reload()" style="margin-top:.5rem">手动刷新</button>';
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
  },

  /**
   * 打开 drawer 编辑"下次启动的数据根目录"。
   * 当前运行实例不会受影响——已加载的 repository/maintainer/viewer 仍指向旧路径。
   */
  editDataRoot() {
    const data = CO_ENGRAM._configData || {};
    const persisted = data.persisted || {};
    const current = data.dataRoot || '(未知)';
    const desired = persisted.desiredDataRoot || '';
    const envSet = data.envSet || false;
    const envPath = data.envDataRoot || '';
    const envMatchedRuntime = !!data.envDataRootOverride;

    const body = '<div class="edit-banner"><strong>切换数据根目录</strong> · 仅影响下次服务启动</div>'
      + '<div class="field"><span class="field-label">当前运行时:</span><code>' + CO_ENGRAM.escapeHtml(current) + '</code></div>'
      + '<div class="field"><label class="field-label">下次启动使用:</label>'
      + '<input id="cf-dataroot" type="text" style="width:100%" value="' + CO_ENGRAM.escapeHtml(desired) + '" placeholder="(留空回退到 env / 默认路径)">'
      + '<div style="font-size:0.75rem;color:var(--fg-muted);margin-top:0.3rem">'
      + '绝对路径(如 <code>/home/USER/team-memory</code> 或 <code>/var/lib/co-engram</code>)。'
      + '留空则清除持久化值,回退到 env / 默认路径。'
      + '<br><strong style="color:var(--accent)">优先级:此处配置 &gt; env CO_ENGRAM_DATA_ROOT &gt; 默认路径。</strong>'
      + (envSet
        ? ' <span style="color:var(--fg-muted)">检测到 env 已设置 <code>' + CO_ENGRAM.escapeHtml(envPath || '(空)') + '</code>' + (envMatchedRuntime ? '(当前正是 env 路径)' : '') + ';此处填值将<strong>覆盖</strong> env。</span>'
        : '')
      + '</div></div>'
      + '<div class="edit-banner" style="background:rgba(251,191,36,0.06);border-color:rgba(251,191,36,0.25);color:var(--accent-warm)">'
      + '<strong>注意:</strong>切换目录后,新目录若为空将自动初始化;原目录的数据不会迁移。'
      + '保存后需要重启服务才会切换。</div>'
      + '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_CONFIG.reload(); CO_ENGRAM.closeDrawer();">取消</button>'
      + '<button class="btn" onclick="CO_ENGRAM_CONFIG.saveDataRoot()">保存期望值</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  async saveDataRoot() {
    const input = document.getElementById('cf-dataroot');
    if (!input) return;
    const value = (input.value || '').trim();
    try {
      await CO_ENGRAM.apiJson('/api/config', 'PUT', { desiredDataRoot: value });
      CO_ENGRAM.closeDrawer();
      const hostType = (CO_ENGRAM._configData && CO_ENGRAM._configData.hostType) || 'mcp-server';
      const HOST_LABEL = hostType === 'openclaw-plugin' ? 'openclaw gateway' : 'MCP server';
      const banner = '<div class="edit-banner" style="background:rgba(251,191,36,0.08);border-color:rgba(251,191,36,0.25);color:var(--accent-warm)">✓ 数据根目录期望值已保存:' + (value ? CO_ENGRAM.escapeHtml(value) : '(已清除,回退默认)') + '。<strong>重启 ' + HOST_LABEL + ' 生效</strong>。</div>';
      const root = document.getElementById('config-content');
      if (root) root.insertAdjacentHTML('afterbegin', banner);
      CO_ENGRAM._configLoaded = false;
      await this.render(document.getElementById('config-content'));
    } catch (e) { alert('保存失败:' + (e.message || e)); }
  }
};

// ============================================================
// Synapses(被 graph tab 调用,也可独立打开)
// ============================================================
window.CO_ENGRAM_SYNAPSES = {
  async open(id) {
    let d;
    try { d = await CO_ENGRAM.apiGet('/api/synapses/' + encodeURIComponent(id)); }
    catch (e) { CO_ENGRAM.openDrawer('<div class="empty">加载失败:' + CO_ENGRAM.escapeHtml(e.message) + '</div>'); return; }
    CO_ENGRAM._currentSynapse = d;
    this._renderView(d);
  },

  _renderView(d) {
    const L = CO_ENGRAM_LABELS;
    const id = CO_ENGRAM.escapeHtml(d.id);
    const kindLabel = L.synapse[d.kind] || d.kind;
    const family = CO_ENGRAM.synapseFamily(d.kind);
    const familyLabel = { structural: '结构', causal: '因果', evidential: '证据', temporal: '时间', modulatory: '调节' }[family] || family;
    const dirLabel = L.synapseDirection[d.direction] || d.direction || '单向';
    const evidence = (d.evidence || []);
    const evidenceHtml = evidence.length
      ? '<h3>证据 (' + evidence.length + ')</h3>' + evidence.map(ev => '<div class="field markdown-body" style="padding-left:.5rem;border-left:2px solid var(--border);margin-bottom:.4rem">'
        + CO_ENGRAM.renderMarkdown(ev.description || '')
        + (ev.source ? ' <span class="chip">' + CO_ENGRAM.escapeHtml(ev.source) + '</span>' : '')
        + (ev.confidence != null ? ' <span class="kpi-sub">置信度 ' + Number(ev.confidence).toFixed(2) + '</span>' : '')
        + (ev.addedBy ? ' <span class="kpi-sub">· ' + CO_ENGRAM.escapeHtml(ev.addedBy) + '</span>' : '')
        + '</div>').join('')
      : '<div class="empty">无证据</div>';

    const body = '<div class="edit-banner" style="display:flex;gap:.5rem;align-items:center">'
      + '<strong style="margin-right:auto">突触详情</strong>'
      + '<button class="btn" onclick="CO_ENGRAM_SYNAPSES.edit()">编辑</button>'
      + '<button class="btn secondary" onclick="CO_ENGRAM_SYNAPSES.confirmDelete()">删除</button>'
      + '</div>'
      + '<h2>' + CO_ENGRAM.escapeHtml(kindLabel) + '</h2>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>类型:</span>' + CO_ENGRAM.escapeHtml(kindLabel) + ' (' + CO_ENGRAM.escapeHtml(d.kind) + ')</div>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('family.' + family) + '>所属族:</span><span class="chip dot" style="color:' + CO_ENGRAM.familyColor(family) + '">' + CO_ENGRAM.escapeHtml(familyLabel) + '</span></div>'
      + '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>方向:</span>' + CO_ENGRAM.escapeHtml(dirLabel) + '</div>'
      + '<div class="field"><span class="field-label">权重:</span>' + (d.weight != null ? Number(d.weight).toFixed(2) : '—') + '</div>'
      + (d.resolutionStatus ? '<div class="field"><span class="field-label"' + CO_ENGRAM.tip('resolution.' + d.resolutionStatus) + '>裁决状态:</span><span class="chip" style="background:rgba(239,68,68,.12);color:#ef4444">' + CO_ENGRAM.escapeHtml(L.resolution[d.resolutionStatus] || d.resolutionStatus) + '</span></div>' : '')
      + '<div class="field"><span class="field-label">ID:</span><code>' + id + '</code></div>'
      + '<div class="field"><span class="field-label">源 → 目标:</span><span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.from) + '">' + CO_ENGRAM.escapeHtml(d.from) + '</span> → <span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(d.to) + '">' + CO_ENGRAM.escapeHtml(d.to) + '</span></div>'
      + '<div class="field"><span class="field-label">创建者:</span>' + CO_ENGRAM.escapeHtml(d.createdBy || '')
      + ' <span class="field-label">时间:</span>' + CO_ENGRAM.escapeHtml(d.createdAt || '') + '</div>'
      + evidenceHtml;
    CO_ENGRAM.openDrawer(body);
  },

  edit() {
    const d = CO_ENGRAM._currentSynapse;
    if (!d) return;
    const L = CO_ENGRAM_LABELS;
    // 12 种 kind,按族分组,与 stats/graph tab 一致
    const KINDS_BY_FAMILY = [
      { family: 'structural', label: '结构族', kinds: ['extends', 'part_of', 'similar_to'] },
      { family: 'causal', label: '因果族', kinds: ['depends_on', 'causes', 'follows'] },
      { family: 'evidential', label: '证据族', kinds: ['derives_from', 'contradicts', 'exemplifies'] },
      { family: 'temporal', label: '时间族', kinds: ['supersedes', 'consolidates'] },
      { family: 'modulatory', label: '调节族', kinds: ['contextualizes'] }
    ];
    const kindOptions = KINDS_BY_FAMILY.map(group =>
      '<optgroup label="' + group.label + '">' + group.kinds.map(k =>
        '<option value="' + k + '"' + (d.kind === k ? ' selected' : '') + CO_ENGRAM.tip('synapse.' + k) + '>' + (L.synapse[k] || k) + ' · ' + k + '</option>'
      ).join('') + '</optgroup>'
    ).join('');
    const dirOptions = Object.keys(L.synapseDirection).map(k => '<option value="' + k + '"' + (d.direction === k ? ' selected' : '') + CO_ENGRAM.tip('synapseDirection.' + k) + '>' + L.synapseDirection[k] + '</option>').join('');

    const body = '<div class="edit-banner"><strong>编辑模式</strong> · 修改后点击"保存"提交</div>'
      + '<h2>编辑记忆突触</h2>'
      + '<div class="field"><span class="field-label">ID:</span><code>' + CO_ENGRAM.escapeHtml(d.id) + '</code></div>'
      + '<div class="edit-banner" style="background:rgba(251,191,36,.06);border-color:rgba(251,191,36,.25);color:var(--accent-warm)">提示:修改"类型"或"方向"会让突触 ID 重新计算(因 ID 派生自 from+to+kind+direction),旧 ID 将失效,但所有元数据(权重/证据/创建者)会迁移到新 ID。</div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>类型</label><select id="sf-kind"' + CO_ENGRAM.tip('synapse.' + d.kind) + '>' + kindOptions + '</select></div>'
      + '<div class="field"><label class="field-label"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>方向</label><select id="sf-direction"' + CO_ENGRAM.tip('synapseDirection.' + (d.direction || 'directional')) + '>' + dirOptions + '</select></div>'
      + '<div class="field"><label class="field-label">权重 (0-1,可拖动滑块)</label><input id="sf-weight-range" type="range" min="0" max="1" step="0.01" value="' + (d.weight || 0) + '" oninput="document.getElementById(\\'sf-weight\\').value=this.value"><input id="sf-weight" type="number" min="0" max="1" step="0.01" value="' + (d.weight || 0) + '" oninput="document.getElementById(\\'sf-weight-range\\').value=this.value" style="width:80px;margin-left:.5rem"></div>'
      + '<div class="field"><label class="field-label">新增证据描述(可选,留空则不追加)</label><input id="sf-evidence-desc" type="text" placeholder="如:通过 codegraph 验证..."></div>'
      + '<div class="field"><label class="field-label">证据来源(可选)</label><input id="sf-evidence-source" type="text" placeholder="如:manual / ci / docs"></div>'
      + '<div class="config-save-bar">'
      + '<button class="btn secondary" onclick="CO_ENGRAM_SYNAPSES.cancel()">取消</button>'
      + '<button class="btn" onclick="CO_ENGRAM_SYNAPSES.save()">保存</button>'
      + '</div>';
    CO_ENGRAM.openDrawer(body);
  },

  cancel() {
    const d = CO_ENGRAM._currentSynapse;
    if (d) this._renderView(d);
  },

  async save() {
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
    } catch (e) { alert('保存失败:' + (e.message || e)); }
  },

  async confirmDelete() {
    const d = CO_ENGRAM._currentSynapse;
    if (!d) return;
    if (!confirm('确定删除此记忆突触?\\n此操作不可撤销。')) return;
    try {
      await CO_ENGRAM.apiJson('/api/synapses/' + encodeURIComponent(d.id), 'DELETE', null);
      CO_ENGRAM.closeDrawer();
      CO_ENGRAM._currentSynapse = null;
      // 重新加载图谱(如果当前在图谱 tab)
      if (CO_ENGRAM._graphState) {
        CO_ENGRAM._graphState.initialized = false;
        CO_ENGRAM._graphState = null;
        const gc = document.getElementById('graph-canvas');
        if (gc) gc.innerHTML = '<div class="loading">重新加载图谱中</div>';
        CO_ENGRAM.onTabEnter('graph');
      }
    } catch (e) { alert('删除失败:' + (e.message || e)); }
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
    return ''
      + '<div class="panel" style="max-width:900px;margin:0 auto;padding:1.5rem;line-height:1.7">'
      + '<h2 style="margin-top:0">Co-Engram · 自进化的团队记忆</h2>'
      + '<p>Co-Engram 把团队工作中的对话、决策、踩过的坑沉淀为<em>记忆印迹(engram)</em>,'
      + '用<em>记忆突触(synapse)</em>把它们连成可演化的知识网络。模型在后续任务里通过 '
      + '<code>memory_search</code> 召回相关记忆,引用有效时调 <code>engram_reinforce</code> '
      + '强化,出错时调 <code>engram_report_failure</code> 弱化——这套闭环让高价值记忆自动浮现、过时记忆自动衰减。</p>'

      + '<h3>核心概念</h3>'
      + '<dl style="padding-left:0.5rem;border-left:3px solid var(--border)">'
      + '<dt><strong>记忆印迹(engram)</strong></dt>'
      + '<dd style="margin-bottom:0.6rem">一条结构化的记忆条目,含标题/内容/类型/标签/重要性/置信度等字段。'
      + '类型分 5 种:<code>fact(事实)</code> <code>observation(观察)</code> <code>pattern(模式)</code> '
      + '<code>procedure(流程)</code> <code>hypothesis(假设)</code>。鼠标悬停字段可以看到该字段的解释。</dd>'
      + '<dt><strong>记忆突触(synapse)</strong></dt>'
      + '<dd style="margin-bottom:0.6rem">连接两个 engram 的有向边,分 5 个族:'
      + '<code>结构族</code>(extends/part_of/similar_to)、'
      + '<code>因果族</code>(depends_on/causes/follows)、'
      + '<code>证据族</code>(derives_from/contradicts/exemplifies)、'
      + '<code>时间族</code>(supersedes/consolidates)、'
      + '<code>调节族</code>(contextualizes)。<code>contradicts</code> 会进入裁决流程。</dd>'
      + '<dt><strong>重要性(importance)与置信度(confidence)</strong></dt>'
      + '<dd style="margin-bottom:0.6rem">两个独立的 0-1 数值。重要性由强化信号 + 时间衰减派生,影响召回权重;'
      + '置信度反映该记忆成立的可信程度(元认知评分),与重要性解耦。</dd>'
      + '<dt><strong>多维重要性向量(importanceVector)</strong></dt>'
      + '<dd style="margin-bottom:0.6rem">把重要性拆解为 personal/team/project/network/temporal 5 个维度,便于精细化调控。'
      + '查看 engram 详情时如果存在,会显示在专门的段落里。</dd>'
      + '<dt><strong>生命周期</strong></dt>'
      + '<dd style="margin-bottom:0.6rem"><code>draft → active → archived → forgotten</code>。'
      + '遗忘的文件仍在仓库,但默认不召回。维护周期会自动评估并迁移状态。</dd>'
      + '</dl>'

      + '<h3>各 tab 用途</h3>'
      + '<ul style="padding-left:1.2rem">'
      + '<li><strong>统计</strong>—总览仪表盘:按类型/状态/族分布,显示团队贡献者和 top 标签。'
      + '顶部搜索框做全文检索。</li>'
      + '<li><strong>记忆印迹</strong>—全部 engram 的卡片/目录视图,支持按 tag/kind/status 过滤,'
      + '点击进入详情(可编辑/删除/查看突触)。</li>'
      + '<li><strong>记忆突触</strong>—知识图谱可视化。'
      + '可按族/类型过滤边,按 engram 类型过滤节点。打开 engram 详情时图谱会高亮其邻居。</li>'
      + '<li><strong>记忆提案</strong>—候选记忆审批队列。系统从对话中提取候选,'
      + '由人工/LLM 采纳(engram_accept_proposal)或忽略(engram_dismiss_proposal)。</li>'
      + '<li><strong>审计</strong>—操作时间线,记录 create/update/reinforce/report_failure 等所有状态变更,'
      + '便于追溯"谁在何时改了什么"。</li>'
      + '<li><strong>记忆回收站</strong>—被删除的 engram 暂存处。可恢复单个,或一键清空(支持按分区筛选,'
      + '永久删除前会 dryRun 预扫描条数 + 二次确认)。</li>'
      + '<li><strong>配置</strong>—数据根目录、维护周期、自进化参数等。改持久化配置后需重启宿主生效。</li>'
      + '</ul>'

      + '<h3>记忆怎么自动进化</h3>'
      + '<ol style="padding-left:1.2rem">'
      + '<li><strong>检索</strong>:agent 调 <code>memory_search</code>,FTS + 三因子打分召回 top-N。</li>'
      + '<li><strong>引用</strong>:agent 把相关记忆内容写进答案,用户据此决策。</li>'
      + '<li><strong>强化</strong>:agent 自主判断引用是否有效——有效调 <code>engram_reinforce</code>,'
      + '出错调 <code>engram_report_failure</code>。</li>'
      + '<li><strong>扩散</strong>:强化通过突触按 Hebbian 比例扩散到邻居(contradicts 除外)。</li>'
      + '<li><strong>衰减</strong>:每个 engram 有 <code>decayHalfLifeDays</code>,'
      + 'importance 按 lastEffectiveAt + 半衰期指数衰减。</li>'
      + '<li><strong>维护</strong>:后台周期跑 light/deep/rem 三阶段,'
      + '完成"巩固强化 → 衰减遗忘 → REM 抽象模式 → 触发元认知评分"。</li>'
      + '</ol>'

      + '<h3>提示</h3>'
      + '<ul style="padding-left:1.2rem">'
      + '<li>字段名旁的 <code>?</code> 图标(鼠标悬停)有该字段的简短解释。</li>'
      + '<li>详情视图的"价值评估/多维重要性/记忆产生情境"段落仅在 engram 携带相应字段时显示。</li>'
      + '<li>配置 tab 的修改默认写入持久化文件,重启宿主(如 <code>openclaw gateway restart</code>)后生效。</li>'
      + '<li>遇到仓库不一致,可在 agent 中调 <code>engram_doctor</code> 自愈扫描。</li>'
      + '</ul>'

      + '</div>';
  }
};
`;
