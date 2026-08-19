/**
 * 沉思孵化器(2026-08-17 重设计)—— incubations.json 侧车 + 固化协议 + 双级执行。
 *
 * 沉思定位:围绕一个问题做一次全资源盘点式深度思考(记忆图谱 + 行为日志 +
 * 技能库,纯本地只读),深思一次出一份报告。状态机三态:queued → thinking →
 * done;不区分第几夜(timeline 内部保留 session 序号供提案实体 id 连续性,
 * UI 按时间戳呈现历史)。
 *
 * 设计要点:
 * - **从 runRem 解耦**:REM 只是消费方之一(queued 条目供 REM 灵感合并种子);
 *   即时触发(对话/viewer)是独立调用方,无排程
 * - **incubations.json RMW 短临界区锁 + 原子写**:任何实例可写(2026-08-19
 *   修复:原「holder-only 落盘」模式让 non-holder 实例的 ponder 工具族假成功
 *   —— 返回成功但数据静默蒸发;并发安全由文件锁互斥「读-改-写」临界区 +
 *   tmp-rename 原子写保证,不再依赖进程身份门禁)
 * - **thinking 原子标记**:跨进程互斥,TTL 30min 过期回收(跑过→done,未跑→queued)
 * - **ponder_report 是 L2 唯一写回路径**:机械校验 + 独立 critic → rem-insight
 *   提案(entityId 纳入 session 序号);捕获即时成提案,不等不攒
 * - **回答必出**:L2 的 answer 由执行现场生产(agent 手握全部盘点上下文);
 *   缺省时综合层兜底(L1 路径),失败记 answerError,不拼接伪回答
 * - **资源申报**:L2 申报 resourcesUsed(记忆/技能/日志),engram id 逐个试读
 *   清洗 —— 编造 id 不进「依据」区
 * - **条目上限 50**(create 拒绝并列出最老 10 条已答条目引导删除,不自动清理
 *   —— 删除属用户裁决);深思史回灌上限 10 次(prompt 长度保护)
 * - **审计**:contemplation_create / run_start / run_done / run_fail / delete
 *
 * @module @co-engram/core/maintenance/insight
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { acquireRmwLock } from "../../concurrency/rmw-lock.js";
import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { insightEntityId } from "../../observability/proposal-engine.js";
import { collectDigestLines } from "../../index/digest-builder.js";
import { buildFtsIndex, searchFts } from "../../retrieval/fts.js";
import { critique } from "./critic.js";
import {
  createL1Executor,
  collectResourceHints,
  collectSeedDigests,
  buildProtocol,
  synthesizeAnswerDraft,
  NO_SURVIVOR_MARKER,
} from "./night-thinking.js";
import type {
  InsightDraft,
  NightThinkingReport,
  NightThinkingTask,
  NightThinkingExecutor,
  NightThinkingResourcesUsed,
  WebResourceUsed,
} from "./types.js";
import { DEFAULT_REM_INSIGHT, INSIGHT_LIMITS } from "./types.js";
import {
  contentJaccard,
  validateInsightDraft,
  type ProposalLike,
} from "./validate.js";
import {
  advanceGaps,
  applyPlanToRequirements,
  checkRequirements,
  digestEvidence,
  isSeedOnlySources,
} from "./gap-check.js";
import { generateThinkPlan, templatePlan } from "./plan.js";
import { extractClaims, generateNextTasks } from "./claims.js";
import type { ToolCallEvent } from "../../signals/types.js";
import type { PonderGap, PonderPlan, PonderRunState } from "./types.js";

/**
 * 条目状态(Phase1 PDCA 扩展,2026-08-18):
 * queued(已提问)→ thinking(深思中)→ verifying(报告校验中,瞬态)
 *   → done(全闭合终束)| repairing(有缺口,等修复 report → verifying → …)
 * repairing/verifying 超时(复用 TTL)未闭合 → done + degraded(触顶终束)。
 */
export type IncubationStatus =
  | "queued"
  | "thinking"
  | "verifying"
  | "repairing"
  | "done";

/** degraded 终束成因(预算触顶 / TTL 超时 / 执行中断 / 闭合校验拒绝) */
export interface IncubationDegraded {
  readonly at: string;
  readonly reason:
    | "repair-budget-exhausted"
    | "gap-budget-exhausted"
    | "ttl-expired"
    | "aborted"
    | "closure-rejected"
    | "single-run-gaps";
  /** 未闭合缺口描述(审批面置顶展示) */
  readonly unclosedGaps: readonly string[];
  /**
   * P8 接力权转移:critic 生成的下轮验证任务(至少一条外部资源型,机械
   * 保证);LLM 失败时缺省 → 转存退化用 unclosedGaps 机械描述。
   */
  readonly nextTasks?: readonly string[];
}

/** 深思时间线单次记录(同一时间线,内部 round 序号供提案实体 id;UI 按时间戳呈现) */
export interface IncubationTimelineEvent {
  readonly at: string;
  readonly trigger: "manual" | "scheduled";
  readonly round: number;
  /** 本次洞察摘要(捕获即记;accept/dismiss 状态经提案实时解析) */
  readonly summaries: readonly string[];
  readonly proposalEntityIds: readonly string[];
  /** 空转诊断:各关计数 */
  readonly diagnosis?: {
    readonly drafts: number;
    readonly dupVetoed: number;
    readonly validateRejected: number;
    readonly criticRejected: number;
    readonly llmClientMissing: boolean;
    /** 逐条拒绝原因(title 前缀 + reason;validate/critic 两关) */
    readonly rejectReasons?: readonly string[];
  };
  /** 执行层轨迹摘要(step: action — detail,每条截断,上限保护) */
  readonly trace?: readonly string[];
  /** 思考计划摘要(step — capability,上限保护;报告「过程」区) */
  readonly plan?: readonly string[];
  /** 资源使用申报(「依据」区数据源;engram id 已过试读清洗) */
  readonly resourcesUsed?: NightThinkingResourcesUsed;
  /** 本次深思的回答(L2 执行现场生产;L1 由综合层兜底补写) */
  readonly answer?: string;
  readonly answerError?: string;
  readonly note?: string;
  /** PDCA 修复回路信息(Phase1;每次 report 落一条) */
  readonly pdca?: {
    /** 修复 report 次序(主报告 = 0) */
    readonly repairRound: number;
    /** 校验后仍开放的阻塞缺口(描述摘要;hash 见 entry.run) */
    readonly openGaps: readonly string[];
    /** 本轮复核闭合的需求数 */
    readonly closedThisRound: number;
    readonly degraded: boolean;
    /** 本轮 deferred 的超额新缺口(不阻塞;留痕) */
    readonly deferred?: readonly string[];
    /** Phase2:P5 收窄拦截(删除/降级的计划项) */
    readonly narrowed?: readonly string[];
    /** Phase2:P1 自动豁免(探测皆空的计划项) */
    readonly exempted?: readonly string[];
    /** Phase3 P6:答案与上一 run 最终答案高度重复(标记,不阻塞) */
    readonly answerRepeat?: boolean;
    /** Phase3 P7:主张抽取被跳过(无 llmClient / L2 未交 answer) */
    readonly claimsSkipped?: boolean;
    /** Phase3 P7:降级主张占比(0-1);> 0.3 时本 run 提案隔离 */
    readonly answerDowngradeRatio?: number;
  };
  /** Phase3 P7:对手抽取的主张清单(critic 从执行者 answer 抽取;上限截断) */
  readonly answerClaims?: ReadonlyArray<{
    readonly claim: string;
    readonly status: "evidenced" | "downgraded";
  }>;
}

export interface IncubationEntry {
  readonly id: string;
  readonly question: string;
  readonly seedEngramIds: readonly string[];
  readonly status: IncubationStatus;
  /** 内部 session 序号(insightEntityId 依赖;UI 不呈现「第几次」) */
  readonly rounds: number;
  readonly createdAt: string;
  readonly lastRunAt: string | null;
  readonly timeline: readonly IncubationTimelineEvent[];
  /** 最新一次深思的回答(= timeline 最后一项的 answer) */
  readonly answer?: string;
  readonly answerError?: string;
  /** thinking/verifying/repairing 瞬态字段(TTL 30min 回收) */
  readonly thinkingAt?: string;
  readonly thinkingBy?: string;
  /** 连续全撞循环计数(诊断信号) */
  readonly consecutiveVetoed?: number;
  /** 当前 run 的 PDCA 状态(修复轮之间持久化;终束清除) */
  readonly run?: PonderRunState;
  /** degraded 终束标记(run 级;洞察提案隔离依据;再思时清除) */
  readonly degraded?: IncubationDegraded;
  /** Phase2 接力瞬态:acquireThinking 时从上轮 degraded 转存,供计划生成 */
  readonly carryOverGaps?: readonly string[];
}

