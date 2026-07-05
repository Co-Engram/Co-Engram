import { describe, it, expect } from "vitest";
import {
  buildGraphSnapshot,
  HUB_INCOMING_THRESHOLD,
  type GraphFilter,
} from "../src/graph/snapshot.js";
import { computeLayout, type LayoutOptions } from "../src/graph/layout.js";
import type { DigestLine, GraphIndex } from "../src/index/types.js";

// ============================================================
// Test helpers
// ============================================================

function makeDigest(
  input: Partial<DigestLine> & Pick<DigestLine, "id" | "title">,
): DigestLine {
  return {
    id: input.id,
    title: input.title,
    kind: input.kind ?? "fact",
    kinds: input.kinds ?? ["fact"],
    summary: input.summary ?? "",
    domainTags: input.domainTags ?? ["default"],
    contextTags: input.contextTags ?? [],
    importance: input.importance ?? 0.5,
    freshness: input.freshness ?? "fresh",
    status: input.status ?? "active",
    sourceType: input.sourceType ?? "firsthand",
    createdBy: input.createdBy ?? "yang",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00Z",
    lastRetrievedAt: input.lastRetrievedAt ?? null,
    lastEffectiveAt: input.lastEffectiveAt ?? null,
    retrievalCount: input.retrievalCount ?? 0,
    effectiveRetrievals: input.effectiveRetrievals ?? 0,
    failedUses: input.failedUses ?? 0,
    reinforcementScore: input.reinforcementScore ?? 0,
    contentSize: input.contentSize ?? 100,
    contentHash: input.contentHash ?? "sha256:fake",
    outgoingSynapseCount: input.outgoingSynapseCount ?? 0,
    incomingSynapseCount: input.incomingSynapseCount ?? 0,
    activeContradictionCount: input.activeContradictionCount ?? 0,
  };
}

function makeGraphIndex(
  nodes: ReadonlyArray<{ id: string; title?: string }>,
  edges: ReadonlyArray<{
    id: string;
    from: string;
    to: string;
    kind?: GraphIndex["edges"][number]["kind"];
    weight?: number;
    direction?: "directional" | "bidirectional";
  }>,
): GraphIndex {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const outgoingAdjacency: Record<string, string[]> = {};
  const incomingAdjacency: Record<string, string[]> = {};
  for (const id of nodeIds) {
    outgoingAdjacency[id] = [];
    incomingAdjacency[id] = [];
  }
  const edgeList = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind ?? "extends",
    weight: e.weight ?? 0.7,
    direction: e.direction ?? "directional",
  }));
  for (const e of edgeList) {
    if (!outgoingAdjacency[e.from]) outgoingAdjacency[e.from] = [];
    if (!incomingAdjacency[e.to]) incomingAdjacency[e.to] = [];
    outgoingAdjacency[e.from].push(e.id);
    incomingAdjacency[e.to].push(e.id);
  }
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      title: n.title ?? n.id,
      kind: "fact",
      importance: 0.5,
      outgoingCount: outgoingAdjacency[n.id]?.length ?? 0,
      incomingCount: incomingAdjacency[n.id]?.length ?? 0,
    })),
    edges: edgeList,
    outgoingAdjacency,
    incomingAdjacency,
  };
}

// ============================================================
// snapshot.ts
// ============================================================

