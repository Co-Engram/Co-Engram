// Phase2 计划先行(2026-08-18):计划生成双源/P5 防收窄(删除+降级)/
// P1 探测逐字执行与自动豁免/预算 origin 归因/跨轮接力/计划复用
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

function searchEvent(query: string, hits: number): ToolCallEvent {
  return {
    toolName: "engram_search",
    input: { query },
    outputSummary: `{hits: ${hits}}`,
    sessionId: "s",
    at: clockMs + 100,
  };
}
function getEvent(id: string): ToolCallEvent {
  return {
    toolName: "engram_get",
    input: { id },
    outputSummary: "{ok}",
    retrievedEngramIds: [id],
    sessionId: "s",
    at: clockMs + 100,
  };
}

/** LLM mock:plan 生成(critic prompt)与 critique 分别可控 */
let planLlmOutput: string | undefined;
function mockLlm(): { complete(p: string, o?: unknown): Promise<string> } {
  return {
    async complete(prompt: string) {
      if (prompt.includes("PLANNING critic")) {
        if (planLlmOutput !== undefined) return planLlmOutput;
        return JSON.stringify({
          items: [
            { resourceType: "engrams", description: "记忆盘点:问题域相关记忆", necessity: "logic-needed",
              probes: [{ query: "探词甲" }, { query: "探词乙" }] },
            { resourceType: "web", description: "业界基准检索", necessity: "helpful",
              probes: [{ query: "benchmark 2026" }] },
          ],
        });
      }
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

const req = (partial: Partial<PonderRequirement> & { resourceType: PonderRequirement["resourceType"]; description: string }): PonderRequirement => ({
  necessity: "logic-needed", closed: true, ...partial,
} as PonderRequirement);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-plan-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo, embedder: async () => [1, 0, 0],
    auditLog: { append: () => {} } as never, dataRoot: tmpDir,
  });
  auditEntries = [];
  observedEvents = [];
  planLlmOutput = undefined;
  clockMs = Date.parse("2026-08-18T04:00:00.000Z");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("计划生成(双源 + 落盘 + 审计)", () => {
  it("无 llmClient → 模板计划:五类型覆盖、engrams logic-needed 带 ≥2 探测变体,落盘 run.plan", async () => {
    const incubator = makeIncubator({ llm: false });
    const e = incubator.create({ question: "模板计划问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    expect(task.plan?.source).toBe("template");
    const types = task.plan!.items.map((i) => i.resourceType);
    expect(types).toEqual(expect.arrayContaining(["engrams", "skills", "logs", "web", "mcp"]));
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    expect(engramsItem.necessity).toBe("logic-needed");
    expect(engramsItem.probes.length).toBeGreaterThanOrEqual(2);
    // 落盘:重读可见(run.plan 持久化)
    const entry = incubator.get(e.id)!;
    expect(entry.run?.plan?.items.length).toBe(task.plan!.items.length);
    // 审计留痕
    const planAudit = auditEntries.find((x) => x.action === "contemplation_plan_generated");
    expect(planAudit?.metadata).toMatchObject({ source: "template" });
  });

  it("有 llmClient → critic 计划:items 透传,engrams 探测变体不足时引擎补足", async () => {
    planLlmOutput = JSON.stringify({
      items: [
        { resourceType: "engrams", description: "单变体计划项", necessity: "logic-needed",
          probes: [{ query: "唯一探词" }] },
      ],
    });
    const incubator = makeIncubator();
    const e = incubator.create({ question: "LLM 计划问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    expect(task.plan?.source).toBe("llm");
    const item = task.plan!.items[0]!;
    expect(item.probes.length).toBeGreaterThanOrEqual(2); // 引擎补足变体
    expect(item.probes[0]!.query).toBe("唯一探词");
  });

  it("LLM 输出垃圾 → 模板兜底(fail-open,计划平庸好过无计划)", async () => {
    planLlmOutput = "not json at all {{{";
    const incubator = makeIncubator();
    const e = incubator.create({ question: "垃圾计划问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    expect(task.plan?.source).toBe("template");
  });

  it("修复轮重复 buildTask → 计划复用不重生成(reports 计数不受影响)", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "复用问题?" });
    incubator.acquireThinking(e.id, "test");
    const t1 = await incubator.buildTask(e.id);
    const t2 = await incubator.buildTask(e.id);
    expect(t2.plan!.items.map((i) => i.id)).toEqual(t1.plan!.items.map((i) => i.id));
    const audits = auditEntries.filter((x) => x.action === "contemplation_plan_generated");
    expect(audits).toHaveLength(1);
  });
});

describe("P5 防收窄(删除拦截 + 降级覆写)", () => {
  it("计划项被删除(report 缺该 planItemId)→ 引擎合成 open 缺口(origin=plan)→ repairing", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "删除拦截问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    observedEvents = [getEvent(a.id)];
    // report 只报 web 项,engrams 计划项被「删除」
    const webItem = task.plan!.items.find((i) => i.resourceType === "web")!;
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ planItemId: webItem.id, resourceType: "web", description: webItem.description, necessity: webItem.necessity, closed: true }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("repairing");
    const dropped = r.openGaps.find((g) => g.description === engramsItem.description);
    expect(dropped).toBeDefined();
    expect(dropped!.origin).toBe("plan");
    expect(dropped!.reason).toBe("unclosed");
    // timeline pdca 留痕收窄
    expect(r.entry.timeline.at(-1)?.pdca?.narrowed).toContain(engramsItem.description);
  });

  it("计划 logic-needed 被报 helpful(降级)→ 引擎覆写回 logic-needed(仍阻塞)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "降级拦截问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    observedEvents = [getEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ planItemId: engramsItem.id, resourceType: "engrams", description: engramsItem.description,
            necessity: "helpful", closed: false }), // 降级 + 未闭合
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("repairing");
    const g = r.openGaps.find((x) => x.description === engramsItem.description)!;
    expect(g.necessity).toBe("logic-needed"); // 计划为准
    expect(r.entry.timeline.at(-1)?.pdca?.narrowed).toContain(engramsItem.description);
  });

  it("计划项不占执行者预算:计划 5 项全 open + 0 追加 → 不 deferred 不触总量预算", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "预算归因问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id); // 模板 5 项(LLM mock 2 项 —— 用 llm 版)
    observedEvents = [getEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: task.plan!.items.map((i) =>
          req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: false })),
      },
      trigger: "manual", actor: "test",
    });
    // 全部 open 但全部 origin=plan:不 deferred、不触预算,仅 repairing
    expect(r.deferredGaps).toHaveLength(0);
    expect(r.entry.status).toBe("repairing");
    expect(r.openGaps.every((g) => g.origin === "plan")).toBe(true);
  });
});

