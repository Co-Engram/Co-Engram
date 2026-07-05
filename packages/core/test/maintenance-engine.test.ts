import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { MemorySignalSink } from "../src/signals/file-sink.js";
import type { ToolCallEvent } from "../src/signals/types.js";
import {
  MaintenanceEngine,
  DEFAULT_LIGHT_INTERVAL_MS,
  DEFAULT_DEEP_INTERVAL_MS,
  DEFAULT_REM_INTERVAL_MS,
  DEFAULT_DAILY_INTERVAL_MS,
  DEFAULT_SIGNAL_PRUNE_AGE_MS,
} from "../src/maintenance/index.js";
import type { MaintenanceReport } from "../src/maintenance/index.js";
import { AuditLog } from "../src/observability/audit-log.js";
import { createDreamingScheduler } from "../src/dreaming/scheduler.js";

let tmpDir: string;
let repo: EngramRepository;
let sink: MemorySignalSink;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-maint-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  sink = new MemorySignalSink();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(
  overrides: Partial<ToolCallEvent> & { toolName: string },
): ToolCallEvent {
  return {
    input: {},
    sessionId: "s1",
    at: Date.now(),
    ...overrides,
  };
}

function setupEngramWithScore(score: number, title: string = "Test"): string {
  const engram = repo.createEngram({
    title,
    content: "hello",
    kind: "fact",
    domainTags: [title.toLowerCase()],
    createdBy: "tester",
  });
  repo.bumpRetrievalStats(engram.id, { lastRetrievalScore: score });
  return engram.id;
}

// ============================================================
// 默认配置
// ============================================================

describe("MaintenanceEngine - 默认配置", () => {
  it("默认间隔合理", () => {
    expect(DEFAULT_LIGHT_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_DEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_REM_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_DAILY_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_SIGNAL_PRUNE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("零配置启动默认全开 light/deep/rem/daily", () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const config = engine.getConfig();
    expect(config.enabledStages).toEqual(["light", "deep", "rem", "daily"]);
    expect(config.learningRate).toBe(0.1);
    expect(config.windowSize).toBe(10);
  });

  it("自定义配置生效", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 1000, learningRate: 0.5, windowSize: 5 },
    );
    const config = engine.getConfig();
    expect(config.lightIntervalMs).toBe(1000);
    expect(config.learningRate).toBe(0.5);
    expect(config.windowSize).toBe(5);
  });
});

// ============================================================
// runLight
// ============================================================