describe("buildGraphSnapshot", () => {
  it("空输入 → 空快照", () => {
    const result = buildGraphSnapshot({
      digest: new Map(),
      graph: {
        nodes: [],
        edges: [],
        outgoingAdjacency: {},
        incomingAdjacency: {},
      },
    });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.stats.totalNodes).toBe(0);
  });

  it("基础：3 节点 + 2 边", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["c", makeDigest({ id: "c", title: "C" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "c" },
      ],
    );
    const result = buildGraphSnapshot({ digest, graph });
    expect(result.nodes.length).toBe(3);
    expect(result.edges.length).toBe(2);
    expect(result.stats.totalNodes).toBe(3);
    expect(result.stats.totalEdges).toBe(2);
  });

  it("kind 过滤", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A", kind: "fact" })],
      ["b", makeDigest({ id: "b", title: "B", kind: "observation" })],
      ["c", makeDigest({ id: "c", title: "C", kind: "fact" })],
    ]);
    const graph = makeGraphIndex([{ id: "a" }, { id: "b" }, { id: "c" }], []);
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { kinds: ["fact"] },
    });
    expect(result.nodes.length).toBe(2);
    expect(result.nodes.every((n) => n.kind === "fact")).toBe(true);
  });

  it("domainTags 过滤（任一匹配即保留）", () => {
    const digest = new Map<string, DigestLine>([
      [
        "a",
        makeDigest({ id: "a", title: "A", domainTags: ["testing", "adb"] }),
      ],
      ["b", makeDigest({ id: "b", title: "B", domainTags: ["frontend"] })],
      ["c", makeDigest({ id: "c", title: "C", domainTags: ["testing"] })],
    ]);
    const graph = makeGraphIndex([{ id: "a" }, { id: "b" }, { id: "c" }], []);
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { domainTags: ["testing"] },
    });
    expect(result.nodes.length).toBe(2);
    expect(result.stats.byDomain.testing).toBe(2);
  });

  it("freshness 过滤", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A", freshness: "fresh" })],
      ["b", makeDigest({ id: "b", title: "B", freshness: "stale" })],
    ]);
    const graph = makeGraphIndex([{ id: "a" }, { id: "b" }], []);
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { freshness: ["fresh"] },
    });
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]!.id).toBe("a");
  });

  it("importance 阈值过滤", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A", importance: 0.9 })],
      ["b", makeDigest({ id: "b", title: "B", importance: 0.3 })],
    ]);
    const graph = makeGraphIndex([{ id: "a" }, { id: "b" }], []);
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { minImportance: 0.5 },
    });
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]!.id).toBe("a");
  });

  it("minWeight 边过滤", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["c", makeDigest({ id: "c", title: "C" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "e1", from: "a", to: "b", weight: 0.9 },
        { id: "e2", from: "b", to: "c", weight: 0.2 },
      ],
    );
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { minWeight: 0.5 },
    });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]!.id).toBe("e1");
  });

  it("hideContradicts 过滤", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["c", makeDigest({ id: "c", title: "C" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "e1", from: "a", to: "b", kind: "extends" },
        { id: "e2", from: "a", to: "c", kind: "contradicts" },
      ],
    );
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { hideContradicts: true },
    });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]!.kind).toBe("extends");
  });

  it("orphansOnly：只显示孤立节点", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["orphan", makeDigest({ id: "orphan", title: "Orphan" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "orphan" }],
      [{ id: "e1", from: "a", to: "b" }],
    );
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { orphansOnly: true },
    });
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]!.id).toBe("orphan");
    expect(result.stats.orphanCount).toBe(1);
  });

  it("contradictionsOnly：只保留矛盾边和节点", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["c", makeDigest({ id: "c", title: "C" })],
      ["d", makeDigest({ id: "d", title: "D" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { id: "e1", from: "a", to: "b", kind: "extends" },
        { id: "e2", from: "a", to: "c", kind: "contradicts" },
      ],
    );
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { contradictionsOnly: true },
    });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]!.isContradiction).toBe(true);
    // 只保留 a 和 c（矛盾两端）
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("isHub 派生：incomingSynapseCount ≥ 10", () => {
    const digest = new Map<string, DigestLine>([
      [
        "hub",
        makeDigest({ id: "hub", title: "Hub", incomingSynapseCount: 15 }),
      ],
      [
        "normal",
        makeDigest({ id: "normal", title: "Normal", incomingSynapseCount: 3 }),
      ],
    ]);
    const graph = makeGraphIndex([{ id: "hub" }, { id: "normal" }], []);
    const result = buildGraphSnapshot({ digest, graph });
    const hub = result.nodes.find((n) => n.id === "hub");
    const normal = result.nodes.find((n) => n.id === "normal");
    expect(hub!.isHub).toBe(true);
    expect(normal!.isHub).toBe(false);
    expect(result.stats.hubCount).toBe(1);
  });

  it("HUB_INCOMING_THRESHOLD 默认 10", () => {
    expect(HUB_INCOMING_THRESHOLD).toBe(10);
  });

  it("SnapshotEdge.family 派生（基于 kind）", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }],
      [{ id: "e1", from: "a", to: "b", kind: "depends_on" }],
    );
    const result = buildGraphSnapshot({ digest, graph });
    expect(result.edges[0]!.family).toBe("causal"); // depends_on 是因果族
  });

  it("节点被过滤掉时，相关边也剔除", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A", kind: "fact" })],
      ["b", makeDigest({ id: "b", title: "B", kind: "observation" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }],
      [{ id: "e1", from: "a", to: "b" }],
    );
    const result = buildGraphSnapshot({
      digest,
      graph,
      filter: { kinds: ["fact"] },
    });
    expect(result.nodes.length).toBe(1);
    expect(result.edges.length).toBe(0); // b 被过滤，边自动剔除
  });

  it("outgoingCount/incomingCount 基于过滤后边", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A" })],
      ["b", makeDigest({ id: "b", title: "B" })],
      ["c", makeDigest({ id: "c", title: "C" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "c" },
      ],
    );
    const result = buildGraphSnapshot({ digest, graph });
    const b = result.nodes.find((n) => n.id === "b");
    expect(b!.outgoingCount).toBe(1);
    expect(b!.incomingCount).toBe(1);
  });
});

