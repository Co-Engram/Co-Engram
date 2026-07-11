import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readMaintenanceState,
  writeStageState,
  maintenanceStatePath,
  EMPTY_STATE,
  type MaintenanceState,
} from "../src/maintenance/state.js";
import type { MaintenanceReport, MaintenanceStage } from "../src/maintenance/types.js";

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
      writeFileSync(
        maintenanceStatePath(tmpDir),
        "{not valid json",
        "utf8",
      );
      const state = await readMaintenanceState(tmpDir);
      expect(state).toEqual(EMPTY_STATE);
    });

    it("version != 1 → EMPTY_STATE(防 schema 漂移)", async () => {
      mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
      writeFileSync(
        maintenanceStatePath(tmpDir),
        JSON.stringify({ version: 2, stages: {}, updatedAt: "", updatedBy: "" }),
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
});
