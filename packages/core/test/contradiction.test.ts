import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { EngramRepository } from "../src/storage/repository.js";
import {
  detectContradictions,
  statsContradictions,
  LocalHeuristicContradictionArbiter,
  validateArbiterOutput,
  shouldAutoExecute,
  resolveContradiction,
  processExpiredContradictions,
  manualResolveContradiction,
  type ContradictionArbiter,
  type ArbitrateInput,
  type ArbitrateOutput,
} from "../src/contradiction/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-contradiction-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  confidence?: number;
  sourceType?: "firsthand" | "secondhand" | "inferred";
  evidenceCount?: number;
  createdBy?: string;
}) {
  const e = repo.createEngram({
    title: input.title,
    content: input.content,
    kind: "observation",
    domainTags: ["t"],
    createdBy: input.createdBy ?? "y",
    confidence: input.confidence ?? 0.5,
    sourceType: input.sourceType ?? "firsthand",
  });
  // evidenceCount 通过 bumpRetrievalStats 累积 effective
  if (input.evidenceCount && input.evidenceCount > 0) {
    repo.bumpRetrievalStats(e.id, { effectiveDelta: input.evidenceCount });
  }
  return e;
}

function linkContradicts(
  fromId: string,
  toId: string,
  evidence: string[] = [],
): string {
  const synapseId = `syn-${randomUUID().slice(0, 8)}`;
  const stored = repo.addOutgoingSynapse(fromId, {
    id: synapseId,
    from: fromId,
    to: toId,
    kind: "contradicts",
    weight: 0.8,
    direction: "directional",
    evidence: evidence.map((description) => ({
      description,
      addedAt: "2026-01-01T00:00:00Z",
      addedBy: "test",
    })),
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.8,
  });
  return stored.id;
}

// ============================================================
// detector
// ============================================================

describe("detectContradictions", () => {
  it("空仓库 → 空", () => {
    expect(detectContradictions(repo)).toEqual([]);
  });

  it("无 contradicts → 空", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    repo.addOutgoingSynapse(a.id, {
      id: "s1",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.5,
    });
    expect(detectContradictions(repo)).toEqual([]);
  });

  it("检测到 contradicts synapse", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    linkContradicts(a.id, b.id);
    const result = detectContradictions(repo);
    expect(result.length).toBe(1);
    expect(result[0]!.fromId).toBe(a.id);
    expect(result[0]!.toId).toBe(b.id);
    expect(result[0]!.status).toBe("none");
  });

  it("按 fromId 字典序稳定排序", () => {
    const c = makeEngram({ title: "C", content: "c" });
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    linkContradicts(c.id, a.id);
    linkContradicts(a.id, b.id);
    const result = detectContradictions(repo);
    // 结果应按 fromId 字典序升序排列(ULID 自然时间序)
    const fromIds = result.map((r) => r.fromId);
    const sorted = [...fromIds].sort();
    expect(fromIds).toEqual(sorted);
    expect(new Set(fromIds)).toEqual(new Set([a.id, c.id]));
  });

  it("filterStatus 过滤", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);
    repo.updateSynapseResolution(a.id, sid, {
      status: "escalated",
      phase: 2,
    });
    expect(
      detectContradictions(repo, { filterStatus: "escalated" }).length,
    ).toBe(1);
    expect(detectContradictions(repo, { filterStatus: "pending" }).length).toBe(
      0,
    );
  });
});

describe("statsContradictions", () => {
  it("按状态统计", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    linkContradicts(a.id, b.id);
    const stats = statsContradictions(repo);
    expect(stats.total).toBe(1);
    expect(stats.none).toBe(1);
    expect(stats.pending).toBe(0);
  });
});

// ============================================================
// arbiter
// ============================================================

