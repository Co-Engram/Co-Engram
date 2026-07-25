import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCoEngramMcpServer,
  startMaintenanceRuntime as startCC,
} from "@co-engram/claude-code";
import {
  createCoEngramContext,
  startMaintenanceRuntime as startOC,
} from "@co-engram/openclaw";

/**
 * 端到端验证双宿主(claude-code-mcp + openclaw-plugin)的 REM 标签漂移刷新。
 *
 * 用两宿主各自的 startMaintenanceRuntime 装配 MaintenanceEngine(真实 bootstrap
 * 的 repository/indexDb/signalSink),手动触发 runRem,验证 uncategorized engram
 * 被刷新成 LLM 提取的内容语义标签。两宿主共享 @co-engram/core 的 MaintenanceEngine,
 * 此处验证的是「两宿主各自的装配 + bootstrap 都能跑通同一条 REM 标签刷新链路」。
 */

function mockLlmReturning(tags: string[]): {
  complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
  ): Promise<string>;
} {
  return {
    async complete() {
      return JSON.stringify({
        title: "extracted-title",
        kind: "observation",
        domainTags: tags,
        summary: "extracted summary",
      });
    },
  };
}

const SAMPLE = {
  title: "Wireless ADB setup",
  content: "how to configure wireless adb debugging on android devices",
  kind: "fact" as const,
  domainTags: ["uncategorized"],
  createdBy: "e2e",
};

describe("REM tag-refresh — dual-host e2e", () => {
  let ccDir: string;
  let ocDir: string;

  beforeEach(() => {
    ccDir = mkdtempSync(join(tmpdir(), "ce-tag-e2e-cc-"));
    ocDir = mkdtempSync(join(tmpdir(), "ce-tag-e2e-oc-"));
  });

  afterEach(() => {
    rmSync(ccDir, { recursive: true, force: true });
    rmSync(ocDir, { recursive: true, force: true });
  });

  it("claude-code-mcp host: runRem refreshes uncategorized → content-semantic tags", async () => {
    const { ctx, releaseProcessLock } = createCoEngramMcpServer({
      dataRoot: ccDir,
      autoOnboardMergeDriver: false,
    });
    try {
      const eng = ctx.repository.createEngram(SAMPLE);
      const { engine, stop } = startCC(
        {
          repository: ctx.repository,
          signalSink: ctx.signalSink!,
          llmClient: mockLlmReturning(["android", "adb"]) as never,
        },
        { enabledStages: [] },
      );
      try {
        const report = await engine.runRem();
        const tagRefresh = (
          report.downstreamReport as { tagRefresh?: { refreshed: number } }
        )?.tagRefresh;
        expect(tagRefresh?.refreshed).toBe(1);
        expect([
          ...ctx.repository.readEngram(eng.id).domainTags,
        ]).toEqual(["android", "adb"]);
      } finally {
        stop();
      }
    } finally {
      releaseProcessLock?.();
    }
  });

  it("openclaw-plugin host: runRem refreshes uncategorized → content-semantic tags", async () => {
    const ctx = createCoEngramContext({ dataRoot: ocDir });
    const eng = ctx.repository.createEngram(SAMPLE);
    const { engine, stop } = startOC(
      {
        repository: ctx.repository,
        signalSink: ctx.signalSink!,
        llmClient: mockLlmReturning(["android", "adb"]) as never,
      },
      { enabledStages: [] },
    );
    try {
      const report = await engine.runRem();
      const tagRefresh = (
        report.downstreamReport as { tagRefresh?: { refreshed: number } }
      )?.tagRefresh;
      expect(tagRefresh?.refreshed).toBe(1);
      expect([...ctx.repository.readEngram(eng.id).domainTags]).toEqual([
        "android",
        "adb",
      ]);
    } finally {
      stop();
    }
  });
});
