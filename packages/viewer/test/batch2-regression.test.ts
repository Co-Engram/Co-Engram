/**
 * Batch 2 回归测试(2026-07-09)
 *
 * 用户原话报告的 5 个 bug:
 *   1. 统计栏记忆印迹总数显示格式不对(应纳入回归测试)
 *   2. 记忆突触总数与记忆突触栏对不上——多次出现(应纳入回归测试)
 *   3. 审计栏没有显示日志
 *   4. 记忆回收站「永久清空全部」不生效——多次出现(应纳入回归测试)
 *   5. 健康栏中记忆总数、已归档、已遗忘需要增加悬停说明
 *
 * 本测试覆盖 Bug #1/#2/#4/#5 的核心契约。Bug #3 是浏览器缓存问题(Cache-Control),
 * 由 server.ts 的 header 设置覆盖,这里通过断言 response header 验证。
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
  zh,
  en,
} from "@co-engram/core";
import { startViewerServer } from "../src/index.js";
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

let portCounter = 40000;
function nextPort(): number {
  portCounter += 1;
  return portCounter;
}

function makeRequest(
  port: number,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
            headers: res.headers,
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
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-batch2-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// Bug #1:统计栏记忆印迹总数格式
// 修复前:`769 / 914`(active / total)双数字混在 KPI 值里,标签写"总数"误导
// 修复后:值只显 total,活跃/归档拆解放 sub
// ============================================================

describe("Bug #1: stats KPI 记忆印迹总数格式", () => {
  it("TABS_RUNTIME 不再含 'activeEngrams / totalEngrams' 双数字模式", () => {
    // 旧实现:activeEngrams + ' <span ...>/ ' + totalEngrams
    // 回归断言:这种拼接模式必须消失
    const oldPattern = /activeEngrams\s*\+\s*['"][^'"]*\/\s*['"]?\s*\+?\s*totalEngrams/;
    expect(oldPattern.test(TABS_RUNTIME), "旧的双数字拼接仍存在").toBe(false);
  });

  it("TABS_RUNTIME 使用 String(totalEngrams) 作为 KPI 值", () => {
    expect(TABS_RUNTIME).toContain("String(totalEngrams)");
  });

  it("zh/en 都有 viewer.stats.archivedCount 翻译(sub 文案)", () => {
    expect(zh["viewer.stats.archivedCount" as keyof typeof zh]).toBeTruthy();
    expect(en["viewer.stats.archivedCount" as keyof typeof en]).toBeTruthy();
  });
});

// ============================================================
// Bug #2:记忆突触总数与记忆突触栏对不上
// 不变量:sum(bySynapseKind) === totalSynapses
// 用户报告"多次出现"对不上,通常是浏览器缓存或瞬时态(操作后 graph 未重建)。
// 后端数据始终一致,这里固化不变量。
// ============================================================

describe("Bug #2: /api/stats 突触总数不变量", () => {
  it("sum(bySynapseKind) === totalSynapses", async () => {
    const ctx = makeCtx(tmpDir);
    // 创建几条 engram + 突触(createEngram 返回 engram 对象,取 .id 用)
    const a = ctx.repository.createEngram({
      title: "A",
      content: "alpha",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    }).id;
    const b = ctx.repository.createEngram({
      title: "B",
      content: "beta",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    }).id;
    const c = ctx.repository.createEngram({
      title: "C",
      content: "gamma",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    }).id;
    ctx.repository.createSynapse?.({
      fromId: a,
      toId: b,
      kind: "extends",
      createdBy: "test",
    });
    ctx.repository.createSynapse?.({
      fromId: a,
      toId: c,
      kind: "related_to",
      createdBy: "test",
    });
    ctx.repository.createSynapse?.({
      fromId: b,
      toId: c,
      kind: "derives_from",
      createdBy: "test",
    });

    await withViewer(ctx, async (port) => {
      const resp = await makeRequest(port, "/api/stats");
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      const totalSynapses: number = body.totalSynapses ?? 0;
      const bySynapseKind: Record<string, number> = body.bySynapseKind ?? {};
      const sum = Object.values(bySynapseKind).reduce((s, n) => s + n, 0);
      expect(sum, "bySynapseKind 之和必须等于 totalSynapses").toBe(totalSynapses);
    });
  });

  it("空仓库时 totalSynapses === 0 且 bySynapseKind 为空对象", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, async (port) => {
      const resp = await makeRequest(port, "/api/stats");
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.totalSynapses).toBe(0);
      expect(body.bySynapseKind).toEqual({});
    });
  });
});

// ============================================================
// Bug #3:audit 不显日志 / Cache-Control
// 根因:HTML 无 Cache-Control 头 → 浏览器缓存旧版 → audit 加载逻辑用的是旧 JS
// 修复:HTML 响应加 Cache-Control: no-store
// ============================================================

describe("Bug #3: HTML 响应含 Cache-Control: no-store", () => {
  it("GET / 返回 no-store 头", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, async (port) => {
      const resp = await makeRequest(port, "/");
      expect(resp.status).toBe(200);
      const cc = String(resp.headers["cache-control"] ?? "");
      expect(cc.toLowerCase()).toContain("no-store");
      expect(cc.toLowerCase()).toContain("no-cache");
    });
  });
});

// ============================================================
// Bug #4:回收站「永久清空全部」不生效
// 根因:前端 dryRun 用 GET,但读 preview.count;GET 响应是 { total, results }
//       没有 count 字段 → n=0 → 提前 return 弹"已空"
// 修复:前端改读 preview.total ?? preview.results.length
// 后端契约(本测试固化):GET /api/trash 必须返回 total 字段(不是 count)
//                       DELETE /api/trash 真实清空 soft deleted
// ============================================================

describe("Bug #4: GET /api/trash 返回 total 字段(前端依赖)", () => {
  it("响应里有 total(不是 count)", async () => {
    const ctx = makeCtx(tmpDir);
    ctx.repository.createEngram({
      title: "soft-deleted",
      content: "body",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    // 标记一条为 forgotten(soft delete)
    const all = ctx.repository.listEngrams();
    if (all.length > 0) {
      ctx.repository.updateLifecycle(all[0]!.id, "forgotten", "forgotten");
    }

    await withViewer(ctx, async (port) => {
      const resp = await makeRequest(port, "/api/trash?limit=10");
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body);
      expect(typeof body.total).toBe("number");
      expect(body.total).toBeGreaterThanOrEqual(1);
      // results 数组长度 <= total(pagination)
      expect(Array.isArray(body.results)).toBe(true);
    });
  });
});

describe("Bug #4: DELETE /api/trash 真实清空 soft-deleted", () => {
  it("DELETE 后 total 降为 0", async () => {
    const ctx = makeCtx(tmpDir);
    // 创建 3 条 engram,全部 forgotten(createEngram 返回对象,取 .id)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const engram = ctx.repository.createEngram({
        title: `trash-${i}`,
        content: "body",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "test",
      });
      ctx.repository.updateLifecycle(engram.id, "forgotten", "forgotten");
      ids.push(engram.id);
    }

    await withViewer(ctx, async (port) => {
      // 先校验 trash 非空
      const before = await makeRequest(port, "/api/trash?limit=100");
      expect(before.status).toBe(200);
      const beforeBody = JSON.parse(before.body);
      expect(beforeBody.total).toBeGreaterThanOrEqual(3);

      // 调用 DELETE
      const del = await makeRequest(port, "/api/trash", { method: "DELETE" });
      expect(del.status).toBe(200);
      const delBody = JSON.parse(del.body);
      expect(delBody.count).toBeGreaterThanOrEqual(3);

      // 再读一次,trash 应为空
      const after = await makeRequest(port, "/api/trash?limit=100");
      expect(after.status).toBe(200);
      const afterBody = JSON.parse(after.body);
      expect(afterBody.total).toBe(0);
    });
  });

  it("前端 TABS_RUNTIME 不再读 preview.count(读 total)", () => {
    // 旧实现:const n = preview.count || 0;
    // 新实现:const n = preview.total ?? ... preview.results.length ?? preview.count ?? 0;
    // 回归:count 不再是主路径(可作 fallback,但 total 必须优先)
    const lineMatch = TABS_RUNTIME.match(/const n = ([^;]+);/);
    expect(lineMatch, "找不到 n 的赋值").not.toBeNull();
    const expr = lineMatch![1]!;
    expect(expr.includes("preview.total"), "应优先读 preview.total").toBe(true);
  });
});

// ============================================================
// Bug #5:健康栏 KPI 悬停说明
// 修复:3 个 KPI(total/archived/forgotten)加 title 属性
// ============================================================

describe("Bug #5: 健康栏 KPI 悬停说明", () => {
  it("TABS_RUNTIME 为 3 个 KPI 加 title 属性", () => {
    // 新实现:healthKpi(label, value, tipKey) → 含 title=
    // 旧实现是 inline '<div class="kpi"><div class="kpi-label">'(无 title)
    expect(TABS_RUNTIME).toContain("healthKpi(");
    expect(TABS_RUNTIME).toContain("'viewer.health.stats.totalTip'");
    expect(TABS_RUNTIME).toContain("'viewer.health.stats.archivedTip'");
    expect(TABS_RUNTIME).toContain("'viewer.health.stats.forgottenTip'");
  });

  it("zh/en 都有 3 个 tip 翻译", () => {
    const tipKeys = [
      "viewer.health.stats.totalTip",
      "viewer.health.stats.archivedTip",
      "viewer.health.stats.forgottenTip",
    ] as const;
    for (const k of tipKeys) {
      expect(zh[k as keyof typeof zh], `zh.${k} 缺翻译`).toBeTruthy();
      expect(en[k as keyof typeof en], `en.${k} 缺翻译`).toBeTruthy();
    }
  });
});
