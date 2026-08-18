// Phase3(2026-08-18):P6 角度防复读(探测词多样性+外部型保证+答案复读标记)/
// P7 主张对手抽取(降级占比>30% 提案隔离)/ P8 接力权转移(critic 下轮任务+外部型机械保证)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import type { PonderRequirement } from "../src/maintenance/insight/types.js";
import type { ToolCallEvent } from "../src/signals/types.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let auditEntries: Array<{ action: string; metadata?: Record<string, unknown> }>;
let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

let observedEvents: ToolCallEvent[];
const signalEvidence = { flush: () => {}, snapshot: () => observedEvents };

/** LLM mock 可编程:plan / claims / nextTasks / critic 四类 prompt */
let planLlmOutput: string | undefined;
let claimsLlmOutput: string | undefined;
let nextTasksLlmOutput: string | undefined;
function mockLlm(): { complete(p: string, o?: unknown): Promise<string> } {
  return {
    async complete(prompt: string) {
      if (prompt.includes("PLANNING critic")) {
        return planLlmOutput ?? JSON.stringify({
          items: [
            { resourceType: "engrams", description: "记忆盘点", necessity: "logic-needed",
              probes: [{ query: "记忆图谱检索角度探词" }, { query: "记忆图谱检索角度探词补充" }] },
          ],
        });
      }
      if (prompt.includes("ADVERSARIAL claim auditor")) return claimsLlmOutput ?? "not-json";
      if (prompt.includes("HANDOFF planner")) return nextTasksLlmOutput ?? "not-json";
      if (prompt.includes("independent critic")) {
        return JSON.stringify({ overall: 0.9, rationale: "ok" });
      }
      return "阶段结论。";
    },
  } as never;
}

function makeIncubator(opts: { llm?: boolean } = {}): Incubator {
  return new Incubator({
    repository: repo,
    proposalEngine: engine,
    dataRoot: tmpDir,
    ...(opts.llm === false ? {} : { llmClient: mockLlm() }),
    signalEvidence,
    auditLog: {
      append: (e) => {
        auditEntries.push(e as { action: string });
      },
    },
    now: clockNow,
  });
}

function makeSource(title: string, tags: readonly string[] = ["域甲"]) {
  return repo.createEngram({
    title, content: `content ${title}`, kind: "fact", domainTags: [...tags], createdBy: "tester",
  });
}

const searchEvent = (query: string, hits: number): ToolCallEvent => ({
  toolName: "engram_search", input: { query }, outputSummary: `{hits: ${hits}}`, sessionId: "s", at: clockMs + 100,
});
const skillEvent = (id: string): ToolCallEvent => ({
  toolName: "skill_list", input: {}, outputSummary: "{ok}", sessionId: "s", at: clockMs + 100,
});
const getEvent = (id: string): ToolCallEvent => ({
  toolName: "engram_get", input: { id }, outputSummary: "{ok}", retrievedEngramIds: [id], sessionId: "s", at: clockMs + 100,
});

const req = (partial: Partial<PonderRequirement> & { resourceType: PonderRequirement["resourceType"]; description: string }): PonderRequirement => ({
  necessity: "logic-needed", closed: true, ...partial,
} as PonderRequirement);

