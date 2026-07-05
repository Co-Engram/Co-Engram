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
  const ALL_SYNAPSE_KINDS = ['extends', 'part_of', 'similar_to', 'depends_on', 'causes', 'follows', 'derives_from', 'contradicts', 'exemplifies', 'supersedes', 'consolidates', 'contextualizes'];
  const state = {
    showKinds: { fact: true, observation: true, pattern: true, procedure: true, hypothesis: true },
    showSynapseKinds: Object.fromEntries(ALL_SYNAPSE_KINDS.map(k => [k, true])),
    physicsEnabled: true
  };
  CO_ENGRAM._graphState = { initialized: false, network: null, data: graph, state };

  // === 节点 / 边构建 ===
  function buildNodes() {
    return graph.nodes
      .filter(n => state.showKinds[n.kind] !== false)
      .map(n => {
        const importance = (n.importance != null ? n.importance : 0.5);
        const size = 10 + importance * 18;
        const kindLabel = T.enumLabel('kind', n.kind) || n.kind;
        const kindTip = (CO_ENGRAM.TOOLTIPS && CO_ENGRAM.TOOLTIPS.kind && CO_ENGRAM.TOOLTIPS.kind[n.kind]) || '';
        const tipText = n.title + '\\n[' + kindLabel + ' / ' + n.kind + ']\\n' + T.t('viewer.graph.tagsLabel') + (n.domainTags || []).join(', ') + (kindTip ? '\\n\\n' + kindTip : '');
        return {
          id: n.id,
          label: n.title.length > 32 ? n.title.slice(0, 30) + '…' : n.title,
          title: tipText,
          group: n.kind,
          color: {
            background: CO_ENGRAM.kindColor(n.kind),
            border: CO_ENGRAM.kindColor(n.kind),
            highlight: { background: CO_ENGRAM.kindColor(n.kind), border: '#000' },
            hover: { background: CO_ENGRAM.kindColor(n.kind), border: '#fff' }
          },
          size,
          font: { color: getComputedStyle(document.body).color, size: 11, face: 'sans-serif' },
          shape: 'dot',
          _raw: n
        };
      });
  }

  function buildEdges() {
    const out = [];
    for (const e of graph.edges) {
      // 按 12 kind 过滤(与编辑器一致)
      if (state.showSynapseKinds[e.kind] === false) continue;

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
        color: { color, highlight: color, hover: color, opacity: 0.85 },
        width: 1 + (e.weight || 0.5) * 3,
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
    nodes: { borderWidth: 2, shadow: { enabled: true, size: 6, x: 0, y: 1 } },
    edges: { smooth: { type: 'continuous' } },
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
    interaction: { hover: true, tooltipDelay: 100, navigationButtons: false, keyboard: false, selectConnectedEdges: false }
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

  // === 交互 ===
  network.on('click', (params) => {
    // 优先处理边点击(突触详情)
    if (params.edges && params.edges.length > 0 && (!params.nodes || params.nodes.length === 0)) {
      const edgeId = params.edges[0];
      const edge = edgesDataset.get(edgeId);
      if (edge && edge._raw) {
        CO_ENGRAM_SYNAPSES.open(edge._raw.id);
      }
      return;
    }
    if (!params.nodes || params.nodes.length === 0) {
      // 点空白:取消高亮
      resetHighlight();
      return;
    }
    const id = params.nodes[0];
    focusNode(id);
  });

  function resetHighlight() {
    const allNodes = nodesDataset.get();
    const allEdges = edgesDataset.get();
    nodesDataset.update(allNodes.map(n => ({ id: n.id, opacity: 1.0 })));
    edgesDataset.update(allEdges.map(e => ({ id: e.id, color: e.color })));
  }

  function focusNode(id) {
    const connectedNodeIds = new Set([id]);
    const connectedEdgeIds = new Set();
    for (const e of graph.edges) {
      if (e.from === id) { connectedNodeIds.add(e.to); connectedEdgeIds.add(e.id); }
      if (e.to === id) { connectedNodeIds.add(e.from); connectedEdgeIds.add(e.id); }
    }
    const allNodes = nodesDataset.get();
    const allEdges = edgesDataset.get();
    nodesDataset.update(allNodes.map(n => ({
      id: n.id,
      opacity: connectedNodeIds.has(n.id) ? 1.0 : 0.15
    })));
    edgesDataset.update(allEdges.map(e => ({
      id: e.id,
      opacity: connectedEdgeIds.has(e.id) ? 1.0 : 0.05
    })));
    showNodeDetail(id);
  }

  async function showNodeDetail(id) {
    const T = CO_ENGRAM_T;
    let detail;
    try {
      detail = await CO_ENGRAM.apiGet('/api/engrams/' + encodeURIComponent(id));
    } catch (e) {
      CO_ENGRAM.openDrawer('<h2>' + CO_ENGRAM.escapeHtml(id) + '</h2><div class="empty">' + T.t('viewer.common.loadFailed', { err: e.message }) + '</div>');
      return;
    }

    // 找该节点的所有 synapse
    const outgoing = graph.edges.filter(e => e.from === id);
    const incoming = graph.edges.filter(e => e.to === id);

    const familyGroup = (list, label) => {
      if (!list.length) return '';
      const grouped = {};
      for (const e of list) {
        const fam = CO_ENGRAM.synapseFamily(e.kind);
        (grouped[fam] = grouped[fam] || []).push(e);
      }
      let html = '<h3>' + CO_ENGRAM.escapeHtml(label) + ' (' + list.length + ')</h3>';
      for (const fam of Object.keys(grouped)) {
        html += '<div class="field"><span class="chip dot" style="color:' + CO_ENGRAM.familyColor(fam) + '">' + (T.enumLabel('family', fam) || fam) + '</span></div>';
        for (const e of grouped[fam]) {
          const other = e.from === id ? e.to : e.from;
          const kindLabel = T.enumLabel('synapseKind', e.kind) || e.kind;
          html += '<div class="field" style="padding-left:0.5rem">'
            + '<span class="chip synapse-link" data-synapse-id="' + CO_ENGRAM.escapeHtml(e.id) + '" style="background:' + CO_ENGRAM.edgeColor(e.kind) + '22;color:' + CO_ENGRAM.edgeColor(e.kind) + ';cursor:pointer">' + kindLabel + '</span> '
            + '<span class="engram-link" data-engram-id="' + CO_ENGRAM.escapeHtml(other) + '">' + CO_ENGRAM.escapeHtml(other) + '</span>'
            + (e.resolutionStatus ? ' <span class="chip" style="background:rgba(239,68,68,.15);color:#ef4444">' + (T.enumLabel('resolution', e.resolutionStatus) || e.resolutionStatus) + '</span>' : '')
            + '</div>';
        }
      }
      return html;
    };

    const body = [
      '<div class="edit-banner" style="display:flex;gap:.5rem;align-items:center"><strong style="margin-right:auto">' + T.t('viewer.graph.nodeDetailTitle') + '</strong>'
      + '<button class="btn" onclick="CO_ENGRAM.showTab(\\'engrams\\');setTimeout(()=>CO_ENGRAM_ENGRAMS.open(\\'' + CO_ENGRAM.escapeHtml(detail.id) + '\\'),50)">' + T.t('viewer.graph.editInEngrams') + '</button>'
      + '</div>',
      '<h2>' + CO_ENGRAM.escapeHtml(detail.title || detail.id) + '</h2>',
      '<div class="field"><span class="chip kind-' + detail.kind + '">' + (T.enumLabel('kind', detail.kind) || detail.kind) + '</span> '
      + CO_ENGRAM.importanceBar(detail.importance) + ' <span class="kpi-sub">' + T.t('viewer.graph.importanceShort') + ' ' + (detail.importance || 0).toFixed(2) + '</span></div>',
      '<div class="field"><span class="field-label">' + T.t('viewer.synapses.idField') + '</span><code>' + CO_ENGRAM.escapeHtml(detail.id) + '</code></div>',
      (detail.domainTags && detail.domainTags.length
        ? '<div class="field"><span class="field-label">' + T.fieldLabel('domainTags') + ':</span>' + detail.domainTags.map(t => '<span class="chip">' + CO_ENGRAM.escapeHtml(t) + '</span>').join(' ') + '</div>'
        : ''),
      (detail.summary ? '<h3>' + T.t('viewer.graph.summaryTitle') + '</h3><div class="field">' + CO_ENGRAM.escapeHtml(detail.summary) + '</div>' : ''),
      '<h3>' + T.t('viewer.graph.statsTitle') + '</h3>',
      '<div class="field"><span class="field-label">' + T.t('viewer.graph.retrievalLabel') + '</span>' + (detail.retrievalCount || 0)
      + ' <span class="field-label">' + T.t('viewer.graph.effectiveLabel') + '</span>' + (detail.effectiveRetrievals || 0)
      + ' <span class="field-label">' + T.t('viewer.graph.failedLabel') + '</span>' + (detail.failedUses || 0) + '</div>',
      '<div class="field"><span class="field-label">' + T.t('viewer.synapses.creatorField') + '</span>' + CO_ENGRAM.escapeHtml(detail.createdBy || '')
      + ' <span class="field-label">' + T.t('viewer.synapses.timeField') + '</span>' + CO_ENGRAM.escapeHtml(detail.createdAt || '') + '</div>',
      familyGroup(outgoing, T.t('viewer.graph.outgoingSynapses')),
      familyGroup(incoming, T.t('viewer.graph.incomingSynapses'))
    ].join('\\n');
    CO_ENGRAM.openDrawer(body);

    // drawer 内的 engram / synapse 链接点击 → focus / open
    setTimeout(() => {
      document.querySelectorAll('#detail-drawer .engram-link').forEach(el => {
        el.onclick = () => {
          const targetId = el.getAttribute('data-engram-id');
          if (targetId) {
            network.focus(targetId, { scale: 1.2, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
            network.selectNodes([targetId]);
            focusNode(targetId);
          }
        };
      });
      document.querySelectorAll('#detail-drawer .synapse-link').forEach(el => {
        el.onclick = () => {
          const sid = el.getAttribute('data-synapse-id');
          if (sid) CO_ENGRAM_SYNAPSES.open(sid);
        };
      });
    }, 50);
  }

  // === 工具栏交互 ===
  CO_ENGRAM._graphState.applyFilters = function() {
    nodesDataset.clear();
    edgesDataset.clear();
    nodesDataset.add(buildNodes());
    edgesDataset.add(buildEdges());
  };
  CO_ENGRAM._graphState.togglePhysics = function() {
    state.physicsEnabled = !state.physicsEnabled;
    network.setOptions({ physics: { enabled: state.physicsEnabled } });
  };
  CO_ENGRAM._graphState.fit = function() { network.fit({ animation: true }); };
  CO_ENGRAM._graphState.resetView = function() {
    state.showKinds = { fact: true, observation: true, pattern: true, procedure: true, hypothesis: true };
    state.showSynapseKinds = Object.fromEntries(ALL_SYNAPSE_KINDS.map(k => [k, true]));
    document.querySelectorAll('.graph-toolbar input[type=checkbox]').forEach(c => c.checked = true);
    CO_ENGRAM._graphState.applyFilters();
    network.fit({ animation: true });
  };
}

// 工具栏点击处理(从 onclick 调用)
window.CO_ENGRAM_GRAPH = {
  toggleSynapseKind(kind, checked) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.showSynapseKinds[kind] = checked;
    s.applyFilters();
  },
  toggleKind(kind, checked) {
    const s = CO_ENGRAM._graphState;
    if (!s) return;
    s.state.showKinds[kind] = checked;
    s.applyFilters();
  },
  togglePhysics() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.togglePhysics(); },
  fit() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.fit(); },
  reset() { CO_ENGRAM._graphState && CO_ENGRAM._graphState.resetView(); }
};
`;
