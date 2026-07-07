/**
 * Maintenance Engine（P4 B.2 + C.2 + D.1）
 *
 * 自动维护服务的核心调度器。四阶段：
 *
 *   - light （秒/分钟级）:drain signals → extractSignals → applyRpeUpdate
 *   - deep  （小时级）   :复用现有 runDeepDreaming
 *   - rem   （天级）     :runRemDreaming + metacognition（P4 C.2 实现）
 *   - daily （24 小时）  :applyDailyDecay —— 全量 engram 乘性衰减 ×0.95
 *
 * daily 与 light 正交:
 *   - light 的 RPE 是事件驱动的加性更新(基于 retrieve/reinforce 信号)
 *   - daily 是时间驱动的乘性衰减(无关事件,每天打 95 折)
 *   两机制走不同 stage,避免在同一循环里"加性 + 乘性"互相抵消。
 *
 * 调度策略：
 *   start() 内部 setInterval + unref(),不依赖宿主 /loop 或 cron。
 *   进程退出时定时器自动清理。
 *
 * 错误隔离：单个阶段失败不阻塞其他阶段；失败信息记入 MaintenanceReport.errors。
 *
 * @module @co-engram/core/maintenance
 */

import type {
  MaintenanceConfig,
  MaintenanceDeps,
  MaintenanceError,
  MaintenanceReport,
  MaintenanceStage,
} from "./types.js";
import {
  DEFAULT_DAILY_INTERVAL_MS,
  DEFAULT_DEEP_INTERVAL_MS,
  DEFAULT_LIGHT_INTERVAL_MS,
  DEFAULT_REM_INTERVAL_MS,
  DEFAULT_RPE_LEARNING_RATE,
  DEFAULT_SIGNAL_PRUNE_AGE_MS,
} from "./types.js";
import {
  extractSignals,
  DEFAULT_RULES,
  type SignalRule,
} from "../signals/extract.js";
import { applyRpeUpdate } from "../signals/rpe.js";
import type { ToolCallEvent } from "../signals/types.js";
import { applyMetacognition } from "../verification/metacognition.js";
import { applyDailyDecay } from "../importance/dynamics.js";
import {
  computePromptSignals,
  writePromptSignals,
} from "../prompt-signals/index.js";

/**
 * Maintenance Engine
 *
 * 使用：
 *   const engine = new MaintenanceEngine(deps, config)
 *   engine.start()
 *   // ... 应用运行期间自动维护
 *   engine.stop()
 *
 * 或单次手动触发：
 *   await engine.runLight()
 */
