/**
 * 窗口活动数据组装(2026-08-16 第二刀:审计日志进 REM 输入)。
 *
 * 数据流:engine.runRem → collectWindowActivity(audit 白名单事件加权 +
 * rem-state.json 检索快照 diff)→ runDeepThought → buildSubgraph 种子
 * activityOf 连续化;REM 成功后 writeRemState 落快照供下轮 diff。
 * 模式校准(computeModeCalibration)与活动数据同源组装,供
 * computeModeSignals 做各模式强度长期校准。
 *
 * 设计约束:检索事件不写 audit(既有决策,高频噪音),检索热度经
 * retrievalCount 快照 diff 窗口化 —— 零 audit 膨胀;快照为派生数据,
 * 任一数据源缺失时对应项为 0,不阻塞 REM。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditAction, AuditEntry, AuditLog } from "../../observability/audit-log.js";
import type { EngramRepository } from "../../storage/repository.js";
import {
  ACTIVITY_EVENT_WEIGHTS,
  EXTERNAL_EDIT_WEIGHT,
  MODE_CALIBRATION,
  type DeepThoughtMode,
  type ModeCalibration,
  type RemRetrievalSnapshot,
} from "./types.js";

/** 饱和归一:x/(x+k),k 为半饱和点(3 个事件 ≈ 0.5)。modes.ts 信号共用同一形状 */
export function saturate(x: number, k = 3): number {
  if (x <= 0) return 0;
  return x / (x + k);
}

/** 窗口内 audit 扫描上限(白名单事件为用户/工具操作级,7 天窗口远低于此) */
const AUDIT_SCAN_LIMIT = 10_000;

/** 白名单 action 集(query IO 层下推,防高频噪音事件挤占 ring buffer) */
const WHITELIST_ACTIONS = Object.keys(ACTIVITY_EVENT_WEIGHTS) as readonly AuditAction[];

/**
 * 白名单事件 → 权重(external-edit 形态在事件级判定;白名单外返回 null)。
 * 权重表与 WHITELIST_ACTIONS 同源,此函数理论上不会返回 null —— 保留判定
 * 是对外部直接调用的防御(action 过滤已下推到 query)。
 */
function weightOf(e: AuditEntry): number | null {
  const w = ACTIVITY_EVENT_WEIGHTS[e.action];
  if (w === undefined) return null;
  if (e.action === "update" && e.metadata?.source === "external-edit") {
    return EXTERNAL_EDIT_WEIGHT;
  }
  return w;
}

/**
 * 窗口内 audit 事件按 engramId 聚合(加权计数;engramId 缺失跳过)。
 *
 * action 白名单必须下推到 query(2026-08-16 真实库场景验证教训):团队库
 * audit.jsonl 的 99.98% 是 noise_filtered 等高频噪音(7 天 21 万条/106MB),
 * 不下推时 ring buffer 会被噪音挤满,窗口早期白名单事件被 limit 截断丢失。
 */
export function collectAuditActivity(
  auditLog: AuditLog,
  since: string | null,
): Map<string, number> {
  const entries =
    since === null
      ? auditLog.query({ action: WHITELIST_ACTIONS, limit: AUDIT_SCAN_LIMIT })
      : auditLog.query({ action: WHITELIST_ACTIONS, since, limit: AUDIT_SCAN_LIMIT });
  const out = new Map<string, number>();
  for (const e of entries) {
    const w = weightOf(e);
    if (w === null || !e.engramId) continue;
    out.set(e.engramId, (out.get(e.engramId) ?? 0) + w);
  }
  return out;
}

/** rem-state.json 读取;缺失/损坏 → null */
export function readRemState(dataRoot: string): RemRetrievalSnapshot | null {
  const file = join(dataRoot, ".co-engram", "rem-state.json");
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RemRetrievalSnapshot>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.retrievalCounts !== "object" ||
      parsed.retrievalCounts === null
    ) {
      return null;
    }
    return {
      writtenAt: typeof parsed.writtenAt === "string" ? parsed.writtenAt : "",
      retrievalCounts: parsed.retrievalCounts,
    };
  } catch {
    return null;
  }
}

/** 当前全库 active engram 的 retrievalCount(与 spread.collectFacts 同源批量查询) */
function currentRetrievalCounts(repo: EngramRepository): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of repo.listDigestByVerificationStatus(
    ["unverified", "plausible", "probable", "verified", "refuted"],
    { lifecycleStatuses: ["active"] },
  )) {
    out.set(e.id, e.retrievalCount);
  }
  return out;
}