describe("MaintenanceEngine - runLight", () => {
  it("空 sink → 无更新", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runLight();
    expect(report.stage).toBe("light");
    expect(report.signalsProcessed).toBe(0);
    expect(report.rpeUpdates).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("drain 后 events 数为 0,二次 runLight 返回 0", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["x"], at: 1 }),
    );
    await engine.runLight();
    const report2 = await engine.runLight();
    expect(report2.signalsProcessed).toBe(0);
  });

  it("repeated_get 信号 → reinforcementScore 增加", async () => {
    const id = setupEngramWithScore(0.5);
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: [id], at: 1 }),
    );
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: [id], at: 2 }),
    );

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runLight();
    expect(report.signalsProcessed).toBeGreaterThan(0);
    expect(report.rpeUpdates).toBe(1);

    const engram = repo.readEngram(id);
    // 触发 repeated_get(+0.6) + get_no_resimilar_search(+0.4) = 1.0
    // expected=0.5, actual=(1.0+1)/2=1.0, rpe=0.5, delta=0.5*0.1=0.05
    expect(engram.reinforcementScore).toBeCloseTo(0.05, 5);
    expect(engram.effectiveRetrievals).toBe(1);
  });

  it("contradicts_created 信号 → reinforcementScore 减少", async () => {
    const id = setupEngramWithScore(0.5);
    sink.append(
      makeEvent({
        toolName: "synapse_create",
        input: { from: "new", to: id, kind: "contradicts" },
        at: 1,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runLight();
    expect(report.rpeUpdates).toBe(1);

    const engram = repo.readEngram(id);
    // expected=0.5, actual=(-0.8+1)/2=0.1, rpe=-0.4, delta=-0.4*0.1=-0.04
    expect(engram.reinforcementScore).toBeCloseTo(-0.04, 5);
    expect(engram.failedUses).toBe(1);
  });

  it("engram 已删除时跳过（不抛错）", async () => {
    sink.append(
      makeEvent({
        toolName: "synapse_create",
        input: { from: "x", to: "deleted-id", kind: "contradicts" },
        at: 1,
      }),
    );
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runLight();
    expect(report.rpeUpdates).toBe(0);
    expect(report.errors).toHaveLength(0);
  });

  it("多 engram 信号 → 各自独立 RPE 更新", async () => {
    const a = setupEngramWithScore(0.5, "Alpha");
    const b = setupEngramWithScore(0.5, "Beta");
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: [a], at: 1 }),
    );
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: [a], at: 2 }),
    );
    sink.append(
      makeEvent({
        toolName: "synapse_create",
        input: { from: "x", to: b, kind: "contradicts" },
        at: 3,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runLight();
    expect(report.rpeUpdates).toBe(2);

    const engramA = repo.readEngram(a);
    const engramB = repo.readEngram(b);
    expect(engramA.reinforcementScore).toBeGreaterThan(0);
    expect(engramB.reinforcementScore).toBeLessThan(0);
  });

  it("prune 在 runLight 后被调用", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const pruneSpy = vi.spyOn(sink, "prune");
    await engine.runLight();
    expect(pruneSpy).toHaveBeenCalledOnce();
  });

  it("中性信号（|rpe| ≤ 0.05）→ 不更新", async () => {
    // 构造 rpe ≈ 0 的场景：expected 高（0.95）, 信号弱正（0.4）
    // actual = (0.4+1)/2 = 0.7, rpe = 0.7 - 0.95 = -0.25 ← 还是触发
    // 改为：expected = 0.7, 信号 sum = 0.4 → actual = 0.7, rpe = 0,中性
    const id = setupEngramWithScore(0.7, "Neutral");
    // 触发 get_no_resimilar_search (+0.4) 单一信号
    sink.append(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: [id], at: 1 }),
    );
    // 后续无 search,触发 +0.4 信号

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    await engine.runLight();
    const engram = repo.readEngram(id);
    expect(engram.reinforcementScore).toBe(0);
    expect(engram.effectiveRetrievals).toBe(0);
    expect(engram.failedUses).toBe(0);
  });

  it("老 engram 无 lastRetrievalScore → 用 0.5 默认", async () => {
    const engram = repo.createEngram({
      title: "old",
      content: "c",
      kind: "fact",
      domainTags: ["d"],
      createdBy: "t",
    });
    // 不调 bumpRetrievalScore,让 lastRetrievalScore 保持默认 0.5（meta 初始写入）
    sink.append(
      makeEvent({
        toolName: "engram_get",
        retrievedEngramIds: [engram.id],
        at: 1,
      }),
    );
    sink.append(
      makeEvent({
        toolName: "engram_get",
        retrievedEngramIds: [engram.id],
        at: 2,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    await engine.runLight();
    // 应该走默认 0.5 路径,reinforcementScore 变化
    const updated = repo.readEngram(engram.id);
    expect(updated.reinforcementScore).not.toBe(0);
  });
});

// ============================================================
// runDeep / runRem 占位
// ============================================================

describe("MaintenanceEngine - runDeep/runRem 占位", () => {
  it("runDeep 无 dreamingScheduler → 报告错误", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runDeep();
    expect(report.stage).toBe("deep");
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toContain("dreamingScheduler");
  });

  it("runRem 无 dreamingScheduler → 报告错误", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runRem();
    expect(report.stage).toBe("rem");
    expect(report.errors).toHaveLength(1);
  });

  it("报告结构包含必要字段", async () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report: MaintenanceReport = await engine.runLight();
    expect(report).toHaveProperty("startedAt");
    expect(report).toHaveProperty("finishedAt");
    expect(report).toHaveProperty("durationMs");
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
  });
});