describe("P1 探测逐字执行与自动豁免", () => {
  it("engrams 计划项全部探测变体逐字执行且皆空 → 引擎自动豁免(closed + exempt),无需执行者申报", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "豁免问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    // 两个探测变体都逐字执行、都空(hits: 0)
    observedEvents = engramsItem.probes.map((p) => searchEvent(p.query, 0));
    // report 不报该计划项(被删除)—— 豁免优先于删除合成
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: task.plan!.items
          .filter((i) => i.id !== engramsItem.id)
          .map((i) => req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
      },
      trigger: "manual", actor: "test",
    });
    // 自动豁免:即使执行者没报,该计划项也被引擎判 closed(done 而非 repairing)
    expect(r.entry.status).toBe("done");
    expect(r.entry.timeline.at(-1)?.pdca?.exempted).toContain(engramsItem.description);
    // 豁免优先于删除合成:不在 narrowed(收窄)留痕里
    expect(r.entry.timeline.at(-1)?.pdca?.narrowed ?? []).not.toContain(engramsItem.description);
  });

  it("探测词被改写执行(生成权被夺)→ 不算执行 → 不豁免", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "改写拦截问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    // 执行者改写探测词(表演式探测:不相关词确保空)
    observedEvents = engramsItem.probes.map((p) => searchEvent(p.query + " 改写后缀", 0));
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: task.plan!.items.map((i) =>
          req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: false })),
      },
      trigger: "manual", actor: "test",
    });
    const gap = advancedGap(r, engramsItem.description);
    expect(gap?.state).toBe("open"); // 未豁免
    expect(gap?.exempt).toBeUndefined();
  });

  it("探测非空(资源存在)→ 不豁免,须真实闭合(evidence.ids)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("命中来源");
    const e = incubator.create({ question: "非空豁免问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    observedEvents = [...engramsItem.probes.map((p) => searchEvent(p.query, 3)), getEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: task.plan!.items.map((i) =>
          i.id === engramsItem.id
            ? req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, closed: true, evidence: { ids: [a.id] } })
            : req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: true })),
      },
      trigger: "manual", actor: "test",
    });
    // 证据闭合(非豁免)→ done;exempted 留痕不含该描述
    expect(r.entry.status).toBe("done");
    expect(r.entry.timeline.at(-1)?.pdca?.exempted ?? []).not.toContain(engramsItem.description);
  });
});

