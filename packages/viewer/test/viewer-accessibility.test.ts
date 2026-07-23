import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  writeTeamMemoryConfig,
} from "@co-engram/core";
import { startViewerServer } from "../src/index.js";

// ============================================================
// 回归测试:viewer 可访问性
//
// 起因:用户多次遇到"网页无法访问"——MCP 启动时若 18899(2026-07 起两宿主
// 统一默认端口;原 host-specific 默认 18799/18899 已弃用)已被孤儿进程
// 占用,MCP 会跳过 viewer 启动,用户浏览器访问就 503/ECONNREFUSED。
// 此测试集把"viewer 起得来 + HTML 关键标记齐全 + 关键端点可访问"
// 凝固成可执行的断言,CI/预发就能拦截类似回归。
// ============================================================

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-acc-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 端到端:viewer 启动 → HTML 可访问 → 关键端点工作
// 这是"网页无法访问"问题的核心防御:任何环节断了都 fail
// ============================================================

describe("viewer 可访问性端到端", () => {
  it("启动后 GET / 返回 200 + HTML + 关键内联 JS", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, { port });
    try {
      const res = await makeRequest(port, "/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");

      // DOCTYPE 必须存在(防 HTML 损坏)
      expect(res.body).toContain("<!DOCTYPE html>");

      // 体积合理(防 vendor 内联丢失)
      // ~1.1MB 完整 bundle;若某天变 50KB 说明 vendor 内联坏了
      expect(Buffer.byteLength(res.body)).toBeGreaterThan(50_000);

      // 关键 JS 入口存在(防 HTML 模板渲染回归)
      expect(res.body).toContain("CO_ENGRAM");
      expect(res.body).toContain("<script");

      // vis-network 内联存在(图表功能依赖)
      expect(res.body).toContain("vis-network");

      // marked + DOMPurify 内联(markdown 渲染依赖)
      expect(res.body).toContain("marked");
      expect(res.body).toContain("DOMPurify");
    } finally {
      await runtime.stop();
    }
  });

  it("启动后 GET /api/status 返回 200 + overall 字段(防孤儿进程返回坏 JSON)", async () => {
    // 复现孤儿进程场景:孤儿 viewer 占着端口但 /api/status 返回 garbage。
    // 这个测试断言:正常启动的 viewer 一定返回结构化 JSON。
    const ctx = makeCtx(tmpDir);
    await writeTeamMemoryConfig(tmpDir, {
      version: 1,
      language: "zh",
      defaultCreatedBy: "tester",
      createdAt: new Date().toISOString(),
      initializedBy: "test",
    });
    const port = nextPort();
    const runtime = await startViewerServer(ctx, {
      port,
      dataRoot: tmpDir,
    });
    try {
      const res = await makeRequest(port, "/api/status");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toBeTruthy();
      expect(typeof data.overall).toBe("string");
      expect(["ok", "warn", "error"]).toContain(data.overall);
      expect(data.dataRoot).toBe(tmpDir);
      expect(data.dataRootExists).toBe(true);
      expect(data.isEngramWarehouse).toBe(true);
      expect(Array.isArray(data.checks)).toBe(true);
      expect(data.checks.length).toBeGreaterThan(0);
    } finally {
      await runtime.stop();
    }
  });

  it("启动后所有关键端点都返回 2xx 或已知的 4xx(防端点漏注册)", async () => {
    const ctx = makeCtx(tmpDir);
    await writeTeamMemoryConfig(tmpDir, {
      version: 1,
      language: "zh",
      defaultCreatedBy: "tester",
      createdAt: new Date().toISOString(),
      initializedBy: "test",
    });
    const port = nextPort();
    const runtime = await startViewerServer(ctx, {
      port,
      dataRoot: tmpDir,
    });
    try {
      const endpoints: Array<{ path: string; expectStatus: number[] }> = [
        { path: "/", expectStatus: [200] },
        { path: "/api/status", expectStatus: [200] },
        { path: "/api/stats", expectStatus: [200] },
        { path: "/api/engrams", expectStatus: [200] },
        { path: "/api/graph", expectStatus: [200] },
        { path: "/api/path-tree", expectStatus: [200] },
        { path: "/api/doctor", expectStatus: [200] },
        { path: "/api/audit", expectStatus: [200] },
        { path: "/api/merge-stats", expectStatus: [200] },
        { path: "/api/merge-anomalies", expectStatus: [200] },
        { path: "/api/trash", expectStatus: [200] },
      ];
      for (const { path, expectStatus } of endpoints) {
        const res = await makeRequest(port, path);
        expect(
          expectStatus,
          `${path} 应返回 ${expectStatus.join("/")},实际 ${res.status}`,
        ).toContain(res.status);
      }
    } finally {
      await runtime.stop();
    }
  });
});

// ============================================================
// HTML 标记:engram-tab visibility filter
// 防 label/option 文案重复回归(tabs.ts:133 复制粘贴 bug)
// ============================================================