/** incubator 对 proposalEngine 的结构依赖 */
export interface IncubatorProposalSink {
  proposeInsight(input: {
    readonly mode: string;
    readonly insightType: string;
    readonly title: string;
    readonly content: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
    readonly sourceIds: readonly string[];
    readonly criticScore: number;
    readonly criticRationale: string;
    readonly incubationId?: string;
    readonly round?: number;
    /** PDCA:run 未闭合时提案带 provisional degraded 标(终态落定时翻转) */
    readonly degraded?: {
      readonly provisional: boolean;
      readonly unclosedGaps: readonly string[];
    };
  }): boolean;
  listAll(): readonly ProposalLike[];
  findProposalByEntityId(
    entityId: string,
  ): { readonly status?: string; readonly dismissReason?: string } | undefined;
  /** PDCA:run 终态落定时改写本 run 提案的隔离标(正常=解除;degraded=固化) */
  setInsightClosureState(
    entityIds: readonly string[],
    degraded:
      | {
          readonly provisional: boolean;
          readonly unclosedGaps: readonly string[];
        }
      | undefined,
  ): void;
}

/** PDCA 证据面(宿主注入;结构 = SignalSink 的 flush + snapshot 窄化) */
export interface PonderEvidenceSource {
  flush(): Promise<void> | void;
  snapshot(): readonly ToolCallEvent[];
}

export interface IncubatorDeps {
  readonly repository: EngramRepository;
  readonly proposalEngine: IncubatorProposalSink;
  readonly dataRoot: string;
  /** L1 兜底 + critic 评审用 */
  readonly llmClient?: LlmClient;
  /** L2 执行器(宿主注入);缺省走 L1(宿主无 agent runtime) */
  readonly executor?: NightThinkingExecutor;
  readonly auditLog?: {
    append(entry: {
      readonly actor: string;
      readonly action: string;
      readonly engramId?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }): unknown;
  };
  readonly now?: () => string;
  /**
   * PDCA 证据源(Phase1):引擎侧调用流水快照(不消费 drain 队列)。
   * 缺省(未注入/旧部署)→ 闭合校验降级为「清单仅展示 + 种子源检查」,
   * 审计如实标注 pdca=evidence-off。
   */
  readonly signalEvidence?: PonderEvidenceSource;
  /** 修复 report 次数上限(clamp [1,10];缺省 INSIGHT_LIMITS.maxRepairRounds) */
  readonly repairRoundLimit?: number;
}

const INCUBATIONS_FILE = "incubations.json";

/** 条目硬上限:达限创建被拒,列出最老 10 条已答条目引导删除(不自动清理) */
const MAX_ENTRIES = 50;
/** 创建接近上限时 UI 预警的阈值 */
const ENTRY_WARN_THRESHOLD = 45;
/** 深思史回灌上限(prompt 长度保护;更早历史保留可见,不删) */
const HISTORY_CAP = 10;

function incubationsPath(dataRoot: string): string {
  return join(dataRoot, ".co-engram", INCUBATIONS_FILE);
}

/**
 * 种子空兜底(缺陷 D,2026-08-17):seedEngramIds 为空时用问题文本对全库做
 * FTS 检索取摘要级种子(用户没指定重点时给 L2 一个起点;协议仍要求全图谱
 * 盘点,种子只是提示不是边界)。索引不可用(损坏 / 测试 fake repo)时降级为
 * 无种子,不阻塞执行。
 */
function searchFallbackSeeds(
  repo: EngramRepository,
  question: string,
  cap = 8,
): NightThinkingTask["seedDigests"] {
  let lines: ReturnType<typeof collectDigestLines>;
  try {
    lines = collectDigestLines(repo).filter((l) => l.status === "active");
  } catch {
    return [];
  }
  if (lines.length === 0) return [];
  const index = buildFtsIndex(lines);
  const hits = searchFts(question, index, cap * 3);
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const out: Array<{
    id: string;
    title: string;
    summary: string;
    domainTags: readonly string[];
  }> = [];
  for (const hit of hits) {
    const line = byId.get(hit.docId);
    if (!line) continue;
    out.push({
      id: line.id,
      title: line.title,
      summary: line.summary,
      domainTags: line.domainTags ?? [],
    });
    if (out.length >= cap) break;
  }
  return out;
}

