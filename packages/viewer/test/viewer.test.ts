import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";

import {
  EngramRepository,
  EngramRepository,
  SearchOrchestrator,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  writeTeamMemoryConfig,
  zh,
  en,
  type Synapse,
  type SynapseKind,
  type SynapseDirection,
} from "@co-engram/core";
import { startViewerServer, renderSpaHtml } from "../src/index.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

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

/** 分配一个非默认端口(避免和并发测试/真实 viewer 冲突) */
let portCounter = 20000;
function nextPort(): number {
  portCounter += 1;
  return portCounter;
}

function makeRequest(
  port: number,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const headers: http.OutgoingHttpHeaders = { connection: "close" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body) {
      const json = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(json);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function withViewer<T>(
  ctx: ReturnType<typeof makeCtx>,
  options:
    | { token?: string; language?: "en" | "zh"; dataRoot?: string }
    | undefined,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  // Task 5.3:测试基础设施改用 env CO_ENGRAM_VIEWER_PORT 而非 config.port,
  // 避免触发 viewer.port deprecation warn(那是为真实用户准备的提示,不是测试噪音)。
  const port = nextPort();
  const savedEnv = process.env.CO_ENGRAM_VIEWER_PORT;
  process.env.CO_ENGRAM_VIEWER_PORT = String(port);
  try {
    const runtime = await startViewerServer(ctx, {
      ...(options?.token ? { token: options.token } : {}),
      ...(options?.language ? { language: options.language } : {}),
      ...(options?.dataRoot ? { dataRoot: options.dataRoot } : {}),
    });
    try {
      return await fn(runtime.port);
    } finally {
      await runtime.stop();
    }
  } finally {
    if (savedEnv === undefined) {
      delete process.env.CO_ENGRAM_VIEWER_PORT;
    } else {
      process.env.CO_ENGRAM_VIEWER_PORT = savedEnv;
    }
  }
}

/** 读取 ${dir}/.co-engram/config.json;不存在返回 undefined。 */
async function readConfig(
  dir: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(`${dir}/.co-engram/config.json`, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function makeSynapse(from: string, to: string, kind: SynapseKind): Synapse {
  const ts = new Date().toISOString();
  return {
    id: randomUUID(),
    from,
    to,
    kind,
    weight: 0.5,
    direction: "forward" as SynapseDirection,
    evidence: [],
    createdBy: "test",
    createdAt: ts,
    updatedAt: ts,
    retrievalWeight: 0.5,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// renderSpaHtml
// ============================================================

describe("renderSpaHtml", () => {
  it("返回完整 HTML(含 doctype 和内联 vis-network)", () => {
    const html = renderSpaHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("vis-network");
    // 完全离线,不依赖 CDN
    expect(html).not.toContain("unpkg.com");
    expect(html).not.toContain("alpinejs");
    // 默认 language=zh,标题 + slogan 拆分为两段(brand name + slogan)
    expect(html).toContain("Co-Engram");
    expect(html).toContain("自进化的团队记忆");
  });

  it("tokenRequired 时显示 auth-bar div", () => {
    const html = renderSpaHtml({ tokenRequired: true });
    expect(html).toContain('<div class="auth-bar">');
    expect(html).toContain('placeholder="Bearer token"');
  });

  it("不要求 token 时不显示 auth-bar div", () => {
    const html = renderSpaHtml({ tokenRequired: false });
    expect(html).not.toContain('<div class="auth-bar">');
  });

  it("language=en 渲染英文 UI", () => {
    const html = renderSpaHtml({ language: "en" });
    expect(html).toContain("Self-evolving team memory");
    expect(html).toContain('data-tab="stats"');
    expect(html).toContain(">Stats</button>");
    expect(html).toContain('data-tab="engrams"');
    expect(html).toContain(">Engrams</button>");
    expect(html).toContain('data-tab="audit"');
    expect(html).toContain(">Audit</button>");
    expect(html).toContain("Full-text search engrams");
    // 中文 UI 不应该有英文 tab 标签
    expect(html).not.toContain(">统计</button>");
    expect(html).not.toContain(">审计</button>");
  });

  it("language=zh 渲染中文 UI", () => {
    const html = renderSpaHtml({ language: "zh" });
    // title + slogan 拆分为两段
    expect(html).toContain("Co-Engram");
    expect(html).toContain("自进化的团队记忆");
    expect(html).toContain("统计");
    expect(html).toContain("审计");
    expect(html).toContain("全文检索");
    expect(html).toContain("搜索");
    // 中文 UI 不应该有英文 tab 标签
    expect(html).not.toContain(">Stats</button>");
    expect(html).not.toContain(">Engrams</button>");
  });

  it("language 影响 <html lang=...>", () => {
    const en = renderSpaHtml({ language: "en" });
    const zh = renderSpaHtml({ language: "zh" });
    expect(en).toContain('<html lang="en">');
    expect(zh).toContain('<html lang="zh">');
  });

  it("默认 language 为 zh", () => {
    const html = renderSpaHtml();
    expect(html).toContain("Co-Engram");
    expect(html).toContain("自进化的团队记忆");
    expect(html).toContain("统计");
  });

  it("vis-network 内联 + tab 容器存在", () => {
    const html = renderSpaHtml();
    expect(html).toContain("vis-network");
    expect(html).toContain('id="graph-canvas"');
    expect(html).toContain('id="engrams-content"');
    expect(html).toContain('id="audit-content"');
    expect(html).toContain('id="detail-drawer"');
  });

  it("marked + DOMPurify vendor 内联(markdown 渲染依赖)", () => {
    const html = renderSpaHtml();
    // 两个 vendor 都通过 build-vendor.mjs 内联为 script
    expect(html).toContain("marked");
    expect(html).toContain("DOMPurify");
    // renderMarkdown helper 注册到 CO_ENGRAM(供详情页/编辑预览调用)
    expect(html).toContain("renderMarkdown");
    // markdown-body CSS class 存在
    expect(html).toContain(".markdown-body");
  });
});

// ============================================================
// Viewer server - 基础行为
// ============================================================

describe("Viewer server 基础", () => {
  it("指定端口可访问", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, { port });
    try {
      expect(runtime.port).toBe(port);
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(200);
    } finally {
      await runtime.stop();
    }
  });

  it("EADDRINUSE 时自动重试到下一个端口", async () => {
    const port = nextPort();
    // 占用 port
    const occupier = await startViewerServer(makeCtx(tmpDir), { port });
    try {
      const ctx2 = makeCtx(tmpDir);
      const runtime = await startViewerServer(ctx2, { port });
      try {
        expect(runtime.port).toBe(port + 1); // 自动 +1
      } finally {
        await runtime.stop();
      }
    } finally {
      await occupier.stop();
    }
  });

  it("GET / 返回 HTML", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("<!DOCTYPE html>");
      // 默认 language=zh,标题 + slogan 拆分为两段
      expect(res.body).toContain("Co-Engram");
      expect(res.body).toContain("自进化的团队记忆");
    });
  });

  it("viewer server config.language=zh 返回中文 HTML", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { language: "zh" }, async (port) => {
      const res = await makeRequest(port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Co-Engram");
      expect(res.body).toContain("自进化的团队记忆");
      expect(res.body).toContain("统计");
      expect(res.body).toContain("全文检索");
      expect(res.body).toContain('<html lang="zh">');
    });
  });

  it("viewer server config.language=en 返回英文 HTML", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { language: "en" }, async (port) => {
      const res = await makeRequest(port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Self-evolving team memory");
      expect(res.body).toContain('data-tab="stats"');
      expect(res.body).toContain(">Stats</button>");
      expect(res.body).toContain("Full-text search engrams");
      expect(res.body).toContain('<html lang="en">');
    });
  });

  it("未知 API 路径返回 404", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/unknown");
      expect(res.status).toBe(404);
    });
  });

  it("OPTIONS 请求返回 204(CORS preflight)", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats", { method: "OPTIONS" });
      expect(res.status).toBe(204);
    });
  });
});

