/**
 * Maintenance state 持久化(方案 A:让 REM 真的跑起来)。
 *
 * 解决「setInterval + 进程重启 + 持锁切换」导致低频 stage(rem/daily)永远
 * 触发不到的问题:
 *   - 每次 runStage 完成(成功/失败)写 lastRunAt / lastResult
 *   - MaintenanceEngine.start() 启动时读,检查 now - lastRunAt > intervalMs
 *     触发 catch-up(详见 engine.ts scheduleCatchUp)
 *
 * 持久化模式参考 prompt-signals/cache.ts 的 fs.promises.writeFile 原子写。
 * 文件位置:`<dataRoot>/.co-engram/maintenance-state.json`,与 prompt-signals.json 同目录。
 *
 * 并发安全:processLock 保证任一时刻最多一个 holder(见 concurrency/process-lock.ts),
 * 只有持锁者写 state.json。writeStageState 内部 read-modify-write,跨进程并发场景下
 * 可能 lost update,但 lastRunAt 字段语义幂等(取最后值),丢失不影响正确性。
 *
 * @module @co-engram/core/maintenance
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaintenanceReport, MaintenanceStage } from "./types.js";

const STATE_FILE_NAME = "maintenance-state.json";
const STATE_DIR = ".co-engram";

/** 单 stage 的状态摘要(每次 runStage 完成后写入) */
export interface StageState {
  /** 最后一次完成时间(ISO) */
  readonly lastRunAt: string;
  /** 最后一次运行耗时(ms) */
  readonly lastDurationMs: number;
  /** 最后一次运行结果摘要(数字 / 布尔 / downstreamSummary) */
  readonly lastResult: Readonly<Record<string, unknown>>;
  /** 最后一次错误信息(null = 成功) */
  readonly lastError: string | null;
}

/** maintenance-state.json 完整 schema */
export interface MaintenanceState {
  readonly version: 1;
  readonly stages: Readonly<Record<MaintenanceStage, StageState | undefined>>;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** 空 state(读失败 / 不存在时返回,触发启动 catch-up) */
export const EMPTY_STATE: MaintenanceState = {
  version: 1,
  stages: {
    light: undefined,
    deep: undefined,
    rem: undefined,
    daily: undefined,
  },
  updatedAt: "",
  updatedBy: "",
};

/** maintenance-state.json 完整路径(dataRoot 下 .co-engram/) */
export function maintenanceStatePath(dataRoot: string): string {
  return join(dataRoot, STATE_DIR, STATE_FILE_NAME);
}

/**
 * 读 maintenance-state.json。
 *
 * 文件不存在 / 损坏 / version 不匹配 → 返回 EMPTY_STATE。
 * EMPTY_STATE 会触发 MaintenanceEngine 启动 catch-up(对低频 stage 立即跑一次),
 * 确保 state 丢失不会让 REM 永远跑不到。
 */
export async function readMaintenanceState(
  dataRoot: string,
): Promise<MaintenanceState> {
  const filePath = maintenanceStatePath(dataRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.stages !== "object" ||
      !parsed.stages
    ) {
      return EMPTY_STATE;
    }
    return {
      version: 1,
      stages: { ...EMPTY_STATE.stages, ...parsed.stages },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "",
    };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * 单 stage 完成时 read-modify-write 更新。
 *
 * 只持锁者调用(MaintenanceEngine.runStage 内部 check processLock.isHolder)。
 * 写失败由调用方 catch,不阻塞 stage 本身。
 *
 * @param dataRoot team-memory 根路径
 * @param stage 哪个 stage
 * @param report runStage 返回的完整 report(用于提取 summary)
 * @param host 当前 host 标识(claude-code-mcp / openclaw-plugin 等)
 */
export async function writeStageState(
  dataRoot: string,
  stage: MaintenanceStage,
  report: MaintenanceReport,
  host: string,
): Promise<void> {
  const currentState = await readMaintenanceState(dataRoot);
  const stageState: StageState = {
    lastRunAt: new Date(report.finishedAt).toISOString(),
    lastDurationMs: report.durationMs,
    lastResult: extractReportSummary(report),
    lastError:
      report.errors.length > 0
        ? report.errors.map((e) => `[${e.stage}] ${e.message}`).join("; ")
        : null,
  };

  const nextState: MaintenanceState = {
    version: 1,
    stages: { ...currentState.stages, [stage]: stageState },
    updatedAt: new Date().toISOString(),
    updatedBy: host,
  };

  const dir = join(dataRoot, STATE_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, STATE_FILE_NAME);
  await writeFile(filePath, JSON.stringify(nextState, null, 2) + "\n", "utf8");
}

/**
 * 从 MaintenanceReport 提取可持久化的 summary。
 *
 * 剔除 downstreamReport 大对象(聚类矩阵 / 候选 pattern 列表可能很大),
 * 仅保留数字 / 布尔 / 字符串字段 + 数组类字段的 count。
 * 保证 maintenance-state.json 单文件 < 2 KB。
 */
function extractReportSummary(
  report: MaintenanceReport,
): Readonly<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  if (report.signalsProcessed !== undefined) {
    summary.signalsProcessed = report.signalsProcessed;
  }
  if (report.rpeUpdates !== undefined) summary.rpeUpdates = report.rpeUpdates;
  if (report.windowsClosed !== undefined) {
    summary.windowsClosed = report.windowsClosed;
  }
  if (report.promptSignalsUpdated !== undefined) {
    summary.promptSignalsUpdated = report.promptSignalsUpdated;
  }
  if (report.decayed !== undefined) summary.decayed = report.decayed;
  if (report.errors.length > 0) {
    summary.errorCount = report.errors.length;
  }
  // downstreamReport 是 dreaming 结果,可能很大;只保留标量字段 + 数组 count
  if (report.downstreamReport && typeof report.downstreamReport === "object") {
    const ds = report.downstreamReport as Record<string, unknown>;
    const dsSummary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ds)) {
      if (k === "remModified" && Array.isArray(v)) {
        // remModified 保留具体(engramId + action),供 viewer 实例化展示
        // 「上次 REM 升级/反驳了哪些 engram」。通常 2-29 条 × ~50 字节 < 1.5KB。
        dsSummary.remModified = v;
      } else if (
        typeof v === "number" ||
        typeof v === "string" ||
        typeof v === "boolean"
      ) {
        dsSummary[k] = v;
      } else if (Array.isArray(v)) {
        dsSummary[`${k}Count`] = v.length;
      }
    }
    if (Object.keys(dsSummary).length > 0) {
      summary.downstreamSummary = dsSummary;
    }
  }
  return summary;
}
