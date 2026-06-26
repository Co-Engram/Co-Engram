import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  gatherContradictingViews,
  enrichWithContradictingViews,
  findContradictionClusters,
  computeMultiViewStats,
} from "../src/perspectives/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-multiview-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  domainTags?: readonly string[];
  perspective?: string;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.title,
    kind: input.kind ?? "fact",
    domainTags: input.domainTags ?? ["x"],
    perspective: input.perspective,
    createdBy: "tester",
  });
}

function addContradicts(
  fromId: string,
  toId: string,
  options: {
    resolutionState?: import("../src/types/synapse.js").SynapseResolutionState;
  } = {},
): string {
  const synapseId = `contra-${Math.random().toString(36).slice(2, 10)}`;
  repo.addOutgoingSynapse(fromId, {
    id: synapseId,
    from: fromId,
    to: toId,
    kind: "contradicts",
    weight: 0.8,
    direction: "directional",
    evidence: [],
    createdBy: "tester",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.8,
    resolutionState: options.resolutionState,
  });
  return synapseId;
}

// ============================================================
// gatherContradictingViews
// ============================================================

describe("gatherContradictingViews", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() => gatherContradictingViews(repo, "no/such")).toThrow(
      /not found/,
    );
  });

  it("无 contradicts → 空数组", () => {
    const a = makeEngram({ title: "A" });
    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.centerId).toBe(a.id);
    expect(bundle.contradictions).toEqual([]);
  });

  it("outgoing contradicts 被收集（A contradicts B）", () => {
    const a = makeEngram({ title: "A", perspective: "team-a" });
    const b = makeEngram({ title: "B", perspective: "team-b" });
    addContradicts(a.id, b.id);

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions).toHaveLength(1);
    expect(bundle.contradictions[0]!.engramId).toBe(b.id);
    expect(bundle.contradictions[0]!.direction).toBe("outgoing");
    expect(bundle.contradictions[0]!.perspective).toBe("team-b");
  });

  it("incoming contradicts 被收集（B contradicts A）", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(b.id, a.id);

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions).toHaveLength(1);
    expect(bundle.contradictions[0]!.engramId).toBe(b.id);
    expect(bundle.contradictions[0]!.direction).toBe("incoming");
  });

  it("双向 contradicts 被同时收集", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    addContradicts(a.id, b.id); // outgoing
    addContradicts(c.id, a.id); // incoming

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions).toHaveLength(2);
    const dirs = bundle.contradictions.map((v) => v.direction).sort();
    expect(dirs).toEqual(["incoming", "outgoing"]);
  });

  it("incoming 排在 outgoing 之前（外部挑战优先）", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    addContradicts(a.id, b.id); // outgoing
    addContradicts(c.id, a.id); // incoming

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions[0]!.direction).toBe("incoming");
    expect(bundle.contradictions[1]!.direction).toBe("outgoing");
  });

  it("携带 resolutionState", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(a.id, b.id, {
      resolutionState: { status: "pending", phase: 1 },
    });

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions[0]!.resolutionState).toBeDefined();
    expect(bundle.contradictions[0]!.resolutionState!.status).toBe("pending");
  });

  it("to 端已删除 → 跳过（避免 dangling）", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(a.id, b.id);
    repo.deleteEngram(b.id);

    const bundle = gatherContradictingViews(repo, a.id);
    expect(bundle.contradictions).toHaveLength(0);
  });
});

// ============================================================
// enrichWithContradictingViews
// ============================================================

describe("enrichWithContradictingViews", () => {
  it("对每个结果 engram 附加 contradicts 视图", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    addContradicts(a.id, b.id);

    const enriched = enrichWithContradictingViews(repo, [a.id, b.id, c.id]);
    expect(enriched).toHaveLength(3);
    expect(enriched[0]!.engramId).toBe(a.id);
    expect(enriched[0]!.contradictsViews).toHaveLength(1);
    expect(enriched[1]!.contradictsViews).toHaveLength(1); // incoming
    expect(enriched[2]!.contradictsViews).toHaveLength(0);
  });

  it("不删除任何结果 engram（保留矛盾双方）", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(a.id, b.id);

    const enriched = enrichWithContradictingViews(repo, [a.id, b.id]);
    expect(enriched.map((e) => e.engramId)).toEqual([a.id, b.id]);
  });

  it("maxViewsPerResult 截断", () => {
    const a = makeEngram({ title: "A" });
    const others: string[] = [];
    for (let i = 0; i < 5; i++) {
      const o = makeEngram({ title: `o-${i}` });
      others.push(o.id);
      addContradicts(a.id, o.id);
    }

    const enriched = enrichWithContradictingViews(repo, [a.id], {
      maxViewsPerResult: 2,
    });
    expect(enriched[0]!.contradictsViews).toHaveLength(2);
  });

  it("已删除的 engramId → 返回空 views", () => {
    const enriched = enrichWithContradictingViews(repo, ["no/such"]);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.contradictsViews).toEqual([]);
  });

  it("spec 验收：contradicts 关系的两个 engram 都被返回", () => {
    const a = makeEngram({ title: "观点 A", perspective: "team-a" });
    const b = makeEngram({ title: "观点 B", perspective: "team-b" });
    addContradicts(a.id, b.id);

    // 假设检索返回了 [a, b]
    const enriched = enrichWithContradictingViews(repo, [a.id, b.id]);
    // 双方都被返回
    expect(enriched.map((e) => e.engramId).sort()).toEqual([a.id, b.id].sort());
    // a 的视图中包含 b
    expect(
      enriched.find((e) => e.engramId === a.id)!.contradictsViews[0]!.engramId,
    ).toBe(b.id);
    // b 的视图中包含 a
    expect(
      enriched.find((e) => e.engramId === b.id)!.contradictsViews[0]!.engramId,
    ).toBe(a.id);
  });
});

