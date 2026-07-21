// packages/core/test/rem-proposal.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { runRemDreaming } from "../src/dreaming/rem.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;

const stubEmbedder = async () => [1, 0, 0];
const stubAudit = { append: () => {} } as never;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rem-prop-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo,
    embedder: stubEmbedder,
    auditLog: stubAudit,
    dataRoot: tmpDir,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(title = "Test", kind: "fact" | "observation" | "pattern" = "fact") {
  return repo.createEngram({
    title,
    content: "content",
    kind,
    domainTags: ["test"],
    createdBy: "tester",
  });
}

// ============================================================
// proposeVerification
// ============================================================

describe("ProposalEngine.proposeVerification", () => {
  it("生成 centroidExcerpt 管道格式 title|before|action|score", () => {
    const e = makeEngram("My Engram");
    engine.proposeVerification(e.id, "My Engram", "plausible", "unverified", 0.75, "reasoning");
    const pending = engine.listPending();
    expect(pending).toHaveLength(1);
    const ce = pending[0]!.centroidExcerpt;
    expect(ce).toContain("|");
    const parts = ce.split("|");
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe("unverified");
    expect(parts[2]).toBe("plausible");
    expect(parts[3]).toBe("0.75");
  });

  it("source = rem-verification", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "refuted", "unverified", 0.22, "reason");
    const pending = engine.listPending();
    expect(pending[0]!.source).toBe("rem-verification");
  });

  it("entityId = rem:<engramId>", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.7, "r");
    expect(engine.listPending()[0]!.entityId).toBe(`rem:${e.id}`);
  });

  it("dedup: pending 覆盖(同 entityId 重复 propose)", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.7, "r1");
    engine.proposeVerification(e.id, e.title, "verified", "unverified", 0.9, "r2");
    const pending = engine.listPending();
    expect(pending).toHaveLength(1);
    // 后一次覆盖
    expect(pending[0]!.centroidExcerpt.split("|")[2]).toBe("verified");
  });

  it("dedup: accepted 跳过(不再 propose)", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.7, "r");
    engine.accept(`rem:${e.id}`, { createdBy: "test" });
    const result = engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.7, "r");
    expect(result).toBe(false);
    expect(engine.listPending()).toHaveLength(0);
  });
});

// ============================================================
// accept rem-verification → upgradeVerification (evidence 追加)
// ============================================================

describe("accept rem-verification → upgradeVerification", () => {
  it("升级: unverified → plausible,status + confidence 更新", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.75, "reason");
    engine.accept(`rem:${e.id}`, { createdBy: "test" });
    const after = repo.readEngram(e.id);
    expect(after.verificationStatus).toBe("plausible");
    expect(after.confidence).toBeGreaterThan(0.5); // confidence 上升
  });

  it("反驳: → refuted,confidence × 0.3", () => {
    const e = makeEngram();
    const before = repo.readEngram(e.id);
    engine.proposeVerification(e.id, e.title, "refuted", "unverified", 0.22, "reason");
    engine.accept(`rem:${e.id}`, { createdBy: "test" });
    const after = repo.readEngram(e.id);
    expect(after.verificationStatus).toBe("refuted");
    expect(after.confidence).toBeCloseTo((before.confidence ?? 0.5) * 0.3, 1);
  });

  it("跨级升级: unverified → verified,逐步升级 plausible→probable→verified", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "verified", "unverified", 0.9, "reason");
    engine.accept(`rem:${e.id}`, { createdBy: "test" });
    const after = repo.readEngram(e.id);
    expect(after.verificationStatus).toBe("verified");
  });

  it("proposal 状态变为 accepted", () => {
    const e = makeEngram();
    engine.proposeVerification(e.id, e.title, "plausible", "unverified", 0.7, "r");
    engine.accept(`rem:${e.id}`, { createdBy: "test" });
    const all = engine.listAll();
    expect(all[0]!.status).toBe("accepted");
  });
});

// ============================================================
// proposePattern
// ============================================================

describe("ProposalEngine.proposePattern", () => {
  it("生成 rem-pattern 提案 with payload", () => {
    engine.proposePattern({
      title: "Test Pattern",
      content: "Pattern content",
      summary: "Summary",
      confidence: 0.88,
      reason: "3 条相似记忆",
      sourceIds: ["id1", "id2", "id3"],
      domainTags: ["test"],
    });
    const pending = engine.listPending();
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p.source).toBe("rem-pattern");
    expect(p.payload).toBeDefined();
    expect(p.payload!.title).toBe("Test Pattern");
    expect(p.payload!.kind).toBe("pattern");
    expect(p.payload!.remConfidence).toBe(0.88);
    expect(p.payload!.remSourceIds).toEqual(["id1", "id2", "id3"]);
  });

  it("entityId = rem-pattern:<sourceIds hash>", () => {
    engine.proposePattern({
      title: "A", content: "c", summary: "s", confidence: 0.8,
      reason: "r", sourceIds: ["a", "b"], domainTags: ["t"],
    });
    const pending = engine.listPending();
    expect(pending[0]!.entityId).toMatch(/^rem-pattern:[a-f0-9]{16}$/);
  });

  it("dedup: 同 sourceIds 覆盖,不同 sourceIds 新建", () => {
    engine.proposePattern({
      title: "A", content: "c", summary: "s", confidence: 0.8,
      reason: "r", sourceIds: ["a", "b"], domainTags: ["t"],
    });
    engine.proposePattern({
      title: "A2", content: "c2", summary: "s2", confidence: 0.9,
      reason: "r2", sourceIds: ["a", "b"], domainTags: ["t"],
    });
    // 同 sourceIds → 覆盖,仍是 1 条
    expect(engine.listPending()).toHaveLength(1);

    engine.proposePattern({
      title: "B", content: "c", summary: "s", confidence: 0.8,
      reason: "r", sourceIds: ["x", "y"], domainTags: ["t"],
    });
    // 不同 sourceIds → 新建
    expect(engine.listPending()).toHaveLength(2);
  });
});