describe("LocalHeuristicContradictionArbiter", () => {
  const arbiter = new LocalHeuristicContradictionArbiter();

  it("confidence 差距大 → keep 高方", () => {
    const result = arbiter.arbitrate({
      newEngram: {
        id: "n",
        title: "N",
        summary: "s",
        content: "c",
        confidence: 0.9,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      oldEngram: {
        id: "o",
        title: "O",
        summary: "s",
        content: "c",
        confidence: 0.5,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      contradictionEvidence: [],
    });
    expect(result.verdict).toBe("keep_new");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("evidence 差距大 → keep 多证据方", () => {
    const result = arbiter.arbitrate({
      newEngram: {
        id: "n",
        title: "N",
        summary: "s",
        content: "c",
        confidence: 0.7,
        sourceType: "firsthand",
        evidenceCount: 5,
      },
      oldEngram: {
        id: "o",
        title: "O",
        summary: "s",
        content: "c",
        confidence: 0.7,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      contradictionEvidence: [],
    });
    expect(result.verdict).toBe("keep_new");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("sourceType 差距大 → keep firsthand 方", () => {
    const result = arbiter.arbitrate({
      newEngram: {
        id: "n",
        title: "N",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      oldEngram: {
        id: "o",
        title: "O",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "inferred",
        evidenceCount: 0,
      },
      contradictionEvidence: [],
    });
    expect(result.verdict).toBe("keep_new");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("同等条件 → merge + 低 confidence", () => {
    const result = arbiter.arbitrate({
      newEngram: {
        id: "n",
        title: "N",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      oldEngram: {
        id: "o",
        title: "O",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      contradictionEvidence: [],
    });
    expect(result.verdict).toBe("merge");
    expect(result.confidence).toBeLessThan(0.8);
  });

  it("总是给出 rationale", () => {
    const result = arbiter.arbitrate({
      newEngram: {
        id: "n",
        title: "N",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      oldEngram: {
        id: "o",
        title: "O",
        summary: "s",
        content: "c",
        confidence: 0.6,
        sourceType: "firsthand",
        evidenceCount: 0,
      },
      contradictionEvidence: [],
    });
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});

describe("validateArbiterOutput", () => {
  it("合法输出不抛错", () => {
    expect(() =>
      validateArbiterOutput({
        verdict: "keep_new",
        rationale: "reason",
        confidence: 0.9,
      }),
    ).not.toThrow();
  });

  it("非法 verdict 抛错", () => {
    expect(() =>
      validateArbiterOutput({
        verdict: "invalid" as never,
        rationale: "r",
        confidence: 0.9,
      }),
    ).toThrow(/verdict/);
  });

  it("空 rationale 抛错", () => {
    expect(() =>
      validateArbiterOutput({
        verdict: "keep_new",
        rationale: "",
        confidence: 0.9,
      }),
    ).toThrow(/rationale/);
  });

  it("confidence 越界抛错", () => {
    expect(() =>
      validateArbiterOutput({
        verdict: "keep_new",
        rationale: "r",
        confidence: 1.5,
      }),
    ).toThrow(/confidence/);
  });
});

describe("shouldAutoExecute", () => {
  it("confidence ≥ 0.8 且非 archive → 自动", () => {
    expect(
      shouldAutoExecute({
        verdict: "keep_new",
        rationale: "r",
        confidence: 0.85,
      }),
    ).toBe(true);
  });

  it("confidence < 0.8 → 不自动", () => {
    expect(
      shouldAutoExecute({
        verdict: "keep_new",
        rationale: "r",
        confidence: 0.7,
      }),
    ).toBe(false);
  });

  it("archive 永远不自动", () => {
    expect(
      shouldAutoExecute({
        verdict: "archive",
        rationale: "r",
        confidence: 0.95,
      }),
    ).toBe(false);
  });
});

// ============================================================
// resolveContradiction
// ============================================================

describe("resolveContradiction", () => {
  const NOW = new Date("2026-06-20T00:00:00Z");

  it("synapse 不存在 → 抛错", async () => {
    const a = makeEngram({ title: "A", content: "a" });
    await expect(
      resolveContradiction(
        repo,
        { fromId: a.id, synapseId: "no-such" },
        { now: NOW },
      ),
    ).rejects.toThrow(/not found/);
  });

  it("非 contradicts synapse → 抛错", async () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const stored = repo.addOutgoingSynapse(a.id, {
      id: "s1",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.5,
    });
    await expect(
      resolveContradiction(
        repo,
        { fromId: a.id, synapseId: stored.id },
        { now: NOW },
      ),
    ).rejects.toThrow(/not a contradicts/);
  });

  it("阶段 1 自动裁决：高 confidence → keep_new", async () => {
    const a = makeEngram({ title: "A", content: "a", confidence: 0.9 });
    const b = makeEngram({ title: "B", content: "b", confidence: 0.5 });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: NOW },
    );
    expect(result.finalPhase).toBe(1);
    expect(result.finalStatus).toBe("auto_resolved");
    expect(result.verdict).toBe("keep_new");

    // old (b) verificationStatus = 'refuted'
    expect(repo.readEngram(b.id).verificationStatus).toBe("refuted");
  });

  it("阶段 1 keep_old: old confidence 高", async () => {
    const a = makeEngram({ title: "A", content: "a", confidence: 0.5 });
    const b = makeEngram({ title: "B", content: "b", confidence: 0.9 });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: NOW },
    );
    expect(result.verdict).toBe("keep_old");
    expect(repo.readEngram(a.id).verificationStatus).toBe("refuted");
  });

  it("阶段 1 merge: 合并 + 删除 synapse", async () => {
    // 用 stub arbiter 强制返回 merge + 高 confidence
    const stubArbiter: ContradictionArbiter = {
      arbitrate(_input: ArbitrateInput): ArbitrateOutput {
        return {
          verdict: "merge",
          rationale: "test merge",
          confidence: 0.9,
        };
      },
    };
    const a = makeEngram({ title: "A", content: "内容 A", confidence: 0.7 });
    const b = makeEngram({ title: "B", content: "内容 B", confidence: 0.7 });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: NOW, arbiter: stubArbiter },
    );
    expect(result.verdict).toBe("merge");
    expect(result.finalPhase).toBe(1);

    // synapse 已删除
    const file = repo.readSynapses(a.id);
    expect(file.outgoing.find((s) => s.id === sid)).toBeUndefined();
    // b 的 content 包含 a 的内容
    const bUpdated = repo.readEngram(b.id);
    expect(bUpdated.content).toContain("内容 A");
    expect(bUpdated.content).toContain("内容 B");
  });

  it("阶段 2 升级：低 confidence → escalated + expiresAt", async () => {
    // 强制低 confidence
    const stubArbiter: ContradictionArbiter = {
      arbitrate(): ArbitrateOutput {
        return { verdict: "merge", rationale: "low conf", confidence: 0.5 };
      },
    };
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b", createdBy: "owner-b" });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: NOW, arbiter: stubArbiter, escalationTimeoutDays: 3 },
    );
    expect(result.finalPhase).toBe(2);
    expect(result.finalStatus).toBe("escalated");

    // synapse resolutionState 落盘
    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.resolutionState).toBeDefined();
    expect(synapse.resolutionState!.status).toBe("escalated");
    expect(synapse.resolutionState!.phase).toBe(2);
    expect(synapse.resolutionState!.escalatedTo).toBe("owner-b");
    expect(synapse.resolutionState!.expiresAt).toBeDefined();
    // expiresAt = NOW + 3 days
    const expMs = new Date(synapse.resolutionState!.expiresAt!).getTime();
    const expected = NOW.getTime() + 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expMs - expected)).toBeLessThan(1000);
  });

  it("dryRun（persist=false）→ 不落盘", async () => {
    const a = makeEngram({ title: "A", content: "a", confidence: 0.9 });
    const b = makeEngram({ title: "B", content: "b", confidence: 0.5 });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: NOW, persist: false },
    );
    expect(result.persisted).toBe(false);
    // b verificationStatus 未改(默认 'unverified')
    expect(repo.readEngram(b.id).verificationStatus).toBe("unverified");
  });
});

// ============================================================
// processExpiredContradictions
// ============================================================

describe("processExpiredContradictions", () => {
  it("无超时 → 空 degraded", () => {
    expect(processExpiredContradictions(repo)).toEqual({
      scanned: 0,
      degraded: [],
    });
  });

  it("未超时 → 不降级", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);
    repo.updateSynapseResolution(a.id, sid, {
      status: "escalated",
      phase: 2,
      expiresAt: "2026-12-31T00:00:00Z",
    });
    const result = processExpiredContradictions(repo, {
      now: new Date("2026-06-20T00:00:00Z"),
    });
    expect(result.scanned).toBe(1);
    expect(result.degraded.length).toBe(0);
  });

  it("已超时 → 降级为 contested", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);
    repo.updateSynapseResolution(a.id, sid, {
      status: "escalated",
      phase: 2,
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const result = processExpiredContradictions(repo, {
      now: new Date("2026-06-20T00:00:00Z"),
    });
    expect(result.degraded.length).toBe(1);
    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.resolutionState!.status).toBe("contested");
    expect(synapse.resolutionState!.phase).toBe(3);
  });

  it("activeContradictionCount 在 contested 后扣减", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);
    repo.updateSynapseResolution(a.id, sid, {
      status: "escalated",
      phase: 2,
      expiresAt: "2020-01-01T00:00:00Z",
    });
    expect(repo.readEngram(b.id).activeContradictionCount).toBe(1);
    processExpiredContradictions(repo, {
      now: new Date("2026-06-20T00:00:00Z"),
    });
    expect(repo.readEngram(b.id).activeContradictionCount).toBe(0);
  });
});

