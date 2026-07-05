import { describe, it, expect, vi } from "vitest";
import { runCrossFileConsistency } from "./cross-file-coordinator.js";
import type { EngramRepository } from "../storage/repository.js";
import type { Engram, EngramCatalogEntry } from "../types/engram.js";
import type { EngramId } from "../types/engram.js";
import type {
  Synapse,
  SynapseId,
  SynapseResolutionState,
} from "../types/synapse.js";
import { LlmArbiter } from "./llm-arbiter.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { AuditLog } from "../observability/audit-log.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── 测试 fixture 构造 ─────────────────────────────────────────────────

function makeCatalogEntry(id: string, title = id): EngramCatalogEntry {
  return {
    id: id as EngramId,
    title,
    kind: "observation",
    domainTags: ["test"],
  };
}

function makeEngram(id: string, overrides: Partial<Engram> = {}): Engram {
  return {
    id: id as EngramId,
    title: id,
    contentHash: "hash-" + id,
    kind: "observation",
    kinds: ["observation"],
    domainTags: ["test"],
    content: "",
    summary: "",
    contentSize: 0,
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "alice",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    importance: 0.5,
    confidence: 0.5,
    sourceType: "firsthand",
    evidenceCount: 0,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0.5,
    decayHalfLifeDays: null,
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
    freshness: "fresh",
    status: "active",
    contextTags: [],
    visibility: "public",
    ...overrides,
  };
}

function makeSynapse(
  from: string,
  to: string,
  kind: Synapse["kind"],
  overrides: Partial<Synapse> = {},
): Synapse {
  return {
    id: `syn-${from}-${to}-${kind}` as SynapseId,
    from: from as EngramId,
    to: to as EngramId,
    kind,
    weight: 0.5,
    direction: "directional",
    evidence: [],
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.5,
    ...overrides,
  };
}

interface MockRepoSpec {
  engrams: Engram[];
  synapsesByFrom?: Record<string, Synapse[]>;
  archivedIds?: string[];
}

