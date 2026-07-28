import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readMaintenanceState,
  writeStageState,
  maintenanceStatePath,
  type MaintenanceState,
} from "../../src/maintenance/state.js";

/**
 * 验证 REM checkpoint 一致性(异常场景)。
 *
 * checkpoint 设计:REM 进行中写顶层 remCheckpoint(不动 stages.rem.lastRunAt);
 * REM 完成 final writeStageState(rem) 清 remCheckpoint。catch-up 看 lastRunAt(未完成=旧/undefined→重跑),
 * remCheckpoint 不污染 lastRunAt 语义。
 */
describe("REM checkpoint 一致性", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-rem-ckpt-"));
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 写一个含 remCheckpoint 的 state(模拟 REM 进行中) */
  async function seedRemCheckpoint(): Promise<void> {
    const state: MaintenanceState = {
      version: 1,
      stages: { light: undefined, deep: undefined, rem: undefined },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
      remCheckpoint: {
        phase: "post-dreaming",
        at: new Date().toISOString(),
        partial: { dream: "mockRecord" },
      },
    };
    writeFileSync(
      maintenanceStatePath(tmpDir),
      JSON.stringify(state, null, 2) + "\n",
      "utf8",
    );
  }

  const fakeReport = {
    stage: "rem" as const,
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
    errors: [],
  };

  it("REM 完成 writeStageState(rem) → 清 remCheckpoint + 写 lastRunAt", async () => {
    await seedRemCheckpoint();
    const before = await readMaintenanceState(tmpDir);
    expect(before.remCheckpoint).toBeDefined(); // 进行中

    await writeStageState(tmpDir, "rem", fakeReport, "test");

    const after = await readMaintenanceState(tmpDir);
    expect(after.remCheckpoint).toBeUndefined(); // 完成 → 清
    expect(after.stages.rem?.lastRunAt).toBeTruthy(); // 完成时间
  });

  it("light/deep 完成 writeStageState(light) → 不清 remCheckpoint(REM 仍进行中)", async () => {
    await seedRemCheckpoint();
    await writeStageState(tmpDir, "light", { ...fakeReport, stage: "light" }, "test");
    const after = await readMaintenanceState(tmpDir);
    expect(after.remCheckpoint).toBeDefined(); // REM 进行中标记保留
  });

  it("remCheckpoint 不影响 stages.rem(未完成时 stages.rem 仍 undefined/旧)", async () => {
    await seedRemCheckpoint();
    const state = await readMaintenanceState(tmpDir);
    expect(state.stages.rem).toBeUndefined(); // REM 未完成 → stages.rem 不存在
    expect(state.remCheckpoint).toBeDefined(); // 但 remCheckpoint 有(进度留痕)
    // catch-up 判定看 stages.rem.lastRunAt(undefined → 从未完成 → 重跑)
    expect(state.stages.rem?.lastRunAt).toBeUndefined();
  });
});
