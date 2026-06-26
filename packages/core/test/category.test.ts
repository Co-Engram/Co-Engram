import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  EVOLUTION_CHAIN,
  ALLOWED_UPGRADES,
  DEFAULT_UPGRADE_CONDITIONS,
  assessUpgrade,
  isUpgradeAllowed,
  upgradeEngramKind,
  runCategoryEvolution,
} from "../src/evolution/category.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-category-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  importance?: number;
  effectiveRetrievals?: number;
  incomingSynapseCount?: number;
}) {
  const engram = repo.createEngram({
    title: input.title,
    content: input.content,
    kind: input.kind ?? "observation",
    domainTags: ["t"],
    createdBy: "y",
    importance: input.importance ?? 0.5,
  });
  if (input.effectiveRetrievals || input.incomingSynapseCount) {
    repo.bumpRetrievalStats(engram.id, {
      effectiveDelta: input.effectiveRetrievals,
      retrievedDelta: input.effectiveRetrievals,
    });
  }
  return engram;
}

// ============================================================
// 进化链定义
// ============================================================

describe("EVOLUTION_CHAIN + ALLOWED_UPGRADES", () => {
  it("EVOLUTION_CHAIN 顺序正确", () => {
    expect(EVOLUTION_CHAIN).toEqual([
      "observation",
      "fact",
      "pattern",
      "procedure",
    ]);
  });

  it("ALLOWED_UPGRADES 包含主链", () => {
    expect(isUpgradeAllowed("observation", "fact")).toBe(true);
    expect(isUpgradeAllowed("fact", "pattern")).toBe(true);
    expect(isUpgradeAllowed("pattern", "procedure")).toBe(true);
  });

  it("ALLOWED_UPGRADES 包含跳级", () => {
    expect(isUpgradeAllowed("observation", "pattern")).toBe(true);
    expect(isUpgradeAllowed("observation", "procedure")).toBe(true);
    expect(isUpgradeAllowed("fact", "procedure")).toBe(true);
  });

  it("ALLOWED_UPGRADES 包含 hypothesis 验证", () => {
    expect(isUpgradeAllowed("hypothesis", "fact")).toBe(true);
    expect(isUpgradeAllowed("hypothesis", "pattern")).toBe(true);
  });

  it("非法升级被拒绝", () => {
    expect(isUpgradeAllowed("procedure", "observation")).toBe(false); // 不可降级
    expect(isUpgradeAllowed("fact", "observation")).toBe(false); // 不可降级
    expect(isUpgradeAllowed("procedure", "fact")).toBe(false);
  });

  it("相同 kind 不算升级", () => {
    expect(isUpgradeAllowed("fact", "fact")).toBe(false);
  });
});

// ============================================================
// assessUpgrade
// ============================================================

describe("assessUpgrade", () => {
  it("observation + evidenceCount 充足 → fact", () => {
    const assessment = assessUpgrade({
      kind: "observation",
      kinds: ["observation"],
      effectiveRetrievals: 0,
      retrievalCount: 0,
      incomingSynapseCount: 5,
    });
    expect(assessment.canUpgrade).toBe(true);
    expect(assessment.targetKind).toBe("fact");
    expect(assessment.readiness).toBe(1);
  });

  it("observation + evidence 不足 → 不能升级", () => {
    const assessment = assessUpgrade({
      kind: "observation",
      kinds: ["observation"],
      effectiveRetrievals: 0,
      retrievalCount: 0,
      incomingSynapseCount: 1,
    });
    expect(assessment.canUpgrade).toBe(false);
    expect(assessment.readiness).toBeLessThan(1);
  });

  it("fact + effectiveRetrievals 充足 → pattern", () => {
    const assessment = assessUpgrade({
      kind: "fact",
      kinds: ["fact"],
      effectiveRetrievals: 7,
      retrievalCount: 10,
      incomingSynapseCount: 5,
    });
    expect(assessment.canUpgrade).toBe(true);
    expect(assessment.targetKind).toBe("pattern");
  });

  it("pattern + effectiveRetrievals 充足 → procedure", () => {
    const assessment = assessUpgrade({
      kind: "pattern",
      kinds: ["pattern"],
      effectiveRetrievals: 15,
      retrievalCount: 20,
      incomingSynapseCount: 5,
    });
    expect(assessment.canUpgrade).toBe(true);
    expect(assessment.targetKind).toBe("procedure");
  });

  it("hypothesis → fact（直接）", () => {
    const assessment = assessUpgrade({
      kind: "hypothesis",
      kinds: ["hypothesis"],
      effectiveRetrievals: 0,
      retrievalCount: 0,
      incomingSynapseCount: 0,
    });
    expect(assessment.canUpgrade).toBe(true);
    expect(assessment.targetKind).toBe("fact");
  });

  it("procedure → 不能升级（达到本模块最高级）", () => {
    const assessment = assessUpgrade({
      kind: "procedure",
      kinds: ["procedure"],
      effectiveRetrievals: 100,
      retrievalCount: 200,
      incomingSynapseCount: 50,
    });
    expect(assessment.canUpgrade).toBe(false);
    expect(assessment.reason).toMatch(/Skill/);
  });

  it("自定义 conditions 生效", () => {
    const assessment = assessUpgrade(
      {
        kind: "observation",
        kinds: ["observation"],
        effectiveRetrievals: 0,
        retrievalCount: 0,
        incomingSynapseCount: 2,
      },
      { ...DEFAULT_UPGRADE_CONDITIONS, observationToFactEvidence: 2 },
    );
    expect(assessment.canUpgrade).toBe(true);
  });
});

