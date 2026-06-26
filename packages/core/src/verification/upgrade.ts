/**
 * 验证状态升级（spec §4.5.2-4.5.3, P3 4.5）
 *
 * 升级条件（spec §4.5.2 三维证据）：
 *   1. evidenceCount：累积证据数量
 *   2. 跨情境验证：distinctDomainTags（来自 evidence 或 source engram）
 *   3. 时间稳定：自首次编码以来的天数
 *
 * 升级到不同状态的阈值：
 *   - plausible：evidenceCount ≥ 1
 *   - probable：evidenceCount ≥ 2 + distinctDomains ≥ 2
 *   - verified：evidenceCount ≥ 3 + distinctDomains ≥ 2 + ageDays ≥ stabilityDays
 *   - refuted：无条件（只需要 refute 证据）
 *
 * 证据追加规则：
 *   - evidence 同时追加到 engram 的所有 derives_from synapse（如果有）
 *   - 跨情境证据的 domainTags 从 evidence.domainTags 提取
 *
 * @module @co-engram/core/verification
 */

import type { EngramRepository } from "../storage/repository.js";
import type { EngramId, VerificationStatus } from "../types/engram.js";
import type { VerificationEvidence } from "../generative/hypothesis.js";
import { canTransition } from "./state-machine.js";

/** 升级条件配置 */
export interface VerificationConditionConfig {
  /** 升级到 plausible 所需的最少 evidence 数 */
  readonly minEvidenceForPlausible: number;
  /** 升级到 probable 所需的最少 evidence 数 */
  readonly minEvidenceForProbable: number;
  /** 升级到 verified 所需的最少 evidence 数 */
  readonly minEvidenceForVerified: number;
  /** 升级到 probable 所需的最少 distinct domainTags 数 */
  readonly minDomainsForProbable: number;
  /** 升级到 verified 所需的最少 distinct domainTags 数 */
  readonly minDomainsForVerified: number;
  /** 升级到 verified 所需的时间稳定天数（自 engram 创建起算） */
  readonly minStabilityDaysForVerified: number;
}

export const DEFAULT_VERIFICATION_CONFIG: VerificationConditionConfig = {
  minEvidenceForPlausible: 1,
  minEvidenceForProbable: 2,
  minEvidenceForVerified: 3,
  minDomainsForProbable: 2,
  minDomainsForVerified: 2,
  minStabilityDaysForVerified: 7,
};

/**
 * 升级证据（扩展自 generative 的 VerificationEvidence）
 *
 * 增加 `domainTags` 用于跨情境证据聚合。
 * 复用 generative 模块的基础结构，避免双接口并存。
 */
export interface UpgradeEvidence extends VerificationEvidence {
  /** 跨情境标签：来自哪个 domain/context */
  readonly domainTags?: readonly string[];
}

/** 单条已落盘的证据（从 derives_from synapse 重建） */
interface PersistedEvidence {
  readonly description: string;
  readonly verifiedBy: string;
  readonly confidence?: number;
  readonly domainTags: readonly string[];
}

/** 单项条件检查结果 */
export interface ConditionCheck {
  readonly key: string;
  readonly required: string;
  readonly actual: string;
  readonly passed: boolean;
}

/** 资格检查结果 */
export interface CheckUpgradeEligibilityResult {
  readonly engramId: EngramId;
  readonly fromStatus: VerificationStatus | undefined;
  readonly toStatus: VerificationStatus;
  readonly eligible: boolean;
  /** 未满足的条件 key 列表 */
  readonly missing: readonly string[];
  readonly checks: readonly ConditionCheck[];
  readonly evidenceCount: number;
  readonly distinctDomains: number;
  readonly ageDays: number;
}

/**
 * 解析 ISO 时间戳到 Date；无效时回退到 epoch
 */
