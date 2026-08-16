/**
 * 夜思孵化器(spec §四)—— incubations.json 侧车 + Dormio 协议 + 双级执行。
 *
 * 设计要点:
 * - **从 runRem 解耦**:REM 只是调度来源之一;即时触发(对话/viewer/CLI)与
 *   独立日调度(light tick,锚点时刻制每日一轮)都是独立调用方
 * - **incubations.json 持锁写**:与 maintenance-state 同款模式,仅 processLock
 *   holder 落盘,防多进程 lost-update
 * - **in-flight 原子标记**:跨进程互斥(REM 进程/即时触发/CLI 共用),TTL 30min
 *   过期自动回收,防 rounds 双计与梦境史互相覆盖
 * - **incubation_report 是 L2 唯一写回路径**:机械校验 + 独立 critic →
 *   rem-insight 提案(entityId 纳入轮次);捕获即时成提案,不等不攒
 * - **回灌迭代**:每轮 prompt 携带完整梦境史;循环检测(Jaccard ≥ 0.65 本轮
 *   作废;连续 2 轮全撞 → paused「孵化空间已充分探索」);默认 5 轮上限,
 *   无 accept 到限 → paused + 提示用户裁决
 *
 * @module @co-engram/core/maintenance/insight
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { insightEntityId } from "../../observability/proposal-engine.js";
import { critique } from "./critic.js";
import {
  createL1Executor,
  collectResourceHints,
  collectSeedDigests,
  buildProtocol,
  synthesizeAnswerDraft,
  synthesizeFinalAnswer,
  NO_SURVIVOR_MARKER,
} from "./night-thinking.js";
import type {
  InsightDraft,
  NightThinkingReport,
  NightThinkingTask,
  NightThinkingExecutor,
} from "./types.js";
import { DEFAULT_REM_INSIGHT, INSIGHT_LIMITS, SCHEDULE_RE } from "./types.js";
import { contentJaccard, validateInsightDraft, type ProposalLike } from "./validate.js";

/** 孵化条目状态:lifecycle + in-flight 瞬态(崩溃后 TTL 回收) */
export type IncubationStatus =
  | "active"
  | "in-flight"
  | "suggested-resolve"
  | "resolved"
  | "paused";

/** 夜思时间线单夜记录(同一时间线,trigger 区分手动/调度) */
export interface IncubationTimelineEvent {
  readonly at: string;
  readonly trigger: "manual" | "scheduled";
  readonly round: number;
  /** 本夜洞察摘要(捕获即记;accept/dismiss 状态经提案实时解析) */
  readonly summaries: readonly string[];
  readonly proposalEntityIds: readonly string[];
  /** 本夜外部调用数(审计留痕计数) */
  readonly externalCallCount: number;
  /** 空转诊断:各关计数(spec §三) */
  readonly diagnosis?: {
    readonly drafts: number;
    readonly dupVetoed: number;
    readonly validateRejected: number;
    readonly criticRejected: number;
    readonly llmClientMissing: boolean;
    /**
     * 逐条拒绝原因(title 前缀 + reason;validate/critic 两关)。
     * 2026-08-16 机制缺陷修复:只有计数无法区分「引用闭合拒」的具体成因
     * (no sourceIds / 不在库 / 非 engram 来源),事后诊断不可达。
     */
    readonly rejectReasons?: readonly string[];
  };
  /**
   * 执行层轨迹摘要(step: action — detail,每条截断,上限保护)。
   * 过程可观测:零存活轮里执行层的实质工作(资源盘点/调研)不再蒸发。
   */
  readonly trace?: readonly string[];
  /** 本轮阶段性回答草稿(LLM 真实综合;失败则记 answerDraftError,无降级拼接) */
  readonly answerDraft?: string;
  readonly answerDraftError?: string;
  readonly note?: string;
}

