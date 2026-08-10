/**
 * S6 Task 1: /api/skills 路由 + stats skill 维度测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";

import {
  EngramRepository,
  SkillRepository,
  SearchOrchestrator,
  AuditLog,
  EffectivenessTracker,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  type Skill,
  type AcquisitionStage,
  type RetentionStage,
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
  const skillRepository = new SkillRepository(tmpDir);
  return {
    repository,
    searchOrchestrator,
    auditLog,
    effectivenessTracker,
    proposalEngine,
    skillRepository,
  };
}

/** 分配一个非默认端口(避免和并发测试/真实 viewer 冲突)。
 *  跳过被外部进程(如 VS Code 端口转发)占用的端口,避免 EADDRINUSE 偶发失败。 */
let portCounter = 52000;
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
    if (portCounter > 60000) portCounter = 52001;
    if (await isPortFree(portCounter)) return portCounter;
  }
  throw new Error("No free port in viewer test range (52001-60000)");
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
  const port = await nextPort();
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

function createMockSkill(overrides: Partial<Skill> = {}): Skill {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    skillId: overrides.skillId ?? `skill-${randomUUID()}`,
    sourcePath: overrides.sourcePath ?? "/test/skill.md",
    contentHash: overrides.contentHash ?? "hash-" + randomUUID(),
    initiationSet: overrides.initiationSet ?? [],
    // A+ 透传:SKILL.md 原生字段(S6.x:termination/policy 已移除,改为可选的原生字段)
    ...(overrides.allowedTools ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides.skillVersion ? { skillVersion: overrides.skillVersion } : {}),
    utility: overrides.utility ?? 0.5,
    sampleSize: overrides.sampleSize ?? 0,
    invocationCount: overrides.invocationCount ?? 0,
    successCount: overrides.successCount ?? 0,
    failureCount: overrides.failureCount ?? 0,
    lastUsedAt: overrides.lastUsedAt ?? null,
    acquisitionStage: overrides.acquisitionStage ?? "draft",
    retentionStage: overrides.retentionStage ?? "active",
    visibility: overrides.visibility ?? "team",
    createdBy: overrides.createdBy ?? "tester",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    composes: overrides.composes ?? [],
    relatedEngrams: overrides.relatedEngrams ?? [],
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-skill-api-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// /api/skills
// ============================================================

describe("GET /api/skills", () => {
  it("返回空 skill 列表", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/skills");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.results).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.enabled).toBe(true);
    });
  });

  it("返回 skill 列表", async () => {
    const ctx = makeCtx(tmpDir);
    // 创建几个 skills
    const skill1 = createMockSkill({ skillId: "skill-1", acquisitionStage: "draft" });
    const skill2 = createMockSkill({ skillId: "skill-2", acquisitionStage: "compiled" });
    const skill3 = createMockSkill({ skillId: "skill-3", acquisitionStage: "tuned" });

    ctx.skillRepository.createSkill({
      skillId: skill1.skillId,
      sourcePath: skill1.sourcePath,
      initiationSet: skill1.initiationSet,
      createdBy: skill1.createdBy,
    });
    ctx.skillRepository.createSkill({
      skillId: skill2.skillId,
      sourcePath: skill2.sourcePath,
      initiationSet: skill2.initiationSet,
      acquisitionStage: "compiled",
      createdBy: skill2.createdBy,
    });
    ctx.skillRepository.createSkill({
      skillId: skill3.skillId,
      sourcePath: skill3.sourcePath,
      initiationSet: skill3.initiationSet,
      acquisitionStage: "tuned",
      createdBy: skill3.createdBy,
    });

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/skills");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.results).toHaveLength(3);
      expect(data.total).toBe(3);
      expect(data.enabled).toBe(true);
    });
  });

  it("支持 acquisitionStage 过滤", async () => {
    const ctx = makeCtx(tmpDir);

    // 默认情况下，所有 skills 都是 draft 阶段
    // A+ 透传验证:skill-1 带 allowedTools + skillVersion,确认原生字段穿透 createSkill
    ctx.skillRepository.createSkill({
      skillId: "skill-1",
      sourcePath: "/test/skill-1.md",
      initiationSet: [],
      allowedTools: ["Read", "Edit"],
      skillVersion: "1.0",
      createdBy: "tester",
    });

    ctx.skillRepository.createSkill({
      skillId: "skill-2",
      sourcePath: "/test/skill-2.md",
      initiationSet: [],
      createdBy: "tester",
    });

    await withViewer(ctx, undefined, async (port) => {
      // 默认都是 draft，所以 draft 过滤应该返回所有 skills
      const res = await makeRequest(port, "/api/skills?acquisitionStage=draft");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.results).toHaveLength(2);
      expect(data.total).toBe(2);

      // compiled 过滤应该返回空
      const res2 = await makeRequest(port, "/api/skills?acquisitionStage=compiled");
      expect(res2.status).toBe(200);
      const data2 = JSON.parse(res2.body);
      expect(data2.results).toHaveLength(0);
      expect(data2.total).toBe(0);
    });
  });

  it("支持 retentionStage 过滤", async () => {
    const ctx = makeCtx(tmpDir);

    // 默认情况下，新创建的 skills 都是 active retentionStage
    ctx.skillRepository.createSkill({
      skillId: "skill-active-1",
      sourcePath: "/test/active1.md",
      initiationSet: [],
      createdBy: "tester",
    });

    ctx.skillRepository.createSkill({
      skillId: "skill-active-2",
      sourcePath: "/test/active2.md",
      initiationSet: [],
      createdBy: "tester",
    });

    await withViewer(ctx, undefined, async (port) => {
      // 测试 active 过滤（应该返回至少 2 个）
      const res = await makeRequest(port, "/api/skills?retentionStage=active");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.total).toBeGreaterThanOrEqual(2);
    });
  });

  it("支持 limit 参数", async () => {
    const ctx = makeCtx(tmpDir);
    for (let i = 0; i < 10; i++) {
      ctx.skillRepository.createSkill({
        skillId: `skill-${i}`,
        sourcePath: `/test/skill-${i}.md`,
        initiationSet: [],
        createdBy: "tester",
      });
    }

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/skills?limit=3");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.results).toHaveLength(3);
      expect(data.total).toBe(10);
    });
  });
});

