/**
 * Graph 布局算法（spec §12.4）
 *
 * 4 种布局：
 *   1. force-directed（默认）：类 Obsidian，物理模拟自然聚集
 *   2. temporal：按 createdAt 水平排列
 *   3. domain-cluster：同 domain 聚簇
 *   4. kind-group：同 kind 归类
 *
 * 所有布局返回 PositionedGraph（节点带 x/y 坐标），宿主用 D3/WebGL 渲染。
 *
 * @module @co-engram/core/graph
 */

import type { GraphSnapshot, SnapshotNode, SnapshotEdge } from "./snapshot.js";

export type LayoutAlgorithm =
  | "force-directed"
  | "temporal"
  | "domain-cluster"
  | "kind-group";

export interface LayoutOptions {
  readonly algorithm: LayoutAlgorithm;
  /** 画布宽度（默认 800） */
  readonly width?: number;
  /** 画布高度（默认 600） */
  readonly height?: number;
  /** force-directed 迭代次数（默认 300） */
  readonly iterations?: number;
  /** 随机种子（默认 42，prompt-cache 友好的稳定布局） */
  readonly seed?: number;
}

export interface PositionedNode extends SnapshotNode {
  readonly x: number;
  readonly y: number;
}

export interface PositionedGraph {
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly SnapshotEdge[];
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  };
  readonly algorithm: LayoutAlgorithm;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const DEFAULT_ITERATIONS = 300;
const DEFAULT_SEED = 42;

/**
 * 计算布局
 */
export function computeLayout(
  snapshot: GraphSnapshot,
  options: LayoutOptions,
): PositionedGraph {
  switch (options.algorithm) {
    case "force-directed":
      return forceDirected(snapshot, options);
    case "temporal":
      return temporal(snapshot, options);
    case "domain-cluster":
      return domainCluster(snapshot, options);
    case "kind-group":
      return kindGroup(snapshot, options);
  }
}

// ============================================================
// Force-directed（Fruchterman-Reingold 简化版）
// ============================================================

function forceDirected(
  snapshot: GraphSnapshot,
  options: LayoutOptions,
): PositionedGraph {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);

  const W = Math.max(width, 1);
  const H = Math.max(height, 1);
  const area = W * H;
  const k = Math.sqrt(area / Math.max(snapshot.nodes.length, 1)) * 0.8;
  const k2 = k * k;

  // 初始随机位置
  const pos = new Map<string, { x: number; y: number }>();
  for (const node of snapshot.nodes) {
    pos.set(node.id, {
      x: rng() * W,
      y: rng() * H,
    });
  }

  const edgePairs: Array<[string, string]> = [];
  for (const e of snapshot.edges) {
    edgePairs.push([e.from, e.to]);
  }

  // 简化版：迭代计算斥力（节点间）+ 引力（边）
  const temperature = W / 10;
  const cool = (t: number) => t * (1 - t / iterations);

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const node of snapshot.nodes) {
      disp.set(node.id, { x: 0, y: 0 });
    }

    // 斥力（所有节点对）
    for (let i = 0; i < snapshot.nodes.length; i++) {
      const a = snapshot.nodes[i]!;
      const pa = pos.get(a.id)!;
      for (let j = i + 1; j < snapshot.nodes.length; j++) {
        const b = snapshot.nodes[j]!;
        const pb = pos.get(b.id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq) || 0.01;
        const repulsion = k2 / dist;
        dx = (dx / dist) * repulsion;
        dy = (dy / dist) * repulsion;
        const da = disp.get(a.id)!;
        const db = disp.get(b.id)!;
        disp.set(a.id, { x: da.x + dx, y: da.y + dy });
        disp.set(b.id, { x: db.x - dx, y: db.y - dy });
      }
    }

    // 引力（边）
    for (const [fromId, toId] of edgePairs) {
      const pa = pos.get(fromId);
      const pb = pos.get(toId);
      if (!pa || !pb) continue;
      let dx = pa.x - pb.x;
      let dy = pa.y - pb.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const attraction = (dist * dist) / k;
      dx = (dx / dist) * attraction;
      dy = (dy / dist) * attraction;
      const da = disp.get(fromId)!;
      const db = disp.get(toId)!;
      disp.set(fromId, { x: da.x - dx, y: da.y - dy });
      disp.set(toId, { x: db.x + dx, y: db.y + dy });
    }

    // 应用位移（受温度限制）
    const t = cool(iter);
    for (const node of snapshot.nodes) {
      const p = pos.get(node.id)!;
      const d = disp.get(node.id)!;
      const dispLen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const limited = Math.min(dispLen, t);
      p.x = Math.max(0, Math.min(W, p.x + (d.x / dispLen) * limited));
      p.y = Math.max(0, Math.min(H, p.y + (d.y / dispLen) * limited));
    }
  }

  const positioned: PositionedNode[] = snapshot.nodes.map((n) => {
    const p = pos.get(n.id)!;
    return { ...n, x: p.x, y: p.y };
  });

  return finalize(positioned, snapshot.edges, "force-directed");
}

