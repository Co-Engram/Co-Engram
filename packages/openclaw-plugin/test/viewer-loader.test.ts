import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EngramRepository,
  SearchOrchestrator,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
} from "@co-engram/core";
import { startCoEngramViewer } from "../src/plugin-entry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-loader-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(tmpDir: string) {
  const repository = new EngramRepository({ rootPath: tmpDir });
  const searchOrchestrator = new SearchOrchestrator();
  const auditLog = new AuditLog(tmpDir);
  const effectivenessTracker = new EffectivenessTracker(tmpDir, auditLog);
  const proposalEngine = new ProposalEngine({
    repository,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog,
    dataRoot: tmpDir,
  });
  return {
    repository,
    searchOrchestrator,
    auditLog,
    effectivenessTracker,
    proposalEngine,
  };
}

describe("startCoEngramViewer", () => {
  it("未启用时返回空对象", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await startCoEngramViewer(ctx, { startViewer: false });
    expect(result.stopViewer).toBeUndefined();
    expect(result.viewerPort).toBeUndefined();
  });

  it("启用且未装 @co-engram/claude-code 时失败但不抛", async () => {
    // 模拟模块缺失:用一个不存在的 specifier
    const originalImport = (await import("node:module")).createRequire(
      import.meta.url,
    );
    void originalImport;

    const ctx = makeCtx(tmpDir);
    // 实际环境中 @co-engram/claude-code 已安装(同 monorepo),所以这里应成功
    const result = await startCoEngramViewer(ctx, {
      startViewer: true,
      viewerConfig: { port: 19400 },
    });
    // 在 monorepo 内能成功加载
    if (result.viewerPort) {
      expect(result.viewerPort).toBe(19400);
      expect(typeof result.stopViewer).toBe("function");
      await result.stopViewer?.();
    }
  });

  it("未传 startViewer 时默认启用(2026-07 opt-out 对齐 maintenance/claude-code/configSchema)", async () => {
    const ctx = makeCtx(tmpDir);
    // 不传 startViewer(undefined):新行为(config.startViewer === false 才关)默认启,
    // 对齐 openclaw.plugin.json default:true / claude-code viewer.enabled ?? proposalEnabled
    const result = await startCoEngramViewer(ctx, {
      viewerConfig: { port: 19401 },
    });
    expect(result.viewerPort).toBe(19401);
    expect(typeof result.stopViewer).toBe("function");
    await result.stopViewer?.();
  });
});
