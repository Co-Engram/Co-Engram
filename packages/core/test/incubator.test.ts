// 沉思 incubator(2026-08-17 重设计):三态状态机/迁移归一化/thinking 互斥/
// L2 显式失败(M2)/answer 必出(M1)/资源申报清洗/上限 50/回灌 cap 10/审计
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-contemplation-"));
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

/** LLM mock:critic 阶段返回高分;answer 兜底综合返回固定文本 */
let generationOutput: string = "[]";
let synthesisOutput: string = "兜底综合回答";
function mockLlm(): { complete(p: string, o?: unknown): Promise<string> } {
  return {
    async complete(prompt: string) {
      if (prompt.includes("independent critic")) {
        return JSON.stringify({
          evidenceSufficiency: 0.9, novelty: 0.9, actionability: 0.9, consistency: 0.9,
          overall: 0.9, rationale: "strong",
        });
      }
      if (prompt.includes("writing the ANSWER")) return synthesisOutput;
      return generationOutput;
    },
  } as never;
}

function draftJson(title: string, sources: readonly string[], type = "theme"): string {
  return JSON.stringify([
    {
      type,
      title,
      content: `洞察内容 ${title}`,
      summary: title,
      sourceIds: [...sources],
      domainTags: ["沉思"],
      reason: "cross-domain mapping",
    },
  ]);
}

function reportOf(
  insightsJson: string,
  extra: Partial<NightThinkingReport> = {},
): NightThinkingReport {
  const drafts = JSON.parse(insightsJson) as InsightDraft[];
  return {
    insights: drafts.map((d) => ({ ...d, mode: "inspiration" as const })),
    plan: [{ step: "L2 plan", capability: "skills" }],
    trace: [{ step: "s1", action: "engram_search", detail: "found" }],
    ...extra,
  };
}

describe("CRUD 与持锁写", () => {
  it("create → queued 落盘;持锁 isHolder=false → 不写盘", () => {
    incubator.create({ question: "问题 Q" });
    expect(existsSync(join(tmpDir, ".co-engram", "incubations.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(tmpDir, ".co-engram", "incubations.json"), "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].status).toBe("queued");

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

  it("创建审计 contemplation_create;删除审计 contemplation_delete(含 sessions)", () => {
    const e = incubator.create({ question: "审计问题?" });
    incubator.delete(e.id);
    const actions = auditEntries.map((a) => a.action);
    expect(actions).toContain("contemplation_create");
    expect(actions).toContain("contemplation_delete");
  });

  it("thinking 态不可删除;done 可删除且 timeline 随条目移除", async () => {
    const a = makeSource("来源A");
    const e = incubator.create({ question: "删除语义问题?" });
    incubator.acquireThinking(e.id, "test");
    expect(() => incubator.delete(e.id)).toThrow(/thinking/);
    await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("洞察一", [a.id])),
      trigger: "manual",
      actor: "test",
    });
    incubator.delete(e.id);
    expect(incubator.list()).toHaveLength(0);
  });
});

describe("迁移归一化(旧五态 → 三态,读时映射)", () => {
  function writeLegacy(raw: unknown): void {
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    writeFileSync(join(tmpDir, ".co-engram", "incubations.json"), JSON.stringify(raw), "utf8");
  }

  it("active(rounds=0)→queued;active/suggested-resolve(rounds>0)→done;resolved/paused→done;in-flight→thinking", () => {
    writeLegacy([
      { id: "a1", question: "未思", status: "active", rounds: 0, timeline: [] },
      { id: "a2", question: "思过待裁决", status: "suggested-resolve", rounds: 1,
        timeline: [{ at: "2026-08-01T00:00:00Z", trigger: "scheduled", round: 1, summaries: ["s"], proposalEntityIds: [], externalCallCount: 0 }] },
      { id: "a3", question: "已归档", status: "resolved", rounds: 2, timeline: [] },
      { id: "a4", question: "已暂停", status: "paused", rounds: 1, timeline: [] },
      { id: "a5", question: "进行中", status: "in-flight", rounds: 0,
        inFlightAt: new Date(clockMs - 60_000).toISOString(), timeline: [] },
    ]);
    const byId = new Map(incubator.list().map((e) => [e.id, e]));
    expect(byId.get("a1")?.status).toBe("queued");
    expect(byId.get("a2")?.status).toBe("done");
    expect(byId.get("a3")?.status).toBe("done");
    expect(byId.get("a4")?.status).toBe("done");
    expect(byId.get("a5")?.status).toBe("thinking");
  });

  it("in-flight TTL 过期:跑过→done,未跑→queued;旧字段丢弃(finalAnswer→answer,lastHatchedAt→lastRunAt)", () => {
    const stale = new Date(clockMs - 31 * 60_000).toISOString();
    writeLegacy([
      { id: "b1", question: "过期未跑", status: "in-flight", rounds: 0, inFlightAt: stale, timeline: [] },
      { id: "b2", question: "过期已跑", status: "in-flight", rounds: 1, inFlightAt: stale, timeline: [],
        lastHatchedAt: stale, finalAnswer: "旧收束回答", schedule: "03:30", webResearchOptIn: true },
    ]);
    const byId = new Map(incubator.list().map((e) => [e.id, e]));
    expect(byId.get("b1")?.status).toBe("queued");
    const b2 = byId.get("b2")!;
    expect(b2.status).toBe("done");
    expect(b2.answer).toBe("旧收束回答");
    expect(b2.lastRunAt).toBe(stale);
    expect(b2).not.toHaveProperty("schedule");
    expect(b2).not.toHaveProperty("webResearchOptIn");
  });

  it("timeline 旧事件 answerDraft → answer(历史回答呈现兼容)", () => {
    writeLegacy([
      { id: "c1", question: "旧草稿", status: "suggested-resolve", rounds: 1,
        timeline: [{ at: "2026-08-01T00:00:00Z", trigger: "manual", round: 1, summaries: ["s"], proposalEntityIds: [], externalCallCount: 0, answerDraft: "旧草稿回答" }] },
    ]);
    const e = incubator.list()[0]!;
    expect(e.timeline[0]!.answer).toBe("旧草稿回答");
    expect(e.answer).toBe("旧草稿回答");
  });
});

