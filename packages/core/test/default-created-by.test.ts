import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { SearchOrchestrator } from "../src/retrieval/orchestrator.js";
import { AuditLog } from "../src/observability/audit-log.js";
import {
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
} from "../src/observability/proposal-engine.js";
import { engramCreateTool } from "../src/tools/engram-tools.js";
import { synapseCreateTool } from "../src/tools/synapse-tools.js";
import { engramAcceptProposalTool } from "../src/tools/proposal-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let search: SearchOrchestrator;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-default-created-by-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  search = new SearchOrchestrator();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { repository: repo, searchOrchestrator: search, ...overrides };
}

describe("engram_create createdBy 完全覆盖行为(2026-07 修复)", () => {
  // ============================================================
  // 2026-07 修复:createdBy 完全由系统决定,LLM 传入的任何值都被忽略。
  //
  // 起因:LLM 在 Claude Code 会话里自我标识为 "claude-code",直接覆盖了
  // 本该是 git author 的 defaultCreatedBy,导致团队记忆里出现 host 标识
  // 作为「作者」,语义混乱。
  //
  // 修复策略:createdBy = 「人类责任归属」,权威来源是本机 git 身份
  // (user.name > user.email)。LLM 想表达自动生成情境应走 encodingContext。
  // ============================================================

  it("LLM 传 host 标识('claude-code')→ 被忽略,走 ctx.defaultCreatedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const result = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "claude-code",
      },
      ctx,
    );
    const engram = repo.readEngram(result.id);
    // 修复前:engram.createdBy === "claude-code"(LLM 覆盖了 default)
    // 修复后:engram.createdBy === "ctx-default"(LLM 被忽略)
    expect(engram.createdBy).toBe("ctx-default");
  });

  it("LLM 传合理用户标识('Yang Yang')→ 也被忽略(完全覆盖,无白名单)", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const result = engramCreateTool.execute(
      {
        title: "B",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "Yang Yang",
      },
      ctx,
    );
    const engram = repo.readEngram(result.id);
    // 即便 LLM 传了合理用户名,也走系统解析(git author)—— createdBy 不该
    // 让 LLM 自填,git 身份是 single source of truth
    expect(engram.createdBy).toBe("ctx-default");
  });

  it("LLM 不传 createdBy → 走 ctx.defaultCreatedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const result = engramCreateTool.execute(
      {
        title: "C",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
      },
      ctx,
    );
    const engram = repo.readEngram(result.id);
    expect(engram.createdBy).toBe("ctx-default");
  });

  it('ctx.defaultCreatedBy 也缺省时回退到 "unknown"', () => {
    const ctx = buildCtx();
    const result = engramCreateTool.execute(
      {
        title: "D",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        // 即使 LLM 传值,也走 "unknown"(因为 ctx.defaultCreatedBy 缺省)
        createdBy: "anything-llm-passed",
      },
      ctx,
    );
    const engram = repo.readEngram(result.id);
    expect(engram.createdBy).toBe("unknown");
  });

  it("dedupe UPDATE 路径也使用回退后的 createdBy 作为 mergedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const first = engramCreateTool.execute(
      {
        title: "ADB 调试",
        content: "使用 adb wireless 调试 Android 设备的方法",
        kind: "fact",
        domainTags: ["testing"],
      },
      ctx,
    );
    expect(first.verdict).toBe("NEW");

    const updated = engramCreateTool.execute(
      {
        title: "ADB 调试",
        content: "使用 adb wireless 调试 Android 设备的方法 详细步骤",
        kind: "fact",
        domainTags: ["testing"],
      },
      ctx,
    );
    expect(updated.verdict).toBe("UPDATE");

    const engram = repo.readEngram(first.id);
    expect(engram.updatedBy).toBe("ctx-default");
  });
});

describe("synapse_create createdBy 回退行为", () => {
  it("LLM 传 createdBy(含 host 标识)→ 被忽略,走 ctx.defaultCreatedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "synapse-default" });
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "a",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "y",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "b",
      },
      ctx,
    );

    // LLM 显式传 createdBy='claude-code'(host 标识),修复后应被忽略
    const result = synapseCreateTool.execute(
      {
        from: a.id,
        to: b.id,
        kind: "extends",
        createdBy: "claude-code",
      },
      ctx,
    );
    expect(result.id).toBeTruthy();

    const synapse = repo
      .readSynapses(a.id)
      .outgoing.find((s) => s.id === result.id);
    expect(synapse).toBeDefined();
    expect(synapse!.createdBy).toBe("synapse-default");
  });

  it("未传 createdBy 时回退到 ctx.defaultCreatedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "synapse-default" });
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "a",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "y",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "b",
      },
      ctx,
    );

    const result = synapseCreateTool.execute(
      {
        from: a.id,
        to: b.id,
        kind: "extends",
      },
      ctx,
    );
    expect(result.id).toBeTruthy();

    const synapse = repo
      .readSynapses(a.id)
      .outgoing.find((s) => s.id === result.id);
    expect(synapse).toBeDefined();
    expect(synapse!.createdBy).toBe("synapse-default");
  });

  it('ctx.defaultCreatedBy 缺省时回退到 "unknown"', () => {
    const ctx = buildCtx();
    const a = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "a",
      },
      ctx,
    );
    const b = engramCreateTool.execute(
      {
        title: "B",
        content: "y",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "b",
      },
      ctx,
    );

    const result = synapseCreateTool.execute(
      {
        from: a.id,
        to: b.id,
        kind: "extends",
      },
      ctx,
    );
    const synapse = repo
      .readSynapses(a.id)
      .outgoing.find((s) => s.id === result.id);
    expect(synapse!.createdBy).toBe("unknown");
  });
});

