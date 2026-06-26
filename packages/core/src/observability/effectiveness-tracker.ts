/**
 * 有效性追踪器（Effectiveness Tracker）
 *
 * 管理 retrieve_hit 后的观察窗口,自动判定 retrieve_effective / retrieve_inconclusive。
 *
 * 流程:
 *   1. engram_search 命中 → openWindow(engramId, kind, query)
 *   2. 在窗口期内调 reinforceEngram → closeAsEffective(engramId)
 *   3. light maintenance 阶段 → sweepExpired() 把超时窗口标记为 inconclusive
 *
 * 窗口长度按 engram kind 区分:
 *   - observation: 6h
 *   - fact:        24h(默认)
 *   - pattern:     48h
 *   - procedure:   48h
 *   - hypothesis:  7d
 * 多 kind(engram.kinds) 取最长。
 *
 * 存储格式: $DATA_ROOT/.co-engram/observation-windows.jsonl
 * 落盘原因: 进程重启不丢窗口;多 host 实例(Claude Code + OpenClaw)共享状态。
 *
 * 派生接口:
 *   - effectiveness(engramId) → EffectivenessReport
 *     本 tracker 提供 hits/effective/inconclusive(从 windows 文件派生),
 *     contradicted 从注入的 auditLog 派生。
 *
 * @module @co-engram/core/observability
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EngramKind } from "../types/engram.js";
import type { AuditLog } from "./audit-log.js";

/** kind → 窗口长度(毫秒) */
export const DEFAULT_EFFECTIVENESS_WINDOWS: Readonly<
  Record<EngramKind, number>
> = {
  observation: 6 * 60 * 60 * 1000, // 6h
  fact: 24 * 60 * 60 * 1000, // 24h
  pattern: 48 * 60 * 60 * 1000, // 48h
  procedure: 48 * 60 * 60 * 1000, // 48h
  hypothesis: 7 * 24 * 60 * 60 * 1000, // 7d
};

/** 默认的最少命中次数门槛 */
export const DEFAULT_MIN_HITS = 3;

/** 某 engram 的有效率统计 */
export interface EffectivenessReport {
  /** retrieve_hit 总次数(从 windows 文件读所有状态记录计数) */
  readonly hits: number;
  /** retrieve_effective 次数(从 windows 读 closed_by_reinforce) */
  readonly effective: number;
  /** retrieve_inconclusive 次数(从 windows 读 closed_by_timeout) */
  readonly inconclusive: number;
  /** contradicted 次数(从 audit 读) */
  readonly contradicted: number;
  /**
   * 有效率:[0, 1] 或 null(数据不足)
   *
   * 公式: effective / (effective + inconclusive + contradicted)
   * - inconclusive 进分母但不进分子(算半负面信号)
   * - contradicted 不额外加权
   * - hits < minHits(默认 3) → 返回 null
   */
  readonly effectiveRate: number | null;
}

/** 单个观察窗口记录 */
export interface ObservationWindow {
  /** 唯一 ID(randomUUID) */
  readonly id: string;
  /** 被检索命中的 engram id */
  readonly engramId: string;
  /** 检索查询(便于后续元学习) */
  readonly query: string;
  /** 命中时的分数 */
  readonly score: number;
  /** 命中时间(ISO) */
  readonly hitAt: string;
  /** 窗口截止时间(ISO) */
  readonly deadline: string;
  /** 该 engram 的 kind(决定窗口长度) */
  readonly kind: EngramKind;
  /** 会话 ID */
  readonly sessionId?: string;
  /** 状态:open / closed_by_reinforce / closed_by_failure / closed_by_timeout */
  readonly status:
    | "open"
    | "closed_by_reinforce"
    | "closed_by_failure"
    | "closed_by_timeout";
}

/**
 * 计算给定 kinds 的窗口长度(取最长)
 *
 * 多 kind engram 取 max——任何维度未闭环都不算"完成"。
 */
