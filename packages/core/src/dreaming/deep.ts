/**
 * Deep Dreaming（慢波睡眠巩固：整合 + 归档 + 遗忘）
 *
 * 神经科学依据：慢波睡眠期间，海马与皮层协同完成记忆巩固——
 * 重要痕迹被强化，陈旧痕迹被归档或遗忘，为新的学习腾出空间。
 *
 * 实现（spec §5.2）：
 *   - 调用 Light Dreaming 清理重复
 *   - 调用 Decay 批量归档/遗忘
 *   - 调用 Trash Sweep 把长期 forgotten 的 engram 移入 .trash/
 *   - 返回整合统计
 *
 * REM Dreaming（跨情境抽象）留 P2。
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramRepository } from "../storage/repository.js";
import {
  applyDecayBatch,
  type DecayOptions,
  type DecayResult,
} from "./decay.js";
import {
  runLightDreaming,
  type LightDreamingOptions,
  type LightDreamingResult,
} from "./light.js";
import {
  sweepToTrash,
  type TrashOptions,
  type TrashSweepResult,
} from "./trash.js";

export interface DeepDreamingOptions {
  readonly light?: LightDreamingOptions;
  readonly decay?: DecayOptions;
  /** Trash sweep 配置。undefined → 跳过 sweep；{} → 启用并用默认值 */
  readonly trash?: TrashOptions;
  /** 跳过 light 阶段（只跑 decay + trash） */
  readonly skipLight?: boolean;
  /** 跳过 decay 阶段（只跑 light + trash） */
  readonly skipDecay?: boolean;
  /** 跳过 trash 阶段 */
  readonly skipTrash?: boolean;
}

export interface DeepDreamingResult {
  readonly light: LightDreamingResult | null;
  readonly decay: DecayResult | null;
  readonly trash: TrashSweepResult | null;
}

/**
 * 执行 Deep Dreaming
 *
 * 默认顺序：先 light（清理重复）→ 再 decay（归档/遗忘陈旧）→ 最后 trash（移入回收站）。
 * 这样 decay 阶段扫描的 engram 数更少,且 trash 能立刻处理本次刚被遗忘的陈旧 engram。
 *
 * 注意：trash 默认不开启（需要显式传 options.trash 或 MaintenanceConfig.trash.enabled=true）,
 * 因为 sweep 涉及跨目录移动,属可观测的副作用。
 */
export function runDeepDreaming(
  repo: EngramRepository,
  options: DeepDreamingOptions = {},
): DeepDreamingResult {
  const light = options.skipLight
    ? null
    : runLightDreaming(repo, options.light ?? {});

  const decay = options.skipDecay
    ? null
    : applyDecayBatch(repo, options.decay ?? {});

  const trash =
    options.skipTrash || options.trash === undefined
      ? null
      : sweepToTrash(repo, options.trash);

  return { light, decay, trash };
}