describe("engram_accept_proposal createdBy 回退行为", () => {
  let audit: AuditLog;
  let engine: ProposalEngine;

  beforeEach(() => {
    audit = new AuditLog(tmpDir);
    engine = new ProposalEngine({
      repository: repo,
      embedder: DEFAULT_HASHER_EMBEDDER,
      auditLog: audit,
      dataRoot: tmpDir,
      // hash embedder 必须配套 0.35 阈值,详见 proposal-engine.ts 注释
      config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
    });
  });

  async function seedPendingProposal(): Promise<string> {
    // 不同措辞的同主题样本(机械重复会被新 Layer 2 过滤掉)
    const samples = [
      "configure github actions for typescript ci pipelines",
      "set up github actions typescript ci pipelines workflow",
      "enable github actions for typescript ci pipeline builds",
    ];
    for (const s of samples) {
      await engine.observe({ role: "user", content: s });
    }
    const [proposal] = engine.listPending();
    if (!proposal) throw new Error("failed to seed a pending proposal");
    return proposal.entityId;
  }

  it("LLM 传 host 标识('claude-code')→ 被忽略,走 ctx.defaultCreatedBy", async () => {
    const entityId = await seedPendingProposal();
    const ctx = buildCtx({
      defaultCreatedBy: "ctx-default",
      proposalEngine: engine,
    });
    const result = engramAcceptProposalTool.execute(
      {
        entityId,
        title: "CI for TS",
        content: "use github actions",
        domainTags: ["devops"],
        createdBy: "claude-code",
      },
      ctx,
    );
    const engram = repo.readEngram(result.engramId);
    // 修复前:Zod schema default 强制填 'proposal-engine',绕过 ctx.defaultCreatedBy
    // 修复后:走 parsed.createdBy ?? ctx.defaultCreatedBy ?? 'unknown'(2026-07 进一步改为完全覆盖)
    expect(engram.createdBy).toBe("ctx-default");
  });

  it("LLM 传合理用户标识('Yang Yang')→ 也被忽略(完全覆盖,对齐 engram_create)", async () => {
    const entityId = await seedPendingProposal();
    const ctx = buildCtx({
      defaultCreatedBy: "ctx-default",
      proposalEngine: engine,
    });
    const result = engramAcceptProposalTool.execute(
      {
        entityId,
        title: "CI for TS",
        content: "use github actions",
        domainTags: ["devops"],
        createdBy: "Yang Yang",
      },
      ctx,
    );
    const engram = repo.readEngram(result.engramId);
    // 与 engram_create 一致:即便 LLM 传合理用户名也忽略,git 身份是 single source of truth
    expect(engram.createdBy).toBe("ctx-default");
  });

  it("未传 createdBy 时回退到 ctx.defaultCreatedBy(对齐 engram_create)", async () => {
    const entityId = await seedPendingProposal();
    const ctx = buildCtx({
      defaultCreatedBy: "ctx-default",
      proposalEngine: engine,
    });
    const result = engramAcceptProposalTool.execute(
      {
        entityId,
        title: "CI for TS",
        content: "use github actions",
        domainTags: ["devops"],
      },
      ctx,
    );
    const engram = repo.readEngram(result.engramId);
    // 修复前:Zod schema default 强制填 'proposal-engine',绕过 ctx.defaultCreatedBy
    // 修复后:走 parsed.createdBy ?? ctx.defaultCreatedBy ?? 'unknown'
    expect(engram.createdBy).toBe("ctx-default");
  });

  it('ctx.defaultCreatedBy 也缺省时回退到 "unknown"', async () => {
    const entityId = await seedPendingProposal();
    const ctx = buildCtx({ proposalEngine: engine });
    const result = engramAcceptProposalTool.execute(
      {
        entityId,
        title: "CI for TS",
        content: "use github actions",
        domainTags: ["devops"],
      },
      ctx,
    );
    const engram = repo.readEngram(result.engramId);
    expect(engram.createdBy).toBe("unknown");
  });
});
