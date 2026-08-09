import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../../src/storage/repository.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { AuditLog } from "../../src/observability/audit-log.js";
import { ProposalEngine } from "../../src/observability/proposal-engine.js";
import { refreshDomainTagsOnDrift } from "../../src/maintenance/tag-refresh.js";
import type { LlmClient } from "../../src/observability/necessity-evaluator.js";

/**
 * 修复验证(2026-08):tag-refresh 占位符刷新走审批卡片 + 修卡死。
 *
 * 旧 bug:首次 LLM 返回空 → 兜底 imported 直接落盘 + baseline 写入 → 后续 L0
 * contentHash 短路 → 占位标签永久卡死,且用户看不到任何 proposal(静默)。
 *
 * 修复后:提取结果走 rem-tag-refresh pending proposal(用户 accept 才改 domainTags),
 * 占位符豁免 L0/L1 反复重提,已有 pending proposal 则不重复提取。
 */
describe("REM tag-refresh:占位符刷新走审批卡片(修复验证)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;
  let auditLog: AuditLog;
  let engine: ProposalEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-tag-refresh-fix-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
    auditLog = new AuditLog(tmpDir);
    engine = new ProposalEngine({
      repository: repo,
      embedder: async () => [1, 0, 0],
      auditLog,
      dataRoot: tmpDir,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 第 i 次 LLM 调用返回 tagsByCall[i](超出长度则重复最后一个);"throw" 表示抛异常 */
  function llmReturning(tagsByCall: ReadonlyArray<readonly string[] | "throw">): LlmClient {
    let n = 0;
    return {
      async complete() {
        const spec = tagsByCall[n] ?? tagsByCall[tagsByCall.length - 1] ?? [];
        n += 1;
        if (spec === "throw") throw new Error("LLM transient error");
        return JSON.stringify({
          title: "t",
          kind: "observation",
          domainTags: spec,
          summary: "s",
        });
      },
    };
  }

  it("占位符 + LLM 返回真实标签 → 生成 pending proposal,不直接落盘", async () => {
    const eng = repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["android", "adb", "testing"]]),
      engine,
    );
    expect(r.refreshed).toBe(1);
    const pending = engine.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.source).toBe("rem-tag-refresh");
    // 标签未直接落盘(仍是占位符,等 accept)
    expect([...repo.readEngram(eng.id).domainTags]).toEqual(["uncategorized"]);
  });

  it("修复核心:首次 LLM 返回空 → 不再静默落盘 imported,而是生成可见 proposal", async () => {
    const eng = repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    // 首次 LLM 返回空数组 → parseExtractionResponse 兜底 imported
    const r = await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([[]]),
      engine,
    );
    // 生成 pending proposal(用户可见可处理),而非旧 bug 的静默落盘 + 卡死
    expect(r.refreshed).toBe(1);
    expect(engine.listPending().length).toBe(1);
    // 关键:标签未被直接改成 imported(不像旧 bug)
    expect([...repo.readEngram(eng.id).domainTags]).toEqual(["uncategorized"]);
  });

  it("占位符豁免:已有 pending proposal → 第二轮不重复提取(不白调 LLM)", async () => {
    repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls += 1;
        return JSON.stringify({
          title: "t",
          kind: "observation",
          domainTags: ["android"],
          summary: "s",
        });
      },
    };
    await refreshDomainTagsOnDrift(repo, auditLog, llm, engine); // 首次:生成 proposal
    const r2 = await refreshDomainTagsOnDrift(repo, auditLog, llm, engine); // 第二轮
    // 第二轮 pending proposal 已存在 → 不重复提取,LLM 调用数不增
    expect(calls).toBe(1);
    expect(r2.refreshed).toBe(0);
  });

  it("accept proposal → 改 domainTags;dismiss → 保持", async () => {
    const eng = repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["android", "adb"]]),
      engine,
    );
    const proposal = engine.listPending()[0]!;
    // accept → 标签应用
    engine.accept(proposal.entityId, { createdBy: "test" });
    expect([...repo.readEngram(eng.id).domainTags]).toEqual(["android", "adb"]);
    expect(engine.listPending().length).toBe(0);

    // 再造一条,测 dismiss
    const eng2 = repo.createEngram({
      title: "Another topic",
      content: "totally different subject about database networking",
      kind: "fact",
      domainTags: ["imported"],
      createdBy: "test",
    });
    await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["database", "networking"]]),
      engine,
    );
    const p2 = engine.listPending()[0]!;
    engine.dismiss(p2.entityId, "wrong tag");
    // dismiss → 标签保持占位符
    expect([...repo.readEngram(eng2.id).domainTags]).toEqual(["imported"]);
    // tombstone 防复活:再次 tag-refresh 不会重新 propose(返回 false,但这里靠 hasPendingProposal
    // 与 proposeTagRefresh 内部 tombstone 双重挡)
    await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["database", "networking"]]),
      engine,
    );
    expect(engine.listPending().length).toBe(0);
  });

  it("已分类记忆内容漂移 → 走 proposal(审批化,不直接落盘)", async () => {
    const eng = repo.createEngram({
      title: "A",
      content: "alpha beta gamma",
      kind: "fact",
      domainTags: ["sometopic"],
      createdBy: "test",
    });
    // 首次建 baseline(LLM 返回与现标签同 → sameAsOld skip)
    await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["sometopic"]]),
      engine,
    );
    // 大改内容
    repo.updateEngram(eng.id, {
      content: "completely different subject about database networking and security",
      updatedBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["database", "security"]]),
      engine,
    );
    expect(r.refreshed).toBe(1);
    // 漂移重提走 proposal,未直接落盘
    expect([...repo.readEngram(eng.id).domainTags]).toEqual(["sometopic"]);
    expect(engine.listPending()[0]!.source).toBe("rem-tag-refresh");
  });

  it("无 proposalEngine → 退化为直接落盘(向后兼容)", async () => {
    const eng = repo.createEngram({
      title: "Wireless ADB setup",
      content: "How to configure wireless adb debugging on android devices",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "test",
    });
    const r = await refreshDomainTagsOnDrift(
      repo,
      auditLog,
      llmReturning([["android"]]),
    );
    expect(r.refreshed).toBe(1);
    expect([...repo.readEngram(eng.id).domainTags]).toEqual(["android"]);
  });
});
