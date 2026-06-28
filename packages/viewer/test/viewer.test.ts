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
  type Synapse,
  type SynapseKind,
  type SynapseDirection,
} from "@co-engram/core";
import { startViewerServer, renderSpaHtml } from "../src/index.js";

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
  const runtime = await startViewerServer(ctx, {
    port: nextPort(),
    ...(options?.token ? { token: options.token } : {}),
    ...(options?.language ? { language: options.language } : {}),
    ...(options?.dataRoot ? { dataRoot: options.dataRoot } : {}),
  });
  try {
    return await fn(runtime.port);
  } finally {
    await runtime.stop();
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
      emotionalValence: "neutral" as const,
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
      decayHalfLifeDays: 90,
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
  it("空仓库返回空报告", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/doctor");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.enabled).toBe(true);
      expect(data.report.totalEngrams).toBe(0);
      expect(data.report.fixes).toEqual([]);
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
// PUT /api/config — desiredDataRoot 字段已移除(改由 CLI co-engram config data-root 管理)
// 旧的 desiredDataRoot 同步测试随之移除。dataRoot 改为只读字段,
// 由 ~/.co-engram/config.json 引导配置 + co-engram config data-root CLI 命令管理。
// ============================================================

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