describe("thinking 互斥", () => {
  it("queued/done 可 acquire;thinking 中再 acquire → false;release 回 done(跑过)/queued(未跑)", () => {
    const e = incubator.create({ question: "互斥问题?" });
    expect(incubator.acquireThinking(e.id, "t1")).toBe(true);
    expect(incubator.acquireThinking(e.id, "t2")).toBe(false);
    incubator.releaseThinking(e.id);
    expect(incubator.get(e.id)?.status).toBe("queued");
    // run_done 审计在 report;run_start 在 acquire
    expect(auditEntries.map((a) => a.action)).toContain("contemplation_run_start");
  });
});

describe("执行:incubateOnce(M2 显式失败 / ENOENT 降级)", () => {
  it("executor 成功 → level=L2,回答必出(L2 answer 优先采用)", async () => {
    const a = makeSource("来源A");
    const e = incubator.create({ question: "L2 问题?" });
    const inc = new Incubator({
      repository: repo, proposalEngine: engine, dataRoot: tmpDir,
      executor: {
        execute: async () => reportOf(draftJson("洞察二", [a.id]), { answer: "执行现场回答" }),
      },
      auditLog: { append: () => {} },
      now: clockNow,
    });
    const r = await inc.incubateOnce(e.id, "manual");
    expect(r.level).toBe("L2");
    const entry = inc.get(e.id)!;
    expect(entry.status).toBe("done");
    expect(entry.answer).toBe("执行现场回答");
  });

  it("executor 失败(非 ENOENT)→ 显式抛错 + run_fail 审计 + 回收 thinking(不再静默降级)", async () => {
    const e = incubator.create({ question: "失败问题?" });
    const inc = new Incubator({
      repository: repo, proposalEngine: engine, dataRoot: tmpDir,
      llmClient: mockLlm(),
      executor: { execute: async () => { throw new Error("headless executor timeout (100ms)"); } },
      auditLog: { append: (x) => auditEntries.push(x as { action: string }) },
      now: clockNow,
    });
    await expect(inc.incubateOnce(e.id, "manual")).rejects.toThrow(/timeout/);
    expect(inc.get(e.id)?.status).toBe("queued");
    expect(auditEntries.map((a) => a.action)).toContain("contemplation_run_fail");
  });

  it("executor ENOENT(环境无 claude CLI)→ 降级 L1,审计如实标注", async () => {
    const a = makeSource("来源B");
    const e = incubator.create({ question: "ENOENT 问题?", seedEngramIds: [a.id] });
    generationOutput = draftJson("洞察三", ["S1"]);
    const inc = new Incubator({
      repository: repo, proposalEngine: engine, dataRoot: tmpDir,
      llmClient: mockLlm(),
      executor: { execute: async () => { throw new Error("spawn claude ENOENT"); } },
      auditLog: { append: (x) => auditEntries.push(x as { action: string; metadata?: Record<string, unknown> }) },
      now: clockNow,
    });
    const r = await inc.incubateOnce(e.id, "manual");
    expect(r.level).toBe("L1");
    const done = auditEntries.find((x) => x.action === "contemplation_run_done");
    expect(done?.metadata?.level).toBe("L1");
  });

  it("无 executor → 直接 L1(llmClient 兜底补写 answer)", async () => {
    const a = makeSource("来源C");
    generationOutput = draftJson("洞察四", ["S1"]);
    const e = incubator.create({ question: "L1 问题?", seedEngramIds: [a.id] });
    const r = await incubator.incubateOnce(e.id, "manual");
    expect(r.level).toBe("L1");
    const entry = incubator.get(e.id)!;
    expect(entry.answer).toBe("兜底综合回答");
  });
});

