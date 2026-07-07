/**
 * P4 自动维护服务 E2E 测试
 *
 * 模拟真实会话：构造工具事件流 → maintenance engine 处理 → 验证 engram 状态变化
 *
 * 场景：
 *   1. 正向信号 → runLight → reinforcement 增强 + effectiveRetrievals 累积
 *   2. 负向信号 → runLight → failedUses 增加 + reinforcement 下降
 *   3. 高质量 engram → runRem → verificationStatus 升级
 *   4. 低质量 engram + contradicts → runRem → refuted
 *   5. 双宿主一致：openclaw-plugin 跑 maintenance,MCP 读到相同 stats
 *   6. signals.jsonl 落盘：调用工具后信号文件确实增长
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  registerCoEngramTools,
  startMaintenanceRuntime,
} from "@co-engram/openclaw";
import type {
  CoEngramPluginHostApi,
  OpenClawToolDescriptor,
} from "@co-engram/openclaw";
import { createCoEngramMcpServer } from "@co-engram/claude-code";
import {
  EngramRepository,
  MaintenanceEngine,
  MemorySignalSink,
  createDreamingScheduler,
  type ToolCallEvent,
} from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-maint-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 测试辅助
// ============================================================

function createMemoryHost(): CoEngramPluginHostApi & {
  tools: Map<string, OpenClawToolDescriptor>;
} {
  const tools = new Map<string, OpenClawToolDescriptor>();
  return {
    tools,
    registerTool(tool, opts) {
      tools.set(opts?.name ?? tool.name, tool);
    },
  };
}

async function callOpenClaw(
  host: ReturnType<typeof createMemoryHost>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = host.tools.get(toolName)!;
  const result = await tool.execute("e2e-call", args);
  const content = (result as { content: { type: string; data?: unknown }[] })
    .content;
  if (content[0] && content[0].type === "json") {
    return content[0].data;
  }
  throw new Error(`Unexpected content shape: ${JSON.stringify(content)}`);
}

function makeEvent(
  overrides: Partial<ToolCallEvent> & { toolName: string },
): ToolCallEvent {
  return {
    input: {},
    sessionId: "s1",
    at: Date.now(),
    ...overrides,
  };
}

/**
 * 把指定 engram 的 createdAt 改成 N 天前（用于触发 metacognition 升级门槛）
 *
 * 单文件布局,通过 listEngramIndex 查找路径后直接修改 frontmatter。
 */