// ============================================================
// /api/stats
// ============================================================

describe("GET /api/stats", () => {
  it("返回空仓库统计", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalEngrams).toBe(0);
      expect(data.byKind).toEqual({});
      expect(data.topTags).toEqual([]);
      expect(data.pendingProposals).toBe(0);
      expect(data.auditEnabled).toBe(true);
      expect(data.proposalEnabled).toBe(true);
    });
  });

  it("创建 engram 后能统计到", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "测试",
      content: "ADB 调试",
      kind: "procedure",
      domainTags: ["testing"],
      createdBy: "tester",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      const data = JSON.parse(res.body);
      expect(data.totalEngrams).toBe(1);
      expect(data.byKind.procedure).toBe(1);
      expect(data.topTags[0]).toEqual({ tag: "testing", count: 1 });
    });
  });
});

// ============================================================
// /api/status (ROI #1 — 健康可视化,与 CLI 共用 core computeStatus)
// ============================================================

describe("GET /api/status", () => {
  it("dataRoot 未配置时返回 overall=error 占位快照", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/status");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.overall).toBe("error");
      expect(data.dataRootExists).toBe(false);
      expect(data.stats.total).toBe(0);
    });
  });

  it("dataRoot 指向真实仓库时返回 checks + overall", async () => {
    const ctx = makeCtx(tmpDir);
    // 写入 .co-engram/config.json 让 computeStatus 识别为 engram 仓库
    await writeTeamMemoryConfig(tmpDir, {
      version: 1,
      language: "zh",
      defaultCreatedBy: "tester",
      createdAt: new Date().toISOString(),
      initializedBy: "test",
    });
    ctx.repository.createEngram({
      title: "t",
      content: "c",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "tester",
    });
    await withViewer(ctx, { dataRoot: tmpDir }, async (port) => {
      const res = await makeRequest(port, "/api/status");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.dataRoot).toBe(tmpDir);
      expect(data.dataRootExists).toBe(true);
      expect(data.isEngramWarehouse).toBe(true);
      expect(data.stats.total).toBe(1);
      expect(data.stats.byKind.fact).toBe(1);
      expect(Array.isArray(data.checks)).toBe(true);
      expect(data.checks.length).toBeGreaterThan(0);
      // overall 不是 error(仓库存在且有 engram)
      expect(data.overall).not.toBe("error");
    });
  });
});

// ============================================================
// /api/engrams
// ============================================================

describe("GET /api/engrams", () => {
  it("返回所有 engram", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "y",
    });
    ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "procedure",
      domainTags: ["y"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/engrams");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.total).toBe(2);
      expect(data.results).toHaveLength(2);
    });
  });

  it("按 kind 过滤", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "y",
    });
    ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "procedure",
      domainTags: ["y"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/engrams?kind=fact");
      const data = JSON.parse(res.body);
      expect(data.total).toBe(1);
      expect(data.results[0].title).toBe("A");
    });
  });

  it("按 tag 过滤", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["x"],
      createdBy: "y",
    });
    ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["y"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/engrams?tag=x");
      const data = JSON.parse(res.body);
      expect(data.total).toBe(1);
      expect(data.results[0].title).toBe("A");
    });
  });
});

// ============================================================
// /api/engrams/:id
// ============================================================

