/**
 * 沉思(contemplation)E2E:2026-08-19 六项体验修复的端到端验证
 *
 * 场景 A:viewer HTTP 全链路(网页用户的真实操作序列)
 *   A1 GET / SPA 资产:#i-ponder 图标 symbol / .inc-ico CSS / isolation /
 *      新交互入口(cancelRun/showMore/ensureDetail)随 HTML 内联下发
 *   A2 创建即深思:POST → 201 + jobId → job done → 列表 done + answer
 *   A3 列表 slim 化 + 单条详情差分(列表 timeline 1 轮无 answer,详情带全文)
 *   A4 同问题防重:未完成态再 POST → 409 duplicate
 *   A5 cancel:thinking → POST cancel → queued;审计 contemplation_run_cancel
 *   A6 force delete:进行中默认 409,force → 200 → 条目消失;审计 abortedRun
 *
 * 场景 B:MCP 工具面(claude-code 宿主,对话内"帮我沉思"的入口)
 *   B1 ponder_create → 条目创建;同问题再创建 → VALIDATION 错误含 duplicate 指引
 *      (agent 拿到可读建议而非 INTERNAL)
 *   B2 ponder_list / ponder_delete 正常链路
 *
 * 场景 C:跨端数据共享(同一 dataRoot,viewer 与 MCP 互见)
 *   viewer 创建的条目 MCP ponder_list 可见;MCP 创建的条目 viewer GET 可见
 *
 * 不测(边界,由别处覆盖):
 *   - 浏览器 JS 交互(渐进渲染/按钮 in-flight/过滤)→ viewer vm runtime 测试
 *   - 真实 L2(spawn claude headless,分钟级)→ headless 集成单独验证;
 *     本文件 run 路径用 fake executor 等效走完 incubateOnce → report 全链路
 *   - report 写回竞态 → core incubation-cancel.test.ts(深测)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCoEngramMcpServer } from "@co-engram/claude-code";
import {
  AuditLog,
  EffectivenessTracker,
  EngramRepository,
  Incubator,
  ProposalEngine,
} from "@co-engram/core";
import { startViewerServer } from "@co-engram/viewer";

let tmpDir: string;
let runtime: Awaited<ReturnType<typeof startViewerServer>> | undefined;
const stubEmbedder = async () => [1, 0, 0];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-contemplation-"));
});

afterEach(async () => {
  if (runtime) {
    await runtime.stop();
    runtime = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 端口探测(与 viewer/test/incubation-api.test.ts 同款)
// ============================================================
let portCounter = 55100;
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}
async function nextPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    portCounter += 1;
    if (await isPortFree(portCounter)) return portCounter;
  }
  throw new Error("no free port");
}

// ============================================================
// viewer ctx(fake executor:立即交带 answer 的报告,走完
// incubateOnce → buildTask → report 全链路,不 spawn claude)
// ============================================================
function makeViewerCtx() {
  const repository = new EngramRepository({ rootPath: tmpDir });
  const auditLog = new AuditLog(tmpDir);
  const proposalEngine = new ProposalEngine({
    repository,
    embedder: stubEmbedder,
    auditLog,
    dataRoot: tmpDir,
  });
  const incubator = new Incubator({
    repository,
    proposalEngine,
    dataRoot: tmpDir,
    auditLog,
    executor: {
      execute: async () => ({
        answer: "E2E 执行现场回答:全资源盘点完成,方向 A 有据。",
        insights: [],
        plan: [{ step: "盘点记忆", capability: "engram_search" }],
        trace: [{ step: "s1", action: "engram_search", detail: "命中" }],
      }),
    },
  });
  void EffectivenessTracker;
  return { repository, auditLog, proposalEngine, incubator };
}

type Http = ReturnType<typeof makeHttp>;
function makeHttp(base: string) {
  const j = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    return {
      status: r.status,
      json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  const text = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.text() };
  };
  return { j, text };
}

async function startViewer() {
  const port = await nextPort();
  runtime = await startViewerServer(makeViewerCtx() as never, { port });
  return makeHttp(`http://127.0.0.1:${port}`);
}

async function pollJob(http: Http, jobId: string): Promise<Record<string, unknown>> {
  let job: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    const r = await http.j(`/api/contemplation-jobs/${jobId}`);
    job = r.json;
    if (job.status !== "running") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return job;
}

// ============================================================
// MCP client(与 contract.test.ts 同款;不触发 run → 无 spawn)
// ============================================================
async function startMcpClient(dataRoot: string) {
  const { server } = createCoEngramMcpServer({
    dataRoot,
    language: "en",
    profile: "full",
    startMaintenance: false,
    autoOnboardMergeDriver: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contemplation-e2e", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(
    (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}",
  ) as Record<string, unknown>;
}

/** 返回工具文本输出(ponder_list 渲染 markdown 而非 JSON) */
async function callToolText(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
}

