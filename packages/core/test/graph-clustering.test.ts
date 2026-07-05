import { describe, it, expect } from "vitest";
import {
  clusterSnapshot,
  expandSuperNode,
  shouldCluster,
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_MIN_CLUSTER_SIZE,
  DEFAULT_HUB_CLUSTER_SIZE,
  type ClusterOptions,
} from "../src/graph/index.js";
import type {
  GraphSnapshot,
  SnapshotNode,
  SnapshotEdge,
} from "../src/graph/index.js";

function makeSnapshot(
  nodes: SnapshotNode[],
  edges: SnapshotEdge[] = [],
): GraphSnapshot {
  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      orphanCount: nodes.filter(
        (n) => n.outgoingCount === 0 && n.incomingCount === 0,
      ).length,
      hubCount: nodes.filter((n) => n.isHub).length,
      contradictionCount: edges.filter((e) => e.isContradiction).length,
      byKind: {},
      byDomain: {},
      byFreshness: {},
    },
  };
}

function makeNode(
  overrides: Partial<SnapshotNode> & { id: string },
): SnapshotNode {
  return {
    id: overrides.id,
    title: overrides.title ?? `node-${overrides.id}`,
    kind: overrides.kind ?? "observation",
    kinds: overrides.kinds ?? [overrides.kind ?? "observation"],
    domainTags: overrides.domainTags ?? ["x"],
    importance: overrides.importance ?? 0.5,
    freshness: overrides.freshness ?? "fresh",
    status: overrides.status ?? "active",
    createdBy: overrides.createdBy ?? "alice",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    retrievalCount: overrides.retrievalCount ?? 0,
    effectiveRetrievals: overrides.effectiveRetrievals ?? 0,
    reinforcementScore: overrides.reinforcementScore ?? 0,
    outgoingCount: overrides.outgoingCount ?? 0,
    incomingCount: overrides.incomingCount ?? 0,
    isHub: overrides.isHub ?? false,
  };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  kind: string = "extends",
): SnapshotEdge {
  return {
    id,
    from,
    to,
    kind: kind as SnapshotEdge["kind"],
    family: "structure",
    weight: 0.5,
    direction: "directional",
    isContradiction: kind === "contradicts",
  };
}

// ============================================================
// 常量
// ============================================================

describe("常量", () => {
  it("DEFAULT_CLUSTER_THRESHOLD = 5000（spec §12.8）", () => {
    expect(DEFAULT_CLUSTER_THRESHOLD).toBe(5000);
  });

  it("DEFAULT_MIN_CLUSTER_SIZE = 5", () => {
    expect(DEFAULT_MIN_CLUSTER_SIZE).toBe(5);
  });

  it("DEFAULT_HUB_CLUSTER_SIZE = 50", () => {
    expect(DEFAULT_HUB_CLUSTER_SIZE).toBe(50);
  });
});

// ============================================================
// shouldCluster
// ============================================================

describe("shouldCluster", () => {
  it("节点数 ≤ 阈值 → false", () => {
    expect(shouldCluster(100, 5000)).toBe(false);
    expect(shouldCluster(5000, 5000)).toBe(false);
  });

  it("节点数 > 阈值 → true", () => {
    expect(shouldCluster(5001, 5000)).toBe(true);
    expect(shouldCluster(10000, 5000)).toBe(true);
  });

  it("默认阈值 5000", () => {
    expect(shouldCluster(4999)).toBe(false);
    expect(shouldCluster(5001)).toBe(true);
  });
});

// ============================================================
// clusterSnapshot：不触发聚类
// ============================================================

describe("clusterSnapshot 不触发聚类", () => {
  it("节点数 ≤ threshold → 全部保留为 standalone", () => {
    const snapshot = makeSnapshot([
      makeNode({ id: "a" }),
      makeNode({ id: "b" }),
    ]);
    const result = clusterSnapshot(snapshot, { threshold: 100 });
    expect(result.superNodes).toEqual([]);
    expect(result.superEdges).toEqual([]);
    expect(result.standaloneNodes).toHaveLength(2);
    expect(result.stats.totalStandaloneNodes).toBe(2);
    expect(result.stats.compressionRatio).toBe(1);
  });

  it("强制低阈值触发聚类", () => {
    // 用 threshold=2 触发聚类（>2 节点）
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["mobile"], kind: "observation" }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 2,
      minClusterSize: 3,
    });
    expect(result.superNodes.length).toBe(1);
    expect(result.superNodes[0]!.memberCount).toBe(10);
    expect(result.standaloneNodes).toHaveLength(0);
  });
});

// ============================================================
// clusterSnapshot：按 domain + kind 聚类
// ============================================================