// ============================================================
// manualResolveContradiction
// ============================================================

describe("manualResolveContradiction", () => {
  it("人工标记 resolved", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);
    repo.updateSynapseResolution(a.id, sid, {
      status: "escalated",
      phase: 2,
      expiresAt: "2026-12-31T00:00:00Z",
    });

    const result = manualResolveContradiction(repo, {
      fromId: a.id,
      synapseId: sid,
      verdict: "keep_new",
      rationale: "human decided",
      resolvedBy: "yang",
    });
    expect(result.finalStatus).toBe("resolved");

    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.resolutionState!.status).toBe("resolved");
    expect(synapse.resolutionState!.resolvedBy).toBe("yang");
    expect(synapse.resolutionState!.rationale).toBe("human decided");
  });

  it("非 contradicts synapse → 抛错", () => {
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const stored = repo.addOutgoingSynapse(a.id, {
      id: "s1",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "directional",
      evidence: [],
      createdBy: "y",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.5,
    });
    expect(() =>
      manualResolveContradiction(repo, {
        fromId: a.id,
        synapseId: stored.id,
        verdict: "keep_new",
        rationale: "r",
        resolvedBy: "y",
      }),
    ).toThrow(/[Nn]ot a contradicts/);
  });
});

// ============================================================
// spec 验收：三阶段完整流程
// ============================================================

