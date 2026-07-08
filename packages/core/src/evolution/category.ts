/**
 * 类别进化（spec §5.1 进化链 + §3.2 CategoryEvolutionTrail）
 *
 * 进化路径：
 *   observation → fact → pattern → procedure → (skill suggest → skill auto)
 *
 * 触发条件：
 *   - observation → fact: evidenceCount ≥ 阈值（多次独立验证）
 *   - fact → pattern: 跨情境抽象（REM 做梦触发，kind 已是 pattern 不重复升级）
 *   - pattern → procedure: 高 effectiveRetrievals + 显式流程化标记
 *   - procedure → skill: 由 Skill 系统处理（不在本模块）
 *
 * Trail 记录：
 *   - originalKind（创建时的 kind）
 *   - currentKind（当前 kind）
 *   - transitions: [{ from, to, at, evidence, reason }]
 *
 * 多标签 kinds：
 *   - 同一 engram 可以同时属于多个 kind（如 ['fact', 'pattern']）
 *   - primary kind 决定 UI 颜色，secondary kinds 作为补充
 *
 * @module @co-engram/core/evolution
 */

import type { EngramKind } from "../types/engram.js";
import type { EngramRepository } from "../storage/repository.js";

// ============================================================
// 进化链定义
// ============================================================

/** 完整进化链顺序（spec §5.1） */
export const EVOLUTION_CHAIN: readonly EngramKind[] = [
  "observation",
  "fact",
  "pattern",
  "procedure",
  // hypothesis 是旁路（不直接进化为 procedure）
] as const;

/** 升级合法性表（A → B 是否允许） */
export interface AllowedUpgrade {
  readonly from: EngramKind;
  readonly to: EngramKind;
}

export const ALLOWED_UPGRADES: readonly AllowedUpgrade[] = [
  { from: "observation", to: "fact" },
  { from: "fact", to: "pattern" },
  { from: "pattern", to: "procedure" },
  { from: "observation", to: "pattern" }, // 跳级（高置信度时）
  { from: "observation", to: "procedure" }, // 跳级
  { from: "fact", to: "procedure" }, // 跳级
  { from: "hypothesis", to: "fact" }, // 假设验证为事实
  { from: "hypothesis", to: "pattern" },
];

// ============================================================
// Trail 数据结构
// ============================================================

export interface CategoryTransition {
  readonly from: EngramKind;
  readonly to: EngramKind;
  readonly at: string;
  readonly reason: string;
  /** 触发证据（如 "evidenceCount=5", "REM dream cluster"） */
  readonly evidence: string;
  readonly upgradedBy: string;
}

export interface CategoryEvolutionTrail {
  readonly originalKind: EngramKind;
  readonly currentKind: EngramKind;
  readonly transitions: readonly CategoryTransition[];
}

// ============================================================
// 升级条件
// ============================================================

export interface UpgradeConditions {
  /** observation → fact 需要的最小 evidenceCount（默认 3） */
  readonly observationToFactEvidence?: number;
  /** fact → pattern 需要的最小 effectiveRetrievals（默认 5） */
  readonly factToPatternEffective?: number;
  /** pattern → procedure 需要的最小 effectiveRetrievals（默认 10） */
  readonly patternToProcedureEffective?: number;
}

export const DEFAULT_UPGRADE_CONDITIONS: UpgradeConditions = {
  observationToFactEvidence: 3,
  factToPatternEffective: 5,
  patternToProcedureEffective: 10,
};

export interface UpgradeAssessment {
  readonly canUpgrade: boolean;
  readonly fromKind: EngramKind;
  readonly targetKind?: EngramKind;
  readonly reason: string;
  /** 满足度（0~1，1=完全满足） */
  readonly readiness: number;
}

/**
 * 评估当前 engram 是否可以升级
 */
