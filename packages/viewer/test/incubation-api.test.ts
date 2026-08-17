// 夜思实验室 API:incubations CRUD + 异步任务(run → jobId → 轮询 done/error)
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

  // ============================================================
  // 暂停/删除端点(2026-08 单次执行改版:paused 不再排程,删除是生命周期终点)
  // ============================================================
  it("POST pause:200 + status=paused + nextRunAt=null;not found → 404", async () => {
    const j = await start(makeCtx());
    const created = await j("/api/incubations", "POST", { question: "暂停语义验证问题?" });
    expect(created.status).toBe(201);
    const id = (created.json.entry as { id: string }).id;
    const paused = await j(`/api/incubations/${id}/pause`, "POST");
    expect(paused.status).toBe(200);
    const entry = paused.json.entry as { status: string; nextRunAt: string | null };
    expect(entry.status).toBe("paused");
    // paused 不再排程:computeNextRunAt 仅 active 返回非 null
    expect(entry.nextRunAt).toBeNull();
    const missing = await j("/api/incubations/inc-nonexistent/pause", "POST");
    expect(missing.status).toBe(404);
    expect((missing.json as { error?: string }).error).toContain("not found");
  });

  it("POST delete:200 {id} 且条目从 GET 列表消失;in-flight → 409;not found → 409", async () => {
    const ctx = makeCtx();
    const j = await start(ctx);
    const created = await j("/api/incubations", "POST", { question: "删除语义验证问题?" });
    const id = (created.json.entry as { id: string }).id;
    const del = await j(`/api/incubations/${id}/delete`, "POST");
    expect(del.status).toBe(200);
    expect(del.json.id).toBe(id);
    const list = await j("/api/incubations");
    expect((list.json.items as unknown[]).length).toBe(0);

    // in-flight 拒绝(409):acquireInFlight 是域层公开的跨进程互斥入口,
    // 直接置锁比跑整轮 incubateOnce 更精准(无需 llmClient/executor)
    const created2 = await j("/api/incubations", "POST", { question: "删除冲突验证问题?" });
    const id2 = (created2.json.entry as { id: string }).id;
    expect(ctx.incubator.acquireInFlight(id2, "api-test")).toBe(true);
    const conflict = await j(`/api/incubations/${id2}/delete`, "POST");
    expect(conflict.status).toBe(409);
    expect((conflict.json as { error?: string }).error).toContain("in-flight");

    // not found 与 conclude 端点同款正则,映射 409(冲突类)而非 404
    const missing = await j("/api/incubations/inc-nonexistent/delete", "POST");
    expect(missing.status).toBe(409);
  });

  // ============================================================
  // 生命周期全链(T19 场景验证,用户实际路径 = viewer HTTP API):
  // 播种→暂停→恢复→立即夜思→待裁决→resolve(false) 授权→再跑一轮→
  // 收束→删除;四类生命周期审计(incubation_pause/round/conclude/delete)
  // 落盘断言。锚点 due/runDue 的调度面由 core 单测覆盖,HTTP 面以 run 等价。
  // ============================================================
  it("生命周期全链:播种→暂停→恢复→夜思×2→收束→删除;四类审计落盘", async () => {
    const ctx = makeCtx();
    // mock llmClient 三分流:L1 零洞察("[]" 驱动状态机,不经 critic 门)、
    // 阶段草稿、最终回答 —— viewer 用户路径的 LLM 依赖全部注入
    const withLlm = new Incubator({
      repository: ctx.repository,
      proposalEngine: ctx.proposalEngine,
      dataRoot: tmpDir,
      auditLog: ctx.auditLog,
      llmClient: {
        complete: async (prompt: string) => {
          if (prompt.includes("FINAL ANSWER")) return "最终回答:两轮证据已收敛。";
          if (prompt.includes("WORKING ANSWER DRAFT")) return "阶段草稿:第一轮证据成立。";
          return "[]";
        },
      } as never,
    });
    const j = await start({ ...ctx, incubator: withLlm });

    // ① 播种
    const created = await j("/api/incubations", "POST", { question: "场景验证:知识如何自然生长?" });
    expect(created.status).toBe(201);
    const id = (created.json.entry as { id: string }).id;

    // ② 暂停 → ③ 恢复(resolve 选「还没有」)
    const paused = await j(`/api/incubations/${id}/pause`, "POST");
    expect((paused.json.entry as { status: string }).status).toBe("paused");
    const resumed = await j(`/api/incubations/${id}/resolve`, "POST", { answered: false });
    expect((resumed.json.entry as { status: string }).status).toBe("active");

    // ④ 立即夜思(异步任务轮询至终态)→ ⑤ 待裁决
    const runOnce = async (): Promise<void> => {
      const run = await j(`/api/incubations/${id}/run`, "POST");
      expect(run.status).toBe(202);
      const jobId = run.json.jobId as string;
      for (let i = 0; i < 60; i++) {
        const job = await j(`/api/incubation-jobs/${jobId}`);
        if (job.json.status !== "running") {
          expect(job.json.status).toBe("done");
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("run job 未在轮询窗口内完成");
    };
    await runOnce();
    let list = await j("/api/incubations");
    let entry = (list.json.items as Array<{ status: string; rounds: number }>)[0]!;
    expect(entry.status).toBe("suggested-resolve");
    expect(entry.rounds).toBe(1);

    // ⑥ resolve(false) 授权 → active → ⑦ 再跑一轮 → 又待裁决(单次执行语义闭环)
    await j(`/api/incubations/${id}/resolve`, "POST", { answered: false });
    await runOnce();
    list = await j("/api/incubations");
    entry = (list.json.items as Array<{ status: string; rounds: number }>)[0]!;
    expect(entry.status).toBe("suggested-resolve");
    expect(entry.rounds).toBe(2);

    // ⑧ 收束:finalAnswer 生成,状态保持待裁决(收束本身不替用户 resolve)
    const concluded = await j(`/api/incubations/${id}/conclude`, "POST");
    expect(concluded.status).toBe(200);
    const finalEntry = concluded.json.entry as { status: string; finalAnswer: string };
    expect(finalEntry.finalAnswer).toContain("收敛");
    expect(finalEntry.status).toBe("suggested-resolve");

    // ⑨ 删除:条目消失
    const del = await j(`/api/incubations/${id}/delete`, "POST");
    expect(del.status).toBe(200);
    list = await j("/api/incubations");
    expect((list.json.items as unknown[]).length).toBe(0);

    // ⑩ 四类生命周期审计落盘(真实 AuditLog 文件,非内存 mock)
    const auditRaw = readFileSync(join(tmpDir, ".co-engram", "audit.jsonl"), "utf8");
    const actions = auditRaw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { action: string }).action);
    for (const expected of [
      "incubation_pause",
      "incubation_round",
      "incubation_conclude",
      "incubation_delete",
    ]) {
      expect(actions).toContain(expected);
    }
    expect(actions.filter((a) => a === "incubation_round").length).toBe(2);
  });
});
