import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  engramSynthesizeTool,
  type EngramSynthesizeResult,
  type SynthesisDraft,
} from "../src/tools/synthesize-tools.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";
import type { ToolContext } from "../src/tools/tool.js";

// ============================================================
// 测试 fixtures
// ============================================================

let tmpDir: string;
let repo: EngramRepository;
let audit: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-synth-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  audit = new AuditLog(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造最小可用 ToolContext */
function makeCtx(client?: LlmClient): ToolContext {
  return {
    repository: repo,
    auditLog: audit,
    defaultCreatedBy: "tester",
    ...(client ? { llmClient: client } : {}),
  };
}

/** 创建源 engram 工厂 */
function makeSource(
  title: string,
  content: string,
  domainTags: readonly string[] = ["testing"],
): string {
  const e = repo.createEngram({
    title,
    content,
    kind: "fact",
    domainTags,
    createdBy: "tester",
  });
  return e.id;
}

/** Stub LlmClient */
function makeStubClient(respond: () => string | Promise<string>): LlmClient {
  return {
    async complete(_prompt: string): Promise<string> {
      return await respond();
    },
  };
}

const VALID_LLM_JSON = JSON.stringify({
  title: "Tests Should Cover Edge Cases",
  summary: "Multiple memories reveal edge case testing patterns.",
  content:
    "Pattern: every source memory emphasizes testing boundary conditions and edge cases rather than happy paths. This includes null inputs, empty collections, network failures, and concurrent access. The lesson is to write tests that explicitly target boundaries, not just typical scenarios.",
  domainTags: ["testing", "patterns"],
  confidence: 0.85,
  reason: "All sources describe testing edge cases in different contexts.",
});

// ============================================================
// happy path
// ============================================================

describe("engram_synthesize — happy path", () => {
  it("2 个源 → 创建 pattern + 2 个 derives_from synapse", async () => {
    const id1 = makeSource("test1", "content about edge cases for input validation");
    const id2 = makeSource("test2", "content about testing null pointer scenarios");
    const client = makeStubClient(() => VALID_LLM_JSON);

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(result.dryRun).toBe(false);
    expect(result.patternEngramId).toBeTruthy();
    expect(result.synapseIds).toHaveLength(2);
    expect(result.sourceIds).toEqual([id1, id2]);
    expect(result.draft.title).toContain("Edge Cases");
    expect(result.draft.confidence).toBeCloseTo(0.85);
    expect(result.draft.domainTags).toEqual(["testing", "patterns"]);

    // pattern engram 真的创建了
    const pattern = repo.readEngram(result.patternEngramId!);
    expect(pattern.kind).toBe("pattern");
    expect(pattern.sourceType).toBe("inferred");
    expect(pattern.createdBy).toBe("tester");
    expect(pattern.importance).toBeCloseTo(0.7);

    // derives_from synapse 已连
    const synapses = repo.readSynapses(result.patternEngramId!);
    expect(synapses.outgoing).toHaveLength(2);
    const kinds = synapses.outgoing.map((s) => s.kind);
    expect(kinds).toEqual(["derives_from", "derives_from"]);
    const targets = synapses.outgoing.map((s) => s.to).sort();
    expect(targets).toEqual([id1, id2].sort());
  });

  it("用户显式 domainTags 优先于 LLM 推断", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    const result = (await engramSynthesizeTool.execute(
      {
        ids: [id1, id2],
        domainTags: ["custom-tag-1", "custom-tag-2"],
      },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    const pattern = repo.readEngram(result.patternEngramId!);
    expect(pattern.domainTags).toEqual(["custom-tag-1", "custom-tag-2"]);
  });

  it("dryRun=true → 不创建 engram,只返回 draft", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2], dryRun: true },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(result.dryRun).toBe(true);
    expect(result.patternEngramId).toBeUndefined();
    expect(result.synapseIds).toEqual([]);
    expect(result.draft).toBeTruthy();
    // 仓库内不应有任何 pattern engram
    const all = repo.listEngrams();
    expect(all.filter((e) => e.id !== id1 && e.id !== id2)).toHaveLength(0);
  });

  // AI-4 修复验证:dryRun=true 时绝不调 LLM(plan 硬约束)
  // 旧实现:dryRun 检查在 LLM 调用之后,导致 dryRun=true 仍消耗一次 LLM 调用
  // 新实现:dryRun=true 走 heuristic 路径,llmClient.complete 不被调用
  it("AI-4: dryRun=true 时 llmClient.complete 不被调用(heuristic 路径)", async () => {
    const id1 = makeSource("源 A", "内容 A");
    const id2 = makeSource("源 B", "内容 B");
    const completeSpy = vi.fn(async () => VALID_LLM_JSON);
    const client = { complete: completeSpy } as unknown as LlmClient;

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2], dryRun: true },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.draft.confidence).toBe(0.0);
    expect(result.draft.reason).toMatch(/dryRun.*heuristic.*未调.*LLM/);
    expect(result.draft.title).toContain("heuristic");
    expect(result.draft.content).toContain("源 A");
    expect(result.draft.content).toContain("源 B");
  });

  // AI-4:dryRun=true 时即使 llmClient 缺失也能返回 draft(因为不调 LLM)
  it("AI-4: dryRun=true 时 llmClient 缺失也能返回 draft(不需 LLM 配置)", async () => {
    const id1 = makeSource("源 X", "内容 X");
    const id2 = makeSource("源 Y", "内容 Y");
    // makeCtx() 不传 client,llmClient = undefined

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2], dryRun: true },
      makeCtx(),
    )) as EngramSynthesizeResult;

    expect(result.dryRun).toBe(true);
    expect(result.draft).toBeTruthy();
    expect(result.draft.confidence).toBe(0.0);
    expect(result.draft.content).toContain("源 X");
    expect(result.draft.content).toContain("源 Y");
  });

  it("ids 重复自动去重", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id1, id2, id2, id1] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(result.sourceIds).toEqual([id1, id2]);
    expect(result.synapseIds).toHaveLength(2);
  });

  it("LLM 返回 markdown fence → 容忍解析", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(
      () => "```json\n" + VALID_LLM_JSON + "\n```",
    );

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(result.patternEngramId).toBeTruthy();
    expect(result.draft.title).toContain("Edge Cases");
  });

  it("LLM 输出带前后 prose → 抽出 JSON", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(
      () => `Let me analyze these samples.\nSure, here's the pattern:\n${VALID_LLM_JSON}\nDone.`,
    );

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    expect(result.patternEngramId).toBeTruthy();
  });

  it("synthesisHints 透传到 LLM prompt", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    let capturedPrompt = "";
    const client: LlmClient = {
      async complete(prompt: string) {
        capturedPrompt = prompt;
        return VALID_LLM_JSON;
      },
    };

    await engramSynthesizeTool.execute(
      { ids: [id1, id2], synthesisHints: "Focus on testing stability" },
      makeCtx(client),
    );

    expect(capturedPrompt).toContain("Focus on testing stability");
    expect(capturedPrompt).toContain("Additional guidance from caller");
  });

  it("audit log 记录 pattern-via-synthesis", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    const events = audit.query({});
    const lastEvent = events[events.length - 1];
    expect(lastEvent.action).toBe("create");
    expect(lastEvent.metadata.target).toBe("pattern-via-synthesis");
    expect(lastEvent.metadata.sourceIds).toEqual([id1, id2]);
    expect(lastEvent.metadata.synapseIds).toEqual(result.synapseIds);
  });
});