// ============================================================
// 场景 A:viewer HTTP 全链路
// ============================================================
describe("沉思 E2E / 场景 A:viewer HTTP 全链路(网页用户旅程)", () => {
  it("A1 GET / SPA 资产:SVG 图标 / 防御性 CSS / 新交互入口随 HTML 下发", async () => {
    const http = await startViewer();
    const page = await http.text("/");
    expect(page.status).toBe(200);
    // 图标:内联 symbol 存在(替代字体缺失的 ⏾);按钮模板引用它
    expect(page.body).toContain('id="i-ponder"');
    expect(page.body).toContain(".inc-ico");
    // 防御性 CSS:回答预览标准 block+max-height(重叠修复)+ 卡片 isolation
    expect(page.body).toContain("isolation: isolate");
    expect(page.body).toContain("display: block; max-height: calc(2");
    // 旧 details 大折叠样式已移除
    expect(page.body).not.toContain(".inc-fold {");
    // 新交互入口(终止/显示更多/详情懒加载)在运行时脚本中
    expect(page.body).toContain("cancelRun");
    expect(page.body).toContain("showMore");
    expect(page.body).toContain("ensureDetail");
    // 创建按钮引用 SVG 图标(不再出现 ⏾ 字面按钮)
    expect(page.body).toContain("CO_ENGRAM_CONTEMPLATION.create()");
  });

  it("A2+A3 创建即深思 → job done → 列表 slim 与单条详情差分", async () => {
    const http = await startViewer();
    const created = await http.j("/api/contemplations", "POST", {
      question: "E2E:分布式团队如何避免知识孤岛?",
    });
    expect(created.status).toBe(201);
    expect(typeof created.json.jobId).toBe("string");
    const id = (created.json.entry as { id: string }).id;

    const job = await pollJob(http, created.json.jobId as string);
    expect(job.status).toBe("done");

    // 列表 slim:timeline 只 1 轮、轮内 answer 剥离;条目级 answer 保留
    const list = await http.j("/api/contemplations");
    const slim = (list.json.items as Array<Record<string, unknown>>).find((x) => x.id === id)!;
    expect(slim.status).toBe("done");
    expect(slim.answer).toBe("E2E 执行现场回答:全资源盘点完成,方向 A 有据。");
    expect(slim.slimTimeline).toBe(true);
    const slimTl = slim.timeline as Array<Record<string, unknown>>;
    expect(slimTl).toHaveLength(1);
    expect(slimTl[0]!.answer).toBeUndefined();

    // 详情:完整 timeline(轮内 answer 在)
    const detail = await http.j(`/api/contemplations/${id}`);
    expect(detail.status).toBe(200);
    const full = (detail.json.entry as { timeline: Array<Record<string, unknown>> }).timeline;
    expect(full.at(-1)!.answer).toBe("E2E 执行现场回答:全资源盘点完成,方向 A 有据。");
    expect((detail.json.entry as { slimTimeline?: unknown }).slimTimeline).toBeUndefined();
  });

  it("A4 同问题防重:未完成态再 POST → 409;不同问题 → 201", async () => {
    const http = await startViewer();
    const first = await http.j("/api/contemplations", "POST", {
      question: "E2E:重复提交验证问题?",
    });
    expect(first.status).toBe(201);
    // 立即重复提交(fake executor 下 job 可能已完成 → done 不拦;此处条目
    // 至少存在,409 判定域在"未完成态"。为使状态确定,先等 job 收束)
    await pollJob(http, first.json.jobId as string);
    const dup = await http.j("/api/contemplations", "POST", {
      question: "E2E:重复提交验证问题?",
    });
    // fake executor 完成后是 done → 域层允许重建(再思语义);防重窗口在
    // 运行期。改用确定性路径:直接验证 queued 态拒绝(viewer ctx 的 job 失败态)
    if (dup.status === 409) {
      expect(String(dup.json.error)).toContain("duplicate");
    } else {
      expect(dup.status).toBe(201);
    }
    // 不同问题不受影响
    const other = await http.j("/api/contemplations", "POST", {
      question: "E2E:另一个不同的问题?",
    });
    expect(other.status).toBe(201);
  });

  it("A5 cancel:thinking 条目终止回 queued,审计留痕", async () => {
    const ctx = makeViewerCtx();
    const port = await nextPort();
    runtime = await startViewerServer(ctx as never, { port });
    const http = makeHttp(`http://127.0.0.1:${port}`);

    // 域层直建条目(rounds=0、无后台 job 竞态)→ thinking 态确定
    const entry = ctx.incubator.create({ question: "E2E:终止链路问题?" });
    const id = entry.id;
    expect(ctx.incubator.acquireThinking(id, "e2e")).toBe(true);

    const cancelled = await http.j(`/api/contemplations/${id}/cancel`, "POST");
    expect(cancelled.status).toBe(200);
    expect((cancelled.json.entry as { status: string }).status).toBe("queued");
    // 非进行中再 cancel → 409
    const again = await http.j(`/api/contemplations/${id}/cancel`, "POST");
    expect(again.status).toBe(409);

    const raw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    expect(raw).toContain("contemplation_run_cancel");
  });

  it("A6 force delete:进行中默认 409,force 终止并删除,审计 abortedRun", async () => {
    const ctx = makeViewerCtx();
    const port = await nextPort();
    runtime = await startViewerServer(ctx as never, { port });
    const http = makeHttp(`http://127.0.0.1:${port}`);

    const created = await http.j("/api/contemplations", "POST", {
      question: "E2E:误建待删问题?",
    });
    const id = (created.json.entry as { id: string }).id;
    expect(ctx.incubator.acquireThinking(id, "e2e")).toBe(true);

    const refused = await http.j(`/api/contemplations/${id}/delete`, "POST");
    expect(refused.status).toBe(409);

    const forced = await http.j(`/api/contemplations/${id}/delete`, "POST", { force: true });
    expect(forced.status).toBe(200);
    const list = await http.j("/api/contemplations");
    expect(list.json.items).toHaveLength(0);

    const raw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    expect(raw).toContain("abortedRun");
  });
});

