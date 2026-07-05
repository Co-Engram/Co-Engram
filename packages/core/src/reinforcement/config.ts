/**
 * LTP/LTD 强化机制配置
 *
 * Importance 动态化(D1)之后,单次强化/惩罚的数值由 `importance/dynamics.ts`
 * 统一治理(`updateOnReinforce` / `updateOnReportFailure`),本配置只保留
 * Hebbian 邻居联动比例与降级建议阈值,不再硬编码 ltpGain / ltdPenalty /
 * failureThreshold / failureEscalation。
 *
 * spec 6.2 默认值:
 *   - hebbianRatio = 0.5(直接邻居得到一半增益)
 *   - archiveThreshold = 3(失败累积达到 3 次建议 archive)
 *   - forgetThreshold = 5(失败累积达到 5 次建议 forget)
 *
 * @module @co-engram/core/reinforcement
 */

/** LTP/LTD 参数(importance 增量由 dynamics.ts 计算) */
export interface ReinforcementConfig {
  /** Hebbian 邻居强化系数 ∈ [0,1] */
  readonly hebbianRatio: number;
  /** 触发 archive 建议的 failedUses 阈值 */
  readonly archiveThreshold: number;
  /** 触发 forget 建议的 failedUses 阈值 */
  readonly forgetThreshold: number;
}

/** 默认配置(spec 6.2 + D1) */
export const DEFAULT_CONFIG: ReinforcementConfig = {
  hebbianRatio: 0.5,
  archiveThreshold: 3,
  forgetThreshold: 5,
};

/**
 * 校验配置合法性
 */
export function validateConfig(config: ReinforcementConfig): void {
  if (config.hebbianRatio < 0 || config.hebbianRatio > 1) {
    throw new Error(
      `hebbianRatio must be in [0,1], got ${config.hebbianRatio}`,
    );
  }
  if (config.archiveThreshold < 1) {
    throw new Error(
      `archiveThreshold must be >= 1, got ${config.archiveThreshold}`,
    );
  }
  if (config.forgetThreshold < config.archiveThreshold) {
    throw new Error(
      `forgetThreshold must be >= archiveThreshold (${config.archiveThreshold}), got ${config.forgetThreshold}`,
    );
  }
}