// ============================================================
// findContradictionClusters
// ============================================================

describe("findContradictionClusters", () => {
  it("无 contradicts → 空 clusters", () => {
    makeEngram({ title: "A" });
    makeEngram({ title: "B" });
    const clusters = findContradictionClusters(repo);
    expect(clusters).toEqual([]);
  });

  it("A contradicts B → 1 cluster 含 2 个成员", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(a.id, b.id);

    const clusters = findContradictionClusters(repo);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds).toEqual([a.id, b.id].sort());
  });

  it("传递性：A contradicts B, B contradicts C → 同一 cluster", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    addContradicts(a.id, b.id);
    addContradicts(b.id, c.id);

    const clusters = findContradictionClusters(repo);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds).toEqual([a.id, b.id, c.id].sort());
  });

  it("独立 cluster：A-B 和 C-D 互不相干", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B", domainTags: ["x"] });
    const c = makeEngram({ title: "C", domainTags: ["y"] });
    const d = makeEngram({ title: "D", domainTags: ["y"] });
    addContradicts(a.id, b.id);
    addContradicts(c.id, d.id);

    const clusters = findContradictionClusters(repo);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.memberIds).toHaveLength(2);
    expect(clusters[1]!.memberIds).toHaveLength(2);
  });

  it("按成员数降序排序", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    addContradicts(a.id, b.id);
    addContradicts(a.id, c.id);
    addContradicts(b.id, c.id);

    const d = makeEngram({ title: "D", domainTags: ["y"] });
    const e = makeEngram({ title: "E", domainTags: ["y"] });
    addContradicts(d.id, e.id);

    const clusters = findContradictionClusters(repo);
    expect(clusters[0]!.memberIds).toHaveLength(3);
    expect(clusters[1]!.memberIds).toHaveLength(2);
  });
});

// ============================================================
// computeMultiViewStats
// ============================================================

describe("computeMultiViewStats", () => {
  it("空仓库 → 全 0", () => {
    const stats = computeMultiViewStats(repo);
    expect(stats.totalContradictsEdges).toBe(0);
    expect(stats.clusters).toBe(0);
    expect(stats.distinctPerspectives).toBe(0);
  });

  it("正确统计 edges / clusters / perspectives", () => {
    makeEngram({ title: "A", perspective: "team-a" });
    makeEngram({ title: "B", perspective: "team-b" });
    makeEngram({ title: "C", perspective: "team-a" });
    const a = repo.listEngrams().find((e) => e.title === "A")!;
    const b = repo.listEngrams().find((e) => e.title === "B")!;
    addContradicts(a.id, b.id);

    const stats = computeMultiViewStats(repo);
    expect(stats.totalContradictsEdges).toBe(1);
    expect(stats.activeContradictions).toBe(1);
    expect(stats.resolvedContradictions).toBe(0);
    expect(stats.clusters).toBe(1);
    expect(stats.largestClusterSize).toBe(2);
    expect(stats.distinctPerspectives).toBe(2); // team-a + team-b
  });

  it("resolved synapse 计入 resolved", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addContradicts(a.id, b.id, {
      resolutionState: { status: "resolved", phase: 3, verdict: "keep_new" },
    });

    const stats = computeMultiViewStats(repo);
    expect(stats.resolvedContradictions).toBe(1);
    expect(stats.activeContradictions).toBe(0);
  });
});

// ============================================================
// perspective 字段
// ============================================================

describe("perspective 字段持久化", () => {
  it("createEngram 时设置 perspective", () => {
    const e = repo.createEngram({
      title: "X",
      content: "x",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
      perspective: "team-a",
    });
    const read = repo.readEngram(e.id);
    expect(read.perspective).toBe("team-a");
  });

  it("updateEngram 可修改 perspective", () => {
    const e = repo.createEngram({
      title: "X",
      content: "x",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
      perspective: "team-a",
    });
    repo.updateEngram(e.id, {
      perspective: "team-b",
      updatedBy: "tester",
    });
    const read = repo.readEngram(e.id);
    expect(read.perspective).toBe("team-b");
  });

  it("未设置 perspective → undefined", () => {
    const e = repo.createEngram({
      title: "X",
      content: "x",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const read = repo.readEngram(e.id);
    expect(read.perspective).toBeUndefined();
  });
});