export function computeWindowMs(
  kinds: readonly EngramKind[],
  overrides?: Partial<Readonly<Record<EngramKind, number>>>,
): number {
  if (kinds.length === 0) {
    return DEFAULT_EFFECTIVENESS_WINDOWS.fact;
  }
  return Math.max(
    ...kinds.map((k) => overrides?.[k] ?? DEFAULT_EFFECTIVENESS_WINDOWS[k]),
  );
}

/** sweepExpired 结果 */
export interface SweepResult {
  /** 关闭的窗口数 */
  readonly closed: number;
  /** 关闭的 engram id 列表(去重) */
  readonly engramIds: readonly string[];
}

/**
 * 有效性追踪器
 *
 * 不抛:所有写操作 fire-and-forget。
 */
export class EffectivenessTracker {
  private readonly filePath: string;
  private readonly auditLog: AuditLog;
  private readonly windowsByKind?: Partial<
    Readonly<Record<EngramKind, number>>
  >;

  constructor(
    dataRoot: string,
    auditLog: AuditLog,
    options: {
      windowsByKind?: Partial<Readonly<Record<EngramKind, number>>>;
    } = {},
  ) {
    this.filePath = join(dataRoot, ".co-engram", "observation-windows.jsonl");
    this.auditLog = auditLog;
    this.windowsByKind = options.windowsByKind;
  }

  /**
   * 开观察窗口(engram_search 命中时调)
   *
   * 同一 engram 同时只允许有一个 open 窗口——重复命中时刷新 deadline。
   */
  openWindow(input: {
    readonly engramId: string;
    readonly query: string;
    readonly score: number;
    readonly kinds: readonly EngramKind[];
    readonly sessionId?: string;
    readonly nowIso?: string;
  }): ObservationWindow {
    const now = input.nowIso ?? new Date().toISOString();
    const windowMs = computeWindowMs(input.kinds, this.windowsByKind);
    const deadline = new Date(new Date(now).getTime() + windowMs).toISOString();

    // 关闭可能存在的 open 窗口(替换语义)
    this.closeExisting(
      input.engramId,
      "closed_by_timeout",
      now,
      /* silent */ true,
    );

    const win: ObservationWindow = {
      id: randomId(),
      engramId: input.engramId,
      query: input.query,
      score: input.score,
      hitAt: now,
      deadline,
      kind: input.kinds[0] ?? "fact",
      sessionId: input.sessionId,
      status: "open",
    };

    this.appendRecord(win);
    // 不写 audit:window 文件已经记录了 hit,effectiveness() 从 windows 派生。
    // 写 retrieve_hit audit 会让 audit.jsonl 被检索事件淹没。

    return win;
  }

  /**
   * 标记某 engram 的最近 open 窗口为 effective(engram_reinforce 时调)
   *
   * @returns true 如果找到并关闭了一个 open 窗口
   */
  closeAsEffective(engramId: string, nowIso?: string): boolean {
    return this.closeExisting(
      engramId,
      "closed_by_reinforce",
      nowIso,
      /* silent */ false,
    );
  }

  /**
   * 标记某 engram 的最近 open 窗口为 failure(engram_report_failure 时调)
   *
   * 失败已通过 report_failure audit 单独记录,这里仅关闭窗口避免后续触发 inconclusive。
   */
  closeAsFailure(engramId: string, nowIso?: string): boolean {
    return this.closeExisting(
      engramId,
      "closed_by_failure",
      nowIso,
      /* silent */ true,
    );
  }

