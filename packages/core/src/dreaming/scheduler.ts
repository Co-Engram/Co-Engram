/**
 * Dreaming 调度器（host-agnostic）
 *
 * 提供简单的"按间隔触发"抽象，不绑定 cron 库。
 * 宿主（OpenClaw / Claude Code MCP）负责：
 *   - 实际的时间触发（cron / setInterval / 外部事件）
 *   - 低负载时段判断（spec 2.5.6）
 *   - CLI 命令（spec 2.5.5）
 *
 * Core 只提供：
 *   - 注册 light/deep 任务
 *   - 立即触发（trigger）
 *   - 启停定时调度（基于 setInterval）
 *
 * @module @co-engram/core/dreaming
 */

import type { EngramRepository } from "../storage/repository.js";
import type { LlmClient } from "../observability/necessity-evaluator.js";
import {
  runLightDreaming,
  type LightDreamingOptions,
  type LightDreamingResult,
} from "./light.js";
import {
  runDeepDreaming,
  type DeepDreamingOptions,
  type DeepDreamingResult,
} from "./deep.js";
import {
  runRemDreaming,
  type RemDreamingOptions,
  type RemDreamingResult,
} from "./rem.js";
import { LlmPatternAbstraction } from "./llm-pattern-abstraction.js";

export type DreamingStage = "light" | "deep" | "rem";

export interface DreamingScheduleConfig {
  /** Light Dreaming 间隔（毫秒）。默认 1 小时。 */
  readonly lightIntervalMs?: number;
  /** Deep Dreaming 间隔（毫秒）。默认 24 小时。 */
  readonly deepIntervalMs?: number;
  /** Rem Dreaming 间隔（毫秒）。默认 7 天。P4 新增。 */
  readonly remIntervalMs?: number;
  /** Light Dreaming 选项 */
  readonly lightOptions?: LightDreamingOptions;
  /** Deep Dreaming 选项 */
  readonly deepOptions?: DeepDreamingOptions;
  /** Rem Dreaming 选项。P4 新增。 */
  readonly remOptions?: RemDreamingOptions;
  /**
   * LLM 客户端(可选,REM 阶段语义模式抽象用)。
   *
   * 注入后,REM 自动用 LlmPatternAbstraction 取代 LocalHeuristicPatternAbstraction。
   * 与 remOptions.abstractionProvider 互斥:显式传入的 abstractionProvider 优先级更高。
   */
  readonly llmClient?: LlmClient;
  /**
   * REM 审批化:ProposalEngine(可选)。注入后 REM 的 pattern 提炼不再自动
   * createEngram,而是生成 rem-pattern 提案(用户 accept 才创建)。
   * 顶层字段便于宿主直接注入 deps.proposalEngine;会合并进 remOptions。
   */
  readonly proposalEngine?: RemDreamingOptions["proposalEngine"];
}

export interface DreamingRunRecord {
  readonly stage: DreamingStage;
  readonly at: string;
  readonly result: LightDreamingResult | DeepDreamingResult | RemDreamingResult;
}

export type DreamingRunHandler = (record: DreamingRunRecord) => void;

/**
 * Dreaming 调度器
 *
 * 使用：
 *   const scheduler = createDreamingScheduler(repo, {
 *     lightIntervalMs: 60_000,
 *     deepIntervalMs: 24 * 60 * 60_000,
 *   })
 *   scheduler.onRun((record) => log(record))
 *   scheduler.start()
 *   // ... 应用运行期间自动触发
 *   scheduler.stop()
 *
 * 或者立即手动触发：
 *   scheduler.trigger('light')
 *   scheduler.trigger('deep')
 */
export interface DreamingScheduler {
  /** 注册运行回调（可多次调用添加多个 handler） */
  onRun(handler: DreamingRunHandler): void;
  /** 启动定时调度 */
  start(): void;
  /** 停止定时调度 */
  stop(): void;
  /** 立即触发指定阶段 */
  trigger(stage: DreamingStage): DreamingRunRecord;
  /** 是否正在运行 */
  isRunning(): boolean;
}

/**
 * 创建 Dreaming 调度器
 *
 * llmClient 注入行为(Feature 2):
 *   - 调用方在 remOptions.abstractionProvider 显式传入 provider 时,优先用它
 *   - 否则若 llmClient 存在,自动用 LlmPatternAbstraction(LLM 失败 fallback 启发式)
 *   - 否则保持原行为(runRemDreaming 内部默认 LocalHeuristicPatternAbstraction)
 */
