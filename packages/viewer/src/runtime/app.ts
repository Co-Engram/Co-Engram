/**
 * Viewer v2 runtime — 通用前端工具:本地 state、auth、fetch、
 * 颜色映射、时间格式化、tab 切换、drawer 管理。
 *
 * 这里 export 的字符串会被嵌入到 SPA HTML 的 <script> 标签内,
 * 在浏览器端执行。完全离线,不依赖任何外部 CDN。
 *
 * @module @co-engram/claude-code/viewer/runtime/app
 */

export const APP_RUNTIME = `
// ============================================================
// Co-Engram Viewer v2 runtime(纯 JS,无 Alpine/htmx 依赖)
// ============================================================

const CO_ENGRAM_STATE = {
  tab: 'stats',
  token: ''
};

const CO_ENGRAM = (function() {
  'use strict';

  // === 颜色 / 类型 映射 ===
  // 注意:related_to 不在 SynapseKind 类型里(神经科学 5 族严格推导,无兜底),
  // 但历史数据中存在;familyColor/edgeColor 兜底为 modulatory 灰色,避免渲染崩成 undefined。
  const SYNAPSE_FAMILY = {
    extends: 'structural', part_of: 'structural', similar_to: 'structural',
    depends_on: 'causal', causes: 'causal', follows: 'causal',
    derives_from: 'evidential', contradicts: 'evidential', exemplifies: 'evidential',
    supersedes: 'temporal', consolidates: 'temporal',
    contextualizes: 'modulatory',
    related_to: 'modulatory'
  };

  const FAMILY_COLOR = {
    structural: '#3b82f6',
    causal: '#f97316',
    evidential: '#10b981',
    temporal: '#8b5cf6',
    modulatory: '#6b7280'
  };
  const CONTRADICTS_COLOR = '#ef4444';

  const KIND_COLOR = {
    fact: '#10b981',
    observation: '#3b82f6',
    pattern: '#8b5cf6',
    procedure: '#f97316',
    hypothesis: '#ef4444'
  };

  // 12 种 synapse kind 各自独立的颜色(同族保持色调相近,但明度不同以便区分)
  // related_to 不属于神经科学 5 族,但历史数据中存在;这里给一个浅灰 fallback
  // 防止渲染时取不到颜色 - 颜色是显示层细节,不影响类型/schema 严格性。
  const SYNAPSE_KIND_COLOR = {
    // 结构族 · 蓝色系
    extends: '#3b82f6',      // 主蓝
    part_of: '#60a5fa',      // 浅蓝
    similar_to: '#1e40af',   // 深蓝
    // 因果族 · 橙色系
    depends_on: '#f97316',   // 主橙
    causes: '#fb923c',       // 浅橙
    follows: '#c2410c',      // 深橙
    // 证据族 · 绿色系(contradicts 独立红色)
    derives_from: '#10b981', // 主绿
    exemplifies: '#6ee7b7',  // 浅绿
    contradicts: '#ef4444',  // 红(高优先级)
    // 时间族 · 紫色系
    supersedes: '#8b5cf6',   // 主紫
    consolidates: '#c4b5fd', // 浅紫
    // 调节族 · 灰色系
    contextualizes: '#6b7280', // 灰
    related_to: '#9ca3af'      // 浅灰(历史数据 fallback,非正式族成员)
  };

  // === 术语提示(鼠标悬停时显示) ===
  // TOOLTIPS 在脚本初始化时按当前 lang 从 i18n 字典(window.CO_ENGRAM_I18N[lang])派生:
  //   把 'tip.{category}.{value}' 平铺 key 重组成 { category: { value: text } } 树。
  // 这样保持 CO_ENGRAM.TOOLTIPS.{cat}.{val} 接口不变,内容跟随语言切换。
  const TOOLTIPS = (function() {
    const dicts = window.CO_ENGRAM_I18N || {};
    const lang = window.CO_ENGRAM_LANG || 'en';
    const dict = dicts[lang] || dicts.en || {};
    const out = {};
    for (const k of Object.keys(dict)) {
      if (k.indexOf('tip.') !== 0) continue;
      const parts = k.split('.');
      const cat = parts[1];
      if (!cat) continue;
      const val = parts[2];
      if (!val) {
        out[cat] = dict[k];
      } else {
        if (!out[cat] || typeof out[cat] !== 'object') out[cat] = {};
        out[cat][val] = dict[k];
      }
    }
    return out;
  })();

  function tip(key) {
    // 支持 'kind.fact' / 'importance' 两种 key 形式
    const parts = key.split('.');
    let v = TOOLTIPS;
    for (const p of parts) {
      if (v && typeof v === 'object' && p in v) v = v[p];
      else return '';
    }
    if (typeof v !== 'string') return '';
    return ' title="' + v.replaceAll('"', '&quot;') + '"';
  }

  function synapseFamily(kind) {
    return SYNAPSE_FAMILY[kind] || 'modulatory';
  }
  function familyColor(family) {
    return FAMILY_COLOR[family] || FAMILY_COLOR.modulatory;
  }
  function kindColor(kind) {
    return KIND_COLOR[kind] || '#6b7280';
  }
  function edgeColor(kind) {
    // 优先用 12 种独立颜色,让每种 kind 视觉上可区分
    if (SYNAPSE_KIND_COLOR[kind]) return SYNAPSE_KIND_COLOR[kind];
    return kind === 'contradicts' ? CONTRADICTS_COLOR : familyColor(synapseFamily(kind));
  }

  // === 时间格式化 ===
  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - then) / 1000));
    if (diffSec < 60) return diffSec + 's ago';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
    if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function importanceBar(value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    const pct = Math.round(v * 100);
    return '<span class="importance-bar" title="importance=' + pct + '%"><span style="width:' + pct + '%"></span></span>';
  }

  // Q2:importance 文字档位 chip(高/中/低),hover tooltip 显示精确数值。
  // 阈值与 T.formatScoreBand 一致(≥0.7 high / ≥0.3 medium / <0.3 low)。
  // 列表卡片 + 详情页 KPI 子标签共用,降低视觉噪音、强化语义化档位。
  function renderImportanceChip(value) {
    const T = window.CO_ENGRAM_T;
    const imp = T.describeImportance(value);
    if (imp.band === 'none') return '<span class="importance-chip imp-none">—</span>';
    return '<span class="importance-chip imp-' + imp.band + '" title="' + escapeHtml(imp.tipText) + '">'
      + escapeHtml(imp.label) + '</span>';
  }

  // === Markdown 渲染(用于 engram/synapse 内容显示)===
  // marked.parse 把 markdown 转 HTML,DOMPurify.sanitize 消毒后返回。
  // 限定 ALLOWED_TAGS 防止 XSS(engram 内容来自 LLM/用户,可能含恶意脚本)。
  // 两个 vendor lib 都通过 vendor 模块 inline,完全离线。
  //
  // P0-8 加固:除 ALLOWED_TAGS 外,显式 FORBID_TAGS 高危标签 + 限制 URI 协议。
  // 此前配置虽有 ALLOWED_TAGS allowlist,但 href/src 属性未限协议,
  // a-href with javascript: protocol or img onerror handler 等仍可绕过。
  // 现在加 ALLOWED_URI_REGEXP,只允许 http(s)/mailto/相对路径/页面内锚点。
  function renderMarkdown(md) {
    if (md == null) return '';
    var input = String(md);
    if (input.trim().length === 0) return '';
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      // vendor 未加载,降级为 escape 后纯文本
      return '<p>' + escapeHtml(input) + '</p>';
    }
    try {
      var html = window.marked.parse(input, { breaks: true, gfm: true });
      return window.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'strong', 'em', 'del', 'code', 'pre',
          'ul', 'ol', 'li', 'blockquote', 'a', 'hr', 'br',
          'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'img', 'span'
        ],
        ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
        ALLOW_DATA_ATTR: false,
        // 显式禁止高危标签(双保险:即使 allowlist 漏配也无法绕过)
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
        // URI 协议白名单:拒绝 javascript: / data: / vbscript: / file: 等
        // 允许:http(s):, mailto:, 页面内锚点(#/path), 无协议相对路径(abc, ./abc)
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#\\/[\\w-]*$|[^:]*$)/i,
        ALLOW_UNKNOWN_PROTOCOLS: false
      });
    } catch (e) {
      console.error('[co-engram] markdown render failed:', e);
      return '<p>' + escapeHtml(input) + '</p>';
    }
  }

  // === Auth / fetch wrapper ===
  function getToken() {
    return CO_ENGRAM_STATE.token || '';
  }
  function setToken(v) {
    CO_ENGRAM_STATE.token = v || '';
    try { localStorage.setItem('co-engram-viewer-token', CO_ENGRAM_STATE.token); } catch {}
  }
  function loadToken() {
    try { CO_ENGRAM_STATE.token = localStorage.getItem('co-engram-viewer-token') || ''; } catch {}
  }
  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }
  async function apiGet(url) {
    const r = await fetch(url, { headers: Object.assign({}, authHeaders(), { Accept: 'application/json' }) });
    if (!r.ok) throw new Error('GET ' + url + ' → ' + r.status);
    return r.json();
  }
  async function apiJson(url, method, body) {
    const r = await fetch(url, {
      method: method,
      headers: Object.assign({}, authHeaders(), { 'Content-Type': 'application/json' }),
      body: body == null ? undefined : JSON.stringify(body)
    });
    if (!r.ok) throw new Error(method + ' ' + url + ' → ' + r.status);
    return r.json().catch(function() { return {}; });
  }

  // === Cursor paginator 工厂 ===
  // 给 engrams/proposals/audit 共用,管理 items 累积 + nextCursor + 重置。
  // 调用方负责:渲染 items、渲染 load-more 按钮、提供额外 query params(filter/sort)。
  // 共同根因(2026-07 viewer 修复):5 个 UX 痛点共同形状是"缺分页抽象",此工厂是
  // 该根因的单一抽象解。详细设计见 packages/viewer/src/cursor-pagination.ts。
  //
  // 用法:
  //   const pager = CO_ENGRAM.createPaginator({
  //     endpoint: '/api/proposals',
  //     pageSize: 50,
  //     getExtraParams: () => ({ status: 'pending' }),
  //   });
  //   await pager.load();            // 第一页
  //   pager.getItems();              // 累积的 items
  //   pager.hasMore();               // 是否还有下一页
  //   await pager.loadMore();        // 翻下一页(loadMore 内部更新 items / hasMore)
  //   await pager.load();            // 重置 + 第一页(filter 变化时调用)
  function createPaginator(opts) {
    var items = [];
    var nextCursor = null;
    var total = 0;
    var loading = false;
    var lastResponse = null;

    function buildUrl() {
      var params = new URLSearchParams();
      params.set('limit', String(opts.pageSize));
      if (nextCursor) params.set('cursor', nextCursor);
      var extra = opts.getExtraParams ? opts.getExtraParams() : {};
      for (var k in extra) {
        var v = extra[k];
        if (v != null && v !== '') params.set(k, String(v));
      }
      return opts.endpoint + '?' + params.toString();
    }

    async function _load(reset) {
      if (loading) return;
      loading = true;
      if (reset) {
        items = [];
        nextCursor = null;
      }
      try {
        var data = await apiGet(buildUrl());
        lastResponse = data;
        items = reset ? (data.results || []) : items.concat(data.results || []);
        nextCursor = data.nextCursor || null;
        total = (data.total != null) ? data.total : items.length;
      } finally {
        loading = false;
      }
    }

    return {
      load: function() { return _load(true); },
      loadMore: function() { return nextCursor ? _load(false) : Promise.resolve(); },
      getItems: function() { return items; },
      getTotal: function() { return total; },
      hasMore: function() { return nextCursor !== null; },
      isLoading: function() { return loading; },
      getLastResponse: function() { return lastResponse; }
    };
  }

  // === Tab 切换 ===
  function showTab(name) {
    CO_ENGRAM_STATE.tab = name;
    document.querySelectorAll('.tab').forEach(function(b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('section.tab-panel').forEach(function(s) {
      s.classList.toggle('active', s.dataset.tab === name);
    });
    // 二级 tab 在「更多」下拉中:展开状态下切 tab 后要收起;
    // trigger 显示当前子 tab 名(如"审计 ▾"替代"更多 ▾")+ .has-active 高亮
    var inMore = document.querySelector('#more-menu-dropdown .tab[data-tab="' + name + '"]');
    var menu = document.getElementById('more-menu');
    if (menu) menu.classList.toggle('has-active', !!inMore);
    // 更新 trigger 标签:二级 tab active 时显示子 tab 名,否则恢复「更多」
    var triggerLabel = document.querySelector('#more-menu-trigger > span:first-child');
    if (triggerLabel) {
      if (inMore) {
        triggerLabel.textContent = inMore.textContent.trim();
      } else {
        triggerLabel.textContent = CO_ENGRAM_T.t('viewer.tab.more');
      }
    }
    toggleMoreMenu(false);
    CO_ENGRAM.onTabEnter(name);
  }

  // === 「更多」下拉菜单切换 ===
  // open 未传 = toggle;true/false 强制打开/关闭。aria-expanded 同步给屏幕阅读器。
  function toggleMoreMenu(open) {
    var menu = document.getElementById('more-menu');
    var trigger = document.getElementById('more-menu-trigger');
    var dropdown = document.getElementById('more-menu-dropdown');
    if (!menu || !trigger || !dropdown) return;
    var shouldOpen = typeof open === 'boolean' ? open : !menu.classList.contains('open');
    menu.classList.toggle('open', shouldOpen);
    trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    dropdown.hidden = !shouldOpen;
  }

  // === Proposals 徽标 ===
  // 由 stats 加载完成后 + accept/dismiss 后调用。count=0 时隐藏,否则显示数字
  // (>=100 显示 99+,避免 3 位数撑爆徽标宽度)。
  function setProposalsBadge(count) {
    var n = Math.max(0, count | 0);
    document.querySelectorAll('[data-badge="proposals"]').forEach(function(b) {
      if (n > 0) {
        b.textContent = n > 99 ? '99+' : String(n);
        b.hidden = false;
      } else {
        b.hidden = true;
      }
    });
  }
  async function refreshProposalsBadge() {
    try {
      var data = await apiGet('/api/stats');
      setProposalsBadge((data && data.pendingProposals) || 0);
    } catch (e) {
      // /api/stats 失败时不抹掉已有徽标(可能是临时网络抖动)
    }
  }

  // === Drawer (right side detail panel) ===
  function openDrawer(html) {
    const drawer = document.getElementById('detail-drawer');
    if (!drawer) return;
    drawer.querySelector('.drawer-body').innerHTML = html;
    drawer.classList.add('open');
  }
  function closeDrawer() {
    const drawer = document.getElementById('detail-drawer');
    if (drawer) drawer.classList.remove('open');
  }

  // === Audit action 分类 ===
  function auditActionClass(action) {
    if (action === 'contradicted') return 'audit-contradicted';
    if (action === 'retrieve_hit' || action === 'retrieve_effective' || action === 'retrieve_inconclusive') return 'audit-effective';
    if (action === 'propose' || action === 'accept' || action === 'dismiss') return 'audit-proposal';
    return 'audit-state';
  }

  // === 注册表 ===
  const TAB_HANDLERS = {};
  function on(name, fn) { TAB_HANDLERS[name] = fn; }
  function onTabEnter(name) {
    const h = TAB_HANDLERS[name];
    if (h) {
      try {
        const result = h();
        if (result && typeof result.catch === 'function') {
          result.catch(function(e) {
            console.error('[co-engram] tab handler async failed:', e);
          });
        }
      } catch (e) {
        console.error('[co-engram] tab handler failed:', e);
      }
    }
  }

  // 清空 stats tab 的搜索结果,回到默认统计视图
  function clearSearch() {
    var input = document.getElementById('search-input');
    if (input) input.value = '';
    var resultsEl = document.getElementById('search-results');
    if (resultsEl) {
      resultsEl.style.display = 'none';
      resultsEl.innerHTML = '';
    }
  }

  return {
    SYNAPSE_FAMILY: SYNAPSE_FAMILY, FAMILY_COLOR: FAMILY_COLOR,
    KIND_COLOR: KIND_COLOR, CONTRADICTS_COLOR: CONTRADICTS_COLOR,
    SYNAPSE_KIND_COLOR: SYNAPSE_KIND_COLOR,
    TOOLTIPS: TOOLTIPS,
    synapseFamily: synapseFamily, familyColor: familyColor,
    kindColor: kindColor, edgeColor: edgeColor,
    relativeTime: relativeTime, escapeHtml: escapeHtml, importanceBar: importanceBar,
    renderImportanceChip: renderImportanceChip,
    renderMarkdown: renderMarkdown,
    tip: tip,
    getToken: getToken, setToken: setToken, loadToken: loadToken,
    authHeaders: authHeaders, apiGet: apiGet, apiJson: apiJson,
    createPaginator: createPaginator,
    showTab: showTab, openDrawer: openDrawer, closeDrawer: closeDrawer,
    clearSearch: clearSearch,
    auditActionClass: auditActionClass,
    toggleMoreMenu: toggleMoreMenu,
    setProposalsBadge: setProposalsBadge,
    refreshProposalsBadge: refreshProposalsBadge,
    on: on, onTabEnter: onTabEnter
  };
})();

window.CO_ENGRAM = CO_ENGRAM;

document.addEventListener('DOMContentLoaded', function() {
  // 加载已保存的 token
  CO_ENGRAM.loadToken();
  // 同步到 token-input(如果存在)
  var tokenInput = document.getElementById('token-input');
  if (tokenInput) {
    tokenInput.value = CO_ENGRAM.getToken();
    tokenInput.addEventListener('input', function(ev) {
      CO_ENGRAM.setToken(ev.target.value);
    });
  }

  // tab 点击切换(跳过 more-menu-trigger,它有 .tab class 是为了复用样式,
  // 但没有 data-tab,不能让 showTab(undefined) 把所有 panel 都置为 inactive)
  document.querySelectorAll('.tab').forEach(function(btn) {
    if (btn.id === 'more-menu-trigger') return;
    if (!btn.dataset.tab) return;
    btn.addEventListener('click', function() { CO_ENGRAM.showTab(btn.dataset.tab); });
  });

  // 「更多」下拉:点击触发器 toggle;外部点击 / ESC 关闭。
  // 二级 tab 本身带 .tab class,click 已由上面 handler 处理 → 切 tab 后 showTab 内部会关闭下拉。
  var moreTrigger = document.getElementById('more-menu-trigger');
  if (moreTrigger) {
    moreTrigger.addEventListener('click', function(e) {
      e.stopPropagation();
      CO_ENGRAM.toggleMoreMenu();
    });
  }
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('more-menu');
    if (menu && !menu.contains(e.target)) CO_ENGRAM.toggleMoreMenu(false);
    // REM/Deep/Light 修改项 + REM 模式提炼:点击 rem-mod-item
    var remItem = e.target.closest('.rem-mod-item');
    if (remItem && remItem.dataset.engramId) {
      if (remItem.dataset.stage === 'pattern') {
        // 模式提炼:直接跳来源记忆(用户要看提炼自哪条记忆)
        CO_ENGRAM.showTab('engrams');
        setTimeout(function() { CO_ENGRAM_ENGRAMS.open(remItem.dataset.engramId); }, 50);
      } else {
        CO_ENGRAM.openModifiedCard(remItem);
      }
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') CO_ENGRAM.toggleMoreMenu(false);
  });

  // 默认显示 stats
  CO_ENGRAM.showTab('stats');

  // 搜索栏:ID 绑定(仅在 stats tab 内)
  var searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      var input = document.getElementById('search-input');
      var q = (input && input.value) ? input.value.trim() : '';
      if (!q) return;
      var resultsEl = document.getElementById('search-results');
      if (!resultsEl) return;
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = '<div class="empty">' + CO_ENGRAM_T.t('viewer.search.searching') + '</div>';
      fetch('/api/search?q=' + encodeURIComponent(q), { headers: CO_ENGRAM.authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.results || data.results.length === 0) {
            resultsEl.innerHTML = '<div class="empty">' + CO_ENGRAM_T.t('viewer.search.noResults') + '</div>';
            return;
          }
          resultsEl.innerHTML = '<div class="grid cols-3">' + data.results.map(function(r) {
            var e = r.entry || r.engram || r;
            var id = CO_ENGRAM.escapeHtml(e.id || '');
            var title = CO_ENGRAM.escapeHtml(e.title || e.id || '');
            var kind = e.kind || '';
            var kindLabel = CO_ENGRAM_T.enumLabel('kind', kind) || kind || '—';
            var kindTip = CO_ENGRAM.tip ? CO_ENGRAM.tip('kind.' + kind) : '';
            return '<div class="card">'
              + '<div class="card-title" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + id + '\\')">' + title + '</div>'
              + '<div><span class="chip kind-' + kind + '"' + kindTip + '>' + CO_ENGRAM.escapeHtml(kindLabel) + '</span></div>'
              + '</div>';
          }).join('') + '</div>';
        })
        .catch(function(err) {
          resultsEl.innerHTML = '<div class="empty">' + CO_ENGRAM_T.t('viewer.search.failed', { err: CO_ENGRAM.escapeHtml(String(err.message || err)) }) + '</div>';
        });
    });
  }

  // drawer close
  var drawerClose = document.querySelector('#detail-drawer .drawer-close');
  if (drawerClose) drawerClose.addEventListener('click', function() { CO_ENGRAM.closeDrawer(); });
  // ESC 关 drawer
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') CO_ENGRAM.closeDrawer();
  });
});
`;