function parseIso(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * 计算两个 ISO 时间戳之间的天数差（向下取整；负值返回 0）
 */
function diffDays(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (!a || !b) return 0;
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * 从 derives_from synapse.evidence 数组重建已落盘证据
 *
 * evidence.description 前缀 `[plausible]` / `[verified]` / `[refuted]` 用于
 * 提取 verdict；其余视作初始 source 生成时的说明。
 *
 * domainTags 如果在 description 中以 `tags:a,b` 格式给出，则解析。
 */
function reconstructPersistedEvidence(
  repo: EngramRepository,
  engramId: EngramId,
): PersistedEvidence[] {
  const result: PersistedEvidence[] = [];
  const file = repo.readSynapses(engramId);
  for (const syn of file.outgoing) {
    if (syn.kind !== "derives_from") continue;
    for (const ev of syn.evidence) {
      result.push({
        description: ev.description,
        verifiedBy: ev.addedBy,
        confidence: ev.confidence,
        domainTags: extractDomainTagsFromDescription(ev.description),
      });
    }
  }
  return result;
}

const DOMAIN_TAGS_PREFIX = "tags:";

function extractDomainTagsFromDescription(description: string): string[] {
  const match = description.match(/\btags:([^\s\]]+)/);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * 检查升级资格（不写盘）
 *
 * 计算当前 engram 的三维证据状态，判断是否满足目标状态的升级条件。
 *
 * @returns CheckUpgradeEligibilityResult
 */
export function checkUpgradeEligibility(
  repo: EngramRepository,
  engramId: EngramId,
  newStatus: VerificationStatus,
  newEvidence: UpgradeEvidence,
  options: {
    readonly config?: VerificationConditionConfig;
    readonly nowIso?: string;
  } = {},
): CheckUpgradeEligibilityResult {
  const config = options.config ?? DEFAULT_VERIFICATION_CONFIG;
  const nowIso = options.nowIso ?? new Date().toISOString();

  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }

  const engram = repo.readEngram(engramId);
  const fromStatus = engram.verificationStatus;

  // 反驳路径：无条件（但 description 必须非空）
  if (newStatus === "refuted") {
    const descriptionOk = newEvidence.description.trim().length > 0;
    return {
      engramId,
      fromStatus,
      toStatus: newStatus,
      eligible: descriptionOk,
      missing: descriptionOk ? [] : ["refute_evidence"],
      checks: [
        {
          key: "refute_evidence",
          required: "evidence description present",
          actual: descriptionOk ? "provided" : "empty",
          passed: descriptionOk,
        },
      ],
      evidenceCount: 0,
      distinctDomains: 0,
      ageDays: 0,
    };
  }

  // 累积证据 = 已落盘 + 本次新证据
  const persisted = reconstructPersistedEvidence(repo, engramId);
  const newEvidenceWithDomains: PersistedEvidence = {
    description: newEvidence.description,
    verifiedBy: newEvidence.verifiedBy,
    confidence: newEvidence.confidence,
    domainTags: newEvidence.domainTags ?? [],
  };
  const allEvidence = [...persisted, newEvidenceWithDomains];

  // 累积 evidence 数（初始 derives_from synapse 的第一条记为"source 生成说明"，不计）
  // 规则：description 以 `[verdict]` 开头的视为升级证据；其他不计
  const verdictEvidence = allEvidence.filter((e) =>
    /^\[(plausible|probable|verified|refuted)\]/.test(e.description),
  );
  const evidenceCount = verdictEvidence.length + 1; // 包含本次将要追加的新证据

  // distinct domain tags（合并 engram 自身 + 所有 evidence 的）
  const domainSet = new Set<string>(engram.domainTags);
  for (const e of allEvidence) {
    for (const t of e.domainTags) {
      domainSet.add(t);
    }
  }
  if (newEvidence.domainTags) {
    for (const t of newEvidence.domainTags) {
      domainSet.add(t);
    }
  }
  const distinctDomains = domainSet.size;

  // 年龄
  const ageDays = diffDays(engram.createdAt, nowIso);

  // 条件检查
  const checks: ConditionCheck[] = [];
  const missing: string[] = [];

  if (newStatus === "plausible") {
    const passed = evidenceCount >= config.minEvidenceForPlausible;
    checks.push({
      key: "evidence_count",
      required: `>= ${config.minEvidenceForPlausible}`,
      actual: String(evidenceCount),
      passed,
    });
    if (!passed) missing.push("evidence_count");
  } else if (newStatus === "probable") {
    const evOk = evidenceCount >= config.minEvidenceForProbable;
    checks.push({
      key: "evidence_count",
      required: `>= ${config.minEvidenceForProbable}`,
      actual: String(evidenceCount),
      passed: evOk,
    });
    if (!evOk) missing.push("evidence_count");

    const domOk = distinctDomains >= config.minDomainsForProbable;
    checks.push({
      key: "cross_context",
      required: `>= ${config.minDomainsForProbable} domains`,
      actual: String(distinctDomains),
      passed: domOk,
    });
    if (!domOk) missing.push("cross_context");
  } else if (newStatus === "verified") {
    const evOk = evidenceCount >= config.minEvidenceForVerified;
    checks.push({
      key: "evidence_count",
      required: `>= ${config.minEvidenceForVerified}`,
      actual: String(evidenceCount),
      passed: evOk,
    });
    if (!evOk) missing.push("evidence_count");

    const domOk = distinctDomains >= config.minDomainsForVerified;
    checks.push({
      key: "cross_context",
      required: `>= ${config.minDomainsForVerified} domains`,
      actual: String(distinctDomains),
      passed: domOk,
    });
    if (!domOk) missing.push("cross_context");

    const ageOk = ageDays >= config.minStabilityDaysForVerified;
    checks.push({
      key: "time_stability",
      required: `>= ${config.minStabilityDaysForVerified} days`,
      actual: `${ageDays} days`,
      passed: ageOk,
    });
    if (!ageOk) missing.push("time_stability");
  } else if (newStatus === "unverified") {
    // 回退到 unverified：不允许（状态机不允许降级，除非首次设置）
    checks.push({
      key: "state_machine",
      required: "first-time set or no-op",
      actual: fromStatus === undefined ? "first-time" : `from ${fromStatus}`,
      passed: fromStatus === undefined,
    });
    if (fromStatus !== undefined) missing.push("state_machine");
  }

  const eligible = missing.length === 0;

  return {
    engramId,
    fromStatus,
    toStatus: newStatus,
    eligible,
    missing,
    checks,
    evidenceCount,
    distinctDomains,
    ageDays,
  };
}

/** upgradeVerification 结果 */
export interface UpgradeVerificationResult {
  readonly engramId: EngramId;
  readonly previousStatus: VerificationStatus | undefined;
  readonly newStatus: VerificationStatus;
  readonly eligible: boolean;
  readonly applied: boolean;
  readonly checks: readonly ConditionCheck[];
  readonly evidenceAppended: boolean;
  /** evidence 被追加到的 synapse ID 列表（通常 0 或 1 条 derives_from） */
  readonly synapseIds: readonly string[];
  readonly reason: string;
}

/**
 * 升级验证状态（主入口）
 *
 * 行为：
 *   1. 校验 engram 存在
 *   2. 校验状态机合法转移（canTransition）
 *   3. 检查升级条件（除非 force=true）
 *   4. 落盘 verificationStatus
 *   5. 追加 evidence 到所有 derives_from synapse（如果有）
 *
 * @param options.force 强制升级（跳过条件检查，但仍然校验状态机）。用于人工裁决。
 */
export function upgradeVerification(
  repo: EngramRepository,
  engramId: EngramId,
  newStatus: VerificationStatus,
  evidence: UpgradeEvidence,
  options: {
    readonly config?: VerificationConditionConfig;
    readonly nowIso?: string;
    readonly force?: boolean;
  } = {},
): UpgradeVerificationResult {
  if (!repo.exists(engramId)) {
    throw new Error(`Engram not found: ${engramId}`);
  }

  const engram = repo.readEngram(engramId);
  const previousStatus = engram.verificationStatus;

  // 状态机校验
  if (!canTransition(previousStatus, newStatus)) {
    return {
      engramId,
      previousStatus,
      newStatus,
      eligible: false,
      applied: false,
      checks: [
        {
          key: "state_machine",
          required: `legal transition from ${previousStatus ?? "undefined"}`,
          actual: `attempted ${previousStatus ?? "undefined"} → ${newStatus}`,
          passed: false,
        },
      ],
      evidenceAppended: false,
      synapseIds: [],
      reason: `illegal transition: ${previousStatus ?? "undefined"} → ${newStatus}`,
    };
  }

  // 条件检查
  const eligibility = checkUpgradeEligibility(
    repo,
    engramId,
    newStatus,
    evidence,
    options,
  );
  const force = options.force ?? false;

  if (!eligibility.eligible && !force) {
    return {
      engramId,
      previousStatus,
      newStatus,
      eligible: false,
      applied: false,
      checks: eligibility.checks,
      evidenceAppended: false,
      synapseIds: [],
      reason: `conditions not met: ${eligibility.missing.join(", ")}`,
    };
  }

  // 落盘 verificationStatus
  repo.updateVerificationStatus(engramId, newStatus);

  // 追加 evidence 到所有 derives_from synapse（如果有）
  const nowIso = options.nowIso ?? new Date().toISOString();
  const file = repo.readSynapses(engramId);
  const derivesSynapses = file.outgoing.filter(
    (s) => s.kind === "derives_from",
  );

  const synapseIds: string[] = [];
  let evidenceAppended = false;

  for (const syn of derivesSynapses) {
    const tagsSuffix =
      evidence.domainTags && evidence.domainTags.length > 0
        ? ` tags:${evidence.domainTags.join(",")}`
        : "";
    const newEv = {
      description: `[${newStatus}] ${evidence.description}${tagsSuffix}`,
      addedAt: nowIso,
      addedBy: evidence.verifiedBy,
      confidence: evidence.confidence,
    };
    const next = [...syn.evidence, newEv];
    repo.replaceSynapseEvidence(engramId, syn.id, next);
    synapseIds.push(syn.id);
    evidenceAppended = true;
  }

  return {
    engramId,
    previousStatus,
    newStatus,
    eligible: true,
    applied: true,
    checks: eligibility.checks,
    evidenceAppended,
    synapseIds,
    reason: force
      ? `forced upgrade to ${newStatus}`
      : `upgraded to ${newStatus} (evidence=${eligibility.evidenceCount})`,
  };
}

/**
 * 反驳（refute）便捷函数
 *
 * 等同于 upgradeVerification(repo, engramId, 'refuted', evidence)，
 * 但允许从任何状态跳转。
 */
export function refuteEngram(
  repo: EngramRepository,
  engramId: EngramId,
  evidence: UpgradeEvidence,
  options: { readonly nowIso?: string; readonly force?: boolean } = {},
): UpgradeVerificationResult {
  return upgradeVerification(repo, engramId, "refuted", evidence, options);
}

/**
 * 批量查询一组 engram 的验证状态摘要
 *
 * 用于统计 / dashboard。
 */
export interface VerificationStatusSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<VerificationStatus, number>>;
  readonly refutedCount: number;
  readonly verifiedCount: number;
}

export function summarizeVerificationStatus(
  repo: EngramRepository,
): VerificationStatusSummary {
  const byStatus: Record<VerificationStatus, number> = {
    unverified: 0,
    plausible: 0,
    probable: 0,
    verified: 0,
    refuted: 0,
  };
  let total = 0;

  for (const entry of repo.listEngrams()) {
    const engram = repo.readEngram(entry.id);
    const status = engram.verificationStatus ?? "unverified";
    byStatus[status] += 1;
    total += 1;
  }

  return {
    total,
    byStatus,
    refutedCount: byStatus.refuted,
    verifiedCount: byStatus.verified,
  };
}
