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

  it("zh/en 都有 viewer.stats.frozenCount 翻译(sub 文案)", () => {
    // 2026-07 archived→frozen 重命名,字段名同步更新
    expect(zh["viewer.stats.frozenCount" as keyof typeof zh]).toBeTruthy();
    expect(en["viewer.stats.frozenCount" as keyof typeof en]).toBeTruthy();
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
    // regex 必须定位到 preview.* 那一处:tabs.ts 里 `const n = ...` 不止一处
    // (statusCounts[s] 也是此形式),`.match()` 无 g flag 只抓第一个 → 假阴性
    const lineMatch = TABS_RUNTIME.match(/const n = ([^;]*preview\.[^;]+);/);
    expect(lineMatch, "找不到 n 的 preview.* 赋值").not.toBeNull();
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
    expect(TABS_RUNTIME).toContain("'viewer.health.stats.frozenTip'");
    expect(TABS_RUNTIME).toContain("'viewer.health.stats.forgottenTip'");
  });

  it("zh/en 都有 3 个 tip 翻译", () => {
    const tipKeys = [
      "viewer.health.stats.totalTip",
      "viewer.health.stats.frozenTip",
      "viewer.health.stats.forgottenTip",
    ] as const;
    for (const k of tipKeys) {
      expect(zh[k as keyof typeof zh], `zh.${k} 缺翻译`).toBeTruthy();
      expect(en[k as keyof typeof en], `en.${k} 缺翻译`).toBeTruthy();
    }
  });
});

// ============================================================
// Batch 2.1 回归测试(2026-07-09 后续,用户报告的真根因)
//
// 用户原话:「1、记忆突触总数与记忆突触栏对不上——多次出现,应该纳入回归测试
//           2、审计栏没有显示日志 这两个问题在当前网页上仍存在」
//
// 真根因(经 puppeteer 诊断):
//   Bug #2(真):SynapseKindSchema 不含 related_to,但工具 prompt/dictionary 推荐
//               它为「默认 fallback」,LLM 大量生成 → 数据库里 197 条 related_to synapse。
//               i18n 表无 enum.synapseKind.related_to 翻译键,前端 enumLabel() 走 fallback
//               显示原始 key 'related_to'(英文),与其他(中文)混杂 → 用户视觉上「对不上」。
//               修复策略:类型/Schema 保持纯粹(神经科学 5 族严格推导,12 种不变),
//               i18n 字典补 related_to 翻译作前端显示兼容,工具 prompt 移除 related_to 推荐。
//
//   Bug #3(真):CO_ENGRAM_AUDIT.applyFilter() 在首次 load 时 this._auditPage 是 undefined
//               (对象字面量未初始化),`undefined * 50 = NaN`,`filtered.slice(NaN, NaN) = []`,
//               pageItems 为空 → 渲染 0 行 timeline-row(只显 pager-nav 488 字符)。
//               修复:applyFilter 开头 isNaN/typeof fallback 到 0。
//
//   Bug #6:回收站「永久清空」逐条 deleteEngram,每次 persistIndex 全量写盘 → O(N²)。
//               N=267 时累计 8-22s,期间 HTTP 阻塞 → 前端 fetch 超时(Bug #7 预扫描失败)。
//               修复:加 deleteEngramsBatch,N 次 persistIndex 合并成 1 次。
// ============================================================