// ============================================================
// 错误路径
// ============================================================

describe("engram_synthesize — error paths", () => {
  it("ctx.llmClient 缺失 → 抛错带安装指引", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, id2] },
        makeCtx(undefined),
      ),
    ).rejects.toThrow(/LLM client is not available for tool engram_synthesize/);
  });

  it("ids 少于 2 → schema 校验拒绝", async () => {
    const id1 = makeSource("a", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/Invalid input/i);
  });

  it("源 engram 部分不存在 → 抛错列出缺失 id(不部分执行)", async () => {
    const id1 = makeSource("a", "content");
    const client = makeStubClient(() => VALID_LLM_JSON);

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, "nonexistent/id-1", "nonexistent/id-2"] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/Source engrams not found.*nonexistent\/id-1.*nonexistent\/id-2/s);

    // 不应创建任何 pattern engram
    const all = repo.listEngrams();
    expect(all.filter((e) => e.id !== id1)).toHaveLength(0);
  });

  it("LLM 调用抛错 → 透传且不创建 engram", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client: LlmClient = {
      async complete() {
        throw new Error("network down");
      },
    };

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, id2] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/LLM synthesis call failed.*network down/);

    const all = repo.listEngrams();
    expect(all).toHaveLength(2); // 只剩源 engram
  });

  it("LLM 返回非 JSON → 抛错,不创建垃圾 engram", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => "sorry I cannot help with that");

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, id2] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/Failed to parse LLM synthesis output/);

    const all = repo.listEngrams();
    expect(all).toHaveLength(2); // 只剩源
  });

  it("LLM 返回 JSON 缺 title → parseSynthesisOutput 返回 null → 抛错", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() =>
      JSON.stringify({
        content: "no title",
        summary: "x",
        domainTags: [],
        confidence: 0.5,
        reason: "x",
      }),
    );

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, id2] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/Failed to parse/);
  });

  it("LLM 返回空字符串 → 抛错(non-string 检查)", async () => {
    const id1 = makeSource("a", "content");
    const id2 = makeSource("b", "content");
    const client = makeStubClient(() => "");

    await expect(
      engramSynthesizeTool.execute(
        { ids: [id1, id2] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/non-string output|Failed to parse/);
  });
});

// ============================================================
// domainTags 解析优先级
// ============================================================

describe("engram_synthesize — domainTags resolution", () => {
  it("LLM 推断优先于源并集(用户未显式指定)", async () => {
    const id1 = makeSource("a", "content", ["frontend", "react"]);
    const id2 = makeSource("b", "content", ["backend", "node"]);
    const client = makeStubClient(() => VALID_LLM_JSON); // LLM 推断 ["testing", "patterns"]

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    const pattern = repo.readEngram(result.patternEngramId!);
    expect(pattern.domainTags).toEqual(["testing", "patterns"]);
  });

  it("LLM domainTags 为空 → fallback 到源并集(取前 5)", async () => {
    const id1 = makeSource("a", "content", ["alpha", "beta"]);
    const id2 = makeSource("b", "content", ["gamma", "delta"]);
    const client = makeStubClient(() =>
      JSON.stringify({
        title: "Some Pattern",
        summary: "x",
        content: "the pattern body content is long enough to be meaningful",
        domainTags: [], // LLM 没推断
        confidence: 0.6,
        reason: "x",
      }),
    );

    const result = (await engramSynthesizeTool.execute(
      { ids: [id1, id2] },
      makeCtx(client),
    )) as EngramSynthesizeResult;

    const pattern = repo.readEngram(result.patternEngramId!);
    expect(pattern.domainTags.sort()).toEqual(
      ["alpha", "beta", "gamma", "delta"].sort(),
    );
  });
});
