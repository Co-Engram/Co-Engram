/**
 * Maintenance 模块类型定义（P4 B.2 + C.2 + D.1）
 *
 * MaintenanceEngine 四阶段配置：
 *   - light : drain signals → extractSignals → applyRpeUpdate（高频,秒/分钟级）
 *   - deep  : 复用现有 runDeepDreaming（中频,小时级）
 *   - rem   : runRemDreaming + metacognition（低频,天级）
 *   - daily : applyDailyDecay（每 24h 一次,全量 engram 乘性衰减 ×0.95）
 *
 * 设计原则：
 *   1. 默认配置合理（可零配置启动）
 *   2. 调度器内化在 engine.start()（setInterval + unref）,不依赖宿主 /loop
 *   3. 各阶段独立触发,可单独调用
 *   4. daily 与 light 的 RPE 加性更新正交 —— RPE 是事件驱动的微调,
 *      daily 是时间驱动的结构化衰减;两机制并存而不互相抵消(分别走不同 stage)。
 *
 * @module @co-engram/core/maintenance
 */

import type { EngramRepository } from "../storage/repository.js";
import type { SignalSink } from "../signals/types.js";
import type { SignalRule } from "../signals/extract.js";
import type { DreamingScheduler } from "../dreaming/scheduler.js";
import type { EffectivenessTracker } from "../observability/effectiveness-tracker.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import { DEFAULT_RPE_LEARNING_RATE } from "../signals/rpe.js";

/** 维护阶段名 */
export type MaintenanceStage = "light" | "deep" | "rem" | "daily";

/**
 * ProcessLock 持有者抽象(用于 maintenance 写 state.json 前 check)。
 *
 * 抽象为接口而非直接依赖 ProcessLock 类,便于:
 *   - 测试 mock
 *   - 不同宿主(claude-code-mcp / openclaw-plugin)注入自己的实现
 *
 * 持锁语义:processLock.isHolder = true 时,当前进程是 dataRoot 的唯一持锁者,
 * 可以独占写 maintenance-state.json。non-holder 跳过写入(避免与 holder 冲突)。
 */
export interface ProcessLockHolder {
  /** 当前进程是否持有 maintenance 锁(只有持锁者可写 state.json) */
  readonly isHolder: boolean;
}

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
   *
   * 同时也是 maintenance-state.json 的写入根路径(方案 A:catch-up 调度所需)。
   */
  readonly dataRoot?: string;
  /**
   * ProcessLock 持有者(可选,写 maintenance-state.json 前 check)。
   *
   * 如果注入,runStage 写 state.json 前会 check isHolder,
   * 防止持锁丢失期间残留写入(多 host 共享 dataRoot 场景)。
   * 如果不注入,视为「无条件持锁」(向后兼容,适用于单 host / 测试场景)。
   */
  readonly processLock?: ProcessLockHolder;
  /**
   * 当前 host 标识(可选,state.json updatedBy 字段用)。
   *
   * 建议值:`"claude-code-mcp"` / `"openclaw-plugin"` 等。
   * 不注入时默认 `"unknown"`。
   */
  readonly host?: string;
  /**
   * LLM 客户端(可选,REM 阶段做语义模式抽象用)。
   *
   * 如果注入,REM Dreaming 会用 LlmPatternAbstraction 取代 LocalHeuristicPatternAbstraction,
   * 让自动综合的 pattern 质量从"字面 token 频率"升级到"LLM 语义抽象"。
   * LLM 调用失败时自动 fallback 到启发式,保证 REM 不挂。
   *
   * 与 ToolContext.llmClient(engram_synthesize 工具用)共享同一份配置,避免重复建连。
   */
  readonly llmClient?: LlmClient;
}

/** 默认配置常量 */
export const DEFAULT_LIGHT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_DEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_REM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
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
  /**
   * daily 阶段调度间隔（默认 24 小时）。
   *
   * daily 走全量 engram 的乘性衰减(importance × 0.95),与 light 阶段的
   * RPE 加性更新正交。频率过快会让 importance 一天被打到 0,过慢则失去
   * "每日衰减"的语义。24h 是与人类"每天"节律对齐的自然周期。
   */
  readonly dailyIntervalMs?: number;
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
  /**
   * daily 阶段实际衰减的 engram 数(importance 真的发生变化的条数;
   * 已在 0 / 1 边界无变化的 engram 不计入)。
   */
  readonly decayed?: number;
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
