/**
 * 沉思取用归因 ctx 注入测试(openclaw-plugin,2026-08-22)
 *
 * createCoEngramContext 读取 CO_ENGRAM_CONTEMPLATION_SESSION(headless
 * executor spawn 注入,经 claude 进程继承到本插件实例)置
 * retrievalAttribution="contemplation";缺省不置(向后兼容)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEMPLATION_SESSION_ENV } from "@co-engram/core";
import { createCoEngramContext } from "../src/plugin-entry.js";

let tmpDir: string;
afterEach(() => {
  delete process.env[CONTEMPLATION_SESSION_ENV];
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("createCoEngramContext · 沉思取用归因注入", () => {
  it("env 标记存在 → ctx.retrievalAttribution = contemplation", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "attr-ocw-"));
    process.env[CONTEMPLATION_SESSION_ENV] = "1";
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    expect(ctx.retrievalAttribution).toBe("contemplation");
    expect(ctx.host).toBe("openclaw-plugin");
  });

  it("env 标记缺省 → 不置归因(work,行为向后兼容)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "attr-ocw-"));
    delete process.env[CONTEMPLATION_SESSION_ENV];
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    expect(ctx.retrievalAttribution).toBeUndefined();
  });
});
