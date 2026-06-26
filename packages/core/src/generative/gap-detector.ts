/**
 * 主动缺口检测（spec §5.3 机制 2，P3 4.2）
 *
 * 识别"不知道什么"——主动报告知识库中的结构性缺陷：
 *
 * 缺口类型：
 *   1. missing_evidence: fact/hypothesis/pattern engram 的 derives_from
 *      synapse 数量 < 阈值（证据不足）
 *   2. missing_procedure: 某 domain 有 ≥ N 个 observation/fact 但 0 个 procedure
 *      （有认知但无可执行流程）
 *   3. missing_contradiction: 高 importance 的 engram 没有任何 contradicts
 *      synapse（缺乏反例验证 → 确认偏误风险）
 *   4. orphan_engram: 无任何 synapse 连接的 active engram（孤立知识）
 *   5. stale_active: freshness='stale' 但 status='active'（可能过时）
 *
 * 上层可基于 gaps 主动触发：
 *   - 生成 hypothesis 填补缺口
 *   - 提示团队验证高 importance 的 engram
 *   - 把 orphan 纳入 dreaming consolidation
 *   - 把 stale_active engram 归档或重新激活
 *
 * @module @co-engram/core/generative
 */

import type { EngramRepository } from "../storage/repository.js";
import type { Engram, EngramKind } from "../types/engram.js";

/** 缺口类型 */
export type GapType =
  | "missing_evidence"
  | "missing_procedure"
  | "missing_contradiction"
  | "orphan_engram"
  | "stale_active";

/** 严重度 */
export type GapSeverity = "low" | "medium" | "high";

/** 单条知识缺口 */
export interface KnowledgeGap {
  readonly type: GapType;
  /** 相关 domainTags（missing_procedure 时表示缺口所在 domain） */
  readonly domainTags?: readonly string[];
  /** 描述（人类可读） */
  readonly description: string;
  /** 相关 engram ID */
  readonly relatedEngramIds: readonly string[];
  /** 严重度（high=急需处理，low=可选） */
  readonly severity: GapSeverity;
  /** 修复建议 */
  readonly suggestion: string;
}

/** 缺口检测配置 */
export interface GapDetectionConfig {
  /** fact 的最少 evidence 数（默认 2） */
  readonly minEvidenceForFact: number;
  /** hypothesis 的最少 evidence 数（默认 3） */
  readonly minEvidenceForHypothesis: number;
  /** pattern 的最少 evidence 数（默认 3） */
  readonly minEvidenceForPattern: number;
  /** 缺失 procedure 阈值：domain 中 ≥ 此值的 obs/fact 但 0 procedure（默认 5） */
  readonly missingProcedureThreshold: number;
  /** 缺失 contradicts 的 importance 下限（默认 0.7） */
  readonly missingContradictionImportance: number;
  /** 是否检测 orphan（默认 true） */
  readonly includeOrphans: boolean;
  /** 是否检测 stale_active（默认 true） */
  readonly includeStaleActive: boolean;
}

export const DEFAULT_GAP_CONFIG: GapDetectionConfig = {
  minEvidenceForFact: 2,
  minEvidenceForHypothesis: 3,
  minEvidenceForPattern: 3,
  missingProcedureThreshold: 5,
  missingContradictionImportance: 0.7,
  includeOrphans: true,
  includeStaleActive: true,
};

/** 检测结果 */
export interface DetectGapsResult {
  readonly gaps: readonly KnowledgeGap[];
  readonly summary: {
    readonly totalGaps: number;
    readonly byType: Record<GapType, number>;
  };
}

/**
 * 主动检测知识缺口
 *
 * @param repo Repository
 * @param options.config 部分覆盖默认配置
 * @param options.domainTags 限定域（只在这些 domainTags 范围内检测）
 */