// ============================================================
// upgradeEngramKind
// ============================================================

describe("upgradeEngramKind", () => {
  it("合法升级：observation → fact", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    const result = upgradeEngramKind(repo, {
      id: e.id,
      newKind: "fact",
      reason: "verified",
      evidence: "evidenceCount=5",
      upgradedBy: "yang",
    });
    expect(result.previousKind).toBe("observation");
    expect(result.newKind).toBe("fact");

    const updated = repo.readEngram(e.id);
    expect(updated.kind).toBe("fact");
    expect(updated.kinds).toContain("observation"); // 旧的保留
    expect(updated.kinds).toContain("fact");
  });

  it("newKind 排在 kinds 第一位（变成主 kind）", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    upgradeEngramKind(repo, {
      id: e.id,
      newKind: "fact",
      reason: "r",
      upgradedBy: "y",
    });
    const updated = repo.readEngram(e.id);
    expect(updated.kinds[0]).toBe("fact");
  });

  it("keepOldKinds=false → 只保留新 kind", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    upgradeEngramKind(repo, {
      id: e.id,
      newKind: "fact",
      reason: "r",
      upgradedBy: "y",
      keepOldKinds: false,
    });
    const updated = repo.readEngram(e.id);
    expect(updated.kinds).toEqual(["fact"]);
  });

  it("trail 含 originalKind + transitions", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    const r1 = upgradeEngramKind(repo, {
      id: e.id,
      newKind: "fact",
      reason: "verified",
      upgradedBy: "y",
      nowIso: "2026-01-01T00:00:00Z",
    });
    const r2 = upgradeEngramKind(repo, {
      id: e.id,
      newKind: "pattern",
      reason: "abstracted",
      upgradedBy: "y",
      nowIso: "2026-01-02T00:00:00Z",
    });
    expect(r2.trail.originalKind).toBe("observation");
    expect(r2.trail.currentKind).toBe("pattern");
    expect(r2.trail.transitions.length).toBeGreaterThanOrEqual(2);
  });

  it("非法升级抛错", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "fact" });
    expect(() =>
      upgradeEngramKind(repo, {
        id: e.id,
        newKind: "observation", // 降级
        reason: "r",
        upgradedBy: "y",
      }),
    ).toThrow(/not allowed/);
  });

  it("不存在抛错", () => {
    expect(() =>
      upgradeEngramKind(repo, {
        id: "no/such",
        newKind: "fact",
        reason: "r",
        upgradedBy: "y",
      }),
    ).toThrow(/not found/);
  });

  it("version 自增（每次升级）", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    const before = repo.readEngram(e.id).version;
    upgradeEngramKind(repo, {
      id: e.id,
      newKind: "fact",
      reason: "r",
      upgradedBy: "y",
    });
    const after = repo.readEngram(e.id).version;
    expect(after).toBe(before + 1);
  });
});

// ============================================================
// runCategoryEvolution
// ============================================================