export function assessUpgrade(
  engram: {
    readonly kind: EngramKind;
    readonly kinds: readonly EngramKind[];
    readonly effectiveRetrievals: number;
    readonly retrievalCount: number;
    readonly incomingSynapseCount: number;
  },
  conditions: UpgradeConditions = DEFAULT_UPGRADE_CONDITIONS,
): UpgradeAssessment {
  const currentKind = engram.kind;

  // hypothesis → fact（如果 evidence 充分）
  if (currentKind === "hypothesis") {
    return {
      canUpgrade: true,
      fromKind: currentKind,
      targetKind: "fact",
      reason: "hypothesis verified",
      readiness: 1,
    };
  }

  if (currentKind === "observation") {
    const needed = conditions.observationToFactEvidence ?? 3;
    // evidenceCount 用 incomingSynapseCount（exemplifies/derives_from 作为证据）
    const evidenceCount = engram.incomingSynapseCount;
    if (evidenceCount >= needed) {
      return {
        canUpgrade: true,
        fromKind: currentKind,
        targetKind: "fact",
        reason: `evidenceCount=${evidenceCount} ≥ ${needed}`,
        readiness: Math.min(1, evidenceCount / needed),
      };
    }
    return {
      canUpgrade: false,
      fromKind: currentKind,
      reason: `evidenceCount=${evidenceCount} < ${needed}`,
      readiness: evidenceCount / needed,
    };
  }

  if (currentKind === "fact") {
    const needed = conditions.factToPatternEffective ?? 5;
    if (engram.effectiveRetrievals >= needed) {
      return {
        canUpgrade: true,
        fromKind: currentKind,
        targetKind: "pattern",
        reason: `effectiveRetrievals=${engram.effectiveRetrievals} ≥ ${needed}`,
        readiness: Math.min(1, engram.effectiveRetrievals / needed),
      };
    }
    return {
      canUpgrade: false,
      fromKind: currentKind,
      reason: `effectiveRetrievals=${engram.effectiveRetrievals} < ${needed}`,
      readiness: engram.effectiveRetrievals / needed,
    };
  }

  if (currentKind === "pattern") {
    const needed = conditions.patternToProcedureEffective ?? 10;
    if (engram.effectiveRetrievals >= needed) {
      return {
        canUpgrade: true,
        fromKind: currentKind,
        targetKind: "procedure",
        reason: `effectiveRetrievals=${engram.effectiveRetrievals} ≥ ${needed}`,
        readiness: Math.min(1, engram.effectiveRetrievals / needed),
      };
    }
    return {
      canUpgrade: false,
      fromKind: currentKind,
      reason: `effectiveRetrievals=${engram.effectiveRetrievals} < ${needed}`,
      readiness: engram.effectiveRetrievals / needed,
    };
  }

  // procedure → skill 不在本模块
  return {
    canUpgrade: false,
    fromKind: currentKind,
    reason: "已达到本模块进化的最高级（procedure → skill 由 Skill 系统处理）",
    readiness: 0,
  };
}

// ============================================================
// 升级操作
// ============================================================

export interface UpgradeKindInput {
  readonly id: string;
  readonly newKind: EngramKind;
  readonly reason: string;
  readonly evidence?: string;
  readonly upgradedBy: string;
  /** 是否同时加入 kinds 多标签（默认 true） */
  readonly keepOldKinds?: boolean;
  readonly nowIso?: string;
}

export interface UpgradeKindResult {
  readonly id: string;
  readonly previousKind: EngramKind;
  readonly newKind: EngramKind;
  readonly trail: CategoryEvolutionTrail;
  readonly transition: CategoryTransition;
}

/**
 * 校验升级是否合法（按 ALLOWED_UPGRADES 表）
 */
export function isUpgradeAllowed(from: EngramKind, to: EngramKind): boolean {
  if (from === to) return false;
  return ALLOWED_UPGRADES.some((u) => u.from === from && u.to === to);
}

/**
 * 手动升级 kind（带 trail 记录）
 *
 * 注意：本函数只更新 kind/kinds 字段；trail 持久化需要调用方处理（P2 暂存在内存返回值）。
 */
