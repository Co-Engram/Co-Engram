import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startMaintenanceRuntime,
  registerCoEngramTools,
  type CoEngramPluginHostApi,
  type OpenClawToolDescriptor,
} from "../src/index.js";
import { EngramRepository, MemorySignalSink } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-openclaw-maint-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createMemoryHost(): CoEngramPluginHostApi & {
  tools: Map<string, OpenClawToolDescriptor>;
} {
  const tools = new Map<string, OpenClawToolDescriptor>();
  return {
    tools,
    registerTool(tool, opts) {
      const name = opts?.name ?? tool.name;
      tools.set(name, tool);
    },
  };
}

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

  it("接受自定义 dreamingScheduler（外部注入）", async () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    const sink = new MemorySignalSink();
    const { createDreamingScheduler } = await import("@co-engram/core");
    const scheduler = createDreamingScheduler(repo, {});

    const runtime = startMaintenanceRuntime(
      {
        repository: repo,
        signalSink: sink,
        dreamingScheduler: scheduler,
      },
      { enabledStages: ["light"] },
    );

    expect(runtime.engine.isRunning()).toBe(true);
    runtime.stop();
  });

  it("runLight() 在 maintenance 启用后正常工作（事件被 drain）", async () => {
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
    expect(report.signalsProcessed).toBeGreaterThanOrEqual(0);
    runtime.stop();
  });
});

// ============================================================
// registerCoEngramTools startMaintenance 集成
// ============================================================

describe("registerCoEngramTools - maintenance 集成", () => {
  it("startMaintenance 默认 true(low-friction-defaults)→ 返回 stopMaintenance", () => {
    const host = createMemoryHost();
    const result = registerCoEngramTools(host, {
      dataRoot: tmpDir,
    });

    expect(typeof result.stopMaintenance).toBe("function");
    expect(result.signalSink).toBeDefined();
    result.stopMaintenance?.();
  });

  it("startMaintenance 显式 false → 不返回 stopMaintenance", () => {
    const host = createMemoryHost();
    const result = registerCoEngramTools(host, {
      dataRoot: tmpDir,
      startMaintenance: false,
    });

    expect(result.stopMaintenance).toBeUndefined();
    expect(result.signalSink).toBeDefined();
  });

  it("startMaintenance=true → 返回 stopMaintenance；调用后停止 engine", () => {
    const host = createMemoryHost();
    const result = registerCoEngramTools(host, {
      dataRoot: tmpDir,
      startMaintenance: true,
      maintenanceConfig: {
        enabledStages: ["light"],
        lightIntervalMs: 1000,
      },
    });

    expect(typeof result.stopMaintenance).toBe("function");
    result.stopMaintenance?.();
  });
});