// ============================================================
// Temporal（按 createdAt 水平排列）
// ============================================================

function temporal(
  snapshot: GraphSnapshot,
  options: LayoutOptions,
): PositionedGraph {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);

  const sorted = [...snapshot.nodes].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );

  const positioned: PositionedNode[] = sorted.map((n, i) => ({
    ...n,
    x: sorted.length === 1 ? width / 2 : (i / (sorted.length - 1)) * width,
    y: height / 2 + (rng() - 0.5) * height * 0.6, // 加点抖动避免完全水平
  }));

  return finalize(positioned, snapshot.edges, "temporal");
}

// ============================================================
// Domain-cluster（同 domain 聚簇）
// ============================================================

function domainCluster(
  snapshot: GraphSnapshot,
  options: LayoutOptions,
): PositionedGraph {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);

  // 按首个 domainTag 分组
  const groups = new Map<string, SnapshotNode[]>();
  for (const n of snapshot.nodes) {
    const key = n.domainTags[0] ?? "__no_domain__";
    const arr = groups.get(key);
    if (arr) arr.push(n);
    else groups.set(key, [n]);
  }

  // 簇按圆形分布
  const clusterList = Array.from(groups.entries());
  const clusterRadius = Math.min(width, height) / 3;
  const cx = width / 2;
  const cy = height / 2;

  const positioned: PositionedNode[] = [];
  clusterList.forEach(([, group], clusterIdx) => {
    const angle =
      clusterList.length === 1
        ? 0
        : (clusterIdx / clusterList.length) * 2 * Math.PI;
    const clusterCx = cx + Math.cos(angle) * clusterRadius;
    const clusterCy = cy + Math.sin(angle) * clusterRadius;

    // 簇内节点按小圆分布
    const intraRadius = Math.min(60, 200 / Math.sqrt(group.length));
    group.forEach((n, i) => {
      const intraAngle = (i / Math.max(group.length, 1)) * 2 * Math.PI;
      positioned.push({
        ...n,
        x: clusterCx + Math.cos(intraAngle) * intraRadius + (rng() - 0.5) * 10,
        y: clusterCy + Math.sin(intraAngle) * intraRadius + (rng() - 0.5) * 10,
      });
    });
  });

  return finalize(positioned, snapshot.edges, "domain-cluster");
}

// ============================================================
// Kind-group（同 kind 归类）
// ============================================================

function kindGroup(
  snapshot: GraphSnapshot,
  options: LayoutOptions,
): PositionedGraph {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);

  const groups = new Map<string, SnapshotNode[]>();
  for (const n of snapshot.nodes) {
    const arr = groups.get(n.kind);
    if (arr) arr.push(n);
    else groups.set(n.kind, [n]);
  }

  const kindList = Array.from(groups.keys()).sort(); // 稳定排序
  const cols = Math.ceil(Math.sqrt(kindList.length));
  const rows = Math.ceil(kindList.length / cols);
  const cellW = width / cols;
  const cellH = height / Math.max(rows, 1);

  const positioned: PositionedNode[] = [];
  kindList.forEach((kind, idx) => {
    const group = groups.get(kind)!;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cellCx = (col + 0.5) * cellW;
    const cellCy = (row + 0.5) * cellH;

    const intraRadius = Math.min(40, Math.min(cellW, cellH) / 3);
    group.forEach((n, i) => {
      const angle = (i / Math.max(group.length, 1)) * 2 * Math.PI;
      positioned.push({
        ...n,
        x: cellCx + Math.cos(angle) * intraRadius + (rng() - 0.5) * 8,
        y: cellCy + Math.sin(angle) * intraRadius + (rng() - 0.5) * 8,
      });
    });
  });

  return finalize(positioned, snapshot.edges, "kind-group");
}

// ============================================================
// Helpers
// ============================================================

function finalize(
  positioned: readonly PositionedNode[],
  edges: readonly SnapshotEdge[],
  algorithm: LayoutAlgorithm,
): PositionedGraph {
  if (positioned.length === 0) {
    return {
      nodes: [],
      edges,
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      algorithm,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of positioned) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return {
    nodes: positioned,
    edges,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
    },
    algorithm,
  };
}

/** 确定性 PRNG（mulberry32），保证同 snapshot 布局可复现（prompt-cache 友好） */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