describe("MaintenanceEngine - runRem 集成", () => {
  it("runRem 触发 dreaming + 对所有 engram 跑 metacognition", async () => {
    const scheduler = createDreamingScheduler(repo, {});
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
      dreamingScheduler: scheduler,
    });

    // 创建若干 engram（不同的 domain 避免聚类）
    repo.createEngram({
      title: "A",
      content: "content-a",
      kind: "fact",
      domainTags: ["alpha-1", "alpha-2", "alpha-3"],
      createdBy: "tester",
    });
    repo.createEngram({
      title: "B",
      content: "content-b",
      kind: "fact",
      domainTags: ["beta-1", "beta-2", "beta-3"],
      createdBy: "tester",
    });

    const report = await engine.runRem();
    expect(report.stage).toBe("rem");
    expect(report.errors).toHaveLength(0);
    expect(report.downstreamReport).toBeDefined();
    const ds = report.downstreamReport as {
      dream: unknown;
      metacognitionApplied: number;
      metacognitionTotal: number;
    };
    expect(ds.metacognitionTotal).toBe(2);
    expect(ds.metacognitionApplied).toBeGreaterThanOrEqual(0);
  });

  it("runRem 空 repo → 0 engram,无错误", async () => {
    const scheduler = createDreamingScheduler(repo, {});
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
      dreamingScheduler: scheduler,
    });
    const report = await engine.runRem();
    expect(report.errors).toHaveLength(0);
    const ds = report.downstreamReport as { metacognitionTotal: number };
    expect(ds.metacognitionTotal).toBe(0);
  });

  it("runRem 对 refuted engram 跳过（不在候选列表）", async () => {
    const engram = repo.createEngram({
      title: "Refuted",
      content: "c",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "tester",
    });
    repo.updateVerificationStatus(engram.id, "refuted");

    const scheduler = createDreamingScheduler(repo, {});
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
      dreamingScheduler: scheduler,
    });
    const report = await engine.runRem();
    const ds = report.downstreamReport as { metacognitionTotal: number };
    expect(ds.metacognitionTotal).toBe(0); // refuted 被排除
  });

  it("runDeep 接入 dreamingScheduler 正常", async () => {
    const scheduler = createDreamingScheduler(repo, {});
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
      dreamingScheduler: scheduler,
    });
    const report = await engine.runDeep();
    expect(report.stage).toBe("deep");
    expect(report.errors).toHaveLength(0);
    expect(report.downstreamReport).toBeDefined();
  });
});

// ============================================================
// start/stop 调度
// ============================================================

describe("MaintenanceEngine - start/stop", () => {
  it("start() 后 isRunning=true", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 10, deepIntervalMs: 10, remIntervalMs: 10 },
    );
    expect(engine.isRunning()).toBe(false);
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
  });

  it("stop() 后 isRunning=false", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 10 },
    );
    engine.start();
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  it("重复 start 不产生多个定时器", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 100 },
    );
    engine.start();
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
  });

  it("未 start 直接 stop → 无副作用", () => {
    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    expect(() => engine.stop()).not.toThrow();
    expect(engine.isRunning()).toBe(false);
  });

  it("enabledStages 限制只启动某些阶段", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 100, enabledStages: ["light"] },
    );
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
  });

  it("enabledStages 空数组 → start 仍算运行但无定时器", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { enabledStages: [] },
    );
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
  });
});

// ============================================================
// 审计日志回归 (契约:阶段触发本身不写 audit)
// ============================================================