  /**
   * 扫描超时窗口,写 retrieve_inconclusive + 关闭
   *
   * 在 maintenance engine light 阶段调用。
   */
  sweepExpired(nowIso?: string): SweepResult {
    const now = nowIso ?? new Date().toISOString();
    const records = this.readAll();
    const closedIds = new Set<string>();
    let closed = 0;

    const updated = records.map((r) => {
      if (r.status === "open" && r.deadline <= now) {
        closed += 1;
        closedIds.add(r.engramId);
        // 不写 audit:window 文件已经记录了 closed_by_timeout 状态,
        // effectiveness() 从 windows 派生 inconclusive 计数。
        return { ...r, status: "closed_by_timeout" as const };
      }
      return r;
    });

    if (closed > 0) {
      this.writeAll(updated);
    }

    return { closed, engramIds: [...closedIds] };
  }

  /** 列出当前所有 open 窗口(调试/Viewer 用) */
  listOpen(): readonly ObservationWindow[] {
    return this.readAll().filter((r) => r.status === "open");
  }

  /**
   * 派生某 engram 的有效率统计
   *
   * 数据源:
   *   - hits/effective/inconclusive:从 observation-windows.jsonl 派生
   *     · hits = 所有该 engram 的窗口记录数(每次 retrieve_hit 都开一个窗口)
   *     · effective = closed_by_reinforce 状态计数
   *     · inconclusive = closed_by_timeout 状态计数
   *   - contradicted:从 audit.jsonl 派生(只有 audit 记录这种事件)
   *
   * hits < minHits(默认 3) → effectiveRate = null
   *
   * 与历史版本的差异:不再从 audit 读 retrieve_* 事件,因为它们每条对话消息
   * 都可能产生,噪音太大。window 文件已经包含完整的 hits/effective/inconclusive
   * 状态,effectiveness 公式精度保留。
   */
  effectiveness(
    engramId: string,
    options: { readonly minHits?: number } = {},
  ): EffectivenessReport {
    const minHits = options.minHits ?? DEFAULT_MIN_HITS;
    const oneYearAgo = new Date(
      Date.now() - 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const records = this.readAll().filter(
      (r) => r.engramId === engramId && r.hitAt >= oneYearAgo,
    );

    const hits = records.length;
    const effective = records.filter(
      (r) => r.status === "closed_by_reinforce",
    ).length;
    const inconclusive = records.filter(
      (r) => r.status === "closed_by_timeout",
    ).length;

    // contradicted 从 audit 派生(只有 audit 记录这种事件)
    const contradicted = this.auditLog.query({
      engramId,
      action: "contradicted",
      since: oneYearAgo,
      limit: 100000,
    }).length;

    const denominator = effective + inconclusive + contradicted;
    const effectiveRate =
      hits < minHits || denominator === 0 ? null : effective / denominator;

    return { hits, effective, inconclusive, contradicted, effectiveRate };
  }

  /** 文件绝对路径 */
  get path(): string {
    return this.filePath;
  }

  /** 清空所有记录(测试用) */
  clear(): void {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf8");
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  private closeExisting(
    engramId: string,
    newStatus: ObservationWindow["status"],
    nowIso: string | undefined,
    silent: boolean,
  ): boolean {
    const now = nowIso ?? new Date().toISOString();
    const records = this.readAll();

    // 从尾部往前找最近的 open 窗口
    let foundIdx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]!.engramId === engramId && records[i]!.status === "open") {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx === -1) return false;

    const target = records[foundIdx]!;
    records[foundIdx] = { ...target, status: newStatus };
    this.writeAll(records);

    // 不写 audit:window 文件已经记录了 closed_by_reinforce 状态,
    // effectiveness() 从 windows 派生 effective 计数。
    // silent=true(failure 关闭)时本来也不写 audit。

    return true;
  }

  private readAll(): ObservationWindow[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as ObservationWindow;
        } catch {
          return null;
        }
      })
      .filter((r): r is ObservationWindow => r !== null);
  }

  private writeAll(records: readonly ObservationWindow[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(this.filePath, content, "utf8");
  }

  private appendRecord(record: ObservationWindow): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // intentional
    }
  }
}

/** 简易 ID 生成(避免引入 crypto 在测试中产生不同 UUID) */
function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
