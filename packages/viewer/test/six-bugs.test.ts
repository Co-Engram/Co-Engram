/**
 * 6 个 viewer bug 修复的集成验证(2026-07)
 *
 * 用户原话:
 *   1. 印迹栏目录点查看 → 无结果
 *   2. 突触栏目录过滤 → 无结果
 *   3. 提案「正在加载更多」文案误导
 *   4. 采纳提案 400
 *   5. 审计栏显示慢
 *   6. 缺批量采纳/驳回按钮
 *
 * 本测试既验证后端 API 行为(curl),也静态校验前端 runtime 字符串内的关键改动
 * (TABS_RUNTIME / GRAPH_RUNTIME 是 export const 字符串字面量,可直接断言)。
 * 不引入 headless 浏览器,降低 CI 依赖。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import {
  EngramRepository,
  SearchOrchestrator,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
} from "@co-engram/core";
import { startViewerServer } from "../src/index.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";

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

let portCounter = 30000;
function nextPort(): number {
  portCounter += 1;
  return portCounter;
}

function makeRequest(
  port: number,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const headers: http.OutgoingHttpHeaders = { connection: "close" };
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
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const port = nextPort();
  const savedEnv = process.env.CO_ENGRAM_VIEWER_PORT;
  process.env.CO_ENGRAM_VIEWER_PORT = String(port);
  try {
    const runtime = await startViewerServer(ctx, {});
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-six-bugs-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 问题 1 + 2:目录过滤失效(ULID id 无 '/')
// 修复:后端 /api/path-tree 响应里增加 engramLocations;前端用 Map 过滤
// ============================================================

describe("问题 1+2: /api/path-tree 返回 engramLocations", () => {
  it("响应里包含 engramLocations 数组,每条含 {id, path}", async () => {
    const ctx = makeCtx(tmpDir);
    // 创建一个有目录层级的 engram
    ctx.repository.createEngram({
      title: "test-environment",
      content: "adb connect serial",
      kind: "fact",
      domainTags: ["android"],
      pathHint: "android/environment.md",
      createdBy: "test",
      importance: 0.5,
    });
    ctx.repository.createEngram({
      title: "root-level",
      content: "no directory",
      kind: "fact",
      domainTags: ["misc"],
      createdBy: "test",
      importance: 0.5,
    });

    await withViewer(ctx, async (port) => {
      const resp = await makeRequest(port, "/api/path-tree?maxDepth=8");
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.enabled).toBe(true);
      expect(Array.isArray(body.engramLocations)).toBe(true);
      expect(body.engramLocations.length).toBeGreaterThanOrEqual(2);
      // 每条结构正确
      for (const loc of body.engramLocations) {
        expect(typeof loc.id).toBe("string");
        expect(typeof loc.path).toBe("string");
      }
      // 至少有一条 path 含 '/',证明 path 字段是相对路径(非 ULID)
      const hasDirEntry = body.engramLocations.some(
        (l: { path: string }) => l.path.includes("/"),
      );
      expect(hasDirEntry).toBe(true);
    });
  });
});

// ============================================================
// 问题 3:proposals 加载文案误导
// 修复:新增 i18n key viewer.proposals.pager.hasMoreHint
// ============================================================

describe("问题 3: proposals hasMoreHint 文案", () => {
  it("TABS_RUNTIME 引用新 i18n key 而非 engrams.pager.loadingHint", () => {
    // 修复后 line 1000 用 viewer.proposals.pager.hasMoreHint
    expect(TABS_RUNTIME).toContain("viewer.proposals.pager.hasMoreHint");
    // proposals tab header 不应再用 engrams.pager.loadingHint(chip 文案不再误导)
    // 注:engrams tab 仍用它,但 proposals tab 不应复用,检查 proposals 渲染分支
    const proposalsSection = TABS_RUNTIME.split(
      "已加载 ' + items.length + ' / 共 ' + total",
    )[1];
    expect(proposalsSection).toBeDefined();
    expect(proposalsSection!.startsWith(" + (hasMore ? ' · ' + CO_ENGRAM.escapeHtml(T.t('viewer.proposals.pager.hasMoreHint'")).toBe(true);
  });
});

// ============================================================
// 问题 4:accept 失败(空数组不回落)
// 修复:proposal-engine.ts accept 兜底语义改为「非空生效,否则回落」
// ============================================================

describe("问题 4: accept 空数组兜底", () => {
  it("auto-memory proposal + 全部空字段 → 应成功回落到 payload", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.proposalEngine.proposeAutoMemory({
      slug: "fallback-test",
      title: "fallback title",
      content: "fallback body",
      domainTags: ["auto-memory-fallback"],
      kind: "observation",
      createdBy: "claude-code-auto-memory",
    });

    await withViewer(ctx, async (port) => {
      // 模拟前端:所有字段都空,依赖后端 payload 兜底
      const resp = await makeRequest(
        port,
        "/api/proposals/am:fallback-test/accept",
        { method: "POST", body: {} },
      );
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.ok).toBe(true);
      expect(typeof body.engramId).toBe("string");
    });
  });

  it("auto-memory proposal + 显式空数组 domainTags → 也应回落(关键回归)", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.proposalEngine.proposeAutoMemory({
      slug: "empty-array-test",
      title: "real title",
      content: "real body",
      domainTags: ["real-tag"],
      kind: "observation",
      createdBy: "claude-code-auto-memory",
    });

    await withViewer(ctx, async (port) => {
      // 模拟前端 acceptFromForm:domainTags 传 [](空数组)
      const resp = await makeRequest(
        port,
        "/api/proposals/am:empty-array-test/accept",
        { method: "POST", body: { title: "", content: "", domainTags: [] } },
      );
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.ok).toBe(true);
    });
  });
});

// ============================================================
// 问题 5:audit 慢
// 修复:applyFilter 加 timing instrument + _existingIds 提到外层
// ============================================================

describe("问题 5: audit tab timing instrument", () => {
  it("TABS_RUNTIME 包含 audit-timing chip 与 timing 测量逻辑", () => {
    // 新增的 chip 元素
    expect(TABS_RUNTIME).toContain('id="audit-timing"');
    // 三段 timing 测量变量
    expect(TABS_RUNTIME).toContain("tFiltered");
    expect(TABS_RUNTIME).toContain("tRendered");
    expect(TABS_RUNTIME).toContain("filter ");
    expect(TABS_RUNTIME).toContain("render ");
    expect(TABS_RUNTIME).toContain("DOM ");
  });

  it("renderRow 接受 existingIds 参数(避免每行 new Set)", () => {
    // renderRow 签名从 2 参数变为 3 参数
    expect(TABS_RUNTIME).toMatch(
      /renderRow\(e,\s*ACTOR_LETTER,\s*existingIds\)/,
    );
  });
});

// ============================================================
// 问题 6:批量采纳/驳回按钮
// 修复:proposals tab header 新增 batchBtns + acceptAllLoaded / dismissAllLoaded 方法
// ============================================================

describe("问题 6: 批量采纳/驳回", () => {
  it("TABS_RUNTIME 包含批量按钮 + 方法", () => {
    expect(TABS_RUNTIME).toContain(
      "viewer.proposals.batch.acceptAll",
    );
    expect(TABS_RUNTIME).toContain(
      "viewer.proposals.batch.dismissAll",
    );
    expect(TABS_RUNTIME).toContain("acceptAllLoaded");
    expect(TABS_RUNTIME).toContain("dismissAllLoaded");
  });

  it("批量方法串行 accept 当前 visible 的 pending proposals", async () => {
    const ctx = makeCtx(tmpDir);
    // 创建 3 个 auto-memory proposal
    for (let i = 0; i < 3; i++) {
      ctx.proposalEngine.proposeAutoMemory({
        slug: `batch-${i}`,
        title: `batch title ${i}`,
        content: `batch body ${i}`,
        domainTags: [`tag-${i}`],
        kind: "observation",
        createdBy: "claude-code-auto-memory",
      });
    }

    await withViewer(ctx, async (port) => {
      // 模拟前端 acceptAllLoaded 串行调 accept(空 body 让后端兜底)
      const listResp = await makeRequest(port, "/api/proposals?status=pending");
      const list = JSON.parse(listResp.body);
      expect(list.results).toHaveLength(3);

      const results = [];
      for (const p of list.results) {
        const r = await makeRequest(
          port,
          `/api/proposals/${encodeURIComponent(p.entityId)}/accept`,
          { method: "POST", body: {} },
        );
        results.push(r.status);
      }
      // 全部 200(不是 400)
      expect(results.every((s) => s === 200)).toBe(true);

      // 验证全部转化为 engram
      const afterResp = await makeRequest(port, "/api/proposals?status=accepted");
      const after = JSON.parse(afterResp.body);
      expect(after.total).toBe(3);
    });
  });
});

// ============================================================
// 问题 1+2 前端验证:TABS_RUNTIME + GRAPH_RUNTIME 用 _engramLocations Map
// ============================================================

describe("问题 1+2: 前端 applyFilter 用 Map 过滤", () => {
  it("tabs.ts applyFilter 用 _engramLocations.get(id) 查 path", () => {
    // 不再用 id.startsWith(pathPrefix)
    expect(TABS_RUNTIME).toContain("CO_ENGRAM._engramLocations");
    expect(TABS_RUNTIME).toContain("locMap.get(e.id)");
    // 修复后的判断逻辑
    expect(TABS_RUNTIME).toContain(
      "ep !== pathPrefix && !ep.startsWith(pathPrefix + '/')",
    );
  });

  it("graph.ts matchesNodeFilters 用 _engramLocations 查 path", () => {
    expect(GRAPH_RUNTIME).toContain("CO_ENGRAM._engramLocations");
    expect(GRAPH_RUNTIME).toContain("locMap.get(n.id)");
  });

  it("graph.ts _refreshFilterCount 内联版同样用 Map(双处同步)", () => {
    expect(GRAPH_RUNTIME).toContain("locMap.get(n.id)");
    // 出现次数 ≥ 2(一处 matchesNodeFilters + 一处 _refreshFilterCount)
    const occurrences = GRAPH_RUNTIME.split("locMap.get(n.id)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