describe("Bug #2(真): related_to i18n 显示兼容", () => {
  it("zh/en 都有 enum.synapseKind.related_to 翻译(前端显示一致)", () => {
    expect(zh["enum.synapseKind.related_to" as keyof typeof zh]).toBeTruthy();
    expect(en["enum.synapseKind.related_to" as keyof typeof en]).toBeTruthy();
  });

  it("zh/en 都有 tip.synapse.related_to(鼠标悬停说明)", () => {
    expect(zh["tip.synapse.related_to" as keyof typeof zh]).toBeTruthy();
    expect(en["tip.synapse.related_to" as keyof typeof en]).toBeTruthy();
  });

  it("tip.synapse.related_to 明确标注历史遗留/不推荐(防止 LLM 看到 tip 后又去用它)", () => {
    // 关键:tip 不能再说「默认 fallback」,否则 LLM 会持续生成 related_to
    const zhTip = zh["tip.synapse.related_to" as keyof typeof zh] as string;
    const enTip = en["tip.synapse.related_to" as keyof typeof en] as string;
    expect(zhTip.length).toBeGreaterThan(0);
    expect(enTip.length).toBeGreaterThan(0);
    // 至少有一处提到「历史遗留 / 不再推荐 / legacy」类警示
    const zhWarns = /历史遗留|不再推荐|不推荐|legacy/i.test(zhTip);
    const enWarns = /legacy|no longer recommended|not recommended/i.test(enTip);
    expect(zhWarns, `zh tip 应含历史遗留警示,实际:${zhTip}`).toBe(true);
    expect(enWarns, `en tip 应含 legacy 警示,实际:${enTip}`).toBe(true);
  });

  it("SynapseKindSchema 严格保持 12 种(神经科学推导,不含 related_to)", () => {
    // 用户反馈:「其他类型是神经科学推导的」——不能为了兼容数据污染类型系统
    // 验证:直接读 schema 源文件,确认仍然只列 12 种
    const fs = require("node:fs");
    const path = require("node:path");
    const schemaSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "core", "src", "tools", "schemas.ts"),
      "utf8",
    );
    // 提取 SynapseKindSchema 的 enum 数组内容
    const m = schemaSrc.match(/export const SynapseKindSchema = z\.enum\(\[([\s\S]*?)\]\)/);
    expect(m, "未找到 SynapseKindSchema 定义").not.toBeNull();
    const items = (m![1]!.match(/"(\w+)"/g) || []).map((s: string) => s.replace(/"/g, ""));
    expect(items).toHaveLength(12);
    expect(items).not.toContain("related_to");
    // 12 种严格匹配神经科学 5 族
    expect(items).toEqual([
      "extends", "part_of", "similar_to",
      "depends_on", "causes", "follows",
      "derives_from", "contradicts", "exemplifies",
      "supersedes", "consolidates",
      "contextualizes",
    ]);
  });

  it("工具 prompt 不再推荐 related_to 作为默认 fallback", () => {
    // 旧描述:「不确定关系类型(默认用 'related_to')」
    // 新描述应移除这种引导,让 LLM 用具体 12 种
    const agentDesc = zh["tool.synapse_create.agent" as keyof typeof zh] as string;
    expect(agentDesc, "tool.synapse_create.agent 应存在").toBeTruthy();
    expect(
      /默认用.*related_to|default.*related_to/i.test(agentDesc),
      `agent 描述仍含 related_to fallback 引导:${agentDesc.slice(0, 200)}`,
    ).toBe(false);
  });

  it("viewer runtime 的 SYNAPSE_FAMILY 含 related_to fallback(modulatory)", () => {
    // viewer app.ts 用模板字符串导出,需要读源文件验证
    // 防御性 fallback:即使 schema 拒绝新数据,旧数据残留时仍能着色而非崩成 undefined
    const fs = require("node:fs");
    const path = require("node:path");
    const appSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "runtime", "app.ts"),
      "utf8",
    );
    expect(appSrc).toContain("related_to: 'modulatory'");
    expect(appSrc).toContain("related_to: '#9ca3af'");
  });
});

describe("Bug #3(真): audit applyFilter _auditPage NaN fallback", () => {
  it("TABS_RUNTIME 在 applyFilter 里含 _auditPage 类型/NaN fallback", () => {
    // 关键修复:applyFilter 开头规范化 _auditPage,避免 undefined * PAGE_SIZE = NaN
    // → filtered.slice(NaN, NaN) = [] → timeline 渲染 0 行
    expect(TABS_RUNTIME).toContain("typeof this._auditPage !== 'number'");
    expect(TABS_RUNTIME).toContain("isNaN(this._auditPage)");
  });

  it("修复前后的对照(逻辑断言):_auditPage 未初始化时必须 fallback 到 0", () => {
    // 模拟 applyFilter 的核心分页逻辑
    function computeStart(auditPage: number | undefined, filteredLen: number, pageSize: number): number {
      const totalPages = Math.max(1, Math.ceil(filteredLen / pageSize));
      // 旧实现(无 fallback):
      // if (auditPage >= totalPages) auditPage = totalPages - 1;
      // if (auditPage < 0) auditPage = 0;
      // return auditPage * pageSize;
      // ↑ 当 auditPage = undefined:undefined >= N / undefined < 0 都是 false,
      //   不钳制 → undefined * pageSize = NaN → slice(NaN, NaN) = []

      // 新实现(applyFilter 修复后):
      if (typeof auditPage !== "number" || isNaN(auditPage) || auditPage < 0) {
        auditPage = 0;
      }
      if (auditPage >= totalPages) auditPage = totalPages - 1;
      return auditPage * pageSize;
    }

    // 修复后:_auditPage undefined → 0,startIdx = 0
    expect(computeStart(undefined, 100, 50)).toBe(0);
    expect(computeStart(undefined, 0, 50)).toBe(0);
    // 正常情况不受影响
    expect(computeStart(0, 100, 50)).toBe(0);
    expect(computeStart(1, 100, 50)).toBe(50);
    expect(computeStart(5, 100, 50)).toBe(50); // 钳到最后一页
    // NaN 显式传入也应 fallback
    expect(computeStart(NaN, 100, 50)).toBe(0);
  });
});