describe("clusterSnapshot 按 domain + kind 聚类", () => {
  it("同 domain + kind 归入同一 super-node", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `a${i}`, domainTags: ["mobile"], kind: "observation" }),
      );
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `b${i}`, domainTags: ["mobile"], kind: "fact" }),
      );
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `c${i}`, domainTags: ["web"], kind: "observation" }),
      );
    }

    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 5,
      minClusterSize: 3,
      secondaryByKind: true,
    });

    // 三个 cluster
    expect(result.superNodes).toHaveLength(3);
    const ids = result.superNodes.map((s) => s.id).sort();
    expect(ids).toContain("cluster:mobile:fact");
    expect(ids).toContain("cluster:mobile:observation");
    expect(ids).toContain("cluster:web:observation");
  });

  it("secondaryByKind=false：只按 domain 聚类", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `a${i}`, domainTags: ["mobile"], kind: "observation" }),
      );
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `b${i}`, domainTags: ["mobile"], kind: "fact" }),
      );
    }

    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 5,
      minClusterSize: 3,
      secondaryByKind: false,
    });

    expect(result.superNodes).toHaveLength(1);
    expect(result.superNodes[0]!.id).toBe("cluster:mobile");
    expect(result.superNodes[0]!.memberCount).toBe(10);
  });

  it("小 group → standalone（< minClusterSize）", () => {
    const nodes: SnapshotNode[] = [];
    // 大 group
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `big${i}`, domainTags: ["big"], kind: "observation" }),
      );
    }
    // 小 group
    nodes.push(
      makeNode({ id: "small1", domainTags: ["small"], kind: "observation" }),
    );
    nodes.push(
      makeNode({ id: "small2", domainTags: ["small"], kind: "observation" }),
    );

    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    expect(result.superNodes).toHaveLength(1); // 只有 big
    expect(result.standaloneNodes).toHaveLength(2); // small1 + small2
  });
});

// ============================================================
// clusterSnapshot：派生统计
// ============================================================

describe("clusterSnapshot 派生统计", () => {
  it("avgImportance / totalRetrievalCount 正确", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({
          id: `n${i}`,
          domainTags: ["x"],
          kind: "observation",
          importance: 0.1 * (i + 1), // 0.1, 0.2, 0.3, 0.4, 0.5
          retrievalCount: 10 * (i + 1),
          effectiveRetrievals: i + 1,
        }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    const superNode = result.superNodes[0]!;
    expect(superNode.avgImportance).toBeCloseTo(0.3, 5); // (0.1+0.2+0.3+0.4+0.5)/5
    expect(superNode.totalRetrievalCount).toBe(150); // 10+20+30+40+50
    expect(superNode.totalEffectiveRetrievals).toBe(15); // 1+2+3+4+5
  });

  it("isHubCluster：memberCount ≥ hubClusterSize", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 60; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 10,
      minClusterSize: 3,
      hubClusterSize: 50,
    });

    expect(result.superNodes[0]!.isHubCluster).toBe(true);
  });

  it("isHubCluster=false 当 memberCount < hubClusterSize", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 10,
      minClusterSize: 3,
      hubClusterSize: 50,
    });

    expect(result.superNodes[0]!.isHubCluster).toBe(false);
  });
});

// ============================================================
// clusterSnapshot：边聚合
// ============================================================

describe("clusterSnapshot 边聚合", () => {
  it("同 cluster 内部边被丢弃（自环）", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const edges = [
      makeEdge("e1", "n0", "n1"), // 都在 cluster:x 内部
      makeEdge("e2", "n2", "n3"), // 都在 cluster:x 内部
    ];
    const snapshot = makeSnapshot(nodes, edges);
    const result = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    expect(result.superEdges).toEqual([]);
  });

  it("跨 cluster 边聚合为 super-edge", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `a${i}`, domainTags: ["a"], kind: "observation" }),
      );
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `b${i}`, domainTags: ["b"], kind: "observation" }),
      );
    }
    const edges = [
      makeEdge("e1", "a0", "b0", "extends"),
      makeEdge("e2", "a1", "b1", "extends"),
      makeEdge("e3", "a2", "b2", "contradicts"),
    ];
    const snapshot = makeSnapshot(nodes, edges);
    const result = clusterSnapshot(snapshot, {
      threshold: 5,
      minClusterSize: 3,
    });

    expect(result.superEdges).toHaveLength(1);
    const se = result.superEdges[0]!;
    expect(se.aggregatedCount).toBe(3);
    expect(se.from).toBe("cluster:a:observation");
    expect(se.to).toBe("cluster:b:observation");
    expect(se.hasContradiction).toBe(true);
  });

  it("standalone 之间的边保留原始", () => {
    const nodes = [
      makeNode({ id: "small1", domainTags: ["s1"], kind: "observation" }),
      makeNode({ id: "small2", domainTags: ["s2"], kind: "observation" }),
    ];
    const edges = [makeEdge("e1", "small1", "small2")];
    const snapshot = makeSnapshot(nodes, edges);
    const result = clusterSnapshot(snapshot, {
      threshold: 1,
      minClusterSize: 3,
    });

    expect(result.standaloneNodes).toHaveLength(2);
    expect(result.standaloneEdges).toHaveLength(1);
    expect(result.standaloneEdges[0]!.from).toBe("small1");
  });

  it("cluster 与 standalone 之间的边聚合为 super-edge", () => {
    const clusterNodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      clusterNodes.push(
        makeNode({ id: `c${i}`, domainTags: ["c"], kind: "observation" }),
      );
    }
    const standalone = makeNode({
      id: "standalone",
      domainTags: ["s"],
      kind: "observation",
    });
    const edges = [
      makeEdge("e1", "c0", "standalone"),
      makeEdge("e2", "c1", "standalone"),
    ];
    const snapshot = makeSnapshot([...clusterNodes, standalone], edges);
    const result = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    expect(result.superEdges).toHaveLength(1);
    expect(result.superEdges[0]!.from).toBe("cluster:c:observation");
    expect(result.superEdges[0]!.to).toBe("standalone");
    expect(result.superEdges[0]!.aggregatedCount).toBe(2);
  });
});

