/**
 * Task 5.3:viewer.port persisted config deprecation warn
 *
 * 验证:用户在 persisted config(`startViewerServer({ port: ... })`)设了 port
 * 而没有用 env `CO_ENGRAM_VIEWER_PORT` 时,会 warn 提示该字段已废弃。
 *
 * Why:两宿主(Claude Code / OpenClaw)共享同一份 persisted config,
 * viewer.port 在 persisted config 里会让两宿主抢同一端口。env 是 host-specific
 * 的,不会冲突,所以是推荐路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { startViewerServer } from "../src/index.js";

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
    config: { threshold: 1 },
  });
  return {
    repository,
    searchOrchestrator,
    auditLog,
    effectivenessTracker,
    proposalEngine,
  };
}

describe("Task 5.3: viewer.port persisted config deprecation warn", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-port-warn-"));
    savedEnv = process.env.CO_ENGRAM_VIEWER_PORT;
    delete process.env.CO_ENGRAM_VIEWER_PORT;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.CO_ENGRAM_VIEWER_PORT = savedEnv;
    } else {
      delete process.env.CO_ENGRAM_VIEWER_PORT;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("warns when config.port is set without env CO_ENGRAM_VIEWER_PORT", async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const ctx = makeCtx(tmpDir);
      const runtime = await startViewerServer(ctx, { port: 19123 });
      await runtime.stop();
      expect(warns.some((w) => /deprecated/.test(w))).toBe(true);
      expect(warns.some((w) => /CO_ENGRAM_VIEWER_PORT/.test(w))).toBe(true);
      expect(warns.some((w) => /19123/.test(w))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when env CO_ENGRAM_VIEWER_PORT is set (env wins over config.port)", async () => {
    process.env.CO_ENGRAM_VIEWER_PORT = "19234";
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const ctx = makeCtx(tmpDir);
      // config.port 仍传入,但因为 env 已设,不应触发 warn
      const runtime = await startViewerServer(ctx, { port: 19124 });
      await runtime.stop();
      expect(warns.some((w) => /deprecated/.test(w))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when config.port is absent (default port path)", async () => {
    // 用 env 指定一个安全端口,避免 default 18899 在 CI 上碰撞
    process.env.CO_ENGRAM_VIEWER_PORT = "19345";
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const ctx = makeCtx(tmpDir);
      const runtime = await startViewerServer(ctx, {});
      await runtime.stop();
      expect(warns.some((w) => /deprecated/.test(w))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