describe("runCategoryEvolution", () => {
  it("空仓库 → 0 scanned", () => {
    const result = runCategoryEvolution(repo);
    expect(result.scanned).toBe(0);
  });

  it("满足条件 → 自动升级", () => {
    // observation + incomingSynapseCount=5（通过 synapse 模拟）
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    // 模拟 evidence：创建 5 个其他 engram 并连接到 e（exemplifies）
    for (let i = 0; i < 5; i++) {
      const witness = repo.createEngram({
        title: `Witness ${i}`,
        content: `witness ${i}`,
        kind: "observation",
        domainTags: ["t"],
        createdBy: "y",
      });
      const synapse = {
        id: `syn-${i}`,
        from: witness.id,
        to: e.id,
        kind: "exemplifies" as const,
        weight: 0.5,
        direction: "directional" as const,
        evidence: [],
        createdBy: "y",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        retrievalWeight: 0.5,
      };
      repo.addOutgoingSynapse(witness.id, synapse);
    }

    const result = runCategoryEvolution(repo, {
      nowIso: "2026-06-20T00:00:00Z",
    });
    expect(result.scanned).toBe(6); // 1 主 + 5 witness
    expect(result.upgraded.length).toBeGreaterThanOrEqual(1);
    const upgraded = result.upgraded.find((u) => u.id === e.id);
    expect(upgraded).toBeDefined();
    expect(upgraded!.from).toBe("observation");
    expect(upgraded!.to).toBe("fact");
  });

  it("不满足条件 → skipped", () => {
    makeEngram({ title: "A", content: "a", kind: "observation" });
    const result = runCategoryEvolution(repo);
    expect(result.upgraded.length).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it("跳过 archived", () => {
    const e = makeEngram({ title: "A", content: "a" });
    repo.updateLifecycle(e.id, "archived");
    const result = runCategoryEvolution(repo);
    expect(result.scanned).toBe(0);
  });

  it("dryRun=true 不落盘", () => {
    const e = makeEngram({ title: "A", content: "a", kind: "observation" });
    // 模拟 evidence
    for (let i = 0; i < 5; i++) {
      const w = repo.createEngram({
        title: `W${i}`,
        content: `w ${i}`,
        kind: "observation",
        domainTags: ["t"],
        createdBy: "y",
      });
      repo.addOutgoingSynapse(w.id, {
        id: `s${i}`,
        from: w.id,
        to: e.id,
        kind: "exemplifies",
        weight: 0.5,
        direction: "directional",
        evidence: [],
        createdBy: "y",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        retrievalWeight: 0.5,
      });
    }
    const result = runCategoryEvolution(repo, { dryRun: true });
    expect(result.upgraded.length).toBeGreaterThan(0);
    expect(repo.readEngram(e.id).kind).toBe("observation"); // 没落盘
  });

  it("稳定扫描：按 id 字典序", () => {
    makeEngram({ title: "Z", content: "z" });
    makeEngram({ title: "A", content: "a" });
    makeEngram({ title: "M", content: "m" });
    const r1 = runCategoryEvolution(repo);
    const r2 = runCategoryEvolution(repo);
    expect(r1.scanned).toBe(r2.scanned);
  });
});

// ============================================================
// spec 验收：observation 经多次验证后升级为 fact
// ============================================================

describe("spec 验收：类别进化链", () => {
  it("observation → fact → pattern → procedure 完整链路", () => {
    const e = makeEngram({
      title: "主题",
      content: "内容",
      kind: "observation",
    });

    // Step 1: observation → fact（evidence 充足）
    for (let i = 0; i < 5; i++) {
      const w = repo.createEngram({
        title: `证据 ${i}`,
        content: `证据内容 ${i}`,
        kind: "observation",
        domainTags: ["t"],
        createdBy: "y",
      });
      repo.addOutgoingSynapse(w.id, {
        id: `s-${i}`,
        from: w.id,
        to: e.id,
        kind: "exemplifies",
        weight: 0.5,
        direction: "directional",
        evidence: [],
        createdBy: "y",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        retrievalWeight: 0.5,
      });
    }
    runCategoryEvolution(repo, { nowIso: "2026-02-01T00:00:00Z" });
    expect(repo.readEngram(e.id).kind).toBe("fact");

    // Step 2: fact → pattern（effectiveRetrievals 充足）
    for (let i = 0; i < 6; i++) {
      repo.bumpRetrievalStats(e.id, {
        retrievedDelta: 1,
        effectiveDelta: 1,
        reinforcementDelta: 1,
      });
    }
    runCategoryEvolution(repo, { nowIso: "2026-03-01T00:00:00Z" });
    expect(repo.readEngram(e.id).kind).toBe("pattern");

    // Step 3: pattern → procedure（effectiveRetrievals 充足）
    for (let i = 0; i < 10; i++) {
      repo.bumpRetrievalStats(e.id, {
        retrievedDelta: 1,
        effectiveDelta: 1,
        reinforcementDelta: 1,
      });
    }
    runCategoryEvolution(repo, { nowIso: "2026-04-01T00:00:00Z" });
    expect(repo.readEngram(e.id).kind).toBe("procedure");

    // kinds 数组包含完整轨迹
    const finalEngram = repo.readEngram(e.id);
    expect(finalEngram.kinds).toContain("observation");
    expect(finalEngram.kinds).toContain("fact");
    expect(finalEngram.kinds).toContain("pattern");
    expect(finalEngram.kinds).toContain("procedure");
  });
});