/** 完整跑一轮「闭合」report 的便捷封装 */
async function runClosedReport(
  incubator: Incubator,
  e: { id: string },
  task: { plan: { items: readonly ReturnType<typeof req2item>[] } } | Awaited<ReturnType<Incubator["buildTask"]>>,
  extra: { answer?: string; insights?: unknown[] } = {},
) {
  return incubator.report({
    incubationId: e.id,
    report: {
      answer: extra.answer ?? "基于记忆证据的回答。",
      insights: (extra.insights ?? []) as never,
      plan: [], trace: [],
      requirements: task.plan.items.map((i) =>
        req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
    },
    trigger: "manual", actor: "test",
  });
}
const req2item = (x: never) => x;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-p3-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo, embedder: async () => [1, 0, 0],
    auditLog: { append: () => {} } as never, dataRoot: tmpDir,
  });
  auditEntries = [];
  observedEvents = [];
  planLlmOutput = undefined;
  claimsLlmOutput = undefined;
  nextTasksLlmOutput = undefined;
  clockMs = Date.parse("2026-08-18T06:00:00.000Z");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("P6 角度防复读(计划机械保证)", () => {
  it("探测词同质(token Jaccard ≥ 0.7)→ 引擎替换第二词为关键词变体", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "角度多样性验证问题" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan.items.find((i) => i.resourceType === "engrams")!;
    // mock 的两个探测词高度同质(仅尾缀不同,2-gram Jaccard ≥ 0.7)→ 第二词被替换
    const [p1, p2] = engramsItem.probes;
    expect(p1!.query).toContain("记忆图谱检索角度探词");
    expect(p2!.query).not.toBe("记忆图谱检索角度探词补充"); // 已被替换为关键词变体
    expect(p2!.query.length).toBeGreaterThan(0);
  });

  it("LLM 计划缺外部型(无 web/mcp 项)→ 机械补 web 项", async () => {
    planLlmOutput = JSON.stringify({
      items: [{ resourceType: "engrams", description: "只有记忆的计划", necessity: "logic-needed",
        probes: [{ query: "探词一" }, { query: "关键词二组" }] }],
    });
    const incubator = makeIncubator();
    const e = incubator.create({ question: "外部型保证问题" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const external = task.plan.items.find((i) => i.resourceType === "web" || i.resourceType === "mcp");
    expect(external).toBeDefined();
    expect(external!.description).toContain("外部检索验证");
  });

  it("答案相邻复读:与上一 run 最终答案 Jaccard ≥ 0.65 → timeline 标记 answerRepeat(不阻塞终束)", async () => {
    const incubator = makeIncubator({ llm: false }); // 无 LLM:claimsSkipped,聚焦 P6
    const a = makeSource("复读来源");
    const e = incubator.create({ question: "复读检测问题?" });
    // Run 1
    incubator.acquireThinking(e.id, "test");
    let task = await incubator.buildTask(e.id);
    observedEvents = [getEvent(a.id), skillEvent("任意"), ...task.plan.items.filter((i) => i.resourceType === "engrams").flatMap((i) => i.probes.map((p) => searchEvent(p.query, 1)))];
    const r1 = await incubator.report({
      incubationId: e.id,
      report: {
        answer: "结论甲:该问题应由方案一解决,依据记忆图谱的三条证据支撑判断。",
        insights: [], plan: [], trace: [],
        requirements: task.plan.items.map((i) =>
          req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
      },
      trigger: "manual", actor: "test",
    });
    expect(r1.entry.status).toBe("done");
    expect(r1.entry.timeline.at(-1)?.pdca?.answerRepeat).toBeUndefined(); // 首轮无前置
    // Run 2(再思):几乎相同答案
    clockMs += 60_000;
    incubator.acquireThinking(e.id, "rethink");
    task = await incubator.buildTask(e.id);
    observedEvents = [getEvent(a.id), skillEvent("任意"), ...task.plan.items.filter((i) => i.resourceType === "engrams").flatMap((i) => i.probes.map((p) => searchEvent(p.query, 1)))];
    const r2 = await incubator.report({
      incubationId: e.id,
      report: {
        answer: "结论甲:该问题应由方案一解决,依据记忆图谱的三条证据支撑判断。",
        insights: [], plan: [], trace: [],
        requirements: task.plan.items.map((i) =>
          req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
      },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.status).toBe("done"); // 不阻塞
    expect(r2.entry.timeline.at(-1)?.pdca?.answerRepeat).toBe(true); // 标记
  });
});

describe("P7 主张对手抽取", () => {
  it("降级占比 > 30% → 本 run 洞察提案固化隔离(答案弱支撑),run 终态不变", async () => {
    claimsLlmOutput = JSON.stringify({ claims: [
      { claim: "主张一(有记忆证据支撑)", status: "evidenced" },
      { claim: "主张二(推测无支撑)", status: "downgraded" },
      { claim: "主张三(待验证假设)", status: "downgraded" },
      { claim: "主张四(凭印象断言)", status: "downgraded" },
    ]});
    const incubator = makeIncubator();
    const seed = makeSource("种子源");
    const extra = makeSource("增量源", ["域乙"]);
    const e = incubator.create({ question: "弱支撑答案问题?", seedEngramIds: [seed.id] });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan.items.find((i) => i.resourceType === "engrams")!;
    observedEvents = [getEvent(seed.id), getEvent(extra.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        answer: "四条主张中三条是推测的弱支撑答案。",
        insights: [{
          mode: "inspiration", type: "theme", title: "弱支撑run的洞察",
          content: "c", summary: "s", sourceIds: [seed.id, extra.id], domainTags: ["沉思"], reason: "r",
        }],
        plan: [], trace: [],
        requirements: [
          req({ planItemId: engramsItem.id, resourceType: "engrams", description: engramsItem.description, closed: true, evidence: { ids: [seed.id, extra.id] } }),
          ...task.plan.items.filter((i) => i.id !== engramsItem.id).map((i) =>
            req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done"); // 资源全闭合,终态正常
    const pid = r.entry.timeline.at(-1)!.proposalEntityIds[0]!;
    expect(engine.findProposalByEntityId(pid)?.payload?.degraded).toMatchObject({ provisional: false });
    expect(engine.findProposalByEntityId(pid)?.payload?.degraded?.unclosedGaps[0]).toContain("答案弱支撑");
    // timeline 落主张清单与占比
    expect(r.entry.timeline.at(-1)?.answerClaims).toHaveLength(4);
    expect(r.entry.timeline.at(-1)?.pdca?.answerDowngradeRatio).toBe(0.75);
  });

  it("降级占比 ≤ 30% → 提案不隔离;claims LLM 垃圾输出 → claimsSkipped(fail-open)", async () => {
    claimsLlmOutput = JSON.stringify({ claims: [
      { claim: "有据主张", status: "evidenced" },
      { claim: "轻微推测", status: "downgraded" },
      { claim: "另一有据主张", status: "evidenced" },
      { claim: "再一有据主张", status: "evidenced" },
    ]});
    const incubator = makeIncubator();
    const seed = makeSource("种子");
    const extra = makeSource("增量", ["域乙"]);
    const e = incubator.create({ question: "健康答案问题?", seedEngramIds: [seed.id] });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan.items.find((i) => i.resourceType === "engrams")!;
    observedEvents = [getEvent(seed.id), getEvent(extra.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        answer: "大部分主张有据的健康答案。",
        insights: [{
          mode: "inspiration", type: "theme", title: "健康run的洞察",
          content: "c", summary: "s", sourceIds: [seed.id, extra.id], domainTags: ["沉思"], reason: "r",
        }],
        plan: [], trace: [],
        requirements: [
          req({ planItemId: engramsItem.id, resourceType: "engrams", description: engramsItem.description, closed: true, evidence: { ids: [seed.id, extra.id] } }),
          ...task.plan.items.filter((i) => i.id !== engramsItem.id).map((i) =>
            req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    const pid = r.entry.timeline.at(-1)!.proposalEntityIds[0]!;
    expect(engine.findProposalByEntityId(pid)?.payload?.degraded).toBeUndefined(); // 25% ≤ 30% 不隔离

    // fail-open:claims 输出垃圾 → claimsSkipped,提案照常
    claimsLlmOutput = "garbage {{{";
    const e2 = incubator.create({ question: "垃圾claims问题?" });
    incubator.acquireThinking(e2.id, "test");
    const t2 = await incubator.buildTask(e2.id);
    const it2 = t2.plan.items.find((i) => i.resourceType === "engrams")!;
    const r2 = await incubator.report({
      incubationId: e2.id,
      report: {
        answer: "垃圾输出下的答案。",
        insights: [], plan: [], trace: [],
        requirements: [
          req({ planItemId: it2.id, resourceType: "engrams", description: it2.description, closed: true, evidence: { ids: [seed.id] } }),
          ...t2.plan.items.filter((i) => i.id !== it2.id).map((i) =>
            req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.timeline.at(-1)?.pdca?.claimsSkipped).toBe(true);
  });
});

describe("P8 接力权转移", () => {
  it("degraded 终束 → critic 生成 nextTasks(含外部型机械保证)→ 转存进新计划", async () => {
    nextTasksLlmOutput = JSON.stringify({ tasks: ["用 web 检索验证业界基准 X", "复查记忆图谱中 Y 的引用链"] });
    const incubator = makeIncubator();
    const a = makeSource("接力源");
    const e = incubator.create({ question: "接力权转移问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan.items.find((i) => i.resourceType === "engrams")!;
    const reqs = () => task.plan.items.map((i) =>
      req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: i.id === engramsItem.id ? false : true }));
    observedEvents = [getEvent(a.id)];
    let last = await incubator.report({
      incubationId: e.id, report: { answer: "带缺口答案。", insights: [], plan: [], trace: [], requirements: reqs() },
      trigger: "manual", actor: "test",
    });
    for (let i = 0; i < 6 && last.entry.status === "repairing"; i += 1) {
      last = await incubator.report({
        incubationId: e.id, report: { answer: `修复 ${i}`, insights: [], plan: [], trace: [], requirements: reqs() },
        trigger: "manual", actor: "test",
      });
    }
    expect(last.entry.degraded).toBeDefined();
    expect(last.entry.degraded?.nextTasks).toContain("用 web 检索验证业界基准 X");
    // 再思:nextTasks 转存 → 新计划 carryOver 项;外部型任务 → web 计划项
    incubator.acquireThinking(e.id, "rethink");
    const task2 = await incubator.buildTask(e.id);
    const carriedWeb = task2.plan.items.find((i) => i.carryOver && i.resourceType === "web");
    const carriedEngrams = task2.plan.items.find((i) => i.carryOver && i.resourceType === "engrams");
    expect(carriedWeb?.description).toContain("业界基准");
    expect(carriedEngrams?.description).toContain("引用链");
  });

  it("critic 任务全无外部型 → 机械追加一条外部检索验证(生成权兜底)", async () => {
    nextTasksLlmOutput = JSON.stringify({ tasks: ["复查记忆图谱条目 A", "核对日志文件 B"] });
    const incubator = makeIncubator();
    const a = makeSource("兜底源");
    const e = incubator.create({ question: "外部型兜底问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan.items.find((i) => i.resourceType === "engrams")!;
    const reqs = () => task.plan.items.map((i) =>
      req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: i.id === engramsItem.id ? false : true }));
    observedEvents = [getEvent(a.id)];
    let last = await incubator.report({
      incubationId: e.id, report: { answer: "答案。", insights: [], plan: [], trace: [], requirements: reqs() },
      trigger: "manual", actor: "test",
    });
    for (let i = 0; i < 6 && last.entry.status === "repairing"; i += 1) {
      last = await incubator.report({
        incubationId: e.id, report: { answer: "修复", insights: [], plan: [], trace: [], requirements: reqs() },
        trigger: "manual", actor: "test",
      });
    }
    expect(last.entry.degraded?.nextTasks?.some((t) => /外部|web|联网|检索/.test(t))).toBe(true);
  });
});