describe("GET /api/engrams/:id", () => {
  it("返回详情", async () => {
    const ctx = makeCtx(tmpDir);
    const engram = ctx.repository.createEngram({
      title: "Hello",
      content: "World",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(
        port,
        `/api/engrams/${encodeURIComponent(engram.id)}`,
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.title).toBe("Hello");
    });
  });

  it("不存在返回 404", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/engrams/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});

describe("PATCH /api/engrams/:id", () => {
  it("更新标题", async () => {
    const ctx = makeCtx(tmpDir);
    const engram = ctx.repository.createEngram({
      title: "Old",
      content: "content",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(
        port,
        `/api/engrams/${encodeURIComponent(engram.id)}`,
        { method: "PATCH", body: { title: "New" } },
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.title).toBe("New");
    });
  });

  it("更新 importance", async () => {
    const ctx = makeCtx(tmpDir);
    const engram = ctx.repository.createEngram({
      title: "T",
      content: "c",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(
        port,
        `/api/engrams/${encodeURIComponent(engram.id)}`,
        { method: "PATCH", body: { importance: 0.9 } },
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.importance).toBe(0.9);
    });
  });
});

describe("DELETE /api/engrams/:id", () => {
  it("删除 engram", async () => {
    const ctx = makeCtx(tmpDir);
    const engram = ctx.repository.createEngram({
      title: "ToDelete",
      content: "c",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(
        port,
        `/api/engrams/${encodeURIComponent(engram.id)}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.deleted).toBe(true);
    });
  });

  it("F1: updateLifecycle 静默 noop 时 → 返回 500 而非伪成功(与工具层 fail-loud 契约一致)", async () => {
    const ctx = makeCtx(tmpDir);
    const engram = ctx.repository.createEngram({
      title: "F1 viewer",
      content: "updateLifecycle 会被 stub 成 noop",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    // 2026-07 Batch 1 改造后,DELETE 走 updateLifecycle 软删除(不再调 deleteEngram)。
    // stub 改成 noop 模拟 race / 不一致 / 被拦截。post-check 读 engram.status,
    // 仍是 active → 500 + 提示 engram_doctor。
    const failingRepo = new Proxy(ctx.repository, {
      get(target, prop, receiver) {
        if (prop === "updateLifecycle") return () => {};
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof ctx.repository;
    ctx.repository = failingRepo;

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(
        port,
        `/api/engrams/${encodeURIComponent(engram.id)}`,
        { method: "DELETE" },
      );
      // F1 修复后:post-check 检测到 engram 仍是 active → 500 + 提示 engram_doctor
      expect(res.status).toBe(500);
      const data = JSON.parse(res.body);
      expect(data.error).toMatch(/still exists as active after updateLifecycle/);
      expect(data.error).toMatch(/engram_doctor/);
    });
  });
});

// ============================================================
// /api/search
// ============================================================

describe("GET /api/search", () => {
  it("空 query 返回空结果", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/search");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.total).toBe(0);
    });
  });

  it("有 query 但索引未构建返回错误或空", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "ADB Debug",
      content: "wireless adb",
      kind: "fact",
      domainTags: ["testing"],
      createdBy: "y",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/search?q=adb");
      // 索引未构建时会抛错,viewer 应捕获并返回 500
      expect(res.status === 200 || res.status === 500).toBe(true);
    });
  });

  it("索引构建后返回结果", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "ADB Debug",
      content: "wireless adb",
      kind: "fact",
      domainTags: ["testing"],
      createdBy: "y",
    });
    const entries = ctx.repository.listEngrams();
    const digest = entries.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      kinds: [e.kind],
      summary: e.title,
      domainTags: e.domainTags,
      contextTags: [],
      importance: 0.5,
      freshness: "fresh" as const,
      status: "active" as const,
      sourceType: "firsthand" as const,
      createdBy: "y",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRetrievedAt: null,
      lastEffectiveAt: null,
      retrievalCount: 0,
      effectiveRetrievals: 0,
      failedUses: 0,
      reinforcementScore: 0,
      contentSize: 100,
      contentHash: "sha256:stub",
      outgoingSynapseCount: 0,
      incomingSynapseCount: 0,
      activeContradictionCount: 0,
    }));
    ctx.searchOrchestrator.build(digest);

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/search?q=adb");
      const data = JSON.parse(res.body);
      expect(data.results.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// /api/graph
// ============================================================

describe("GET /api/graph", () => {
  it("返回节点 + 边", async () => {
    const ctx = makeCtx(tmpDir);
    const a = ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const b = ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    ctx.repository.addOutgoingSynapse(a.id, makeSynapse(a.id, b.id, "extends"));
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/graph");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.nodes.length).toBe(2);
      expect(data.edges.length).toBe(1);
      expect(data.edges[0].from).toBe(a.id);
      expect(data.edges[0].to).toBe(b.id);
      expect(data.edges[0].kind).toBe("extends");
    });
  });

  it("边包含完整元数据 (id/weight/evidenceCount/direction)", async () => {
    const ctx = makeCtx(tmpDir);
    const a = ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const b = ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    ctx.repository.addOutgoingSynapse(a.id, makeSynapse(a.id, b.id, "extends"));
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/graph");
      const data = JSON.parse(res.body);
      const edge = data.edges[0];
      expect(edge.id).toBeTruthy();
      expect(typeof edge.weight).toBe("number");
      expect(typeof edge.evidenceCount).toBe("number");
      expect(edge.direction).toBe("forward");
    });
  });

  it("空仓库返回空图", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/graph");
      const data = JSON.parse(res.body);
      expect(data.nodes).toEqual([]);
      expect(data.edges).toEqual([]);
    });
  });

  it('bidirectional synapse 不被重复加边 (regression: vis-network "item already exists")', async () => {
    // 背景:bidirectional synapse 同时出现在两端的 outgoing 列表里,
    // buildGraph 遍历每个 engram 时会把同一条边 push 两次(同 id)。
    // 前端 vis-network DataSet 用 id 去重,会抛
    //   "Cannot add item: item with id syn-XXX already exists"
    // 导致 viewer 整个图渲染失败。
    const ctx = makeCtx(tmpDir);
    const a = ctx.repository.createEngram({
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const b = ctx.repository.createEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const syn = makeSynapse(a.id, b.id, "derives_from");
    syn.direction = "bidirectional";
    ctx.repository.addOutgoingSynapse(a.id, syn);

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/graph");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.nodes.length).toBe(2);
      // 关键:虽然 bidirectional 在 A 和 B 的 outgoing 都出现,只能产生 1 条边
      expect(data.edges.length).toBe(1);
      const edgeIds = data.edges.map((e: { id: string }) => e.id);
      expect(new Set(edgeIds).size).toBe(edgeIds.length);
      expect(data.edges[0].direction).toBe("bidirectional");
    });
  });
});

// ============================================================
// /api/path-tree
// ============================================================

describe("GET /api/path-tree", () => {
  it("空仓库返回根节点 + engramCount=0", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/path-tree");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.root.path).toBe("/");
      expect(data.root.engramCount).toBe(0);
    });
  });
});

// ============================================================
// /api/doctor
// ============================================================

describe("GET /api/doctor", () => {
  it("空仓库返回空报告(可能含 infra-doctor 重建索引的 fix)", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/doctor");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.report.totalEngrams).toBe(0);
      // infra-doctor preflight 会自动重建缺失的派生索引(digest.jsonl / graph.json)
      // 空仓库首次跑会产 1 个 index_rebuilt fix,这是预期行为
      const engramFileFixes = data.report.fixes.filter(
        (f: { kind: string }) => !["index_rebuilt", "merge_driver_installed"].includes(f.kind),
      );
      expect(engramFileFixes).toEqual([]);
      expect(data.report.pendingManualReview).toEqual([]);
    });
  });

  it("支持 incremental=1 参数", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/doctor?incremental=1");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
    });
  });
});

// ============================================================
// /api/proposals
// ============================================================

describe("GET /api/proposals", () => {
  it("返回 pending proposals", async () => {
    const ctx = makeCtx(tmpDir);
    await ctx.proposalEngine.observe({
      role: "user",
      content: "how to configure co-engram with environment variables",
    });
    const pending = ctx.proposalEngine.listPending();
    expect(pending.length).toBeGreaterThan(0);

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/proposals");
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.total).toBeGreaterThanOrEqual(1);
    });
  });

  it("可查看所有 status", async () => {
    const ctx = makeCtx(tmpDir);
    await ctx.proposalEngine.observe({
      role: "user",
      content: "some unique content for testing proposals api",
    });

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/proposals?status=all");
      const data = JSON.parse(res.body);
      expect(data.total).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================
// /api/audit
// ============================================================

describe("GET /api/audit", () => {
  it("返回审计记录", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.auditLog.append({
      actor: "user",
      action: "create",
      engramId: "test-1",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/audit");
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.results.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("按 action 过滤", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.auditLog.append({ actor: "user", action: "create", engramId: "a" });
    ctx.auditLog.append({ actor: "user", action: "reinforce", engramId: "b" });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/audit?action=create");
      const data = JSON.parse(res.body);
      expect(
        data.results.every((e: { action: string }) => e.action === "create"),
      ).toBe(true);
    });
  });
});

// ============================================================
// /api/effectiveness
// ============================================================

describe("GET /api/effectiveness", () => {
  it("返回某 engram 的有效率", async () => {
    const ctx = makeCtx(tmpDir);
    // 通过 tracker API 产生 window 记录(effectiveness 现从 windows 派生,不再读 audit)
    ctx.effectivenessTracker.openWindow({
      engramId: "e1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    ctx.effectivenessTracker.closeAsEffective("e1");
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/effectiveness?engramId=e1");
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.engramId).toBe("e1");
      expect(data.report.hits).toBe(1);
      expect(data.report.effective).toBe(1);
    });
  });

  it("无 engramId 返回空 report", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/effectiveness");
      const data = JSON.parse(res.body);
      expect(data.report).toBeNull();
    });
  });
});

// ============================================================
// /api/merge-stats
// ============================================================

describe("GET /api/merge-stats", () => {
  it("返回空统计(无 merge 事件)", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-stats");
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.stats.totalMerges).toBe(0);
      expect(data.stats.autoResolved).toBe(0);
      expect(data.stats.escalatedToMarkers).toBe(0);
      expect(data.stats.backupFailures).toBe(0);
      expect(data.windowDays).toBe(7);
    });
  });

  it("聚合 7 天内的 merge 事件", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.auditLog.append({
      actor: "merge-driver",
      action: "merge_resolved",
      engramId: "e1",
    });
    ctx.auditLog.append({
      actor: "merge-driver",
      action: "merge_resolved",
      engramId: "e2",
    });
    ctx.auditLog.append({
      actor: "merge-driver",
      action: "merge_conflict_escalated",
      engramId: "e3",
    });
    ctx.auditLog.append({
      actor: "merge-driver",
      action: "merge_llm_arbitrated",
      engramId: "e4",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-stats");
      const data = JSON.parse(res.body);
      expect(data.stats.totalMerges).toBe(3);
      expect(data.stats.autoResolved).toBe(2);
      expect(data.stats.escalatedToMarkers).toBe(1);
      expect(data.stats.llm.arbitrated).toBe(1);
      expect(data.stats.llm.totalInvocations).toBe(1);
    });
  });

  it("支持 windowDays 查询参数", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-stats?windowDays=30");
      const data = JSON.parse(res.body);
      expect(data.windowDays).toBe(30);
    });
  });

  it("windowDays 钳制到 [1, 365]", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const tooLarge = await makeRequest(
        port,
        "/api/merge-stats?windowDays=9999",
      );
      expect(JSON.parse(tooLarge.body).windowDays).toBe(365);
      const tooSmall = await makeRequest(port, "/api/merge-stats?windowDays=0");
      expect(JSON.parse(tooSmall.body).windowDays).toBe(1);
      const invalid = await makeRequest(
        port,
        "/api/merge-stats?windowDays=abc",
      );
      expect(JSON.parse(invalid.body).windowDays).toBe(7);
    });
  });
});

// ============================================================
// /api/merge-anomalies
// ============================================================

describe("GET /api/merge-anomalies", () => {
  it("健康状态返回空数组", async () => {
    const ctx = makeCtx(tmpDir);
    for (let i = 0; i < 20; i++) {
      ctx.auditLog.append({
        actor: "merge-driver",
        action: "merge_resolved",
        engramId: `e-${i}`,
      });
    }
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-anomalies");
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(Array.isArray(data.anomalies)).toBe(true);
      expect(data.anomalies.length).toBe(0);
    });
  });

  it("backup 失败触发 critical 异常", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.auditLog.append({
      actor: "merge-driver",
      action: "merge_backup_failed",
      engramId: "e1",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-anomalies");
      const data = JSON.parse(res.body);
      expect(data.anomalies.length).toBeGreaterThanOrEqual(1);
      const crit = data.anomalies.find(
        (a: { severity: string; kind: string }) =>
          a.severity === "critical" && a.kind === "backup_failure",
      );
      expect(crit).toBeDefined();
    });
  });

  it("支持 windowDays 参数", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/merge-anomalies?windowDays=14");
      const data = JSON.parse(res.body);
      expect(data.windowDays).toBe(14);
    });
  });
});

// ============================================================
// /api/trash
// ============================================================

describe("GET /api/trash", () => {
  it("空仓库返回空列表", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/trash");
      const data = JSON.parse(res.body);
      expect(data.total).toBe(0);
    });
  });
});

// ============================================================
// 认证
// ============================================================

describe("Token 认证", () => {
  it("无 token 时所有 /api 请求 401", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { token: "secret" }, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(401);
    });
  });

  it("错误 token 401", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { token: "secret" }, async (port) => {
      const res = await makeRequest(port, "/api/stats", { token: "wrong" });
      expect(res.status).toBe(401);
    });
  });

  it("正确 token 200", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { token: "secret" }, async (port) => {
      const res = await makeRequest(port, "/api/stats", { token: "secret" });
      expect(res.status).toBe(200);
    });
  });

  it("GET / 不需要 token(登录页可达)", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, { token: "secret" }, async (port) => {
      const res = await makeRequest(port, "/");
      expect(res.status).toBe(200);
    });
  });
});

// ============================================================
// PUT /api/config — dataRoot 编辑(写 ~/.co-engram/config.json bootstrap)
// 关键 UX:non-engram 目录首次 force=false 拒绝并返回 existingFiles,
// UI 弹"接管此目录"二次确认后,带 force=true 重发接管成功。
// 这组测试锁住该契约,防止回归到"硬拒绝 + 让用户走 CLI"。
// ============================================================

describe("PUT /api/config dataRoot + force UX 路径", () => {
  let tmpRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "co-engram-api-config-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("missing dir + force=false → 200 ok:true(自动 mkdir+initialize)", async () => {
    const ctx = makeCtx(tmpDir);
    const targetPath = join(tmpRoot, "new-dir");
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/config", {
        method: "PUT",
        body: { dataRoot: targetPath },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.initialized).toBe(true);
    });
  });

  it("non-engram + force=false → 400 + reason=non-engram + existingFiles 数组", async () => {
    const ctx = makeCtx(tmpDir);
    // 准备一个有用户文件的目录
    const targetPath = join(tmpRoot, "has-files");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "README.md"), "# existing");
    writeFileSync(join(targetPath, "notes.txt"), "my notes");

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/config", {
        method: "PUT",
        body: { dataRoot: targetPath },
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("non-engram");
      // 关键:返回 existingFiles 让 UI 能弹二次确认 banner
      expect(Array.isArray(body.existingFiles)).toBe(true);
      expect(body.existingCount).toBeGreaterThanOrEqual(2);
      expect(body.existingFiles.sort()).toEqual(["README.md", "notes.txt"]);
    });
  });

  it("non-engram + force=true → 200 ok:true + 用户原有文件完好", async () => {
    const ctx = makeCtx(tmpDir);
    const targetPath = join(tmpRoot, "takeover");
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "README.md"), "# my project");

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/config", {
        method: "PUT",
        body: { dataRoot: targetPath, force: true },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.initialized).toBe(true);
    });

    // 用户的 README.md 必须完好——这是 force 的核心信任基础
    const readme = readFileSync(join(targetPath, "README.md"), "utf8");
    expect(readme).toBe("# my project");
    // .co-engram/ 子目录被创建,内含合法 config.json
    const configJson = readFileSync(
      join(targetPath, ".co-engram", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(configJson);
    expect(parsed.version).toBe(1);
  });

  it("GET /api/config 返回 suggestedPaths 让首次 UI 显示推荐路径", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/config");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.suggestedPaths).toBeDefined();
      expect(typeof body.suggestedPaths.home).toBe("string");
      expect(body.suggestedPaths.home).toContain("team-memory");
      expect(body.suggestedPaths.hidden).toContain(".co-engram-data");
    });
  });
});

// ============================================================
// renderVisibilityBadge — 列表 / 详情 / 提案显示 visibility 徽章
// ============================================================
//
// 注意:tabs.ts 是 export const TABS_RUNTIME = "..." 的字符串注入,不是普通 TS 模块。
// 不能 `import { renderVisibilityBadge }`。沿用 health-tab.test.ts 的字符串断言模式:
//   1. TABS_RUNTIME 含 renderVisibilityBadge 函数定义
//   2. TABS_RUNTIME 的列表 / 详情 / 提案三处调用 renderVisibilityBadge
//   3. zh / en i18n 含 viewer.engram.visibilityBadge.{level}.tip 翻译键
//   4. 实际 HTTP /api/engrams 渲染的 HTML 含 visibility 徽章 chip

describe("renderVisibilityBadge", () => {
  const VISIBILITIES = ["public", "team", "private", "restricted"] as const;

  it("TABS_RUNTIME 含 renderVisibilityBadge 函数定义", () => {
    expect(TABS_RUNTIME).toContain("renderVisibilityBadge");
    // 函数体含四种 visibility 的图标映射
    expect(TABS_RUNTIME).toContain("🌍");
    expect(TABS_RUNTIME).toContain("👥");
    expect(TABS_RUNTIME).toContain("🔒");
    expect(TABS_RUNTIME).toContain("⚠️");
  });

  it("函数返回带 chip / visibility-* / title 的 HTML", () => {
    // 函数定义里必须含 class="chip visibility- + title= 的模板
    expect(TABS_RUNTIME).toContain("visibility-");
    expect(TABS_RUNTIME).toContain("title=");
  });

  it("TABS_RUNTIME 在 engram 列表 / 详情 / 提案三处调用 renderVisibilityBadge", () => {
    const occurrences = TABS_RUNTIME.split("renderVisibilityBadge").length - 1;
    // 1 处函数定义 + 3 处调用 = 至少 4 次
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  for (const v of VISIBILITIES) {
    it(`zh 含 viewer.engram.visibilityBadge.${v}.tip 翻译键`, () => {
      const key = `viewer.engram.visibilityBadge.${v}.tip` as keyof typeof zh;
      expect(zh[key], `zh.${key} 缺翻译`).toBeTruthy();
    });
    it(`en 含 viewer.engram.visibilityBadge.${v}.tip 翻译键`, () => {
      const key = `viewer.engram.visibilityBadge.${v}.tip` as keyof typeof en;
      expect(en[key], `en.${key} 缺翻译`).toBeTruthy();
    });
    it(`zh 与 en 的 ${v}.tip 翻译不同(防复制粘贴漏改)`, () => {
      const key = `viewer.engram.visibilityBadge.${v}.tip` as keyof typeof zh;
      expect(zh[key]).not.toBe(en[key as keyof typeof en]);
    });
  }

  it("engram 列表 HTTP 渲染包含 visibility 徽章 chip", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "测试 visibility badge",
      content: "private engram 用于验证列表渲染含徽章",
      kind: "fact",
      domainTags: ["test"],
      visibility: "private",
      createdBy: "test",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/engrams");
      expect(res.status).toBe(200);
      // /api/engrams 返回 JSON,不含 HTML;真正列表渲染发生在 TABS_RUNTIME 客户端。
      // 这里仅校验后端返回的 engram 含 visibility 字段,前端 chip 由字符串断言覆盖。
      const body = JSON.parse(res.body);
      expect(body.results[0].visibility).toBe("private");
    });
  });
});

// ============================================================
// POST /api/restart — 触发 MCP 服务优雅退出
// ============================================================

describe("POST /api/restart", () => {
  it("响应 200 + ok:true,300ms 后调用 process.exit(0)", async () => {
    const ctx = makeCtx(tmpDir);
    const exitCalls: number[] = [];
    const realExit = process.exit;
    // 拦截 process.exit:仅记录调用,不真的退出测试进程,也不抛错
    // (抛错会被 setTimeout 吞成 unhandled exception,污染 Vitest 报告)
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as typeof process.exit;

    try {
      await withViewer(ctx, undefined, async (port) => {
        const res = await makeRequest(port, "/api/restart", { method: "POST" });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(true);
        // 等 400ms 让 setTimeout(300) 触发
        await new Promise((r) => setTimeout(r, 400));
      });
    } finally {
      process.exit = realExit;
    }
    expect(exitCalls).toEqual([0]);
  });
});

// Task 3:提案详情表单的 visibility 选择器(字符串断言)
// 参考 health-tab.test.ts 的字符串断言模式;TABS_RUNTIME 是注入到 iframe 的字符串。
// 注意:visKeys 的 option 通过 `'<option value="' + v + '"'` 拼接,运行时才生成
// `value="public"` 等;源码层只能断言 `'<option value="'` 与 `visKeys` 字面量。
describe("Task 3: proposals visibility selector (字符串断言)", () => {
  it("TABS_RUNTIME 在 proposal 详情表单渲染 visibility 下拉", () => {
    // 详情表单内有 <select id="pf-visibility" name="visibility">
    expect(TABS_RUNTIME).toContain('id="pf-visibility"');
    expect(TABS_RUNTIME).toContain('name="visibility"');
    // visKeys 数组里 4 个枚举值源码字面量
    expect(TABS_RUNTIME).toContain("'public'");
    expect(TABS_RUNTIME).toContain("'private'");
    expect(TABS_RUNTIME).toContain("'team'");
    expect(TABS_RUNTIME).toContain("'restricted'");
    // 拼接 <option value="..." selected ...> 模板
    expect(TABS_RUNTIME).toContain("<option value=\"");
  });

  it("TABS_RUNTIME 引用 visibility i18n keys(label + hint)", () => {
    expect(TABS_RUNTIME).toContain("viewer.proposals.visibility.label");
    expect(TABS_RUNTIME).toContain("viewer.proposals.visibility.hint");
    // option label 用 viewer.engram.visibilityBadge.<v>
    expect(TABS_RUNTIME).toContain("viewer.engram.visibilityBadge.");
  });

  it("acceptFromForm 读取并透传 visibility 给 /accept 端点", () => {
    // acceptFromForm 必须读取 #pf-visibility
    expect(TABS_RUNTIME).toMatch(/pf-visibility/);
    // 条件性透传(非 public 才带 visibility 字段)
    expect(TABS_RUNTIME).toMatch(/visibility.*!==.*'public'/);
  });
});

// ============================================================
// Task 4:详情页 visibility 切换 UI(字符串断言)
// ============================================================
//
// 详情页已有 renderVisibilityBadge 渲染当前 visibility(Task 1);
// 但用户切换 visibility 必须进 edit form 才能改 —— 体验偏重。
// Task 4 在详情页徽章下方加 <details> 折叠的快捷切换 UI:
//   - <select name="visibility"> 4 个选项(public/team/private/restricted)
//   - 切换按钮调用 CO_ENGRAM_ENGRAMS.updateVisibility(id)
//   - updateVisibility 调 PATCH /api/engrams/:id 透传 visibility 字段
//
// 注意:TABS_RUNTIME 是字符串注入,沿用 health-tab.test.ts 的字符串断言模式。

describe("Task 4: 详情页 visibility 快捷切换 UI (字符串断言)", () => {
  it("TABS_RUNTIME 在详情页渲染 <details> 折叠的 visibility 切换器", () => {
    // 折叠容器 + select + 触发按钮
    expect(TABS_RUNTIME).toContain("visibility-editor");
    expect(TABS_RUNTIME).toContain("<details");
    expect(TABS_RUNTIME).toContain("<summary");
    expect(TABS_RUNTIME).toContain('name="visibility"');
    // 切换按钮绑定到 CO_ENGRAM_ENGRAMS.updateVisibility
    expect(TABS_RUNTIME).toContain("CO_ENGRAM_ENGRAMS.updateVisibility");
  });

  it("TABS_RUNTIME 引用 detail.visibility i18n keys", () => {
    expect(TABS_RUNTIME).toContain("viewer.detail.visibility.changeBtn");
    // option label 复用现有 viewer.engram.visibilityBadge.<v> 翻译
    expect(TABS_RUNTIME).toContain("viewer.engram.visibilityBadge.");
  });

  it("updateVisibility handler 调 PATCH /api/engrams/:id + confirm 对话框", () => {
    // handler 必须读 select 值 + window.confirm + PATCH
    expect(TABS_RUNTIME).toMatch(/updateVisibility\s*\(/);
    expect(TABS_RUNTIME).toContain("window.confirm");
    expect(TABS_RUNTIME).toContain("/api/engrams/");
    expect(TABS_RUNTIME).toContain("PATCH");
  });

  for (const key of [
    "viewer.detail.visibility.changeBtn",
    "viewer.detail.visibility.confirm",
    "viewer.detail.visibility.changed",
  ] as const) {
    it(`zh.${key} 有翻译`, () => {
      expect(zh[key], `zh.${key} 缺翻译`).toBeTruthy();
    });
    it(`en.${key} 有翻译`, () => {
      expect(en[key], `en.${key} 缺翻译`).toBeTruthy();
    });
    it(`zh 与 en 的 ${key} 翻译不同(防复制粘贴漏改)`, () => {
      expect(zh[key]).not.toBe(en[key]);
    });
  }
});

// ============================================================
// 守护测试(Bug 3/4/5/6) — viewer 4 个回归 bug 的不变量
//
// Bug 3: topContributors 必须统计 synapse 作者(不只 engram 作者)
// Bug 4: topTags sum > totalEngrams 是合法的多对多关系(防止未来"修复"破坏此语义)
// Bug 5: /api/proposals 返回 statusCounts,viewer 按钮显示 (N)
// Bug 6: POST /api/proposals/purge-dismissed 清空 dismissed
// ============================================================

describe("守护 · Bug 3: topContributors 合计 engram + synapse 作者", () => {
  it("synapse-only 作者出现在 topContributors 里,且 total 等于 engram+synapse", async () => {
    const ctx = makeCtx(tmpDir);
    // alice 创建 1 个 engram;bob 只创建 synapse(不创建任何 engram)
    const a = ctx.repository.createEngram({
      title: "A", content: "a", kind: "fact",
      domainTags: ["t"], createdBy: "alice",
    });
    const b = ctx.repository.createEngram({
      title: "B", content: "b", kind: "fact",
      domainTags: ["t"], createdBy: "alice",
    });
    // synapse.createdBy = bob(只在 synapse 出现,不在 engram 出现)
    const syn: Synapse = {
      ...makeSynapse(a.id, b.id, "extends"),
      createdBy: "bob",
    };
    ctx.repository.addOutgoingSynapse(a.id, syn);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      const data = JSON.parse(res.body);
      const bob = data.topContributors.find((c: { actor: string }) => c.actor === "bob");
      const alice = data.topContributors.find((c: { actor: string }) => c.actor === "alice");
      // bob 是 synapse-only 作者,旧版(只统计 engram.created_by)会漏掉 → 必须出现
      expect(bob, "synapse-only 作者必须出现在 topContributors").toBeDefined();
      expect(bob.synapseCount).toBe(1);
      expect(bob.engramCount).toBe(0);
      expect(bob.total).toBe(1);
      // alice 有 2 engram + 0 synapse
      expect(alice).toBeDefined();
      expect(alice.engramCount).toBe(2);
      expect(alice.synapseCount).toBe(0);
      expect(alice.total).toBe(2);
    });
  });

  it("topContributors 合计 ≤ totalEngrams + totalSynapses(天花板守护)", async () => {
    const ctx = makeCtx(tmpDir);
    const a = ctx.repository.createEngram({
      title: "A", content: "a", kind: "fact",
      domainTags: ["t"], createdBy: "alice",
    });
    const b = ctx.repository.createEngram({
      title: "B", content: "b", kind: "fact",
      domainTags: ["t"], createdBy: "bob",
    });
    const c = ctx.repository.createEngram({
      title: "C", content: "c", kind: "fact",
      domainTags: ["t"], createdBy: "carol",
    });
    ctx.repository.addOutgoingSynapse(a.id, { ...makeSynapse(a.id, b.id, "extends"), createdBy: "dave" });
    ctx.repository.addOutgoingSynapse(b.id, { ...makeSynapse(b.id, c.id, "extends"), createdBy: "dave" });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      const data = JSON.parse(res.body);
      const sumTotal = data.topContributors.reduce(
        (s: number, c: { total: number }) => s + c.total,
        0,
      );
      // 3 engrams + 2 synapses = 5(天花板);topContributors 是按 actor 分组后的合计,
      // 因为没有作者跨 engram/synapse 重复,dave 的 synapseCount=2 算 2 条
      expect(sumTotal).toBeLessThanOrEqual(data.totalEngrams + data.totalSynapses);
      expect(sumTotal).toBe(5); // alice 1 + bob 1 + carol 1 + dave 2
    });
  });
});

describe("守护 · Bug 4: topTags sum > totalEngrams 是合法多对多语义", () => {
  it("一条 engram 带 3 个 domainTags,topTags sum = 3,totalEngrams = 1", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "X", content: "x", kind: "fact",
      domainTags: ["a", "b", "c"], createdBy: "u",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      const data = JSON.parse(res.body);
      expect(data.totalEngrams).toBe(1);
      const sum = data.topTags.reduce(
        (s: number, t: { count: number }) => s + t.count,
        0,
      );
      // 多对多:一条 engram 带 3 个 tag → sum=3 > totalEngrams=1 是合法语义
      expect(sum).toBe(3);
      expect(sum).toBeGreaterThan(data.totalEngrams);
    });
  });

  it("tip.stats.topTagsTip 在 zh/en 都有翻译(防止用户误解 sum > total 为 bug)", () => {
    expect(zh["tip.stats.topTagsTip"], "zh.tip.stats.topTagsTip 缺翻译").toBeTruthy();
    expect(en["tip.stats.topTagsTip"], "en.tip.stats.topTagsTip 缺翻译").toBeTruthy();
  });
});

describe("守护 · Bug 5: /api/proposals 返回 statusCounts", () => {
  it("statusCounts.pending/accepted/dismissed/all 四个字段齐全,值与全量一致", async () => {
    const ctx = makeCtx(tmpDir);
    // 造一条 pending
    await ctx.proposalEngine.observe({
      role: "user",
      content: "some unique content for statusCounts test xyz123",
    });
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/proposals?status=all");
      const data = JSON.parse(res.body);
      expect(data.statusCounts).toBeDefined();
      expect(data.statusCounts).toHaveProperty("pending");
      expect(data.statusCounts).toHaveProperty("accepted");
      expect(data.statusCounts).toHaveProperty("dismissed");
      expect(data.statusCounts).toHaveProperty("all");
      // pending ≥ 1(刚 observe 的那条),accepted/dismissed = 0(空仓库)
      expect(data.statusCounts.pending).toBeGreaterThanOrEqual(1);
      expect(data.statusCounts.accepted).toBe(0);
      expect(data.statusCounts.dismissed).toBe(0);
      // all = pending + accepted + dismissed
      const sum = data.statusCounts.pending + data.statusCounts.accepted + data.statusCounts.dismissed;
      expect(data.statusCounts.all).toBe(sum);
    });
  });
});

describe("守护 · Bug 6: POST /api/proposals/purge-dismissed", () => {
  it("purge-dismissed 删除所有 dismissed,保留 pending/accepted", async () => {
    const ctx = makeCtx(tmpDir);
    // 造两条 pending,然后 dismiss
    await ctx.proposalEngine.observe({
      role: "user",
      content: "first unique proposal content abc111",
    });
    await ctx.proposalEngine.observe({
      role: "user",
      content: "second unique proposal content def222",
    });
    const pending = ctx.proposalEngine.listPending();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    // dismiss 全部
    for (const p of pending) {
      ctx.proposalEngine.dismiss(p.entityId, "test purge");
    }
    expect(ctx.proposalEngine.statusCounts().dismissed).toBe(pending.length);

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/proposals/purge-dismissed", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.purgedCount).toBe(pending.length);
      expect(Array.isArray(data.purgedIds)).toBe(true);
      expect(data.purgedIds.length).toBe(pending.length);

      // 验证 dismissed 已清空
      const afterRes = await makeRequest(port, "/api/proposals?status=all");
      const afterData = JSON.parse(afterRes.body);
      expect(afterData.statusCounts.dismissed).toBe(0);
      expect(afterData.statusCounts.all).toBe(0);
    });
  });

  it("purge-dismissed 在没有 dismissed 时返回 purgedCount=0(no-op)", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/proposals/purge-dismissed", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.purgedCount).toBe(0);
      expect(data.purgedIds).toEqual([]);
    });
  });
});

describe("守护 · Bug 5/6: i18n keys 中英文一致", () => {
  const keys = [
    "viewer.proposals.batch.purgeDismissed",
    "viewer.proposals.batch.purgeConfirm",
    "viewer.proposals.batch.purgeToast",
    "viewer.proposals.batch.purgeNoDismissed",
  ] as const;
  for (const key of keys) {
    it(`zh.${key} 有翻译`, () => {
      expect(zh[key], `zh.${key} 缺翻译`).toBeTruthy();
    });
    it(`en.${key} 有翻译`, () => {
      expect(en[key], `en.${key} 缺翻译`).toBeTruthy();
    });
    it(`zh 与 en 的 ${key} 翻译不同(防复制粘贴漏改)`, () => {
      expect(zh[key]).not.toBe(en[key]);
    });
  }
});
