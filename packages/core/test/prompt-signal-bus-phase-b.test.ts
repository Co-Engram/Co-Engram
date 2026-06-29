/**
 * Task 3.4 Phase B:bus.emit 真接线测试
 *
 * 验证:createEngram / updateVerificationStatus / createSynapse /
 * proposalEngine.accept / proposalEngine.dismiss / closeLearningLoop /
 * runDoctor 都会通过 singleton bus emit PromptSignalEvent。
 *
 * 这是 R13 root cause 的核心修复:"刚 confirm 的记忆 prompt 没反应"——
 * emit 让 prompt-signals cache 失效并 debounced rebuild。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EngramRepository,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  closeLearningLoop,
  getGlobalPromptSignalBus,
  resetGlobalPromptSignalBus,
  type PromptSignalEvent,
} from "@co-engram/core";

let tmpDir: string;
let repo: EngramRepository;
let events: PromptSignalEvent[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-bus-phase-b-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  events = [];
  resetGlobalPromptSignalBus();
  getGlobalPromptSignalBus().on((e) => events.push(e));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetGlobalPromptSignalBus();
});

describe("Task 3.4 Phase B: bus.emit wired at mutation points", () => {
  it("createEngram emits engram_created", () => {
    repo.createEngram({
      title: "test",
      content: "hello",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    expect(events.some((e) => e.type === "engram_created")).toBe(true);
  });

  it("updateVerificationStatus emits engram_verified", () => {
    const e = repo.createEngram({
      title: "v",
      content: "x",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    events.length = 0;
    repo.updateVerificationStatus(e.id, "plausible");
    expect(events.some((ev) => ev.type === "engram_verified" && ev.engramId === e.id)).toBe(true);
  });

  it("createSynapse emits synapse_created", () => {
    const a = repo.createEngram({
      title: "a",
      content: "x",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    const b = repo.createEngram({
      title: "b",
      content: "y",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    events.length = 0;
    repo.createSynapse({
      from: a.id,
      to: b.id,
      kind: "similar_to",
      direction: "directional",
      weight: 0.5,
      evidence: [],
      createdBy: "tester",
    });
    expect(events.some((ev) => ev.type === "synapse_created")).toBe(true);
  });

  it("proposalEngine.accept emits proposal_accepted", () => {
    const auditLog = new AuditLog(tmpDir);
    const effectivenessTracker = new EffectivenessTracker(tmpDir, auditLog);
    const proposalEngine = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog,
      dataRoot: tmpDir,
      config: { threshold: 1 },
    });
    void effectivenessTracker;

    // 直接调 proposalEngine.accept 需要先有 proposal;通过 private API 不可行,
    // 改为模拟:accept 内部会 createEngram,我们已经测过 createEngram emit。
    // 这里验证 accept 路径触发 proposal_accepted 事件:
    // 先手工 write 一个 proposal 到 jsonl,再 accept
    const fs = require("node:fs");
    const path = require("node:path");
    const proposalsFile = path.join(tmpDir, ".co-engram", "proposals.jsonl");
    fs.mkdirSync(path.dirname(proposalsFile), { recursive: true });
    const entityId = "test-cluster-1";
    fs.writeFileSync(
      proposalsFile,
      JSON.stringify({
        entityId,
        occurrences: 3,
        sampleQuotes: ["sample"],
        centroidExcerpt: "sample",
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        status: "pending",
      }) + "\n",
      "utf8",
    );

    events.length = 0;
    proposalEngine.accept(entityId, {
      title: "Accepted",
      content: "body",
      domainTags: ["t"],
    });
    expect(events.some((ev) => ev.type === "proposal_accepted")).toBe(true);
  });

  it("proposalEngine.dismiss emits proposal_dismissed", () => {
    const auditLog = new AuditLog(tmpDir);
    const proposalEngine = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog,
      dataRoot: tmpDir,
      config: { threshold: 1 },
    });

    const fs = require("node:fs");
    const path = require("node:path");
    const proposalsFile = path.join(tmpDir, ".co-engram", "proposals.jsonl");
    fs.mkdirSync(path.dirname(proposalsFile), { recursive: true });
    const entityId = "test-cluster-dismiss";
    fs.writeFileSync(
      proposalsFile,
      JSON.stringify({
        entityId,
        occurrences: 3,
        sampleQuotes: ["sample"],
        centroidExcerpt: "sample",
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        status: "pending",
      }) + "\n",
      "utf8",
    );

    events.length = 0;
    proposalEngine.dismiss(entityId, "not relevant");
    expect(events.some((ev) => ev.type === "proposal_dismissed")).toBe(true);
  });

  it("closeLearningLoop (success) emits engram_reinforced", () => {
    const e = repo.createEngram({
      title: "loop",
      content: "x",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    events.length = 0;
    closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "success",
      effectiveness: 0.8,
      reportedBy: "tester",
    });
    expect(events.some((ev) => ev.type === "engram_reinforced" && ev.engramId === e.id)).toBe(true);
  });

  it("closeLearningLoop (failure) emits engram_failed", () => {
    const e = repo.createEngram({
      title: "loop-fail",
      content: "x",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    events.length = 0;
    closeLearningLoop(repo, {
      engramId: e.id,
      outcome: "failure",
      reportedBy: "tester",
    });
    expect(events.some((ev) => ev.type === "engram_failed" && ev.engramId === e.id)).toBe(true);
  });

  it("runDoctor emits doctor_completed", () => {
    repo.createEngram({
      title: "doc",
      content: "x",
      kind: "observation",
      domainTags: ["t"],
      createdBy: "tester",
    });
    events.length = 0;
    repo.runDoctor();
    expect(events.some((ev) => ev.type === "doctor_completed")).toBe(true);
  });

  it("bus failure does not throw (safeEmit swallows)", () => {
    // 重置 bus,加一个会抛错的 listener
    resetGlobalPromptSignalBus();
    getGlobalPromptSignalBus().on(() => {
      throw new Error("listener boom");
    });

    // safeEmit 应吞掉异常,不抛
    expect(() => {
      repo.createEngram({
        title: "safe",
        content: "x",
        kind: "observation",
        domainTags: ["t"],
        createdBy: "tester",
      });
    }).not.toThrow();
  });
});