// ============================================================
// layout.ts
// ============================================================

describe("computeLayout", () => {
  function makeSnapshot(nodeCount: number, edgeCount: number) {
    const digest = new Map<string, DigestLine>();
    const nodeIds: string[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const id = `n${i}`;
      nodeIds.push(id);
      digest.set(
        id,
        makeDigest({
          id,
          title: `Node ${i}`,
          createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
    }
    const edges: Array<{ id: string; from: string; to: string }> = [];
    for (let i = 0; i < edgeCount && i + 1 < nodeIds.length; i++) {
      edges.push({ id: `e${i}`, from: nodeIds[i]!, to: nodeIds[i + 1]! });
    }
    const graph = makeGraphIndex(
      nodeIds.map((id) => ({ id })),
      edges,
    );
    return buildGraphSnapshot({ digest, graph });
  }

  it("空快照 force-directed → 空", () => {
    const empty = buildGraphSnapshot({
      digest: new Map(),
      graph: {
        nodes: [],
        edges: [],
        outgoingAdjacency: {},
        incomingAdjacency: {},
      },
    });
    const result = computeLayout(empty, { algorithm: "force-directed" });
    expect(result.nodes).toEqual([]);
    expect(result.bounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it("force-directed：所有节点有 x/y 坐标", () => {
    const snapshot = makeSnapshot(10, 5);
    const result = computeLayout(snapshot, {
      algorithm: "force-directed",
      width: 800,
      height: 600,
      iterations: 50,
    });
    expect(result.nodes.length).toBe(10);
    for (const n of result.nodes) {
      expect(typeof n.x).toBe("number");
      expect(typeof n.y).toBe("number");
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(800);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(600);
    }
  });

  it("force-directed：相同 seed → 相同布局（确定性）", () => {
    const snapshot = makeSnapshot(8, 4);
    const opts: LayoutOptions = {
      algorithm: "force-directed",
      width: 400,
      height: 300,
      iterations: 30,
      seed: 42,
    };
    const r1 = computeLayout(snapshot, opts);
    const r2 = computeLayout(snapshot, opts);
    expect(r1.nodes.length).toBe(r2.nodes.length);
    for (let i = 0; i < r1.nodes.length; i++) {
      expect(r1.nodes[i]!.x).toBe(r2.nodes[i]!.x);
      expect(r1.nodes[i]!.y).toBe(r2.nodes[i]!.y);
    }
  });

  it("temporal：按 createdAt 水平排列", () => {
    const snapshot = makeSnapshot(5, 0);
    const result = computeLayout(snapshot, {
      algorithm: "temporal",
      width: 1000,
      height: 500,
    });
    // 第一个节点 x 应该是最小（左侧）
    const xs = result.nodes.map((n) => n.x);
    const sortedById = [...result.nodes].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    );
    expect(sortedById[0]!.x).toBeLessThanOrEqual(sortedById[4]!.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1000);
  });

  it("domain-cluster：同 domain 节点聚簇", () => {
    const digest = new Map<string, DigestLine>([
      ["a", makeDigest({ id: "a", title: "A", domainTags: ["x", "y"] })],
      ["b", makeDigest({ id: "b", title: "B", domainTags: ["x"] })],
      ["c", makeDigest({ id: "c", title: "C", domainTags: ["z"] })],
    ]);
    const graph = makeGraphIndex([{ id: "a" }, { id: "b" }, { id: "c" }], []);
    const snapshot = buildGraphSnapshot({ digest, graph });
    const result = computeLayout(snapshot, {
      algorithm: "domain-cluster",
      width: 800,
      height: 600,
    });
    expect(result.nodes.length).toBe(3);
    // a 和 b 同 domain x，应该聚簇（距离近）
    const a = result.nodes.find((n) => n.id === "a")!;
    const b = result.nodes.find((n) => n.id === "b")!;
    const c = result.nodes.find((n) => n.id === "c")!;
    const distAB = Math.hypot(a.x - b.x, a.y - b.y);
    const distAC = Math.hypot(a.x - c.x, a.y - c.y);
    expect(distAB).toBeLessThan(distAC);
  });

  it("kind-group：同 kind 节点归类", () => {
    const digest = new Map<string, DigestLine>([
      ["f1", makeDigest({ id: "f1", title: "F1", kind: "fact" })],
      ["f2", makeDigest({ id: "f2", title: "F2", kind: "fact" })],
      ["o1", makeDigest({ id: "o1", title: "O1", kind: "observation" })],
    ]);
    const graph = makeGraphIndex(
      [{ id: "f1" }, { id: "f2" }, { id: "o1" }],
      [],
    );
    const snapshot = buildGraphSnapshot({ digest, graph });
    const result = computeLayout(snapshot, {
      algorithm: "kind-group",
      width: 800,
      height: 600,
    });
    const f1 = result.nodes.find((n) => n.id === "f1")!;
    const f2 = result.nodes.find((n) => n.id === "f2")!;
    const o1 = result.nodes.find((n) => n.id === "o1")!;
    const distF1F2 = Math.hypot(f1.x - f2.x, f1.y - f2.y);
    const distF1O1 = Math.hypot(f1.x - o1.x, f1.y - o1.y);
    expect(distF1F2).toBeLessThan(distF1O1);
  });

  it("bounds 正确反映节点范围", () => {
    const snapshot = makeSnapshot(5, 2);
    const result = computeLayout(snapshot, {
      algorithm: "force-directed",
      width: 500,
      height: 400,
    });
    expect(result.bounds.minX).toBeGreaterThanOrEqual(0);
    expect(result.bounds.maxX).toBeLessThanOrEqual(500);
    expect(result.bounds.minY).toBeGreaterThanOrEqual(0);
    expect(result.bounds.maxY).toBeLessThanOrEqual(400);
  });

  it("edges 透传（不丢失）", () => {
    const snapshot = makeSnapshot(3, 2);
    const result = computeLayout(snapshot, { algorithm: "temporal" });
    expect(result.edges.length).toBe(2);
  });

  it("algorithm 字段返回正确", () => {
    const snapshot = makeSnapshot(3, 0);
    expect(
      computeLayout(snapshot, { algorithm: "force-directed" }).algorithm,
    ).toBe("force-directed");
    expect(computeLayout(snapshot, { algorithm: "temporal" }).algorithm).toBe(
      "temporal",
    );
    expect(
      computeLayout(snapshot, { algorithm: "domain-cluster" }).algorithm,
    ).toBe("domain-cluster");
    expect(computeLayout(snapshot, { algorithm: "kind-group" }).algorithm).toBe(
      "kind-group",
    );
  });
});
