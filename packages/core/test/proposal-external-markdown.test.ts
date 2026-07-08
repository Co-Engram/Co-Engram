import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { SearchOrchestrator } from "../src/retrieval/orchestrator.js";
import { collectDigestLines } from "../src/index/digest-builder.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
} from "../src/observability/proposal-engine.js";
import {
  engramAcceptProposalTool,
  engramListProposalsTool,
} from "../src/tools/proposal-tools.js";
import { engramSearchTool } from "../src/tools/engram-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let search: SearchOrchestrator;
let audit: AuditLog;
let engine: ProposalEngine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-ext-md-tools-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  search = new SearchOrchestrator();
  audit = new AuditLog(tmpDir);
  engine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: tmpDir,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repository: repo,
    searchOrchestrator: search,
    proposalEngine: engine,
    ...overrides,
  };
}

function refreshSearchIndex(): void {
  search.build(collectDigestLines(repo));
}

// ============================================================
// engram_accept_proposal · external-markdown 来源(工具级)
// ============================================================
//
// 单元层(ProposalEngine.accept)的 payload 兜底已在 proposal-engine.test.ts
// 覆盖。这里测工具入口(engramAcceptProposalTool.execute)的契约:
//   1. external-markdown proposal 自带 payload → 调用方不传 title/content
//      也能成功(没有 schema 强制 required 报错)
//   2. 调用方覆盖优先级正确
//   3. accept 后 engram_search 端到端能找到
//   4. accept 后 engram_list_proposals 反映 status=accepted
//   5. createdBy 兜底链对 external-markdown 同样生效

describe("engram_accept_proposal · external-markdown 工具级契约", () => {
  it("调用方未传 title/content/domainTags/kind → 全部走 payload 兜底,不报错", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "notes/tool-accept.md",
      title: "外部标题",
      content: "外部正文",
      summary: "外部摘要",
      domainTags: ["imported"],
      kind: "pattern",
      createdBy: "external-author",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute({ entityId }, buildCtx());

    expect(result.status).toBe("accepted");
    expect(result.entityId).toBe(entityId);
    const engram = repo.readEngram(result.engramId);
    expect(engram.title).toBe("外部标题");
    expect(engram.content).toBe("外部正文");
    expect(engram.summary).toBe("外部摘要");
    expect(engram.kind).toBe("pattern");
    expect(engram.domainTags).toEqual(["imported"]);
    expect(engram.createdBy).toBe("external-author");
  });

  it("调用方覆盖 title/kind → 用覆盖值,其余走 payload", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "override.md",
      title: "原标题",
      content: "原 body",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute(
      {
        entityId,
        title: "LLM 修订标题",
        kind: "fact",
      },
      buildCtx(),
    );

    const engram = repo.readEngram(result.engramId);
    expect(engram.title).toBe("LLM 修订标题");
    expect(engram.kind).toBe("fact");
    expect(engram.content).toBe("原 body"); // 未覆盖 → payload
    expect(engram.domainTags).toEqual(["imported"]); // 未覆盖 → payload
  });

  it("调用方覆盖 domainTags → 用覆盖值", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "tags-override.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    engramAcceptProposalTool.execute(
      { entityId, domainTags: ["reviewed", "v2"] },
      buildCtx(),
    );

    const engram = repo.readEngram(
      engine.listAll().find((p) => p.entityId === entityId)!.acceptedEngramId!,
    );
    expect(engram.domainTags).toEqual(["reviewed", "v2"]);
  });

  it("createdBy 兜底链:调用方未传 → ctx.defaultCreatedBy → 'unknown'", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "no-created-by.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    // 1) ctx.defaultCreatedBy 兜底
    const result = engramAcceptProposalTool.execute(
      { entityId },
      buildCtx({ defaultCreatedBy: "ctx-default" }),
    );
    expect(repo.readEngram(result.engramId).createdBy).toBe("ctx-default");

    // 再 propose 一个不同 source 测 'unknown' 兜底
    engine.proposeExternalMarkdown({
      sourcePath: "fallback-unknown.md",
      title: "T2",
      content: "C2",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId2 = engine
      .listAll()
      .find((p) => p.sourcePath === "fallback-unknown.md")!.entityId;

    // 2) ctx.defaultCreatedBy 也缺省 → 'unknown'
    const result2 = engramAcceptProposalTool.execute(
      { entityId: entityId2 },
      buildCtx({ defaultCreatedBy: undefined }),
    );
    expect(repo.readEngram(result2.engramId).createdBy).toBe("unknown");
  });

  it("accept 后 → engram_search 端到端能搜到(body 关键词命中)", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "searchable.md",
      title: "可搜索的记忆",
      content: "独特的关键短语 zxy-123 用于命中搜索",
      domainTags: ["imported"],
      kind: "fact",
    });
    const entityId = engine.listAll()[0]!.entityId;

    engramAcceptProposalTool.execute({ entityId }, buildCtx());
    refreshSearchIndex();

    const results = engramSearchTool.execute(
      { query: "zxy-123", limit: 10 },
      buildCtx(),
    );
    expect(results.results.length).toBeGreaterThan(0);
    expect(results.results[0]!.title).toBe("可搜索的记忆");
  });

  it("accept 后 → engram_list_proposals 反映 status=accepted + acceptedEngramId", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "list-after-accept.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    engramAcceptProposalTool.execute({ entityId }, buildCtx());

    const listResult = engramListProposalsTool.execute(
      { includeAll: true, limit: 100 },
      buildCtx(),
    );
    const target = listResult.items.find((p) => p.entityId === entityId);
    expect(target?.status).toBe("accepted");
    expect(target?.acceptedEngramId).toBeTruthy();
  });

  it("已 accepted 的 proposal 第二次 accept → 幂等返回同一 engramId(防重复创建 engram)", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "already-accepted.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const first = engramAcceptProposalTool.execute({ entityId }, buildCtx());
    // 第二次 accept:同一 path 已存在 .md(第一次创建的),不再抛 already exists,
    // 而是幂等 adopt 现有文件,返回同一 engramId,proposal 状态保持 accepted。
    // 2026-07 修复:batch accept 30 个时多个 proposal 指向同一 path 不再失败。
    const second = engramAcceptProposalTool.execute({ entityId }, buildCtx());
    expect(second.engramId).toBe(first.engramId);
    const target = engine.listAll().find((p) => p.entityId === entityId);
    expect(target?.status).toBe("accepted");
    expect(target?.acceptedEngramId).toBe(first.engramId);
  });


  it("accept 时 caller 可传 visibility 覆盖默认 public", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "visibility-override.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute(
      { entityId, visibility: "private" },
      buildCtx(),
    );

    const engram = repo.readEngram(result.engramId);
    expect(engram.visibility).toBe("private");
  });

  it("accept 不传 visibility 时默认 public", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "visibility-default.md",
      title: "T",
      content: "C",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute({ entityId }, buildCtx());
    expect(repo.readEngram(result.engramId).visibility).toBe("public");
  });
});