function makeMockRepository(spec: MockRepoSpec): {
  repo: EngramRepository;
  archivedIds: string[];
} {
  const archivedIds = [...(spec.archivedIds ?? [])];
  const catalog: EngramCatalogEntry[] = spec.engrams.map((e) => ({
    id: e.id,
    title: e.title,
    kind: e.kind,
    domainTags: e.domainTags,
  }));
  const engramsById = new Map(spec.engrams.map((e) => [e.id, e]));

  const repo = {
    listEngrams: () => catalog,
    readEngram: (id: string) => {
      const en = engramsById.get(id as EngramId);
      if (!en) throw new Error(`Engram not found: ${id}`);
      // 如果被 archived,返回 archived 状态
      if (archivedIds.includes(id)) {
        return { ...en, status: "archived" as const };
      }
      return en;
    },
    readSynapses: (id: string) => ({
      outgoing: spec.synapsesByFrom?.[id] ?? [],
      incoming: [],
    }),
    updateLifecycle: (id: string, status?: unknown) => {
      if (status === "archived") {
        archivedIds.push(id);
      }
    },
  } as unknown as EngramRepository;

  return { repo, archivedIds };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("runCrossFileConsistency", () => {
  it("returns empty report on clean repository", async () => {
    const { repo } = makeMockRepository({
      engrams: [makeEngram("E1"), makeEngram("E2")],
    });
    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toEqual([]);
    expect(report.autoFixedCount).toBe(0);
    expect(report.llmEscalatedCount).toBe(0);
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
  });

  it("Check 1: flags refuted engram that still has outgoing synapse", async () => {
    const refuted = makeEngram("E1", { verificationStatus: "refuted" });
    const active = makeEngram("E2");
    const { repo } = makeMockRepository({
      engrams: [refuted, active],
      synapsesByFrom: {
        E1: [makeSynapse("E1", "E2", "related_to")],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toHaveLength(1);
    expect(report.inconsistencies[0].kind).toBe(
      "refuted_engram_has_active_synapse",
    );
    expect(report.inconsistencies[0].engramId).toBe("E1");
    expect(report.inconsistencies[0].autoFixed).toBe(false);
  });

  it("Check 1: flags forgotten engram but not active one", async () => {
    const forgotten = makeEngram("E1", { status: "forgotten" });
    const active = makeEngram("E2");
    const { repo } = makeMockRepository({
      engrams: [forgotten, active],
      synapsesByFrom: {
        E1: [makeSynapse("E1", "E2", "related_to")],
        E2: [makeSynapse("E2", "E1", "related_to")],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toHaveLength(1);
    expect(report.inconsistencies[0].engramId).toBe("E1");
  });

  it("Check 1: does not flag refuted engram with zero synapses", async () => {
    const refuted = makeEngram("E1", { verificationStatus: "refuted" });
    const { repo } = makeMockRepository({
      engrams: [refuted],
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toEqual([]);
  });

  it("Check 2: auto-archives supersedes target (spec §7.3)", async () => {
    const newer = makeEngram("E1");
    const older = makeEngram("E2");
    const { repo, archivedIds } = makeMockRepository({
      engrams: [newer, older],
      synapsesByFrom: {
        E1: [makeSynapse("E1", "E2", "supersedes")],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.autoFixedCount).toBe(1);
    expect(report.inconsistencies[0].kind).toBe(
      "supersedes_target_not_archived",
    );
    expect(report.inconsistencies[0].engramId).toBe("E2");
    expect(report.inconsistencies[0].autoFixed).toBe(true);
    expect(archivedIds).toContain("E2");
  });

  it("Check 2: does not re-archive already-archived target", async () => {
    const newer = makeEngram("E1");
    const older = makeEngram("E2", { status: "archived" });
    const { repo, archivedIds } = makeMockRepository({
      engrams: [newer, older],
      archivedIds: ["E2"],
      synapsesByFrom: {
        E1: [makeSynapse("E1", "E2", "supersedes")],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toEqual([]);
    expect(archivedIds).toEqual(["E2"]); // 未追加
  });

  it("Check 3 (no LLM): flags contradicts synapse stuck in pending", async () => {
    const e1 = makeEngram("E1");
    const e2 = makeEngram("E2");
    const stuckRs: SynapseResolutionState = {
      status: "pending",
      phase: 1,
    };
    const { repo } = makeMockRepository({
      engrams: [e1, e2],
      synapsesByFrom: {
        E1: [
          makeSynapse("E1", "E2", "contradicts", { resolutionState: stuckRs }),
        ],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toHaveLength(1);
    expect(report.inconsistencies[0].kind).toBe(
      "contradicts_resolution_state_drift",
    );
    expect(report.inconsistencies[0].synapseId).toContain("contradicts");
  });

  it("Check 3 (no LLM): does not flag resolved contradicts", async () => {
    const e1 = makeEngram("E1");
    const e2 = makeEngram("E2");
    const resolvedRs: SynapseResolutionState = {
      status: "resolved",
      phase: 3,
    };
    const { repo } = makeMockRepository({
      engrams: [e1, e2],
      synapsesByFrom: {
        E1: [
          makeSynapse("E1", "E2", "contradicts", {
            resolutionState: resolvedRs,
          }),
        ],
      },
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toEqual([]);
  });

  it("Check 4 (no LLM): flags engram with empty domainTags", async () => {
    const clean = makeEngram("E1");
    const empty = makeEngram("E2", { domainTags: [] });
    const { repo } = makeMockRepository({
      engrams: [clean, empty],
    });

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toHaveLength(1);
    expect(report.inconsistencies[0].kind).toBe("disjoint_domain_tags");
    expect(report.inconsistencies[0].engramId).toBe("E2");
  });

  it("with LLM: paths use scan variants (Phase 3 scan-only)", async () => {
    const client: LlmClient = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({
          verdict: "ours",
          rationale: "x",
          confidence: 0.95,
        }),
      ),
    };
    const arbiter = new LlmArbiter({ client });
    const empty = makeEngram("E1", { domainTags: [] });
    const { repo } = makeMockRepository({
      engrams: [empty],
    });

    const report = await runCrossFileConsistency({
      repository: repo,
      llmArbiter: arbiter,
    });
    expect(report.inconsistencies).toHaveLength(1);
    expect(report.inconsistencies[0].kind).toBe("disjoint_domain_tags");
    // Phase 3 scan-only — LLM 未实际被调
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("writes audit entries for all inconsistencies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfc-audit-"));
    try {
      const auditLog = new AuditLog(dir);
      const refuted = makeEngram("E1", { verificationStatus: "refuted" });
      const target = makeEngram("E2");
      const { repo } = makeMockRepository({
        engrams: [refuted, target],
        synapsesByFrom: {
          E1: [makeSynapse("E1", "E2", "causes")],
        },
      });

      await runCrossFileConsistency({ repository: repo, auditLog });
      const entries = auditLog.query();
      expect(entries.length).toBe(1);
      expect(entries[0].action).toBe("merge_conflict_escalated");
      expect(entries[0].metadata?.kind).toBe(
        "refuted_engram_has_active_synapse",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when readEngram fails for stale index entry", async () => {
    // Simulate an index entry pointing to a deleted file
    const catalog: EngramCatalogEntry[] = [makeCatalogEntry("STALE")];
    const repo = {
      listEngrams: () => catalog,
      readEngram: () => {
        throw new Error("Engram not found");
      },
      readSynapses: () => ({ outgoing: [], incoming: [] }),
    } as unknown as EngramRepository;

    const report = await runCrossFileConsistency({ repository: repo });
    expect(report.inconsistencies).toEqual([]);
  });
});