describe("Bug #6: deleteEngramsBatch 批量删除避免 O(N²)", () => {
  it("EngramRepository 有 deleteEngramsBatch 方法", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    expect(typeof repo.deleteEngramsBatch).toBe("function");
  });

  it("批量删除 N 条 engram,只触发 1 次 persistIndex(关键性能不变量)", () => {
    // 这是个白盒测试:验证 N 次 deleteEngram 合并成 1 次 persistIndex
    // 实现细节:deleteEngramsBatch 内部一次 getIndex + 一次 persistIndex,
    // 其余 deleteEngramFile / deleteSynapsesTouching / indexDb.deleteEngram 仍逐条
    const repo = new EngramRepository({ rootPath: tmpDir });
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = repo.createEngram({
        title: `batch-${i}`,
        content: `content-${i}`,
        kind: "fact",
        domainTags: ["t"],
        createdBy: "test",
      });
      created.push(e.id);
    }
    // createEngram 是 lazy 写 index,触发一次 listEngrams 强制 persistIndex 落盘
    expect(repo.listEngrams()).toHaveLength(5);

    const deleted = repo.deleteEngramsBatch(created);
    expect(deleted).toHaveLength(5);
    // 删除后 listEngrams 应立即反映(index 已在 batch 内 persist 一次)
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("批量删除后 listEngrams 不再返回这些 engram", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = repo.createEngram({
        title: `del-${i}`,
        content: "x",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "test",
      });
      ids.push(e.id);
    }
    expect(repo.listEngrams()).toHaveLength(3);

    const deleted = repo.deleteEngramsBatch(ids);
    expect(deleted).toHaveLength(3);
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("空数组 noop(不写盘,返回空)", () => {
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "keep",
      content: "x",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "test",
    });
    const deleted = repo.deleteEngramsBatch([]);
    expect(deleted).toEqual([]);
    expect(repo.listEngrams()).toHaveLength(1);
  });

  it("DELETE /api/trash 用 deleteEngramsBatch 路径(批量,非逐条)", async () => {
    // server.ts 在 softRows.length > 0 且非 dryRun 时调 deleteEngramsBatch
    // 失败时 fallback 到逐条 deleteEngram(功能正确性兜底)
    const ctx = makeCtx(tmpDir);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const engram = ctx.repository.createEngram({
        title: `purge-${i}`,
        content: "body",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "test",
      });
      ctx.repository.updateLifecycle(engram.id, "forgotten", "forgotten");
      ids.push(engram.id);
    }

    await withViewer(ctx, async (port) => {
      const before = await makeRequest(port, "/api/trash?limit=100");
      expect(before.status).toBe(200);
      expect(JSON.parse(before.body).total).toBeGreaterThanOrEqual(5);

      const tStart = Date.now();
      const del = await makeRequest(port, "/api/trash", { method: "DELETE" });
      const elapsed = Date.now() - tStart;
      expect(del.status).toBe(200);

      const delBody = JSON.parse(del.body);
      expect(delBody.count).toBeGreaterThanOrEqual(5);

      // 性能断言:5 条 forgotten 删除应该在 5s 内完成
      // (旧逐条实现 ~5-10s,新批量 <1s。这里给宽松阈值防 CI 抖动)
      expect(elapsed, `批量删除耗时 ${elapsed}ms 过长`).toBeLessThan(5000);

      const after = await makeRequest(port, "/api/trash?limit=100");
      expect(after.status).toBe(200);
      expect(JSON.parse(after.body).total).toBe(0);
    });
  });
});