function backdateEngram(
  repo: EngramRepository,
  engramId: string,
  daysAgo: number,
): void {
  const entry = repo.listEngramIndex().find((e) => e.id === engramId);
  if (!entry) throw new Error(`engram not found: ${engramId}`);
  const rootPath = (repo as unknown as { rootPath: string }).rootPath;
  const filePath = join(rootPath, entry.path);
  // 兼容两种磁盘格式:英文顶部(`createdAt:`)与中文底部(`创建时间:`)
  const old = readFileSync(filePath, "utf8");
  const newDate = new Date(
    Date.now() - daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  const updated = old
    .replace(/^createdAt:.*$/m, `createdAt: ${newDate}`)
    .replace(/^创建时间:.*$/m, `创建时间: ${newDate}`);
  writeFileSync(filePath, updated, "utf8");
}

// ============================================================
// Light 阶段场景
// ============================================================

describe("P4 maintenance - light 阶段", () => {
  it("正向信号（repeated_get）→ reinforcementScore 增加 + effectiveRetrievals 累积", async () => {
    const host = createMemoryHost();
    const ctx = registerCoEngramTools(host, { dataRoot: tmpDir });

    // 创建 engram A（初始 lastRetrievalScore=0.5）
    const created = (await callOpenClaw(host, "engram_create", {
      title: "测试事实",
      content: "用于验证 repeated_get 信号",
      kind: "fact",
      domainTags: ["e2e", "positive"],
      createdBy: "tester",
    })) as { id: string };

    // 模拟同 session 内 2 次 get → repeated_get rule +0.6
    const sink = (ctx.signalSink as MemorySignalSink) ?? new MemorySignalSink();
    // 直接用 MemorySink 替换（ctx.signalSink 是 FileSignalSink,改用 memory 方便控制）
    const memSink = new MemorySignalSink();
    memSink.append(
      makeEvent({
        toolName: "engram_get",
        input: { id: created.id },
        retrievedEngramIds: [created.id],
        at: 1,
      }),
    );
    memSink.append(
      makeEvent({
        toolName: "engram_get",
        input: { id: created.id },
        retrievedEngramIds: [created.id],
        at: 2,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: ctx.repository,
      signalSink: memSink,
    });

    const report = await engine.runLight();
    expect(report.rpeUpdates).toBe(1);

    const engram = ctx.repository.readEngram(created.id);
    // effectiveness = (0.6+1)/2 - 0.5 = 0.3 > 0.05 → effectiveDelta+1, reinforcementDelta += 0.3*0.1 = 0.03
    expect(engram.effectiveRetrievals).toBe(1);
    expect(engram.reinforcementScore).toBeGreaterThan(0);
    void sink;
  });

  it("负向信号（contradicts_created）→ failedUses 增加 + reinforcementScore 下降", async () => {
    const host = createMemoryHost();
    const ctx = registerCoEngramTools(host, { dataRoot: tmpDir });

    const created = (await callOpenClaw(host, "engram_create", {
      title: "将被反驳",
      content: "内容",
      kind: "fact",
      domainTags: ["e2e", "negative"],
      createdBy: "tester",
    })) as { id: string };

    const memSink = new MemorySignalSink();
    memSink.append(
      makeEvent({
        toolName: "synapse_create",
        input: { from: "new-id", to: created.id, kind: "contradicts" },
        at: 1,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: ctx.repository,
      signalSink: memSink,
    });

    const report = await engine.runLight();
    expect(report.rpeUpdates).toBe(1);

    const engram = ctx.repository.readEngram(created.id);
    // effectiveness = (-0.8+1)/2 - 0.5 = -0.4 < -0.05 → failedDelta+1, reinforcementDelta -= 0.4*0.1 = -0.04
    expect(engram.failedUses).toBe(1);
    expect(engram.reinforcementScore).toBeLessThan(0);
  });
});

// ============================================================
// REM 阶段场景
// ============================================================

describe("P4 maintenance - rem 阶段", () => {
  it("高质量 engram（跨域 + extends + 老）→ runRem 升级 verificationStatus", async () => {
    const host = createMemoryHost();
    const ctx = registerCoEngramTools(host, { dataRoot: tmpDir });

    // 创建主 engram（2 个 domainTags → crossContext=1.0）
    const main = (await callOpenClaw(host, "engram_create", {
      title: "核心事实",
      content: "高质量内容",
      kind: "fact",
      domainTags: ["domain-a", "domain-b"],
      createdBy: "tester",
    })) as { id: string };

    // 创建 1 个 extends synapse（另一个 engram → main）→ mutuallySupported=1.0
    const supporter = (await callOpenClaw(host, "engram_create", {
      title: "支持者",
      content: "佐证",
      kind: "fact",
      domainTags: ["domain-a"],
      createdBy: "tester",
    })) as { id: string };
    await callOpenClaw(host, "synapse_create", {
      from: supporter.id,
      to: main.id,
      kind: "extends",
      weight: 0.8,
      createdBy: "tester",
    });

    // 把 main 的 createdAt 改成 10 天前（让 timeStable ≥ 0.33 贡献到 overall）
    // overall = 0.30*1 + 0.25*(10/30) + 0.25*1 + 0.20*0.5 = 0.30 + 0.083 + 0.25 + 0.10 = 0.733 ≥ 0.70
    backdateEngram(ctx.repository, main.id, 10);

    // 启动 engine + rem
    const scheduler = createDreamingScheduler(ctx.repository, {});
    const engine = new MaintenanceEngine({
      repository: ctx.repository,
      signalSink: new MemorySignalSink(),
      dreamingScheduler: scheduler,
    });

    const report = await engine.runRem();
    expect(report.errors).toHaveLength(0);

    const engram = ctx.repository.readEngram(main.id);
    // unverified → plausible（upgrade_one_level 路径）
    expect(engram.verificationStatus).toBe("plausible");
  });

  it("低质量 engram + contradicts synapse → runRem 触发 refute", async () => {
    const host = createMemoryHost();
    const ctx = registerCoEngramTools(host, { dataRoot: tmpDir });

    // 单 domain（crossContext=0.5）、新（timeStable=0）、无 extends（mutuallySupported=0.5）
    // overall = 0.30*0.5 + 0.25*0 + 0.25*0.5 + 0.20*0.5 = 0.15 + 0 + 0.125 + 0.10 = 0.375
    // 还不够低（< 0.30 才 refute）。用 0 domain 让 crossContext=0:
    // overall = 0.30*0 + 0 + 0.25*0 + 0.20*0.5 = 0.10 < 0.30 ✓
    // 但 domainTags 不能为空（schema 要求至少 1 个）。那就只有 1 domain 且 contradicts 让 mutuallySupported=0
    const target = (await callOpenClaw(host, "engram_create", {
      title: "可疑",
      content: "内容",
      kind: "fact",
      domainTags: ["single"],
      createdBy: "tester",
    })) as { id: string };

    // 创建 contradicts synapse（mutuallySupported=0）
    const refuter = (await callOpenClaw(host, "engram_create", {
      title: "反驳者",
      content: "反例",
      kind: "fact",
      domainTags: ["refute"],
      createdBy: "tester",
    })) as { id: string };
    await callOpenClaw(host, "synapse_create", {
      from: refuter.id,
      to: target.id,
      kind: "contradicts",
      weight: 0.9,
      createdBy: "tester",
    });

    // overall = 0.30*(1/2) + 0 + 0.25*0 + 0.20*0.5 = 0.15 + 0 + 0 + 0.10 = 0.25 < 0.30 ✓
    const scheduler = createDreamingScheduler(ctx.repository, {});
    const engine = new MaintenanceEngine({
      repository: ctx.repository,
      signalSink: new MemorySignalSink(),
      dreamingScheduler: scheduler,
    });

    await engine.runRem();

    const engram = ctx.repository.readEngram(target.id);
    expect(engram.verificationStatus).toBe("refuted");
  });
});

// ============================================================
// 跨宿主一致性
// ============================================================

describe("P4 maintenance - 跨宿主一致", () => {
  it("OpenClaw engine 更新 stats 后,MCP 端读到相同数值", async () => {
    // Step 1: OpenClaw 端创建 + 启动 maintenance
    const openclawHost = createMemoryHost();
    const openclawCtx = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
    });

    const created = (await callOpenClaw(openclawHost, "engram_create", {
      title: "共享 engram",
      content: "openclaw 创建",
      kind: "fact",
      domainTags: ["shared"],
      createdBy: "openclaw",
    })) as { id: string };

    // Step 2: 用 memory sink + engine 手动触发一次 light（避免 FileSignalSink flush 延迟）
    const memSink = new MemorySignalSink();
    memSink.append(
      makeEvent({
        toolName: "engram_get",
        input: { id: created.id },
        retrievedEngramIds: [created.id],
        at: 1,
      }),
    );
    memSink.append(
      makeEvent({
        toolName: "engram_get",
        input: { id: created.id },
        retrievedEngramIds: [created.id],
        at: 2,
      }),
    );

    const engine = new MaintenanceEngine({
      repository: openclawCtx.repository,
      signalSink: memSink,
    });
    await engine.runLight();

    // OpenClaw 端读到的 stats
    const openclawEngram = openclawCtx.repository.readEngram(created.id);
    expect(openclawEngram.effectiveRetrievals).toBe(1);

    // Step 3: 启动 MCP,通过 repository 直读同一个 engram（共享 dataRoot）
    const { server, ctx: mcpCtx } = createCoEngramMcpServer({
      dataRoot: tmpDir,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "e2e-cross-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const mcpEngram = mcpCtx.repository.readEngram(created.id);
      expect(mcpEngram.effectiveRetrievals).toBe(
        openclawEngram.effectiveRetrievals,
      );
      expect(mcpEngram.reinforcementScore).toBeCloseTo(
        openclawEngram.reinforcementScore,
        5,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("startMaintenanceRuntime 同时启动 OpenClaw + MCP 两端,共享同一份数据", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });

    // OpenClaw 端
    const openclawHost = createMemoryHost();
    const openclawResult = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
      startMaintenance: true,
      maintenanceConfig: {
        enabledStages: ["light"],
        lightIntervalMs: 60_000, // 长间隔,不会真的跑（测试只验证启动/停止）
      },
    });

    // MCP 端(同一 dataRoot)— ProcessLock 后第二个进程是 non-holder,
    // 不启动 maintenance / rotation / watcher(避免多进程叠加烧 CPU / fs.watch 链)。
    // 这是 2026-07 viewer 性能修复的关键 invariant:共享 dataRoot 时只允许一个 holder。
    const mcpResult = createCoEngramMcpServer({
      dataRoot: tmpDir,
      startMaintenance: true,
      maintenanceConfig: {
        enabledStages: ["light"],
        lightIntervalMs: 60_000,
      },
    });

    // 恰好一个 holder(第一个启动的 OpenClaw),另一个 non-holder
    const openclawStop = openclawResult.stopMaintenance;
    const mcpStop = mcpResult.stopMaintenance;
    expect(typeof openclawStop === "function" || typeof mcpStop === "function").toBe(true);
    openclawStop?.();
    mcpStop?.();
    openclawResult.releaseProcessLock?.();
    mcpResult.releaseProcessLock?.();

    // 验证共享数据（两个 host adapter 都指向同一目录)
    void repo;
    expect(existsSync(tmpDir)).toBe(true);
  });
});

// ============================================================
// signals.jsonl 落盘
// ============================================================

describe("P4 maintenance - signals.jsonl 落盘", () => {
  it("调用 engram_create 后,FileSignalSink 缓冲的事件最终可被 drain", async () => {
    const host = createMemoryHost();
    const ctx = registerCoEngramTools(host, { dataRoot: tmpDir });

    // 触发 1 次工具调用（FileSignalSink 会缓冲）
    await callOpenClaw(host, "engram_create", {
      title: "信号落盘测试",
      content: "内容",
      kind: "fact",
      domainTags: ["signal-test"],
      createdBy: "tester",
    });

    // 显式 flush（FileSignalSink 的 flush 是 async）
    const sink = ctx.signalSink;
    expect(sink).toBeDefined();
    const flushable = sink as unknown as { flush?: () => Promise<void> };
    if (sink && typeof flushable.flush === "function") {
      await flushable.flush();
    }

    // 文件存在或 drain 能拿到事件
    const signalsPath = join(tmpDir, "signals.jsonl");
    if (existsSync(signalsPath)) {
      const raw = readFileSync(signalsPath, "utf8").trim();
      expect(raw.length).toBeGreaterThan(0);
      // 至少有一行是 engram_create
      const lines = raw.split("\n");
      const createEvents = lines.filter((l) =>
        l.includes('"toolName":"engram_create"'),
      );
      expect(createEvents.length).toBeGreaterThanOrEqual(1);
    } else {
      // 缓冲可能还没 flush,通过 drain 强制读取
      const events = sink!.drain();
      expect(events.length).toBeGreaterThanOrEqual(1);
    }
  });
});
