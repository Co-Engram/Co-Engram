/**
 * Viewer v2 runtime — Graph tab(记忆突触)。
 *
 * 用 vis-network(已内联到 window.vis)渲染力导向图谱。节点按 EngramKind 着色,
 * 边按 SynapseFamily 着色,contradicts 边红色虚线 + resolutionStatus badge。
 *
 * 点击节点 → 节点详情(记忆印迹)
 * 点击边   → 突触详情(可编辑/删除,通过 CO_ENGRAM_SYNAPSES)
 *
 * @module @co-engram/claude-code/viewer/runtime/graph
 */

export const GRAPH_RUNTIME = `
CO_ENGRAM.on('graph', async function renderGraph() {
  const container = document.getElementById('graph-canvas');
  if (!container) return;
  try {
    await renderGraphInner(container);
  } catch (e) {
    console.error('[co-engram] graph render failed:', e);
    container.innerHTML = '<div class="empty"><div class="icon">⚠️</div>' + CO_ENGRAM_T.t('viewer.graph.renderFailed', { err: String((e && e.message) || e) }) + '</div>';
  }
});

async function renderGraphInner(container) {
  const T = CO_ENGRAM_T;
  if (typeof vis === 'undefined' || !vis.Network) {
    container.innerHTML = '<div class="empty"><div class="icon">⚠️</div>' + T.t('viewer.graph.visLoadFailed') + '</div>';
    return;
  }
  if (CO_ENGRAM._graphState && CO_ENGRAM._graphState.initialized) {
    // 已初始化,只 refit
    setTimeout(() => CO_ENGRAM._graphState.network.fit(), 30);
    return;
  }

  let graph;
  try {
    graph = await CO_ENGRAM.apiGet('/api/graph');
  } catch (e) {
    container.innerHTML = '<div class="empty"><div class="icon">⚠️</div>' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>';
    return;
  }

  if (!graph.nodes || graph.nodes.length === 0) {
    container.innerHTML = '<div class="empty"><div class="icon">🕳️</div>' + T.t('viewer.graph.empty') + '</div>';
    return;
  }

  // === 状态:filter ===
  // showKinds: engram 类型(节点过滤);showSynapseKinds: synapse 类型(边过滤,与编辑器一致)
  // textFilter / pathFilter: 顶栏关键词 + 目录前缀过滤(2026-07 新增)
  // minImportance / timeRatio: 重要度阈值 + 时间回放(2026-08 改版,DEMO g2-synapses)
  // focusedId / night: 聚焦邻域(边流动 + 非邻居淡出)/ 夜览
  const ALL_SYNAPSE_KINDS = ['extends', 'part_of', 'similar_to', 'depends_on', 'causes', 'follows', 'derives_from', 'contradicts', 'exemplifies', 'supersedes', 'consolidates', 'contextualizes'];
  // 关系族 → kinds(DEMO 图例的「关系族」行,点选整族)
  const FAMILIES = [
    ['structural', ['extends', 'part_of', 'similar_to']],
    ['causal', ['depends_on', 'causes', 'follows']],
    ['evidential', ['derives_from', 'contradicts', 'exemplifies']],
    ['temporal', ['supersedes', 'consolidates']],
    ['modulatory', ['contextualizes']],
  ];
  const KIND_ORDER = ['observation', 'fact', 'pattern', 'procedure', 'hypothesis', 'skill'];
  const state = {
    showKinds: { fact: true, observation: true, pattern: true, procedure: true, hypothesis: true, skill: true },
    showSynapseKinds: Object.fromEntries(ALL_SYNAPSE_KINDS.map(k => [k, true])),
    physicsEnabled: true,
    textFilter: '',
    pathFilter: '',
    minImportance: 0,
    timeRatio: 1,
    focusedId: null,
    night: false,
    timeRange: null,
    // 2026-08 DEMO 校准:着色模式(结构/活力/冲突/热力)+ 状态筛选
    colorMode: 'structure',
    statusFilter: 'active'
  };
  CO_ENGRAM._graphState = { initialized: false, network: null, data: graph, state };

  // 时间回放:节点 createdAtMs 的时间跨度(无任何 createdAtMs 时为 null → 滑杆不生效)
  (function computeTimeRange() {
    let min = Infinity, max = -Infinity;
    for (const n of graph.nodes) {
      if (typeof n.createdAtMs === 'number' && n.createdAtMs > 0) {
        if (n.createdAtMs < min) min = n.createdAtMs;
        if (n.createdAtMs > max) max = n.createdAtMs;
      }
    }
    state.timeRange = (min !== Infinity && max > min) ? { min, max } : null;
  })();
  function timeCutoffMs() {
    if (!state.timeRange || state.timeRatio >= 1) return null;
    return state.timeRange.min + (state.timeRange.max - state.timeRange.min) * state.timeRatio;
  }
  // 重要度 + 时间回放共同过滤(与 buildNodes / _refreshFilterCount 同一谓词)
  function passesImpTime(n) {
    const imp = n.importance != null ? n.importance : 0.5;
    if (imp < state.minImportance) return false;
    const cut = timeCutoffMs();
    if (cut != null && !(typeof n.createdAtMs === 'number' && n.createdAtMs > 0 && n.createdAtMs <= cut)) return false;
    return true;
  }

  // 状态过滤(DEMO fselect):仅活跃 / 含归档 / 仅矛盾待裁决。
  // 旧缓存无 status 字段的节点放行(与时间回放同一兼容策略)。
  function statusPassSet() {
    if (state.statusFilter === 'contradictions') {
      const keep = new Set();
      for (const e of graph.edges) {
        if (e.kind === 'contradicts') { keep.add(e.from); keep.add(e.to); }
      }
      return keep;
    }
    return null;
  }
  function passesStatus(n, contraSet) {
    if (state.statusFilter === 'all') return true;
    if (state.statusFilter === 'contradictions') return contraSet.has(n.id);
    // 'active'(默认)
    return !n.status || n.status === 'active';
  }

  // 着色模式(DEMO modes):结构=类型色 / 活力=取用次数渐变 /
  // 冲突=矛盾相关红 + 其余灰 / 热力=取用新近度渐变
  const _contraNodeSet = new Set();
  for (const e of graph.edges) {
    if (e.kind === 'contradicts') { _contraNodeSet.add(e.from); _contraNodeSet.add(e.to); }
  }
  function lerpColor(a, b, t) {
    const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  let _vitalityMax = 1;
  for (const n of graph.nodes) {
    if (typeof n.retrievalCount === 'number' && n.retrievalCount > _vitalityMax) _vitalityMax = n.retrievalCount;
  }
  // 2026-08 用户反馈「效果不明显」根因:log1p(count)/log1p(max) 把中位数拉到
  // ~0.6、前四分位挤在 0.3-0.74,叠加端点 #C9C4B8→#2563EB 中段是不饱和灰蓝,
  // 梯度视觉上糊成一片。改用「百分位名次」映射(rank/(N-1)):与分布无关,
  // 任何数据都铺满整个梯度;端点换成近纸米白 → 饱和深蓝,对比拉满。
  // count=0 恒 t=0(从未取用统一最浅)。
  const _vitalityCounts = graph.nodes
    .map(n => (typeof n.retrievalCount === 'number' ? n.retrievalCount : 0))
    .sort((a, b) => a - b);
  function vitalityT(n) {
    const c = typeof n.retrievalCount === 'number' ? n.retrievalCount : 0;
    if (c <= 0) return 0;
    // 名次 = counts 中 <c 的个数 + 同值半距(并列取中位名次,稳定)
    let lo = 0, hi = _vitalityCounts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (_vitalityCounts[mid] < c) lo = mid + 1; else hi = mid; }
    let first = lo;
    hi = _vitalityCounts.length;
    let l2 = first;
    while (l2 < hi && _vitalityCounts[l2] === c) l2++;
    const rank = (first + (l2 - 1)) / 2;
    return _vitalityCounts.length > 1 ? rank / (_vitalityCounts.length - 1) : 1;
  }
  function nodeColorFor(n) {
    const isSkillNode = n.kind === 'skill';
    if (state.colorMode === 'vitality' && !isSkillNode) {
      return lerpColor('#EDE9DF', '#1D4ED8', vitalityT(n));
    }
    if (state.colorMode === 'conflict') {
      if (isSkillNode) return '#a78bfa';
      return _contraNodeSet.has(n.id) ? '#BE3B3B' : '#C9C4B8';
    }
    // 热度:热带内部按 idle 天数连续渐变分层(今天最红 → 7 天橙),
    // 30 天金棕;从未取用单独冷灰 —— 消除「67/91 节点挤同一橙红」的无层次
    if (state.colorMode === 'heat' && !isSkillNode) {
      const DAY = 86400000;
      const idle = n.lastRetrievedAt ? (Date.now() - n.lastRetrievedAt) / DAY : Infinity;
      if (idle <= 7) return lerpColor('#BE3B3B', '#D7730D', Math.min(1, idle / 7));
      if (idle <= 30) return lerpColor('#D7730D', '#B8941D', (idle - 7) / 23);
      if (idle <= 90) return '#B8941D';
      return '#8B857B';
    }
    return isSkillNode ? '#a78bfa' : CO_ENGRAM.kindColor(n.kind);
  }

  // === 节点匹配文本/路径过滤(顶栏) ===
  // textFilter: 标题/domainTags/id 包含关键词则保留
  // pathFilter: 用 id→path Map 查路径后做前缀匹配(2026-07 修复 ULID id 假设)
  //   pathFilter === '' 时仅匹配 path 无 '/' 的根级 engram
  //   pathFilter !== '' 时匹配 path === pathFilter 或 path 以 pathFilter + '/' 开头
  function matchesNodeFilters(n) {
    if (state.pathFilter !== '') {
      const locMap = CO_ENGRAM._engramLocations;
      const ep = locMap ? locMap.get(n.id) : null;
      if (ep == null) return false;
      if (state.pathFilter === '') {
        if (ep.includes('/')) return false;
      } else if (ep !== state.pathFilter && !ep.startsWith(state.pathFilter + '/')) {
        return false;
      }
    }
    if (state.textFilter) {
      const q = state.textFilter.toLowerCase();
      const title = (n.title || '').toLowerCase();
      const tags = (n.domainTags || []).join(' ').toLowerCase();
      const id = (n.id || '').toLowerCase();
      if (!title.includes(q) && !tags.includes(q) && !id.includes(q)) return false;
    }
    return true;
  }

  // === 节点 / 边构建 ===
  function nodeFontColor() {
    return state.night ? '#C6D0EC' : getComputedStyle(document.body).color;
  }
  // 舞台底色(DEMO --sv-bg):节点描边圈与标签 halo 都取它,让节点从画布里"浮"出来
  function stageBg() {
    return state.night ? '#0A0D1C' : '#F7F4EC';
  }
  function nodeBorderColor() {
    return state.night ? '#DFE6F5' : '#2D2A26';
  }
  function buildNodes() {
    const contraSet = statusPassSet();
    return graph.nodes
      .filter(n => state.showKinds[n.kind] !== false)
      .filter(n => matchesNodeFilters(n))
      .filter(n => passesImpTime(n))
      .filter(n => passesStatus(n, contraSet))
      .map(n => {
        const importance = (n.importance != null ? n.importance : 0.5);
        const size = 10 + importance * 18;
        const nodeColor = nodeColorFor(n);
        const kindLabel = T.enumLabel('kind', n.kind) || n.kind;
        const kindTip = (CO_ENGRAM.TOOLTIPS && CO_ENGRAM.TOOLTIPS.kind && CO_ENGRAM.TOOLTIPS.kind[n.kind]) || '';
        const tipText = n.title + '\\n[' + kindLabel + ' / ' + n.kind + ']\\n' + T.t('viewer.graph.tagsLabel') + (n.domainTags || []).join(', ') + (kindTip ? '\\n\\n' + kindTip : '');
        return {
          id: n.id,
          label: n.title.length > 32 ? n.title.slice(0, 30) + '…' : n.title,
          title: tipText,
          group: n.kind,
          color: {
            background: nodeColor,
            border: stageBg(),
            // 字符串形式(非对象):hover/highlight = 填充色,强制覆盖 vis 默认
            highlight: nodeColor,
            hover: nodeColor
          },
          size,
          // DEMO .nlabel:paint-order stroke 纸色 halo(vis 用 strokeWidth/strokeColor 等价实现)
          font: { color: nodeFontColor(), size: 11, face: 'sans-serif', strokeWidth: 3, strokeColor: stageBg() },
          shape: n.kind === 'skill' ? 'diamond' : 'dot',
          _raw: n
        };
      });
  }

  function buildEdges() {
    // 过滤后保留的节点 id 集合(边的两端都需通过与节点同一套过滤:类型/文本/路径/重要度/时间/状态)
    const contraSet = statusPassSet();
    const passNodeFilter = new Set(
      graph.nodes
        .filter(n => state.showKinds[n.kind] !== false)
        .filter(n => matchesNodeFilters(n))
        .filter(n => passesImpTime(n))
        .filter(n => passesStatus(n, contraSet))
        .map(n => n.id),
    );
    const out = [];
    for (const e of graph.edges) {
      // 按 12 kind 过滤(与编辑器一致)
      if (state.showSynapseKinds[e.kind] === false) continue;
      // 顶栏过滤:边两端节点必须都通过(任一端被过滤掉,边就不再有意义显示)
      if (!passNodeFilter.has(e.from) || !passNodeFilter.has(e.to)) continue;

      const isContra = e.kind === 'contradicts';
      const color = CO_ENGRAM.edgeColor(e.kind);
      const kindLabel = T.enumLabel('synapseKind', e.kind) || e.kind;
      const family = CO_ENGRAM.synapseFamily(e.kind);
      const familyLabel = T.enumLabel('family', family) || family;
      const synTip = (CO_ENGRAM.TOOLTIPS && CO_ENGRAM.TOOLTIPS.synapse && CO_ENGRAM.TOOLTIPS.synapse[e.kind]) || '';
      const resLabel = e.resolutionStatus ? ' · ' + T.t('viewer.graph.resolutionLabel') + (T.enumLabel('resolution', e.resolutionStatus) || e.resolutionStatus) : '';
      const tipText = kindLabel + ' (' + e.kind + ') · ' + familyLabel + T.t('viewer.graph.familySuffix') + '\\n' + T.t('viewer.graph.weightLabel') + ' ' + (e.weight != null ? e.weight.toFixed(2) : '?') + ' · ' + T.t('viewer.graph.evidenceLabel') + ' ' + (e.evidenceCount || 0) + resLabel + '\\n' + T.t('viewer.graph.directionLabel') + (e.direction || 'directional') + (synTip ? '\\n\\n' + synTip : '') + '\\n\\n[' + T.t('viewer.graph.clickToEdit') + ']';
      out.push({
        id: e.id,
        from: e.from,
        to: e.to,
        label: '',
        title: tipText,
        // DEMO 边风格:普通边低不透明度暖灰调(quiet,不与节点抢注意力);
        // contradicts 失效边虚线红 #F2708A 全不透明。悬停/高亮才亮起全色。
        color: isContra
          ? { color: '#F2708A', highlight: '#F2708A', hover: '#F2708A', opacity: 1 }
          : { color, highlight: color, hover: color, opacity: 0.35 },
        width: 1 + (e.weight || 0.5) * 2,
        dashes: isContra,
        arrows: e.direction === 'bidirectional' ? { to: { enabled: true }, from: { enabled: true } } : { to: { enabled: true, scaleFactor: 0.6 } },
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
        _raw: e
      });
    }
    return out;
  }

  // === 初始化 vis-network ===
  const nodesDataset = new vis.DataSet(buildNodes());
  const edgesDataset = new vis.DataSet(buildEdges());

  const options = {
    autoResize: true,
    height: '100%',
    width: '100%',
    // DEMO 节点:纸色描边圈 2.5px,扁平无阴影(旧 shadow 是暗色主题残留)
    // 2026-08 用户两轮反馈「点击画布后变带外圈的颜色」—— 两个来源一并根治:
    //   1. vis 默认 borderWidthSelected=6:选中时描边 2.5→6 加粗成环 → 与普通态同宽
    //   2. highlight 色(batches 前已与普通态对齐)
    // chosen:false 兜底关闭其余选中/悬停默认视觉增量;点击只触发交互不改外观。
    // hover:true 后此开关同时冻结「悬停节点换 hover 色 + label 加粗」的 vis 默认增量
    nodes: { borderWidth: 2.5, borderWidthSelected: 2.5, shadow: { enabled: false }, chosen: false },
    edges: { smooth: { type: 'continuous' }, selectionWidth: 1 },
    // 大规模图(1000+ 节点)物理引擎优化(2026-07):
    //   1. solver 切 barnesHut — O(n log n) vs forceAtlas2Based 的 O(n²),
    //      1000 节点级别单步模拟快 5-10×
    //   2. stabilization 收敛后 physics.enabled=false — 消除空载 CPU,
    //      节点位置冻结,但交互(拖拽 / 缩放 / 点击)不受影响
    physics: {
      enabled: true,
      solver: 'barnesHut',
      barnesHut: {
        gravitationalConstant: -8000,
        centralGravity: 0.3,
        springLength: 95,
        springConstant: 0.04,
        damping: 0.09,
        avoidOverlap: 0.1
      },
      stabilization: {
        enabled: true,
        iterations: 150,
        updateInterval: 25,
        fit: true
      }
    },
    // hover:true 是悬停邻边高亮的必要条件 —— vis 只在 interaction.hover 开启时才派发
    // hoverNode/blurNode 事件(2026-08「邻居高亮失效」根因:此前 hover:false 让下方
    // handler 一直是死代码)。hoverConnectedEdges:false —— 邻边强调由自定义 handler
    // 全权负责:原生只把邻边换成 hover 色(=普通色,无对比)且会叠加 hoverWidth 双重加粗。
    interaction: { hover: true, selectable: false, tooltipDelay: 100, navigationButtons: false, keyboard: false, selectConnectedEdges: false, hoverConnectedEdges: false }
  };

  const network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);
  CO_ENGRAM._graphState.network = network;
  CO_ENGRAM._graphState.initialized = true;
  CO_ENGRAM._graphState.nodes = nodesDataset;
  CO_ENGRAM._graphState.edges = edgesDataset;

  // 物理稳态后冻结布局:消除空载 CPU(1000+ 节点持续模拟让 tab 切换卡顿)。
  // 用户仍可拖拽单个节点(松开后不回弹,因 physics 已停),zoom / pan 不受影响。
  // 需重新启用物理时由工具栏 togglePhysics 按钮触发。
  network.once('stabilizationIterationsDone', function() {
    try {
      network.setOptions({ physics: { enabled: false } });
      state.physicsEnabled = false;
    } catch (e) { /* 防御:某些 vis 版本 setOptions 在 frozen 状态抛错 */ }
  });

  // ============================================================
  // 2026-08 改版(DEMO g2-synapses):SVG 覆盖层演示效果
  //   - Louvain 簇呼吸凸包 + 簇标签
  //   - 高重要度(≥0.7)节点发光脉冲光环
  //   - 聚焦邻域流动边
  // 实现方式:vis-network canvas 不支持逐帧动效,全部动效画在
  // pointer-events:none 的 SVG 覆盖层上 —— 呼吸/脉冲/流动用 CSS 动画
  // (GPU 合成,零 canvas 重绘);位置在 afterDrawing(pan/zoom/drag/过滤)
  // 时经 rAF 节流重算,canvasToDOM 把网络坐标映射到覆盖层坐标。
  // ============================================================
  const SVGNS = 'http://www.w3.org/2000/svg';
  function ensureOverlay() {
    let svg = document.getElementById('graph-overlay-svg');
    if (!svg) {
      svg = document.createElementNS(SVGNS, 'svg');
      svg.id = 'graph-overlay-svg';
      svg.setAttribute('class', 'graph-overlay');
      container.appendChild(svg);
    }
    return svg;
  }

  // Louvain 社区发现(过滤后当前图上运行;稀疏图 81~914 节点毫秒级)
  function recomputeClusters() {
    const nodes = nodesDataset.get();
    const edges = edgesDataset.get();
    if (nodes.length < 3 || !edges.length) { CO_ENGRAM._graphClusters = []; return; }
    const assign = CO_ENGRAM_LOUVAIN(
      nodes.map(n => n.id),
      edges.map(e => ({ from: e.from, to: e.to, weight: (e._raw && e._raw.weight != null) ? e._raw.weight : 0.5 })),
    );
    const groups = new Map();
    for (const n of nodes) {
      const c = assign.get(n.id);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(n);
    }
    CO_ENGRAM._graphClusters = Array.from(groups.values())
      .filter(g => g.length >= 3) // ≥3 节点才画凸包;散点/两点对不画
      .map(members => {
        // 簇标签:成员最常见 domainTag + 节点数(DEMO:「方法论 · 9」)
        const tagCount = new Map();
        for (const m of members) {
          for (const tg of (m._raw.domainTags || [])) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
        }
        let bestTag = '', bestN = 0;
        for (const [tg, c2] of tagCount) { if (c2 > bestN) { bestN = c2; bestTag = tg; } }
        return { members, label: (bestTag || (T.enumLabel('kind', members[0]._raw.kind) || members[0]._raw.kind)) + ' · ' + members.length };
      });
  }

  function refreshOverlay() {
    if (container.offsetParent === null && container.clientWidth === 0) return; // tab 隐藏时跳过
    const svg = ensureOverlay();
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    let inner = '';
    const positions = network.getPositions();
    const domOf = id => {
      const p = positions[id];
      if (!p) return null;
      const d = network.canvasToDOM({ x: p.x, y: p.y });
      return { x: d.x, y: d.y };
    };
    const clusters = CO_ENGRAM._graphClusters || [];
    // 1) Louvain 簇呼吸凸包(DEMO:蓝/绿/橙三色虚线轮换呼吸)
    clusters.forEach((cl, ci) => {
      const pts = cl.members.map(m => domOf(m.id)).filter(Boolean);
      if (pts.length < 3) return;
      const hull = CO_ENGRAM_CONVEX_HULL(pts);
      if (hull.length < 3) return;
      const cls = 'hull' + (ci % 3 === 1 ? ' h2' : ci % 3 === 2 ? ' h3' : '');
      inner += '<path class="' + cls + '" d="' + CO_ENGRAM_HULL_PATH(hull, 26) + '"></path>';
    });
    // 2) 聚焦邻域流动边(DEMO .flow:邻接边虚线流动)
    if (state.focusedId) {
      for (const e of edgesDataset.get()) {
        if (e.from !== state.focusedId && e.to !== state.focusedId) continue;
        const a = domOf(e.from), b = domOf(e.to);
        if (!a || !b) continue;
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
        const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
        inner += '<path class="flow" stroke="#0F766E" d="M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1)
          + ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1) + '"></path>';
      }
    }
    // 3) 簇标签(最上层)
    for (const cl of clusters) {
      const pts = cl.members.map(m => domOf(m.id)).filter(Boolean);
      if (pts.length < 3) continue;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      inner += '<text class="cluster-lab" x="' + cx.toFixed(0) + '" y="' + (cy - 8).toFixed(0) + '" text-anchor="middle">' + CO_ENGRAM.escapeHtml(cl.label) + '</text>';
    }
    svg.innerHTML = inner;
  }
  let _overlayQueued = false;
  function queueRefreshOverlay() {
    if (_overlayQueued) return;
    _overlayQueued = true;
    requestAnimationFrame(() => { _overlayQueued = false; refreshOverlay(); });
  }
  network.on('afterDrawing', queueRefreshOverlay);

  // 滑杆 / 夜览标签刷新
  function updateSliderLabels() {
    const impVal = document.getElementById('graph-imp-val');
    const visible = nodesDataset.length;
    if (impVal) impVal.textContent = '≥ ' + state.minImportance.toFixed(2) + ' · ' + visible + ' ' + T.t('viewer.graph.filter.visibleUnit');
    const tlVal = document.getElementById('graph-time-val');
    if (tlVal) {
      if (state.timeRatio >= 1) {
        tlVal.textContent = T.t('viewer.graph.replay.full', { n: visible });
      } else if (!state.timeRange) {
        tlVal.textContent = T.t('viewer.graph.replay.noData');
      } else {
        tlVal.textContent = new Date(timeCutoffMs()).toISOString().slice(0, 10) + ' · ' + visible;
      }
    }
  }
  recomputeClusters();
  updateSliderLabels();
  queueRefreshOverlay();

  // ============================================================
  // 左侧图例(DEMO .legend):KIND 点选筛选行 + 关系族行,带计数。
  // 点击整行 toggle(行 off 时降透明度);族行 toggle 该族全部 kinds。
  // ============================================================
  function renderLegend() {
    const T = CO_ENGRAM_T;
    const kindsEl = document.getElementById('legend-kinds');
    const famsEl = document.getElementById('legend-families');
    if (!kindsEl || !famsEl) return;
    const kindCount = {};
    for (const n of graph.nodes) kindCount[n.kind] = (kindCount[n.kind] || 0) + 1;
    let kh = '';
    for (const k of KIND_ORDER) {
      const on = state.showKinds[k] !== false;
      kh += '<div class="fk' + (on ? '' : ' off') + '" onclick="CO_ENGRAM_GRAPH.toggleKind(\\'' + k + '\\', ' + (!on) + ')">'
        + '<span class="d" style="background:' + (k === 'skill' ? '#a78bfa' : CO_ENGRAM.kindColor(k)) + '"></span>'
        + CO_ENGRAM.escapeHtml(T.enumLabel('kind', k) || k)
        + '<span class="c">' + (kindCount[k] || 0) + '</span></div>';
    }
    kindsEl.innerHTML = kh;
    const famEdgeCount = {};
    for (const e of graph.edges) {
      const fam = CO_ENGRAM.synapseFamily(e.kind);
      famEdgeCount[fam] = (famEdgeCount[fam] || 0) + 1;
    }
    let fh = '';
    for (const [fam, kinds] of FAMILIES) {
      const on = kinds.every(k => state.showSynapseKinds[k] !== false);
      fh += '<div class="fk' + (on ? '' : ' off') + '" onclick="CO_ENGRAM_GRAPH.toggleFamily(\\'' + fam + '\\', ' + (!on) + ')">'
        + '<span class="d sq" style="background:' + CO_ENGRAM.familyColor(fam) + '"></span>'
        + CO_ENGRAM.escapeHtml(T.enumLabel('family', fam) || fam)
        + '<span class="c">' + (famEdgeCount[fam] || 0) + '</span></div>';
    }
    famsEl.innerHTML = fh;
  }

  renderLegend();

  // 顶栏 chip + 计数初始显示
  CO_ENGRAM_GRAPH._refreshTextChip();
  CO_ENGRAM_GRAPH._refreshPathChip();
  CO_ENGRAM_GRAPH._refreshFilterCount();

  // === 交互 ===
  // 悬停邻边高亮(常开,2026-08 修复:根因 interaction.hover:false 导致事件从未触发,
  // 修复后移除功能栏开关,不再暴露给用户选择):悬停节点 → 邻接边全亮加粗,其余边淡出
  // 到 0.08;移开恢复。聚焦邻域时让位(已有更强的淡出)。
  function applyHoverEmphasis(nid) {
    const conn = new Set();
    for (const e of graph.edges) {
      if (e.from === nid || e.to === nid) conn.add(e.id);
    }
    edgesDataset.update(edgesDataset.get().map(e2 => ({
      id: e2.id,
      opacity: conn.has(e2.id) ? 1 : 0.08,
      width: conn.has(e2.id) ? baseEdgeWidth(e2) + 1 : baseEdgeWidth(e2),
    })));
  }
  network.on('hoverNode', (params) => {
    if (state.focusedId) return;
    applyHoverEmphasis(params.node);
  });
  network.on('blurNode', () => {
    if (state.focusedId) return;
    edgesDataset.update(edgesDataset.get().map(e2 => ({
      id: e2.id,
      opacity: baseEdgeOpacity(e2),
      width: baseEdgeWidth(e2),
    })));
  });
  network.on('click', (params) => {
    // selectable:false → params.nodes/edges 为空,手动检测点击位置
    let nodeId = params.nodes?.[0] || null;
    let edgeId = params.edges?.[0] || null;
    if (!nodeId && !edgeId && params.pointer?.DOM) {
      const dom = params.pointer.DOM;
      nodeId = network.getNodeAt(dom);
      if (!nodeId) edgeId = network.getEdgeAt(dom);
    }
    if (edgeId) {
      const edge = edgesDataset.get(edgeId);
      if (edge && edge._raw) {
        CO_ENGRAM_SYNAPSES.open(edge._raw.id);
      }
      return;
    }
    if (nodeId) {
      focusNode(nodeId);
      // vis bug:内部选中/悬停逻辑会重置节点颜色(不只被点节点,邻近节点也会)
      // → 延迟恢复全图颜色,盖过 vis 内部异步处理
      restoreAllNodeColors();
      return;
    }
    // 点空白:关闭检查器 + 恢复全图颜色
    resetHighlight();
    restoreAllNodeColors();
  });

  // 2026-08 用户定稿设计:点击节点 → 其他节点淡化(0.13),被点节点保持全亮
  // → 自然突出。但 vis 内部 update({opacity}) 会重置节点颜色为默认浅蓝
  // → 每次更新后必须立即恢复正确颜色(restoreAllNodeColors)。
  function restoreAllNodeColors() {
    // 同步恢复(盖过 nodesDataset.update 触发的 vis 内部颜色重置)
    for (const nid of Object.keys(network.body.nodes)) {
      const vn = network.body.nodes[nid];
      const rawN = graph.nodes.find(n => n.id === nid);
      if (!vn || !vn.options || !vn.options.color || !rawN) continue;
      const c = nodeColorFor(rawN);
      vn.options.color.background = c;
      vn.options.color.border = stageBg();
      if (typeof vn.options.color.highlight === 'object') {
        vn.options.color.highlight.background = c;
        vn.options.color.highlight.border = stageBg();
      } else {
        vn.options.color.highlight = c;
      }
      if (typeof vn.options.color.hover === 'object') {
        vn.options.color.hover.background = c;
        vn.options.color.hover.border = stageBg();
      } else {
        vn.options.color.hover = c;
      }
    }
  }

  function resetHighlight() {
    const wasFocused = state.focusedId !== null;
    state.focusedId = null;
    const insp = document.getElementById('graph-insp');
    if (insp) insp.hidden = true;
    if (!wasFocused) return;
    nodesDataset.update(nodesDataset.get().map(n => ({ id: n.id, opacity: 1.0 })));
    edgesDataset.update(edgesDataset.get().map(e => ({
      id: e.id, opacity: baseEdgeOpacity(e), width: baseEdgeWidth(e)
    })));
    restoreAllNodeColors();
    network.redraw();
    // 复位重写了全部边状态;若鼠标仍停在节点上(vis 不会重发 hoverNode),此处复放悬停强调。
    // hoverObj 是 vis 10.1.0 实例属性(vendor 版本锁定),若未来升级 vis 需复查此访问。
    const stillHovered = network.selectionHandler && network.selectionHandler.hoverObj
      ? Object.keys(network.selectionHandler.hoverObj.nodes)[0]
      : undefined;
    if (stillHovered) applyHoverEmphasis(stillHovered);
  }

  function focusNode(id) {
    state.focusedId = id;
    const connectedNodeIds = new Set([id]);
    const connectedEdgeIds = new Set();
    for (const e of graph.edges) {
      if (e.from === id) { connectedNodeIds.add(e.to); connectedEdgeIds.add(e.id); }
      if (e.to === id) { connectedNodeIds.add(e.from); connectedEdgeIds.add(e.id); }
    }
    // 淡化非邻居(0.13)+ 邻居保持全亮 → 被点节点自然突出
    nodesDataset.update(nodesDataset.get().map(n => ({
      id: n.id,
      opacity: connectedNodeIds.has(n.id) ? 1.0 : 0.13
    })));
    edgesDataset.update(edgesDataset.get().map(e => {
      const hit = connectedEdgeIds.has(e.id);
      return { id: e.id, opacity: hit ? 1.0 : 0.05, width: hit ? baseEdgeWidth(e) + 1.2 : baseEdgeWidth(e) };
    }));
    // vis update 会重置颜色 → 立即恢复
    restoreAllNodeColors();
    network.redraw();
    renderInspector(id);
  }

  /** 边基础不透明度(与 buildEdges 口径一致:contradicts 1.0,其余 0.35) */
  function baseEdgeOpacity(e) {
    return e._raw && e._raw.kind === 'contradicts' ? 1.0 : 0.35;
  }
  /** 边基础宽度(1 + weight×2,与 buildEdges 口径一致) */
  function baseEdgeWidth(e) {
    const w = (e._raw && e._raw.weight != null) ? e._raw.weight : 0.5;
    return 1 + w * 2;
  }

  // ============================================================
  // 右侧检查器(DEMO .insp):点击节点填充;Esc / 点空白关闭。
  // 「打开全文」进印迹详情抽屉(完整编辑能力保留在抽屉)。
  // ============================================================
  async function renderInspector(id) {
    const T = CO_ENGRAM_T;
    const insp = document.getElementById('graph-insp');
    if (!insp) return;
    insp.hidden = false;

    const node = graph.nodes.find(n => n.id === id);
    if (id.indexOf('skill:') === 0) {
      insp.innerHTML = '<span class="kind">SKILL</span>'
        + '<h3>' + CO_ENGRAM.escapeHtml(node ? node.title : id.slice(6)) + '</h3>'
        + '<div class="irow"><span>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.skillNode')) + '</span></div>'
        + '<div class="iacts"><button class="ab" onclick="CO_ENGRAM_SKILLS.open(\\'' + CO_ENGRAM.escapeHtml(id.slice(6)) + '\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.openFull')) + '</button></div>';
      return;
    }

    let detail = null;
    try { detail = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(id)); } catch (e) { /* 降级用 _raw */ }

    const imp = node && node.importance != null ? node.importance : (detail ? detail.importance ?? 0.5 : 0.5);
    const kindColor = node ? nodeColorFor(node) : '#8B857B';
    const outgoing = graph.edges.filter(e => e.from === id);
    const incoming = graph.edges.filter(e => e.to === id);
    const titleById = new Map(graph.nodes.map(n => [n.id, n.title]));
    const cluster = (CO_ENGRAM._graphClusters || []).find(cl => cl.members.some(m => m.id === id));

    let neighHtml = '';
    for (const e of outgoing.concat(incoming)) {
      const other = e.from === id ? e.to : e.from;
      const otherNode = graph.nodes.find(n => n.id === other);
      const kindLabel = T.enumLabel('synapseKind', e.kind) || e.kind;
      neighHtml += '<div class="nl" onclick="CO_ENGRAM_GRAPH.focusById(\\'' + CO_ENGRAM.escapeHtml(other) + '\\')">'
        + '<span class="d" style="background:' + (otherNode ? nodeColorFor(otherNode) : '#8B857B') + '"></span>'
        + '<span class="nl-t">' + CO_ENGRAM.escapeHtml(titleById.get(other) || other) + '</span>'
        + '<span class="ek">' + CO_ENGRAM.escapeHtml(e.kind) + '</span></div>';
    }

    // 2026-08 修复:旧写法把同一份译文 toUpperCase 后再拼一次(zh 下「模式 · 模式」重复)。
    // 徽标 = 英文枚举值(大写)+ 本地化标签,如 PATTERN · 模式 / SKILL · 技能
    insp.innerHTML = '<span class="kind">' + CO_ENGRAM.escapeHtml(String(node ? node.kind : '').toUpperCase() + ' · ' + (T.enumLabel('kind', node ? node.kind : '') || node.kind)) + '</span>'
      + '<h3>' + CO_ENGRAM.escapeHtml(detail ? detail.title : (node ? node.title : id)) + '</h3>'
      + '<div class="irow"><span>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.importanceShort')) + '</span><b>' + imp.toFixed(2)
        + (detail && detail.verificationStatus ? ' · ' + CO_ENGRAM.escapeHtml(T.enumLabel('verificationStatus', detail.verificationStatus) || detail.verificationStatus) : '') + '</b></div>'
      + '<div class="irow"><span>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.retrieval')) + '</span><b>'
        + ((detail && detail.retrievalCount) || (node && node.retrievalCount) || 0) + ' · '
        + ((node && node.lastRetrievedAt) ? CO_ENGRAM.escapeHtml(CO_ENGRAM.relativeTime(node.lastRetrievedAt)) : CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.never'))) + '</b></div>'
      + (cluster ? '<div class="irow"><span>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.cluster')) + '</span><b>' + CO_ENGRAM.escapeHtml(cluster.label) + '</b></div>' : '')
      + '<div class="irow"><span>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.degrees')) + '</span><b>' + incoming.length + ' / ' + outgoing.length + '</b></div>'
      + '<div class="neigh"><h5>' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.neighborhood', { n: outgoing.length + incoming.length })) + '</h5>' + (neighHtml || '<div class="nl">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.noNeighbors')) + '</div>') + '</div>'
      + '<div class="iacts">'
      + '<button class="ab" onclick="CO_ENGRAM.showTab(\\'engrams\\');setTimeout(function(){CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(id) + '\\')},60)">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.openFull')) + '</button>'
      + '<button class="ab" onclick="CO_ENGRAM.showTab(\\'audit\\');setTimeout(function(){var i=document.getElementById(\\'audit-engram\\');if(i){i.value=\\'' + CO_ENGRAM.escapeHtml(id) + '\\';CO_ENGRAM_AUDIT.applyFilter();}},60)">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.auditTrail')) + '</button>'
      + '<button class="ab" onclick="CO_ENGRAM._graphState.resetFocus()">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.insp.back')) + '</button>'
      + '</div>';
  }

  // === 工具栏交互 ===
  CO_ENGRAM._graphState.applyFilters = function() {
    nodesDataset.clear();
    edgesDataset.clear();
    nodesDataset.add(buildNodes());
    edgesDataset.add(buildEdges());
    // 焦点节点被过滤掉时清焦(防流动边指向不存在节点)
    if (state.focusedId && !nodesDataset.get(state.focusedId)) {
      state.focusedId = null;
      const insp = document.getElementById('graph-insp');
      if (insp) insp.hidden = true;
    }
    recomputeClusters();
    updateSliderLabels();
    renderLegend();
    queueRefreshOverlay();
  };
  CO_ENGRAM._graphState.togglePhysics = function() {
    state.physicsEnabled = !state.physicsEnabled;
    network.setOptions({ physics: { enabled: state.physicsEnabled } });
  };
  CO_ENGRAM._graphState.fit = function() { network.fit({ animation: true }); };
  // 重要度阈值滑杆(DEMO imp-slider):0~100 → [0,1],与时间回放 AND 生效。
  // 防抖 120ms:oninput 拖动连续触发,直接 applyFilters 会每帧重建 DataSet +
  // 重跑 Louvain,5000 节点规模拖动卡顿;停止拖动 120ms 后一次性应用。
  let _sliderDebounce = null;
  function debouncedApply() {
    if (_sliderDebounce) clearTimeout(_sliderDebounce);
    _sliderDebounce = setTimeout(() => {
      _sliderDebounce = null;
      CO_ENGRAM._graphState.applyFilters();
      CO_ENGRAM_GRAPH._refreshFilterCount();
    }, 120);
  }
  CO_ENGRAM._graphState.setImportance = function(v) {
    state.minImportance = Math.max(0, Math.min(1, Number(v) / 100));
    const impVal = document.getElementById('graph-imp-val');
    if (impVal) impVal.textContent = '≥ ' + state.minImportance.toFixed(2) + ' …';
    debouncedApply();
  };
  // 时间回放滑杆(DEMO tl):按 createdAt 让图生长;ratio<1 时晚于切点的节点淡出
  CO_ENGRAM._graphState.setTimeReplay = function(v) {
    state.timeRatio = Math.max(0, Math.min(1, Number(v) / 100));
    const tlVal = document.getElementById('graph-time-val');
    if (tlVal && state.timeRange && state.timeRatio < 1) {
      tlVal.textContent = new Date(timeCutoffMs()).toISOString().slice(0, 10) + ' …';
    }
    debouncedApply();
  };
  // 夜览切换(DEMO stage.night):深底色 + 节点标签/光环配色跟随。
  // night 类挂在 .graph-container(舞台)上 —— 点阵底色/浮层配色都由它驱动
  CO_ENGRAM._graphState.toggleNight = function() {
    state.night = !state.night;
    const stage = document.getElementById('graph-stage') || container;
    stage.classList.toggle('night', state.night);
    const btn = document.getElementById('graph-night-btn');
    if (btn) btn.textContent = state.night
      ? '☀️ ' + T.t('viewer.graph.night.disable')
      : '🌙 ' + T.t('viewer.graph.night.enable');
    const fontColor = nodeFontColor();
    nodesDataset.update(nodesDataset.get().map(n => ({
      id: n.id,
      font: { color: fontColor, size: 11, face: 'sans-serif', strokeWidth: 3, strokeColor: stageBg() },
      color: { ...n.color, border: stageBg() }
    })));
    queueRefreshOverlay();
  };
  CO_ENGRAM._graphState.resetFocus = function() { resetHighlight(); };
  CO_ENGRAM._graphState.focusNode = focusNode;
  // 着色模式(DEMO modes):structure/vitality/conflict/heat + 按钮态
  CO_ENGRAM._graphState.setColorMode = function(mode) {
    state.colorMode = mode;
    const sel = document.getElementById('graph-color-mode');
    if (sel) sel.value = mode;
    // 颜色只依赖 nodeColorFor → 重算节点 color(不重建位置)
    nodesDataset.update(nodesDataset.get().map(n => {
      const raw = graph.nodes.find(x => x.id === n.id);
      const c = raw ? nodeColorFor(raw) : n.color;
      return { id: n.id, color: { background: c, border: stageBg(), highlight: c, hover: c } };
    }));
    renderLegend();
    queueRefreshOverlay();
  };
  // 状态筛选(DEMO fselect):仅活跃 / 含归档 / 仅矛盾
  CO_ENGRAM._graphState.setStatusFilter = function(v) {
    state.statusFilter = v || 'active';
    CO_ENGRAM._graphState.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
  };
}

// ============================================================
// 纯函数工具(模块级,与实例状态无关)
// ============================================================

// Louvain 社区发现:局部移动(ΔQ = k_i,in − Σ_tot·k_i / 2m)+ 聚合,最多 3 层。
// 返回 Map<nodeId, clusterId>(原始节点 → 顶层簇)。
// 确定性:遍历顺序按 id 排序(无随机,同一图同一结果)。
window.CO_ENGRAM_LOUVAIN = function(nodeIds, edgeList) {
  const finalOf = new Map();
  for (const id of nodeIds) finalOf.set(id, id);
  let ids = nodeIds.slice();
  let edges = edgeList.map(e => ({ from: e.from, to: e.to, w: (e.weight != null && e.weight > 0) ? e.weight : 0.5 }));
  for (let level = 0; level < 3 && edges.length > 0; level++) {
    const nodeSet = new Set(ids);
    edges = edges.filter(e => nodeSet.has(e.from) && nodeSet.has(e.to));
    if (!edges.length) break;
    let m2 = 0; // 2m(总权重×2)
    for (const e of edges) m2 += 2 * e.w;
    if (m2 <= 0) break;
    const adj = new Map();
    const k = new Map();
    for (const id of ids) adj.set(id, new Map());
    for (const e of edges) {
      adj.get(e.from).set(e.to, (adj.get(e.from).get(e.to) || 0) + e.w);
      adj.get(e.to).set(e.from, (adj.get(e.to).get(e.from) || 0) + e.w);
      k.set(e.from, (k.get(e.from) || 0) + e.w);
      k.set(e.to, (k.get(e.to) || 0) + e.w);
    }
    const comm = new Map();
    const commK = new Map(k);
    for (const id of ids) comm.set(id, id);
    const sortedIds = ids.slice().sort();
    let improved = true, passes = 0;
    while (improved && passes < 15) {
      improved = false; passes++;
      for (const id of sortedIds) {
        const neighbors = adj.get(id);
        if (!neighbors || !neighbors.size) continue;
        const ki = k.get(id) || 0;
        const oldC = comm.get(id);
        commK.set(oldC, (commK.get(oldC) || 0) - ki);
        const toComm = new Map();
        for (const entry of neighbors) {
          const c = comm.get(entry[0]);
          toComm.set(c, (toComm.get(c) || 0) + entry[1]);
        }
        let bestC = oldC, bestGain = toComm.get(oldC) ? (toComm.get(oldC) - (commK.get(oldC) || 0) * ki / m2) : -Infinity;
        for (const entry of toComm) {
          const gain = entry[1] - (commK.get(entry[0]) || 0) * ki / m2;
          if (gain > bestGain) { bestGain = gain; bestC = entry[0]; }
        }
        comm.set(id, bestC);
        commK.set(bestC, (commK.get(bestC) || 0) + ki);
        if (bestC !== oldC) improved = true;
      }
    }
    // 按社区分组
    const groups = new Map();
    for (const id of ids) {
      const c = comm.get(id);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(id);
    }
    if (groups.size >= ids.length) break; // 已是全孤立社区,聚合无意义
    const newIdOf = new Map();
    let gi = 0;
    for (const grp of groups.values()) {
      const sid = 'c' + level + '_' + (gi++);
      for (const m0 of grp) newIdOf.set(m0, sid);
    }
    for (const key of Array.from(finalOf.keys())) {
      finalOf.set(key, newIdOf.get(finalOf.get(key)));
    }
    const edgeAgg = new Map();
    for (const e of edges) {
      const f = newIdOf.get(e.from), t = newIdOf.get(e.to);
      if (f === t) continue;
      const key = f < t ? f + '|' + t : t + '|' + f;
      edgeAgg.set(key, (edgeAgg.get(key) || 0) + e.w);
    }
    ids = Array.from(new Set(Array.from(newIdOf.values())));
    edges = [];
    for (const entry of edgeAgg) {
      const parts = entry[0].split('|');
      edges.push({ from: parts[0], to: parts[1], w: entry[1] });
    }
  }
  return finalOf;
};

// 凸包(Andrew 单调链),points: [{x,y}]
window.CO_ENGRAM_CONVEX_HULL = function(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
};

// 凸包外扩 pad 像素的闭合 path
window.CO_ENGRAM_HULL_PATH = function(pts, pad) {
  if (!pts.length) return '';
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const out = pts.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return (p.x + dx / len * pad).toFixed(1) + ' ' + (p.y + dy / len * pad).toFixed(1);
  });
  return 'M ' + out.join(' L ') + ' Z';
};

// Esc 复位聚焦邻域(DEMO「Esc 返回」;drawer 关闭逻辑在 app.ts,两者独立)
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  const s = CO_ENGRAM._graphState;
  if (s && s.state && s.state.focusedId && s.resetFocus) s.resetFocus();
});

// 工具栏点击处理(从 onclick 调用)
window.CO_ENGRAM_GRAPH = {
  toggleSynapseKind(kind, checked) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.showSynapseKinds[kind] = checked;
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
  },
  toggleKind(kind, checked) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.showKinds[kind] = checked;
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
  },
  togglePhysics() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.togglePhysics(); },
  fit() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.fit(); },
  setImportance(v) { CO_ENGRAM._graphState && CO_ENGRAM._graphState.setImportance(v); },
  setTimeReplay(v) { CO_ENGRAM._graphState && CO_ENGRAM._graphState.setTimeReplay(v); },
  toggleNight() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.toggleNight(); },
  setColorMode(m) { CO_ENGRAM._graphState && CO_ENGRAM._graphState.setColorMode(m); },
  setStatusFilter(v) { CO_ENGRAM._graphState && CO_ENGRAM._graphState.setStatusFilter(v); },
  // 图例族行:toggle 该族全部 kinds(on = 该族所有 kind 开)
  toggleFamily(fam, on) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    const FAM_KINDS = {
      structural: ['extends', 'part_of', 'similar_to'],
      causal: ['depends_on', 'causes', 'follows'],
      evidential: ['derives_from', 'contradicts', 'exemplifies'],
      temporal: ['supersedes', 'consolidates'],
      modulatory: ['contextualizes'],
    };
    for (const k of (FAM_KINDS[fam] || [])) s.state.showSynapseKinds[k] = on;
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
  },
  // 检查器邻域行点击 → 聚焦该节点(复用画布聚焦逻辑)
  focusById(id) {
    const s = CO_ENGRAM._graphState;
    if (!s || !s.network) return;
    s.network.focus(id, { scale: 1.2, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    s.network.selectNodes([id]);
    s.focusNode(id);
  },

  // === 顶栏过滤(2026-07 新增)===
  // 关键词过滤:oninput 实时触发,空值清空
  applyTextFilter(text) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.textFilter = (text || '').trim();
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
    CO_ENGRAM_GRAPH._refreshTextChip();
    // 过滤变化后重新 fit,让保留的节点居中可见
    setTimeout(() => { if (s.network) s.network.fit({ animation: true }); }, 50);
  },
  clearTextFilter() {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.textFilter = '';
    const input = document.getElementById('graph-q');
    if (input) input.value = '';
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
    CO_ENGRAM_GRAPH._refreshTextChip();
    setTimeout(() => { if (s.network) s.network.fit({ animation: true }); }, 50);
  },
  // 目录路径过滤:由 path picker 弹窗选中后调用
  setPathFilter(prefix) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.pathFilter = (prefix || '');
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
    CO_ENGRAM_GRAPH._refreshPathChip();
    setTimeout(() => { if (s.network) s.network.fit({ animation: true }); }, 50);
  },
  clearPathFilter() {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.pathFilter = '';
    s.applyFilters();
    CO_ENGRAM_GRAPH._refreshFilterCount();
    CO_ENGRAM_GRAPH._refreshPathChip();
    setTimeout(() => { if (s.network) s.network.fit({ animation: true }); }, 50);
  },
  // 打开目录选择 drawer:复用 engrams 的 /api/path-tree 数据
  async openPathPicker() {
    const T = CO_ENGRAM_T;
    let root;
    try {
      const resp = await CO_ENGRAM.apiGet('/api/path-tree?maxDepth=8');
      if (!resp || !resp.enabled || !resp.root) {
        CO_ENGRAM.openDrawer('<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.filter.pathPickerEmpty')) + '</div>');
        return;
      }
      root = resp.root;
      // 缓存 id→path Map(2026-07 修复 ULID id 假设):setPathFilter 用它过滤节点
      if (Array.isArray(resp.engramLocations)) {
        CO_ENGRAM._engramLocations = new Map(
          resp.engramLocations.map((x) => [x.id, x.path]),
        );
      }
    } catch (e) {
      CO_ENGRAM.openDrawer('<div class="empty">' + CO_ENGRAM.escapeHtml(T.t('viewer.common.loadFailed', { err: e.message })) + '</div>');
      return;
    }

    function renderNode(node, depth) {
      const children = node.children || [];
      let childSum = 0;
      for (const c of children) childSum += (c.engramCount || 0);
      const direct = Math.max(0, (node.engramCount || 0) - childSum);
      const segs = (node.path || '').split('/').filter(Boolean);
      const basename = segs.length ? segs[segs.length - 1] : (node.path === '/' ? '/' : '/');
      const pathForFilter = node.path && node.path !== '/' ? node.path : '';
      const isOpen = depth === 0;
      const childHtml = children.length
        ? '<div class="tree-group-body">' + children.map(c => renderNode(c, depth + 1)).join('') + '</div>'
        : '';
      const pickBtn = (node.engramCount || 0) > 0
        ? '<button class="btn mini" onclick="CO_ENGRAM_GRAPH._pickPath(\\'' + CO_ENGRAM.escapeHtml(pathForFilter) + '\\')">'
          + CO_ENGRAM.escapeHtml(T.t('viewer.graph.filter.pathPick')) + ' (' + (node.engramCount || 0) + ')</button>'
        : '';
      if (!children.length) {
        return '<div class="tree-leaf-dir">'
          + '<span class="tree-folder-icon">📁</span> '
          + '<span class="tree-dir-name">' + CO_ENGRAM.escapeHtml(basename) + '</span> '
          + '<span class="tree-count">' + (node.engramCount || 0) + '</span> '
          + pickBtn
          + '</div>';
      }
      return '<details class="tree-group"' + (isOpen ? ' open' : '') + '>'
        + '<summary>'
        + '<span class="tree-folder-icon">📁</span> '
        + '<span class="tree-dir-name">' + CO_ENGRAM.escapeHtml(basename) + '</span> '
        + '<span class="tree-count">' + (node.engramCount || 0) + '</span>'
        + (direct > 0 ? ' <span class="tree-direct">+' + direct + ' here</span>' : '')
        + ' ' + pickBtn
        + '</summary>'
        + childHtml
        + '</details>';
    }

    let html = '<div class="edit-banner" style="display:flex;gap:.5rem;align-items:center"><strong style="margin-right:auto">'
      + CO_ENGRAM.escapeHtml(T.t('viewer.graph.filter.pathPickerTitle')) + '</strong></div>';
    html += '<div class="tree-view">';
    const rootChildren = root.children || [];
    const rootDirect = (root.engramCount || 0) - rootChildren.reduce((s, c) => s + (c.engramCount || 0), 0);
    if (rootDirect > 0) {
      html += '<details class="tree-group" open>'
        + '<summary><span class="tree-folder-icon">🏠</span> '
        + '<span class="tree-dir-name">' + CO_ENGRAM.escapeHtml(T.t('engrams.tree.rootDirect')) + '</span> '
        + '<span class="tree-count">' + rootDirect + '</span> '
        + '<button class="btn mini" onclick="CO_ENGRAM_GRAPH._pickPath(\\'\\')">' + CO_ENGRAM.escapeHtml(T.t('viewer.graph.filter.pathPick')) + '</button>'
        + '</summary></details>';
    }
    for (const child of rootChildren) {
      html += renderNode(child, 0);
    }
    html += '</div>';
    CO_ENGRAM.openDrawer(html);
  },
  _pickPath(prefix) {
    CO_ENGRAM.closeDrawer();
    CO_ENGRAM_GRAPH.setPathFilter(prefix);
  },
  _refreshTextChip() {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    const chip = document.getElementById('graph-text-chip');
    if (!chip) return;
    if (s.state.textFilter) {
      chip.style.display = '';
      chip.textContent = '🔍 ' + s.state.textFilter + ' ✕';
      chip.title = s.state.textFilter;
    } else {
      chip.style.display = 'none';
      chip.textContent = '';
    }
  },
  _refreshPathChip() {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    const chip = document.getElementById('graph-path-chip');
    if (!chip) return;
    if (s.state.pathFilter) {
      chip.style.display = '';
      chip.textContent = '📁 ' + s.state.pathFilter + ' ✕';
      chip.title = s.state.pathFilter;
    } else {
      chip.style.display = 'none';
      chip.textContent = '';
    }
  },
  _refreshFilterCount() {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    const countEl = document.getElementById('graph-filter-count');
    if (!countEl) return;
    // 重新计算保留的节点 / 边数(与 buildNodes / buildEdges 一致)
    const T = CO_ENGRAM_T;
    // 重要度阈值 + 时间回放 + 状态(与 buildNodes 同一谓词,内联复算)
    const cut = (s.state.timeRange && s.state.timeRatio < 1)
      ? s.state.timeRange.min + (s.state.timeRange.max - s.state.timeRange.min) * s.state.timeRatio
      : null;
    const contraSet = s.state.statusFilter === 'contradictions' ? new Set(
      s.data.edges.filter(e => e.kind === 'contradicts').flatMap(e => [e.from, e.to]),
    ) : null;
    const passNodes = s.data.nodes.filter(n =>
      s.state.showKinds[n.kind] !== false
      && ((n.importance != null ? n.importance : 0.5) >= s.state.minImportance)
      && (cut == null || (typeof n.createdAtMs === 'number' && n.createdAtMs > 0 && n.createdAtMs <= cut))
      && (s.state.statusFilter === 'all' ? true
        : s.state.statusFilter === 'contradictions' ? contraSet.has(n.id)
        : (!n.status || n.status === 'active'))
      && (function matchesNodeFilters(n) {
        if (s.state.pathFilter !== '') {
          const locMap = CO_ENGRAM._engramLocations;
          const ep = locMap ? locMap.get(n.id) : null;
          if (ep == null) return false;
          if (s.state.pathFilter === '') {
            if (ep.includes('/')) return false;
          } else if (ep !== s.state.pathFilter && !ep.startsWith(s.state.pathFilter + '/')) {
            return false;
          }
        }
        if (s.state.textFilter) {
          const q = s.state.textFilter.toLowerCase();
          const title = (n.title || '').toLowerCase();
          const tags = (n.domainTags || []).join(' ').toLowerCase();
          const id = (n.id || '').toLowerCase();
          if (!title.includes(q) && !tags.includes(q) && !id.includes(q)) return false;
        }
        return true;
      })(n),
    );
    const passIds = new Set(passNodes.map(n => n.id));
    const passEdges = s.data.edges.filter(e =>
      s.state.showSynapseKinds[e.kind] !== false
      && passIds.has(e.from) && passIds.has(e.to),
    );
    const totalEdges = s.data.edges.length;
    const totalNodes = s.data.nodes.length;
    // 显示「过滤后 / 总数」帮助用户理解为什么 stats 总数 ≠ graph 显示数:
    //   - stats 走 /api/status 全量统计(包括未在 graph 渲染的节点 / 边)
    //   - graph 走 /api/graph,只渲染两端 engram 都存在的边(dangling 已被 doctor 清理)
    //   - 过滤(关键词 / 目录 / 类型)进一步收窄
    // 当 passEdges == totalEdges 时只显示一个数,避免视觉噪音
    const edgesText = passEdges.length === totalEdges
      ? String(passEdges.length)
      : passEdges.length + ' / ' + totalEdges;
    const nodesText = passNodes.length === totalNodes
      ? String(passNodes.length)
      : passNodes.length + ' / ' + totalNodes;
    countEl.textContent = T.t('viewer.graph.filter.count', { nodes: nodesText, edges: edgesText });
    // 节点口径说明:图谱节点 = 印迹 + 技能同图(2026-08-20 用户报告概览 109 vs 图谱 118
    // 疑似矛盾,实为 9 个技能节点)。动态拼入 tooltip,悬停即可看到差异来源。
    const skillTotal = s.data.nodes.filter(n => n.kind === 'skill').length;
    countEl.title = T.t('viewer.graph.filter.countTip')
      + (skillTotal > 0 ? '\\n' + T.t('viewer.graph.filter.skillNodes', { n: skillTotal }) : '');
  }
};
`;