// ============================================================
// 统计指标
// ============================================================

describe("ClusterStats", () => {
  it("compressionRatio 正确", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot, {
      threshold: 10,
      minClusterSize: 3,
    });

    // 100 个节点聚成 1 个 super-node
    expect(result.superNodes).toHaveLength(1);
    expect(result.stats.compressionRatio).toBeCloseTo(1 / 100, 5);
    expect(result.stats.maxClusterSize).toBe(100);
    expect(result.stats.avgClusterSize).toBe(100);
  });

  it("空 snapshot → 全 0", () => {
    const snapshot = makeSnapshot([]);
    const result = clusterSnapshot(snapshot, { threshold: 0 });
    expect(result.stats.totalSuperNodes).toBe(0);
    expect(result.stats.totalStandaloneNodes).toBe(0);
    expect(result.stats.compressionRatio).toBe(1);
  });
});

// ============================================================
// expandSuperNode
// ============================================================

describe("expandSuperNode", () => {
  it("展开 super-node 返回子图", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const edges = [makeEdge("e1", "n0", "n1"), makeEdge("e2", "n1", "n2")];
    const snapshot = makeSnapshot(nodes, edges);
    const clustered = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    const superNode = clustered.superNodes[0]!;
    const expanded = expandSuperNode(snapshot, superNode);
    expect(expanded.nodes).toHaveLength(5);
    expect(expanded.edges).toHaveLength(2);
  });

  it("展开时只包含内部边", () => {
    const clusterNodes: SnapshotNode[] = [];
    for (let i = 0; i < 5; i++) {
      clusterNodes.push(
        makeNode({ id: `c${i}`, domainTags: ["c"], kind: "observation" }),
      );
    }
    const outside = makeNode({
      id: "outside",
      domainTags: ["o"],
      kind: "observation",
    });
    const edges = [
      makeEdge("e1", "c0", "c1"), // 内部
      makeEdge("e2", "c0", "outside"), // 跨界
    ];
    const snapshot = makeSnapshot([...clusterNodes, outside], edges);
    const clustered = clusterSnapshot(snapshot, {
      threshold: 3,
      minClusterSize: 3,
    });

    const expanded = expandSuperNode(snapshot, clustered.superNodes[0]!);
    expect(expanded.nodes).toHaveLength(5); // 只含 cluster 成员
    expect(expanded.edges).toHaveLength(1); // 只含内部边
  });
});

// ============================================================
// 端到端：10000 节点验收
// ============================================================

describe("端到端：spec §4.7 验收场景", () => {
  it("10000 节点 → 聚类后可交互规模", () => {
    const nodes: SnapshotNode[] = [];
    // 模拟 5 个 domain × 4 种 kind × 500 个节点 = 10000
    const domains = ["mobile", "web", "embedded", "ai", "infra"];
    const kinds = ["observation", "fact", "pattern", "procedure"];
    for (const d of domains) {
      for (const k of kinds) {
        for (let i = 0; i < 500; i++) {
          nodes.push(
            makeNode({
              id: `${d}-${k}-${i}`,
              domainTags: [d],
              kind: k,
            }),
          );
        }
      }
    }
    expect(nodes.length).toBe(10000);

    const snapshot = makeSnapshot(nodes);
    const result = clusterSnapshot(snapshot);

    // 5 domains × 4 kinds = 20 super-nodes
    expect(result.superNodes.length).toBe(20);
    expect(result.stats.compressionRatio).toBeLessThan(0.01); // < 1%
    expect(result.stats.maxClusterSize).toBe(500);
    // 可交互规模（< 100 节点）
    const totalInteractiveNodes =
      result.superNodes.length + result.standaloneNodes.length;
    expect(totalInteractiveNodes).toBeLessThan(100);
  });

  it("展开 super-node 后规模可控（≤ 500）", () => {
    const nodes: SnapshotNode[] = [];
    for (let i = 0; i < 500; i++) {
      nodes.push(
        makeNode({ id: `n${i}`, domainTags: ["x"], kind: "observation" }),
      );
    }
    const snapshot = makeSnapshot(nodes);
    // 强制低阈值触发聚类
    const clustered = clusterSnapshot(snapshot, {
      threshold: 100,
      minClusterSize: 3,
    });

    const superNode = clustered.superNodes[0]!;
    const expanded = expandSuperNode(snapshot, superNode);
    expect(expanded.nodes.length).toBe(500); // 可控规模
  });
});