export interface IncubationEntry {
  readonly id: string;
  readonly question: string;
  readonly seedEngramIds: readonly string[];
  readonly status: IncubationStatus;
  readonly rounds: number;
  /** 联网调研 opt-in(默认 false;GUI 明示) */
  readonly webResearchOptIn: boolean;
  /** 每日排程时刻 "HH:mm"(本地);缺省 "00:00" */
  readonly schedule?: string;
  readonly createdAt: string;
  readonly lastHatchedAt: string | null;
  readonly timeline: readonly IncubationTimelineEvent[];
  /** in-flight 瞬态字段(TTL 30min 回收) */
  readonly inFlightAt?: string;
  readonly inFlightBy?: string;
  /** 收束产物(incubation_conclude;幂等可重生成) */
  readonly finalAnswer?: string;
  readonly concludedAt?: string;
  /** 连续全撞循环计数(诊断信号保留;单次执行语义下不再驱动 paused) */
  readonly consecutiveVetoed?: number;
  /** resolve(false) 的显式续孵标记:期间 normalize 不做 suggested-resolve 自动翻转(用户裁决主权);新一轮 report 落盘时清除 */
  readonly resumedAt?: string;
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
  }): boolean;
  listAll(): readonly ProposalLike[];
  findProposalByEntityId(
    entityId: string,
  ): { readonly status?: string; readonly dismissReason?: string } | undefined;
}

export interface IncubatorDeps {
  readonly repository: EngramRepository;
  readonly proposalEngine: IncubatorProposalSink;
  readonly dataRoot: string;
  /** L1 兜底 + critic 评审用 */
  readonly llmClient?: LlmClient;
  /** L2 执行器(宿主注入);缺省降级 L1 */
  readonly executor?: NightThinkingExecutor;
  readonly processLock?: { readonly isHolder?: boolean };
  readonly auditLog?: {
    append(entry: {
      readonly actor: string;
      readonly action: string;
      readonly engramId?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }): unknown;
  };
  readonly now?: () => string;
}

const INCUBATIONS_FILE = "incubations.json";

function incubationsPath(dataRoot: string): string {
  return join(dataRoot, ".co-engram", INCUBATIONS_FILE);
}

function parseAt(iso: string): number {
  return new Date(iso).getTime();
}

/** 解析 "HH:mm" → date 当日该时刻(本地时区);不合法值回落 00:00 */
function anchorOn(date: Date, schedule: string): Date {
  const m = SCHEDULE_RE.exec(schedule);
  const h = m ? Number(m[1]) : 0;
  const min = m ? Number(m[2]) : 0;
  const d = new Date(date);
  d.setHours(h, min, 0, 0);
  return d;
}

/**
 * 下一个排程锚点(> lastHatchedAt ?? createdAt);仅 active 可调度(单次执行
 * 语义:跑完即 suggested-resolve 待裁决 → null;resolve(false) 回 active 后恢复)。
 *
 * `now` 不参与计算,仅与 `isDue` 签名对称;返回值可能落在过去(待补跑信号,
 * 由展示层判定)。
 */
export function computeNextRunAt(entry: IncubationEntry, now: Date = new Date()): string | null {
  if (entry.status !== "active") return null;
  const last = new Date(entry.lastHatchedAt ?? entry.createdAt);
  // 最坏情形:last 恰在当日锚点后 → 次日锚点必 > last,两轮足够
  for (let i = 0; i < 2; i += 1) {
    const day = new Date(last);
    day.setDate(day.getDate() + i);
    const anchor = anchorOn(day, entry.schedule ?? "00:00");
    if (anchor > last) return anchor.toISOString();
  }
  return null;
}

/** 锚点 due 判定(spec §四,红队修正 R4):now ≥ 今日锚点 && 今日锚点 > (last ?? createdAt) */
export function isDue(entry: IncubationEntry, now: Date = new Date()): boolean {
  if (entry.status !== "active") return false;
  const last = new Date(entry.lastHatchedAt ?? entry.createdAt);
  const anchor = anchorOn(now, entry.schedule ?? "00:00");
  return now >= anchor && anchor > last;
}

/**
 * 夜思孵化器。读时始终从磁盘读(跨进程可见),写时仅 holder 落盘。
 */
