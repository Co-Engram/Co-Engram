import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// ============================================================
// external-markdown accept · 原地纳管（源文件存在时）
// ============================================================
//
// 真实流程：用户手动放 .md 到 dataRoot → watcher 扫到 → propose(sourcePath=相对路径)。
// accept 应基于源文件原地创建 engram，目录 / 路径不变，不在 imported/ 下新建副本。
// 裸 md → 原地提升（加 frontmatter）；合法 engram orphan → 原地 adopt（文件不动）。
// 源文件不存在（虚拟 proposal / 已被外部删除）→ 退化默认路径创建（向后兼容）。

describe("engram_accept_proposal · external-markdown 原地纳管", () => {
  function seedFile(relPath: string, content: string): string {
    const abs = join(tmpDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  it("裸 md 源文件 accept → 原地提升为 engram，路径不变，imported/ 无新建", () => {
    const rel = "项目信息/协同规范.md";
    const body = "# 协同规范\n\n统一需求管理流程。";
    seedFile(rel, body);
    engine.proposeExternalMarkdown({
      sourcePath: rel,
      title: "协同规范",
      content: body,
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute({ entityId }, buildCtx());

    expect(result.status).toBe("accepted");
    // 原文件路径仍在，且被提升为合法 engram（zh 模式 frontmatter 在底部，
    // 故不断言 startsWith("---")；改用 readEngramByPath 验证可解析 + 原正文保留）
    const raw = readFileSync(join(tmpDir, rel), "utf8");
    expect(raw).toContain(body);
    const promoted = repo.readEngramByPath(rel);
    expect(promoted?.title).toBe("协同规范");
    expect(promoted?.kind).toBe("observation");
    // imported/ 下没有新建副本
    expect(existsSync(join(tmpDir, "imported"))).toBe(false);
    // engram 入索引，可读
    const engram = repo.readEngram(result.engramId);
    expect(engram.title).toBe("协同规范");
    expect(engram.content).toBe(body);
  });

  it("源文件在深层子目录 → accept 后保留原目录层级（目录不动）", () => {
    const rel = "产品支持/终端/无线-adb.md";
    seedFile(rel, "无线 adb 调试正文");
    engine.proposeExternalMarkdown({
      sourcePath: rel,
      title: "无线 ADB",
      content: "无线 adb 调试正文",
      domainTags: ["imported"],
      kind: "fact",
    });
    const entityId = engine.listAll()[0]!.entityId;

    engramAcceptProposalTool.execute({ entityId }, buildCtx());

    expect(existsSync(join(tmpDir, rel))).toBe(true);
    expect(repo.readEngramByPath(rel)?.title).toBe("无线 ADB");
    expect(existsSync(join(tmpDir, "imported"))).toBe(false);
  });

  it("accept 时 caller 覆盖 title → frontmatter 用新值，但路径仍保留 sourcePath", () => {
    const rel = "in-place-override.md";
    seedFile(rel, "正文内容");
    engine.proposeExternalMarkdown({
      sourcePath: rel,
      title: "原标题",
      content: "正文内容",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute(
      { entityId, title: "新标题" },
      buildCtx(),
    );

    expect(repo.readEngram(result.engramId).title).toBe("新标题");
    expect(existsSync(join(tmpDir, rel))).toBe(true);
    expect(existsSync(join(tmpDir, "imported"))).toBe(false);
  });

  it("已是合法 engram 的源文件 accept → 原地 adopt，文件字节不变（幂等）", () => {
    const rel = "existing-engram.md";
    // 经 createEngram 写一个合法 engram（已在 index）
    const created = repo.createEngram({
      title: "Existing",
      content: "existing body",
      kind: "fact",
      domainTags: ["imported"],
      createdBy: "tester",
      pathHint: rel,
    });
    const bytesBefore = readFileSync(join(tmpDir, rel), "utf8");

    engine.proposeExternalMarkdown({
      sourcePath: rel,
      title: "Existing",
      content: "existing body",
      domainTags: ["imported"],
      kind: "fact",
    });
    const entityId = engine
      .listAll()
      .find((p) => p.sourcePath === rel)!.entityId;

    engramAcceptProposalTool.execute({ entityId }, buildCtx());

    // adopt：文件字节不变（未被 promote 覆盖）
    const bytesAfter = readFileSync(join(tmpDir, rel), "utf8");
    expect(bytesAfter).toBe(bytesBefore);
    // 原有 engram 仍可读
    expect(repo.readEngram(created.id).title).toBe("Existing");
    expect(existsSync(join(tmpDir, "imported"))).toBe(false);
  });

  it("源文件不存在（虚拟 proposal）→ 退化默认路径创建，不报错（向后兼容）", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "virtual-no-file.md",
      title: "虚拟",
      content: "无对应文件",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    const result = engramAcceptProposalTool.execute({ entityId }, buildCtx());

    expect(result.status).toBe("accepted");
    expect(repo.readEngram(result.engramId).title).toBe("虚拟");
  });

  it("sourcePath 路径逃逸 → 拒绝（抛错，不做路径遍历）", () => {
    engine.proposeExternalMarkdown({
      sourcePath: "../../etc/passwd",
      title: "逃逸",
      content: "x",
      domainTags: ["imported"],
      kind: "observation",
    });
    const entityId = engine.listAll()[0]!.entityId;

    expect(() =>
      engramAcceptProposalTool.execute({ entityId }, buildCtx()),
    ).toThrow(/escapes dataRoot/);
  });

  it("acceptBatch：源文件存在 → 原地纳管；源文件不存在 → 退化（混合）", () => {
    seedFile("batch-real.md", "真实文件正文");
    engine.proposeExternalMarkdown({
      sourcePath: "batch-real.md",
      title: "Real",
      content: "真实文件正文",
      domainTags: ["imported"],
      kind: "observation",
    });
    engine.proposeExternalMarkdown({
      sourcePath: "batch-virtual.md",
      title: "Virtual",
      content: "虚拟正文",
      domainTags: ["imported"],
      kind: "observation",
    });

    const result = engine.acceptBatch(
      { source: "external-markdown" },
      { createdBy: "tester" },
    );

    expect(result.acceptedIds.length).toBe(2);
    expect(result.failures.length).toBe(0);
    // batch-real.md：原位提升为合法 engram（zh 底部 frontmatter），imported/ 无它的副本
    expect(repo.readEngramByPath("batch-real.md")?.title).toBe("Real");
    // batch-virtual.md：无源文件 → 退化默认路径（imported/ 下创建）
    expect(existsSync(join(tmpDir, "imported", "virtual.md"))).toBe(true);
  });

  it("端到端：watcher hook 扫到裸 md → proposal → accept → 原地提升（完整链路）", async () => {
    const rel = "e2e/协同规范.md";
    const abs = join(tmpDir, rel);
    const fileBody = "# 协同规范\n\n统一需求管理。";
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, fileBody, "utf8");

    // 模拟 scanForExternalMarkdown 对裸 md 的 hook 调用（parsed=null → 路径 2 异步提取）
    const hook = engine.createExternalMarkdownHook();
    hook({ absPath: abs, relPath: rel, raw: fileBody, parsed: null });
    // proposeBareMarkdownAsync 是 fire-and-forget async，等它落 proposals.jsonl
    await new Promise((resolve) => setTimeout(resolve, 200));

    const proposal = engine.listAll().find((p) => p.sourcePath === rel);
    expect(proposal).toBeTruthy();
    expect(proposal!.source).toBe("external-markdown");

    const result = engramAcceptProposalTool.execute(
      { entityId: proposal!.entityId },
      buildCtx(),
    );
    expect(result.status).toBe("accepted");

    // 原地提升为合法 engram，imported/ 无新建（死循环根除）
    expect(repo.readEngramByPath(rel)?.title).toBeTruthy();
    expect(existsSync(join(tmpDir, "imported"))).toBe(false);
  });
});