// ============================================================
// engram_list_proposals · cursor 分页(Task 3.5)
// ============================================================

describe("engram_list_proposals · cursor 分页 shape", () => {
  function seedN(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      engine.proposeExternalMarkdown({
        sourcePath: `p-${i}.md`,
        title: `T${i}`,
        content: `C${i}`,
        domainTags: ["imported"],
        kind: "observation",
      });
      // proposeExternalMarkdown 用内部时钟生成 entityId/createdAt;
      // 通过 listAll 拿到刚创建的 id 用于断言
      ids.push(engine.listAll()[engine.listAll().length - 1]!.entityId);
    }
    return ids;
  }

  it("limit 缺失时 schema 校验失败", () => {
    expect(() =>
      engramListProposalsTool.execute({ includeAll: true } as never, buildCtx()),
    ).toThrow(/limit/);
  });

  it("limit > 500 被 schema 拒绝", () => {
    expect(() =>
      engramListProposalsTool.execute(
        { includeAll: true, limit: 501 },
        buildCtx(),
      ),
    ).toThrow();
  });

  it("limit = 0 被拒绝(positive)", () => {
    expect(() =>
      engramListProposalsTool.execute(
        { includeAll: true, limit: 0 },
        buildCtx(),
      ),
    ).toThrow();
  });

  it("接受 named input + 返回 { items, nextCursor }", () => {
    seedN(1);
    const result = engramListProposalsTool.execute(
      { includeAll: true, limit: 50 },
      buildCtx(),
    );
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("nextCursor");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(1);
    expect(result.nextCursor).toBeNull();
  });

  it("cursor 翻页稳定:第二页不与第一页重复,无遗漏", () => {
    seedN(25);
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let iterations = 0;
    const maxIterations = 10;
    while (iterations < maxIterations) {
      const result = engramListProposalsTool.execute(
        cursor
          ? { includeAll: true, limit: 10, cursor }
          : { includeAll: true, limit: 10 },
        buildCtx(),
      );
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(seenIds.has(item.entityId)).toBe(false);
        seenIds.add(item.entityId);
      }
      cursor = result.nextCursor;
      if (cursor === null) break;
      iterations++;
    }
    expect(seenIds.size).toBe(25);
    expect(cursor).toBeNull();
  });
});