// ============================================================
// accept rem-pattern → createEngram + derives_from
// ============================================================

describe("accept rem-pattern → createEngram + derives_from", () => {
  it("创建新 pattern engram + connects derives_from", () => {
    const src1 = makeEngram("Source 1");
    const src2 = makeEngram("Source 2");
    const src3 = makeEngram("Source 3");
    engine.proposePattern({
      title: "Abstracted Pattern",
      content: "Pattern content",
      summary: "Pattern summary",
      confidence: 0.88,
      reason: "3 sources",
      sourceIds: [src1.id, src2.id, src3.id],
      domainTags: ["test"],
    });
    const pending = engine.listPending();
    const entityId = pending[0]!.entityId;

    const newId = engine.accept(entityId, { createdBy: "test" });
    expect(newId).toBeDefined();

    const pattern = repo.readEngram(newId);
    expect(pattern.kind).toBe("pattern");
    expect(pattern.title).toBe("Abstracted Pattern");
    expect(pattern.confidence).toBeCloseTo(0.88, 2);

    // derives_from synapses
    const syns = repo.readSynapses(newId);
    const derives = syns.outgoing.filter((s) => s.kind === "derives_from");
    expect(derives).toHaveLength(3);
  });

  it("path conflict: adopt existing engram(同 title)", () => {
    // 先创建一个 pattern engram
    const existing = repo.createEngram({
      title: "Conflict Pattern",
      content: "Existing",
      kind: "pattern",
      domainTags: ["test"],
      createdBy: "tester",
    });
    // 再 propose 同 title 的 rem-pattern
    const src1 = makeEngram("Src");
    engine.proposePattern({
      title: "Conflict Pattern", // 同 title → deriveDefaultPath 会冲突
      content: "New",
      summary: "s",
      confidence: 0.85,
      reason: "r",
      sourceIds: [src1.id],
      domainTags: ["test"],
    });
    const pending = engine.listPending();
    // accept 应该 adopt existing,不抛 400
    const result = engine.accept(pending[0]!.entityId, { createdBy: "test" });
    expect(result).toBeDefined();
  });
});

// ============================================================
// runRemDreaming with proposalEngine (不自动创建)
// ============================================================

describe("runRemDreaming + proposalEngine", () => {
  it("注入 proposalEngine 时不自动 createEngram,而是 proposePattern", async () => {
    // 创建 3 个相似 engram(够 minClusterSize=3)
    makeEngram("Test A", "fact");
    makeEngram("Test B", "fact");
    makeEngram("Test C", "fact");

    const collected: unknown[] = [];
    const stubEngine = {
      proposePattern: (input: unknown) => {
        collected.push(input);
        return true;
      },
    };

    const before = repo.listEngrams().length;
    await runRemDreaming(repo, {
      proposalEngine: stubEngine as never,
      minClusterSize: 3,
    });

    // 不自动创建新 engram(importance 不变)
    const after = repo.listEngrams().length;
    expect(after).toBe(before);
  });
});

// ============================================================
// runRemDreaming rem-synapse add 发现
// ============================================================

