/**
 * 沉思取用归因 ctx 注入测试(claude-code-mcp,2026-08-22)
 *
 * headless executor spawn 注入 CO_ENGRAM_CONTEMPLATION_SESSION=1;本包的
 * createCoEngramMcpServer 构造 ToolContext 时读取该 env 置
 * retrievalAttribution="contemplation",让本 MCP 实例内的 engram_search
 * 不计取用(冷却榜/hotness/effectiveness 语义保真)。缺省不置(向后兼容)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEMPLATION_SESSION_ENV } from "@co-engram/core";
import { createCoEngramMcpServer } from "../src/register.js";

let tmpDir: string;
afterEach(() => {
  delete process.env[CONTEMPLATION_SESSION_ENV];
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("createCoEngramMcpServer · 沉思取用归因注入", () => {
  it("env 标记存在 → ctx.retrievalAttribution = contemplation", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "attr-ccm-"));
    process.env[CONTEMPLATION_SESSION_ENV] = "1";
    const { ctx, stopMaintenance, stopAuditRotation } = createCoEngramMcpServer(
      { dataRoot: tmpDir, profile: "full" },
    );
    expect(ctx.retrievalAttribution).toBe("contemplation");
    expect(ctx.host).toBe("claude-code-mcp");
    stopMaintenance?.();
    stopAuditRotation?.();
  });

  it("env 标记缺省 → 不置归因(work,行为向后兼容)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "attr-ccm-"));
    delete process.env[CONTEMPLATION_SESSION_ENV];
    const { ctx, stopMaintenance, stopAuditRotation } = createCoEngramMcpServer(
      { dataRoot: tmpDir, profile: "full" },
    );
    expect(ctx.retrievalAttribution).toBeUndefined();
    stopMaintenance?.();
    stopAuditRotation?.();
  });
});