export function createDreamingScheduler(
  repo: EngramRepository,
  config: DreamingScheduleConfig = {},
): DreamingScheduler {
  const lightIntervalMs = config.lightIntervalMs ?? 60 * 60 * 1000;
  const deepIntervalMs = config.deepIntervalMs ?? 24 * 60 * 60 * 1000;
  const remIntervalMs = config.remIntervalMs ?? 7 * 24 * 60 * 60 * 1000;

  // 解析 REM abstractionProvider:显式 > llmClient 自动构造 > 默认(runRemDreaming 内部 LocalHeuristic)
  const baseRemOptions: RemDreamingOptions = config.remOptions
    ? config.remOptions
    : config.llmClient
      ? { abstractionProvider: new LlmPatternAbstraction(config.llmClient) }
      : {};
  // REM 审批化:叠加 proposalEngine(若宿主注入),pattern 提炼走提案而非自动创建
  const remOptions: RemDreamingOptions = config.proposalEngine
    ? { ...baseRemOptions, proposalEngine: config.proposalEngine }
    : baseRemOptions;

  const handlers: DreamingRunHandler[] = [];
  let lightTimer: ReturnType<typeof setInterval> | null = null;
  let deepTimer: ReturnType<typeof setInterval> | null = null;
  let remTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const emit = (record: DreamingRunRecord): void => {
    for (const h of handlers) {
      try {
        h(record);
      } catch {
        // handler 异常不影响调度（仅记录）
      }
    }
  };

  const runStage = async (stage: DreamingStage): Promise<DreamingRunRecord> => {
    const at = new Date().toISOString();
    if (stage === "light") {
      const result = runLightDreaming(repo, config.lightOptions ?? {});
      return { stage, at, result };
    }
    if (stage === "deep") {
      const result = runDeepDreaming(repo, config.deepOptions ?? {});
      return { stage, at, result };
    }
    // rem
    const result = await runRemDreaming(repo, remOptions);
    return { stage, at, result };
  };

  return {
    onRun(handler) {
      handlers.push(handler);
    },
    start() {
      if (running) return;
      running = true;
      lightTimer = setInterval(() => {
        runStage("light")
          .then(emit)
          .catch(() => {});
      }, lightIntervalMs);
      deepTimer = setInterval(() => {
        runStage("deep")
          .then(emit)
          .catch(() => {});
      }, deepIntervalMs);
      remTimer = setInterval(() => {
        runStage("rem")
          .then(emit)
          .catch(() => {});
      }, remIntervalMs);
      // unref：定时器不阻止 Node 进程退出（宿主决定生命周期）
      lightTimer.unref?.();
      deepTimer.unref?.();
      remTimer.unref?.();
    },
    stop() {
      if (!running) return;
      running = false;
      if (lightTimer) {
        clearInterval(lightTimer);
        lightTimer = null;
      }
      if (deepTimer) {
        clearInterval(deepTimer);
        deepTimer = null;
      }
      if (remTimer) {
        clearInterval(remTimer);
        remTimer = null;
      }
    },
    trigger(stage) {
      const at = new Date().toISOString();
      if (stage === "light") {
        const result = runLightDreaming(repo, config.lightOptions ?? {});
        const record: DreamingRunRecord = { stage, at, result };
        emit(record);
        return record;
      }
      if (stage === "deep") {
        const result = runDeepDreaming(repo, config.deepOptions ?? {});
        const record: DreamingRunRecord = { stage, at, result };
        emit(record);
        return record;
      }
      // rem 是 async,trigger 同步签名无法等待。
      // 返回 placeholder record,真实 result 通过 onRun handler 拿到。
      const placeholder: RemDreamingResult = {
        clustersScanned: 0,
        proposals: [],
        adopted: [],
        skipped: [],
      };
      const record: DreamingRunRecord = { stage, at, result: placeholder };
      runRemDreaming(repo, remOptions)
        .then((realResult) => {
          emit({ stage, at, result: realResult });
        })
        .catch(() => {
          // 失败不阻塞
        });
      return record;
    },
    isRunning() {
      return running;
    },
  };
}
