// 沉思 API(2026-08-17 重设计):创建即深思(POST 起异步 job)+ 轮询 + 再思 + 删除
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-viewer-contemplation-"));
});

afterEach(async () => {
  if (runtime) {
    await runtime.stop();
    runtime = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

let portCounter = 54000;
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

function makeCtx(opts: { fakeExecutor?: boolean } = {}) {
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
    auditLog,
    // fake L2:立即返回带 answer 的报告(创建即深思的 done 链)
    ...(opts.fakeExecutor
      ? {
          executor: {
            execute: async () => ({
              answer: "执行现场回答:证据充分。",
              insights: [],
              plan: [{ step: "盘点", capability: "engram_search" }],
              trace: [{ step: "s1", action: "engram_search", detail: "命中" }],
            }),
          },
        }
      : {}),
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

async function pollJob(
  j: Awaited<ReturnType<typeof start>>,
  jobId: string,
): Promise<Record<string, unknown>> {
  let job: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    const r = await j(`/api/contemplation-jobs/${jobId}`);
    job = r.json;
    if (job.status !== "running") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return job;
}

describe("沉思 API", () => {
  it("POST /api/contemplations 创建即深思(201 + jobId);轮询 job → done;条目 done + answer", async () => {
    const j = await start(makeCtx({ fakeExecutor: true }));
    const created = await j("/api/contemplations", "POST", { question: "分布式团队如何避免知识孤岛?" });
    expect(created.status).toBe(201);
    expect(typeof created.json.jobId).toBe("string");
    const id = (created.json.entry as { id: string }).id;
    const job = await pollJob(j, created.json.jobId as string);
    expect(job.status).toBe("done");
    const list = await j("/api/contemplations");
    expect(list.json.enabled).toBe(true);
    const item = (list.json.items as Array<{ id: string; status: string; answer?: string }>).find((x) => x.id === id)!;
    expect(item.status).toBe("done");
    expect(item.answer).toBe("执行现场回答:证据充分。");
    // limit 信息在 payload(上限预警数据源)
    expect((list.json.limit as { max: number }).max).toBe(50);
    // 参数校验:过短问题 → 400;旧联网/排程参数已移除(strict body 被忽略之外仅 question/seed 生效)
    const bad = await j("/api/contemplations", "POST", { question: "ab" });
    expect(bad.status).toBe(400);
  });

  it("POST :id/run 再思 → 202 jobId;job 失败(无 llmClient/executor)→ error+message", async () => {
    const j = await start(makeCtx({ fakeExecutor: true }));
    const created = await j("/api/contemplations", "POST", { question: "再思链路问题?" });
    const id = (created.json.entry as { id: string }).id;
    await pollJob(j, created.json.jobId as string);
    const run = await j(`/api/contemplations/${id}/run`, "POST");
    expect(run.status).toBe(202);
    expect(typeof run.json.jobId).toBe("string");
    const job = await pollJob(j, run.json.jobId as string);
    expect(job.status).toBe("done");
    const missing = await j("/api/contemplation-jobs/nonexistent");
    expect(missing.status).toBe(404);
    // 不存在条目 run → 404
    const nf = await j("/api/contemplations/inc-nonexistent/run", "POST");
    expect(nf.status).toBe(404);
  });

  it("non-holder viewer:持锁写被跳过 → 创建落盘验证 503(不假 201 + 异步 job 炸)", async () => {
    const ctx = makeCtx({ fakeExecutor: true });
    const nonHolder = new Incubator({
      repository: ctx.repository,
      proposalEngine: ctx.proposalEngine,
      dataRoot: tmpDir,
      processLock: { isHolder: false },
    });
    const j = await start({ ...ctx, incubator: nonHolder });
    const r = await j("/api/contemplations", "POST", { question: "非 holder 创建问题?" });
    expect(r.status).toBe(503);
    expect(String(r.json.error)).toContain("read-only");
    // 盘上无条目(列表为空,无幽灵)
    const list = await j("/api/contemplations");
    expect(list.json.items).toHaveLength(0);
  });

  it("incubator 未注入 → 503 enabled=false", async () => {
    const ctx = makeCtx();
    const j = await start({ ...ctx, incubator: undefined } as never);
    const list = await j("/api/contemplations");
    expect(list.status).toBe(503);
    expect(list.json.enabled).toBe(false);
  });

  it("POST delete:200 {id} 且条目从 GET 列表消失;not found → 409", async () => {
    const j = await start(makeCtx({ fakeExecutor: true }));
    const created = await j("/api/contemplations", "POST", { question: "删除链路问题?" });
    const id = (created.json.entry as { id: string }).id;
    await pollJob(j, created.json.jobId as string);
    const del = await j(`/api/contemplations/${id}/delete`, "POST");
    expect(del.status).toBe(200);
    expect(del.json.id).toBe(id);
    const list = await j("/api/contemplations");
    expect((list.json.items as unknown[])).toHaveLength(0);
    const nf = await j("/api/contemplations/inc-nonexistent/delete", "POST");
    expect(nf.status).toBe(409);
  });

  it("生命周期审计链:contemplation_create / run_start / run_done 落 audit.jsonl", async () => {
    const j = await start(makeCtx({ fakeExecutor: true }));
    const created = await j("/api/contemplations", "POST", { question: "审计链路问题?" });
    const id = (created.json.entry as { id: string }).id;
    await pollJob(j, created.json.jobId as string);
    const raw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    const actions = raw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toContain("contemplation_create");
    expect(actions).toContain("contemplation_run_start");
    expect(actions).toContain("contemplation_run_done");
  });
});
