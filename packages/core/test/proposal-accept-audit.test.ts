import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";

/**
 * H7 归因修复回归(2026-08-16 loop r24/r25):
 *
 * accept 决策审计此前的问题:
 *   1. action 语义不一致:rem-tag-refresh 记 update、rem-synapse 记 create/purge/update、
 *      rem-insight/skill 记 accept —— 同一「用户批准提案」语义多种写法,
 *      按 action=accept 检索会漏,造成「audit 零 accept 事件 → rem 伪造审批」误判
 *   2. rem-pattern / rem-verification 分支完全零审计
 *   3. 不带 host、不带 via —— 真人点卡 / viewer 批量 / MCP 工具在审计里不可区分
 *
 * 修复后契约:所有 accept(含 acceptBatch)统一
 *   action="accept" + metadata.appliedAction(具体落盘动作)
 *   + metadata.via(调用通道)+ host(构造注入的宿主标识)
 */
describe("proposal accept 审计归因(H7)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let auditLog: AuditLog;
  let engine: ProposalEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-accept-audit-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    repo = new EngramRepository({ rootPath: tmpDir });
    auditLog = new AuditLog(tmpDir);
    engine = new ProposalEngine({
      repository: repo,
      embedder: async () => [1, 0, 0],
      auditLog,
      dataRoot: tmpDir,
      host: "claude-code-mcp",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function acceptAuditEvents() {
    return auditLog.query({ action: "accept" });
  }

  it("rem-tag-refresh accept → action=accept + appliedAction=update + via + host", () => {
    const eng = repo.createEngram({
      title: "t",
      content: "c",
      kind: "fact",
      domainTags: ["imported"],
      createdBy: "tester",
    });
    const proposed = engine.proposeTagRefresh({
      engramId: eng.id,
      oldTags: ["imported"],
      newTags: ["database", "networking"],
      reason: "占位标签刷新",
      engramTitle: "t",
    });
    expect(proposed).toBe(true);

    engine.accept(`rem-tag-refresh:${eng.id}`, {
      createdBy: "tester",
      via: "viewer-batch",
    });

    // 标签已按提案更新
    expect([...repo.readEngram(eng.id).domainTags]).toEqual([
      "database",
      "networking",
    ]);
    // 审计:统一 accept 语义 + 归因字段
    const events = acceptAuditEvents().filter((e) =>
      (e.metadata?.source as string | undefined) === "rem-tag-refresh",
    );
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.actor).toBe("user");
    expect(ev.host).toBe("claude-code-mcp");
    expect(ev.metadata?.via).toBe("viewer-batch");
    expect(ev.metadata?.appliedAction).toBe("update");
    expect(ev.metadata?.oldTags).toEqual(["imported"]);
    expect(ev.metadata?.newTags).toEqual(["database", "networking"]);
  });

  it("accept 不传 via → 审计无 via 字段但不报错(向后兼容)", () => {
    const eng = repo.createEngram({
      title: "t2",
      content: "c2",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "tester",
    });
    engine.proposeTagRefresh({
      engramId: eng.id,
      oldTags: ["uncategorized"],
      newTags: ["x"],
      reason: "r",
    });
    engine.accept(`rem-tag-refresh:${eng.id}`, { createdBy: "tester" });
    const ev = acceptAuditEvents().find(
      (e) => e.metadata?.source === "rem-tag-refresh",
    );
    expect(ev).toBeDefined();
    expect(ev?.metadata?.via).toBeUndefined();
    expect(ev?.host).toBe("claude-code-mcp");
  });

  it("rem-pattern accept → 补齐决策审计(此前零审计)", () => {
    // 直接写一条 source=rem-pattern 的 pending proposal,再 accept
    const engineInner = engine as unknown as {
      readProposals: () => { entityId: string }[];
      writeProposals: (p: unknown[]) => void;
    };
    engineInner.writeProposals([
      {
        entityId: "rem-pattern:test-1",
        occurrences: 1,
        sampleQuotes: ["q"],
        centroidExcerpt: "ce",
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "pending",
        source: "rem-pattern",
        payload: {
          title: "Pattern Title",
          content: "pattern body",
          summary: "s",
          domainTags: ["d"],
          kind: "pattern",
          remConfidence: 0.8,
          remSourceIds: [],
        },
      },
    ]);
    const id = engine.accept("rem-pattern:test-1", {
      createdBy: "tester",
      via: "mcp",
    });
    expect(typeof id).toBe("string");
    const ev = acceptAuditEvents().find(
      (e) => e.metadata?.source === "rem-pattern",
    );
    expect(ev).toBeDefined();
    expect(ev?.metadata?.via).toBe("mcp");
    expect(ev?.metadata?.appliedAction).toBe("create");
    expect(ev?.host).toBe("claude-code-mcp");
  });

  it("acceptBatch → audit 带 via=batch 缺省值 + host", () => {
    // auto-memory proposal 带 payload → acceptBatch 可直接转化
    engine.proposeAutoMemory({
      slug: "mem-1",
      title: "auto title",
      content: "auto content",
      domainTags: ["am"],
      createdBy: "tester",
      sourceMtimeMs: 1,
    });
    const result = engine.acceptBatch(
      { source: "auto-memory" },
      { createdBy: "tester" },
    );
    expect(result.acceptedIds.length).toBe(1);
    const ev = acceptAuditEvents().find(
      (e) => e.metadata?.source === "auto-memory",
    );
    expect(ev).toBeDefined();
    expect(ev?.metadata?.via).toBe("batch");
    expect(ev?.host).toBe("claude-code-mcp");
  });
});
