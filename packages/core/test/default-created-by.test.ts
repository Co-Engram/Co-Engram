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

describe("engram_create createdBy 回退行为", () => {
  it("显式传入 createdBy 时优先使用", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const result = engramCreateTool.execute(
      {
        title: "A",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "explicit",
      },
      ctx,
    );
    const engram = repo.readEngram(result.id);
    expect(engram.createdBy).toBe("explicit");
  });

  it("未传 createdBy 时回退到 ctx.defaultCreatedBy", () => {
    const ctx = buildCtx({ defaultCreatedBy: "ctx-default" });
    const result = engramCreateTool.execute(
      {
        title: "B",
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
        title: "C",
        content: "x",
        kind: "fact",
        domainTags: ["t"],
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

  it("显式传入 createdBy 时优先使用", async () => {
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
        createdBy: "explicit-user",
      },
      ctx,
    );
    const engram = repo.readEngram(result.engramId);
    expect(engram.createdBy).toBe("explicit-user");
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
