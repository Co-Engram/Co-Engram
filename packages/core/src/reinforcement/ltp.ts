/**
 * LTP（Long-Term Potentiation）- 有效检索强化
 *
 * 神经科学依据：海马 LTP，重复激活的突触连接增强。
 * 业务含义：engram 被实际使用并证明有效 → importance 提升。
 *
 * 触发场景：
 *   - 工具调用结果被用户采纳
 *   - LLM 引用后给出正面反馈
 *   - 同样的 engram 被多次有效检索
 *
 * 实现(importance 增量由 `importance/dynamics.ts` 单一来源计算):
 *   - effectiveRetrievals += 1
 *   - retrievalCount += 1
 *   - reinforcementScore += effectiveness
 *   - importance = dynamics.updateOnReinforce(current, effectiveness)(clamp [0,1])
 *   - lastEffectiveAt = now
 *
 * @module @co-engram/core/reinforcement
 */

import type { EngramRepository } from "../storage/repository.js";
import type { Engram } from "../types/engram.js";
import { updateOnReinforce } from "../importance/dynamics.js";
import { DEFAULT_CONFIG, type ReinforcementConfig } from "./config.js";
import { notFoundError, validationError } from "../tools/error-schema.js";

export interface LtpResult {
  readonly id: string;
  readonly importanceDelta: number;
  readonly importance: number;
  readonly retrievalCount: number;
  readonly effectiveRetrievals: number;
  readonly reinforcementScore: number;
  readonly lastEffectiveAt: string;
}

/**
 * 记录一次有效检索（LTP 强化）
 *
 * 注意：本函数只更新统计 + importance，
 * Hebbian 邻居强化请用 reinforceRelated()（related.ts）。
 *
 * importance 增量委托 `dynamics.updateOnReinforce` 计算,本函数不再读
 * `config.ltpGain`(D1 之后该字段已删除)。
 *
 * @param repo - 仓库
 * @param id - 目标 engram id
 * @param effectiveness - 有效性 [0,1]，1=完全有效
 * @param _config - 保留参数(签名兼容);importance 增量由 dynamics 单一来源决定
 * @param nowIso - 当前时间（测试用，默认 new Date()）
 */
export function recordRetrievalSuccess(
  repo: EngramRepository,
  id: string,
  effectiveness: number,
  _config: ReinforcementConfig = DEFAULT_CONFIG,
  nowIso: string = new Date().toISOString(),
): LtpResult {
  if (effectiveness < 0 || effectiveness > 1) {
    throw validationError(`effectiveness must be in [0,1], got ${effectiveness}`);
  }
  if (!repo.exists(id)) {
    throw notFoundError("Engram", id);
  }
  const current = repo.readEngram(id).importance;
  const next = updateOnReinforce(current, effectiveness);
  const importanceDelta = next - current;
  repo.bumpRetrievalStats(id, {
    retrievedDelta: 1,
    effectiveDelta: 1,
    reinforcementDelta: effectiveness,
    importanceDelta,
    lastRetrievedAt: nowIso,
    lastEffectiveAt: nowIso,
  });
  const updated = repo.readEngram(id);
  return {
    id,
    importanceDelta,
    importance: updated.importance,
    retrievalCount: updated.retrievalCount,
    effectiveRetrievals: updated.effectiveRetrievals,
    reinforcementScore: updated.reinforcementScore,
    lastEffectiveAt: updated.lastEffectiveAt ?? nowIso,
  };
}

/**
 * 强化 engram（不更新 retrieval 统计，只提升 importance）
 *
 * 用于 Hebbian 间接强化（邻居得到增益时），
 * 或外部队列触发的批量强化（如 Dreaming 周期）。
 *
 * D1 之后:`amount` 默认被当作 effectiveness 委托给 `dynamics.updateOnReinforce`,
 * importance 增量 = dynamics(current, amount) - current。
 *
 * 但 Hebbian 邻居联动(`reinforceRelated`)传入的是源 engram 经 dynamics 算出的
 * 实际 importanceDelta × hebbianRatio,这已经是"目标 importance 增量",不应再次
 * 经 dynamics 缩放。`options.asImportanceDelta = true` 让函数跳过 dynamics 转换,
 * 直接把 `amount` 当作 importanceDelta 累加(保持 Hebbian 邻居得到 50% 源 delta 的语义)。
 *
 * P0-9 修复:Hebbian 邻居联动此前是"幽灵强化" —— 只改 importance,但
 * effectiveRetrievals / retrievalCount / reinforcementScore 全为 0,且
 * audit_log 无任何 reinforce 记录。新增 `withStats` 选项让邻居联动也走
 * 完整统计更新(语义上,邻居被"间接有效检索")。
 */
export function reinforceEngram(
  repo: EngramRepository,
  id: string,
  amount: number,
  nowIso: string = new Date().toISOString(),
  options: {
    /**
     * 是否同时更新 retrievalCount/effectiveRetrievals/reinforcementScore。
     * 默认 false(向后兼容:Dreaming 周期批量强化不应污染检索统计)。
     * Hebbian 邻居联动应传 true(P0-9:让邻居统计字段可观察)。
     */
    readonly withStats?: boolean;
    /** 邻居联动的 effectiveness 值(默认 = amount,即把 importance 增益视作 effectiveness) */
    readonly effectiveness?: number;
    /**
     * D1 Hebbian 路径专用:把 `amount` 当作已经计算好的 importanceDelta
     * 直接累加,不再经 dynamics.updateOnReinforce 缩放。源 engram 的 delta
     * 已经走过 dynamics,邻居按 hebbianRatio 分摊的部分应保持等比例,不应
     * 再次"effectiveness → delta"转换。
     */
    readonly asImportanceDelta?: boolean;
  } = {},
): { id: string; importanceDelta: number; importance: number } {
  if (!repo.exists(id)) {
    throw notFoundError("Engram", id);
  }
  if (amount < 0) {
    throw validationError(`amount must be >= 0, got ${amount}`);
  }
  const withStats = options.withStats ?? false;
  const effectiveness = options.effectiveness ?? amount;
  const asImportanceDelta = options.asImportanceDelta ?? false;
  const current = repo.readEngram(id).importance;
  const importanceDelta = asImportanceDelta
    ? amount
    : updateOnReinforce(current, amount) - current;
  if (withStats) {
    repo.bumpRetrievalStats(id, {
      retrievedDelta: 1,
      effectiveDelta: 1,
      reinforcementDelta: effectiveness,
      importanceDelta,
      lastRetrievedAt: nowIso,
      lastEffectiveAt: nowIso,
    });
  } else {
    repo.bumpRetrievalStats(id, {
      importanceDelta,
      lastEffectiveAt: nowIso,
    });
  }
  const updated = repo.readEngram(id);
  return {
    id,
    importanceDelta,
    importance: updated.importance,
  };
}

/**
 * 计算强化 N 次后的预期 importance（不写盘）
 *
 * 用于规划/模拟：例如想知道"再强化 5 次 importance 会到多少"。
 * D1 之后:循环调 `dynamics.updateOnReinforce`,与实际写入路径一致。
 */
export function projectImportance(
  engram: Engram,
  times: number,
  effectivenessPerUse = 1,
  _config: ReinforcementConfig = DEFAULT_CONFIG,
): number {
  let importance = engram.importance;
  for (let i = 0; i < times; i++) {
    importance = updateOnReinforce(importance, effectivenessPerUse);
    if (importance >= 1) return 1;
  }
  return Math.min(1, importance);
}
