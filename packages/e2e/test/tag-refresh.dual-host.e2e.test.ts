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
 * 验证(2026-08 审批化):两宿主各自的 bootstrap 都把 proposalEngine 注入 maintenance,
 * runRem 后占位标签(uncategorized)的刷新走 rem-tag-refresh pending proposal(卡片),
 * 用户 accept 才改 domainTags——而非旧的直接落盘 + 静默卡死。两宿主共享 core
 * MaintenanceEngine,此处验证「两宿主各自的装配 + proposalEngine 注入 + 同一条
 * proposal 审批链路都跑通」。
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

describe("REM tag-refresh — dual-host e2e(proposal 审批化)", () => {
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

  it("claude-code-mcp host: runRem 把占位标签刷新走 proposal(accept 才落盘)", async () => {
    const { ctx, releaseProcessLock } = createCoEngramMcpServer({
      dataRoot: ccDir,
      autoOnboardMergeDriver: false,
    });
    try {
      const eng = ctx.repository.createEngram(SAMPLE);
      // bootstrap 默认创建 proposalEngine(真实路径注入 maintenance)
      expect(ctx.proposalEngine).toBeDefined();
      const { engine, stop } = startCC(
        {
          repository: ctx.repository,
          signalSink: ctx.signalSink!,
          llmClient: mockLlmReturning(["android", "adb"]) as never,
          ...(ctx.proposalEngine ? { proposalEngine: ctx.proposalEngine } : {}),
        },
        { enabledStages: [] },
      );
      try {
        const report = await engine.runRem();
        const tagRefresh = (
          report.downstreamReport as { tagRefresh?: { refreshed: number } }
        )?.tagRefresh;
        expect(tagRefresh?.refreshed).toBe(1); // 生成 1 个 proposal
        // 走 proposal:标签未直接落盘,仍是占位符(旧 bug 会静默落盘 imported + 卡死)
        expect([
          ...ctx.repository.readEngram(eng.id).domainTags,
        ]).toEqual(["uncategorized"]);
        // 有 pending rem-tag-refresh proposal
        const proposal = ctx
          .proposalEngine!.listPending()
          .find((p) => p.source === "rem-tag-refresh");
        expect(proposal).toBeDefined();
        // accept → 标签应用
        ctx.proposalEngine!.accept(proposal!.entityId, { createdBy: "e2e" });
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

  it("openclaw-plugin host: runRem 把占位标签刷新走 proposal(accept 才落盘)", async () => {
    const ctx = createCoEngramContext({ dataRoot: ocDir });
    const eng = ctx.repository.createEngram(SAMPLE);
    expect(ctx.proposalEngine).toBeDefined();
    const { engine, stop } = startOC(
      {
        repository: ctx.repository,
        signalSink: ctx.signalSink!,
        llmClient: mockLlmReturning(["android", "adb"]) as never,
        ...(ctx.proposalEngine ? { proposalEngine: ctx.proposalEngine } : {}),
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
        "uncategorized",
      ]);
      const proposal = ctx
        .proposalEngine!.listPending()
        .find((p) => p.source === "rem-tag-refresh");
      expect(proposal).toBeDefined();
      ctx.proposalEngine!.accept(proposal!.entityId, { createdBy: "e2e" });
      expect([...ctx.repository.readEngram(eng.id).domainTags]).toEqual([
        "android",
        "adb",
      ]);
    } finally {
      stop();
    }
  });
});
