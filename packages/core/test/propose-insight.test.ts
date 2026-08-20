// rem-insight 提案:proposeInsight 幂等(entityId 纳入轮次)+ accept 分支 + 复验
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { refuteEngram } from "../src/verification/upgrade.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;

const stubEmbedder = async () => [1, 0, 0];
const stubAudit = { append: () => {} } as never;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-prop-"));
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

function makeSource(title: string) {
  return repo.createEngram({
    title,
    content: `content ${title}`,
    kind: "fact",
    domainTags: ["t"],
    createdBy: "tester",
  });
}

function propose(over: Partial<Parameters<ProposalEngine["proposeInsight"]>[0]> = {}) {
  return engine.proposeInsight({
    mode: "integration",
    insightType: "theme",
    title: "跨情境主题",
    content: "共性结构",
    summary: "s",
    domainTags: ["t"],
    sourceIds: [],
    criticScore: 0.8,
    criticRationale: "evidence sufficient",
    ...over,
  });
}

describe("proposeInsight 幂等(entityId 纳入轮次,防回灌撞车)", () => {
  it("propose → pending 提案 source=rem-insight,payload 带 mode/criticScore/incubationId", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    expect(
      propose({
        sourceIds: [a.id, b.id],
        incubationId: "inc-1",
        round: 1,
      }),
    ).toBe(true);
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    expect(p.status).toBe("pending");
    expect(p.payload!.insightMode).toBe("integration");
    expect(p.payload!.criticScore).toBe(0.8);
    expect(p.payload!.incubationId).toBe("inc-1");
    expect(p.payload!.insightRound).toBe(1);
  });

  it("同 mode+incubationId+round+sourceIds 二次 propose → false;round+1 → true(新一轮不撞)", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    const ids = [a.id, b.id];
    expect(propose({ sourceIds: ids, incubationId: "inc-1", round: 1 })).toBe(true);
    expect(propose({ sourceIds: [b.id, a.id], incubationId: "inc-1", round: 1 })).toBe(false); // 顺序无关
    expect(propose({ sourceIds: ids, incubationId: "inc-1", round: 2 })).toBe(true); // 新轮次
    expect(propose({ sourceIds: ids, incubationId: "inc-2", round: 1 })).toBe(true); // 不同条目
  });

  it("accepted 后再 propose → false;dismissed 永久 → false", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    const ids = [a.id, b.id];
    propose({ sourceIds: ids });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    // 先测 dismissed 永久屏蔽
    engine.dismiss(p.entityId, "not useful");
    expect(propose({ sourceIds: ids })).toBe(false);
  });
});

describe("accept(rem-insight 分支)", () => {
  it("创建 pattern engram:confidence=criticScore、sourceType=inferred、encodingContext 标记、derives_from 证据链", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    propose({ sourceIds: [a.id, b.id], criticScore: 0.72 });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    const engramId = engine.accept(p.entityId, { createdBy: "user" });
    const created = repo.readEngram(engramId);
    expect(created.kind).toBe("pattern");
    expect(created.confidence).toBeCloseTo(0.72, 5);
    expect(created.sourceType).toBe("inferred");
    expect(created.encodingContext).toBe(`rem-insight:${p.entityId}`);
    // derives_from 证据链
    const targets = repo
      .collectAllSynapses()
      .filter(({ fromId, synapse }) => fromId === engramId && synapse.kind === "derives_from")
      .map(({ synapse }) => synapse.to);
    expect(targets).toContain(a.id);
    expect(targets).toContain(b.id);
    // 提案标记 accepted
    expect(engine.listAll().find((x) => x.entityId === p.entityId)!.status).toBe("accepted");
  });

  it("hypothesis 型建 kind=hypothesis", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    propose({ sourceIds: [a.id, b.id], insightType: "hypothesis" });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    const engramId = engine.accept(p.entityId, { createdBy: "user" });
    expect(repo.readEngram(engramId).kind).toBe("hypothesis");
  });

  it("accept-time 复验:来源被删除 → accept 被拦,proposal 保持 pending", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    propose({ sourceIds: [a.id, b.id] });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    repo.deleteEngram(a.id);
    expect(() => engine.accept(p.entityId, { createdBy: "user" })).toThrow(/不存在|refute/);
    expect(engine.listAll().find((x) => x.entityId === p.entityId)!.status).toBe("pending");
  });

  it("accept-time 复验:来源被 refute → accept 被拦,proposal 保持 pending", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    propose({ sourceIds: [a.id, b.id] });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    refuteEngram(repo, a.id, {
      description: "测试反驳",
      verifiedBy: "tester",
      confidence: 0.9,
    });
    expect(() => engine.accept(p.entityId, { createdBy: "user" })).toThrow(/refute/);
    expect(engine.listAll().find((x) => x.entityId === p.entityId)!.status).toBe("pending");
  });

  it("list_proposals 投影带 insightMode/criticScore/incubationId", () => {
    const a = makeSource("A");
    const b = makeSource("B");
    propose({ sourceIds: [a.id, b.id], incubationId: "inc-9", round: 2 });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    expect(p.payload!.insightMode).toBe("integration");
    expect(p.payload!.incubationId).toBe("inc-9");
    expect(p.payload!.insightRound).toBe(2);
  });
});

// ============================================================
// sampleQuotes 语义(2026-08-18 修复:不再泄漏引擎调试串/假样本计数)
// ============================================================
describe("proposeInsight sampleQuotes = 来源记忆标题(非调试串)", () => {
  it("sampleQuotes 为来源记忆标题(≤3 条),不含 mode=/critic= 调试串与 criticRationale", () => {
    const a = makeSource("来源记忆甲");
    const b = makeSource("来源记忆乙");
    propose({
      sourceIds: [a.id, b.id],
      criticScore: 0.9,
      criticRationale: "structurally grounded analogy",
    });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    expect(p.sampleQuotes).toEqual(["来源记忆甲", "来源记忆乙"]);
    // 旧实现的调试串泄漏形态,回归防线
    expect(p.sampleQuotes.join(" ")).not.toContain("mode=");
    expect(p.sampleQuotes.join(" ")).not.toContain("critic=");
    expect(p.sampleQuotes.join(" ")).not.toContain("structurally grounded");
  });

  it("来源 >3 条时截断为前 3;已删除的来源跳过不炸", () => {
    const sources = ["甲", "乙", "丙", "丁"].map((t) => makeSource(t));
    const deleted = makeSource("已删除");
    repo.deleteEngram(deleted.id);
    propose({ sourceIds: [sources[0]!.id, deleted.id, sources[1]!.id, sources[2]!.id, sources[3]!.id] });
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    expect(p.sampleQuotes).toEqual(["甲", "乙", "丙"]);
  });
});