describe("spec 验收：Contradiction Resolution 三阶段", () => {
  it("阶段 1：高置信度矛盾自动解决", async () => {
    const a = makeEngram({ title: "A", content: "a", confidence: 0.95 });
    const b = makeEngram({ title: "B", content: "b", confidence: 0.4 });
    const sid = linkContradicts(a.id, b.id);

    const result = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: new Date("2026-06-20T00:00:00Z") },
    );

    expect(result.finalPhase).toBe(1);
    expect(result.finalStatus).toBe("auto_resolved");
    expect(result.verdict).toBe("keep_new");
    expect(repo.readEngram(b.id).verificationStatus).toBe("refuted");
  });

  it("阶段 2 → 3：低置信度升级 → 超时降级", async () => {
    const stubArbiter: ContradictionArbiter = {
      arbitrate(): ArbitrateOutput {
        return { verdict: "merge", rationale: "uncertain", confidence: 0.5 };
      },
    };
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b", createdBy: "owner" });
    const sid = linkContradicts(a.id, b.id);

    // 阶段 2：升级
    const r2 = await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      {
        now: new Date("2026-06-01T00:00:00Z"),
        arbiter: stubArbiter,
        escalationTimeoutDays: 7,
      },
    );
    expect(r2.finalPhase).toBe(2);
    expect(r2.finalStatus).toBe("escalated");

    // 阶段 3：20 天后超时降级
    const r3 = processExpiredContradictions(repo, {
      now: new Date("2026-06-20T00:00:00Z"),
    });
    expect(r3.degraded.length).toBe(1);

    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.resolutionState!.status).toBe("contested");
    expect(synapse.resolutionState!.phase).toBe(3);
  });

  it("阶段 2 → resolved：人工介入解决", async () => {
    const stubArbiter: ContradictionArbiter = {
      arbitrate(): ArbitrateOutput {
        return { verdict: "merge", rationale: "uncertain", confidence: 0.5 };
      },
    };
    const a = makeEngram({ title: "A", content: "a" });
    const b = makeEngram({ title: "B", content: "b" });
    const sid = linkContradicts(a.id, b.id);

    await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: new Date("2026-06-01T00:00:00Z"), arbiter: stubArbiter },
    );

    // 人工介入
    manualResolveContradiction(repo, {
      fromId: a.id,
      synapseId: sid,
      verdict: "keep_old",
      rationale: "调查后确认旧版",
      resolvedBy: "yang",
    });

    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.resolutionState!.status).toBe("resolved");
    expect(synapse.resolutionState!.verdict).toBe("keep_old");
    expect(synapse.resolutionState!.resolvedBy).toBe("yang");
  });

  it("revisionHistory 通过 evidence 数组追加（spec：无需新增字段）", async () => {
    const a = makeEngram({ title: "A", content: "a", confidence: 0.9 });
    const b = makeEngram({ title: "B", content: "b", confidence: 0.5 });
    const sid = linkContradicts(a.id, b.id, ["initial contradiction evidence"]);

    await resolveContradiction(
      repo,
      { fromId: a.id, synapseId: sid },
      { now: new Date("2026-06-20T00:00:00Z") },
    );

    // keep_new 后 evidence 应该包含初始证据 + auto 裁决记录
    const file = repo.readSynapses(a.id);
    const synapse = file.outgoing.find((s) => s.id === sid)!;
    expect(synapse.evidence.length).toBeGreaterThanOrEqual(2);
    expect(
      synapse.evidence.some((e) => e.description.includes("initial")),
    ).toBe(true);
    expect(synapse.evidence.some((e) => e.description.includes("auto:"))).toBe(
      true,
    );
  });
});
