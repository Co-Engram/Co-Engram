/**
 * LTP/LTD 强化机制配置
 *
 * Hebbian 原则："一起激活的神经元连接增强"
 * LTP（Long-Term Potentiation）：有效检索 → importance 增强
 * LTD（Long-Term Depression）：失败使用 → importance 削弱
 *
 * spec 6.2 默认值：
 *   - 每次 effective=1 的检索 → importance += 0.02（10 次从 0.5 → 0.7）
 *   - 邻居强化系数：0.5（直接邻居得到一半增益）
 *   - LTD 单次惩罚：0.03（略大于 LTP 增益，符合"失败比成功更显著"的神经科学规律）
 *
 * @module @co-engram/core/reinforcement
 */

/** LTP/LTD 参数 */
export interface ReinforcementConfig {
  /** 每次 effective=1 检索的 importance 增益 */
  readonly ltpGain: number;
  /** 每次失败使用的 importance 削弱（绝对值） */
  readonly ltdPenalty: number;
  /** Hebbian 邻居强化系数 ∈ [0,1] */
  readonly hebbianRatio: number;
  /** 失败累积阈值：超过此值后额外惩罚 */
  readonly failureThreshold: number;
  /** 阈值之上的额外惩罚倍率 */
  readonly failureEscalation: number;
}

/** 默认配置（spec 6.2） */
export const DEFAULT_CONFIG: ReinforcementConfig = {
  ltpGain: 0.02,
  ltdPenalty: 0.03,
  hebbianRatio: 0.5,
  failureThreshold: 3,
  failureEscalation: 1.5,
};

/**
 * 校验配置合法性
 */
export function validateConfig(config: ReinforcementConfig): void {
  if (config.ltpGain <= 0 || config.ltpGain > 1) {
    throw new Error(`ltpGain must be in (0,1], got ${config.ltpGain}`);
  }
  if (config.ltdPenalty <= 0 || config.ltdPenalty > 1) {
    throw new Error(`ltdPenalty must be in (0,1], got ${config.ltdPenalty}`);
  }
  if (config.hebbianRatio < 0 || config.hebbianRatio > 1) {
    throw new Error(
      `hebbianRatio must be in [0,1], got ${config.hebbianRatio}`,
    );
  }
  if (config.failureThreshold < 1) {
    throw new Error(
      `failureThreshold must be >= 1, got ${config.failureThreshold}`,
    );
  }
  if (config.failureEscalation < 1) {
    throw new Error(
      `failureEscalation must be >= 1, got ${config.failureEscalation}`,
    );
  }
}
