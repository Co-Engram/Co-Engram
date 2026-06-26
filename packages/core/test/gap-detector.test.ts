import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  DEFAULT_GAP_CONFIG,
  detectKnowledgeGaps,
  type KnowledgeGap,
} from "../src/generative/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-gap-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content?: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  domainTags?: readonly string[];
  contextTags?: readonly string[];
  importance?: number;
  createdBy?: string;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["testing"],
    contextTags: input.contextTags,
    importance: input.importance ?? 0.5,
    createdBy: input.createdBy ?? "alice",
  });
}

function addDerivesFrom(fromId: string, toId: string): void {
  repo.addOutgoingSynapse(fromId, {
    id: `syn-${fromId}-${toId}-${Math.random().toString(36).slice(2, 8)}`,
    from: fromId,
    to: toId,
    kind: "derives_from",
    weight: 0.7,
    direction: "directional",
    evidence: [],
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.7,
  });
}

function addContradicts(fromId: string, toId: string): void {
  repo.addOutgoingSynapse(fromId, {
    id: `contra-${fromId}-${toId}-${Math.random().toString(36).slice(2, 8)}`,
    from: fromId,
    to: toId,
    kind: "contradicts",
    weight: 0.8,
    direction: "directional",
    evidence: [],
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    retrievalWeight: 0.8,
  });
}

// ============================================================
// DEFAULT_GAP_CONFIG
// ============================================================

describe("DEFAULT_GAP_CONFIG", () => {
  it("默认阈值符合 spec", () => {
    expect(DEFAULT_GAP_CONFIG.minEvidenceForFact).toBe(2);
    expect(DEFAULT_GAP_CONFIG.minEvidenceForHypothesis).toBe(3);
    expect(DEFAULT_GAP_CONFIG.minEvidenceForPattern).toBe(3);
    expect(DEFAULT_GAP_CONFIG.missingProcedureThreshold).toBe(5);
    expect(DEFAULT_GAP_CONFIG.missingContradictionImportance).toBe(0.7);
    expect(DEFAULT_GAP_CONFIG.includeOrphans).toBe(true);
    expect(DEFAULT_GAP_CONFIG.includeStaleActive).toBe(true);
  });
});

// ============================================================
// missing_evidence
// ============================================================

describe("missing_evidence", () => {
  it("fact 只有 0 个 derives_from → 报告", () => {
    makeEngram({ title: "fact-1", kind: "fact", domainTags: ["x"] });
    const result = detectKnowledgeGaps(repo);
    const evidence = result.gaps.filter((g) => g.type === "missing_evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.severity).toBe("high"); // 0/min=0
  });

  it("fact 有 1 个 derives_from → medium", () => {
    const f = makeEngram({ title: "fact-1", kind: "fact", domainTags: ["x"] });
    const obs = makeEngram({
      title: "obs-1",
      kind: "observation",
      domainTags: ["x"],
    });
    addDerivesFrom(f.id, obs.id);

    const result = detectKnowledgeGaps(repo);
    const evidence = result.gaps.filter((g) => g.type === "missing_evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.severity).toBe("medium");
  });

  it("fact 有 2+ derives_from → 不报告", () => {
    const f = makeEngram({ title: "fact-1", kind: "fact", domainTags: ["x"] });
    const o1 = makeEngram({
      title: "obs-1",
      kind: "observation",
      domainTags: ["x"],
    });
    const o2 = makeEngram({
      title: "obs-2",
      kind: "observation",
      domainTags: ["x"],
    });
    addDerivesFrom(f.id, o1.id);
    addDerivesFrom(f.id, o2.id);

    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_evidence"),
    ).toHaveLength(0);
  });

  it("observation 不检查 evidence（默认 kind 无最小要求）", () => {
    makeEngram({ title: "obs-1", kind: "observation", domainTags: ["x"] });
    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_evidence"),
    ).toHaveLength(0);
  });

  it("hypothesis 阈值更高（默认 3）", () => {
    const h = makeEngram({ title: "h", kind: "hypothesis", domainTags: ["x"] });
    const o1 = makeEngram({
      title: "o1",
      kind: "observation",
      domainTags: ["x"],
    });
    const o2 = makeEngram({
      title: "o2",
      kind: "observation",
      domainTags: ["x"],
    });
    addDerivesFrom(h.id, o1.id);
    addDerivesFrom(h.id, o2.id);
    // 2 < 3 → 仍然报告

    const result = detectKnowledgeGaps(repo);
    const ev = result.gaps.filter((g) => g.type === "missing_evidence");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.severity).toBe("medium");
  });
});