function parseAt(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * 夜思孵化器。读时始终从磁盘读(跨进程可见),写时仅 holder 落盘。
 */
/** report() 链的总超时:> executor 20min(DEFAULT_TIMEOUT_MS)+ report 的 LLM 余量 */
const REPORT_TIMEOUT_MS = 25 * 60_000;

export class Incubator {
  private readonly deps: IncubatorDeps;
  private readonly now: () => string;
  /** L1 兜底执行器(llmClient 存在时惰性构造) */
  private l1: {
    execute(t: NightThinkingTask): Promise<NightThinkingReport>;
  } | null = null;
  /** RMW 锁重入深度(同进程 delete/cancel 临界区内调 releaseThinking 等) */
  private storeLockDepth = 0;

  constructor(deps: IncubatorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ============================================================
  // 持久化(持锁写 + 读时状态归一化)
  // ============================================================

  private read(): IncubationEntry[] {
    let raw: string;
    try {
      raw = readFileSync(incubationsPath(this.deps.dataRoot), "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return (parsed as IncubationEntry[])
      .map((e) => this.normalize(e))
      .filter((e): e is IncubationEntry => e !== null);
  }

  private write(entries: readonly IncubationEntry[]): void {
    // 原子写:tmp + rename,读者永远看到完整文件(旧版或新版)。
    // 多进程互斥由 withStoreLock 的短临界区保证(调用方持有);本方法不自行
    // 加锁,禁止在临界区外调用。
    const path = incubationsPath(this.deps.dataRoot);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  }

  /**
   * incubations.json 的 RMW 短临界区:跨进程文件锁互斥「读-改-写」全程。
   * 同进程可重入(delete/cancel 在临界区内调 releaseThinking 等内部 mutator)。
   * 任何实例(含 maintenance 锁 non-holder)都能进临界区 —— 用户数据通道
   * 不受单写者门禁管辖(2026-08-19 修复,见模块头注释)。
   */
  private withStoreLock<T>(fn: () => T): T {
    if (this.storeLockDepth > 0) return fn();
    this.storeLockDepth += 1;
    const lock = acquireRmwLock(
      join(this.deps.dataRoot, ".co-engram", "incubations.lock"),
    );
    try {
      return fn();
    } finally {
      this.storeLockDepth -= 1;
      lock.release();
    }
  }

  /**
   * 读时归一化(2026-08-17 重设计的迁移层,无迁移脚本):
   * - 旧五态 → 三态:active(+rounds>0)/suggested-resolve/resolved/paused →
   *   done;active(rounds=0)→ queued;in-flight → thinking(TTL 过期按
   *   rounds 归 done/queued)
   * - 旧字段丢弃:schedule / webResearchOptIn / resumedAt / concludedAt;
   *   finalAnswer → answer 兜底;lastHatchedAt → lastRunAt;
   *   inFlightAt/inFlightBy → thinkingAt/thinkingBy
   * - timeline 旧事件:answerDraft → answer、answerDraftError → answerError
   *   (历史深思的回答呈现兼容);externalCallCount 等联网线字段丢弃
   */
  private normalize(e: IncubationEntry): IncubationEntry | null {
    if (!e || typeof e.id !== "string" || typeof e.question !== "string")
      return null;
    const rounds = e.rounds ?? 0;
    const raw = e as unknown as Record<string, unknown>;
    const timeline = Array.isArray(e.timeline)
      ? e.timeline.map((t) => {
          const ev = t as Record<string, unknown>;
          return {
            ...t,
            ...(typeof ev.answerDraft === "string" && ev.answer === undefined
              ? { answer: ev.answerDraft }
              : {}),
            ...(typeof ev.answerDraftError === "string" &&
            ev.answerError === undefined
              ? { answerError: ev.answerDraftError }
              : {}),
          } as IncubationTimelineEvent;
        })
      : [];
    const answer =
      typeof e.answer === "string"
        ? e.answer
        : typeof raw.finalAnswer === "string"
          ? (raw.finalAnswer as string)
          : timeline.length
            ? ([...timeline].reverse().find((t) => typeof t.answer === "string")
                ?.answer as string | undefined)
            : undefined;
    // 状态映射
    let status: IncubationStatus;
    const legacy = e.status as string;
    if (
      legacy === "thinking" ||
      legacy === "queued" ||
      legacy === "done" ||
      legacy === "verifying" ||
      legacy === "repairing"
    ) {
      status = legacy;
    } else if (legacy === "in-flight") {
      status = "thinking";
    } else if (
      legacy === "resolved" ||
      legacy === "paused" ||
      legacy === "suggested-resolve"
    ) {
      status = "done";
    } else {
      status = rounds > 0 ? "done" : "queued";
    }
    // thinking TTL 过期回收:跑过的回 done,没跑过的回 queued
    const thinkingAt = (e.thinkingAt ??
      (typeof raw.inFlightAt === "string"
        ? (raw.inFlightAt as string)
        : undefined)) as string | undefined;
    const thinkingBy = (e.thinkingBy ??
      (typeof raw.inFlightBy === "string"
        ? (raw.inFlightBy as string)
        : undefined)) as string | undefined;
    // PDCA 修复回路瞬态(verifying/repairing)TTL 过期 → 视为修复失败,
    // done + degraded(ttl-expired),未闭合缺口随 run 记录落盘(审批面可见)
    let degraded = e.degraded;
    let run = e.run;
    if (
      (status === "thinking" ||
        status === "verifying" ||
        status === "repairing") &&
      thinkingAt
    ) {
      // 用注入时钟(与写入同源),防测试/模拟时钟与真实时钟混用导致瞬态被误回收
      if (
        parseAt(this.now()) - parseAt(thinkingAt) >
        INSIGHT_LIMITS.inFlightTtlMs
      ) {
        if (status === "thinking") {
          status = rounds > 0 ? "done" : "queued";
        } else {
          // verifying/repairing:run 已开始(报告已交或修复中),超时按修复失败收束
          const unclosed = (run?.gaps ?? [])
            .filter((g) => g.state === "open")
            .map((g) => g.description);
          degraded = {
            at: this.now(),
            reason: "ttl-expired",
            unclosedGaps: unclosed,
          };
          run = undefined;
          status = "done";
        }
      }
    }
    const lastRunAt =
      e.lastRunAt ??
      (typeof raw.lastHatchedAt === "string"
        ? (raw.lastHatchedAt as string)
        : null);
    return {
      id: e.id,
      question: e.question,
      seedEngramIds: Array.isArray(e.seedEngramIds) ? e.seedEngramIds : [],
      status,
      rounds,
      createdAt: e.createdAt ?? this.now(),
      lastRunAt,
      timeline,
      ...(answer !== undefined ? { answer } : {}),
      ...(e.answerError !== undefined ? { answerError: e.answerError } : {}),
      ...(status === "thinking" ||
      status === "verifying" ||
      status === "repairing"
        ? {
            ...(thinkingAt ? { thinkingAt } : {}),
            ...(thinkingBy ? { thinkingBy } : {}),
            ...(run ? { run } : {}),
            ...(e.carryOverGaps ? { carryOverGaps: e.carryOverGaps } : {}),
          }
        : {}),
      ...(degraded ? { degraded } : {}),
      ...(e.consecutiveVetoed !== undefined
        ? { consecutiveVetoed: e.consecutiveVetoed }
        : {}),
    };
  }

  // ============================================================
  // CRUD
  // ============================================================

  create(input: {
    readonly question: string;
    readonly seedEngramIds?: readonly string[];
  }): IncubationEntry {
    const entry = this.withStoreLock(() => {
      const entries = this.read();
      // 同问题防重:未出过报告的条目(queued/进行中)已存在同问题 → 拒绝。
      // 覆盖双入口连击(viewer 按钮无反馈期重复点击、对话内重复说「帮我沉思 X」);
      // done 条目不拦(「重新深思同一问题」走再思/重建是正当场景)。
      const dup = entries.find(
        (e) => e.question === input.question.trim() && e.status !== "done",
      );
      if (dup) {
        throw new Error(
          `duplicate contemplation question (existing ${dup.id}, status=${dup.status}) — run or delete it instead`,
        );
      }
      if (entries.length >= MAX_ENTRIES) {
        // 不自动清理:删除属用户裁决。列出最老 10 条已答条目引导删除。
        const oldestDone = entries
          .filter((e) => e.status === "done")
          .sort(
            (a, b) =>
              parseAt(a.lastRunAt ?? a.createdAt) -
              parseAt(b.lastRunAt ?? b.createdAt),
          )
          .slice(0, 10)
          .map((e) => `- ${e.id} · ${e.question.slice(0, 60)}`)
          .join("\n");
        throw new Error(
          `contemplation limit reached (${entries.length}/${MAX_ENTRIES}) — delete oldest answered entries first. Oldest done entries:\n${oldestDone}`,
        );
      }
      const created: IncubationEntry = {
        id: `inc-${randomUUID().slice(0, 12)}`,
        question: input.question.trim(),
        seedEngramIds: [...(input.seedEngramIds ?? [])],
        status: "queued",
        rounds: 0,
        createdAt: this.now(),
        lastRunAt: null,
        timeline: [],
      };
      this.write([...entries, created]);
      return created;
    });
    this.deps.auditLog?.append({
      actor: "user",
      action: "contemplation_create",
      metadata: { id: entry.id, questionPreview: entry.question.slice(0, 120) },
    });
    return entry;
  }

  list(): readonly IncubationEntry[] {
    return this.read();
  }

  get(id: string): IncubationEntry | undefined {
    return this.read().find((e) => e.id === id);
  }

  /** 条目上限元信息(viewer 预警用) */
  limitInfo(): {
    readonly total: number;
    readonly max: number;
    readonly warnAt: number;
  } {
    return {
      total: this.read().length,
      max: MAX_ENTRIES,
      warnAt: ENTRY_WARN_THRESHOLD,
    };
  }

  /**
   * 删除条目(生命周期终点)。
   * 语义:删条目不删提案 —— 提案本体在 proposalEngine,走各自 accept/dismiss
   * 裁决流;深思历史(timeline)随条目一并移除。
   * force:进行中(thinking/verifying/repairing)默认拒绝(后台 run 可能写回);
   * force=true 先释放运行标记再删 —— 运行中的写回被 report 的写前重读
   * 拦截(条目不存在 → 放弃写入),不会复活。
   */
  delete(id: string, opts?: { readonly force?: boolean }): void {
    const { target, inFlight } = this.withStoreLock(() => {
      const entries = this.read();
      const found = entries.find((e) => e.id === id);
      if (!found) throw new Error(`incubation ${id} not found`);
      const inFlightNow =
        found.status === "thinking" ||
        found.status === "verifying" ||
        found.status === "repairing";
      if (inFlightNow && !opts?.force) {
        throw new Error(
          `incubation ${id} in progress (${found.status}) — cancel the run first or delete with force`,
        );
      }
      if (inFlightNow) this.releaseThinking(id);
      this.write(this.read().filter((e) => e.id !== id));
      return { target: found, inFlight: inFlightNow };
    });
    this.deps.auditLog?.append({
      actor: "user",
      action: "contemplation_delete",
      metadata: {
        id,
        questionPreview: target.question.slice(0, 120),
        sessions: target.rounds,
        ...(inFlight ? { abortedRun: true } : {}),
      },
    });
  }

  /**
   * 终止进行中的 run(2026-08-19:沉思可取消)。
   * 语义:thinking → 回可跑状态(rounds>0 → done,否则 queued,本次 run 视为
   * 未发生);verifying/repairing → releaseThinking 的降级收束(degraded
   * aborted,报告缺口留档)。后台 job 的写回由 report 写前重读拦截(状态已
   * 非 in-flight → 放弃),不会推翻本次取消裁决。审计 contemplation_run_cancel。
   */
  cancel(id: string, by = "user"): IncubationEntry {
    const target = this.get(id);
    if (!target) throw new Error(`incubation ${id} not found`);
    if (
      target.status !== "thinking" &&
      target.status !== "verifying" &&
      target.status !== "repairing"
    ) {
      throw new Error(`incubation ${id} not in progress (${target.status})`);
    }
    this.releaseThinking(id);
    this.deps.auditLog?.append({
      actor: "user",
      action: "contemplation_run_cancel",
      metadata: {
        id,
        by,
        fromStatus: target.status,
        questionPreview: target.question.slice(0, 120),
      },
    });
    const after = this.get(id);
    if (!after) throw new Error(`incubation ${id} vanished during cancel`);
    return after;
  }

  // ============================================================
  // thinking 原子标记(跨进程互斥)
  // ============================================================

  /** queued/done 均可开跑(再思);审计记 run_start;新 run 清旧 run/degraded 标,
   *  上轮未闭合缺口转存瞬态字段供计划生成接力(Phase2) */
  acquireThinking(id: string, by: string): boolean {
    const started = this.withStoreLock(
      ():
        | { readonly ok: true; readonly rounds: number }
        | { readonly ok: false } => {
        const entries = this.read();
        const target = entries.find((e) => e.id === id);
        if (!target) throw new Error(`incubation ${id} not found`);
        if (target.status !== "queued" && target.status !== "done")
          return { ok: false };
        const carryOver = [
          ...(target.degraded?.nextTasks ??
            target.degraded?.unclosedGaps ??
            []),
        ];
        const updated: IncubationEntry = {
          ...target,
          status: "thinking",
          thinkingAt: this.now(),
          thinkingBy: by,
          // degraded 是 run 级标记:再思开启新 run,旧标记随之失效;
          // 未闭合缺口先转存(接力输入),终束时清除
          ...(target.degraded ? { degraded: undefined } : {}),
          ...(carryOver.length ? { carryOverGaps: carryOver } : {}),
        };
        this.write(entries.map((e) => (e.id === id ? updated : e)));
        return { ok: true, rounds: target.rounds + 1 };
      },
    );
    if (!started.ok) return false;
    this.deps.auditLog?.append({
      actor: "system",
      action: "contemplation_run_start",
      metadata: { id, by, session: started.rounds },
    });
    return true;
  }

  releaseThinking(
    id: string,
    info?: {
      /** degraded 成因(缺省 aborted —— cancel / 执行器抛错等真中断) */
      readonly reason?: IncubationDegraded["reason"];
      /** 失败原因预览(落 entry.answerError,用户端可见) */
      readonly errorPreview?: string;
    },
  ): void {
    this.withStoreLock(() => {
      const entries = this.read();
      this.write(
        entries.map((e) => {
          if (e.id !== id) return e;
          if (e.status === "thinking") {
            // run 未产出报告:回退可跑状态(与旧语义一致)
            return {
              ...e,
              status: e.rounds > 0 ? "done" : "queued",
              thinkingAt: undefined,
              thinkingBy: undefined,
            };
          }
          if (e.status === "verifying" || e.status === "repairing") {
            // PDCA:报告已交、修复中断(执行器抛错/进程退出)—— 按修复失败
            // 收束为 degraded done,未闭合缺口留档;执行者可再思重跑。
            // 缺口清单回落链(2026-08-19 修复「未闭合需求:——」空展示):
            // run.gaps 的 open 项 → 空则 run.plan 全量(整单被闭合校验拒绝时
            // gaps 从未被逐项比对填充,计划项本身就是全部未闭合)。
            const fromGaps = (e.run?.gaps ?? [])
              .filter((g) => g.state === "open")
              .map((g) => g.description);
            const unclosed =
              fromGaps.length > 0
                ? fromGaps
                : (e.run?.plan?.items ?? []).map((it) => it.description);
            // 终态落定:本 run 提案隔离标翻转 —— 与 report 的 finalize 分支
            // 对齐。此前 releaseThinking 的全部收束路径都漏了翻转,提案停在
            // provisional 隔离态无人终裁(2026-08-19)。
            // 分流(2026-08-19 产品裁决):single-run-gaps → **解除**隔离 ——
            // 单跑沉思已交付 answer 与过审提案,计划部分缺口与提案质量是两个
            // 维度(提案过了机械校验 + critic 质量关),因缺口整批隔离对用户
            // 是噪音(部署实测用户两次成功深思的 3 条提案被打入隔离区);
            // 其余成因(修复失败/TTL/中断)保留固化隔离语义。
            const runEntityIds = e.timeline
              .filter((t) => t.round === e.rounds)
              .flatMap((t) => [...t.proposalEntityIds]);
            if (runEntityIds.length > 0) {
              try {
                this.deps.proposalEngine.setInsightClosureState(
                  runEntityIds,
                  info?.reason === "single-run-gaps"
                    ? undefined
                    : { provisional: false, unclosedGaps: unclosed },
                );
              } catch {
                // 提案翻转失败不阻塞条目收束;提案面仍按 provisional 展示
              }
            }
            return {
              ...e,
              status: "done" as const,
              thinkingAt: undefined,
              thinkingBy: undefined,
              run: undefined,
              degraded: {
                at: this.now(),
                reason: info?.reason ?? "aborted",
                unclosedGaps: unclosed,
              },
              ...(info?.errorPreview ? { answerError: info.errorPreview } : {}),
            };
          }
          return e;
        }),
      );
    });
  }

  // ============================================================
  // 深思史(回灌组装)与任务包
  // ============================================================

  /**
   * 启动恢复:固化超时 in-flight 条目的 TTL 收束(2026-08-19)。
   *
   * 进程内超时(executor 20min / report 链 25min)对「宿主进程自身死亡」
   * 无效 —— timer 随进程消失,链条悬挂且零审计(部署实测 inc-1093853c:
   * 驱动进程死亡,条目挂 thinking 3h+,audit 无 run_fail,journal 零日志)。
   * normalize 的 TTL 映射只在读时生效且不写盘(无人读 = 盘上永不回收)。
   * 每个宿主进程装配时调用一次:原始态与归一化态对比,被 TTL 回收的条目
   * 固化写盘并逐条审计 contemplation_recovered —— 恢复有痕、不依赖是否
   * 有人读。幂等:无可恢复条目时零写盘,多进程重复调用安全(锁内 RMW)。
   */
  recoverStale(): ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly reason: string;
  }> {
    const diffs: Array<{
      id: string;
      from: string;
      to: string;
      reason: string;
    }> = [];
    this.withStoreLock(() => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          readFileSync(incubationsPath(this.deps.dataRoot), "utf8"),
        );
      } catch {
        return; // 文件不存在/损坏:无恢复对象
      }
      if (!Array.isArray(parsed)) return;
      const rawEntries = parsed as IncubationEntry[];
      let changed = false;
      const next = rawEntries.map((raw) => {
        const norm = this.normalize(raw);
        // normalize 拒收的条目原样保留(恢复不删数据,与 read 的过滤语义不同)
        if (!norm) return raw;
        const wasInFlight =
          raw.status === "thinking" ||
          raw.status === "verifying" ||
          raw.status === "repairing";
        const settled = norm.status === "queued" || norm.status === "done";
        if (wasInFlight && settled) {
          changed = true;
          diffs.push({
            id: norm.id,
            from: raw.status,
            to: norm.status,
            reason: norm.degraded?.reason ?? "ttl-expired-thinking",
          });
          return norm; // 固化 TTL 映射结果(thinking→queued/done;verifying/repairing→done+degraded)
        }
        return raw; // 其余条目原样保留:恢复只处置超时 in-flight,不做全量归一化回写
      });
      if (changed) this.write(next);
    });
    for (const d of diffs) {
      this.deps.auditLog?.append({
        actor: "system",
        action: "contemplation_recovered",
        metadata: {
          id: d.id,
          fromStatus: d.from,
          toStatus: d.to,
          reason: d.reason,
        },
      });
    }
    return diffs;
  }


  /** 深思史(最近 HISTORY_CAP 次):过往洞察摘要 + accept/dismiss 理由(回灌防重复) */
  dreamHistoryFor(id: string): string {
    const entry = this.get(id);
    if (!entry) return "";
    const lines: string[] = [];
    for (const t of entry.timeline.slice(-HISTORY_CAP)) {
      const dispositions = t.proposalEntityIds.map((pid) => {
        const p = this.deps.proposalEngine.findProposalByEntityId(pid);
        if (!p) return "";
        if (p.status === "accepted") return " [accepted]";
        if (p.status === "dismissed") {
          return ` [dismissed: ${(p.dismissReason ?? "").slice(0, 60)}]`;
        }
        return " [pending]";
      });
      t.summaries.forEach((s, i) => {
        lines.push(
          `- Session ${t.round}(${t.trigger}): ${s}${dispositions[i] ?? ""}`,
        );
      });
      if (t.summaries.length === 0) {
        lines.push(
          `- Session ${t.round}(${t.trigger}): ${NO_SURVIVOR_MARKER}${t.note ? ` ${t.note}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  }

  /** queued 条目(供 REM 灵感模式合并;还没深思过的问题最有价值) */
  activeEntries(): ReadonlyArray<{
    id: string;
    question: string;
    dreamHistory: string;
  }> {
    return this.read()
      .filter((e) => e.status === "queued")
      .map((e) => ({
        id: e.id,
        question: e.question,
        dreamHistory: this.dreamHistoryFor(e.id),
      }));
  }

  /**
   * 组装 L2 任务包(ponder_run 工具返回;脱敏:种子摘要级内容)。
   * Phase2 计划先行:run 首次组装时生成需求拓扑并落盘 run.plan(LLM 从
   * 问题结构生成,无 llmClient 走机械模板;上轮未闭合缺口机械接力);
   * 修复轮重复调用只复用不重生成。
   */
  async buildTask(id: string): Promise<NightThinkingTask> {
    const entry = this.get(id);
    if (!entry) throw new Error(`incubation ${id} not found`);
    const seedDigests =
      entry.seedEngramIds.length > 0
        ? collectSeedDigests(this.deps.repository, entry.seedEngramIds)
        : searchFallbackSeeds(this.deps.repository, entry.question);
    let plan: PonderPlan | undefined = entry.run?.plan;
    if (!plan) {
      const input = {
        question: entry.question,
        seedTitles: seedDigests.map((s) => s.title),
        dreamHistory: this.dreamHistoryFor(id),
        carryOverGaps: [...(entry.carryOverGaps ?? [])],
      };
      plan = this.deps.llmClient
        ? await generateThinkPlan(this.deps.llmClient, input, this.now)
        : templatePlan(input, this.now);
      // 落盘(锁内读-改-写;已存在则尊重先写者)
      this.withStoreLock(() => {
        const fresh = this.read();
        const idx = fresh.findIndex((e) => e.id === id);
        if (idx !== -1 && !fresh[idx]!.run?.plan) {
          const target = fresh[idx]!;
          fresh[idx] = {
            ...target,
            run: {
              startedAt: target.thinkingAt ?? this.now(),
              reports: 0,
              repairReports: 0,
              gaps: [],
              plan,
            },
          };
          this.write(fresh);
        }
      });
      this.deps.auditLog?.append({
        actor: "system",
        action: "contemplation_plan_generated",
        metadata: {
          id,
          source: plan.source,
          items: plan.items.length,
          probes: plan.items.reduce((n, it) => n + it.probes.length, 0),
          carryOver: plan.items.filter((it) => it.carryOver).length,
        },
      });
    }
    return {
      incubationId: entry.id,
      question: entry.question,
      seedDigests,
      dreamHistory: this.dreamHistoryFor(id),
      resourceHints: collectResourceHints(this.deps.dataRoot),
      plan,
      protocol: buildProtocol(this.deps.repository.currentLanguage),
    };
  }

  // ============================================================
  // 执行(L2 主路径 / L1 无 executor 兜底)+ 唯一写回路径
  // ============================================================

  /**
   * 即时执行入口(viewer 异步 job / CLI)。
   * M2(2026-08-17):**不再静默降级** —— L2 执行失败显式抛错(run_fail 审计),
   * 唯一例外是 spawn ENOENT(环境无 claude CLI,一次性配置问题):降级 L1 并
   * 在 run_done 审计如实标注 level=L1-env。无 executor(宿主未注入)走 L1。
   */
  async incubateOnce(
    id: string,
    trigger: "manual" | "scheduled",
  ): Promise<{
    proposals: number;
    cycleVetoed: boolean;
    level: "L1" | "L2";
    entry: IncubationEntry;
  }> {
    const entry = this.get(id);
    if (!entry) throw new Error(`incubation ${id} not found`);
    if (entry.status !== "queued" && entry.status !== "done") {
      throw new Error(`incubation ${id} not runnable (status=${entry.status})`);
    }
    if (!this.acquireThinking(id, `incubateOnce:${trigger}`)) {
      throw new Error(`incubation ${id} already thinking`);
    }
    const startedAt = Date.now();
    const task = await this.buildTask(id);
    // 种子空兜底留痕(缺陷 D):显式种子为空但任务包拿到了种子 → 记审计,
    // audit 查询 / viewer 可区分「本轮种子来自兜底检索」与「用户指定」
    if (entry.seedEngramIds.length === 0 && task.seedDigests.length > 0) {
      this.deps.auditLog?.append({
        actor: "system",
        action: "contemplation_seed_fallback",
        metadata: {
          incubationId: id,
          seeded: task.seedDigests.length,
          questionPreview: entry.question.slice(0, 80),
        },
      });
    }
    let report: NightThinkingReport;
    let level: "L1" | "L2";
    try {
      if (this.deps.executor) {
        try {
          report = await this.deps.executor.execute(task);
          level = "L2";
        } catch (err) {
          // spawn ENOENT = 环境无 claude CLI(配置缺失,非本轮失败):
          // 降级 L1 让沉思仍可用,审计如实标注;其余失败(超时/解析/非零
          // 退出)显式抛错 —— 静默降级曾让用户长期吃 L1 产物而无从知晓。
          const isEnoent = err instanceof Error && /ENOENT/i.test(err.message);
          if (!isEnoent) throw err;
          report = await this.runL1(task);
          level = "L1";
        }
      } else {
        report = await this.runL1(task);
        level = "L1";
      }
      // report 总超时(2026-08-19 E2E 实测缺陷):executor 有 20min 超时,但
      // report() 内部存在无超时的 LLM await(critic / 综合 / 主张抽取)——
      // headless 进程死亡或 LLM 挂起时链条悬挂,条目挂 thinking 直到 30min
      // TTL,用户全程无反馈。外层总超时兜底(25min > executor 20min + report
      // 余量);超时按 aborted 收束,迟到的 report 写回由「写前重读拦截」
      //(commit 的 cancelled 分支:状态非 in-flight 即放弃)自然丢弃。
      let reportTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.report({
          incubationId: id,
          report,
          trigger,
          actor: `contemplation-${level}`,
          level,
          durationMs: Date.now() - startedAt,
        }),
        new Promise<never>((_, reject) => {
          reportTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `contemplation report timeout (${REPORT_TIMEOUT_MS}ms) — report 链存在无超时 await`,
                ),
              ),
            REPORT_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (reportTimer) clearTimeout(reportTimer);
      });
      // 单跑收尾(2026-08-19):report 带 openGaps 时条目停在 repairing 等
      // 修复轮 —— 修复轮只存在于 MCP 现场会话(执行者可再调 ponder_report);
      // incubateOnce 驱动的 headless 单跑没有后续轮,会挂到 30min TTL,页面
      // 呈现「无终态」。answer 与洞察提案已交付,缺口按单轮收束立即终态化
      //(releaseThinking 内同步翻转提案隔离标)。
      if (this.get(id)?.status === "repairing") {
        this.releaseThinking(id, { reason: "single-run-gaps" });
      }
      return { ...result, level };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(
        0,
        200,
      );
      // 闭合校验拒绝是「报告未通过证据核验」而非执行中断 —— 成因与失败
      // 原因落 entry(degraded.reason / answerError),用户端「带缺口收束」
      // 不再显示为「执行中断 + 未闭合需求空清单」(2026-08-19 部署实测)。
      this.releaseThinking(id, {
        reason: /rejected by closure check/.test(msg)
          ? "closure-rejected"
          : "aborted",
        errorPreview: msg,
      });
      this.deps.auditLog?.append({
        actor: "system",
        action: "contemplation_run_fail",
        metadata: { id, errorPreview: msg },
      });
      throw err;
    }
  }

  private async runL1(task: NightThinkingTask): Promise<NightThinkingReport> {
    if (!this.deps.llmClient) {
      throw new Error("L1 unavailable: no llmClient injected");
    }
    if (!this.l1)
      this.l1 = createL1Executor(this.deps.llmClient, this.deps.repository);
    return this.l1.execute(task);
  }

  /**
   * 唯一写回路径(L2 agent 的 ponder_report / L1 内部共用):
   * PDCA 闭合校验(Phase1)→ 机械校验 + 独立 critic + 循环检测 + timeline。
   *
   * 状态机:thinking(主报告)/ verifying|repairing(修复轮)进入 → 先落
   * verifying(瞬态,TTL 回收)→ 校验三分支:
   * - 全闭合 → done(提案隔离标解除);
   * - 有阻塞缺口且预算未耗尽 → repairing,缺口清单随返回,执行者修复后
   *   全量重报(修复 report ≤ repairRoundLimit 次);
   * - 预算触顶(修复轮用尽 / 累计缺口超限)→ done + degraded,本 run
   *   提案固化隔离标(默认不进审批队列,viewer 置顶未闭合清单)。
   *
   * 回答:M1 —— L2 报告自带 answer 时直接采用(执行现场生产);否则用
   * synthesizeAnswerDraft 兜底(L1 路径),失败记 answerError,不降级拼接。
   * critic 遵循第一关语义:独立第二次调用、fail-closed(无 llmClient /
   * 不可解析 / 低于阈值 → 不出提案)。
   */
  async report(input: {
    readonly incubationId: string;
    readonly report: NightThinkingReport;
    readonly trigger: "manual" | "scheduled";
    readonly actor: string;
    /** 执行档位(审计;agent 现场执行视为 L2) */
    readonly level?: "L1" | "L2";
    readonly durationMs?: number;
  }): Promise<{
    proposals: number;
    cycleVetoed: boolean;
    entry: IncubationEntry;
    /** PDCA:repairing 时随返回的开放缺口(执行者修复目标) */
    readonly openGaps: readonly PonderGap[];
    /** PDCA:本次是否 degraded 终束 */
    readonly degraded: boolean;
    /** PDCA:本次 report 的修复轮序(主报告 = 0) */
    readonly repairRound: number;
    /** PDCA:超额被 deferred 的新缺口描述 */
    readonly deferredGaps: readonly string[];
  }> {
    const entry = this.withStoreLock(() => {
      const entries = this.read();
      const idx = entries.findIndex((e) => e.id === input.incubationId);
      if (idx === -1)
        throw new Error(`incubation ${input.incubationId} not found`);
      const found = entries[idx]!;
      if (found.status === "queued" || found.status === "done") {
        throw new Error(
          `incubation ${input.incubationId} has no active run (status=${found.status}) — call ponder_run first`,
        );
      }
      // 落 verifying 瞬态(校验中;崩溃由 TTL 回收)。thinkingAt 保留:
      // 既是证据时间窗起点也是 TTL 基准。
      this.write(
        entries.map((e) =>
          e.id === found.id ? { ...e, status: "verifying" } : e,
        ),
      );
      return found;
    });

    // ---- PDCA 闭合校验(Phase1:清单自报、证据事实化) ----
    const level = input.level ?? "L2";
    const evidenceAvailable = !!this.deps.signalEvidence && !!entry.thinkingAt;
    const runState: PonderRunState = entry.run ?? {
      startedAt: entry.thinkingAt ?? this.now(),
      reports: 0,
      repairReports: 0,
      gaps: [],
    };
    // 主报告判定:本 run 还没有成功落盘过 report(reports=0 覆盖崩溃重试:
    // verifying 入口但 timeline 未写成 → 仍是主报告,rounds 递增)
    const isMainReport = runState.reports === 0;
    const nextRound = isMainReport ? entry.rounds + 1 : entry.rounds;

    // ---- Phase3 P6:答案相邻复读检测(与上一 run 最终答案比;标记+审计,
    //      不阻塞 ——「上轮结论仍成立」是正当场景,v7 要求检查而非禁止) ----
    const cutoffRound = isMainReport ? nextRound : entry.rounds;
    const prevRunAnswer = [...entry.timeline]
      .filter((t) => t.round < cutoffRound && typeof t.answer === "string")
      .reverse()
      .find((t) => typeof t.answer === "string")?.answer;
    const answerRepeat =
      !!input.report.answer?.trim() &&
      !!prevRunAnswer &&
      contentJaccard(input.report.answer, prevRunAnswer) >=
        INSIGHT_LIMITS.dreamJaccard;

    // ---- Phase3 P7:主张对手抽取(独立 critic 从执行者 answer 抽取;
    //      fail-open —— 质量信号而非形式闸,LLM 不可用即跳过) ----
    const claimsResult =
      level === "L2" &&
      evidenceAvailable &&
      this.deps.llmClient &&
      input.report.answer?.trim()
        ? await extractClaims(this.deps.llmClient, input.report.answer)
        : undefined;
    const claimsWeak = !!claimsResult?.weak;

    let events: readonly ToolCallEvent[] = [];
    if (evidenceAvailable) {
      // flush 把 sink 缓冲(≤5s/50条)落盘,snapshot 读取不消费 drain 队列。
      // 时间窗严格 [thinkingAt, ∞):at 是调用时刻(非落盘时刻),flush 已
      // 解决延迟 —— 不回溯容差,否则上一 run 刚执行的空探测会污染本 run
      // 的 P1 豁免判定(「资源不存在」被假证明,跨 run 证据污染)。
      await this.deps.signalEvidence!.flush();
      const since = parseAt(entry.thinkingAt!);
      events = this.deps
        .signalEvidence!.snapshot()
        .filter((e) => e.at >= since);
    }
    const digest = digestEvidence(events);
    // Phase2 计划先行:计划 → 有效需求集(P5 防收窄:P1 自动豁免)
    const planItems = runState.plan?.items ?? [];
    const applied = applyPlanToRequirements(
      planItems,
      input.report.requirements,
      digest,
    );
    const reqCheck = checkRequirements(applied.effective, digest, {
      level,
      evidenceAvailable,
      ...(applied.origins.length ? { origins: applied.origins } : {}),
    });
    if (reqCheck.reject) {
      this.deps.auditLog?.append({
        actor: input.actor,
        action: "contemplation_gap_check",
        metadata: { id: entry.id, rejected: reqCheck.reject },
      });
      // 整单退回(瞒报/零盘点):不进修复回路,修正清单后重报。
      // 状态停在 verifying(重报入口仍判定为主报告/修复轮)。
      throw new Error(`report rejected by closure check: ${reqCheck.reject}`);
    }
    // P1 豁免留痕:自动豁免的计划项在 gap 记录上标 probe-empty
    const exemptSet = new Set(applied.exempted);
    const currentGaps = reqCheck.current.map((g) =>
      exemptSet.has(g.description) && g.state === "closed"
        ? { ...g, exempt: "probe-empty" as const }
        : g,
    );
    const advanced = advanceGaps(runState.gaps, currentGaps);
    const repairReports = isMainReport ? 0 : runState.repairReports + 1;
    const repairLimit = Math.max(
      1,
      Math.min(
        10,
        this.deps.repairRoundLimit ?? INSIGHT_LIMITS.maxRepairRounds,
      ),
    );
    const blocking = advanced.blocking;
    // 终束只能由预算耗尽触发(P3:重报不是终束理由)
    const repairExhausted = blocking && repairReports >= repairLimit;
    const gapBudgetExhausted = blocking && advanced.totalBudgetExhausted;
    const finalize = !blocking || repairExhausted || gapBudgetExhausted;
    const openGapDescs = advanced.gaps
      .filter((g) => g.state === "open")
      .map((g) => g.description);
    let degradedFinal: IncubationDegraded | undefined;
    if (finalize && blocking) {
      degradedFinal = {
        at: this.now(),
        reason: gapBudgetExhausted
          ? "gap-budget-exhausted"
          : "repair-budget-exhausted",
        unclosedGaps: openGapDescs,
      };
      // Phase3 P8:接力权转移 —— critic 生成下轮验证任务(含至少一条外部
      // 资源型,机械保证);LLM 失败退化用缺口原文(generateNextTasks 内兜底)
      if (this.deps.llmClient) {
        const tasks = await generateNextTasks(this.deps.llmClient, {
          question: entry.question,
          unclosedGaps: openGapDescs,
          answer: input.report.answer ?? "",
        });
        if (tasks.length)
          degradedFinal = { ...degradedFinal, nextTasks: tasks };
      }
    }
    // run 未闭合期间提案带隔离标;终态落定时翻转(见本函数尾)。
    // Phase3 P7:终束但答案弱支撑(降级主张占比 > 30%)→ 提案固化隔离
    // (不改 run 终态 —— 资源闭合与答案支撑是两个维度)
    const claimsWeakNote = claimsResult
      ? [
          `答案弱支撑:降级主张占比 ${(claimsResult.downgradeRatio * 100).toFixed(0)}%(阈值 30%),` +
            `洞察提案隔离待人工复核`,
        ]
      : [];
    const proposalDegraded = degradedFinal
      ? { provisional: false, unclosedGaps: degradedFinal.unclosedGaps }
      : !finalize
        ? { provisional: true, unclosedGaps: openGapDescs }
        : claimsWeak
          ? { provisional: false, unclosedGaps: claimsWeakNote }
          : undefined;

    // ---- 循环检测:与过往每次洞察摘要逐一对比(整体 blob 会被稀释,
    //      逐条对比才能稳定命中),Jaccard ≥ dreamJaccard → 该条作废 ----
    const pastSummaries = entry.timeline.flatMap((t) => [...t.summaries]);
    const survived: InsightDraft[] = [];
    let vetoed = 0;
    for (const d of input.report.insights) {
      const draftText = `${d.title}\n${d.summary}`;
      const dup = pastSummaries.some(
        (s) => contentJaccard(draftText, s) >= INSIGHT_LIMITS.dreamJaccard,
      );
      if (dup) {
        vetoed += 1;
        continue;
      }
      survived.push(d);
    }
    const allVetoed =
      input.report.insights.length > 0 &&
      vetoed === input.report.insights.length;

    // ---- 种子源检查(P2 零增量拦截):种子是起点提示不是边界,洞察
    //      sourceIds 全部来自任务包种子 = 没有为问题开采任何新证据 ----
    const seedIdSet = new Set<string>(entry.seedEngramIds);
    if (entry.seedEngramIds.length === 0) {
      // 兜底种子引擎可复算(确定性 FTS;repo 只读协议下结果稳定)
      for (const s of searchFallbackSeeds(
        this.deps.repository,
        entry.question,
      )) {
        seedIdSet.add(s.id);
      }
    }

    // ---- 机械校验 + 独立 critic → rem-insight 提案(捕获即时成提案) ----
    const summaries: string[] = [];
    const entityIds: string[] = [];
    /** 综合证据面:成案草稿的「标题 — 摘要」(timeline.summaries 仍只存
     * title(Jaccard 语料不变),仅兜底综合拿到更宽的证据面) */
    const draftEvidence: string[] = [];
    const threshold = DEFAULT_REM_INSIGHT.criticThreshold;
    let validateRejected = 0;
    let criticRejected = 0;
    /** 逐条拒因(title 前缀 + reason;诊断可达性:计数区分不了成因) */
    const rejectReasons: string[] = [];
    for (const d of survived) {
      // 种子源拦截先于引用闭合:全引种子 = 零增量开采,过了 validate 也是
      // 形式合规的表演(subgraph 由 sourceIds 自身构造,引用闭合恒真)
      if (isSeedOnlySources(d.sourceIds, seedIdSet)) {
        validateRejected += 1;
        rejectReasons.push(
          `[seed-only] ${d.title.slice(0, 40)}: all sourceIds come from the task seeds — mine the graph beyond the starting hints`,
        );
        continue;
      }
      const sub = this.subgraphFor(d);
      const v = validateInsightDraft(
        d,
        sub,
        this.deps.repository,
        this.deps.proposalEngine.listAll(),
      );
      if (!v.ok) {
        validateRejected += 1;
        rejectReasons.push(`[validate] ${d.title.slice(0, 40)}: ${v.reason}`);
        continue;
      }
      // fail-closed:无 llmClient 即无独立 critic → 不出提案
      // (静默 continue:llmClientMissing 已由 diagnosis 字段表达)
      if (!this.deps.llmClient) continue;
      const score = await critique(
        this.deps.llmClient,
        d,
        sub,
        d.mode,
        this.deps.repository.currentLanguage,
      );
      if (!score || score.overall < threshold) {
        criticRejected += 1;
        rejectReasons.push(
          `[critic] ${d.title.slice(0, 40)}: ${score ? score.overall.toFixed(2) : "unparseable"} < ${threshold}`,
        );
        continue;
      }
      const entityId = insightEntityId(
        d.mode,
        entry.id,
        nextRound,
        d.sourceIds,
      );
      const ok = this.deps.proposalEngine.proposeInsight({
        mode: d.mode,
        insightType: d.type,
        title: d.title,
        content: d.content,
        summary: d.summary,
        domainTags: d.domainTags,
        sourceIds: d.sourceIds,
        criticScore: score.overall,
        criticRationale: score.rationale,
        incubationId: entry.id,
        round: nextRound,
        ...(proposalDegraded ? { degraded: proposalDegraded } : {}),
      });
      if (ok) {
        summaries.push(d.title);
        draftEvidence.push(`${d.title} — ${d.summary}`);
        entityIds.push(entityId);
      }
    }

    // ---- 资源申报清洗(「依据」区):engram id 逐个试读,编造 id 不落盘 ----
    const resourcesUsed = this.sanitizeResources(input.report.resourcesUsed);

    // ---- 回答(M1:执行现场 answer 优先,综合层兜底) ----
    // dreamHistoryFor 此时读盘仍是旧 timeline(新事件尚未落盘)→ 天然「至上一次」
    const traceSummary = input.report.trace
      .slice(0, 40)
      .map((t) => `${t.step}: ${t.action} — ${t.detail}`.slice(0, 160));
    const planSummary = input.report.plan
      .slice(0, 10)
      .map((p) => `${p.step} — ${p.capability}`.slice(0, 160));
    let answer: string | undefined = input.report.answer?.trim() || undefined;
    let answerError: string | undefined;
    if (!answer) {
      if (!this.deps.llmClient) {
        answerError = "llmClient unavailable";
      } else {
        try {
          answer = await synthesizeAnswerDraft(
            this.deps.llmClient,
            entry.question,
            this.dreamHistoryFor(entry.id),
            draftEvidence,
            { rejectReasons, traceSummary },
          );
        } catch (err) {
          answerError = (
            err instanceof Error ? err.message : String(err)
          ).slice(0, 200);
        }
      }
    }

    // ---- session 推进 + timeline 落盘 ----
    const consecutive = allVetoed ? (entry.consecutiveVetoed ?? 0) + 1 : 0;
    const note = allVetoed ? "all insights vetoed as duplicates" : undefined;
    const diagnosis = {
      drafts: input.report.insights.length,
      dupVetoed: vetoed,
      validateRejected,
      criticRejected,
      llmClientMissing: !this.deps.llmClient,
      ...(rejectReasons.length ? { rejectReasons } : {}),
    };
    const timeline: IncubationTimelineEvent[] = [
      ...entry.timeline,
      {
        at: this.now(),
        trigger: input.trigger,
        round: nextRound,
        summaries,
        proposalEntityIds: entityIds,
        diagnosis,
        ...(planSummary.length ? { plan: planSummary } : {}),
        ...(traceSummary.length ? { trace: traceSummary } : {}),
        ...(resourcesUsed ? { resourcesUsed } : {}),
        ...(answer ? { answer } : {}),
        ...(answerError ? { answerError } : {}),
        ...(note ? { note } : {}),
        pdca: {
          repairRound: repairReports,
          openGaps: openGapDescs.slice(0, 10),
          closedThisRound: reqCheck.current.filter((g) => g.state === "closed")
            .length,
          degraded: !!degradedFinal,
          ...(advanced.deferredThisRound.length
            ? { deferred: advanced.deferredThisRound }
            : {}),
          ...(applied.narrowed.length
            ? { narrowed: applied.narrowed.slice(0, 10) }
            : {}),
          ...(applied.exempted.length
            ? { exempted: applied.exempted.slice(0, 10) }
            : {}),
          ...(answerRepeat ? { answerRepeat: true } : {}),
          ...(claimsResult
            ? {
                answerDowngradeRatio: Number(
                  claimsResult.downgradeRatio.toFixed(2),
                ),
              }
            : { claimsSkipped: true }),
        },
        ...(claimsResult?.claims.length
          ? { answerClaims: claimsResult.claims }
          : {}),
      },
    ];
    const nextRunState: PonderRunState | undefined = finalize
      ? undefined
      : {
          ...runState,
          reports: runState.reports + 1,
          repairReports,
          gaps: advanced.gaps,
        };
    const updated: IncubationEntry = {
      ...entry,
      status: finalize ? "done" : "repairing",
      rounds: nextRound,
      lastRunAt: this.now(),
      timeline,
      consecutiveVetoed: consecutive,
      // repairing 保留 thinkingAt/thinkingBy(证据窗口与 TTL 基准);done 清除
      ...(finalize
        ? { thinkingAt: undefined, thinkingBy: undefined, run: undefined }
        : {
            ...(entry.thinkingAt ? { thinkingAt: entry.thinkingAt } : {}),
            ...(entry.thinkingBy ? { thinkingBy: entry.thinkingBy } : {}),
            run: nextRunState,
          }),
      ...(degradedFinal
        ? { degraded: degradedFinal }
        : { degraded: undefined }),
      ...(answer ? { answer } : { answer: undefined }),
      ...(answerError ? { answerError } : { answerError: undefined }),
    };
    // 写前重读合并(锁内临界区):report 中途有 await(critic/综合走 LLM),
    // 若仍基于开头快照整文件覆写,会回滚期间其他进程/用户的写;本条目轮中
    // 用户删除等裁决优先保留,其余字段(timeline/rounds 等)用本轮计算值。
    const commit = this.withStoreLock(
      ():
        | { readonly kind: "cancelled"; readonly current: IncubationEntry }
        | { readonly kind: "deleted" }
        | {
            readonly kind: "written";
            readonly finalEntry: IncubationEntry;
          } => {
        const fresh = this.read();
        const freshIdx = fresh.findIndex((x) => x.id === entry.id);
        // 条目被并发取消(cancel → releaseThinking,状态已非 in-flight):
        // 放弃写回 —— 落盘会推翻用户的终止裁决(状态被报告强行拉回 done)。
        // 与下方"被删除"分支同构:用户裁决优先于迟到的报告。
        if (
          freshIdx !== -1 &&
          fresh[freshIdx]!.status !== "thinking" &&
          fresh[freshIdx]!.status !== "verifying" &&
          fresh[freshIdx]!.status !== "repairing"
        ) {
          return { kind: "cancelled", current: fresh[freshIdx]! };
        }
        if (freshIdx === -1) {
          // 本条目被并发删除:放弃写入(不复活已删条目)
          return { kind: "deleted" };
        }
        const finalEntry: IncubationEntry = {
          ...updated,
          status: updated.status,
        };
        const next = [...fresh];
        next[freshIdx] = finalEntry;
        // 终态落定:本 run 全部提案的隔离标翻转(正常终束解除;degraded 固化)。
        // 本 run 的提案 = timeline 中 round=nextRound 的全部事件(主报告 + 修复轮)
        if (
          finalize &&
          entityIds.length +
            timeline.filter((t) => t.round === nextRound).length >
            0
        ) {
          const runEntityIds = [
            ...entry.timeline
              .filter((t) => t.round === nextRound)
              .flatMap((t) => [...t.proposalEntityIds]),
            ...entityIds,
          ];
          if (runEntityIds.length > 0) {
            this.deps.proposalEngine.setInsightClosureState(
              runEntityIds,
              degradedFinal
                ? {
                    provisional: false,
                    unclosedGaps: degradedFinal.unclosedGaps,
                  }
                : claimsWeak
                  ? { provisional: false, unclosedGaps: claimsWeakNote }
                  : undefined,
            );
          }
        }
        // 轮次审计(viewer 可查):diagnosis 以嵌套对象直落 metadata;回答仅记
        // 200 字预览防爆噪;level 是执行档位(M2:不进 UI,仅审计可达);pdca
        // 记修复回路状态(Phase1)。与 write 同临界区,保持盘上状态与审计痕次序。
        this.deps.auditLog?.append({
          actor: input.actor,
          action: "contemplation_run_done",
          metadata: {
            id: entry.id,
            round: nextRound,
            trigger: input.trigger,
            level: input.level ?? "L2",
            ...(input.durationMs !== undefined
              ? { durationMs: input.durationMs }
              : {}),
            proposals: entityIds.length,
            drafts: input.report.insights.length,
            diagnosis,
            ...(answer ? { answerPreview: answer.slice(0, 200) } : {}),
            pdca: {
              evidenceAvailable,
              repairRound: repairReports,
              openGaps: openGapDescs.length,
              gapsTotal: advanced.gaps.length,
              deferred: advanced.deferredThisRound.length,
              degraded: !!degradedFinal,
              ...(degradedFinal
                ? { degradedReason: degradedFinal.reason }
                : {}),
              ...(planItems.length
                ? {
                    planItems: planItems.length,
                    planNarrowed: applied.narrowed.length,
                    planExempted: applied.exempted.length,
                  }
                : {}),
              ...(answerRepeat ? { answerRepeat: true } : {}),
              ...(claimsResult
                ? {
                    claims: claimsResult.claims.length,
                    claimsDowngraded: claimsResult.claims.filter(
                      (c) => c.status === "downgraded",
                    ).length,
                    claimsWeak,
                  }
                : { claimsSkipped: true }),
              ...(degradedFinal?.nextTasks?.length
                ? { nextTasks: degradedFinal.nextTasks.length }
                : {}),
            },
          },
        });
        this.write(next);
        return { kind: "written", finalEntry };
      },
    );
    if (commit.kind !== "written") {
      // 用户裁决优先:并发取消(取盘上终态)或并发删除(取本轮计算值)
      return {
        proposals: entityIds.length,
        cycleVetoed: allVetoed,
        entry: commit.kind === "cancelled" ? commit.current : updated,
        openGaps: advanced.gaps.filter((g) => g.state === "open"),
        degraded: !!degradedFinal,
        repairRound: repairReports,
        deferredGaps: advanced.deferredThisRound,
      };
    }
    return {
      proposals: entityIds.length,
      cycleVetoed: allVetoed,
      entry: commit.finalEntry,
      openGaps: advanced.gaps.filter((g) => g.state === "open"),
      degraded: !!degradedFinal,
      repairRound: repairReports,
      deferredGaps: advanced.deferredThisRound,
    };
  }

  /** 资源申报清洗:engram id 逐个试读(repo 存在才留);skills/logs 去空去重;web 按 query 清洗去重 */
  private sanitizeResources(
    r: NightThinkingResourcesUsed | undefined,
  ): NightThinkingResourcesUsed | undefined {
    if (!r) return undefined;
    const engrams = [...new Set(r.engrams ?? [])].filter((id) => {
      if (typeof id !== "string" || !id) return false;
      try {
        this.deps.repository.readEngram(id);
        return true;
      } catch {
        return false;
      }
    });
    const skills = [
      ...new Set(
        (r.skills ?? []).filter(
          (s): s is string => typeof s === "string" && !!s,
        ),
      ),
    ];
    const logs = [
      ...new Set(
        (r.logs ?? []).filter((l): l is string => typeof l === "string" && !!l),
      ),
    ];
    const webMap = new Map<string, WebResourceUsed>();
    for (const w of Array.isArray(r.web) ? r.web : []) {
      if (!w || typeof w.query !== "string" || !w.query.trim()) continue;
      const key = w.query.trim().slice(0, 300);
      if (!webMap.has(key)) webMap.set(key, w); // 同报告内重复申报:保留首条
    }
    const web = [...webMap.values()].map((w) => ({
      query: w.query.trim().slice(0, 300),
      ...(typeof w.purpose === "string" && w.purpose.trim()
        ? { purpose: w.purpose.trim().slice(0, 300) }
        : {}),
    }));
    if (
      engrams.length === 0 &&
      skills.length === 0 &&
      logs.length === 0 &&
      web.length === 0
    ) {
      return undefined;
    }
    return { engrams, skills, logs, ...(web.length ? { web } : {}) };
  }

  /** 由 sourceIds 构造最小校验子图(节点来自 repo;不存在者由引用闭合拒绝) */
  private subgraphFor(
    d: InsightDraft,
  ): Parameters<typeof validateInsightDraft>[1] {
    const nodes = [];
    for (const id of new Set(d.sourceIds)) {
      try {
        const e = this.deps.repository.readEngram(id);
        nodes.push({
          id: e.id,
          title: e.title,
          summary: e.summary,
          domainTags: e.domainTags ?? [],
          kind: e.kind,
          importance: e.importance,
          confidence: e.confidence,
          verificationStatus: e.verificationStatus ?? null,
          retrievalCount: e.retrievalCount,
          failedUses: e.failedUses,
          reinforcementScore: e.reinforcementScore,
          freshness: e.updatedAt,
          isSeed: true,
          activation: 1,
        });
      } catch {
        // 来源不存在 → validate 的引用闭合会拒绝
      }
    }
    return { nodes, edges: [], globalStats: { source: "incubation" } };
  }
}
