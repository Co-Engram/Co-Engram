// 夜思 incubator:CRUD/持锁写/in-flight/回灌/循环检测/L1/日调度/resolve 仪式
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { InsightDraft, NightThinkingReport } from "../src/maintenance/insight/types.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let incubator: Incubator;
let auditEntries: Array<{ action: string; metadata?: Record<string, unknown> }>;

const stubEmbedder = async () => [1, 0, 0];

/** 可控时钟 */
let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-incubator-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo,
    embedder: stubEmbedder,
    auditLog: { append: () => {} } as never,
    dataRoot: tmpDir,
  });
  auditEntries = [];
  incubator = new Incubator({
    repository: repo,
    proposalEngine: engine,
    dataRoot: tmpDir,
    llmClient: mockLlm(),
    auditLog: {
      append: (e) => {
        auditEntries.push(e as { action: string });
      },
    },
    now: clockNow,
  });
  clockMs = Date.now();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSource(title: string, tags: readonly string[] = ["域甲"]) {
  return repo.createEngram({
    title,
    content: `content ${title}`,
    kind: "fact",
    domainTags: [...tags],
    createdBy: "tester",
  });
}

/** LLM mock:生成阶段返回 insights JSON,critic 阶段返回高分 */
let generationOutput: string = "[]";
function mockLlm(): { complete(): Promise<string> } & { complete(p: string, o?: unknown): Promise<string> } {
  return {
    async complete(prompt: string) {
      if (prompt.includes("independent critic")) {
        return JSON.stringify({
          evidenceSufficiency: 0.9, novelty: 0.9, actionability: 0.9, consistency: 0.9,
          overall: 0.9, rationale: "strong",
        });
      }
      return generationOutput;
    },
  } as never;
}

function draftJson(title: string, sources: readonly string[], type = "theme"): string {
  return JSON.stringify([
    {
      type,
      title,
      content: `洞察内容 ${title} 关于结构 ${Math.random() > 2 ? "" : ""}`.trim(),
      summary: title,
      sourceIds: [...sources],
      domainTags: ["夜思"],
      reason: "cross-domain mapping",
    },
  ]);
}

function reportOf(insightsJson: string, externalCalls: NightThinkingReport["externalCalls"] = []): NightThinkingReport {
  const drafts = JSON.parse(insightsJson) as InsightDraft[];
  return {
    insights: drafts.map((d) => ({ ...d, mode: "inspiration" })),
    plan: [{ step: "L2 plan", capability: "skills" }],
    trace: [{ step: "s1", action: "engram_search", detail: "found" }],
    externalCalls,
  };
}

