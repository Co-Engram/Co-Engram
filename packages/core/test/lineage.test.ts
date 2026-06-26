import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  LINEAGE_KINDS,
  getEvolutionLineage,
  getAncestors,
  getDescendants,
  traceToOriginObservations,
  findPathToAncestor,
  computeLineageStats,
  type GetLineageOptions,
} from "../src/lineage/index.js";
import type { EngramId } from "../src/types/engram.js";
import type { Synapse, SynapseKind } from "../src/types/synapse.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-lineage-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  domainTags?: readonly string[];
  createdBy?: string;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["x"],
    createdBy: input.createdBy ?? "alice",
  });
}

function addLineage(
  fromId: EngramId,
  toId: EngramId,
  kind: SynapseKind,
  createdBy = "tester",
): string {
  const synapseId = `lin-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const synapse: Synapse = {
    id: synapseId,
    from: fromId,
    to: toId,
    kind,
    weight: 0.7,
    direction: "directional",
    evidence: [],
    createdBy,
    createdAt: now,
    updatedAt: now,
    retrievalWeight: 0.7,
  };
  repo.addOutgoingSynapse(fromId, synapse);
  return synapseId;
}

// ============================================================
// LINEAGE_KINDS
// ============================================================

describe("LINEAGE_KINDS", () => {
  it("包含 derives_from / consolidates / supersedes", () => {
    expect(LINEAGE_KINDS.has("derives_from")).toBe(true);
    expect(LINEAGE_KINDS.has("consolidates")).toBe(true);
    expect(LINEAGE_KINDS.has("supersedes")).toBe(true);
  });

  it("不包含其他 kind", () => {
    expect(LINEAGE_KINDS.has("contradicts")).toBe(false);
    expect(LINEAGE_KINDS.has("extends")).toBe(false);
    expect(LINEAGE_KINDS.has("similar_to")).toBe(false);
    expect(LINEAGE_KINDS.size).toBe(3);
  });
});

// ============================================================
// getEvolutionLineage：基础
// ============================================================

describe("getEvolutionLineage 基础", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() => getEvolutionLineage(repo, "no/such")).toThrow(/not found/);
  });

  it("无血统关系 → 只有 root 节点", () => {
    const a = makeEngram({ title: "A" });
    const lineage = getEvolutionLineage(repo, a.id);
    expect(lineage.rootId).toBe(a.id);
    expect(lineage.nodes).toHaveLength(1);
    expect(lineage.nodes[0]!.engramId).toBe(a.id);
    expect(lineage.nodes[0]!.relation).toBe("self");
    expect(lineage.nodes[0]!.depth).toBe(0);
    expect(lineage.edges).toEqual([]);
    expect(lineage.origins).toEqual([]);
    expect(lineage.terminals).toEqual([]);
    expect(lineage.maxDepth).toBe(0);
    expect(lineage.totalNodes).toBe(1);
  });

  it("contradicts 不被视为血统关系", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const syn: Synapse = {
      id: "s1",
      from: a.id,
      to: b.id,
      kind: "contradicts",
      weight: 0.8,
      direction: "directional",
      evidence: [],
      createdBy: "tester",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.8,
    };
    repo.addOutgoingSynapse(a.id, syn);
    const lineage = getEvolutionLineage(repo, a.id);
    expect(lineage.nodes).toHaveLength(1); // 只有 root
  });
});

// ============================================================
// ancestors 方向
// ============================================================

describe("ancestors 方向追溯", () => {
  it("直接 ancestor：hypothesis.derives_from observation", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const hyp = makeEngram({ title: "hyp", kind: "hypothesis" });
    addLineage(hyp.id, obs.id, "derives_from");

    const lineage = getEvolutionLineage(repo, hyp.id, {
      direction: "ancestors",
    });
    expect(lineage.nodes).toHaveLength(2);
    expect(lineage.edges).toHaveLength(1);
    expect(lineage.edges[0]!.direction).toBe("ancestor");
    expect(lineage.edges[0]!.from).toBe(hyp.id);
    expect(lineage.edges[0]!.to).toBe(obs.id);
    expect(lineage.edges[0]!.kind).toBe("derives_from");

    const obsNode = lineage.nodes.find((n) => n.engramId === obs.id)!;
    expect(obsNode.depth).toBe(1);
    expect(obsNode.relation).toBe("derives_from");
    expect(obsNode.kind).toBe("observation");
  });

  it("传递追溯：pattern ← fact ← observation", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const lineage = getEvolutionLineage(repo, pattern.id, {
      direction: "ancestors",
    });
    expect(lineage.nodes).toHaveLength(3);
    expect(lineage.maxDepth).toBe(2);
    expect(lineage.origins).toEqual([obs.id]); // 最深的 ancestor

    // depth 正确
    const obsNode = lineage.nodes.find((n) => n.engramId === obs.id)!;
    expect(obsNode.depth).toBe(2);
  });

  it("多种 kind 混合追溯", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const old = makeEngram({ title: "old", kind: "procedure" });
    const fact = makeEngram({ title: "fact", kind: "fact" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(fact.id, old.id, "supersedes");

    const lineage = getEvolutionLineage(repo, fact.id, {
      direction: "ancestors",
    });
    expect(lineage.nodes).toHaveLength(3);
    expect(lineage.origins).toHaveLength(2); // obs + old 都是叶子
    expect(lineage.origins).toContain(obs.id);
    expect(lineage.origins).toContain(old.id);
  });

  it("kinds 过滤：只追溯 derives_from", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const old = makeEngram({ title: "old", kind: "procedure" });
    const fact = makeEngram({ title: "fact", kind: "fact" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(fact.id, old.id, "supersedes");

    const lineage = getEvolutionLineage(repo, fact.id, {
      direction: "ancestors",
      kinds: ["derives_from"],
    });
    expect(lineage.nodes).toHaveLength(2); // fact + obs
    expect(lineage.nodes.some((n) => n.engramId === old.id)).toBe(false);
  });

  it("maxDepth 限制追溯深度", () => {
    const a = makeEngram({ title: "a" });
    const b = makeEngram({ title: "b" });
    const c = makeEngram({ title: "c" });
    const d = makeEngram({ title: "d" });

    addLineage(b.id, a.id, "derives_from");
    addLineage(c.id, b.id, "derives_from");
    addLineage(d.id, c.id, "derives_from");

    const lineage = getEvolutionLineage(repo, d.id, {
      direction: "ancestors",
      maxDepth: 2,
    });
    // d(0) → c(1) → b(2)，a 不在范围内
    expect(lineage.nodes).toHaveLength(3);
    expect(lineage.nodes.some((n) => n.engramId === a.id)).toBe(false);
  });

  it("dangling ancestor（to 已删除）跳过", () => {
    const a = makeEngram({ title: "a" });
    const b = makeEngram({ title: "b" });
    addLineage(b.id, a.id, "derives_from");
    repo.deleteEngram(a.id);

    const lineage = getEvolutionLineage(repo, b.id, { direction: "ancestors" });
    expect(lineage.nodes).toHaveLength(1); // 只有 b
  });
});

// ============================================================
// descendants 方向
// ============================================================

describe("descendants 方向追溯", () => {
  it("直接 descendant：observation 被 hypothesis 引用", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const hyp = makeEngram({ title: "hyp", kind: "hypothesis" });
    addLineage(hyp.id, obs.id, "derives_from");

    const lineage = getEvolutionLineage(repo, obs.id, {
      direction: "descendants",
    });
    expect(lineage.nodes).toHaveLength(2);
    expect(lineage.edges).toHaveLength(1);
    expect(lineage.edges[0]!.direction).toBe("descendant");
    expect(lineage.edges[0]!.from).toBe(hyp.id); // hyp 是 descendant
    expect(lineage.edges[0]!.to).toBe(obs.id);

    const hypNode = lineage.nodes.find((n) => n.engramId === hyp.id)!;
    expect(hypNode.depth).toBe(1);
    expect(hypNode.relation).toBe("derives_from");
  });

  it("传递 descendants：observation → fact → pattern", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const lineage = getEvolutionLineage(repo, obs.id, {
      direction: "descendants",
    });
    expect(lineage.nodes).toHaveLength(3);
    expect(lineage.maxDepth).toBe(2);
    expect(lineage.terminals).toEqual([pattern.id]);
  });

  it("一个 observation 被多个 hypothesis 引用 → 多个 descendants", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const h1 = makeEngram({ title: "h1", kind: "hypothesis" });
    const h2 = makeEngram({ title: "h2", kind: "hypothesis" });

    addLineage(h1.id, obs.id, "derives_from");
    addLineage(h2.id, obs.id, "derives_from");

    const lineage = getEvolutionLineage(repo, obs.id, {
      direction: "descendants",
    });
    expect(lineage.nodes).toHaveLength(3); // obs + h1 + h2
    expect(lineage.terminals).toHaveLength(2);
    expect(lineage.terminals).toContain(h1.id);
    expect(lineage.terminals).toContain(h2.id);
  });
});

// ============================================================
// both 方向
// ============================================================

describe("both 方向（双向）", () => {
  it("中间节点：有 ancestor + descendant", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const lineage = getEvolutionLineage(repo, fact.id, { direction: "both" });
    expect(lineage.nodes).toHaveLength(3);
    expect(lineage.origins).toEqual([obs.id]);
    expect(lineage.terminals).toEqual([pattern.id]);
    expect(lineage.maxDepth).toBe(1); // 从 fact 看两侧都最深 1
  });

  it("DAG 多路径：diamond 形状", () => {
    //     pattern
    //    /       \
    //  fact1     fact2
    //    \       /
    //     observation
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const f1 = makeEngram({ title: "f1", kind: "fact" });
    const f2 = makeEngram({ title: "f2", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });

    addLineage(f1.id, obs.id, "derives_from");
    addLineage(f2.id, obs.id, "derives_from");
    addLineage(pattern.id, f1.id, "consolidates");
    addLineage(pattern.id, f2.id, "consolidates");

    const lineage = getEvolutionLineage(repo, pattern.id, {
      direction: "ancestors",
    });
    expect(lineage.nodes).toHaveLength(4); // pattern + f1 + f2 + obs
    expect(lineage.origins).toEqual([obs.id]);
    expect(lineage.edges).toHaveLength(4);
  });
});

// ============================================================
// 便捷函数
// ============================================================

describe("便捷函数", () => {
  it("getAncestors 等价于 direction=ancestors", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const hyp = makeEngram({ title: "hyp", kind: "hypothesis" });
    addLineage(hyp.id, obs.id, "derives_from");

    const r1 = getAncestors(repo, hyp.id);
    const r2 = getEvolutionLineage(repo, hyp.id, { direction: "ancestors" });
    expect(r1.nodes).toHaveLength(r2.nodes.length);
    expect(r1.edges.every((e) => e.direction === "ancestor")).toBe(true);
  });

  it("getDescendants 等价于 direction=descendants", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const hyp = makeEngram({ title: "hyp", kind: "hypothesis" });
    addLineage(hyp.id, obs.id, "derives_from");

    const r1 = getDescendants(repo, obs.id);
    expect(r1.nodes).toHaveLength(2);
  });

  it("traceToOriginObservations：找到最深 observation", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });
    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const origins = traceToOriginObservations(repo, pattern.id);
    expect(origins).toEqual([obs.id]);
  });

  it("traceToOriginObservations：无 ancestor → 空", () => {
    const a = makeEngram({ title: "A" });
    const origins = traceToOriginObservations(repo, a.id);
    expect(origins).toEqual([]);
  });

  it("traceToOriginObservations：origin 不是 observation → 不返回", () => {
    const fact = makeEngram({ title: "f1", kind: "fact" });
    const pattern = makeEngram({ title: "p", kind: "pattern" });
    addLineage(pattern.id, fact.id, "consolidates");

    const origins = traceToOriginObservations(repo, pattern.id);
    expect(origins).toEqual([]); // fact 不是 observation
  });

  it("findPathToAncestor：找到 root 到 ancestor 的路径", () => {
    const obs = makeEngram({ title: "obs" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });
    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const path = findPathToAncestor(repo, pattern.id, obs.id);
    expect(path).toEqual([pattern.id, fact.id, obs.id]);
  });

  it("findPathToAncestor：ancestor 不存在 → 空", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const path = findPathToAncestor(repo, a.id, b.id);
    expect(path).toEqual([]);
  });
});

// ============================================================
// computeLineageStats
// ============================================================

describe("computeLineageStats", () => {
  it("空仓库 → 全 0", () => {
    const s = computeLineageStats(repo);
    expect(s.totalLineageEdges).toBe(0);
    expect(s.engramsWithLineage).toBe(0);
    expect(s.orphanEngrams).toBe(0);
    expect(s.maxDepth).toBe(0);
  });

  it("孤立 engram → orphanEngrams 计数", () => {
    makeEngram({ title: "A" });
    makeEngram({ title: "B" });
    const s = computeLineageStats(repo);
    expect(s.orphanEngrams).toBe(2);
    expect(s.engramsWithLineage).toBe(0);
  });

  it("正确统计 lineage 边数和深度", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });
    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const s = computeLineageStats(repo);
    expect(s.totalLineageEdges).toBe(2);
    expect(s.engramsWithLineage).toBe(3); // obs + fact + pattern
    expect(s.orphanEngrams).toBe(0);
    expect(s.maxDepth).toBeGreaterThan(0);
  });
});

// ============================================================
// 端到端：从 Skill 到 observation 的完整链路
// ============================================================

describe("端到端：Skill → observation 反向追溯", () => {
  it("spec §4.6 验收场景", () => {
    // 模拟完整知识演化链：
    //   obs1, obs2, obs3 → fact1 (derives_from)
    //   obs4, obs5 → fact2
    //   fact1, fact2 → pattern (consolidates)
    //   pattern → procedure_v2 (supersedes pattern_v1)
    //   procedure_v2 → skill_procedure（kind=procedure，模拟 Skill 来源）

    const obs1 = makeEngram({
      title: "obs1",
      kind: "observation",
      domainTags: ["mobile"],
    });
    const obs2 = makeEngram({
      title: "obs2",
      kind: "observation",
      domainTags: ["mobile"],
    });
    const obs3 = makeEngram({
      title: "obs3",
      kind: "observation",
      domainTags: ["embedded"],
    });

    const fact1 = makeEngram({
      title: "fact1",
      kind: "fact",
      domainTags: ["mobile"],
    });
    addLineage(fact1.id, obs1.id, "derives_from");
    addLineage(fact1.id, obs2.id, "derives_from");
    addLineage(fact1.id, obs3.id, "derives_from");

    const pattern = makeEngram({
      title: "pattern",
      kind: "pattern",
      domainTags: ["mobile"],
    });
    addLineage(pattern.id, fact1.id, "consolidates");

    const procedureV1 = makeEngram({
      title: "procedure_v1",
      kind: "procedure",
      domainTags: ["mobile"],
    });
    addLineage(procedureV1.id, pattern.id, "derives_from");

    const procedureV2 = makeEngram({
      title: "procedure_v2",
      kind: "procedure",
      domainTags: ["mobile"],
    });
    addLineage(procedureV2.id, procedureV1.id, "supersedes");

    // 从 procedure_v2 反向追溯到所有 observation
    const lineage = getEvolutionLineage(repo, procedureV2.id, {
      direction: "ancestors",
    });
    expect(lineage.totalNodes).toBe(7); // procedureV2 + v1 + pattern + fact1 + obs1 + obs2 + obs3

    // origins = 所有叶子 ancestor（observation 是最深的）
    expect(lineage.origins.length).toBeGreaterThanOrEqual(3);
    expect(lineage.origins).toContain(obs1.id);
    expect(lineage.origins).toContain(obs2.id);
    expect(lineage.origins).toContain(obs3.id);

    // 路径验证：procedure_v2 → procedure_v1 → pattern → fact1 → obs1
    const path = findPathToAncestor(repo, procedureV2.id, obs1.id);
    expect(path).toEqual([
      procedureV2.id,
      procedureV1.id,
      pattern.id,
      fact1.id,
      obs1.id,
    ]);
  });

  it("血统图包含完整证据链（depth + relation）", () => {
    const obs = makeEngram({ title: "obs", kind: "observation" });
    const fact = makeEngram({ title: "fact", kind: "fact" });
    const pattern = makeEngram({ title: "pattern", kind: "pattern" });

    addLineage(fact.id, obs.id, "derives_from");
    addLineage(pattern.id, fact.id, "consolidates");

    const lineage = getEvolutionLineage(repo, pattern.id, {
      direction: "ancestors",
    });

    // depth + relation 检查
    const patternNode = lineage.nodes.find((n) => n.engramId === pattern.id)!;
    expect(patternNode.depth).toBe(0);
    expect(patternNode.relation).toBe("self");

    const factNode = lineage.nodes.find((n) => n.engramId === fact.id)!;
    expect(factNode.depth).toBe(1);
    expect(factNode.relation).toBe("consolidates");

    const obsNode = lineage.nodes.find((n) => n.engramId === obs.id)!;
    expect(obsNode.depth).toBe(2);
    expect(obsNode.relation).toBe("derives_from");
  });
});

// ============================================================
// 防环 / 异常
// ============================================================

describe("防环与异常", () => {
  it("自环（A derives_from A）：visited 阻止无限循环", () => {
    const a = makeEngram({ title: "A" });
    addLineage(a.id, a.id, "derives_from");

    const lineage = getEvolutionLineage(repo, a.id, { direction: "ancestors" });
    expect(lineage.nodes).toHaveLength(1); // 只有 A，不重复加入
  });

  it("互相引用（A→B + B→A）：visited 阻止无限循环", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addLineage(a.id, b.id, "derives_from");
    addLineage(b.id, a.id, "derives_from");

    const lineage = getEvolutionLineage(repo, a.id, { direction: "ancestors" });
    expect(lineage.nodes).toHaveLength(2); // A + B
    // 不应该继续追溯（B 已 visited）
  });
});

// ============================================================
// 默认 options
// ============================================================

describe("默认 options", () => {
  it("options 全省略时使用默认值", () => {
    const obs = makeEngram({ title: "obs" });
    const fact = makeEngram({ title: "f", kind: "fact" });
    addLineage(fact.id, obs.id, "derives_from");

    const lineage = getEvolutionLineage(repo, fact.id);
    expect(lineage.nodes).toHaveLength(2);
    expect(lineage.maxDepth).toBe(1);
  });
});