export function upgradeEngramKind(
  repo: EngramRepository,
  input: UpgradeKindInput,
): UpgradeKindResult {
  if (!repo.exists(input.id)) {
    throw new Error(`Engram not found: ${input.id}`);
  }
  const old = repo.readEngram(input.id);
  if (!isUpgradeAllowed(old.kind, input.newKind)) {
    throw new Error(
      `Upgrade not allowed: ${old.kind} → ${input.newKind}. Allowed upgrades: see ALLOWED_UPGRADES.`,
    );
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  const keepOld = input.keepOldKinds ?? true;

  // 构造新 kinds：newKind 放第一位（repository 用 kinds[0] 作为 kind 字段）
  const oldKinds = [...old.kinds];
  const filteredOld = oldKinds.filter((k) => k !== input.newKind);
  const newKinds = keepOld ? [input.newKind, ...filteredOld] : [input.newKind];

  repo.updateEngram(input.id, {
    kinds: newKinds,
    updatedBy: input.upgradedBy,
  });

  const transition: CategoryTransition = {
    from: old.kind,
    to: input.newKind,
    at: nowIso,
    reason: input.reason,
    evidence: input.evidence ?? "manual upgrade",
    upgradedBy: input.upgradedBy,
  };

  // trail 构造（P2 暂不持久化，返回给调用方）
  const existingTransitions = extractTransitionsFromKinds(oldKinds, old.kind);
  const trail: CategoryEvolutionTrail = {
    originalKind: existingTransitions[0]?.from ?? old.kind,
    currentKind: input.newKind,
    transitions: [...existingTransitions, transition],
  };

  return {
    id: input.id,
    previousKind: old.kind,
    newKind: input.newKind,
    trail,
    transition,
  };
}

/**
 * 从 engram.kinds 推断历史 transitions（无持久化时的启发式）
 *
 * kinds 数组按"最新在前"保留：[newest, ..., oldest]
 * 例如 ['pattern', 'fact', 'observation'] → [{observation→fact}, {fact→pattern}]
 */
function extractTransitionsFromKinds(
  kinds: readonly EngramKind[],
  currentKind: EngramKind,
): CategoryTransition[] {
  if (kinds.length === 0) {
    return [];
  }
  const result: CategoryTransition[] = [];
  // 从最旧（数组末尾）向最新（数组开头）构造 transition 链
  for (let i = kinds.length - 1; i > 0; i--) {
    result.push({
      from: kinds[i]!,
      to: kinds[i - 1]!,
      at: "unknown",
      reason: "inferred from kinds array",
      evidence: "kinds order",
      upgradedBy: "unknown",
    });
  }
  // currentKind 与 kinds[0] 不一致时（理论上不应发生，但防御性处理）
  if (result.length === 0 && currentKind !== kinds[0]) {
    result.push({
      from: kinds[0]!,
      to: currentKind,
      at: "unknown",
      reason: "kind mismatch inferred",
      evidence: "kind field",
      upgradedBy: "unknown",
    });
  }
  return result;
}

// ============================================================
// 批量进化（Deep Dreaming 调用）
// ============================================================

export interface CategoryEvolutionResult {
  readonly scanned: number;
  readonly upgraded: ReadonlyArray<{
    id: string;
    from: EngramKind;
    to: EngramKind;
    reason: string;
  }>;
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
}

/**
 * 扫描所有 active engram，评估是否满足升级条件
 *
 * 注意：高 readiness 但未触发自动升级的会进入 skipped；
 * 完全满足条件时（canUpgrade=true 且 readiness=1）自动升级。
 */
export function runCategoryEvolution(
  repo: EngramRepository,
  options: {
    readonly conditions?: UpgradeConditions;
    readonly upgradedBy?: string;
    readonly nowIso?: string;
    readonly dryRun?: boolean;
  } = {},
): CategoryEvolutionResult {
  const conditions = options.conditions ?? DEFAULT_UPGRADE_CONDITIONS;
  const upgradedBy = options.upgradedBy ?? "category-evolution";
  const nowIso = options.nowIso ?? new Date().toISOString();
  const dryRun = options.dryRun ?? false;

  const upgraded: Array<{
    id: string;
    from: EngramKind;
    to: EngramKind;
    reason: string;
  }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const entries = [...repo.listEngrams()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  // 性能修复(2026-07):消除循环内 readEngram N+1
  const allIds = entries.map((e) => e.id);
  const digestById = new Map(
    repo.readDigestBatch(allIds).map((d) => [d.id, d] as const),
  );

  let scanned = 0;
  for (const entry of entries) {
    const digest = digestById.get(entry.id);
    if (!digest) continue;
    if (digest.status !== "active") continue;
    scanned += 1;

    const assessment = assessUpgrade(
      {
        kind: digest.kind as EngramKind,
        kinds: digest.kinds as readonly EngramKind[],
        effectiveRetrievals: digest.effectiveRetrievals,
        retrievalCount: digest.retrievalCount,
        incomingSynapseCount: digest.incomingSynapseCount,
      },
      conditions,
    );
    if (!assessment.canUpgrade || !assessment.targetKind) {
      skipped.push({ id: digest.id, reason: assessment.reason });
      continue;
    }

    if (!dryRun) {
      try {
        upgradeEngramKind(repo, {
          id: digest.id,
          newKind: assessment.targetKind,
          reason: assessment.reason,
          evidence: `auto: ${assessment.reason}`,
          upgradedBy,
          nowIso,
        });
      } catch (e) {
        skipped.push({
          id: digest.id,
          reason: `upgrade failed: ${(e as Error).message}`,
        });
        continue;
      }
    }
    upgraded.push({
      id: digest.id,
      from: assessment.fromKind,
      to: assessment.targetKind,
      reason: assessment.reason,
    });
  }

  return { scanned, upgraded, skipped };
}