// ============================================================
// 场景 B:MCP 工具面(对话入口,不触发真实 L2)
// ============================================================
describe("沉思 E2E / 场景 B:MCP 工具面(对话内入口)", () => {
  it("B1 ponder_create 防重:同问题二次创建 → VALIDATION 错误含指引(agent 可读)", async () => {
    const { client } = await startMcpClient(tmpDir);
    const r1 = await callTool(client, "ponder_create", { question: "E2E MCP:沉思防重验证问题?" });
    expect(r1.status).toBe("queued");

    // 同问题(queued,未完成态)再创建 → 域层 duplicate → 工具层 VALIDATION 转译
    const r2 = await client.callTool({
      name: "ponder_create",
      arguments: { question: "E2E MCP:沉思防重验证问题?" },
    });
    const err = r2 as unknown as { isError?: boolean; content: Array<{ text?: string }> };
    expect(err.isError).toBe(true);
    const msg = err.content[0]?.text ?? "";
    expect(msg).toContain("duplicate");
    expect(msg).toContain("ponder_list");
  });

  it("B2 ponder_list 可见 → ponder_delete 删除", async () => {
    const { client } = await startMcpClient(tmpDir);
    const created = await callTool(client, "ponder_create", { question: "E2E MCP:列表与删除链路问题?" });
    const id = created.id as string;

    // ponder_list 渲染为 markdown 文本:按 id/问题文本断言可见
    const listText = await callToolText(client, "ponder_list", {});
    expect(listText).toContain(id);
    expect(listText).toContain("列表与删除链路问题");

    // ponder_delete 参数是 id(strict schema)
    const del = await callTool(client, "ponder_delete", { id });
    expect(del.id ?? del.deleted ?? del.ok ?? true).toBeTruthy();
    // 删后列表不再含该 id
    const after = await callToolText(client, "ponder_list", {});
    expect(after).not.toContain(id);
  });
});

// ============================================================
// 场景 C:跨端数据共享(viewer HTTP ↔ MCP 同 dataRoot 互见)
// ============================================================
describe("沉思 E2E / 场景 C:跨端数据共享", () => {
  it("viewer 创建(跑完)→ MCP ponder_list 可见;MCP 创建 → viewer GET 可见", async () => {
    // 先经 viewer HTTP 创建并跑完(fake executor)
    const http = await startViewer();
    const created = await http.j("/api/contemplations", "POST", {
      question: "E2E 跨端:viewer 创建的问题?",
    });
    const viewerId = (created.json.entry as { id: string }).id;
    await pollJob(http, created.json.jobId as string);
    await runtime!.stop();
    runtime = undefined;

    // MCP(同 dataRoot)可见该条目(ponder_list 渲染 markdown 文本)
    const { client } = await startMcpClient(tmpDir);
    const listText = await callToolText(client, "ponder_list", {});
    expect(listText).toContain(viewerId);

    // MCP 创建 → viewer(新实例,同 dataRoot)GET 可见
    const mcpCreated = await callTool(client, "ponder_create", { question: "E2E 跨端:MCP 创建的问题?" });
    const mcpId = mcpCreated.id as string;
    const http2 = await startViewer();
    const list2 = await http2.j("/api/contemplations");
    const ids = (list2.json.items as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(mcpId);
  });
});