/**
 * 快照 diff → 窗口检索增量。负增量(计数重置/清零)按 0;
 * 快照中不存在的新 engram 不计 —— 新编码已是种子(isEventSeed),不重复计活动。
 */
export function retrievalDeltas(
  repo: EngramRepository,
  snapshot: RemRetrievalSnapshot | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!snapshot) return out;
  for (const [id, now] of currentRetrievalCounts(repo)) {
    const prev = snapshot.retrievalCounts[id];
    if (prev === undefined) continue;
    const delta = now - prev;
    if (delta > 0) out.set(id, delta);
  }
  return out;
}

/** REM 结束写检索快照(原子 tmp + rename;失败静默 —— 快照是派生数据) */
export function writeRemState(dataRoot: string, repo: EngramRepository): void {
  try {
    const dir = join(dataRoot, ".co-engram");
    const file = join(dir, "rem-state.json");
    const snapshot: RemRetrievalSnapshot = {
      writtenAt: new Date().toISOString(),
      retrievalCounts: Object.fromEntries(currentRetrievalCounts(repo)),
    };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(snapshot), "utf8");
    renameSync(`${file}.tmp`, file);
  } catch {
    // intentional:快照失败不阻塞 REM
  }
}

/**
 * 窗口活动总分(engramId → 检索增量 + 加权事件数,单一量纲「次」)。
 * 数据源任一缺失时该项为 0;两者全缺 → 空 Map(spread 退化现状二值)。
 */
export function collectWindowActivity(deps: {
  readonly repository: EngramRepository;
  readonly auditLog?: AuditLog;
  readonly dataRoot?: string;
  readonly since: string | null;
}): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, v: number): void => {
    out.set(id, (out.get(id) ?? 0) + v);
  };
  if (deps.dataRoot) {
    for (const [id, delta] of retrievalDeltas(
      deps.repository,
      readRemState(deps.dataRoot),
    )) {
      add(id, delta);
    }
  }
  if (deps.auditLog) {
    for (const [id, w] of collectAuditActivity(deps.auditLog, deps.since)) {
      add(id, w);
    }
  }
  return out;
}

/**
 * 模式强度长期校准(2026-08-16 用户灵感:被 accept 洞察的模式分布)。
 *
 * rem-insight 提案按 insightMode 统计 accepted/dismissed(全历史,非窗口):
 * 样本 < minSamples 冷启动 factor=1;否则 factor = floor + (ceiling-floor)·
 * acceptRate(acceptRate=0.5 中性)。下限不打死(防一次 dismiss 潮后模式
 * 永久哑火),上限防正反馈失控。
 */
export function computeModeCalibration(
  proposals: ReadonlyArray<{
    readonly source?: string;
    readonly status?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }>,
): ReadonlyMap<DeepThoughtMode, ModeCalibration> {
  const byMode = new Map<DeepThoughtMode, { accepted: number; dismissed: number }>();
  for (const p of proposals) {
    if (p.source !== "rem-insight") continue;
    if (p.status !== "accepted" && p.status !== "dismissed") continue;
    const mode = p.payload?.insightMode;
    if (mode !== "integration" && mode !== "retrospective" && mode !== "inspiration") {
      continue;
    }
    const agg = byMode.get(mode) ?? { accepted: 0, dismissed: 0 };
    if (p.status === "accepted") agg.accepted += 1;
    else agg.dismissed += 1;
    byMode.set(mode, agg);
  }
  const out = new Map<DeepThoughtMode, ModeCalibration>();
  for (const [mode, agg] of byMode) {
    const samples = agg.accepted + agg.dismissed;
    const acceptRate = samples === 0 ? 0 : agg.accepted / samples;
    if (samples < MODE_CALIBRATION.minSamples) {
      out.set(mode, { factor: 1, samples, acceptRate });
      continue;
    }
    const raw =
      MODE_CALIBRATION.floor +
      (MODE_CALIBRATION.ceiling - MODE_CALIBRATION.floor) * acceptRate;
    out.set(mode, {
      factor: Math.min(MODE_CALIBRATION.ceiling, Math.max(MODE_CALIBRATION.floor, raw)),
      samples,
      acceptRate,
    });
  }
  return out;
}
