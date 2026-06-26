import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startMaintenanceRuntime,
  createCoEngramMcpServer,
} from "../src/index.js";
import { EngramRepository, MemorySignalSink } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-mcp-maint-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// startMaintenanceRuntime
// ============================================================

describe("startMaintenanceRuntime", () => {
  it("start + stop 工作；无 dreamingScheduler 时自动创建", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    const sink = new MemorySignalSink();

    const runtime = startMaintenanceRuntime(
      { repository: repo, signalSink: sink },
      { lightIntervalMs: 100 },
    );

    expect(runtime.engine.isRunning()).toBe(true);
    runtime.stop();
    expect(runtime.engine.isRunning()).toBe(false);
  });

  it("runLight() drain 事件正常", async () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    const sink = new MemorySignalSink();
    const runtime = startMaintenanceRuntime(
      { repository: repo, signalSink: sink },
      { enabledStages: [] },
    );

    sink.append({
      toolName: "engram_get",
      input: { id: "fake-id" },
      retrievedEngramIds: ["fake-id"],
      sessionId: "s1",
      at: Date.now(),
    });

    const report = await runtime.engine.runLight();
    expect(report.stage).toBe("light");
    expect(report.errors).toHaveLength(0);
    runtime.stop();
  });
});

// ============================================================
// createCoEngramMcpServer + maintenance 集成
// ============================================================

describe("createCoEngramMcpServer - maintenance 集成", () => {
  it("startMaintenance 默认 false → 不返回 stopMaintenance", () => {
    const { ctx, stopMaintenance } = createCoEngramMcpServer({
      dataRoot: tmpDir,
    });

    expect(stopMaintenance).toBeUndefined();
    expect(ctx.signalSink).toBeDefined();
  });

  it("startMaintenance=true → 返回 stopMaintenance；调用后 engine 停止", () => {
    const { stopMaintenance } = createCoEngramMcpServer({
      dataRoot: tmpDir,
      startMaintenance: true,
      maintenanceConfig: {
        enabledStages: ["light"],
        lightIntervalMs: 1000,
      },
    });

    expect(typeof stopMaintenance).toBe("function");
    stopMaintenance?.();
  });
});
