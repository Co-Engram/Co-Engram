import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readMaintenanceState,
  writeStageState,
  maintenanceStatePath,
  EMPTY_STATE,
  type MaintenanceState,
} from "../src/maintenance/state.js";
import type {
  MaintenanceReport,
  MaintenanceStage,
} from "../src/maintenance/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-maint-state-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeReport(
  overrides: Partial<MaintenanceReport> & { stage: MaintenanceStage },
): MaintenanceReport {
  const finishedAt = Date.now();
  return {
    startedAt: finishedAt - 100,
    finishedAt,
    durationMs: 100,
    errors: [],
    ...overrides,
  };
}

describe("maintenance state 持久化(方案 A)", () => {
  // ============================================================
  // maintenanceStatePath
  // ============================================================
  describe("maintenanceStatePath", () => {
    it("返回 <dataRoot>/.co-engram/maintenance-state.json 路径", () => {
      const p = maintenanceStatePath(tmpDir);
      expect(p).toBe(join(tmpDir, ".co-engram", "maintenance-state.json"));
    });
  });

  // ============================================================
  // readMaintenanceState
  // ============================================================
  describe("readMaintenanceState", () => {
    it("文件不存在 → EMPTY_STATE", async () => {
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
      expect(state.stages.rem).toBeUndefined();
    });

    it("文件损坏 JSON → EMPTY_STATE", async () => {
      mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
      writeFileSync(maintenanceStatePath(tmpDir), "{not valid json", "utf8");
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
    });

    it("version != 1 → EMPTY_STATE(防 schema 漂移)", async () => {
      mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
      writeFileSync(
        maintenanceStatePath(tmpDir),
        JSON.stringify({
          version: 2,
          stages: {},
          updatedAt: "",
          updatedBy: "",
        }),
        "utf8",
      );
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
    });

    it("缺 stages 字段 → EMPTY_STATE", async () => {
      mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
      writeFileSync(
        maintenanceStatePath(tmpDir),
        JSON.stringify({ version: 1, updatedAt: "", updatedBy: "" }),
        "utf8",
      );
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
    });

    it("正常 round-trip:write 后 read 一致", async () => {
      const report = makeReport({
        stage: "rem",
        downstreamReport: {
          clustersProcessed: 5,
          patternsProposed: 2,
          adoptedPatterns: [1, 2, 3], // 数组,应被压成 count
        },
      });
      await writeStageState(tmpDir, "rem", report, "claude-code-mcp");
      const state = await readMaintenanceState(tmpDir);
      expect(state.version).toBe(1);
      expect(state.updatedBy).toBe("claude-code-mcp");
      expect(state.stages.rem).toBeDefined();
      expect(state.stages.rem?.lastDurationMs).toBe(100);
      expect(state.stages.rem?.lastError).toBeNull();
      expect(state.stages.rem?.lastResult.downstreamSummary).toEqual({
        clustersProcessed: 5,
        patternsProposed: 2,
        adoptedPatternsCount: 3,
      });
      // 其他 stage 不受影响
      expect(state.stages.light).toBeUndefined();
      expect(state.stages.deep).toBeUndefined();
      expect(state.stages.daily).toBeUndefined();
    });
  });

  // ============================================================
  // writeStageState
  // ============================================================
  describe("writeStageState", () => {
    it("单 stage 更新不影响其他 stage(read-modify-write)", async () => {
      // 先写 light
      await writeStageState(
        tmpDir,
        "light",
        makeReport({ stage: "light", signalsProcessed: 5 }),
        "host-A",
      );
      // 再写 rem
      await writeStageState(
        tmpDir,
        "rem",
        makeReport({ stage: "rem", decayed: 100 }),
        "host-B",
      );

      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.light).toBeDefined();
      expect(state.stages.light?.lastResult.signalsProcessed).toBe(5);
      expect(state.stages.rem).toBeDefined();
      expect(state.stages.rem?.lastResult.decayed).toBe(100);
      // updatedBy 取最后写入的 host
      expect(state.updatedBy).toBe("host-B");
    });

    it("downstreamReport 大对象被压成标量 summary + 数组 count", async () => {
      const report = makeReport({
        stage: "deep",
        downstreamReport: {
          // 标量保留
          clustersProcessed: 10,
          averageConfidence: 0.78,
          isFallback: true,
          // 数组只保留 count
          candidates: [
            { id: "a", score: 0.9 },
            { id: "b", score: 0.85 },
          ],
          // 嵌套对象被丢弃
          nestedMetadata: { foo: "bar", baz: [1, 2, 3] },
        },
      });
      await writeStageState(tmpDir, "deep", report, "host");
      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.deep?.lastResult.downstreamSummary).toEqual({
        clustersProcessed: 10,
        averageConfidence: 0.78,
        isFallback: true,
        candidatesCount: 2,
      });
      // nestedMetadata 完全不出现在文件里
      const rawFile = readFileSync(maintenanceStatePath(tmpDir), "utf8");
      expect(rawFile).not.toContain("nestedMetadata");
      expect(rawFile).not.toContain("foo");
    });

    it("errors 数组转字符串(可读 + 单行)", async () => {
      const report = makeReport({
        stage: "rem",
        errors: [
          { stage: "rem", message: "LLM 调用失败", at: 1234567890 },
          { stage: "rem", message: "fallback 启发式也失败", at: 1234567891 },
        ],
      });
      await writeStageState(tmpDir, "rem", report, "host");
      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.rem?.lastError).toBe(
        "[rem] LLM 调用失败; [rem] fallback 启发式也失败",
      );
      expect(state.stages.rem?.lastResult.errorCount).toBe(2);
    });

    it("成功 report:lastError = null,errorCount 不写入", async () => {
      await writeStageState(
        tmpDir,
        "light",
        makeReport({ stage: "light", signalsProcessed: 3 }),
        "host",
      );
      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.light?.lastError).toBeNull();
      expect(state.stages.light?.lastResult.errorCount).toBeUndefined();
    });

    it("维护文件 < 2 KB(单 stage summary,4 stage 全填也小)", async () => {
      const stages: MaintenanceStage[] = ["light", "deep", "rem", "daily"];
      for (const stage of stages) {
        await writeStageState(
          tmpDir,
          stage,
          makeReport({
            stage,
            signalsProcessed: 10,
            rpeUpdates: 5,
            downstreamReport:
              stage === "rem" || stage === "deep"
                ? {
                    clustersProcessed: 8,
                    patternsProposed: 3,
                    adoptedPatterns: [1],
                  }
                : undefined,
          }),
          "claude-code-mcp",
        );
      }
      const { statSync } = await import("node:fs");
      const size = statSync(maintenanceStatePath(tmpDir)).size;
      expect(size).toBeLessThan(2048);
    });
  });

  // ============================================================
  // 集成:通过 MaintenanceEngine.runLight 触发写盘
  // ============================================================
  describe("MaintenanceEngine 集成", () => {
    it("runLight 完成后 state.json 落盘 + 含 light stage 摘要", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
        },
        { enabledStages: ["light"] },
      );

      await engine.runLight();

      const state: MaintenanceState = await readMaintenanceState(tmpDir);
      expect(state.stages.light).toBeDefined();
      expect(state.stages.light?.lastDurationMs).toBeGreaterThanOrEqual(0);
      expect(state.updatedBy).toBe("test-host");
      expect(state.stages.rem).toBeUndefined();
      expect(state.stages.deep).toBeUndefined();
    });

    it("processLock.isHolder=false 时不写 state.json(防 holder 丢失残留)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "non-holder",
          processLock: { isHolder: false },
        },
        { enabledStages: ["light"] },
      );

      await engine.runLight();

      // 持锁=false 时不应写文件
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
    });

    it("processLock 未注入:向后兼容,正常写(适用单 host / 测试)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "legacy-host",
          // processLock 不注入
        },
        { enabledStages: ["light"] },
      );

      await engine.runLight();

      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.light).toBeDefined();
      expect(state.updatedBy).toBe("legacy-host");
    });
  });

  // ============================================================
  // scheduleCatchUp(方案 A 第 2 步)
  // ============================================================
  describe("scheduleCatchUp", () => {
    /**
     * 直接调用 private scheduleCatchUp(通过类型断言绕过),
     * 避免 start() 的 setInterval 副作用干扰测试。
     */
    async function callCatchUp(engine: {
      scheduleCatchUp: () => Promise<void>;
    }): Promise<void> {
      await engine.scheduleCatchUp();
    }

    /** 写一个 lastRunAt 已过期的 state.json,模拟「REM 已超期」场景 */
    async function seedExpiredState(
      dataRoot: string,
      stage: MaintenanceStage,
      daysAgo: number,
    ): Promise<void> {
      const lastRunAt = new Date(
        Date.now() - daysAgo * 24 * 60 * 60 * 1000,
      ).toISOString();
      const state = {
        version: 1 as const,
        stages: {
          light: undefined,
          deep: undefined,
          rem: undefined,
          daily: undefined,
          [stage]: {
            lastRunAt,
            lastDurationMs: 100,
            lastResult: {},
            lastError: null,
          },
        } as Record<MaintenanceStage, unknown>,
        updatedAt: lastRunAt,
        updatedBy: "old-host",
      };
      mkdirSync(join(dataRoot, ".co-engram"), { recursive: true });
      writeFileSync(
        maintenanceStatePath(dataRoot),
        JSON.stringify(state, null, 2) + "\n",
        "utf8",
      );
    }

    it("REM 已过期(8 天前):catch-up 立即触发,更新 state.json", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine, DEFAULT_REM_INTERVAL_MS } =
        await import("../src/maintenance/index.js");

      // sanity:8 天 > 7 天 default REM interval
      expect(DEFAULT_REM_INTERVAL_MS).toBe(1 * 24 * 60 * 60 * 1000);

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      // 注入 mock dreamingScheduler,让 runRem 不抛错
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: { clustersProcessed: 0 },
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "new-host",
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        // 只启用 rem,避免 daily/light 互相干扰断言
        { enabledStages: ["rem"] },
      );

      await seedExpiredState(tmpDir, "rem", 8);
      await callCatchUp(
        engine as unknown as { scheduleCatchUp: () => Promise<void> },
      );

      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.rem).toBeDefined();
      // updatedBy 从 "old-host" 变成 "new-host"(说明被新 host 的 catch-up 重写)
      expect(state.updatedBy).toBe("new-host");
      // lastRunAt 应该是 catch-up 触发时刻(刚刚),不再是 8 天前
      const newRunAt = new Date(state.stages.rem!.lastRunAt).getTime();
      expect(Date.now() - newRunAt).toBeLessThan(10_000); // < 10 秒前
    });

    it("REM 未到周期(6 天前):catch-up 不触发,state.json 不被改写", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: {},
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "new-host",
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        { enabledStages: ["rem"] },
      );

      await seedExpiredState(tmpDir, "rem", 0); // 0 天前(刚跑),未到周期(1天)
      await callCatchUp(
        engine as unknown as { scheduleCatchUp: () => Promise<void> },
      );

      const state = await readMaintenanceState(tmpDir);
      // updatedBy 应保持 "old-host"(未被 catch-up 改写)
      expect(state.updatedBy).toBe("old-host");
      // lastRunAt 应仍是 6 天前
      const runAt = new Date(state.stages.rem!.lastRunAt).getTime();
      expect(Date.now() - runAt).toBeLessThan(1 * 24 * 60 * 60 * 1000); // 不到1天
    });

    it("从未跑过 + 低频 stage(rem/daily):catch-up 立即触发", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: {},
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "fresh-host",
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        // 全启用,验证只有 rem + daily 立即跑,light/deep 不跑
        { enabledStages: ["rem", "daily", "deep", "light"] },
      );

      // state.json 不存在(全新环境)
      await callCatchUp(
        engine as unknown as { scheduleCatchUp: () => Promise<void> },
      );

      const state = await readMaintenanceState(tmpDir);
      expect(state.stages.rem).toBeDefined(); // 立即触发
      expect(state.stages.daily).toBeDefined(); // 立即触发
      expect(state.stages.deep).toBeUndefined(); // 不立即跑(setInterval 会触发)
      expect(state.stages.light).toBeUndefined(); // 不立即跑
    });

    it("低频优先顺序:rem 在 daily 之前被触发", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: {},
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "order-host",
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        { enabledStages: ["rem", "daily"] },
      );

      await callCatchUp(
        engine as unknown as { scheduleCatchUp: () => Promise<void> },
      );

      const state = await readMaintenanceState(tmpDir);
      // 两个都触发了
      expect(state.stages.rem).toBeDefined();
      expect(state.stages.daily).toBeDefined();
      // rem 的 lastRunAt <= daily 的 lastRunAt(rem 先跑)
      const remAt = new Date(state.stages.rem!.lastRunAt).getTime();
      const dailyAt = new Date(state.stages.daily!.lastRunAt).getTime();
      expect(remAt).toBeLessThanOrEqual(dailyAt);
    });

    it("processLock.isHolder=false:不触发任何 catch-up", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: {},
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "non-holder",
          processLock: { isHolder: false },
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        { enabledStages: ["rem", "daily", "deep", "light"] },
      );

      await seedExpiredState(tmpDir, "rem", 30); // 远过期
      await callCatchUp(
        engine as unknown as { scheduleCatchUp: () => Promise<void> },
      );

      const state = await readMaintenanceState(tmpDir);
      // 不持锁 → 不触发 catch-up → updatedBy 仍是 "old-host"
      expect(state.updatedBy).toBe("old-host");
    });
  });

  // ============================================================
  // audit log:maintenance_run 事件(方案 A 第 3 步)
  // ============================================================
  describe("audit log maintenance_run", () => {
    it("rem stage 完成 → 写 maintenance_run audit entry(含 stage/duration/errorCount)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");
      const { AuditLog } = await import("../src/observability/audit-log.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const auditLog = new AuditLog(tmpDir);
      const mockScheduler = {
        trigger: () => ({
          stage: "rem" as const,
          at: new Date().toISOString(),
          result: { clustersProcessed: 3, patternsProposed: 2 },
        }),
        start: () => {},
        stop: () => {},
        onRun: () => () => {},
      };
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
          auditLog,
          // @ts-expect-error mock minimal scheduler
          dreamingScheduler: mockScheduler,
        },
        { enabledStages: ["rem"] },
      );

      await engine.runRem();

      const events = auditLog.query({ action: "maintenance_run" });
      expect(events.length).toBe(1);
      const entry = events[0];
      expect(entry.actor).toBe("system");
      expect(entry.action).toBe("maintenance_run");
      expect(entry.host).toBe("test-host");
      expect(entry.metadata?.stage).toBe("rem");
      expect(typeof entry.metadata?.durationMs).toBe("number");
      expect(entry.metadata?.errorCount).toBe(0);
      // downstreamReport 被 extractAuditSummary 压成标量 + count
      // (dream 嵌套对象被丢弃,只保留 metacognition* 标量)
      expect(entry.metadata?.downstreamSummary).toMatchObject({
        metacognitionApplied: 0,
        metacognitionTotal: 0,
      });
    });

    it("daily stage 完成 → 写 maintenance_run audit entry(含 decayed)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");
      const { AuditLog } = await import("../src/observability/audit-log.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const auditLog = new AuditLog(tmpDir);
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
          auditLog,
        },
        { enabledStages: ["daily"] },
      );

      await engine.runDaily();

      const events = auditLog.query({ action: "maintenance_run" });
      expect(events.length).toBe(1);
      const entry = events[0];
      expect(entry.metadata?.stage).toBe("daily");
      expect(entry.metadata?.decayed).toBe(0); // 空 repo,无 engram 可衰减
    });

    it("light stage 完成 → 不写 maintenance_run(避免高频噪音)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");
      const { AuditLog } = await import("../src/observability/audit-log.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const auditLog = new AuditLog(tmpDir);
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
          auditLog,
        },
        { enabledStages: ["light"] },
      );

      await engine.runLight();

      const events = auditLog.query({ action: "maintenance_run" });
      expect(events.length).toBe(0); // light 不写 audit
    });

    it("未注入 auditLog → 跳过 audit 写入(stage 正常完成)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
          // auditLog 不注入
        },
        { enabledStages: ["daily"] },
      );

      // 不应抛错
      const report = await engine.runDaily();
      expect(report.stage).toBe("daily");
    });

    it("rem stage 失败 → 写 maintenance_run audit entry(含 errorMessage)", async () => {
      const { EngramRepository } = await import("../src/storage/repository.js");
      const { MemorySignalSink } = await import("../src/signals/file-sink.js");
      const { MaintenanceEngine } = await import("../src/maintenance/index.js");
      const { AuditLog } = await import("../src/observability/audit-log.js");

      const repo = new EngramRepository({ rootPath: tmpDir });
      const sink = new MemorySignalSink();
      const auditLog = new AuditLog(tmpDir);
      const engine = new MaintenanceEngine(
        {
          repository: repo,
          signalSink: sink,
          dataRoot: tmpDir,
          host: "test-host",
          auditLog,
          // dreamingScheduler 不注入 → runRem 抛 configError
        },
        { enabledStages: ["rem"] },
      );

      await engine.runRem();

      const events = auditLog.query({ action: "maintenance_run" });
      expect(events.length).toBe(1);
      const entry = events[0];
      expect(entry.metadata?.stage).toBe("rem");
      expect(entry.metadata?.errorCount).toBe(1);
      expect(typeof entry.metadata?.errorMessage).toBe("string");
    });
  });
});
