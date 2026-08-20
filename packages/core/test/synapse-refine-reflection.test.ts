import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { IndexDb } from "../src/storage/index-db.js";
import { refineSynapsesOnActiveGraph } from "../src/dreaming/synapse-refiner.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";

/**
 * 反思落地(2026-08,REM 突触维护二期)refiner 集成:
 * 注入 llmClient 时按 LLM 判定 kind 提案(causes 等跨族从 0 起步)/判 none 不提/
 * 反向交换端点;缺失/失败降级占位 similar_to + reflection_skipped 审计。
 */
describe("refineSynapsesOnActiveGraph × 反思判断层", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let indexDb: IndexDb;
  let proposed: Array<{
    from: string;
    to: string;
    kind: string;
    reason: string;
  }>;
  let proposalEngine: {
    proposeSynapseOp: (input: {
      from: string;
      to: string;
      kind: string;
      reason: string;
    }) => boolean;
  };
  let auditEntries: Array<{
    action: string;
    metadata?: Record<string, unknown>;
  }>;
  let auditLog: {
    append: (e: { action: string; metadata?: Record<string, unknown> }) => void;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-refine-reflect-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    indexDb = new IndexDb({ dbPath: join(tmpDir, ".co-engram", "index.db") });
    indexDb.open();
    repo = new EngramRepository({ rootPath: tmpDir, language: "zh" }, indexDb);
    proposed = [];
    proposalEngine = {
      proposeSynapseOp: (input) => {
        proposed.push({
          from: input.from,
          to: input.to,
          kind: input.kind,
          reason: input.reason,
        });
        return true;
      },
    };
    auditEntries = [];
    auditLog = {
      append: (e) => {
        auditEntries.push({ action: e.action, metadata: e.metadata });
      },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 两个高相似(过 Jaccard 预筛)无 edge 的活跃 engram 对 */
  function seedSimilarPair(): { a: string; b: string } {
    const a = repo.createEngram({
      title: "根因分析",
      content: "信号游标未初始化导致首批事件被吞,根本原因在构造函数",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    const b = repo.createEngram({
      title: "修复方案",
      content: "信号游标未初始化导致事件被吞,修复为构造时初始化游标",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    return { a: a.id, b: b.id };
  }

  const judgeClient = (verdict: {
    kind: string;
    confidence?: number;
    reverse?: boolean;
  }): LlmClient => ({
    complete: async () =>
      JSON.stringify({
        judgments: [
          {
            index: 0,
            kind: verdict.kind,
            confidence: verdict.confidence ?? 0.8,
            reason: "测试判断",
            ...(verdict.reverse ? { reverse: true } : {}),
          },
        ],
      }),
  });

  it("LLM 判跨族关系 → 提案按判定 kind(因果族从 0 起步)", async () => {
    const { a, b } = seedSimilarPair();
    const r = await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      llmClient: judgeClient({ kind: "causes" }),
    });
    expect(r.proposed).toBe(1);
    expect(proposed[0]?.kind).toBe("causes");
    expect(proposed[0]?.reason).toContain("REM 反思");
    expect(proposed[0]?.reason).toContain("测试判断");
    // 无降级审计
    expect(
      auditEntries.filter((e) => e.action === "reflection_skipped"),
    ).toHaveLength(0);
    // 端点:字典序对(a<b 或 b<a),非 reverse 不交换 —— 只验证两端集合
    expect([proposed[0]?.from, proposed[0]?.to].sort()).toEqual([a, b].sort());
  });

  it("LLM 判 reverse → 交换端点(有向方向由 LLM 裁定)", async () => {
    seedSimilarPair();
    await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      llmClient: judgeClient({ kind: "supersedes", reverse: true }),
    });
    // 字典序小的必然是 from(候选对 a<b);reverse 后 from 应为字典序大者
    const all = repo
      .listEngrams()
      .map((e) => e.id)
      .sort();
    const [small, large] = all;
    expect(proposed[0]?.from).toBe(large);
    expect(proposed[0]?.to).toBe(small);
  });

  it("LLM 判 none → 不提(比占位更少噪音)", async () => {
    seedSimilarPair();
    const r = await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      llmClient: judgeClient({ kind: "none", confidence: 0.3 }),
    });
    expect(r.proposed).toBe(0);
    expect(proposed).toHaveLength(0);
  });

  it("未注入 llmClient → 降级占位 similar_to + 审计 llm-missing", async () => {
    seedSimilarPair();
    const r = await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      auditLog,
    });
    expect(r.proposed).toBeGreaterThanOrEqual(1);
    expect(proposed.every((p) => p.kind === "similar_to")).toBe(true);
    expect(proposed[0]?.reason).toContain("agent review");
    const skipped = auditEntries.find((e) => e.action === "reflection_skipped");
    expect(skipped?.metadata?.reason).toBe("llm-missing");
  });

  it("LLM 全批失败 → 降级占位 similar_to + 审计 llm-failed", async () => {
    seedSimilarPair();
    const failing: LlmClient = {
      complete: async () => {
        throw new Error("LLM down");
      },
    };
    const r = await refineSynapsesOnActiveGraph(repo, proposalEngine, {
      llmClient: failing,
      auditLog,
    });
    expect(r.proposed).toBeGreaterThanOrEqual(1);
    expect(proposed.every((p) => p.kind === "similar_to")).toBe(true);
    const skipped = auditEntries.find((e) => e.action === "reflection_skipped");
    expect(skipped?.metadata?.reason).toBe("llm-failed");
  });
});
