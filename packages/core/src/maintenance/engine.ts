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
import { lowConfidencePenalty } from "../reinforcement/confidence.js";
import {
  computePromptSignals,
  writePromptSignals,
} from "../prompt-signals/index.js";
import { configError } from "../tools/error-schema.js";
import { writeStageState, readMaintenanceState } from "./state.js";

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
        config.enabledStages ?? (["light", "deep", "rem", "daily"] as const),
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
      // 收集 RPE 实际强化的 engram(供 viewer 展示 Light 的实际效果,可点击跳详情)
      const lightModified: { engramId: string; delta: number }[] = [];

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
          lightModified.push({ engramId, delta: effectiveness });
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
        downstreamReport: {
          signalsProcessed,
          rpeUpdates,
          windowsClosed,
          promptSignalsUpdated,
          lightModified,
        },
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
        throw configError(
          "dreamingScheduler",
          "dreamingScheduler not configured (required for deep stage)",
        );
      }
      const record = this.deps.dreamingScheduler.trigger("deep");

      // Deep 修改的记忆:decay(遗忘/归档) + light(重复合并),供 viewer 展示(可点击跳详情)
      const deepResult = record?.result as
        | {
            light?: {
              duplicatesHandled?: ReadonlyArray<{ from: string; to: string }>;
            };
            decay?: {
              forgotten?: readonly string[];
              archived?: readonly string[];
            };
          }
        | undefined;
      // Deep 修改的记忆:decay(遗忘/归档) + light(重复合并),供 viewer 展示(可点击跳详情)
      // to:merged 时记录合并目标 engramId,供「修改介绍卡片」显示「from → to」
      const deepModified: { engramId: string; action: string; to?: string }[] = [];
      for (const id of deepResult?.decay?.forgotten ?? []) {
        deepModified.push({ engramId: id, action: "forgotten" });
      }
      for (const id of deepResult?.decay?.archived ?? []) {
        deepModified.push({ engramId: id, action: "archived" });
      }
      for (const rec of deepResult?.light?.duplicatesHandled ?? []) {
        // merged:记录「from 被合并到 to」,卡片展示「from → to」
        deepModified.push({ engramId: rec.from, action: "merged", to: rec.to });
      }

      return {
        downstreamReport: { ...record, deepModified },
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
        throw configError(
          "dreamingScheduler",
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
      // 收集 REM 实际修改的 engram(升级/反驳),供 viewer 实例化展示
      // before:修改前 verificationStatus,供「修改介绍卡片」显示「从 before 到 action」
      const remModified: { engramId: string; action: string; before?: string }[] = [];
      for (const candidate of candidates) {
        try {
          const result = await applyMetacognition(
            this.deps.repository,
            candidate.id,
          );
          if (result.applied) {
            metacognitionApplied += 1;
            remModified.push({
              engramId: candidate.id,
              action: result.newStatus ?? "evaluated",
              before: candidate.verificationStatus ?? "unverified",
            });
            // REM 审批化:生成 verification proposal(centroidExcerpt 方案)
            if (this.deps.proposalEngine && result.newStatus) {
              this.deps.proposalEngine.proposeVerification(
                candidate.id,
                candidate.title,
                result.newStatus,
                candidate.verificationStatus ?? "unverified",
                result.score.overall,
                result.reason,
              );
            }
          }
        } catch {
          // 单个 engram 失败不阻塞整体
        }
      }

      // dreaming 模式提炼的 pattern 提案(供 viewer「上次 REM 修改」展示,
      // 补 metacognition 升级/反驳之外的「模式提炼」类型)。
      // dreamRecord.result 是 Light/Deep/Rem DreamingResult union,需收窄出 Rem 的 proposals。
      const dreamResult = dreamRecord?.result as
        | {
            proposals?: ReadonlyArray<{
              title: string;
              confidence: number;
              sourceIds?: readonly string[];
            }>;
          }
        | undefined;
      const dreamProposals =
        dreamResult && Array.isArray(dreamResult.proposals)
          ? dreamResult.proposals
          : [];
      const patternProposals = dreamProposals.map((p) => ({
        title: p.title,
        confidence: p.confidence,
        sourceCount: Array.isArray(p.sourceIds) ? p.sourceIds.length : 0,
      }));

      return {
        downstreamReport: {
          dream: dreamRecord,
          metacognitionApplied,
          metacognitionTotal: candidates.length,
          remModified,
          patternProposals,
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
          // daily batch 低频(24h),读 confidence 加 lowConfidencePenalty(N+1 可接受;
          // 未来若 digest 加 confidence 字段可消除 N+1)
          const engram = this.deps.repository.readEngram(candidate.id);
          // daily-decay + lowConfidencePenalty:不可信记忆加速遗忘
          const newImportance =
            applyDailyDecay(candidate.importance) *
            (1 - lowConfidencePenalty(engram.confidence));
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

    // 方案 A:启动时检查 catch-up(异步,不阻塞 start 返回)。
    // 读 maintenance-state.json,若某 stage 的 now - lastRunAt > intervalMs,
    // 或低频 stage(rem/daily)从未跑过,立即触发一次。
    // 低频优先(rem → daily → deep → light):确保最贵的 REM 不被前面 stage 卡住。
    // 串行执行,避免 stage 间互相干扰。
    this.scheduleCatchUp().catch(() => {
      // catch-up 失败不影响后续 setInterval;下次启动会再次尝试
    });

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

  /**
   * 启动 catch-up:检查 maintenance-state.json,触发已过期或从未跑过的 stage。
   *
   * 触发条件:
   *   - 有 lastRunAt 且 now - lastRunAt > intervalMs(已过周期)
   *   - 无 lastRunAt + 低频 stage(rem/daily):首次启动立即跑,避免 setInterval 永远不到
   *   - 无 lastRunAt + 高频 stage(light/deep):setInterval 会很快触发,不立即跑
   *
   * 顺序:低频优先(rem → daily → deep → light),串行执行。
   *
   * 不触发条件(直接返回):
   *   - 未注入 dataRoot(无 state 可读)
   *   - processLock 注入且 isHolder=false(non-holder 不跑 maintenance)
   */
  private async scheduleCatchUp(): Promise<void> {
    if (!this.deps.dataRoot) return;
    if (this.deps.processLock?.isHolder === false) return;

    const state = await readMaintenanceState(this.deps.dataRoot);
    const now = Date.now();
    const enabledStages = new Set(this.resolvedConfig.enabledStages);

    // 低频优先顺序
    const order: readonly MaintenanceStage[] = [
      "rem",
      "daily",
      "deep",
      "light",
    ];
    for (const stage of order) {
      if (!enabledStages.has(stage)) continue;
      const intervalMs = this.getIntervalMs(stage);
      const last = state.stages[stage]?.lastRunAt;
      if (!last) {
        // 从未跑过:仅低频 stage(rem/daily)立即触发(否则 setInterval 永远到不了)。
        // 高频 stage(light/deep) 等 setInterval 很快就会跑,无需 catch-up。
        if (!(stage === "rem" || stage === "daily")) continue;
      } else {
        // 跑过:仅当过期才 catch-up
        const elapsed = now - new Date(last).getTime();
        if (elapsed <= intervalMs) continue;
      }

      try {
        await this.runStageByName(stage);
      } catch {
        // 单 stage catch-up 失败不阻塞下一个;错误已在 report 内记录
      }
    }
  }

  /** 按 stage 名取调度间隔(便于 catch-up 复用) */
  private getIntervalMs(stage: MaintenanceStage): number {
    switch (stage) {
      case "light":
        return this.resolvedConfig.lightIntervalMs;
      case "deep":
        return this.resolvedConfig.deepIntervalMs;
      case "rem":
        return this.resolvedConfig.remIntervalMs;
      case "daily":
        return this.resolvedConfig.dailyIntervalMs;
    }
  }

  /** 按 stage 名触发 run*(便于 catch-up 复用) */
  private async runStageByName(stage: MaintenanceStage): Promise<void> {
    switch (stage) {
      case "light":
        await this.runLight();
        return;
      case "deep":
        await this.runDeep();
        return;
      case "rem":
        await this.runRem();
        return;
      case "daily":
        await this.runDaily();
        return;
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

    // 阶段触发 audit 策略:
    //   - light/deep 频率高(5min/1h),写 audit 会变噪音,跳过
    //   - rem/daily 频率低(7d/24h),且用户关心"REM 跑过吗",写 audit
    //   - 下游任务(sweep_to_trash / reinforce / forget / refute 等)自己写状态变更 audit
    const shouldWriteAudit = stage === "rem" || stage === "daily";

    const report: MaintenanceReport = {
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

    // 方案 A:写 maintenance-state.json(只在 dataRoot 注入 + 持锁时)。
    // processLock 未注入视为「无条件持锁」(向后兼容,适用于单 host / 测试)。
    // 写失败不阻塞 stage(state 是辅助,丢失下次启动会触发 catch-up 重做)。
    if (this.deps.dataRoot && this.deps.processLock?.isHolder !== false) {
      try {
        await writeStageState(
          this.deps.dataRoot,
          stage,
          report,
          this.deps.host ?? "unknown",
        );
      } catch {
        // state 写失败不阻塞 stage
      }
    }

    // 方案 A:rem/daily 完成后写 audit log(让用户可查 "REM 跑过吗")。
    // 失败/成功都写,metadata 含 stage / durationMs / errorCount / 关键产物。
    if (shouldWriteAudit && this.deps.auditLog) {
      try {
        this.deps.auditLog.append({
          actor: "system",
          action: "maintenance_run",
          host: this.deps.host,
          metadata: {
            stage,
            durationMs,
            errorCount: errors.length,
            ...(errors.length > 0 ? { errorMessage: errors[0]?.message } : {}),
            ...(report.signalsProcessed !== undefined
              ? { signalsProcessed: report.signalsProcessed }
              : {}),
            ...(report.rpeUpdates !== undefined
              ? { rpeUpdates: report.rpeUpdates }
              : {}),
            ...(report.decayed !== undefined
              ? { decayed: report.decayed }
              : {}),
            ...(report.downstreamReport !== undefined
              ? {
                  downstreamSummary: extractAuditSummary(
                    report.downstreamReport,
                  ),
                }
              : {}),
          },
        });
      } catch {
        // audit 写失败不阻塞 stage
      }
    }

    return report;
  }
}

/**
 * 从 downstreamReport(可能很大,如聚类矩阵 / 候选 pattern 列表)提取 audit log
 * 友好的 summary:仅保留标量字段 + 数组 count,与 state.ts extractReportSummary 同策略。
 *
 * audit entry 一行 ~200B,downstreamReport 不压会撑爆 audit.jsonl。
 */
function extractAuditSummary(
  downstream: unknown,
): Readonly<Record<string, unknown>> {
  if (!downstream || typeof downstream !== "object") return {};
  const ds = downstream as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ds)) {
    if (
      typeof v === "number" ||
      typeof v === "string" ||
      typeof v === "boolean"
    ) {
      summary[k] = v;
    } else if (Array.isArray(v)) {
      summary[`${k}Count`] = v.length;
    }
  }
  return summary;
}
