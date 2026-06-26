import { describe, it, expect } from "vitest";
import {
  SYNAPSE_KIND_REGISTRY,
  ALL_SYNAPSE_KINDS,
  isValidSynapseKind,
  getSynapseKindMeta,
  listKindsByFamily,
  areSameFamily,
} from "../src/graph/registry.js";
import { GraphTraverser } from "../src/graph/traverse.js";
import type { GraphIndex } from "../src/index/types.js";

describe("Synapse Kind Registry", () => {
  it("注册了 12 种 kind", () => {
    expect(ALL_SYNAPSE_KINDS).toHaveLength(12);
  });

  it("每种 kind 都有完整元数据", () => {
    for (const kind of ALL_SYNAPSE_KINDS) {
      const meta = SYNAPSE_KIND_REGISTRY[kind];
      expect(meta).toBeDefined();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.defaultDirection).toMatch(/^(directional|bidirectional)$/);
      expect(meta.defaultWeight).toBeGreaterThan(0);
      expect(meta.defaultWeight).toBeLessThanOrEqual(1);
    }
  });

  it("isValidSynapseKind 校验", () => {
    expect(isValidSynapseKind("extends")).toBe(true);
    expect(isValidSynapseKind("invalid")).toBe(false);
  });

  it("getSynapseKindMeta 返回元数据", () => {
    const meta = getSynapseKindMeta("contradicts");
    expect(meta.family).toBe("evidential");
    expect(meta.defaultDirection).toBe("bidirectional");
  });

  it("getSynapseKindMeta 未知 kind 抛错", () => {
    expect(() => getSynapseKindMeta("invalid" as never)).toThrow();
  });

  it("listKindsByFamily 列出族下所有 kind", () => {
    const structural = listKindsByFamily("structural");
    expect(structural).toEqual(["extends", "part_of", "similar_to"]);
  });

  it("areSameFamily 判断同族", () => {
    expect(areSameFamily("extends", "part_of")).toBe(true);
    expect(areSameFamily("extends", "causes")).toBe(false);
  });
});

function makeEdge(
  id: string,
  from: string,
  to: string,
  kind: "similar_to" | "contradicts" | "derives_from" = "similar_to",
  weight = 0.5,
): import("../src/index/types.js").GraphEdge {
  return {
    id,
    from,
    to,
    kind,
    weight,
    direction: "directional",
  };
}

function makeTestIndex(): GraphIndex {
  const edges = [
    makeEdge("e1", "a", "b"),
    makeEdge("e2", "a", "c"),
    makeEdge("e3", "b", "d"),
    makeEdge("e4", "c", "d", "contradicts"),
    makeEdge("e5", "d", "e", "derives_from"),
  ];
  return {
    nodes: [
      {
        id: "a",
        title: "A",
        kind: "fact",
        importance: 0.5,
        outgoingCount: 2,
        incomingCount: 0,
      },
      {
        id: "b",
        title: "B",
        kind: "fact",
        importance: 0.5,
        outgoingCount: 1,
        incomingCount: 1,
      },
      {
        id: "c",
        title: "C",
        kind: "fact",
        importance: 0.5,
        outgoingCount: 1,
        incomingCount: 1,
      },
      {
        id: "d",
        title: "D",
        kind: "fact",
        importance: 0.5,
        outgoingCount: 1,
        incomingCount: 2,
      },
      {
        id: "e",
        title: "E",
        kind: "fact",
        importance: 0.5,
        outgoingCount: 0,
        incomingCount: 1,
      },
    ],
    edges,
    outgoingAdjacency: {
      a: ["e1", "e2"],
      b: ["e3"],
      c: ["e4"],
      d: ["e5"],
      e: [],
    },
    incomingAdjacency: {
      a: [],
      b: ["e1"],
      c: ["e2"],
      d: ["e3", "e4"],
      e: ["e5"],
    },
  };
}

describe("GraphTraverser", () => {
  it("getNeighbors 一阶邻居", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const neighbors = traverser.getNeighbors("a", { depth: 1 });
    expect(neighbors).toHaveLength(2);
    const ids = neighbors.map((n) => n.id).sort();
    expect(ids).toEqual(["b", "c"]);
  });

  it("getNeighbors 二阶邻居", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const neighbors = traverser.getNeighbors("a", { depth: 2 });
    const ids = neighbors.map((n) => n.id);
    expect(ids).toContain("d");
  });

  it("getNeighbors 过滤 kind", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const neighbors = traverser.getNeighbors("c", {
      depth: 1,
      kinds: ["contradicts"],
    });
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe("d");
  });

  it("findPaths 找到最短路径", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const paths = traverser.findPaths("a", "d", 3);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0][0]).toBe("a");
    expect(paths[0][paths[0].length - 1]).toBe("d");
  });

  it("findPaths 同节点返回单元素路径", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const paths = traverser.findPaths("a", "a");
    expect(paths).toEqual([["a"]]);
  });

  it("isIsolated 检查孤立节点", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    expect(traverser.isIsolated("a")).toBe(false);
  });

  it("getDegree 返回出入度", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    expect(traverser.getDegree("a")).toEqual({
      outgoing: 2,
      incoming: 0,
      total: 2,
    });
    expect(traverser.getDegree("d")).toEqual({
      outgoing: 1,
      incoming: 2,
      total: 3,
    });
  });

  it("findContradictions 列出矛盾边", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const contradictions = traverser.findContradictions();
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].id).toBe("e4");
  });

  it("traceLineage 沿 derives_from 追溯", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const chain = traverser.traceLineage("d", "derives_from");
    expect(chain[0]).toBe("d");
    expect(chain[1]).toBe("e");
    expect(chain).toHaveLength(2);
  });

  it("findHubs 返回高入度节点", () => {
    const traverser = new GraphTraverser(makeTestIndex());
    const hubs = traverser.findHubs(2);
    expect(hubs[0].id).toBe("d");
    expect(hubs[0].incoming).toBe(2);
  });
});