// ============================================================
// missing_procedure
// ============================================================

describe("missing_procedure", () => {
  it("spec 验收：有 observation 无 procedure → 正确识别", () => {
    // 5 个 observation + 0 个 procedure（domain=android）
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `obs-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    const result = detectKnowledgeGaps(repo);
    const procGaps = result.gaps.filter((g) => g.type === "missing_procedure");
    expect(procGaps).toHaveLength(1);
    expect(procGaps[0]!.domainTags).toEqual(["android"]);
    expect(procGaps[0]!.description).toMatch(/android/);
    expect(procGaps[0]!.relatedEngramIds).toHaveLength(5);
  });

  it("已有 procedure → 不报告", () => {
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `obs-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    makeEngram({ title: "proc-1", kind: "procedure", domainTags: ["android"] });

    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_procedure"),
    ).toHaveLength(0);
  });

  it("obs/fact 数量 < threshold → 不报告", () => {
    for (let i = 0; i < 4; i++) {
      makeEngram({
        title: `obs-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_procedure"),
    ).toHaveLength(0);
  });

  it("数量 ≥ 2x threshold → severity=high", () => {
    for (let i = 0; i < 10; i++) {
      makeEngram({
        title: `obs-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    const result = detectKnowledgeGaps(repo);
    const procGaps = result.gaps.filter((g) => g.type === "missing_procedure");
    expect(procGaps[0]!.severity).toBe("high");
  });

  it("按 domain 分别统计", () => {
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `a-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    for (let i = 0; i < 5; i++) {
      makeEngram({ title: `i-${i}`, kind: "observation", domainTags: ["ios"] });
    }
    const result = detectKnowledgeGaps(repo);
    const procGaps = result.gaps.filter((g) => g.type === "missing_procedure");
    expect(procGaps).toHaveLength(2);
    const domains = procGaps.map((g) => g.domainTags![0]).sort();
    expect(domains).toEqual(["android", "ios"]);
  });
});

// ============================================================
// missing_contradiction
// ============================================================

describe("missing_contradiction", () => {
  it("高 importance fact 无 contradicts → 报告", () => {
    makeEngram({
      title: "important fact",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.9,
    });
    const result = detectKnowledgeGaps(repo);
    const contradicts = result.gaps.filter(
      (g) => g.type === "missing_contradiction",
    );
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0]!.severity).toBe("high"); // importance >= 0.9
  });

  it("importance < threshold → 不报告", () => {
    makeEngram({
      title: "low fact",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.5,
    });
    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_contradiction"),
    ).toHaveLength(0);
  });

  it("observation 不检查 contradicts（反例少是常态）", () => {
    makeEngram({
      title: "high obs",
      kind: "observation",
      domainTags: ["x"],
      importance: 0.95,
    });
    const result = detectKnowledgeGaps(repo);
    expect(
      result.gaps.filter((g) => g.type === "missing_contradiction"),
    ).toHaveLength(0);
  });

  it("有 outgoing contradicts → 不报告", () => {
    const a = makeEngram({
      title: "fact A",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.9,
    });
    const b = makeEngram({
      title: "fact B",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.5,
    });
    addContradicts(a.id, b.id);
    const result = detectKnowledgeGaps(repo);
    // A 有 outgoing contradicts → 不报告；B importance=0.5 → 不报告
    expect(
      result.gaps.filter((g) => g.type === "missing_contradiction"),
    ).toHaveLength(0);
  });

  it("有 incoming contradicts → 不报告", () => {
    const a = makeEngram({
      title: "fact A",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.5,
    });
    const b = makeEngram({
      title: "fact B",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.9,
    });
    addContradicts(a.id, b.id); // A contradicts B
    const result = detectKnowledgeGaps(repo);
    // B 有 incoming contradicts → 不报告
    expect(
      result.gaps.filter((g) => g.type === "missing_contradiction"),
    ).toHaveLength(0);
  });
});

// ============================================================
// orphan_engram
// ============================================================

describe("orphan_engram", () => {
  it("无任何 synapse 的 engram → 报告", () => {
    makeEngram({ title: "orphan", domainTags: ["x"] });
    const result = detectKnowledgeGaps(repo);
    const orphans = result.gaps.filter((g) => g.type === "orphan_engram");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.severity).toBe("low");
  });

  it("有 synapse → 不报告", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B", domainTags: ["x"] });
    addDerivesFrom(a.id, b.id);

    const result = detectKnowledgeGaps(repo);
    // A 有 outgoing；B 有 incoming（derives_from 的 to）
    // 都不算 orphan
    expect(result.gaps.filter((g) => g.type === "orphan_engram")).toHaveLength(
      0,
    );
  });

  it("includeOrphans=false → 不检测", () => {
    makeEngram({ title: "orphan", domainTags: ["x"] });
    const result = detectKnowledgeGaps(repo, {
      config: { includeOrphans: false },
    });
    expect(result.gaps.filter((g) => g.type === "orphan_engram")).toHaveLength(
      0,
    );
  });
});

// ============================================================
// stale_active
// ============================================================

describe("stale_active", () => {
  it("freshness=stale + status=active → 报告", () => {
    const e = makeEngram({ title: "stale", domainTags: ["x"] });
    repo.updateLifecycle(e.id, undefined, "stale");

    const result = detectKnowledgeGaps(repo);
    const staleGaps = result.gaps.filter((g) => g.type === "stale_active");
    expect(staleGaps).toHaveLength(1);
  });

  it("freshness=fresh → 不报告", () => {
    const e = makeEngram({ title: "fresh", domainTags: ["x"] });
    repo.updateLifecycle(e.id, undefined, "fresh");
    const result = detectKnowledgeGaps(repo);
    expect(result.gaps.filter((g) => g.type === "stale_active")).toHaveLength(
      0,
    );
  });

  it("stale 但 archived → 不报告", () => {
    const e = makeEngram({ title: "archived", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "archived", "stale");
    const result = detectKnowledgeGaps(repo);
    expect(result.gaps.filter((g) => g.type === "stale_active")).toHaveLength(
      0,
    );
  });

  it("includeStaleActive=false → 不检测", () => {
    const e = makeEngram({ title: "stale", domainTags: ["x"] });
    repo.updateLifecycle(e.id, undefined, "stale");
    const result = detectKnowledgeGaps(repo, {
      config: { includeStaleActive: false },
    });
    expect(result.gaps.filter((g) => g.type === "stale_active")).toHaveLength(
      0,
    );
  });
});

// ============================================================
// domainTags 过滤 + summary
// ============================================================

describe("domainTags 过滤 + summary", () => {
  it("限定 domain → 只检测该域", () => {
    // android 域：缺 procedure
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `a-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    // ios 域：也缺 procedure
    for (let i = 0; i < 5; i++) {
      makeEngram({ title: `i-${i}`, kind: "observation", domainTags: ["ios"] });
    }

    const result = detectKnowledgeGaps(repo, { domainTags: ["android"] });
    expect(
      result.gaps.filter((g) => g.type === "missing_procedure"),
    ).toHaveLength(1);
    expect(result.gaps[0]!.domainTags).toEqual(["android"]);
  });

  it("summary.byType 准确统计", () => {
    // 用不同 domain 隔离，避免触发 missing_procedure
    // orphan：完全孤立（无 synapse）
    makeEngram({ title: "orphan", domainTags: ["a"] });

    // fact 有 derives_from（非 orphan）但 < min → missing_evidence
    const f = makeEngram({ title: "fact", kind: "fact", domainTags: ["b"] });
    const o = makeEngram({
      title: "src",
      kind: "observation",
      domainTags: ["b"],
    });
    addDerivesFrom(f.id, o.id);

    // stale 且有 synapse（非 orphan）
    const stale = makeEngram({ title: "stale", domainTags: ["c"] });
    const staleSrc = makeEngram({ title: "stale-src", domainTags: ["c"] });
    addDerivesFrom(stale.id, staleSrc.id);
    repo.updateLifecycle(stale.id, undefined, "stale"); // stale_active

    const result = detectKnowledgeGaps(repo);
    expect(result.summary.byType.orphan_engram).toBe(1);
    expect(result.summary.byType.missing_evidence).toBe(1);
    expect(result.summary.byType.stale_active).toBe(1);
    expect(result.summary.byType.missing_procedure).toBe(0);
    expect(result.summary.byType.missing_contradiction).toBe(0);
    expect(result.summary.totalGaps).toBe(3);
  });

  it("gaps 按 severity 排序（high → low）", () => {
    const high = makeEngram({
      title: "high",
      kind: "fact",
      domainTags: ["x"],
      importance: 0.95, // high severity missing_contradiction
    });
    void high;
    makeEngram({ title: "orphan", domainTags: ["x"] }); // low severity orphan

    const result = detectKnowledgeGaps(repo);
    const severities = result.gaps.map((g) => g.severity);
    // high 在 low 之前
    const highIdx = severities.indexOf("high");
    const lowIdx = severities.indexOf("low");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ============================================================
// 空仓库
// ============================================================

describe("空仓库", () => {
  it("无 engram → 0 gap", () => {
    const result = detectKnowledgeGaps(repo);
    expect(result.gaps).toEqual([]);
    expect(result.summary.totalGaps).toBe(0);
  });
});

// ============================================================
// 综合场景
// ============================================================

describe("综合场景", () => {
  it("混合缺口都能识别", () => {
    // 1. missing_evidence: fact 只有 1 个 derives_from
    const f = makeEngram({
      title: "fact-1",
      kind: "fact",
      domainTags: ["android"],
    });
    const o1 = makeEngram({
      title: "obs-1",
      kind: "observation",
      domainTags: ["android"],
    });
    addDerivesFrom(f.id, o1.id);

    // 2. missing_procedure: android 域 5 obs 0 proc
    for (let i = 2; i <= 5; i++) {
      makeEngram({
        title: `obs-${i}`,
        kind: "observation",
        domainTags: ["android"],
      });
    }
    // 等等，fact-1 + 5 obs = 6 (≥5)，且 0 proc → missing_procedure

    // 3. missing_contradiction: 高 importance fact 无 contradicts
    makeEngram({
      title: "high-fact",
      kind: "fact",
      domainTags: ["ios"],
      importance: 0.9,
    });

    // 4. orphan
    makeEngram({ title: "orphan", domainTags: ["misc"] });

    // 5. stale_active
    const stale = makeEngram({ title: "stale-e", domainTags: ["misc"] });
    repo.updateLifecycle(stale.id, undefined, "stale");

    const result = detectKnowledgeGaps(repo);
    const types = new Set(result.gaps.map((g) => g.type));
    expect(types.has("missing_evidence")).toBe(true);
    expect(types.has("missing_procedure")).toBe(true);
    expect(types.has("missing_contradiction")).toBe(true);
    expect(types.has("orphan_engram")).toBe(true);
    expect(types.has("stale_active")).toBe(true);
  });
});
