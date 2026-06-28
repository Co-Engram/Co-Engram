import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerCoEngramTools,
  buildProposalPrompt,
} from "../src/plugin-entry.js";
import { RuleBasedNecessityEvaluator } from "@co-engram/core";
import type {
  CoEngramPluginHostApi,
  SessionHookHandler,
  PluginNextTurnInjectionInput,
} from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-plugin-session-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface CapturedHost {
  readonly api: CoEngramPluginHostApi;
  readonly hooks: ReadonlyArray<{
    events: "session" | readonly string[];
    handler: SessionHookHandler;
  }>;
  readonly injections: PluginNextTurnInjectionInput[];
}

function makeCapturingHost(): CapturedHost {
  const hooks: Array<{
    events: "session" | readonly string[];
    handler: SessionHookHandler;
  }> = [];
  const injections: PluginNextTurnInjectionInput[] = [];
  const api: CoEngramPluginHostApi = {
    registerTool: () => {},
    registerHook: (events, handler) => {
      hooks.push({ events, handler });
    },
    enqueueNextTurnInjection: async (injection) => {
      injections.push(injection);
      return {
        enqueued: true,
        id: "test-id",
        sessionKey: injection.sessionKey,
      };
    },
  };
  return { api, hooks, injections };
}

describe("buildProposalPrompt", () => {
  it("默认 zh:单数 candidate", () => {
    const msg = buildProposalPrompt(1);
    expect(msg).toContain("1 个候选记忆");
    expect(msg).toContain("engram_list_proposals");
  });

  it("默认 zh:复数 candidates", () => {
    const msg = buildProposalPrompt(5);
    expect(msg).toContain("5 个候选记忆");
  });
});

describe("registerCoEngramTools M3b 候选提示注入", () => {
  it("proposalEngine 未启用时不注册 hook", () => {
    const host = makeCapturingHost();
    registerCoEngramTools(host.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: false, // 关键:不启用 proposal
    });
    expect(host.hooks).toHaveLength(0);
  });

  it("proposalEngine 启用但 host 缺 hook API 时不注册", () => {
    // host 只提供 registerTool,无 registerHook/enqueueNextTurnInjection
    const api: CoEngramPluginHostApi = { registerTool: () => {} };
    expect(() => {
      registerCoEngramTools(api, {
        dataRoot: tmpDir,
        enabled: true,
        proposalEnabled: true,
      });
    }).not.toThrow();
  });

  it("proposalEngine + host 完整时注册 session + llm_input/output hooks", () => {
    const host = makeCapturingHost();
    registerCoEngramTools(host.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: true,
    });
    // M3b session hook(候选注入)+ M3c llm_input/output hook(对话观察)
    expect(host.hooks).toHaveLength(2);
    const sessionHooks = host.hooks.filter((h) => h.events === "session");
    expect(sessionHooks).toHaveLength(1);
    const observeHooks = host.hooks.filter(
      (h) => Array.isArray(h.events) && h.events.includes("llm_input"),
    );
    expect(observeHooks).toHaveLength(1);
  });

  it('session "new" 触发时无 pending proposals 不注入', async () => {
    const host = makeCapturingHost();
    registerCoEngramTools(host.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: true,
      startMaintenance: false,
    });

    const sessionHook = host.hooks.find((h) => h.events === "session")!;
    const handler = sessionHook.handler;
    await handler({ type: "session", action: "new", sessionKey: "s1" });

    expect(host.injections).toHaveLength(0);
  });

  it('session "new" 触发时有 pending proposals 注入 prompt', async () => {
    // 先注册一次以拿到 ctx + proposalEngine
    const host = makeCapturingHost();
    const result = registerCoEngramTools(host.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: true,
      proposalConfig: { threshold: 1 },
      // 显式注入规则版评估器,避免测试环境自动探测 ~/.openclaw/openclaw.json
      // 的 LLM 配置导致 evaluate 走网络阻塞
      necessityEvaluator: new RuleBasedNecessityEvaluator(),
    });

    // 触发 proposal 生成(threshold=1,observe 一次即可)
    if (result.proposalEngine) {
      await result.proposalEngine.observe({
        role: "user",
        content: "unique content for testing session hook injection mechanism",
      });
    }

    // 重新注册(模拟 host 重启),这次会扫描 pending proposals
    const host2 = makeCapturingHost();
    registerCoEngramTools(host2.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: true,
    });

    const sessionHook = host2.hooks.find((h) => h.events === "session")!;
    const handler = sessionHook.handler;
    await handler({ type: "session", action: "new", sessionKey: "s2" });

    expect(host2.injections.length).toBeGreaterThan(0);
    const injection = host2.injections[0]!;
    expect(injection.sessionKey).toBe("s2");
    expect(injection.placement).toBe("prepend_context");
    expect(injection.text).toContain("co-engram");
    expect(injection.text).toContain("engram_list_proposals");
    expect(injection.idempotencyKey).toContain("s2");
  });

  it('非 "new" action 不触发注入', async () => {
    const host = makeCapturingHost();
    registerCoEngramTools(host.api, {
      dataRoot: tmpDir,
      enabled: true,
      proposalEnabled: true,
    });

    const sessionHook = host.hooks.find((h) => h.events === "session")!;
    const handler = sessionHook.handler;
    await handler({ type: "session", action: "reset", sessionKey: "s1" });
    await handler({ type: "session", action: "stop", sessionKey: "s1" });

    expect(host.injections).toHaveLength(0);
  });
});