describe("跨轮接力(P4 延伸:上轮未闭合缺口进新计划)", () => {
  it("degraded 终束 → 再思 buildTask → 计划含 carryOver 项(logic-needed)", async () => {
    const incubator = makeIncubator({ repairRoundLimit: undefined });
    const a = makeSource("接力来源");
    const e = incubator.create({ question: "接力问题?" });
    incubator.acquireThinking(e.id, "test");
    const task = await incubator.buildTask(e.id);
    const engramsItem = task.plan!.items.find((i) => i.resourceType === "engrams")!;
    // 第 1 轮:engrams 计划项不闭合 → repairing;重报 6 次触顶 degraded
    observedEvents = [getEvent(a.id)];
    const reqs = () => task.plan!.items.map((i) =>
      req({ planItemId: i.id, resourceType: i.resourceType, description: i.description, necessity: i.necessity, closed: i.id === engramsItem.id ? false : true }));
    let last = await incubator.report({
      incubationId: e.id, report: { insights: [], plan: [], trace: [], requirements: reqs() },
      trigger: "manual", actor: "test",
    });
    for (let i = 0; i < 6 && last.entry.status === "repairing"; i += 1) {
      last = await incubator.report({
        incubationId: e.id, report: { insights: [], plan: [], trace: [], requirements: reqs() },
        trigger: "manual", actor: "test",
      });
    }
    expect(last.entry.degraded?.unclosedGaps).toContain(engramsItem.description);
    // 再思:acquireThinking 转存 → buildTask 新计划含 carryOver 项。
    // 第二轮 LLM 输出换成不含该需求的计划 → 验证纯机械接力(不依赖 LLM 覆盖)
    planLlmOutput = JSON.stringify({
      items: [{ resourceType: "web", description: "第二轮新需求", necessity: "helpful", probes: [] }],
    });
    expect(incubator.acquireThinking(e.id, "rethink")).toBe(true);
    const task2 = await incubator.buildTask(e.id);
    // Phase3 P8:接力输入优先用 nextTasks(critic 生成;mock 未覆盖 HANDOFF
    // prompt → generateNextTasks 退化 fallback「验证未闭合需求:<原描述>」)
    const carried = task2.plan!.items.find(
      (i) => i.carryOver && i.description.includes(engramsItem.description),
    );
    expect(carried).toBeDefined();
    expect(carried!.necessity).toBe("logic-needed");
  });
});

/** 从 report 返回的 entry.run(TTL 未清)或 timeline 推断缺口状态 */
function advancedGap(
  r: { entry: { run?: { gaps: Array<{ description: string; state: string; exempt?: string; origin?: string }> } } },
  description: string,
) {
  return r.entry.run?.gaps.find((g) => g.description === description);
}