describe("HTML 标记:engram-tab visibility filter", () => {
  it("中文模式:visibility label = 可见性,option = 全部,gitIsolation tip 挂在 private option 上", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, { port, language: "zh" });
    try {
      const res = await makeRequest(port, "/");
      // 新 i18n key 已打包
      expect(res.body).toContain("viewer.engram.filter.visibility");
      expect(res.body).toContain("viewer.engram.filter.allVisibilities");
      expect(res.body).toContain("tip.engram.gitIsolation.teamScope");
      // 旧 key viewer.engram.filter.all 必须完全清除(带引号断言,避免 allVisibilities 子串误判)
      expect(res.body).not.toContain('"viewer.engram.filter.all"');
      // label 中文文案
      expect(res.body).toContain("可见性");
      // team option 新文案:团队可见(比单字「团队」更清晰)
      expect(res.body).toContain("团队可见");
    } finally {
      await runtime.stop();
    }
  });

  it("英文模式:visibility label = Visibility,option = All,team = Team-visible", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, { port, language: "en" });
    try {
      const res = await makeRequest(port, "/");
      expect(res.body).toContain("viewer.engram.filter.visibility");
      expect(res.body).not.toContain('"viewer.engram.filter.all"');
      expect(res.body).toContain("Visibility");
      expect(res.body).toContain("Team-visible");
    } finally {
      await runtime.stop();
    }
  });
});

// ============================================================
// HTML 标记:health-tab 一键提交功能
// 防 commit 端点 + health-tab JS 漏打包
// ============================================================

describe("HTML 标记:health-tab 一键提交", () => {
  it("HTML 包含 _healthCommitNow handler + i18n 键 + 立即提交按钮文案", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, {
      port,
      language: "zh",
    });
    try {
      const res = await makeRequest(port, "/");
      // JS handler 必须存在
      expect(res.body).toContain("_healthCommitNow");
      // i18n key 必须打包进 bundle
      expect(res.body).toContain("viewer.health.check.commitNow");
      expect(res.body).toContain("viewer.health.why.git_dirty_high");
      // 中文文案必须渲染
      expect(res.body).toContain("立即提交");
    } finally {
      await runtime.stop();
    }
  });

  it("英文模式下 HTML 包含 Commit now 按钮文案", async () => {
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, {
      port,
      language: "en",
    });
    try {
      const res = await makeRequest(port, "/");
      expect(res.body).toContain("_healthCommitNow");
      expect(res.body).toContain("Commit now");
    } finally {
      await runtime.stop();
    }
  });
});

// ============================================================
// POST /api/commit — 一键提交 engram 变更
// ============================================================

describe("POST /api/commit", () => {
  it("非 git 仓库返回 ok:false + error", async () => {
    const ctx = makeCtx(tmpDir);
    await writeTeamMemoryConfig(tmpDir, {
      version: 1,
      language: "zh",
      defaultCreatedBy: "tester",
      createdAt: new Date().toISOString(),
      initializedBy: "test",
    });
    const port = nextPort();
    const runtime = await startViewerServer(ctx, {
      port,
      dataRoot: tmpDir,
    });
    try {
      const res = await makeRequest(port, "/api/commit", {
        method: "POST",
        body: { message: "test" },
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(false);
      expect(typeof data.error).toBe("string");
    } finally {
      await runtime.stop();
    }
  });

  it("空 message 时使用默认 commit message", async () => {
    // 不传 message 或传空 → viewer 应回退到默认 message
    // 此处非 git 仓库,只验证请求能被处理不报 500
    const ctx = makeCtx(tmpDir);
    const port = nextPort();
    const runtime = await startViewerServer(ctx, { port });
    try {
      const res = await makeRequest(port, "/api/commit", {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      // ok=false 因为不是 git 仓库,但端点本身能正常处理
      expect(data).toBeTruthy();
      expect(typeof data.ok).toBe("boolean");
    } finally {
      await runtime.stop();
    }
  });
});

// ============================================================
// 孤儿端口场景:EADDRINUSE 时同端口重试(2026-07 根治端口漂移)
// 这是"网页无法访问"问题的根因防御:
// 如果 18899 被占(通常 failover 时旧 holder viewer 未关闭),viewer 应同端口
// 重试等释放,而不是漂移到别的端口(漂移会让客户端访问固定 18899 时找不到)
// ============================================================

describe("孤儿端口场景防御", () => {
  it("EADDRINUSE 时同端口重试,不漂移到别的端口", async () => {
    const port = nextPort();
    const occupier = await startViewerServer(makeCtx(tmpDir), { port });
    try {
      // 新行为:port 被占 → 同端口重试 → 耗尽 throw,不漂移到 port+1
      // (漂移会让客户端访问固定 18899 时找不到 viewer)
      await expect(
        startViewerServer(makeCtx(tmpDir), { port, maxRetries: 2 }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await occupier.stop();
    }
  });

  it("超过 maxRetries 次仍冲突时抛出错误(不能静默吞掉启动失败)", async () => {
    // 防回归:MCP 启动时若 viewer 始终起不来,必须抛出可见错误,
    // 而不是静默跳过(那是"网页无法访问"问题的根因)
    const port = nextPort();
    // 同端口重试:只需占住 port 一个(2026-07 起不再漂移到 port+1..port+5)
    const occupier = await startViewerServer(makeCtx(tmpDir), { port });
    try {
      // 同端口重试 maxRetries 次仍被占 → 抛出
      await expect(
        startViewerServer(makeCtx(tmpDir), { port, maxRetries: 3 }),
      ).rejects.toThrow();
    } finally {
      await occupier.stop();
    }
  });
});

// ============================================================
// 端口默认值:不指定 port 时使用统一默认 18899(2026-07 起两宿主共用)
// 注:已存在的 viewer.test.ts 覆盖了 EADDRINUSE 重试行为 + 端口绑定。
// 此处不再重复测端口探测,因为 CI/本地环境可能正好占着 18899,
// 触发 EADDRINUSE 重试后断言会 flaky。回归重点在 HTML 标记 + 端点访问。
// ============================================================
