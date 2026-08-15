/**
 * Maintenance Engine（P4 B.2 + C.2 + D.1）
 *
 * 自动维护服务的核心调度器。三阶段（2026-07-20 移除 daily：importance 不再时间驱动衰减）：
 *
 *   - light （秒/分钟级）:drain signals → extractSignals → applyRpeUpdate
 *   - deep  （小时级）   :runDeepDreaming（记忆整理：合并重复 + 归档/遗忘）
 *   - rem   （天级）     :runRemDreaming + metacognition
 *
 * importance 纯事件驱动（RPE/LTP/LTD），freshness 纯时间驱动（age vs halfLife）。
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
  DEFAULT_DEEP_INTERVAL_MS,
  DEFAULT_LIGHT_INTERVAL_MS,
  DEFAULT_REM_ACTIVITY_THRESHOLD,
  DEFAULT_REM_INTERVAL_MS,
  DEFAULT_REM_MIN_INTERVAL_MS,
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
import {
  computePromptSignals,
  writePromptSignals,
} from "../prompt-signals/index.js";
import { configError } from "../tools/error-schema.js";
import { runDeepThought, scanInsightDecay } from "./insight/run.js";
import { DEFAULT_REM_INSIGHT } from "./insight/types.js";
import {
  writeStageState,
  readMaintenanceState,
  maintenanceStatePath,
  type MaintenanceState,
} from "./state.js";
import { mkdir, writeFile } from "node:fs/promises";
import { refreshDomainTagsOnDrift } from "./tag-refresh.js";
import { refineSynapsesOnActiveGraph } from "../dreaming/synapse-refiner.js";
import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { DoctorReport } from "../types/repository-types.js";

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
  private running = false;
  /** P0-1:活动量触发的 REM 是否在执行(防 light 5min 节拍与 REM 分钟级耗时交叠时重复触发) */
  private remActivityRunning = false;

  constructor(deps: MaintenanceDeps, config: MaintenanceConfig = {}) {
    this.deps = deps;
    this.resolvedConfig = {
      lightIntervalMs: config.lightIntervalMs ?? DEFAULT_LIGHT_INTERVAL_MS,
      deepIntervalMs: config.deepIntervalMs ?? DEFAULT_DEEP_INTERVAL_MS,
      remIntervalMs: config.remIntervalMs ?? DEFAULT_REM_INTERVAL_MS,
      remActivityThreshold:
        config.remActivityThreshold ?? DEFAULT_REM_ACTIVITY_THRESHOLD,
      remMinIntervalMs: config.remMinIntervalMs ?? DEFAULT_REM_MIN_INTERVAL_MS,
      signalPruneAgeMs: config.signalPruneAgeMs ?? DEFAULT_SIGNAL_PRUNE_AGE_MS,
      learningRate: config.learningRate ?? DEFAULT_RPE_LEARNING_RATE,
      rules: config.rules ?? DEFAULT_RULES,
      windowSize: config.windowSize ?? 10,
      enabledStages:
        config.enabledStages ?? (["light", "deep", "rem"] as const),
      trash: config.trash ?? { enabled: false },
      remInsight: config.remInsight
        ? { ...DEFAULT_REM_INSIGHT, ...config.remInsight }
        : { ...DEFAULT_REM_INSIGHT },
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
    const report = await this.runStage("light", async () => {
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

      // F28 治本:回收 SQLite free page(auto_vacuum=INCREMENTAL 下生效)。
      // light 的 RPE 更新 / deleteEngram / doctor ghost 清理产生 free page;
      // incremental_vacuum 无 free page 时 no-op(毫秒),有则增量回收,防文件膨胀。
      try {
        this.deps.repository.indexDb?.exec("PRAGMA incremental_vacuum");
      } catch {
        // 回收失败不阻塞 light
      }

      // S3: skill retention 周期重算(Oblivion 衰退)。可选——未注入 skillRepository 时 noop。
      let skillsDecayed: number | undefined = undefined;
      let skillsScanned: number | undefined = undefined;
      if (this.deps.skillRepository) {
        try {
          const result = this.deps.skillRepository.recomputeRetentionAll();
          skillsScanned = result.scanned;
          skillsDecayed = result.changed;
        } catch {
          // skill 衰退失败不阻塞 light
        }
      }

      const baseResult = {
        signalsProcessed,
        rpeUpdates,
        windowsClosed,
        promptSignalsUpdated,
        downstreamReport: {
          signalsProcessed,
          rpeUpdates,
          windowsClosed,
          promptSignalsUpdated,
          lightModified,
        },
      };

      // 只有当 skillRepository 存在时才添加 skill 衰退字段
      if (skillsDecayed !== undefined && skillsScanned !== undefined) {
        return {
          ...baseResult,
          skillsDecayed,
          skillsScanned,
          downstreamReport: {
            ...baseResult.downstreamReport,
            skillsDecayed,
            skillsScanned,
          },
        };
      }

      return baseResult;
    });

    // P0-1 REM 活动量累积阈值:light 完成后检查自上次 REM 以来新增 engram 的
    // Σimportance 是否达标(内容密度驱动,非日历驱动)。达标且过防抖窗口则
    // 提前触发 REM;时间兜底(remIntervalMs 定时器 + 启动 catch-up)不受影响。
    await this.maybeRunRemByActivity();

    // 夜思独立日调度(spec §四):active 孵化条目 24h 一轮,不依赖 REM 节拍
    // (REM 为 7 天级低频,与「每夜」叙事错位)。light tick(5min)检查即触发;
    // fire-and-forget,失败不阻塞 light。仅注入 incubator 时生效。
    if (this.deps.incubator) {
      void this.deps.incubator.runDue().catch(() => {
        // 单轮夜思失败下次 tick 重试
      });
    }
    return report;
  }

  /**
   * P0-1 REM 活动量累积阈值检查(runLight 尾部调用)。
   *
   * 触发条件(全部满足):
   *   - remActivityThreshold > 0(设 0 禁用,退回纯时间触发)
   *   - enabledStages 含 rem;dataRoot 可用(maintenance-state 是累积起点)
   *   - 距上次 REM ≥ remMinIntervalMs(防抖:窗口内不触发,等下一轮 light 检查)
   *   - 自上次 REM(无记录则从零起算)以来新增 engram 的 Σimportance ≥ 阈值
   *
   * 口径只算现存 engram 的 importance(强化事件/访问量不计入):前者要扫
   * audit.jsonl,后者与检索 hotness(P0-2)双重激励。
   *
   * 串行保护:remActivityRunning flag 防 REM 执行期间下一轮 light 重复触发
   * (light 5min 节拍与 REM 分钟级 LLM 耗时可能交叠)。时间兜底路径
   * (remTimer / scheduleCatchUp)不经过本方法,不受 flag 影响。
   */
  private async maybeRunRemByActivity(): Promise<void> {
    const cfg = this.resolvedConfig;
    if (cfg.remActivityThreshold <= 0) return;
    if (this.remActivityRunning) return;
    if (!new Set(cfg.enabledStages).has("rem")) return;
    if (!this.deps.dataRoot) return;

    try {
      const state = await readMaintenanceState(this.deps.dataRoot);
      const lastRemAt = state.stages.rem?.lastRunAt;
      if (lastRemAt) {
        const sinceRemMs = Date.now() - new Date(lastRemAt).getTime();
        if (sinceRemMs < cfg.remMinIntervalMs) return;
      }

      // 累积起点 = 上次 REM 完成时间;从未跑过则从零起算(全部现存 engram
      // 计入,与启动 catch-up 对"从未跑过立即触发"的语义一致)
      const sinceIso = lastRemAt ?? new Date(0).toISOString();
      const sum = this.deps.repository.sumImportanceSince(sinceIso);
      if (sum < cfg.remActivityThreshold) return;

      this.remActivityRunning = true;
      try {
        await this.runRem();
      } finally {
        this.remActivityRunning = false;
      }
    } catch {
      // 检查失败(state 读不了 / SUM 查询失败)不阻塞 light;下一轮再试
    }
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
      const deepModified: { engramId: string; action: string; to?: string }[] =
        [];
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

      // 方案 A:deep stage 跑 doctor 自愈(dangling synapse / orphan md / SQLite ghost
      // 自动检测+清理)。无异常时 doctor 只检测不写(快速);有异常 autoFixed。
      // report 持久化到 .co-engram/doctor-report.json,供 viewer 健康栏显示"修复前的
      // 问题"(即使已 autoFixed,用户仍能看到 deep 修了什么)。
      let doctorReport: DoctorReport | undefined;
      try {
        doctorReport = this.deps.repository.runDoctor();
      } catch {
        // doctor 失败不阻塞 deep,下次重试
      }
      if (this.deps.dataRoot && doctorReport) {
        try {
          const drPath = join(
            this.deps.dataRoot,
            ".co-engram",
            "doctor-report.json",
          );
          mkdirSync(dirname(drPath), { recursive: true });
          writeFileSync(drPath, JSON.stringify(doctorReport), "utf8");
        } catch {
          // 持久化失败不阻塞 deep
        }
      }
      const doctorSummary = doctorReport
        ? {
            startedAt: doctorReport.startedAt,
            finishedAt: doctorReport.finishedAt,
            issueCount: doctorReport.issues.length,
            fixCount: doctorReport.fixes.length,
            pendingCount: doctorReport.pendingManualReview.length,
          }
        : undefined;

      return {
        downstreamReport: { ...record, deepModified, doctorSummary },
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

      // checkpoint:dreaming 是最慢的 LLM 步骤(聚类 pattern 抽象)。完成后立即写
      // state,确保「dreaming 跑完」即使后续标签/突触/metacognition 中断也不丢。
      await this.persistRemCheckpoint({
        dream: dreamRecord,
        phase: "post-dreaming",
      });

      // 1.5 标签漂移刷新:对内容显著变化(≥阈值)的 engram 用 LLM 重提内容语义
      //     domainTags,修正导入/历史 engram 的笼统标签(imported/uncategorized)。
      //     先于 metacognition 跑,让 crossContext 维度拿到准确的 domainTags 数量。
      //     无 indexDb 时 noop;无 llmClient 时只更新 baseline 不调 LLM。不阻塞 REM。
      const tagRefresh = await refreshDomainTagsOnDrift(
        this.deps.repository,
        this.deps.auditLog,
        this.deps.llmClient,
        // 注入 proposalEngine:提取出的新标签走 rem-tag-refresh pending proposal
        // (用户审批卡片 accept 才改 domainTags),与 rem-pattern/synapse/verification 对齐。
        // 未注入(最小部署)时 refreshDomainTagsOnDrift 内部退化为直接落盘。
        this.deps.proposalEngine,
      );

      // 1.6 突触候选对计算(二期,agent-driven):局部图遍历(活跃 engram + 1-hop 邻居)
      //     → 候选对(A×A + A×N + Jaccard 预筛)。不调 LLM/不 propose——交 agent
      //     (Claude Code)判断关系 + 调 synapse_create/delete/update。增量触发。
      const lastRemState = this.deps.dataRoot
        ? await readMaintenanceState(this.deps.dataRoot)
        : undefined;
      const synapseRefine = await refineSynapsesOnActiveGraph(
        this.deps.repository,
        this.deps.proposalEngine,
        { lastRemAt: lastRemState?.stages.rem?.lastRunAt },
      );

      // checkpoint:LLM 阶段(dreaming + 标签刷新 + 突触候选对)完成,写 intermediate state。
      // metacognition 纯计算(快),但容许 REM 长耗时——中途进程退出不丢「LLM 阶段已跑完」。
      // 产物(标签 updateEngram / 突触 proposeSynapseOp 写 proposals.jsonl)已落盘。
      await this.persistRemCheckpoint({
        dream: dreamRecord,
        tagRefresh,
        synapseRefine,
        phase: "post-llm-pre-metacognition",
      });

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
      const remModified: {
        engramId: string;
        action: string;
        before?: string;
      }[] = [];
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

      // 2.5 REM 深度思考(spec §三/§五):事件驱动模式 top-K → 扩散激活子图 →
      //     机械校验 + 独立 critic → rem-insight 提案(每轮硬上限 5 条)。
      //     一期兜底 REM(无事件信号)整体跳过、零 LLM 调用;enabled 默认 false
      //     (spec §九:人工盲评校准后才可默认开启)。单模式失败不阻塞 REM。
      let deepThought: import("./insight/run.js").DeepThoughtReport | undefined;
      try {
        deepThought = await runDeepThought({
          repository: this.deps.repository,
          proposalEngine: this.deps.proposalEngine as import("./insight/run.js").DeepThoughtProposalSink | undefined,
          llmClient: this.deps.llmClient,
          lastRemAt: lastRemState?.stages.rem?.lastRunAt ?? null,
          config: this.resolvedConfig.remInsight,
          ...(this.deps.incubator ? { incubator: this.deps.incubator } : {}),
        });
      } catch {
        // 深度思考失败不阻塞 REM 主流程
      }

      // 2.6 存活期证据链衰减监测(spec §五第三关,纯代码无 LLM):
      //     rem-insight 洞察的 derives_from 对端 refute/非 active 占比 > 30%
      //     → 汇入 insight-review.json 重审摘要(不逐条出提案,防泛滥)。
      let insightDecay: import("./insight/run.js").InsightDecayItem[] | undefined;
      try {
        insightDecay = await scanInsightDecay(
          this.deps.repository,
          this.deps.dataRoot,
          this.deps.processLock,
        );
      } catch {
        // 衰减扫描失败不阻塞 REM
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
        sourceIds: Array.isArray(p.sourceIds) ? [...p.sourceIds] : [],
      }));

      return {
        downstreamReport: {
          dream: dreamRecord,
          metacognitionApplied,
          metacognitionTotal: candidates.length,
          remModified,
          patternProposals,
          tagRefresh,
          synapseRefine,
          ...(deepThought ? { deepThought } : {}),
          ...(insightDecay !== undefined ? { insightDecayCount: insightDecay.length } : {}),
        },
      };
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
    // 或低频 stage(rem)从未跑过,立即触发一次。
    // 低频优先(rem → deep → light):确保最贵的 REM 不被前面 stage 卡住。
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
  }

  /**
   * 启动 catch-up:检查 maintenance-state.json,触发已过期或从未跑过的 stage。
   *
   * 触发条件:
   *   - 有 lastRunAt 且 now - lastRunAt > intervalMs(已过周期)
   *   - 无 lastRunAt + 低频 stage(rem):首次启动立即跑,避免 setInterval 永远不到
   *   - 无 lastRunAt + 高频 stage(light/deep):setInterval 会很快触发,不立即跑
   *
   * 顺序:低频优先(rem → deep → light),串行执行。
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
    const order: readonly MaintenanceStage[] = ["rem", "deep", "light"];
    for (const stage of order) {
      if (!enabledStages.has(stage)) continue;
      const intervalMs = this.getIntervalMs(stage);
      const last = state.stages[stage]?.lastRunAt;
      if (!last) {
        // 从未跑过:仅低频 stage(rem)立即触发(否则 setInterval 永远到不了)。
        // 高频 stage(light/deep) 等 setInterval 很快就会跑,无需 catch-up。
        if (stage !== "rem") continue;
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

  /**
   * REM 分步 checkpoint:记「进度」(phase + partial downstreamReport)到 state.json 的
   * `stages.rem.progress` 字段。**不更新 lastRunAt/lastResult/lastError**(那些只在
   * REM 完整完成时 final writeStageState 更新)。
   *
   * 一致性关键:lastRunAt 语义是「REM 完成时间」。checkpoint 若误更新 lastRunAt →
   * catch-up 误判「rem 已完成(elapsed < interval)不重跑」→ metacognition 永不补跑。
   * 所以 checkpoint 只写 progress(progress 字段不影响 catch-up 判定),lastRunAt 保持
   * 旧值(未完成)→ 中断后 catch-up 重跑(标签/突触幂等,metacognition 补)。
   *
   * 容许 REM 长耗时(LLM 分钟级):中途进程退出不丢「已跑到哪步」(progress 留痕)。
   */
  private async persistRemCheckpoint(
    partial: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.deps.dataRoot || this.deps.processLock?.isHolder === false)
      return;
    try {
      const state = await readMaintenanceState(this.deps.dataRoot);
      const nextState: MaintenanceState = {
        ...state,
        stages: state.stages, // 不动 stages.rem(lastRunAt 不污染)
        updatedAt: new Date().toISOString(),
        updatedBy: this.deps.host ?? "unknown",
        remCheckpoint: {
          phase: partial.phase,
          at: new Date().toISOString(),
          partial,
        },
      };
      const filePath = maintenanceStatePath(this.deps.dataRoot);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify(nextState, null, 2) + "\n",
        "utf8",
      );
    } catch {
      // checkpoint 失败不阻塞 REM 继续
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
    //   - rem 频率低(7d),且用户关心"REM 跑过吗",写 audit
    //   - 下游任务(sweep_to_trash / reinforce / forget / refute 等)自己写状态变更 audit
    const shouldWriteAudit = stage === "rem";

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
      ...(body.skillsDecayed !== undefined
        ? { skillsDecayed: body.skillsDecayed }
        : {}),
      ...(body.skillsScanned !== undefined
        ? { skillsScanned: body.skillsScanned }
        : {}),
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

    // 方案 A:rem 完成后写 audit log(让用户可查 "REM 跑过吗")。
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