describe("MaintenanceEngine - 审计日志回归", () => {
  // 阶段触发本身是高频噪音(light 5min/次,1 年 ~10万条),已从 audit 中移除。
  // 下游任务(sweep_to_trash / reinforce / forget / refute)自己写状态变更 audit。
  // daily 阶段同理 —— 全量 engram × 每天会产生海量噪音,通过 MaintenanceReport.decayed 暴露。
  // 这个回归测试保护契约,防止未来回退到噪音状态。
  it("runLight/runDeep/runRem/runDaily 不写任何 audit event", async () => {
    const auditLog = new AuditLog(tmpDir);
    const scheduler = createDreamingScheduler(repo, {});
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink, dreamingScheduler: scheduler },
      { enabledStages: ["light", "deep", "rem", "daily"] },
    );
    await engine.runLight();
    await engine.runDeep();
    await engine.runRem();
    await engine.runDaily();

    // 整个 audit.jsonl 应该为空 —— maintenance 阶段触发不写,下游任务在本测试也未触发
    const all = auditLog.query({ limit: 1000 });
    expect(all.length).toBe(0);
  });
});

// ============================================================
// runDaily(applyDailyDecay —— 全量乘性衰减)
// ============================================================

describe("MaintenanceEngine - runDaily", () => {
  function makeEngram(importance: number) {
    const engram = repo.createEngram({
      title: `T-${importance}-${Math.random().toString(36).slice(2, 8)}`,
      content: "daily decay test",
      kind: "fact",
      domainTags: ["daily"],
      createdBy: "tester",
      importance,
    });
    return engram.id;
  }

  it("runDaily 衰减所有 active engram × 0.95", async () => {
    const idA = makeEngram(0.5);
    const idB = makeEngram(1.0);
    const idC = makeEngram(0.3);

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runDaily();

    expect(repo.readEngram(idA).importance).toBeCloseTo(0.475, 5);
    expect(repo.readEngram(idB).importance).toBeCloseTo(0.95, 5);
    expect(repo.readEngram(idC).importance).toBeCloseTo(0.285, 5);
    expect(report.decayed).toBe(3);
    expect(report.stage).toBe("daily");
  });

  it("runDaily 跳过 archived / forgotten engram(lifecycle status)", async () => {
    const idActive = makeEngram(0.5);
    const idArchived = makeEngram(0.7);
    const idForgotten = makeEngram(0.8);
    repo.updateLifecycle(idArchived, "archived", undefined);
    repo.updateLifecycle(idForgotten, "forgotten", undefined);

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runDaily();

    expect(repo.readEngram(idActive).importance).toBeCloseTo(0.475, 5);
    expect(repo.readEngram(idArchived).importance).toBe(0.7);
    expect(repo.readEngram(idForgotten).importance).toBe(0.8);
    expect(report.decayed).toBe(1);
  });

  it("runDaily 不写 audit log(高频噪音,通过 report.decayed 暴露)", async () => {
    const auditLog = new AuditLog(tmpDir);
    makeEngram(0.5);

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    await engine.runDaily();

    const all = auditLog.query({ limit: 1000 });
    expect(all.length).toBe(0);
  });

  it("runDaily 在 importance=0 边界无变化,decayed 不计入", async () => {
    const id = makeEngram(0);

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    const report = await engine.runDaily();

    expect(repo.readEngram(id).importance).toBe(0);
    expect(report.decayed).toBe(0);
  });

  it("runDaily 写入 updatedBy='maintenance.daily' 标记", async () => {
    const id = makeEngram(0.5);

    const engine = new MaintenanceEngine({
      repository: repo,
      signalSink: sink,
    });
    await engine.runDaily();

    expect(repo.readEngram(id).updatedBy).toBe("maintenance.daily");
  });

  it("start() 启动 daily 定时器,stop() 清理", () => {
    const engine = new MaintenanceEngine(
      { repository: repo, signalSink: sink },
      { dailyIntervalMs: 100, enabledStages: ["daily"] },
    );
    expect(engine.isRunning()).toBe(false);
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });
});