export function detectKnowledgeGaps(
  repo: EngramRepository,
  options: {
    readonly config?: Partial<GapDetectionConfig>;
    readonly domainTags?: readonly string[];
  } = {},
): DetectGapsResult {
  const cfg: GapDetectionConfig = { ...DEFAULT_GAP_CONFIG, ...options.config };
  const filterDomains = options.domainTags;

  // 一次性加载所有 active engram
  const allEngrams: Engram[] = [];
  for (const entry of repo.listEngrams()) {
    const engram = repo.readEngram(entry.id);
    if (engram.status !== "active") continue;
    if (filterDomains && filterDomains.length > 0) {
      const hasOverlap = filterDomains.some((t) =>
        engram.domainTags.includes(t),
      );
      if (!hasOverlap) continue;
    }
    allEngrams.push(engram);
  }

  // 收集每个 engram 的 synapse 信息
  const synapseInfo = new Map<
    string,
    {
      outgoingCount: number;
      incomingCount: number;
      derivesFromCount: number;
      contradictsIncoming: number;
      contradictsOutgoing: number;
      similarToCount: number;
    }
  >();

  for (const engram of allEngrams) {
    const file = repo.readSynapses(engram.id);
    const outgoing = file.outgoing;
    const derivesFromCount = outgoing.filter(
      (s) => s.kind === "derives_from",
    ).length;
    const contradictsOutgoing = outgoing.filter(
      (s) => s.kind === "contradicts",
    ).length;
    const similarToCount = outgoing.filter(
      (s) => s.kind === "similar_to",
    ).length;
    synapseInfo.set(engram.id, {
      outgoingCount: outgoing.length,
      incomingCount: engram.incomingSynapseCount,
      derivesFromCount,
      contradictsIncoming: 0, // 稍后扫描所有 synapse 填充
      contradictsOutgoing,
      similarToCount,
    });
  }

  // 第二轮扫描：填充 contradictsIncoming（来自其他 engram 的 contradicts 出边）
  for (const engram of allEngrams) {
    const file = repo.readSynapses(engram.id);
    for (const syn of file.outgoing) {
      if (syn.kind !== "contradicts") continue;
      const target = synapseInfo.get(syn.to);
      if (target) {
        target.contradictsIncoming += 1;
      }
    }
  }

  const gaps: KnowledgeGap[] = [];

  // === 1. missing_evidence ===
  for (const engram of allEngrams) {
    const info = synapseInfo.get(engram.id)!;
    const minEvidence = getMinEvidence(engram.kind, cfg);
    if (minEvidence === null) continue;
    if (info.derivesFromCount < minEvidence) {
      gaps.push({
        type: "missing_evidence",
        domainTags: [...engram.domainTags],
        description: `${engram.kind} "${engram.title}" 只有 ${info.derivesFromCount} 个 derives_from evidence（建议 ≥ ${minEvidence}）`,
        relatedEngramIds: [engram.id],
        severity: severityForEvidence(
          engram.kind,
          info.derivesFromCount,
          minEvidence,
        ),
        suggestion: `补充更多 observation 作为 ${engram.kind} 的来源（derives_from synapse）`,
      });
    }
  }

  // === 2. missing_procedure ===
  const domainKinds = new Map<
    string,
    { observations: number; facts: number; procedures: number }
  >();
  for (const engram of allEngrams) {
    for (const domain of engram.domainTags) {
      const entry = domainKinds.get(domain) ?? {
        observations: 0,
        facts: 0,
        procedures: 0,
      };
      if (engram.kind === "observation") entry.observations += 1;
      else if (engram.kind === "fact") entry.facts += 1;
      else if (engram.kind === "procedure") entry.procedures += 1;
      domainKinds.set(domain, entry);
    }
  }
  for (const [domain, counts] of domainKinds) {
    const totalObsFact = counts.observations + counts.facts;
    if (
      totalObsFact >= cfg.missingProcedureThreshold &&
      counts.procedures === 0
    ) {
      gaps.push({
        type: "missing_procedure",
        domainTags: [domain],
        description: `domain "${domain}" 有 ${totalObsFact} 个 observation/fact 但 0 个 procedure`,
        relatedEngramIds: collectDomainEngramIds(allEngrams, domain),
        severity:
          totalObsFact >= cfg.missingProcedureThreshold * 2 ? "high" : "medium",
        suggestion: `从现有 observation/fact 抽象出可执行 procedure（考虑触发 REM consolidation 或人工编写）`,
      });
    }
  }

  // === 3. missing_contradiction ===
  for (const engram of allEngrams) {
    if (engram.importance < cfg.missingContradictionImportance) continue;
    // 只关注 fact/pattern/hypothesis（observation 反例少是常态）
    if (
      engram.kind !== "fact" &&
      engram.kind !== "pattern" &&
      engram.kind !== "hypothesis"
    )
      continue;
    const info = synapseInfo.get(engram.id)!;
    const hasContradiction =
      info.contradictsIncoming > 0 || info.contradictsOutgoing > 0;
    if (!hasContradiction) {
      gaps.push({
        type: "missing_contradiction",
        domainTags: [...engram.domainTags],
        description: `高重要性 ${engram.kind} "${engram.title}"（importance=${engram.importance.toFixed(2)}）无任何 contradicts 对照`,
        relatedEngramIds: [engram.id],
        severity: engram.importance >= 0.9 ? "high" : "medium",
        suggestion: `主动寻找反例（contradicts synapse）以避免确认偏误；触发 hypothesis 验证流程`,
      });
    }
  }

  // === 4. orphan_engram ===
  if (cfg.includeOrphans) {
    for (const engram of allEngrams) {
      const info = synapseInfo.get(engram.id)!;
      if (info.outgoingCount === 0 && info.incomingCount === 0) {
        gaps.push({
          type: "orphan_engram",
          domainTags: [...engram.domainTags],
          description: `孤立 engram "${engram.title}" 无任何 synapse 连接`,
          relatedEngramIds: [engram.id],
          severity: "low",
          suggestion: `加入 dreaming consolidation 或人工建立 similar_to/extends 连接`,
        });
      }
    }
  }

  // === 5. stale_active ===
  if (cfg.includeStaleActive) {
    for (const engram of allEngrams) {
      if (engram.freshness === "stale" && engram.status === "active") {
        gaps.push({
          type: "stale_active",
          domainTags: [...engram.domainTags],
          description: `${engram.kind} "${engram.title}" 已 stale 但仍 active（可能过时）`,
          relatedEngramIds: [engram.id],
          severity: engram.importance >= 0.7 ? "medium" : "low",
          suggestion: `触发 recompute_importance 或归档（archive），或重新激活（reinforce）`,
        });
      }
    }
  }

  // 汇总
  const byType: Record<GapType, number> = {
    missing_evidence: 0,
    missing_procedure: 0,
    missing_contradiction: 0,
    orphan_engram: 0,
    stale_active: 0,
  };
  for (const g of gaps) {
    byType[g.type] += 1;
  }

  // 排序：severity 高 → 低；同 severity 按 type 字典序
  const severityOrder: Record<GapSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  gaps.sort((a, b) => {
    const sa = severityOrder[a.severity];
    const sb = severityOrder[b.severity];
    if (sa !== sb) return sa - sb;
    return a.type < b.type ? -1 : 1;
  });

  return {
    gaps,
    summary: {
      totalGaps: gaps.length,
      byType,
    },
  };
}

// ============================================================
// 辅助函数
// ============================================================

function getMinEvidence(
  kind: EngramKind,
  cfg: GapDetectionConfig,
): number | null {
  switch (kind) {
    case "fact":
      return cfg.minEvidenceForFact;
    case "hypothesis":
      return cfg.minEvidenceForHypothesis;
    case "pattern":
      return cfg.minEvidenceForPattern;
    default:
      return null;
  }
}

function severityForEvidence(
  kind: EngramKind,
  current: number,
  min: number,
): GapSeverity {
  void kind;
  // 0 个 evidence → high；不足但 > 0 → medium；满足（不报告）
  if (current === 0) return "high";
  if (current < min) return "medium";
  return "low";
}

function collectDomainEngramIds(
  engrams: readonly Engram[],
  domain: string,
): string[] {
  return engrams
    .filter((e) => e.domainTags.includes(domain))
    .map((e) => e.id)
    .sort();
}
