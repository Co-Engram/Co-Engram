/**
 * 沉思取用归因 ctx 注入测试(dsh-plugin,2026-08-22)
 *
 * createDshRuntime 读取 CO_ENGRAM_CONTEMPLATION_SESSION(headless executor
 * spawn 注入,经 claude 进程继承到本插件实例)置
 * retrievalAttribution="contemplation";缺省不置(向后兼容)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEMPLATION_SESSION_ENV } from "@co-engram/core";
import { createDshRuntime } from "../src/bootstrap.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env[CONTEMPLATION_SESSION_ENV];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("createDshRuntime · 沉思取用归因注入", () => {
  it("env 标记存在 → ctx.retrievalAttribution = contemplation", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "attr-dsh-"));
    roots.push(dataRoot);
    process.env[CONTEMPLATION_SESSION_ENV] = "1";
    const rt = await createDshRuntime({ dataRootOverrideForTest: dataRoot });
    expect(rt.ctx.retrievalAttribution).toBe("contemplation");
    expect(rt.ctx.host).toBe("dsh-plugin");
    rt.stop();
  });

  it("env 标记缺省 → 不置归因(work,行为向后兼容)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "attr-dsh-"));
    roots.push(dataRoot);
    delete process.env[CONTEMPLATION_SESSION_ENV];
    const rt = await createDshRuntime({ dataRootOverrideForTest: dataRoot });
    expect(rt.ctx.retrievalAttribution).toBeUndefined();
    rt.stop();
  });
});
