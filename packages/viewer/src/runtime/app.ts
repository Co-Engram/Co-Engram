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
  const SYNAPSE_FAMILY = {
    extends: 'structural', part_of: 'structural', similar_to: 'structural',
    depends_on: 'causal', causes: 'causal', follows: 'causal',
    derives_from: 'evidential', contradicts: 'evidential', exemplifies: 'evidential',
    supersedes: 'temporal', consolidates: 'temporal',
    contextualizes: 'modulatory'
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
    contextualizes: '#6b7280' // 灰
  };

  // === 术语提示(鼠标悬停时显示) ===
  // key 命名约定:{category}.{value},与 CO_ENGRAM_LABELS 对齐。
  const TOOLTIPS = {
    kind: {
      fact: '事实 (fact):被确认成立、可独立验证的客观陈述。例:"项目使用 PostgreSQL 14"。',
      observation: '观察 (observation):一次性感知到的事实,可能尚未沉淀为稳定结论。例:"今天 CI 跑了 12 分钟"。',
      pattern: '模式 (pattern):从多次观察归纳出的规律,可预测未来行为。例:"每周一早上构建时间会变长"。',
      procedure: '流程 (procedure):步骤序列,执行后可复现某结果。例:"发布前需跑 pnpm check"。',
      hypothesis: '假设 (hypothesis):待验证的猜测;在反例出现前可作工作假设。例:"慢查询可能源于缺失索引"。'
    },
    status: {
      active: '活跃 (active):近期被检索或强化,在召回池中权重高。',
      dormant: '休眠 (dormant):长期未被检索,权重已衰减但未遗忘。',
      forgotten: '已遗忘 (forgotten):维护阶段主动遗忘,文件仍在但默认不召回。',
      archived: '已归档 (archived):冷归档状态,仅用于历史回溯。'
    },
    freshness: {
      fresh: '鲜活 (fresh):ageDays ≤ halfLife,最近被有效强化过,在召回池中权重最高。',
      aging: '渐衰 (aging):halfLife < ageDays ≤ halfLife×2,权重正在下降,建议尽快强化。',
      stale: '过时 (stale):halfLife×2 < ageDays ≤ halfLife×4,长期未强化,候选遗忘对象。',
      forgotten: '遗忘 (forgotten):ageDays > halfLife×4,默认移出召回池(文件保留,Git 可追溯)。'
    },
    visibility: {
      public: '公开 (public):所有人/所有 agent 可见。',
      team: '团队 (team):仅同团队可见。',
      private: '私有 (private):仅创建者可见。',
      restricted: '受限 (restricted):需特定权限才能查看。'
    },
    synapse: {
      extends: '扩展 (extends) · 结构族:A 在 B 基础上扩展,继承 B 的语义并新增维度。',
      part_of: '部分 (part_of) · 结构族:A 是 B 的组成部分(B has-a A)。',
      similar_to: '相似 (similar_to) · 结构族:A 与 B 语义相近,可互换或互援。',
      depends_on: '依赖 (depends_on) · 因果族:A 的成立依赖 B(B 是 A 的前置条件)。',
      causes: '导致 (causes) · 因果族:A 触发或产生 B(正向因果)。',
      follows: '顺承 (follows) · 因果族:A 在时间/逻辑上跟随 B(无强因果)。',
      derives_from: '派生 (derives_from) · 证据族:A 从 B 推导而来(B 是依据)。',
      contradicts: '矛盾 (contradicts) · 证据族:A 与 B 相互冲突,进入裁决流程。',
      exemplifies: '例证 (exemplifies) · 证据族:A 是 B 的具体实例/样本。',
      supersedes: '取代 (supersedes) · 时间族:A 取代过时的 B(版本更迭)。',
      consolidates: '整合 (consolidates) · 时间族:A 合并/精炼了 B 的内容。',
      contextualizes: '上下文 (contextualizes) · 调节族:A 为 B 提供情境背景(非因果、非证据)。'
    },
    family: {
      structural: '结构族 (structural):描述知识间的组成/扩展关系。蓝色。',
      causal: '因果族 (causal):描述触发/依赖关系。橙色。',
      evidential: '证据族 (evidential):描述来源/冲突关系。绿色(矛盾单独标红)。',
      temporal: '时间族 (temporal):描述版本/演化关系。紫色。',
      modulatory: '调节族 (modulatory):描述情境上下文关系。灰色。'
    },
    synapseDirection: {
      directional: '单向 (directional):A → B,关系仅从源指向目标。',
      bidirectional: '双向 (bidirectional):A ↔ B,关系对称适用。'
    },
    resolution: {
      pending: '待处理 (pending):已检测到矛盾,等待裁决。',
      auto_resolved: '已自动裁决 (auto_resolved):阶段 1,LLM 自动给出裁决。',
      escalated: '已升级 (escalated):阶段 2,升级到归属人裁决。',
      contested: '有争议 (contested):阶段 3,超时未响应,附警告。',
      resolved: '已解决 (resolved):人工或自动最终结案。'
    },
    importance: '重要性 (importance):0-1 数值,越高在召回池中权重越大。由初始设置 + 强化信号 + 衰减综合得出。',
    confidence: '置信度 (confidence):0-1 数值,反映该记忆成立的可信程度(与重要性独立)。',
    retrievalCount: '检索次数 (retrievalCount):该记忆被搜索/召回命中的总次数。',
    effectiveRetrievals: '有效检索 (effectiveRetrievals):命中后被实际采用(非过滤掉)的次数。',
    failedUses: '失败使用 (failedUses):命中后被报告"无效/过时"的次数。失败过多会触发遗忘。',
    reinforcementScore: '强化分数 (reinforcementScore):累计的正向强化信号。',
    emotionalValence: {
      positive: '积极 (positive):该记忆编码时带有正向情绪(成功/赞赏/解决)。强化权重略高。',
      negative: '消极 (negative):该记忆编码时带有负向情绪(失败/警告/反驳)。用于警示未来决策。',
      neutral: '中性 (neutral):编码时无明显情绪倾向,纯陈述性记忆。'
    },
    sourceType: {
      firsthand: '一手 (firsthand):亲历/直接观测,可信度最高。',
      secondhand: '二手 (secondhand):转述/文档/他人经验,需交叉验证。',
      inferred: '推断 (inferred):从其他记忆归纳得出,无直接证据。'
    },
    verification: {
      unverified: '未验证 (unverified):新创建,尚未通过元认知评分。',
      plausible: '貌似成立 (plausible):overall ≥ 0.4,初步通过但仍有不确定性。',
      probable: '较可能 (probable):overall ≥ 0.6,经多次检索未出现反例。',
      verified: '已验证 (verified):overall ≥ 0.8 或人工确认,可作为决策依据。',
      refuted: '已反驳 (refuted):出现强反例或元认知评分极低,不应再作依据。'
    },
    decayHalfLifeDays: '衰退半衰期 (decayHalfLifeDays):importance 每经过 N 天衰减一半。null 表示永不衰退。',
    lastEffectiveAt: '最近一次有效 (lastEffectiveAt):该记忆最后一次被实际采纳/强化成功的时间戳。',
    evidenceCount: '证据数量 (evidenceCount):支撑该记忆的独立证据条数(突触 + 元数据)。',
    encodingContext: '记忆产生情境 (encodingContext):记忆创建时的背景描述,用于情境依赖回忆。',
    perspective: '视角 (perspective):该记忆的观察视角标识(多视角保留机制,spec §5.3)。',
    importanceVector: '多维重要性 (importanceVector):把 importance 拆解为 5 个独立维度,便于精细化调控。',
    importanceDim: {
      personal: '个人维度 (personal):对当前用户的工作关联度。',
      team: '团队维度 (team):对整个团队的协作价值。',
      project: '项目维度 (project):与当前项目目标的契合度。',
      network: '网络维度 (network):基于突触连接数派生,反映知识图谱中心性。',
      temporal: '时间维度 (temporal):基于 lastEffectiveAt + 半衰期派生,近期强化的得分高。'
    }
  };

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

  // === Markdown 渲染(用于 engram/synapse 内容显示)===
  // marked.parse 把 markdown 转 HTML,DOMPurify.sanitize 消毒后返回。
  // 限定 ALLOWED_TAGS 防止 XSS(engram 内容来自 LLM/用户,可能含恶意脚本)。
  // 两个 vendor lib 都通过 vendor/*.ts inline,完全离线。
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
        ALLOW_DATA_ATTR: false
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

  // === Tab 切换 ===
  function showTab(name) {
    CO_ENGRAM_STATE.tab = name;
    document.querySelectorAll('.tab').forEach(function(b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('section.tab-panel').forEach(function(s) {
      s.classList.toggle('active', s.dataset.tab === name);
    });
    CO_ENGRAM.onTabEnter(name);
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
    renderMarkdown: renderMarkdown,
    tip: tip,
    getToken: getToken, setToken: setToken, loadToken: loadToken,
    authHeaders: authHeaders, apiGet: apiGet, apiJson: apiJson,
    showTab: showTab, openDrawer: openDrawer, closeDrawer: closeDrawer,
    clearSearch: clearSearch,
    auditActionClass: auditActionClass,
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

  // tab 点击切换
  document.querySelectorAll('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() { CO_ENGRAM.showTab(btn.dataset.tab); });
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
      resultsEl.innerHTML = '<div class="empty">Searching...</div>';
      fetch('/api/search?q=' + encodeURIComponent(q), { headers: CO_ENGRAM.authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.results || data.results.length === 0) {
            resultsEl.innerHTML = '<div class="empty">无匹配结果</div>';
            return;
          }
          var L = window.CO_ENGRAM_LABELS || {};
          var kindLabelMap = L.kind || {};
          resultsEl.innerHTML = '<div class="grid cols-3">' + data.results.map(function(r) {
            var e = r.entry || r.engram || r;
            var id = CO_ENGRAM.escapeHtml(e.id || '');
            var title = CO_ENGRAM.escapeHtml(e.title || e.id || '');
            var kind = e.kind || '';
            var kindLabel = kindLabelMap[kind] || kind || '—';
            var kindTip = CO_ENGRAM.tip ? CO_ENGRAM.tip('kind.' + kind) : '';
            return '<div class="card">'
              + '<div class="card-title" onclick="CO_ENGRAM_ENGRAMS.open(\\'' + id + '\\')">' + title + '</div>'
              + '<div><span class="chip kind-' + kind + '"' + kindTip + '>' + CO_ENGRAM.escapeHtml(kindLabel) + '</span></div>'
              + '</div>';
          }).join('') + '</div>';
        })
        .catch(function(err) {
          resultsEl.innerHTML = '<div class="empty">Search failed: ' + CO_ENGRAM.escapeHtml(String(err.message || err)) + '</div>';
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