export class MaintenanceEngine {
  private readonly deps: MaintenanceDeps;
  private readonly resolvedConfig: Required<MaintenanceConfig>;
  private lightTimer: ReturnType<typeof setInterval> | null = null;
  private deepTimer: ReturnType<typeof setInterval> | null = null;
  private remTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: MaintenanceDeps, config: MaintenanceConfig = {}) {
    this.deps = deps;
    this.resolvedConfig = {
      lightIntervalMs: config.lightIntervalMs ?? DEFAULT_LIGHT_INTERVAL_MS,
      deepIntervalMs: config.deepIntervalMs ?? DEFAULT_DEEP_INTERVAL_MS,
      remIntervalMs: config.remIntervalMs ?? DEFAULT_REM_INTERVAL_MS,
      dailyIntervalMs: config.dailyIntervalMs ?? DEFAULT_DAILY_INTERVAL_MS,
      signalPruneAgeMs: config.signalPruneAgeMs ?? DEFAULT_SIGNAL_PRUNE_AGE_MS,
      learningRate: config.learningRate ?? DEFAULT_RPE_LEARNING_RATE,
      rules: config.rules ?? DEFAULT_RULES,
      windowSize: config.windowSize ?? 10,
      enabledStages:
        config.enabledStages ??
        (["light", "deep", "rem", "daily"] as const),
      trash: config.trash ?? { enabled: false },
    };
  }

  /** 暴露配置（测试/审计用） */
  getConfig(): Readonly<Required<MaintenanceConfig>> {
    return this.resolvedConfig;
  }

  /**
   * Light 阶段：drain signals → extractSignals → applyRpeUpdate → sweepExpired
   *
   * 高频运行（默认 5 分钟）,负责把累积的行为信号转成 engram 的强化/衰减。
   * 无论 events 是否为空,都会执行 prune（控制 signals.jsonl 体积）。
   * 如果注入了 effectivenessTracker,会扫描超时观察窗口（写 retrieve_inconclusive）。
   */
  async runLight(): Promise<MaintenanceReport> {
    return this.runStage("light", async () => {
      const events = this.deps.signalSink.drain() as ToolCallEvent[];

      let signalsProcessed = 0;
      let rpeUpdates = 0;

      if (events.length > 0) {
        const signals = extractSignals(events, this.resolvedConfig.rules, {
          windowSize: this.resolvedConfig.windowSize,
        });
        signalsProcessed = signals.length;

        // 按 engramId 聚合：取每个 engram 的所有 source 信号求和
        const byEngram = new Map<string, { sum: number; count: number }>();
        for (const s of signals) {
          const entry = byEngram.get(s.engramId) ?? { sum: 0, count: 0 };
          entry.sum += s.weight;
          entry.count += 1;
          byEngram.set(s.engramId, entry);
        }

        for (const [engramId, agg] of byEngram) {
          // 读取该 engram 的 expected（lastRetrievalScore,缺失视为 0.5）
          let expected = 0.5;
          try {
            const engram = this.deps.repository.readEngram(engramId);
            expected = engram.lastRetrievalScore ?? 0.5;
          } catch {
            // engram 可能已被删除,跳过
            continue;
          }

          const effectiveness = (agg.sum + 1) / 2 - expected;
          applyRpeUpdate(
            this.deps.repository,
            engramId,
            effectiveness,
            this.resolvedConfig.learningRate,
          );
          rpeUpdates += 1;
        }
      }

      // 无论 events 是否为空都清理过期 events（控制 signals.jsonl 体积）
      try {
        await this.deps.signalSink.prune(this.resolvedConfig.signalPruneAgeMs);
      } catch {
        // prune 失败不阻塞 light
      }

      // M1: 扫描超时观察窗口（如果配置了 effectivenessTracker）
      let windowsClosed = 0;
      if (this.deps.effectivenessTracker) {
        try {
          const sweep = this.deps.effectivenessTracker.sweepExpired();
          windowsClosed = sweep.closed;
        } catch {
          // sweep 失败不阻塞 light
        }
      }

      // 自进化 prompt signals:扫描 domainTags,生成 snapshot 写缓存
      // 用于 promptBuilder 动态填充 "Frequent topics" 提示
      let promptSignalsUpdated = false;
      if (this.deps.dataRoot) {
        try {
          const snapshot = computePromptSignals(this.deps.repository, {
            generatedBy: "light-stage",
          });
          await writePromptSignals(this.deps.dataRoot, snapshot);
          promptSignalsUpdated = true;
        } catch {
          // signals 更新失败不阻塞 light
        }
      }

      return {
        signalsProcessed,
        rpeUpdates,
        windowsClosed,
        promptSignalsUpdated,
      };
    });
  }

  /**
   * Deep 阶段：复用现有 runDeepDreaming
   *
   * 中频（默认 1 小时）,负责 decay + abstraction。
   * 提交 9 实现（占位：抛错,提示 deps 缺 dreamingScheduler）。
   */
  async runDeep(): Promise<MaintenanceReport> {
    return this.runStage("deep", async () => {
      if (!this.deps.dreamingScheduler) {
        throw new Error(
          "dreamingScheduler not configured (required for deep stage)",
        );
      }
      const record = this.deps.dreamingScheduler.trigger("deep");
      return {
        downstreamReport: record,
      };
    });
  }

  /**
   * REM 阶段：runRemDreaming + metacognition
   *
   * 低频（默认 7 天）,负责 abstraction + verification 升降级。
   *
   * 1. 触发 dreamingScheduler.trigger('rem')（聚类 + 抽象）
   * 2. 遍历所有未 refute 的 engram,调 applyMetacognition
   *    - 元认知评分决定 verificationStatus 升级 / refute
   */
  async runRem(): Promise<MaintenanceReport> {
    return this.runStage("rem", async () => {
      if (!this.deps.dreamingScheduler) {
        throw new Error(
          "dreamingScheduler not configured (required for rem stage)",
        );
      }

      // 1. 触发 REM Dreaming（聚类 + 抽象）
      const dreamRecord = this.deps.dreamingScheduler.trigger("rem");

      // 2. 对所有 active 且未 refuted 的 engram 跑 metacognition
      //    遍历 unverified / plausible / probable / verified
      //
      // SQL 端 filter(verification_status + status='active')下推,
      // 替代旧 listByVerificationStatus 的 N+1 readEngram(1026 engram ×
      // readEngram ≈ 18s)。applyMetacognition 内部会 readEngram,所以
      // 这里只需要 id 列表 —— listDigestByVerificationStatus 返回的
      // DigestLine 字段集超集,够用。
      const candidates = this.deps.repository.listDigestByVerificationStatus(
        ["unverified", "plausible", "probable", "verified"],
        { lifecycleStatuses: ["active"] },
      );

      let metacognitionApplied = 0;
      for (const candidate of candidates) {
        try {
          const result = await applyMetacognition(
            this.deps.repository,
            candidate.id,
          );
          if (result.applied) metacognitionApplied += 1;
        } catch {
          // 单个 engram 失败不阻塞整体
        }
      }

      return {
        downstreamReport: {
          dream: dreamRecord,
          metacognitionApplied,
          metacognitionTotal: candidates.length,
        },
      };
    });
  }

  /**
   * Daily 阶段:applyDailyDecay —— 全量 engram 乘性衰减
   *
   * 低频(默认 24 小时),时间驱动的结构化衰减。
   * 与 light 的 RPE 加性更新正交:RPE 是事件驱动的微调,daily 是
   * "无论是否被使用,所有 engram 每天打 95 折",对应"未被使用的时间
   * 也在削弱记忆权重"的认知科学语义。
   *
   * 范围:active 状态 + verificationStatus ∈ {unverified, plausible,
   * probable, verified} 的 engram。
   *   - status = draft/archived/forgotten 的 engram 已是冻结/废弃态,不再衰减
   *   - verificationStatus = refuted 的 engram 已被否决,不再衰减
   *
   * 不写 audit log:全量 × 每天会产生海量 audit 噪音(1000 engrams ×
   * 365 天 = 36w 条/年),违反 audit log "人类可读的状态变更追踪"设计。
   * 通过 MaintenanceReport.decayed 暴露衰减计数供宿主观察。
   */
  async runDaily(): Promise<MaintenanceReport> {
    return this.runStage("daily", async () => {
      // SQL 端 filter 下推(verification_status + status='active'),
      // 替代旧 listByVerificationStatus 的 N+1 readEngram + 内存 status 过滤。
      // 返回 DigestLine[] 包含 id / importance,够 applyDailyDecay 用。
      const candidates = this.deps.repository.listDigestByVerificationStatus(
        ["unverified", "plausible", "probable", "verified"],
        { lifecycleStatuses: ["active"] },
      );

      let decayed = 0;
      for (const candidate of candidates) {
        try {
          const newImportance = applyDailyDecay(candidate.importance);
          if (newImportance !== candidate.importance) {
            this.deps.repository.updateEngram(candidate.id, {
              importance: newImportance,
              updatedBy: "maintenance.daily",
            });
            decayed += 1;
          }
        } catch {
          // 单个 engram 失败不阻塞整体
        }
      }

      return { decayed };
    });
  }

  /**
   * 启动所有已启用阶段的定时调度
   *
   * 定时器都调 .unref(),进程退出时自动清理。
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    const stages = new Set(this.resolvedConfig.enabledStages);
    if (stages.has("light")) {
      this.lightTimer = setInterval(() => {
        this.runLight().catch(() => {
          // 单次失败不阻塞后续调度（错误已在 report 内记录）
        });
      }, this.resolvedConfig.lightIntervalMs);
      this.lightTimer.unref?.();
    }
    if (stages.has("deep")) {
      this.deepTimer = setInterval(() => {
        this.runDeep().catch(() => {});
      }, this.resolvedConfig.deepIntervalMs);
      this.deepTimer.unref?.();
    }
    if (stages.has("rem")) {
      this.remTimer = setInterval(() => {
        this.runRem().catch(() => {});
      }, this.resolvedConfig.remIntervalMs);
      this.remTimer.unref?.();
    }
    if (stages.has("daily")) {
      this.dailyTimer = setInterval(() => {
        this.runDaily().catch(() => {});
      }, this.resolvedConfig.dailyIntervalMs);
      this.dailyTimer.unref?.();
    }
  }

  /** 停止所有定时调度 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.lightTimer) {
      clearInterval(this.lightTimer);
      this.lightTimer = null;
    }
    if (this.deepTimer) {
      clearInterval(this.deepTimer);
      this.deepTimer = null;
    }
    if (this.remTimer) {
      clearInterval(this.remTimer);
      this.remTimer = null;
    }
    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running;
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  private async runStage(
    stage: MaintenanceStage,
    fn: () => Promise<Partial<MaintenanceReport>>,
  ): Promise<MaintenanceReport> {
    const startedAt = Date.now();
    const errors: MaintenanceError[] = [];
    let body: Partial<MaintenanceReport> = {};

    try {
      body = await fn();
    } catch (err) {
      errors.push({
        stage,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;

    // 阶段触发本身不写 audit —— 避免每 5 分钟一条噪音。
    // 下游任务(sweep_to_trash / reinforce / forget / refute 等)自己写状态变更 audit。

    return {
      stage,
      startedAt,
      finishedAt,
      durationMs,
      errors,
      signalsProcessed: body.signalsProcessed,
      rpeUpdates: body.rpeUpdates,
      windowsClosed: body.windowsClosed,
      promptSignalsUpdated: body.promptSignalsUpdated,
      decayed: body.decayed,
      downstreamReport: body.downstreamReport,
    };
  }
}
