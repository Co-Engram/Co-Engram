import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import type { Synapse, SynapseKind } from "../src/types/synapse.js";

function setup(): { engine: ProposalEngine; repo: EngramRepository; dir: string } {
  const dir = join(process.cwd(), ".tmp-rem-synapse-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const repo = new EngramRepository({ rootPath: dir, language: "zh" });
  const auditLog = new AuditLog(dir);
  const engine = new ProposalEngine({
    repository: repo,
    embedder: async () => [1, 0, 0],
    auditLog,
    dataRoot: dir,
  });
  return { engine, repo, dir };
}

describe("rem-synapse ProposalSource", () => {
  it("ProposalSource 联合类型包含 rem-synapse", () => {
    const src: import("../src/observability/proposal-engine.js").ProposalSource =
      "rem-synapse";
    expect(src).toBe("rem-synapse");
  });
});

describe("proposeSynapseOp", () => {
  it("add 操作生成 pending 提案,entityId 幂等", () => {
    const { engine } = setup();
    const a = engine.proposeSynapseOp({
      op: "add",
      from: "A",
      to: "B",
      kind: "similar_to",
      reason: "聚类相似",
      confidence: 0.8,
      fromTitle: "记忆A",
      toTitle: "记忆B",
    });
    expect(a).toBe(true);
    const pending = engine.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.source).toBe("rem-synapse");
    expect(pending[0]!.entityId).toMatch(
      /^rem-synapse:add:[0-9a-f]{16}$/,
    );
    // 重复 propose 同 op+endpoints+kind → 覆盖,occurrences +1,不新增
    const b = engine.proposeSynapseOp({
      op: "add",
      from: "A",
      to: "B",
      kind: "similar_to",
      reason: "聚类相似",
      confidence: 0.82,
      fromTitle: "A",
      toTitle: "B",
    });
    expect(b).toBe(true);
    expect(engine.listPending()).toHaveLength(1);
    expect(engine.listPending()[0]!.occurrences).toBe(2);
  });

  it("delete / retype 的 entityId 与 add 不同(op 入 key)", () => {
    const { engine } = setup();
    engine.proposeSynapseOp({
      op: "add",
      from: "A",
      to: "B",
      kind: "similar_to",
      reason: "r",
      confidence: 0.7,
    });
    engine.proposeSynapseOp({
      op: "delete",
      from: "A",
      to: "B",
      kind: "similar_to",
      oldKind: "similar_to",
      reason: "r",
      confidence: 0.7,
    });
    engine.proposeSynapseOp({
      op: "retype",
      from: "A",
      to: "B",
      kind: "extends",
      oldKind: "similar_to",
      reason: "r",
      confidence: 0.7,
    });
    expect(engine.listPending()).toHaveLength(3);
  });
});

function makeEngram(repo: EngramRepository, id: string) {
  return repo.createEngram({
    title: id,
    content: `内容 ${id}`,
    kind: "fact",
    domainTags: ["t"],
    createdBy: "tester",
  });
}

function makeSynapse(repo: EngramRepository, from: string, to: string, kind: SynapseKind) {
  const ts = new Date().toISOString();
  const s: Synapse = {
    id: randomUUID(),
    from,
    to,
    kind,
    weight: 0.5,
    direction: "directional",
    evidence: [],
    createdBy: "tester",
    createdAt: ts,
    updatedAt: ts,
    retrievalWeight: 0.5,
    visibility: "public",
  };
  return repo.addOutgoingSynapse(from, s);
}

describe("accept rem-synapse", () => {
  it("add:accept 后两端出现新突触", () => {
    const { engine, repo } = setup();
    const a = makeEngram(repo, "ea");
    const b = makeEngram(repo, "eb");
    engine.proposeSynapseOp({
      op: "add",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      reason: "r",
      confidence: 0.8,
    });
    const eid = engine.listPending()[0]!.entityId;
    const ret = engine.accept(eid, {});
    expect(ret).toBe(a.id);
    const out = repo.readSynapses(a.id).outgoing;
    expect(out.some((s) => s.to === b.id && s.kind === "similar_to")).toBe(true);
  });

  it("delete:accept 后突触消失", () => {
    const { engine, repo } = setup();
    const a = makeEngram(repo, "ea");
    const b = makeEngram(repo, "eb");
    const s = makeSynapse(repo, a.id, b.id, "similar_to");
    engine.proposeSynapseOp({
      op: "delete",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      oldKind: "similar_to",
      synapseId: s.id,
      reason: "r",
      confidence: 0.8,
    });
    const eid = engine.listPending()[0]!.entityId;
    engine.accept(eid, {});
    expect(repo.readSynapses(a.id).outgoing.some((x) => x.id === s.id)).toBe(false);
  });

  it("retype:accept 后 kind 变更(id 重算)", () => {
    const { engine, repo } = setup();
    const a = makeEngram(repo, "ea");
    const b = makeEngram(repo, "eb");
    const s = makeSynapse(repo, a.id, b.id, "similar_to");
    engine.proposeSynapseOp({
      op: "retype",
      from: a.id,
      to: b.id,
      kind: "extends",
      oldKind: "similar_to",
      synapseId: s.id,
      reason: "r",
      confidence: 0.8,
    });
    const eid = engine.listPending()[0]!.entityId;
    engine.accept(eid, {});
    const out = repo.readSynapses(a.id).outgoing;
    expect(out.some((x) => x.to === b.id && x.kind === "extends")).toBe(true);
    expect(out.some((x) => x.id === s.id)).toBe(false);
  });

  it("retype oldKind 不符 → 抛 actionable 错,proposal 留 pending", () => {
    const { engine, repo } = setup();
    const a = makeEngram(repo, "ea");
    const b = makeEngram(repo, "eb");
    makeSynapse(repo, a.id, b.id, "similar_to");
    engine.proposeSynapseOp({
      op: "retype",
      from: a.id,
      to: b.id,
      kind: "extends",
      oldKind: "derives_from",
      reason: "r",
      confidence: 0.8,
    });
    const eid = engine.listPending()[0]!.entityId;
    expect(() => engine.accept(eid, {})).toThrow();
    const p = engine.listAll().find((x) => x.entityId === eid)!;
    expect(p.status).toBe("pending");
  });
});
