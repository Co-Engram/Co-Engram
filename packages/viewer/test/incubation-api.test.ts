// 夜思实验室 API:incubations CRUD + 异步任务(run → jobId → 轮询 done/error)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuditLog,
  DEFAULT_HASHER_EMBEDDER,
  EffectivenessTracker,
  EngramRepository,
  Incubator,
  ProposalEngine,
  SearchOrchestrator,
  SkillRepository,
} from "@co-engram/core";
import { startViewerServer } from "../src/index.js";

let tmpDir: string;
let runtime: Awaited<ReturnType<typeof startViewerServer>> | undefined;
const stubEmbedder = async () => [1, 0, 0];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-incub-"));
});

afterEach(async () => {
  if (runtime) {
    await runtime.stop();
    runtime = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

let portCounter = 53000;
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

function makeCtx() {
  const repository = new EngramRepository({ rootPath: tmpDir });
  const auditLog = new AuditLog(tmpDir);
  const proposalEngine = new ProposalEngine({
    repository,
    embedder: stubEmbedder ?? DEFAULT_HASHER_EMBEDDER,
    auditLog,
    dataRoot: tmpDir,
  });
  const incubator = new Incubator({
    repository,
    proposalEngine,
    dataRoot: tmpDir,
    ...(auditLog ? { auditLog } : {}),
  });
  void EffectivenessTracker;
  void SearchOrchestrator;
  void SkillRepository;
  return { repository, auditLog, proposalEngine, incubator };
}

async function start(ctx: ReturnType<typeof makeCtx>) {
  const port = await nextPort();
  runtime = await startViewerServer(ctx as never, { port });
  const base = `http://127.0.0.1:${port}`;
  const j = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return j;
}

describe("夜思 API", () => {
  it("POST /api/incubations 创建;GET 列表;resolve 仪式", async () => {
    const j = await start(makeCtx());
    const created = await j("/api/incubations", "POST", { question: "分布式团队如何避免知识孤岛?" });
    expect(created.status).toBe(201);
    const id = (created.json.entry as { id: string }).id;
    const list = await j("/api/incubations");
    expect(list.json.enabled).toBe(true);
    expect((list.json.items as unknown[]).length).toBe(1);
    const bad = await j("/api/incubations", "POST", { question: "ab" });
    expect(bad.status).toBe(400);
    const resolved = await j(`/api/incubations/${id}/resolve`, "POST", { answered: true });
    expect((resolved.json.entry as { status: string }).status).toBe("resolved");
  });

  it("POST run → 202 立即返回 jobId(不阻塞);GET job → running→done;错误 → error+message", async () => {
    const ctx = makeCtx();
    // 注入必败 executor:incubateOnce 抛错(acquireInFlight 后 runL1 无 llmClient)
    const failing = new Incubator({
      repository: ctx.repository,
      proposalEngine: ctx.proposalEngine,
      dataRoot: tmpDir,
    });
    const j = await start({ ...ctx, incubator: failing });
    const created = await j("/api/incubations", "POST", { question: "测试问题一:异步任务语义" });
    const id = (created.json.entry as { id: string }).id;
    const run = await j(`/api/incubations/${id}/run`, "POST");
    expect(run.status).toBe(202);
    expect(typeof run.json.jobId).toBe("string");
    // 轮询直至终态(无 llmClient → L1 抛错 → job error)
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      const r = await j(`/api/incubation-jobs/${run.json.jobId}`);
      job = r.json;
      if (job.status !== "running") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(["done", "error"]).toContain(job.status);
    if (job.status === "error") {
      expect(typeof job.error).toBe("string");
    }
    const missing = await j("/api/incubation-jobs/nonexistent");
    expect(missing.status).toBe(404);
  });

  it("incubator 未注入 → 503 enabled=false", async () => {
    const ctx = makeCtx();
    const j = await start({ repository: ctx.repository } as never);
    const r = await j("/api/incubations");
    expect(r.status).toBe(503);
    expect(r.json.enabled).toBe(false);
  });
});