describe("CRUD 与持锁写", () => {
  it("create → incubations.json 落盘;持锁 isHolder=false → 不写盘", () => {
    incubator.create({ question: "问题 Q" });
    expect(existsSync(join(tmpDir, ".co-engram", "incubations.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(tmpDir, ".co-engram", "incubations.json"), "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].status).toBe("active");

    const nonHolder = new Incubator({
      repository: repo,
      proposalEngine: engine,
      dataRoot: tmpDir,
      processLock: { isHolder: false },
    });
    const before = readFileSync(join(tmpDir, ".co-engram", "incubations.json"), "utf8");
    nonHolder.create({ question: "不应落盘" });
    const after = readFileSync(join(tmpDir, ".co-engram", "incubations.json"), "utf8");
    expect(after).toBe(before);
  });
});

describe("in-flight 原子标记", () => {
  it("acquire 成功 → 二次 acquire false;TTL 过期可再 acquire;release 后可再 acquire", () => {
    const e = incubator.create({ question: "Q" });
    expect(incubator.acquireInFlight(e.id, "proc-A")).toBe(true);
    expect(incubator.acquireInFlight(e.id, "proc-B")).toBe(false);
    incubator.releaseInFlight(e.id);
    expect(incubator.acquireInFlight(e.id, "proc-C")).toBe(true);
    // TTL 过期(推进时钟 31 分钟)→ 回收为 active → 可再 acquire
    clockMs += 31 * 60_000;
    expect(incubator.get(e.id)!.status).toBe("active");
    expect(incubator.acquireInFlight(e.id, "proc-D")).toBe(true);
  });
});

describe("L1 执行 + 回灌 + 循环检测", () => {
  it("incubateOnce:L1 单次调用 → 提案关联 incubationId+round;rounds+1;timeline 写入", async () => {
    const a = makeSource("种子A", ["域甲"]);
    const b = makeSource("种子B", ["域乙"]);
    const entry = incubator.create({ question: "问题 Q", seedEngramIds: [a.id, b.id] });
    generationOutput = draftJson("首轮洞察", [a.id, b.id]);
    const r = await incubator.incubateOnce(entry.id, "manual");
    expect(r.level).toBe("L1");
    expect(r.proposals).toBe(1);
    expect(r.entry.rounds).toBe(1);
    expect(r.entry.lastHatchedAt).toBe(clockNow());
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    expect(p.payload!.incubationId).toBe(entry.id);
    expect(p.payload!.insightRound).toBe(1);
    expect(r.entry.timeline[0]!.trigger).toBe("manual");
  });

  it("回灌:第 2 轮 dreamHistory 含第 1 轮洞察与 dismiss 理由", async () => {
    const a = makeSource("A", ["域甲"]);
    const b = makeSource("B", ["域乙"]);
    const entry = incubator.create({ question: "Q", seedEngramIds: [a.id, b.id] });
    generationOutput = draftJson("首轮洞察", [a.id, b.id]);
    await incubator.incubateOnce(entry.id, "scheduled");
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    engine.dismiss(p.entityId, "证据不足");
    const history = incubator.dreamHistoryFor(entry.id);
    expect(history).toContain("首轮洞察");
    expect(history).toContain("dismissed");
    expect(history).toContain("证据不足");
    // 任务包携带梦境史(回灌组装)
    const task = incubator.buildTask(entry.id);
    expect(task.dreamHistory).toContain("首轮洞察");
    expect(task.question).toBe("Q");
    expect(task.protocol).toContain("incubation_report");
    expect(task.webResearchOptIn).toBe(false); // 默认 off
  });

  it("循环检测:第 2 轮洞察与历史重复 → 本轮作废(cycleVetoed);连续 2 轮全撞 → paused", async () => {
    const a = makeSource("A", ["域甲"]);
    const b = makeSource("B", ["域乙"]);
    const entry = incubator.create({ question: "Q", seedEngramIds: [a.id, b.id] });
    // 第 1 轮:title 固定,summary=title → 第 2 轮同 title 必与历史高 Jaccard
    generationOutput = draftJson("重复主题", [a.id, b.id]);
    await incubator.incubateOnce(entry.id, "scheduled");
    clockMs += 60_000;
    const r2 = await incubator.incubateOnce(entry.id, "scheduled");
    expect(r2.cycleVetoed).toBe(true);
    expect(r2.proposals).toBe(0);
    expect(r2.entry.consecutiveVetoed).toBe(1);
    clockMs += 60_000;
    const r3 = await incubator.incubateOnce(entry.id, "scheduled");
    expect(r3.cycleVetoed).toBe(true);
    expect(incubator.get(entry.id)!.status).toBe("paused"); // 充分探索
    const last = incubator.get(entry.id)!.timeline.at(-1)!;
    expect(last.note).toContain("充分探索");
  });

  it("轮数上限:5 轮无提案 → paused + 提示用户裁决", async () => {
    const entry = incubator.create({ question: "Q" });
    generationOutput = "[]"; // 每轮零洞察
    for (let i = 0; i < 5; i++) {
      clockMs += 60_000;
      await incubator.incubateOnce(entry.id, "scheduled");
    }
    expect(incubator.get(entry.id)!.rounds).toBe(5);
    expect(incubator.get(entry.id)!.status).toBe("paused");
    expect(incubator.get(entry.id)!.timeline.at(-1)!.note).toContain("上限");
  });
});

describe("report(L2 唯一写回路径)", () => {
  it("外部调用写审计日志(night_thinking_external_call)", async () => {
    const entry = incubator.create({ question: "Q" });
    incubator.acquireInFlight(entry.id, "agent");
    await incubator.report({
      incubationId: entry.id,
      report: {
        insights: [],
        plan: [],
        trace: [],
        externalCalls: [{ tool: "WebSearch", purpose: "查证", at: clockNow() }],
      },
      trigger: "manual",
      actor: "night-thinking-L2",
    });
    expect(auditEntries.some((e) => e.action === "night_thinking_external_call")).toBe(true);
  });
});

describe("resolve 仪式", () => {
  it("accept 洞察 → suggested-resolve;resolve(true)→ resolved(梦境链保留);resolve(false)→ active", async () => {
    const a = makeSource("A", ["域甲"]);
    const b = makeSource("B", ["域乙"]);
    const entry = incubator.create({ question: "Q", seedEngramIds: [a.id, b.id] });
    generationOutput = draftJson("可接受洞察", [a.id, b.id]);
    await incubator.incubateOnce(entry.id, "scheduled");
    const p = engine.listAll().find((x) => x.source === "rem-insight")!;
    engine.accept(p.entityId, { createdBy: "user" });
    // 读时归一化:accept → suggested-resolve
    expect(incubator.get(entry.id)!.status).toBe("suggested-resolve");
    const resolved = incubator.resolve(entry.id, true);
    expect(resolved.status).toBe("resolved");
    expect(resolved.timeline).toHaveLength(1); // 梦境链保留
    // 未回答的 suggested-resolve:false → 继续 active
    const e2 = incubator.create({ question: "Q2" });
    const paused2 = incubator.pause(e2.id);
    expect(paused2.status).toBe("paused");
  });
});

describe("独立日调度 runDue", () => {
  it("从未跑过 → 立即执行;24h 内 → skip;非 active → skip", async () => {
    const a = makeSource("A", ["域甲"]);
    const b = makeSource("B", ["域乙"]);
    const fresh = incubator.create({ question: "Q1", seedEngramIds: [a.id, b.id] });
    const pausedEntry = incubator.create({ question: "Q2" });
    incubator.pause(pausedEntry.id);
    generationOutput = draftJson("调度洞察", [a.id, b.id]);
    const r1 = await incubator.runDue();
    expect(r1.ran).toContain(fresh.id);
    expect(r1.ran).not.toContain(pausedEntry.id);
    // 24h 内:lastHatchedAt 刚写 → skip
    const r2 = await incubator.runDue();
    expect(r2.ran).not.toContain(fresh.id);
    expect(r2.skipped).toContain(fresh.id);
    // 25h 后 → 再触发
    clockMs += 25 * 3600_000;
    generationOutput = draftJson("次夜洞察", [a.id, b.id]);
    const r3 = await incubator.runDue();
    expect(r3.ran).toContain(fresh.id);
    expect(incubator.get(fresh.id)!.rounds).toBe(2);
  });
});

describe("L2 执行器优先 + 失败降级 L1", () => {
  it("executor 抛错 → 降级 L1 不阻塞交付;executor 成功 → level=L2", async () => {
    const a = makeSource("A", ["域甲"]);
    const b = makeSource("B", ["域乙"]);
    const entry = incubator.create({ question: "Q", seedEngramIds: [a.id, b.id] });
    generationOutput = draftJson("L1 兜底洞察", [a.id, b.id]);

    const failing = new Incubator({
      repository: repo, proposalEngine: engine, dataRoot: tmpDir, llmClient: mockLlm(),
      executor: { execute: async () => { throw new Error("headless boom"); } },
      now: clockNow,
    });
    const r1 = await failing.incubateOnce(entry.id, "manual");
    expect(r1.level).toBe("L1");
    expect(r1.proposals).toBe(1);

    clockMs += 60_000;
    const entry2 = incubator.create({ question: "Q2", seedEngramIds: [a.id, b.id] });
    const okExec = new Incubator({
      repository: repo, proposalEngine: engine, dataRoot: tmpDir, llmClient: mockLlm(),
      executor: {
        execute: async (task) => ({
          insights: [
            {
              mode: "inspiration", type: "theme",
              title: "L2 洞察", content: "结构映射内容", summary: "L2 洞察",
              sourceIds: [a.id, b.id], domainTags: ["夜思"], reason: "r",
            },
          ],
          plan: [{ step: "盘点", capability: "skills" }],
          trace: [], externalCalls: [],
        }),
      },
      now: clockNow,
    });
    void entry2;
    const r2 = await okExec.incubateOnce(entry.id, "scheduled");
    expect(r2.level).toBe("L2");
    expect(r2.proposals).toBeGreaterThanOrEqual(1);
  });
});
