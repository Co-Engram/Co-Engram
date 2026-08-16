import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { refineSynapsesOnActiveGraph } from "../../src/dreaming/synapse-refiner.js";

/**
 * 验证 synapse-refiner(二期 agent-driven)局部图遍历 + 候选对计算 + proposeSynapseOp。
 * 不调 LLM——候选对(无 edge)→ proposeSynapseOp(add similar_to 占位)→ agent review。
 */
describe("refineSynapsesOnActiveGraph", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-syn-refine-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir, language: "zh" }, indexDb);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("活跃 A + 邻居 N → 候选对(无edge propose add, 有edge skip)", async () => {
    const now = new Date().toISOString();
    const a1 = repo.createEngram({
      title: "A1", content: "alpha beta gamma content", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    const a2 = repo.createEngram({
      title: "A2", content: "alpha beta delta content", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    const n1 = repo.createEngram({
      title: "N1 neighbor", content: "alpha beta epsilon neighbor", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    repo.bumpRetrievalStats(a1.id, { lastRetrievedAt: "2027-01-01T00:00:00.000Z" });
    repo.bumpRetrievalStats(a2.id, { lastRetrievedAt: "2027-01-01T00:00:00.000Z" });
    repo.addOutgoingSynapse(a1.id, {
      id: ulid(), from: a1.id, to: n1.id, kind: "similar_to",
      weight: 0.5, direction: "directional", evidence: [],
      createdBy: "test", createdAt: now, updatedAt: now,
      retrievalWeight: 0.5, visibility: "public",
    });

    // mock proposalEngine 收集 proposeSynapseOp 调用
    const proposed: Array<{ from: string; to: string; op: string; kind: string }> = [];
    const proposalEngine = {
      proposeSynapseOp: (input: { from: string; to: string; op: string; kind: string }): boolean => {
        proposed.push({ from: input.from, to: input.to, op: input.op, kind: input.kind });
        return true;
      },
    };

    const result = await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      lastRemAt: "2026-12-01T00:00:00.000Z",
    });

    expect(result.activeCount).toBe(2);
    expect(result.neighborCount).toBe(1);
    expect(result.candidatePairs.length).toBeGreaterThan(0);
    // a1-a2(无edge)→ propose add similar_to
    const a1a2Propose = proposed.find(
      (p) => (p.from === a1.id && p.to === a2.id) || (p.from === a2.id && p.to === a1.id),
    );
    expect(a1a2Propose).toBeDefined();
    expect(a1a2Propose?.op).toBe("add");
    expect(a1a2Propose?.kind).toBe("similar_to");
    // a1-n1(有edge)→ 不 propose(agent 用 synapse 工具评估)
    const a1n1Propose = proposed.find(
      (p) => (p.from === a1.id && p.to === n1.id) || (p.from === n1.id && p.to === a1.id),
    );
    expect(a1n1Propose).toBeUndefined();
    expect(result.proposed).toBe(proposed.length);
  });

  it("冷启动(无 lastRemAt)→ 所有 active engram 活跃", async () => {
    repo.createEngram({
      title: "A1", content: "alpha beta", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    const result = await refineSynapsesOnActiveGraph(repo, undefined, {});
    expect(result.activeCount).toBe(1);
  });

  it("无活跃 → 空候选 + 0 proposed", async () => {
    repo.createEngram({
      title: "A1", content: "alpha beta", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    const result = await refineSynapsesOnActiveGraph(repo, undefined, {
      lastRemAt: "2027-12-01T00:00:00.000Z",
    });
    expect(result.activeCount).toBe(0);
    expect(result.candidatePairs).toHaveLength(0);
    expect(result.proposed).toBe(0);
  });

  it("三层节流:Jaccard < 0.25 的对不 propose(阈值上调 2026-08-18)", async () => {
    // 两记忆只共享 1 个低频词,Jaccard 远低于 0.25
    repo.createEngram({
      title: "X1", content: "alpha one two three four", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    repo.createEngram({
      title: "Y1", content: "alpha five six seven eight", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    const proposed: string[] = [];
    const proposalEngine = {
      proposeSynapseOp: (input: { from: string }): boolean => {
        proposed.push(input.from);
        return true;
      },
    };
    // 冷启动:全部活跃
    const result = await refineSynapsesOnActiveGraph(repo, proposalEngine, {});
    expect(result.candidatePairs).toHaveLength(0); // 低于阈值连候选对都不进
    expect(proposed).toHaveLength(0);
    expect(result.proposed).toBe(0);
  });

  it("三层节流:hub 单节点候选 ≤ 5(相似度降序保留 top)", async () => {
    // 8 节点共享核心词池 → 两两高相似(Jaccard ≈ 0.7+),全对过筛。
    // HUB 无配额时会出现 7 条边;配额 5 下恰好截断。
    const hub = repo.createEngram({
      title: "HUB", content: "shared core topic words pool", kind: "fact",
      domainTags: ["t"], createdBy: "test",
    });
    for (let i = 0; i < 7; i++) {
      repo.createEngram({
        title: `M${i}`, content: `shared core topic words pool u${i}`, kind: "fact",
        domainTags: ["t"], createdBy: "test",
      });
    }
    const proposedEdges: Array<{ from: string; to: string }> = [];
    const proposalEngine = {
      proposeSynapseOp: (input: { from: string; to: string }): boolean => {
        proposedEdges.push({ from: input.from, to: input.to });
        return true;
      },
    };
    await refineSynapsesOnActiveGraph(repo, proposalEngine, {});
    const hubEdges = proposedEdges.filter(
      (e) => e.from === hub.id || e.to === hub.id,
    );
    expect(hubEdges.length).toBe(5);
  });

  it("三层节流:单轮总量 ≤ 30(保险丝)", async () => {
    // 13 节点两两高相似 → 78 对过筛;hub≤5 约束后可达 ~32 条,触发总量 ≤30 截断。
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ");
    for (let i = 0; i < 13; i++) {
      repo.createEngram({
        title: `N${i}`, content: `${words} e${i}`, kind: "fact",
        domainTags: ["t"], createdBy: "test",
      });
    }
    const proposed: string[] = [];
    const proposalEngine = {
      proposeSynapseOp: (input: { from: string }): boolean => {
        proposed.push(input.from);
        return true;
      },
    };
    const result = await refineSynapsesOnActiveGraph(repo, proposalEngine, {});
    expect(result.candidatePairs.length).toBe(78); // 过筛本身不节流(供 agent review)
    expect(proposed.length).toBe(30);
    expect(result.proposed).toBe(30);
  });
});