// ============================================================
// /api/skills/:id
// ============================================================

describe("GET /api/skills/:id", () => {
  it("返回 skill 详情", async () => {
    const ctx = makeCtx(tmpDir);
    const skill = createMockSkill({ skillId: "skill-1" });
    ctx.skillRepository.createSkill({
      skillId: skill.skillId,
      sourcePath: skill.sourcePath,
      initiationSet: skill.initiationSet,
      createdBy: skill.createdBy,
    });

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, `/api/skills/${encodeURIComponent(skill.skillId)}`);
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.skillId).toBe("skill-1");
      expect(data.acquisitionStage).toBe("draft");
      expect(data.retentionStage).toBe("active");
    });
  });

  it("skill 不存在时返回 404", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/skills/nonexistent");
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("Skill not found");
    });
  });
});

// ============================================================
// /api/stats skill 维度
// ============================================================

describe("GET /api/stats with skill 维度", () => {
  it("空仓库返回零 skill 统计", async () => {
    const ctx = makeCtx(tmpDir);
    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalSkills).toBe(0);
      expect(data.skillsByAcquisitionStage).toEqual({
        draft: 0,
        compiled: 0,
        tuned: 0,
      });
      expect(data.skillsByRetentionStage).toEqual({
        active: 0,
        aging: 0,
        stale: 0,
        forgotten: 0,
      });
    });
  });

  it("统计 skills 按阶段分布", async () => {
    const ctx = makeCtx(tmpDir);

    // 创建几个 skills（默认都是 draft 阶段）
    for (let i = 0; i < 3; i++) {
      ctx.skillRepository.createSkill({
        skillId: `skill-${i}`,
        sourcePath: `/test/skill-${i}.md`,
        initiationSet: [],
        createdBy: "tester",
      });
    }

    // 验证 skillRepository 确实创建了这些 skills
    expect(ctx.skillRepository.listSkills()).toHaveLength(3);

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalSkills).toBe(3);
      // 默认都是 draft
      expect(data.skillsByAcquisitionStage).toEqual({
        draft: 3,
        compiled: 0,
        tuned: 0,
      });
      // 默认都是 active
      expect(data.skillsByRetentionStage).toEqual({
        active: 3,
        aging: 0,
        stale: 0,
        forgotten: 0,
      });
    });
  });

  it("skillRepository 未注入时降级为全零统计", async () => {
    // 构造没有 skillRepository 的 ctx
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
    const ctx = {
      repository,
      searchOrchestrator,
      auditLog,
      effectivenessTracker,
      proposalEngine,
      // 故意不包含 skillRepository
    };

    await withViewer(ctx, undefined, async (port) => {
      const res = await makeRequest(port, "/api/stats");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalSkills).toBe(0);
      expect(data.skillsByAcquisitionStage).toEqual({
        draft: 0,
        compiled: 0,
        tuned: 0,
      });
      expect(data.skillsByRetentionStage).toEqual({
        active: 0,
        aging: 0,
        stale: 0,
        forgotten: 0,
      });
    });
  });
});