export class Incubator {
  private readonly deps: IncubatorDeps;
  private readonly now: () => string;
  /** L1 兜底执行器(llmClient 存在时惰性构造) */
  private l1: { execute(t: NightThinkingTask): Promise<NightThinkingReport> } | null = null;

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
    const nowMs = parseAt(this.now());
    return (parsed as IncubationEntry[])
      .map((e) => this.normalize(e, nowMs))
      .filter((e): e is IncubationEntry => e !== null);
  }

  private write(entries: readonly IncubationEntry[]): void {
    // 与 maintenance-state 同款持锁写:non-holder 不落盘(防 lost-update)
    if (this.deps.processLock?.isHolder === false) return;
    const path = incubationsPath(this.deps.dataRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries, null, 2) + "\n", "utf8");
  }

  /** 状态归一化:in-flight 过期回收 + accept 后 suggested-resolve */
  private normalize(e: IncubationEntry, nowMs: number): IncubationEntry | null {
    if (!e || typeof e.id !== "string" || typeof e.question !== "string") return null;
    let out = e;
    out = { ...out, schedule: out.schedule ?? "00:00" };
    if (out.status === "in-flight") {
      const at = out.inFlightAt ? parseAt(out.inFlightAt) : 0;
      if (nowMs - at > INSIGHT_LIMITS.inFlightTtlMs) {
        out = { ...out, status: "active", inFlightAt: undefined, inFlightBy: undefined };
      }
    }
    // resolve 仪式(spec §四):accept 洞察 → suggested-resolve。
    // resumedAt = 用户显式「继续孵化」(resolve false):自动翻转让位于用户
    // 裁决;下一轮 report() 清除标记后建议重新武装(新一轮证据出现)。
    if (out.status === "active" && out.rounds > 0 && !out.resumedAt) {
      const hasAccepted = out.timeline.some((t) =>
        t.proposalEntityIds.some(
          (id) => this.deps.proposalEngine.findProposalByEntityId(id)?.status === "accepted",
        ),
      );
      if (hasAccepted) out = { ...out, status: "suggested-resolve" };
    }
    return out;
  }

  // ============================================================
  // CRUD
  // ============================================================

  create(input: {
    readonly question: string;
    readonly seedEngramIds?: readonly string[];
    readonly webResearchOptIn?: boolean;
    readonly schedule?: string;
  }): IncubationEntry {
    // 域层对称校验:与 updateSchedule 同一 SCHEDULE_RE,防工具层漏检脏值落盘
    if (input.schedule !== undefined && !SCHEDULE_RE.test(input.schedule)) {
      throw new Error(`invalid schedule "${input.schedule}" (expect HH:mm)`);
    }
    const entry: IncubationEntry = {
      id: `inc-${randomUUID().slice(0, 12)}`,
      question: input.question.trim(),
      seedEngramIds: [...(input.seedEngramIds ?? [])],
      status: "active",
      rounds: 0,
      webResearchOptIn: input.webResearchOptIn ?? false,
      schedule: input.schedule ?? "00:00",
      createdAt: this.now(),
      lastHatchedAt: null,
      timeline: [],
    };
    this.write([...this.read(), entry]);
    return entry;
  }

  list(): readonly IncubationEntry[] {
    return this.read();
  }

  get(id: string): IncubationEntry | undefined {
    return this.read().find((e) => e.id === id);
  }

  /** resolve 仪式:answered=true → resolved(梦境链保留);false → 继续 active */
  resolve(id: string, answered: boolean): IncubationEntry {
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    const updated: IncubationEntry = {
      ...target,
      status: answered ? "resolved" : "active",
      // 显式续孵标记:answered=false 时用户拒绝 suggested-resolve 建议,
      // normalize 的自动翻转让位于用户裁决,直到下一轮 report() 清除
      ...(answered ? {} : { resumedAt: this.now() }),
    };
    this.write(entries.map((e) => (e.id === id ? updated : e)));
    return updated;
  }

  /** 改写排程时刻(仅非 in-flight;SCHEDULE_RE 校验;同步读改写,无 await
   *  窗口故无需写前重读(与 create/resolve/pause 同保护级别)) */
  updateSchedule(id: string, schedule: string): IncubationEntry {
    if (!SCHEDULE_RE.test(schedule)) {
      throw new Error(`invalid schedule "${schedule}" (expect HH:mm)`);
    }
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    if (target.status === "in-flight") {
      throw new Error(`incubation ${id} in-flight — update schedule after the round finishes`);
    }
    const updated: IncubationEntry = { ...target, schedule };
    this.write(entries.map((e) => (e.id === id ? updated : e)));
    return updated;
  }

  /** 收束:综合全部梦境史出最终回答,置 suggested-resolve(幂等,可重复收束) */
  async conclude(id: string): Promise<IncubationEntry> {
    if (!this.deps.llmClient) {
      throw new Error("conclude unavailable: no llmClient injected");
    }
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    if (target.status === "in-flight") {
      throw new Error(`incubation ${id} in-flight — conclude after the round finishes`);
    }
    const finalAnswer = await synthesizeFinalAnswer(
      this.deps.llmClient,
      target.question,
      this.dreamHistoryFor(id),
    );
    // 写前重读合并(同 report() 模式):LLM await 窗口内的并发写不回滚;
    // 若用户已把条目 resolve 成 resolved(或 paused),保留用户裁决,仅落 finalAnswer。
    const fresh = this.read();
    const freshIdx = fresh.findIndex((e) => e.id === id);
    if (freshIdx === -1) throw new Error(`incubation ${id} not found`);
    // await 窗口内复查:锚点到期/手动 run 可能已合法 acquireInFlight 拿锁开跑,
    // 不复查会用开头快照整文件覆写,把 in-flight 态打回 suggested-resolve →
    // 双轮并发 + 本轮 finalAnswer 随后被 report() 回滚。
    if (fresh[freshIdx]!.status === "in-flight") {
      throw new Error(`incubation ${id} in-flight — conclude after the round finishes`);
    }
    const freshStatus = fresh[freshIdx]!.status;
    const status =
      freshStatus === "resolved" || freshStatus === "paused" ? freshStatus : "suggested-resolve";
    const updated: IncubationEntry = {
      ...fresh[freshIdx]!,
      finalAnswer,
      concludedAt: this.now(),
      status,
    };
    const next = [...fresh];
    next[freshIdx] = updated;
    this.deps.auditLog?.append({
      actor: "user",
      action: "incubation_conclude",
      metadata: {
        incubationId: id,
        finalAnswerPreview: finalAnswer.slice(0, 200),
      },
    });
    this.write(next);
    return updated;
  }

  pause(id: string): IncubationEntry {
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    const updated: IncubationEntry = { ...target, status: "paused" };
    this.write(entries.map((e) => (e.id === id ? updated : e)));
    this.deps.auditLog?.append({
      actor: "user",
      action: "incubation_pause",
      metadata: { incubationId: id },
    });
    return updated;
  }

  /**
   * 删除条目(生命周期终点;in-flight 拒绝,同 updateSchedule 保护)。
   * 语义:删条目不删提案 —— 提案本体在 proposalEngine,走各自 accept/dismiss
   * 裁决流;梦境史(timeline)随条目一并移除。
   */
  delete(id: string): void {
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    if (target.status === "in-flight") {
      throw new Error(`incubation ${id} in-flight — delete after the round finishes`);
    }
    this.write(entries.filter((e) => e.id !== id));
    this.deps.auditLog?.append({
      actor: "user",
      action: "incubation_delete",
      metadata: {
        incubationId: id,
        question: target.question.slice(0, 120),
      },
    });
  }

  // ============================================================
  // in-flight 原子标记(跨进程互斥)
  // ============================================================

  acquireInFlight(id: string, by: string): boolean {
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) throw new Error(`incubation ${id} not found`);
    if (target.status !== "active" && target.status !== "suggested-resolve") return false;
    const updated: IncubationEntry = {
      ...target,
      status: "in-flight",
      inFlightAt: this.now(),
      inFlightBy: by,
    };
    this.write(entries.map((e) => (e.id === id ? updated : e)));
    return true;
  }

  releaseInFlight(id: string): void {
    const entries = this.read();
    this.write(
      entries.map((e) =>
        e.id === id && e.status === "in-flight"
          ? { ...e, status: "active", inFlightAt: undefined, inFlightBy: undefined }
          : e,
      ),
    );
  }

  // ============================================================
  // 梦境史(回灌组装)与任务包
  // ============================================================

  /** 完整梦境史:过往洞察摘要 + accept/dismiss 理由(spec §四回灌迭代) */
  dreamHistoryFor(id: string): string {
    const entry = this.get(id);
    if (!entry) return "";
    const lines: string[] = [];
    for (const t of entry.timeline) {
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
        lines.push(`- Round ${t.round}(${t.trigger}): ${s}${dispositions[i] ?? ""}`);
      });
      if (t.summaries.length === 0) {
        lines.push(
          `- Round ${t.round}(${t.trigger}): ${NO_SURVIVOR_MARKER}${t.note ? ` ${t.note}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  }

  /** active 条目(供 REM 灵感模式合并;结构满足 MaintenanceDeps.incubator) */
  activeEntries(): ReadonlyArray<{ id: string; question: string; dreamHistory: string }> {
    return this.read()
      .filter((e) => e.status === "active")
      .map((e) => ({
        id: e.id,
        question: e.question,
        dreamHistory: this.dreamHistoryFor(e.id),
      }));
  }

  /** 组装 L2 任务包(incubation_run 工具返回;脱敏:种子摘要级内容) */
  buildTask(id: string): NightThinkingTask {
    const entry = this.get(id);
    if (!entry) throw new Error(`incubation ${id} not found`);
    return {
      incubationId: entry.id,
      question: entry.question,
      seedDigests: collectSeedDigests(this.deps.repository, entry.seedEngramIds),
      dreamHistory: this.dreamHistoryFor(id),
      webResearchOptIn: entry.webResearchOptIn,
      resourceHints: collectResourceHints(this.deps.dataRoot),
      protocol: buildProtocol(entry.webResearchOptIn),
    };
  }

  // ============================================================
  // 执行(L2 主路径 / L1 降级)+ 唯一写回路径
  // ============================================================

  /** 即时/调度执行入口:executor(L2)→ L1 降级;不与 L2 并存竞争预算 */
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
    if (entry.status !== "active" && entry.status !== "suggested-resolve") {
      throw new Error(`incubation ${id} not runnable (status=${entry.status})`);
    }
    if (!this.acquireInFlight(id, `incubateOnce:${trigger}`)) {
      throw new Error(`incubation ${id} already in-flight`);
    }
    const task = this.buildTask(id);
    let report: NightThinkingReport;
    let level: "L1" | "L2";
    try {
      if (this.deps.executor) {
        try {
          report = await this.deps.executor.execute(task);
          level = "L2";
        } catch {
          // L2 失败 → 降级 L1(不阻塞交付)
          report = await this.runL1(task);
          level = "L1";
        }
      } else {
        report = await this.runL1(task);
        level = "L1";
      }
      const result = await this.report({
        incubationId: id,
        report,
        trigger,
        actor: `night-thinking-${level}`,
      });
      return { ...result, level };
    } catch (err) {
      this.releaseInFlight(id);
      throw err;
    }
  }

  private async runL1(task: NightThinkingTask): Promise<NightThinkingReport> {
    if (!this.deps.llmClient) {
      throw new Error("L1 unavailable: no llmClient injected");
    }
    if (!this.l1) this.l1 = createL1Executor(this.deps.llmClient, this.deps.repository);
    return this.l1.execute(task);
  }

  /**
   * 唯一写回路径(L2 agent 的 incubation_report / L1 内部共用):
   * 机械校验 + 独立 critic + 循环检测 + rounds+1 + timeline + 落盘。
   *
   * critic 遵循第一关语义:独立第二次调用、fail-closed(无 llmClient /
   * 不可解析 / 低于阈值 → 不出提案)。
   */
  async report(input: {
    readonly incubationId: string;
    readonly report: NightThinkingReport;
    readonly trigger: "manual" | "scheduled";
    readonly actor: string;
  }): Promise<{ proposals: number; cycleVetoed: boolean; entry: IncubationEntry }> {
    const entries = this.read();
    const idx = entries.findIndex((e) => e.id === input.incubationId);
    if (idx === -1) throw new Error(`incubation ${input.incubationId} not found`);
    const entry = entries[idx]!;
    const nextRound = entry.rounds + 1;

    // 外部调用审计(viewer 可查)
    for (const call of input.report.externalCalls) {
      this.deps.auditLog?.append({
        actor: "system",
        action: "night_thinking_external_call",
        metadata: {
          incubationId: entry.id,
          tool: call.tool,
          purpose: call.purpose,
          at: call.at,
        },
      });
    }

    // ---- 循环检测:与过往每轮洞察摘要逐一对比(整体 blob 会被稀释,
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
      input.report.insights.length > 0 && vetoed === input.report.insights.length;

    // ---- 机械校验 + 独立 critic → rem-insight 提案(捕获即时成提案) ----
    const summaries: string[] = [];
    const entityIds: string[] = [];
    /** 综合证据面:成案草稿的「标题 — 摘要」。timeline.summaries 仍只存
     * title(既有契约 + Jaccard 语料不变),仅综合调用拿到更宽的证据面。 */
    const draftEvidence: string[] = [];
    const threshold = DEFAULT_REM_INSIGHT.criticThreshold;
    let validateRejected = 0;
    let criticRejected = 0;
    /** 逐条拒因(title 前缀 + reason;诊断可达性:计数区分不了成因) */
    const rejectReasons: string[] = [];
    for (const d of survived) {
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
      const score = await critique(this.deps.llmClient, d, sub, d.mode);
      if (!score || score.overall < threshold) {
        criticRejected += 1;
        rejectReasons.push(
          `[critic] ${d.title.slice(0, 40)}: ${score ? score.overall.toFixed(2) : "unparseable"} < ${threshold}`,
        );
        continue;
      }
      const entityId = insightEntityId(d.mode, entry.id, nextRound, d.sourceIds);
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
      });
      if (ok) {
        summaries.push(d.title);
        draftEvidence.push(`${d.title} — ${d.summary}`);
        entityIds.push(entityId);
      }
    }

    // ---- 阶段综合(spec §五:不降级,失败报错)----
    // dreamHistoryFor 此时读盘仍是旧 timeline(新事件尚未落盘)→ 天然「至上一轮」
    // 执行语境(2026-08-16 机制缺陷修复):轨迹/外调 purpose/逐条拒因注入综合
    // 输入 —— 零存活轮的综合层不再对执行层的工作一无所知,归因锚定真实证据。
    const traceSummary = input.report.trace
      .slice(0, 20)
      .map((t) => `${t.step}: ${t.action} — ${t.detail}`.slice(0, 160));
    const externalPurposes = input.report.externalCalls.map((c) =>
      `${c.tool}: ${c.purpose.slice(0, 120)}`,
    );
    let answerDraft: string | undefined;
    let answerDraftError: string | undefined;
    if (!this.deps.llmClient) {
      answerDraftError = "llmClient unavailable";
    } else {
      try {
        // 证据面取「标题 — 摘要」:draftEvidence 与 summaries 在同一 if(ok)
        // 分支共同 push、长度恒相等,零成案时二者同为空(综合端渲染空态占位),
        // 故直接传 draftEvidence 即等价于「有成案用标题+摘要、零成案退回
        // title 列表」的语义,无需再写 length 回退分支。
        answerDraft = await synthesizeAnswerDraft(
          this.deps.llmClient,
          entry.question,
          this.dreamHistoryFor(entry.id),
          draftEvidence,
          {
            rejectReasons,
            traceSummary,
            externalPurposes,
          },
        );
      } catch (err) {
        answerDraftError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      }
    }

    // ---- 轮次推进 + timeline 落盘(单次执行语义)----
    // 排程时刻是「单次任务的启动时刻」:跑完任意一轮 → suggested-resolve,
    // 完成后待用户裁决,不再自动续夜。再来一次只有两条路:手动「立即夜思」,
    // 或 resolve(false) 回 active 等下个锚点。consecutiveVetoed 仍逐轮计数
    // (dup 检测语料/诊断信号保留),但不再驱动自动 paused。
    const consecutive = allVetoed ? (entry.consecutiveVetoed ?? 0) + 1 : 0;
    const note = allVetoed ? "all insights vetoed as duplicates" : undefined;
    // 轮前已落的用户裁决(paused/resolved)保留;其余(in-flight/active)一律待裁决
    const status: IncubationStatus =
      entry.status === "paused" || entry.status === "resolved"
        ? entry.status
        : "suggested-resolve";
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
        externalCallCount: input.report.externalCalls.length,
        diagnosis,
        ...(traceSummary.length ? { trace: traceSummary } : {}),
        ...(answerDraft ? { answerDraft } : {}),
        ...(answerDraftError ? { answerDraftError } : {}),
        ...(note ? { note } : {}),
      },
    ];
    const updated: IncubationEntry = {
      ...entry,
      status,
      rounds: nextRound,
      lastHatchedAt: this.now(),
      timeline,
      consecutiveVetoed: consecutive,
      inFlightAt: undefined,
      inFlightBy: undefined,
      // 新一轮证据落盘:清除续孵标记(accept 建议 re-arm,normalize 重新可翻转)
      resumedAt: undefined,
    };
    // 写前重读合并:report 中途有 await(critic/综合走 LLM),若仍基于开头
    // 快照整文件覆写,会回滚期间其他进程/用户的写;本条目轮中用户
    // pause/resolve 裁决优先保留,其余字段(timeline/rounds 等)用本轮计算值。
    const fresh = this.read();
    const freshIdx = fresh.findIndex((x) => x.id === entry.id);
    if (freshIdx === -1) {
      // 本条目被并发删除:放弃写入(不复活已删条目),返回本轮计算结果
      return { proposals: entityIds.length, cycleVetoed: allVetoed, entry: updated };
    }
    const freshEntry = fresh[freshIdx]!;
    const finalEntry: IncubationEntry = {
      ...updated,
      status:
        freshEntry.status === "paused" || freshEntry.status === "resolved"
          ? freshEntry.status
          : status,
    };
    const next = [...fresh];
    next[freshIdx] = finalEntry;
    // 轮次审计(viewer 可查):diagnosis 以嵌套对象直落 metadata(audit.jsonl
    // 按行 JSON.stringify,天然支持嵌套);草稿仅记 200 字预览防爆噪。
    this.deps.auditLog?.append({
      actor: input.actor,
      action: "incubation_round",
      metadata: {
        incubationId: entry.id,
        round: nextRound,
        trigger: input.trigger,
        proposals: entityIds.length,
        drafts: input.report.insights.length,
        diagnosis,
        ...(answerDraft ? { answerDraftPreview: answerDraft.slice(0, 200) } : {}),
      },
    });
    this.write(next);
    return { proposals: entityIds.length, cycleVetoed: allVetoed, entry: finalEntry };
  }

  /** 由 sourceIds 构造最小校验子图(节点来自 repo;不存在者由引用闭合拒绝) */
  private subgraphFor(d: InsightDraft): Parameters<typeof validateInsightDraft>[1] {
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

  // ============================================================
  // 独立日调度(锚点时刻制,active 条目每日 schedule 时刻一轮,不依赖 REM 节拍)
  // ============================================================

  async runDue(
    now: string = this.now(),
  ): Promise<{ ran: readonly string[]; skipped: readonly string[] }> {
    const nowDate = new Date(parseAt(now));
    // spec §四(锚点时刻制):active 条目每日在 schedule 锚点时刻(默认 00:00
    // 本地)跑一轮;错过锚点(无进程)→ 下一 tick 补跑;新建条目等首个锚点
    // 或手动触发;锚点前手动跑过(昨夜)不消耗当日锚点,锚点后手动跑过
    // (last ≥ 今日锚点)则当日不再自动。
    const active = this.read().filter((e) => e.status === "active");
    const ran: string[] = [];
    const skipped: string[] = [];
    for (const e of active) {
      if (!isDue(e, nowDate)) {
        skipped.push(e.id);
        continue;
      }
      try {
        await this.incubateOnce(e.id, "scheduled");
        ran.push(e.id);
      } catch {
        skipped.push(e.id);
      }
    }
    return { ran, skipped };
  }
}