describe("runRemDreaming rem-synapse add 发现", () => {
  it("cluster 内 representative→成员 未连则提议 add similar_to", async () => {
    // makeEngram(title, kind) 是该文件现有 helper;3 个相似 engram 聚成 1 cluster
    makeEngram("Test A", "fact");
    makeEngram("Test B", "fact");
    makeEngram("Test C", "fact");

    const proposed: { op: string; kind: string }[] = [];
    const stubEngine = {
      proposePattern: () => true,
      proposeSynapseOp: (input: { op: string; kind: string }) => {
        proposed.push(input);
        return true;
      },
    };

    await runRemDreaming(repo, {
      proposalEngine: stubEngine as never,
      minClusterSize: 3,
    });

    const adds = proposed.filter((p) => p.op === "add");
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(adds.every((p) => p.kind === "similar_to")).toBe(true);
  });

  it("已存在 member→rep 的 directional similar_to 时,不重复提议 rep→member", async () => {
    const a = makeEngram("Test A", "fact");
    const b = makeEngram("Test B", "fact");
    const c = makeEngram("Test C", "fact");
    // 预置一条 b→a 的 directional similar_to(b 是某成员,a 可能是 representative)
    const ts = new Date().toISOString();
    repo.addOutgoingSynapse(b.id, {
      id: randomUUID(), from: b.id, to: a.id, kind: "similar_to",
      weight: 0.5, direction: "directional", evidence: [], createdBy: "tester",
      createdAt: ts, updatedAt: ts, retrievalWeight: 0.5, visibility: "public",
    });

    const proposed: { op: string; from: string; to: string }[] = [];
    const stubEngine = {
      proposePattern: () => true,
      proposeSynapseOp: (input: { op: string; from: string; to: string }) => {
        proposed.push(input);
        return true;
      },
    };
    await runRemDreaming(repo, { proposalEngine: stubEngine as never, minClusterSize: 3 });

    // 不应再提议 a→b 或 b→a(两端已通过 b→a 相连)
    const dupAB = proposed.some((p) => p.op === "add" && p.from === a.id && p.to === b.id);
    const dupBA = proposed.some((p) => p.op === "add" && p.from === b.id && p.to === a.id);
    expect(dupAB || dupBA).toBe(false);
  });

  it("两记忆间有 derives_from（非 similar_to）突触时,不提议 add similar_to", async () => {
    const a = makeEngram("Test A", "fact");
    const b = makeEngram("Test B", "fact");
    const c = makeEngram("Test C", "fact");
    // 预置一条 b→a 的 derives_from 突触（非 similar_to）
    const ts = new Date().toISOString();
    repo.addOutgoingSynapse(b.id, {
      id: randomUUID(), from: b.id, to: a.id, kind: "derives_from",
      weight: 0.5, direction: "directional", evidence: [], createdBy: "tester",
      createdAt: ts, updatedAt: ts, retrievalWeight: 0.5, visibility: "public",
    });

    const proposed: { op: string; from: string; to: string; kind: string }[] = [];
    const stubEngine = {
      proposePattern: () => true,
      proposeSynapseOp: (input: { op: string; from: string; to: string; kind: string }) => {
        proposed.push(input);
        return true;
      },
    };
    await runRemDreaming(repo, { proposalEngine: stubEngine as never, minClusterSize: 3 });

    // 不应再提议 a↔b 间的 similar_to（两端已通过 derives_from 相连）
    const similarAB = proposed.some((p) =>
      p.op === "add" && p.kind === "similar_to" &&
      ((p.from === a.id && p.to === b.id) || (p.from === b.id && p.to === a.id))
    );
    expect(similarAB).toBe(false);
  });
});

// ============================================================
// runRemDreaming rem-synapse delete/retype 发现 (P1+P2)
// ============================================================
describe("runRemDreaming rem-synapse delete/retype 发现", () => {
  it("两端 token 不交 + domainTags 不交 → 提议 delete", async () => {
    const a = repo.createEngram({ title: "Alpha", content: "machine learning neural network deep learning", kind: "fact", domainTags: ["ml"], createdBy: "tester" });
    const b = repo.createEngram({ title: "Beta", content: "番茄炒蛋放糖还是放盐", kind: "observation", domainTags: ["life"], createdBy: "tester" });
    const ts = new Date().toISOString();
    repo.addOutgoingSynapse(a.id, {
      id: randomUUID(),
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "tester",
      createdAt: ts,
      updatedAt: ts,
      retrievalWeight: 0.5,
      visibility: "public",
    });

    const proposed: { op: string }[] = [];
    await runRemDreaming(repo, {
      deleteJaccardThreshold: 0.3,
      proposalEngine: {
        proposePattern: () => true,
        proposeSynapseOp: (input: { op: string }) => {
          proposed.push(input);
          return true;
        },
      } as never,
    });
    expect(proposed.some((p) => p.op === "delete")).toBe(true);
  });

  it("similar_to 但 pattern→fact → 提议 retype extends", async () => {
    const fact = repo.createEngram({ title: "FactBase", content: "基础事实", kind: "fact", domainTags: ["test"], createdBy: "tester" });
    const pattern = repo.createEngram({ title: "PatternGen", content: "泛化模式", kind: "pattern", domainTags: ["test"], createdBy: "tester" });
    const ts = new Date().toISOString();
    repo.addOutgoingSynapse(pattern.id, {
      id: randomUUID(),
      from: pattern.id,
      to: fact.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "tester",
      createdAt: ts,
      updatedAt: ts,
      retrievalWeight: 0.5,
      visibility: "public",
    });

    const proposed: { op: string; kind: string }[] = [];
    await runRemDreaming(repo, {
      proposalEngine: {
        proposePattern: () => true,
        proposeSynapseOp: (input: { op: string; kind: string }) => {
          proposed.push(input);
          return true;
        },
      } as never,
    });
    expect(proposed.some((p) => p.op === "retype" && p.kind === "extends")).toBe(true);
  });
});
