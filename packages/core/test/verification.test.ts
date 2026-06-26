import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  STATUS_ORDER,
  UPGRADE_PATH,
  TERMINAL_STATUSES,
  canTransition,
  nextUpgradeStatus,
  compareStatus,
  isTerminal,
  isRefuted,
  isVerified,
  upgradeVerification,
  refuteEngram,
  checkUpgradeEligibility,
  summarizeVerificationStatus,
  DEFAULT_VERIFICATION_CONFIG,
  type VerificationConditionConfig,
  type UpgradeEvidence,
} from "../src/verification/index.js";
import type { EngramId, VerificationStatus } from "../src/types/engram.js";
import type { Synapse } from "../src/types/synapse.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-verification-"));
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
  createdBy?: string;
  createdAt?: string;
}) {
  const engram = repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["x"],
    createdBy: input.createdBy ?? "alice",
  });
  // 如果需要控制 createdAt，手动覆写 meta 文件
  if (input.createdAt) {
    repo.updateEngram(engram.id, {
      updatedBy: "tester",
    });
  }
  return engram;
}

/** 给 engram 加一个 derives_from synapse（模拟 hypothesis 源头） */
function addDerivesFrom(
  fromId: EngramId,
  toId: EngramId,
  createdBy = "tester",
): string {
  const synapseId = `der-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const synapse: Synapse = {
    id: synapseId,
    from: fromId,
    to: toId,
    kind: "derives_from",
    weight: 0.7,
    direction: "directional",
    evidence: [
      {
        description: "initial source generated",
        addedAt: now,
        addedBy: createdBy,
      },
    ],
    createdBy,
    createdAt: now,
    updatedAt: now,
    retrievalWeight: 0.7,
  };
  const stored = repo.addOutgoingSynapse(fromId, synapse);
  return stored.id;
}

function evidence(overrides: Partial<UpgradeEvidence> = {}): UpgradeEvidence {
  return {
    description: "validated by alice",
    verifiedBy: "alice",
    ...overrides,
  };
}

// ============================================================
// state-machine：常量
// ============================================================

describe("state-machine 常量", () => {
  it("STATUS_ORDER 数值递增", () => {
    expect(STATUS_ORDER.unverified).toBe(0);
    expect(STATUS_ORDER.plausible).toBe(1);
    expect(STATUS_ORDER.probable).toBe(2);
    expect(STATUS_ORDER.verified).toBe(3);
    expect(STATUS_ORDER.refuted).toBe(4);
  });

  it("UPGRADE_PATH 不包含 refuted", () => {
    expect(UPGRADE_PATH).toEqual([
      "unverified",
      "plausible",
      "probable",
      "verified",
    ]);
  });

  it("TERMINAL_STATUSES 只含 refuted", () => {
    expect(TERMINAL_STATUSES.has("refuted")).toBe(true);
    expect(TERMINAL_STATUSES.has("verified")).toBe(false);
    expect(TERMINAL_STATUSES.size).toBe(1);
  });
});

// ============================================================
// state-machine: canTransition
// ============================================================

describe("canTransition 状态机", () => {
  it("undefined → unverified/plausible/refuted：首次设置允许", () => {
    expect(canTransition(undefined, "unverified")).toBe(true);
    expect(canTransition(undefined, "plausible")).toBe(true);
    expect(canTransition(undefined, "refuted")).toBe(true);
  });

  it("undefined → probable/verified：跳级不允许", () => {
    expect(canTransition(undefined, "probable")).toBe(false);
    expect(canTransition(undefined, "verified")).toBe(false);
  });

  it("相邻级别升级：合法", () => {
    expect(canTransition("unverified", "plausible")).toBe(true);
    expect(canTransition("plausible", "probable")).toBe(true);
    expect(canTransition("probable", "verified")).toBe(true);
  });

  it("跳级：不合法", () => {
    expect(canTransition("unverified", "probable")).toBe(false);
    expect(canTransition("unverified", "verified")).toBe(false);
    expect(canTransition("plausible", "verified")).toBe(false);
  });

  it("降级：不合法", () => {
    expect(canTransition("verified", "probable")).toBe(false);
    expect(canTransition("probable", "plausible")).toBe(false);
    expect(canTransition("plausible", "unverified")).toBe(false);
  });

  it("任何非终态 → refuted：合法", () => {
    expect(canTransition("unverified", "refuted")).toBe(true);
    expect(canTransition("plausible", "refuted")).toBe(true);
    expect(canTransition("probable", "refuted")).toBe(true);
    expect(canTransition("verified", "refuted")).toBe(true);
  });

  it("refuted 是终态：不允许转出", () => {
    expect(canTransition("refuted", "unverified")).toBe(false);
    expect(canTransition("refuted", "plausible")).toBe(false);
    expect(canTransition("refuted", "verified")).toBe(false);
    expect(canTransition("refuted", "refuted")).toBe(false);
  });

  it("同级转：不合法（避免无效转移）", () => {
    expect(canTransition("plausible", "plausible")).toBe(false);
    expect(canTransition("verified", "verified")).toBe(false);
  });
});

// ============================================================
// state-machine: 辅助函数
// ============================================================

describe("state-machine 辅助函数", () => {
  it("nextUpgradeStatus 返回下一个升级状态", () => {
    expect(nextUpgradeStatus(undefined)).toBe("unverified");
    expect(nextUpgradeStatus("unverified")).toBe("plausible");
    expect(nextUpgradeStatus("plausible")).toBe("probable");
    expect(nextUpgradeStatus("probable")).toBe("verified");
  });

  it("nextUpgradeStatus verified 已最高", () => {
    expect(nextUpgradeStatus("verified")).toBe("verified");
  });

  it("nextUpgradeStatus refuted 终态", () => {
    expect(nextUpgradeStatus("refuted")).toBe("refuted");
  });

  it("compareStatus：a 比 b 成熟 → 正数", () => {
    expect(compareStatus("verified", "unverified")).toBeGreaterThan(0);
    expect(compareStatus("unverified", "verified")).toBeLessThan(0);
    expect(compareStatus("plausible", "plausible")).toBe(0);
  });

  it("isTerminal / isRefuted / isVerified", () => {
    expect(isTerminal("refuted")).toBe(true);
    expect(isTerminal("verified")).toBe(false);
    expect(isTerminal(undefined)).toBe(false);

    expect(isRefuted("refuted")).toBe(true);
    expect(isRefuted("verified")).toBe(false);

    expect(isVerified("verified")).toBe(true);
    expect(isVerified("refuted")).toBe(false);
    expect(isVerified(undefined)).toBe(false);
  });
});

// ============================================================
// DEFAULT_VERIFICATION_CONFIG
// ============================================================

describe("DEFAULT_VERIFICATION_CONFIG", () => {
  it("阈值符合 spec §4.5.2", () => {
    expect(DEFAULT_VERIFICATION_CONFIG.minEvidenceForPlausible).toBe(1);
    expect(DEFAULT_VERIFICATION_CONFIG.minEvidenceForProbable).toBe(2);
    expect(DEFAULT_VERIFICATION_CONFIG.minEvidenceForVerified).toBe(3);
    expect(DEFAULT_VERIFICATION_CONFIG.minDomainsForProbable).toBe(2);
    expect(DEFAULT_VERIFICATION_CONFIG.minDomainsForVerified).toBe(2);
    expect(DEFAULT_VERIFICATION_CONFIG.minStabilityDaysForVerified).toBe(7);
  });
});

// ============================================================
// checkUpgradeEligibility
// ============================================================

describe("checkUpgradeEligibility", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() =>
      checkUpgradeEligibility(repo, "no/such", "plausible", evidence()),
    ).toThrow(/not found/);
  });

  it("升级 plausible：1 条证据即可", () => {
    const e = makeEngram({ title: "A" });
    const result = checkUpgradeEligibility(repo, e.id, "plausible", evidence());
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("升级 probable：需要 evidence ≥ 2", () => {
    const e = makeEngram({ title: "A" });
    const result = checkUpgradeEligibility(repo, e.id, "probable", evidence());
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("evidence_count");
    expect(result.evidenceCount).toBe(1); // 只有本次新证据
  });

  it("升级 probable：累积证据满足后合格", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    // 第一次升级 plausible
    const r1 = upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "first" }),
    );
    expect(r1.applied).toBe(true);

    // 第二次升级 probable
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "probable",
      evidence({ description: "second" }),
    );
    expect(result.evidenceCount).toBe(2);
  });

  it("升级 verified：需要跨情境 + 时间稳定", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    // plausible
    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
    );
    // probable
    upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
    );
    // verified
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "verified",
      evidence({ description: "e3", domainTags: ["z"] }),
      {
        nowIso: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
    );
    expect(result.eligible).toBe(true);
  });

  it("升级 verified：时间稳定不足 → missing time_stability", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
    );
    upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
    );
    // 同一天升级
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "verified",
      evidence({ description: "e3" }),
    );
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("time_stability");
  });

  it("升级 probable：distinctDomains 不足 → missing cross_context", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
    );
    // 只有 'x' domain → distinctDomains = 1
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["x"] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("cross_context");
  });

  it("refute 路径：无条件合格", () => {
    const a = makeEngram({ title: "A" });
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "refuted",
      evidence({ description: "反例" }),
    );
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("refute 路径：空 description → 不合格", () => {
    const a = makeEngram({ title: "A" });
    const result = checkUpgradeEligibility(
      repo,
      a.id,
      "refuted",
      evidence({ description: "" }),
    );
    expect(result.eligible).toBe(false);
  });
});

// ============================================================
// upgradeVerification：正向升级
// ============================================================

describe("upgradeVerification 正向升级", () => {
  it("engram 不存在 → 抛错", () => {
    expect(() =>
      upgradeVerification(repo, "no/such", "plausible", evidence()),
    ).toThrow(/not found/);
  });

  it("undefined → plausible：合格且 applied", () => {
    const a = makeEngram({ title: "A" });
    const result = upgradeVerification(repo, a.id, "plausible", evidence());
    expect(result.applied).toBe(true);
    expect(result.eligible).toBe(true);
    // 默认 'unverified',因此 previousStatus 就是 'unverified'
    expect(result.previousStatus).toBe("unverified");
    expect(result.newStatus).toBe("plausible");
    expect(repo.readEngram(a.id).verificationStatus).toBe("plausible");
  });

  it("plausible → probable：累积 2 条证据合格", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
    );
    const result = upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
    );
    expect(result.applied).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.newStatus).toBe("probable");
  });

  it("跳级（undefined → probable）：不允许（状态机拒绝）", () => {
    const a = makeEngram({ title: "A" });
    // 未设置 verificationStatus（undefined）→ 跳 probable：状态机拒绝
    const result = upgradeVerification(repo, a.id, "probable", evidence());
    expect(result.applied).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("跳级（undefined → verified）：不允许（状态机拒绝）", () => {
    const a = makeEngram({ title: "A" });
    const result = upgradeVerification(repo, a.id, "verified", evidence());
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("跳级（unverified → probable）：不允许（状态机拒绝）", () => {
    const a = makeEngram({ title: "A" });
    // 先合法设置为 unverified
    upgradeVerification(repo, a.id, "unverified", evidence());
    // 再尝试跳级到 probable：状态机拒绝
    const result = upgradeVerification(repo, a.id, "probable", evidence());
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("跳级（plausible → verified）：不允许（状态机拒绝）", () => {
    const a = makeEngram({ title: "A" });
    upgradeVerification(repo, a.id, "plausible", evidence());
    const result = upgradeVerification(repo, a.id, "verified", evidence());
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("降级（verified → plausible）：不允许", () => {
    const a = makeEngram({ title: "A" });
    // 直接设置 verified（绕过状态机，模拟外部已验证状态）
    repo.updateVerificationStatus(a.id, "verified");
    expect(repo.readEngram(a.id).verificationStatus).toBe("verified");

    const result = upgradeVerification(repo, a.id, "plausible", evidence());
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("条件不足时（probable 缺证据）：不 applied", () => {
    const a = makeEngram({ title: "A" });
    // 先升 plausible（条件需要 1 证据，本次即可）
    upgradeVerification(repo, a.id, "plausible", evidence());
    // 再升 probable，没有 derives_from 且证据不足 → 不合格
    const result = upgradeVerification(repo, a.id, "probable", evidence());
    expect(result.applied).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/conditions not met/);
  });

  it("force=true：跳过条件检查但保留状态机校验", () => {
    const a = makeEngram({ title: "A" });
    // 无 derives_from + 证据不足 → 正常不合格
    const normal = upgradeVerification(repo, a.id, "plausible", evidence());
    expect(normal.applied).toBe(true); // plausible 只需 1 证据

    // 跳级 unverified→probable，force 也无法绕过状态机
    const forced = upgradeVerification(repo, a.id, "verified", evidence(), {
      force: true,
    });
    expect(forced.applied).toBe(false);
    expect(forced.reason).toMatch(/illegal transition/);
  });

  it("force=true 升级 verified：跨过时间稳定要求", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
    );
    upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
    );
    // 不够稳定 → 正常不合格
    const normal = upgradeVerification(
      repo,
      a.id,
      "verified",
      evidence({ description: "e3" }),
    );
    expect(normal.applied).toBe(false);

    // force → 升级成功
    const forced = upgradeVerification(
      repo,
      a.id,
      "verified",
      evidence({ description: "e3" }),
      { force: true },
    );
    expect(forced.applied).toBe(true);
    expect(forced.reason).toMatch(/forced/);
  });
});

// ============================================================
// upgradeVerification：反驳路径
// ============================================================

describe("upgradeVerification 反驳路径", () => {
  it("refute：从 unverified 可直接 refute", () => {
    const a = makeEngram({ title: "A" });
    const result = upgradeVerification(
      repo,
      a.id,
      "refuted",
      evidence({ description: "反例" }),
    );
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("refuted");
  });

  it("refute：从 verified 可直接 refute", () => {
    const a = makeEngram({ title: "A" });
    upgradeVerification(repo, a.id, "verified", evidence(), { force: true });
    const result = upgradeVerification(
      repo,
      a.id,
      "refuted",
      evidence({ description: "新反例" }),
    );
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("refuted");
  });

  it("refuted 之后无法再升级", () => {
    const a = makeEngram({ title: "A" });
    upgradeVerification(
      repo,
      a.id,
      "refuted",
      evidence({ description: "反例" }),
    );
    const result = upgradeVerification(repo, a.id, "verified", evidence());
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/illegal transition/);
  });

  it("refuteEngram 便捷函数", () => {
    const a = makeEngram({ title: "A" });
    const result = refuteEngram(repo, a.id, evidence({ description: "反例" }));
    expect(result.applied).toBe(true);
    expect(result.newStatus).toBe("refuted");
  });
});

// ============================================================
// upgradeVerification：evidence 追加
// ============================================================

describe("upgradeVerification evidence 追加", () => {
  it("有 derives_from synapse：evidence 追加成功", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const synId = addDerivesFrom(a.id, b.id);

    const result = upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "first check" }),
    );
    expect(result.evidenceAppended).toBe(true);
    expect(result.synapseIds).toEqual([synId]);

    // 验证 evidence 落盘
    const synapseFile = repo.readSynapses(a.id);
    const syn = synapseFile.outgoing.find((s) => s.id === synId)!;
    expect(syn.evidence.length).toBe(2); // 初始 + 追加
    expect(syn.evidence[1]!.description).toMatch(/^\[plausible\] first check/);
  });

  it("无 derives_from synapse：evidenceAppended=false 但 applied=true", () => {
    const a = makeEngram({ title: "A" });
    const result = upgradeVerification(repo, a.id, "plausible", evidence());
    expect(result.applied).toBe(true);
    expect(result.evidenceAppended).toBe(false);
    expect(result.synapseIds).toEqual([]);
  });

  it("多条 derives_from：evidence 同时追加到所有", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });
    const synId1 = addDerivesFrom(a.id, b.id);
    const synId2 = addDerivesFrom(a.id, c.id);

    const result = upgradeVerification(repo, a.id, "plausible", evidence());
    expect(result.synapseIds).toHaveLength(2);
    expect(result.synapseIds).toContain(synId1);
    expect(result.synapseIds).toContain(synId2);
  });

  it("evidence description 包含 tags: 前缀", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({
        description: "跨情境验证",
        domainTags: ["mobile", "web"],
      }),
    );

    const synapseFile = repo.readSynapses(a.id);
    const syn = synapseFile.outgoing.find((s) => s.kind === "derives_from")!;
    const last = syn.evidence[syn.evidence.length - 1]!;
    expect(last.description).toMatch(/tags:mobile,web/);
  });
});

// ============================================================
// checkUpgradeEligibility：返回证据链
// ============================================================

describe("evidenceCount 累积", () => {
  it("每次升级后 evidenceCount +1", () => {
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    // 初始
    let r = checkUpgradeEligibility(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1" }),
    );
    expect(r.evidenceCount).toBe(1);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1" }),
    );

    r = checkUpgradeEligibility(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2" }),
    );
    expect(r.evidenceCount).toBe(2);
  });

  it("distinctDomains 包含 engram 自身 domainTags + evidence", () => {
    const a = makeEngram({ title: "A", domainTags: ["mobile"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    const r = checkUpgradeEligibility(
      repo,
      a.id,
      "plausible",
      evidence({ domainTags: ["web"] }),
    );
    expect(r.distinctDomains).toBe(2); // mobile + web
  });
});

// ============================================================
// summarizeVerificationStatus
// ============================================================

describe("summarizeVerificationStatus", () => {
  it("空仓库：全 0", () => {
    const s = summarizeVerificationStatus(repo);
    expect(s.total).toBe(0);
    expect(s.byStatus.unverified).toBe(0);
    expect(s.byStatus.refuted).toBe(0);
    expect(s.byStatus.verified).toBe(0);
  });

  it("未设置 verificationStatus 视为 unverified", () => {
    makeEngram({ title: "A" });
    makeEngram({ title: "B" });
    const s = summarizeVerificationStatus(repo);
    expect(s.total).toBe(2);
    expect(s.byStatus.unverified).toBe(2);
  });

  it("正确按状态分类", () => {
    const a = makeEngram({ title: "A" });
    const b = makeEngram({ title: "B" });
    const c = makeEngram({ title: "C" });

    upgradeVerification(repo, a.id, "plausible", evidence());
    // 直接设置 verified（绕过状态机，模拟外部已验证状态）
    repo.updateVerificationStatus(b.id, "verified");
    refuteEngram(repo, c.id, evidence({ description: "反例" }));

    const s = summarizeVerificationStatus(repo);
    expect(s.total).toBe(3);
    expect(s.byStatus.plausible).toBe(1);
    expect(s.byStatus.verified).toBe(1);
    expect(s.byStatus.refuted).toBe(1);
    expect(s.byStatus.unverified).toBe(0);
    expect(s.refutedCount).toBe(1);
    expect(s.verifiedCount).toBe(1);
  });
});

// ============================================================
// 端到端：完整证据链
// ============================================================

describe("端到端：从 observation 到 verified", () => {
  it("完整生命周期：unverified → plausible → probable → verified", () => {
    // 模拟一个 hypothesis 从生成到验证为 verified 的完整证据链
    const h = repo.createEngram({
      title: "Hypothesis: adb 连接稳定性与 USB 数据线质量强相关",
      content: "基于多次观察，劣质 USB 数据线会导致 adb 连接频繁断开",
      kind: "hypothesis",
      domainTags: ["mobile", "adb"],
      createdBy: "alice",
    });
    const obs1 = makeEngram({ title: "obs-1", domainTags: ["mobile"] });
    addDerivesFrom(h.id, obs1.id);

    // 阶段 1：1 条验证证据 → plausible
    const r1 = upgradeVerification(
      repo,
      h.id,
      "plausible",
      evidence({
        description: "在 mobile 域首次验证",
        domainTags: ["mobile"],
        verifiedBy: "bob",
      }),
    );
    expect(r1.applied).toBe(true);
    expect(r1.newStatus).toBe("plausible");

    // 阶段 2：第 2 条证据 + 跨情境 → probable
    const r2 = upgradeVerification(
      repo,
      h.id,
      "probable",
      evidence({
        description: "在 embedded 域再次复现",
        domainTags: ["embedded"],
        verifiedBy: "carol",
      }),
    );
    expect(r2.applied).toBe(true);
    expect(r2.newStatus).toBe("probable");

    // 阶段 3：第 3 条证据 + 跨情境 + 时间稳定 → verified
    const future = new Date(
      Date.now() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const r3 = upgradeVerification(
      repo,
      h.id,
      "verified",
      evidence({
        description: "大规模场景验证",
        domainTags: ["ci"],
        verifiedBy: "dave",
        confidence: 0.95,
      }),
      { nowIso: future },
    );
    expect(r3.applied).toBe(true);
    expect(r3.newStatus).toBe("verified");
  });

  it("完整证据链：每条 evidence 都有 verdict + verifiedBy + 可选 confidence", () => {
    const h = repo.createEngram({
      title: "H: X",
      content: "x",
      kind: "hypothesis",
      domainTags: ["d1"],
      createdBy: "alice",
    });
    const src = makeEngram({ title: "src" });
    addDerivesFrom(h.id, src.id);

    upgradeVerification(
      repo,
      h.id,
      "plausible",
      evidence({
        description: "p",
        verifiedBy: "bob",
        confidence: 0.7,
        domainTags: ["d1"],
      }),
    );
    upgradeVerification(
      repo,
      h.id,
      "probable",
      evidence({
        description: "pr",
        verifiedBy: "carol",
        confidence: 0.8,
        domainTags: ["d2"],
      }),
    );

    const synapseFile = repo.readSynapses(h.id);
    const syn = synapseFile.outgoing.find((s) => s.kind === "derives_from")!;
    // 1 initial + 2 verdict evidence
    expect(syn.evidence.length).toBe(3);
    const verdicts = syn.evidence.slice(1);
    expect(verdicts[0]!.description).toMatch(/^\[plausible\]/);
    expect(verdicts[0]!.addedBy).toBe("bob");
    expect(verdicts[0]!.confidence).toBe(0.7);
    expect(verdicts[1]!.description).toMatch(/^\[probable\]/);
  });

  it("refute 中途打断：完整 refuted 证据", () => {
    const h = repo.createEngram({
      title: "H",
      content: "x",
      kind: "hypothesis",
      domainTags: ["d1"],
      createdBy: "alice",
    });
    const src = makeEngram({ title: "src" });
    addDerivesFrom(h.id, src.id);

    upgradeVerification(
      repo,
      h.id,
      "plausible",
      evidence({ description: "initial", verifiedBy: "bob" }),
    );

    // 发现反例 → 直接 refute
    const refuteResult = refuteEngram(
      repo,
      h.id,
      evidence({
        description: "反例：在 Y 场景无法复现",
        verifiedBy: "carol",
        confidence: 0.9,
      }),
    );
    expect(refuteResult.applied).toBe(true);
    expect(refuteResult.newStatus).toBe("refuted");
    expect(repo.readEngram(h.id).verificationStatus).toBe("refuted");
  });
});

// ============================================================
// 自定义 config
// ============================================================

describe("自定义 VerificationConditionConfig", () => {
  it("放宽阈值：minEvidenceForVerified=2", () => {
    const config: VerificationConditionConfig = {
      ...DEFAULT_VERIFICATION_CONFIG,
      minEvidenceForVerified: 2,
      minStabilityDaysForVerified: 0,
    };
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
      { config },
    );
    upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
      { config },
    );
    const r = upgradeVerification(
      repo,
      a.id,
      "verified",
      evidence({ description: "e3" }),
      { config },
    );
    expect(r.applied).toBe(true);
  });

  it("收紧阈值：minDomainsForProbable=3", () => {
    const config: VerificationConditionConfig = {
      ...DEFAULT_VERIFICATION_CONFIG,
      minDomainsForProbable: 3,
    };
    const a = makeEngram({ title: "A", domainTags: ["x"] });
    const b = makeEngram({ title: "B" });
    addDerivesFrom(a.id, b.id);

    upgradeVerification(
      repo,
      a.id,
      "plausible",
      evidence({ description: "e1", domainTags: ["x"] }),
      { config },
    );
    // 只有 2 个 domain → 不合格
    const r = upgradeVerification(
      repo,
      a.id,
      "probable",
      evidence({ description: "e2", domainTags: ["y"] }),
      { config },
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/cross_context/);
  });
});