describe("report 写回(M1 answer / 资源申报 / 循环检测 / run_done 审计)", () => {
  it("L2 answer 缺省 → llmClient 综合兜底;answer 落条目与 timeline", async () => {
    const a = makeSource("来源D");
    const e = incubator.create({ question: "兜底问题?" });
    await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("洞察五", [a.id])),
      trigger: "manual", actor: "test", level: "L2",
    });
    const entry = incubator.get(e.id)!;
    expect(entry.answer).toBe("兜底综合回答");
    expect(entry.timeline[0]!.answer).toBe("兜底综合回答");
  });

  it("resourcesUsed:真实 engram id 保留,编造 id 剔除;skills/logs 去空", async () => {
    const a = makeSource("来源E");
    const e = incubator.create({ question: "依据问题?" });
    await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("洞察六", [a.id]), {
        resourcesUsed: {
          engrams: [a.id, "编造/id-不存在"],
          skills: ["图谱页配置", ""],
          logs: [join(tmpDir, ".co-engram", "audit.jsonl")],
        },
      }),
      trigger: "manual", actor: "test",
    });
    const ru = incubator.get(e.id)!.timeline[0]!.resourcesUsed!;
    expect(ru.engrams).toEqual([a.id]);
    expect(ru.skills).toEqual(["图谱页配置"]);
    expect(ru.logs).toHaveLength(1);
  });

  it("全假 resourcesUsed → 清洗为空,不落 timeline 字段", async () => {
    const a = makeSource("来源F");
    const e = incubator.create({ question: "全假依据?" });
    await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("洞察七", [a.id]), {
        resourcesUsed: { engrams: ["假/id"], skills: [], logs: [] },
      }),
      trigger: "manual", actor: "test",
    });
    expect(incubator.get(e.id)!.timeline[0]!.resourcesUsed).toBeUndefined();
  });

  it("重复洞察(Jaccard ≥ 0.65 与历史撞)→ 本条作废;成案走提案;run_done 审计含 level/duration", async () => {
    const a = makeSource("来源G");
    const b = makeSource("来源G2", ["域乙"]);
    const e = incubator.create({ question: "循环检测?" });
    await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("完全相同的洞察标题", [a.id, b.id])),
      trigger: "manual", actor: "test", level: "L2", durationMs: 1234,
    });
    const r2 = await incubator.report({
      incubationId: e.id,
      report: reportOf(draftJson("完全相同的洞察标题", [a.id, b.id])),
      trigger: "manual", actor: "test",
    });
    expect(r2.cycleVetoed).toBe(true);
    expect(r2.proposals).toBe(0);
    const done = auditEntries.find((x) => x.action === "contemplation_run_done");
    expect(done?.metadata?.level).toBe("L2");
    expect(done?.metadata?.durationMs).toBe(1234);
    expect(done?.metadata?.round).toBe(1);
  });

  it("done 条目可再思(acquireThinking 通过),rounds 递增,dreamHistory 回灌最近 10 次", async () => {
    const a = makeSource("来源H");
    const e = incubator.create({ question: "再思问题?" });
    for (let i = 0; i < 12; i += 1) {
      await incubator.report({
        incubationId: e.id,
        report: reportOf(draftJson(`洞察 ${i} ${Math.random()}`, [a.id])),
        trigger: "manual", actor: "test",
      });
    }
    const entry = incubator.get(e.id)!;
    expect(entry.rounds).toBe(12);
    expect(entry.status).toBe("done");
    expect(incubator.acquireThinking(e.id, "rethink")).toBe(true);
    const history = incubator.dreamHistoryFor(e.id);
    const lines = history.split("\n").filter(Boolean);
    expect(lines).toHaveLength(10);
    expect(history).toContain("Session 12");
    expect(history).not.toContain("Session 1:");
  });
});

describe("条目上限与 REM 消费", () => {
  it("上限 50:达限 create 抛错并列出最老 done 条目;不自动清理", () => {
    for (let i = 0; i < 50; i += 1) incubator.create({ question: `问题编号 ${i}??` });
    expect(() => incubator.create({ question: "第 51 个问题?" })).toThrow(/limit reached/);
    expect(incubator.list()).toHaveLength(50);
    expect(incubator.limitInfo().total).toBe(50);
  });

  it("activeEntries 只供 queued(未深思过的问题);done 不再进 REM 种子", async () => {
    const a = makeSource("来源I");
    const e1 = incubator.create({ question: "还没思的问题?" });
    const e2 = incubator.create({ question: "已经思过的问题?" });
    await incubator.report({
      incubationId: e2.id,
      report: reportOf(draftJson("洞察八", [a.id])),
      trigger: "manual", actor: "test",
    });
    const active = incubator.activeEntries();
    expect(active.map((x) => x.id)).toEqual([e1.id]);
  });
});
