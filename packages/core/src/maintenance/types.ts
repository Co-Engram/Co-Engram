/**
 * Maintenance 模块类型定义（P4 B.2 + C.2 + D.1）
 *
 * MaintenanceEngine 三阶段配置：
 *   - light: drain signals → extractSignals → applyRpeUpdate（高频,秒/分钟级）
 *   - deep : 复用现有 runDeepDreaming（中频,小时级）
 *   - rem  : runRemDreaming + metacognition（低频,天级）
 *
 * 设计原则：
 *   1. 默认配置合理（可零配置启动）
 *   2. 调度器内化在 engine.start()（setInterval + unref）,不依赖宿主 /loop
 *   3. 三阶段独立触发,可单独调用
 *
 * @module @co-engram/core/maintenance
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SignalSink } from "../signals/types.js";
import type { SignalRule } from "../signals/extract.js";
import type { DreamingScheduler } from "../dreaming/scheduler.js";
import type { EffectivenessTracker } from "../observability/effectiveness-tracker.js";
import { DEFAULT_RPE_LEARNING_RATE } from "../signals/rpe.js";

/** 维护阶段名 */
export type MaintenanceStage = "light" | "deep" | "rem";

/** 维护引擎依赖（注入式,便于测试） */
export interface MaintenanceDeps {
  readonly repository: EngramRepository;
  readonly signalSink: SignalSink;
  /**
   * 复用现有 DreamingScheduler（deep/rem 阶段）。
   * light 阶段不需要它,但 deep/rem 需要。
   */
  readonly dreamingScheduler?: DreamingScheduler;
  /**
   * 有效性追踪器（可选,light 阶段调用 sweepExpired）。
   *
   * 如果注入,每次 light 阶段会扫描超时观察窗口,
   * 把 inconclusive 的 retrieve 信号写入 audit log。
   */
  readonly effectivenessTracker?: EffectivenessTracker;
  /**
   * team-memory 根路径（可选,light 阶段写 prompt-signals.json 用）。
   *
   * 如果注入,每次 light 阶段会扫描所有 engram 的 domainTags,
   * 生成 PromptSignalSnapshot 写入 `<dataRoot>/.co-engram/prompt-signals.json`。
   * promptBuilder 读取这份 snapshot 实现自进化提示词。
   */
  readonly dataRoot?: string;
}

/** 默认配置常量 */
export const DEFAULT_LIGHT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_DEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_REM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_SIGNAL_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** 复用 signals/rpe.ts 的学习率（重导出避免分裂） */
export { DEFAULT_RPE_LEARNING_RATE };

/** 维护引擎配置 */
export interface MaintenanceConfig {
  /** light 阶段调度间隔（默认 5 分钟） */
  readonly lightIntervalMs?: number;
  /** deep 阶段调度间隔（默认 1 小时） */
  readonly deepIntervalMs?: number;
  /** rem 阶段调度间隔（默认 7 天） */
  readonly remIntervalMs?: number;
  /** signals.jsonl 保留时长（默认 7 天） */
  readonly signalPruneAgeMs?: number;
  /** RPE 学习率（默认 0.1） */
  readonly learningRate?: number;
  /** 自定义信号规则（默认 DEFAULT_RULES） */
  readonly rules?: readonly SignalRule[];
  /** sliding window 大小（默认 10） */
  readonly windowSize?: number;
  /** 启用哪些阶段（默认全开） */
  readonly enabledStages?: readonly MaintenanceStage[];
  /** Trash sweep 配置。默认开启 → deep 阶段执行 trash sweep */
  readonly trash?: TrashMaintenanceConfig;
}

/** Trash 在 maintenance 中的配置 */
export interface TrashMaintenanceConfig {
  /** 是否启用 trash sweep（默认 true,遵循 low-friction-defaults） */
  readonly enabled?: boolean;
  /** forgotten 后多少天才进入回收站（默认 30 天） */
  readonly afterDays?: number;
  /** 回收站中多少天后物理删除（默认 365 天）;0 或负数表示永不删除 */
  readonly purgeAfterDays?: number;
}

/** 单次维护的报告 */
export interface MaintenanceReport {
  readonly stage: MaintenanceStage;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  /** 处理的信号条数（light 阶段） */
  readonly signalsProcessed?: number;
  /** 产生的 RPE 更新数（light 阶段） */
  readonly rpeUpdates?: number;
  /** light 阶段关闭的观察窗口数（sweepExpired） */
  readonly windowsClosed?: number;
  /** light 阶段是否刷新了 prompt-signals.json */
  readonly promptSignalsUpdated?: boolean;
  /** deep/rem 阶段的下游报告 */
  readonly downstreamReport?: unknown;
  /** 错误（不抛,记录后继续） */
  readonly errors: readonly MaintenanceError[];
}

/** 维护过程中的错误（不阻塞） */
export interface MaintenanceError {
  readonly stage: MaintenanceStage;
  readonly message: string;
  readonly at: number;
}
