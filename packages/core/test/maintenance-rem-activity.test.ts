import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { IndexDb } from "../src/storage/index-db.js";
import { MemorySignalSink } from "../src/signals/file-sink.js";
import { MaintenanceEngine } from "../src/maintenance/index.js";
import {
  DEFAULT_REM_ACTIVITY_THRESHOLD,
  DEFAULT_REM_MIN_INTERVAL_MS,
} from "../src/maintenance/index.js";
import { readMaintenanceState } from "../src/maintenance/state.js";
import { createDreamingScheduler } from "../src/dreaming/scheduler.js";

/**
 * P0-1「REM 活动量累积阈值」混合触发回归测试。
 *
 * 触发条件(runLight 尾部检查):
 *   - remActivityThreshold > 0(enabledStages 含 rem + dataRoot 可用)
 *   - 距上次 REM ≥ remMinIntervalMs(防抖)
 *   - 自上次 REM 以来新增 engram 的 Σimportance ≥ 阈值
 */
describe("MaintenanceEngine - REM 活动量累积触发(P0-1)", () => {
  let tmpDir: string;
  let repo: EngramRepository;
  let sink: MemorySignalSink;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rem-act-"));
    sink = new MemorySignalSink();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEngine(
    rootPath: string,
    repository: EngramRepository,
    extraConfig: Record<string, unknown> = {},
  ): MaintenanceEngine {
    return new MaintenanceEngine(
      {
        repository,
        signalSink: sink,
        dreamingScheduler: createDreamingScheduler(repository, {
          lightIntervalMs: 60_000,
          deepIntervalMs: 60_000,
          remIntervalMs: 7 * 24 * 3600_000,
        }),
        dataRoot: rootPath,
        host: "test",
      },
      {
        lightIntervalMs: 60_000,
        deepIntervalMs: 60_000,
        // 时间兜底拉到 7 天:测试窗口内 REM 只可能因活动量触发
        remIntervalMs: 7 * 24 * 3600_000,
        remActivityThreshold: 1.0,
        ...extraConfig,
      },
    );
  }

  /** 写一个 lastRunAt 在 agoMs 之前的 maintenance-state(模拟"上次 REM"时刻) */
  function seedRemState(rootPath: string, agoMs: number): string {
    const dir = join(rootPath, ".co-engram");
    mkdirSync(dir, { recursive: true });
    const lastRunAt = new Date(Date.now() - agoMs).toISOString();
    writeFileSync(
      join(dir, "maintenance-state.json"),
      JSON.stringify(
        {
          version: 1,
          stages: {
            rem: {
              lastRunAt,
              lastDurationMs: 1,
              lastResult: {},
              lastError: null,
            },
          },
          updatedAt: lastRunAt,
          updatedBy: "test",
        },
        null,
        2,
      ) + "\n",
    );
    return lastRunAt;
  }

  function createEngram(repository: EngramRepository, title: string): void {
    repository.createEngram({
      title,
      content: `content for ${title}`,
      kind: "fact",
      domainTags: ["rem-activity-test"],
      createdBy: "test",
    });
  }

  it("默认配置:阈值 12.0 / 防抖 12h", () => {
    expect(DEFAULT_REM_ACTIVITY_THRESHOLD).toBe(12.0);
    expect(DEFAULT_REM_MIN_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const config = engine.getConfig();
    expect(config.remActivityThreshold).toBe(12.0);
    expect(config.remMinIntervalMs).toBe(12 * 60 * 60 * 1000);
  });

  it("活动量达阈值提前触发 REM(SQLite 主路径)", async () => {
    const indexDb = new IndexDb({
      dbPath: join(tmpDir, ".co-engram", "index.db"),
    });
    repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
    const lastRunAt = seedRemState(tmpDir, 13 * 3600_000); // 出 12h 防抖,未到 7d 兜底
    createEngram(repo, "alpha"); // 默认 importance 0.5
    createEngram(repo, "beta"); // Σ = 1.0 ≥ 1.0

    const engine = makeEngine(tmpDir, repo);
    await engine.runLight();

    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem?.lastRunAt).not.toBe(lastRunAt);
  });

  it("防抖窗口内不触发", async () => {
    repo = new EngramRepository({ rootPath: tmpDir });
    const lastRunAt = seedRemState(tmpDir, 3600_000); // 1h 前,在 12h 防抖窗口内
    createEngram(repo, "alpha");
    createEngram(repo, "beta");

    const engine = makeEngine(tmpDir, repo);
    await engine.runLight();

    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem?.lastRunAt).toBe(lastRunAt);
  });

  it("零活动(Σ=0)不触发", async () => {
    repo = new EngramRepository({ rootPath: tmpDir });
    const lastRunAt = seedRemState(tmpDir, 13 * 3600_000);

    const engine = makeEngine(tmpDir, repo);
    await engine.runLight();

    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem?.lastRunAt).toBe(lastRunAt);
  });

  it("阈值设 0 禁用,退回纯时间触发", async () => {
    repo = new EngramRepository({ rootPath: tmpDir });
    const lastRunAt = seedRemState(tmpDir, 13 * 3600_000);
    createEngram(repo, "alpha");
    createEngram(repo, "beta");

    const engine = makeEngine(tmpDir, repo, { remActivityThreshold: 0 });
    await engine.runLight();

    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem?.lastRunAt).toBe(lastRunAt);
  });

  it("rem 不在 enabledStages 时不触发", async () => {
    repo = new EngramRepository({ rootPath: tmpDir });
    const lastRunAt = seedRemState(tmpDir, 13 * 3600_000);
    createEngram(repo, "alpha");
    createEngram(repo, "beta");

    const engine = makeEngine(tmpDir, repo, {
      enabledStages: ["light", "deep"],
    });
    await engine.runLight();

    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem?.lastRunAt).toBe(lastRunAt);
  });
});

describe("sumImportanceSince", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-sum-imp-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("SQLite 主路径:只累计时间窗内新增", () => {
    const indexDb = new IndexDb({
      dbPath: join(tmpDir, ".co-engram", "index.db"),
    });
    const repo = new EngramRepository({ rootPath: tmpDir }, indexDb);
    const before = new Date(Date.now() - 1000).toISOString();
    const e1 = repo.createEngram({
      title: "new one",
      content: "c",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    const sum = repo.sumImportanceSince(before);
    expect(sum).toBeCloseTo(e1.importance, 5);
    // 无时间窗内新增时为 0
    expect(repo.sumImportanceSince(new Date().toISOString())).toBe(0);
  });

  it("无 indexDb 兜底路径:遍历 entries + readEngram", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    const before = new Date(Date.now() - 1000).toISOString();
    const e1 = repo.createEngram({
      title: "mem fallback",
      content: "c",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    expect(repo.sumImportanceSince(before)).toBeCloseTo(e1.importance, 5);
  });

  it("非法 sinceIso 返回 0", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    expect(repo.sumImportanceSince("not-a-date")).toBe(0);
  });
});
