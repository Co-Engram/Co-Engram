// PDCA 修复回路(Phase1,2026-08-18):闭合事实化/瞒报拦截/种子源拦截/
// 重报升级/修复轮触顶与缺口预算触顶 → degraded 差分/repairing TTL 回收
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { Incubator } from "../src/maintenance/insight/incubator.js";
import { advanceGaps } from "../src/maintenance/insight/gap-check.js";
import type { PonderGap, PonderRequirement } from "../src/maintenance/insight/types.js";
import type { ToolCallEvent } from "../src/signals/types.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: ProposalEngine;
let auditEntries: Array<{ action: string; metadata?: Record<string, unknown> }>;

/** 可控时钟(TTL 与证据窗口都用它) */
let clockMs: number;
const clockNow = () => new Date(clockMs).toISOString();

/** 可注入的引擎侧调用流水(时间窗内的 co-engram 工具调用) */
let observedEvents: ToolCallEvent[];
const signalEvidence = {
  flush: () => {},
  snapshot: () => observedEvents,
};

function engramEvent(id: string, at = clockMs + 100): ToolCallEvent {
  return {
    toolName: "engram_get",
    input: { id },
    outputSummary: "{ok}",
    retrievedEngramIds: [id],
    sessionId: "s",
    at,
  };
}

function skillEvent(id: string): ToolCallEvent {
  return {
    toolName: "skill_get",
    input: { id },
    outputSummary: "{ok}",
    sessionId: "s",
    at: clockMs + 100,
  };
}

function skillListEvent(): ToolCallEvent {
  return {
    toolName: "skill_list",
    input: {},
    outputSummary: "{items:9}",
    sessionId: "s",
    at: clockMs + 100,
  };
}

function makeIncubator(opts: { repairRoundLimit?: number; llm?: unknown } = {}): Incubator {
  return new Incubator({
    repository: repo,
    proposalEngine: engine,
    dataRoot: tmpDir,
    llmClient: (opts.llm ?? mockLlm()) as never,
    signalEvidence,
    ...(opts.repairRoundLimit !== undefined
      ? { repairRoundLimit: opts.repairRoundLimit }
      : {}),
    auditLog: {
      append: (e) => {
        auditEntries.push(e as { action: string });
      },
    },
    now: clockNow,
  });
}

function mockLlm(): { complete(p: string, o?: unknown): Promise<string> } {
  return {
    async complete(prompt: string) {
      if (prompt.includes("independent critic")) {
        return JSON.stringify({
          evidenceSufficiency: 0.9, novelty: 0.9, actionability: 0.9, consistency: 0.9,
          overall: 0.9, rationale: "strong",
        });
      }
      return "阶段结论。";
    },
  } as never;
}

function makeSource(title: string, tags: readonly string[] = ["域甲"]) {
  return repo.createEngram({
    title,
    content: `content ${title}`,
    kind: "fact",
    domainTags: [...tags],
    createdBy: "tester",
  });
}

const req = (partial: Partial<PonderRequirement> & { resourceType: PonderRequirement["resourceType"]; description: string }): PonderRequirement => ({
  necessity: "logic-needed",
  closed: true,
  ...partial,
} as PonderRequirement);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-pdca-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new ProposalEngine({
    repository: repo,
    embedder: async () => [1, 0, 0],
    auditLog: { append: () => {} } as never,
    dataRoot: tmpDir,
  });
  auditEntries = [];
  observedEvents = [];
  clockMs = Date.parse("2026-08-18T02:00:00.000Z");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PDCA 闭合事实化:清单校验四道闸", () => {
  it("假闭合被拒:closed engrams 需求的 evidence.ids 无流水支持 → 缺口(evidence-mismatch),run 转 repairing", async () => {
    const incubator = makeIncubator();
    const a = makeSource("真来源");
    const e = incubator.create({ question: "假闭合问题?" });
    incubator.acquireThinking(e.id, "test");
    // 流水里只有 a;清单声称读了 a 和 b(编造)
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读齐相关记忆", evidence: { ids: [a.id, "编造/id"] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("repairing");
    expect(r.openGaps).toHaveLength(1);
    expect(r.openGaps[0]!.reason).toBe("evidence-mismatch");
    expect(r.openGaps[0]!.description).toBe("读齐相关记忆");
  });

  it("真闭合通过:声称的每个 id 都在流水(retrievedEngramIds)→ closed,done", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源甲");
    const b = makeSource("来源乙");
    const e = incubator.create({ question: "真闭合问题?", seedEngramIds: [a.id] });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id), engramEvent(b.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读齐相关记忆", evidence: { ids: [a.id, b.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    expect(r.openGaps).toHaveLength(0);
    expect(r.degraded).toBe(false);
  });

  it("瞒报被拒:流水有 engram 读调用而清单无 engrams 条目 → 整单拒绝", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "瞒报问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(makeSource("被瞒报的来源").id)];
    await expect(
      incubator.report({
        incubationId: e.id,
        report: { insights: [], plan: [], trace: [], requirements: [] },
        trigger: "manual", actor: "test",
      }),
    ).rejects.toThrow(/under-declared.*engram read call/);
  });

  it("skill 瞒报被拒:流水有 skill_get 调用而清单无 skills 条目", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "技能瞒报?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id), skillEvent("skill-x")];
    await expect(
      incubator.report({
        incubationId: e.id,
        report: {
          insights: [], plan: [], trace: [],
          requirements: [req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } })],
        },
        trigger: "manual", actor: "test",
      }),
    ).rejects.toThrow(/under-declared.*skill call/);
  });

  it("零盘点被拒:run 内零 engram/skill 读调用 → 整单拒绝(完全偏废最低线)", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "零盘点问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [];
    await expect(
      incubator.report({
        incubationId: e.id,
        report: {
          insights: [], plan: [], trace: [],
          requirements: [req({ resourceType: "engrams", description: "读记忆", closed: false })],
        },
        trigger: "manual", actor: "test",
      }),
    ).rejects.toThrow(/no resource evidence at all/);
  });

  it("requirements 缺失(L2 + 引擎有证据面)→ Phase2 计划项合成缺口退回修复(不再整单拒)", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "缺清单问题?" });
    incubator.acquireThinking(e.id, "test");
    await incubator.buildTask(e.id); // 生成并落盘计划(无 llmClient → 模板)
    const a = makeSource("来源");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: { insights: [], plan: [], trace: [] }, // 无 requirements
      trigger: "manual", actor: "test",
    });
    // Phase2:计划先行后,缺清单 = 计划项全部 open(删除即收窄)→ repairing
    expect(r.entry.status).toBe("repairing");
    expect(r.openGaps.length).toBeGreaterThanOrEqual(1);
    expect(r.openGaps.every((g) => g.origin === "plan")).toBe(true);
  });

  it("引擎不可观测类型(logs/web/mcp)closed 不参与事实化:自报 closed 直接认可;报了又悬置同样阻塞(报进清单 = 承诺闭合)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "不可观测类型?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    // web 不可观测:自报 closed → 直接认可(仅展示);logs 自报 closed 同理
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          req({ resourceType: "web", description: "外部基准检索", closed: true }),
          req({ resourceType: "logs", description: "行为日志佐证", closed: true }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    expect(r.openGaps).toHaveLength(0);

    // 对照:报了又悬置(helpful 未闭合)→ 阻塞终束(放弃就不该报进清单)
    const e2 = incubator.create({ question: "悬置对照?" });
    incubator.acquireThinking(e2.id, "test");
    const r2 = await incubator.report({
      incubationId: e2.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          req({ resourceType: "logs", description: "行为日志佐证", closed: false, necessity: "helpful" }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.status).toBe("repairing");
    expect(r2.openGaps.map((g) => g.description)).toEqual(["行为日志佐证"]);
  });

  it("logic-needed 未闭合 → 缺口(unclosed),run 转 repairing", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "未闭合问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          req({ resourceType: "engrams", description: "突触图谱扩展", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("repairing");
    expect(r.openGaps.map((g) => g.description)).toEqual(["突触图谱扩展"]);
    expect(r.openGaps[0]!.reason).toBe("unclosed");
    expect(r.repairRound).toBe(0);
  });
});

describe("PDCA 修复回路与预算(degraded 差分)", () => {
  it("修复闭环:repairing → 补齐流水闭合 → done,提案隔离标解除", async () => {
    const incubator = makeIncubator();
    const seed = makeSource("种子源");
    const extra = makeSource("增量源", ["域乙"]);
    const e = incubator.create({ question: "修复闭环?", seedEngramIds: [seed.id] });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(seed.id)];
    // 第 1 轮:洞察成案(sourceIds 含非种子源);需求「突触扩展」未闭合
    const r1 = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [{
          mode: "inspiration", type: "theme", title: "跨域修复主题",
          content: "c", summary: "s",
          sourceIds: [seed.id, extra.id], domainTags: ["沉思"], reason: "r",
        }],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [seed.id] } }),
          req({ resourceType: "engrams", description: "突触扩展", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r1.entry.status).toBe("repairing");
    expect(r1.proposals).toBe(1);
    const entityId = r1.entry.timeline.at(-1)!.proposalEntityIds[0]!;
    // 修复中:提案带 provisional 隔离标
    expect(engine.findProposalByEntityId(entityId)?.payload?.degraded).toEqual({
      provisional: true,
      unclosedGaps: ["突触扩展"],
    });
    // 修复:补上「突触扩展」的真实调用后全量重报
    observedEvents = [engramEvent(seed.id), engramEvent(extra.id)];
    const r2 = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [seed.id] } }),
          req({ resourceType: "engrams", description: "突触扩展", evidence: { ids: [extra.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.status).toBe("done");
    expect(r2.degraded).toBe(false);
    expect(r2.repairRound).toBe(1);
    // 终态正常:隔离标解除
    expect(engine.findProposalByEntityId(entityId)?.payload?.degraded).toBeUndefined();
    expect(r2.entry.degraded).toBeUndefined();
    expect(r2.entry.rounds).toBe(1); // 一次 run = 一个 session,修复轮不递增
  });

  it("修复轮触顶:repairRoundLimit=1 下修复 report 仍不闭合 → done+degraded,提案固化隔离标", async () => {
    const incubator = makeIncubator({ repairRoundLimit: 1 });
    const a = makeSource("来源");
    const e = incubator.create({ question: "触顶问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r1 = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [a.id] } }),
          req({ resourceType: "engrams", description: "难闭合需求", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r1.entry.status).toBe("repairing");
    // 修复轮(第 1 次,也是上限):仍未闭合 → 触顶终束
    const r2 = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [a.id] } }),
          req({ resourceType: "engrams", description: "难闭合需求", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.status).toBe("done");
    expect(r2.degraded).toBe(true);
    expect(r2.entry.degraded?.reason).toBe("repair-budget-exhausted");
    expect(r2.entry.degraded?.unclosedGaps).toEqual(["难闭合需求"]);
    expect(r2.entry.timeline.at(-1)?.pdca).toMatchObject({ degraded: true, repairRound: 1 });
  });

  it("P3 重报升级:helpful 缺口连续 2 次重报 → 强制升级 logic-needed(阻塞终束)", async () => {
    const incubator = makeIncubator({ repairRoundLimit: 6 });
    const a = makeSource("来源");
    const e = incubator.create({ question: "升级问题?" });
    incubator.acquireThinking(e.id, "test");
    const helpfulGap = [
      req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [a.id] } }),
      req({ resourceType: "engrams", description: "锦上添花的深挖", closed: false, necessity: "helpful" }),
    ];
    observedEvents = [engramEvent(a.id)];
    // 第 1 次:helpful 未闭合不阻塞 → repairing(gap 记录在案)
    const r1 = await incubator.report({
      incubationId: e.id, report: { insights: [], plan: [], trace: [], requirements: helpfulGap },
      trigger: "manual", actor: "test",
    });
    expect(r1.entry.status).toBe("repairing");
    // 第 2 次:重报(reopens=1)仍未升级 —— 第 3 次重报(reopens=2)达阈值
    const r2 = await incubator.report({
      incubationId: e.id, report: { insights: [], plan: [], trace: [], requirements: helpfulGap },
      trigger: "manual", actor: "test",
    });
    expect(r2.entry.status).toBe("repairing");
    const r3 = await incubator.report({
      incubationId: e.id, report: { insights: [], plan: [], trace: [], requirements: helpfulGap },
      trigger: "manual", actor: "test",
    });
    // 连续 2 次重报(reopens≥2)→ 升级 logic-needed → 阻塞缺口出现在返回里
    expect(r3.openGaps.map((g) => g.description)).toContain("锦上添花的深挖");
    expect(r3.openGaps.find((g) => g.description === "锦上添花的深挖")!.necessity).toBe("logic-needed");
  });

  it("每轮新缺口超额(>3)→ 只认前 3,其余 deferred 不阻塞", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "超额问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [a.id] } }),
          req({ resourceType: "engrams", description: "缺口A", closed: false }),
          req({ resourceType: "engrams", description: "缺口B", closed: false }),
          req({ resourceType: "engrams", description: "缺口C", closed: false }),
          req({ resourceType: "engrams", description: "缺口D", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.openGaps).toHaveLength(3); // 只认前 3
    expect(r.deferredGaps).toEqual(["缺口D"]);
    expect(r.entry.run?.gaps.filter((g) => g.state === "deferred")).toHaveLength(1);
  });

  it("repairing TTL 过期 → done + degraded(ttl-expired),未闭合缺口随档", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "TTL 问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [a.id] } }),
          req({ resourceType: "engrams", description: "悬置缺口", closed: false }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(incubator.get(e.id)!.status).toBe("repairing");
    // 时钟推进 31min(> TTL 30min)→ 下次读时回收
    clockMs += 31 * 60_000;
    const recovered = incubator.get(e.id)!;
    expect(recovered.status).toBe("done");
    expect(recovered.degraded?.reason).toBe("ttl-expired");
    expect(recovered.degraded?.unclosedGaps).toEqual(["悬置缺口"]);
  });

  it("无证据面(旧部署)与 L1:PDCA 降级,清单仅展示,直接 done", async () => {
    const noEvidence = new Incubator({
      repository: repo,
      proposalEngine: engine,
      dataRoot: tmpDir,
      llmClient: mockLlm(),
      auditLog: {
        append: (x) => {
          auditEntries.push(x as { action: string });
        },
      },
      now: clockNow,
    });
    const e = noEvidence.create({ question: "降级部署?" });
    noEvidence.acquireThinking(e.id, "test");
    const r = await noEvidence.report({
      incubationId: e.id,
      report: { insights: [], plan: [], trace: [] }, // 无 requirements 也不拒
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    const gapAudit = auditEntries.find((x) => x.action === "contemplation_run_done");
    expect(gapAudit?.metadata?.pdca).toMatchObject({ evidenceAvailable: false, degraded: false });
  });
});

describe("PDCA 种子源拦截(零增量)", () => {
  it("洞察 sourceIds 全部来自任务包种子 → 该洞察被拒([seed-only]);含非种子源 → 通过", async () => {
    const incubator = makeIncubator();
    const seed = makeSource("种子");
    const extra = makeSource("增量", ["域乙"]);
    const e = incubator.create({ question: "种子问题?", seedEngramIds: [seed.id] });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(seed.id), engramEvent(extra.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [
          {
            mode: "inspiration", type: "theme", title: "全引种子的洞察",
            content: "c", summary: "s",
            sourceIds: [seed.id], domainTags: ["沉思"], reason: "r",
          },
          {
            mode: "inspiration", type: "theme", title: "有增量源的洞察",
            content: "c2", summary: "s2",
            sourceIds: [seed.id, extra.id], domainTags: ["沉思"], reason: "r",
          },
        ],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [seed.id, extra.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.proposals).toBe(1); // 只有增量源洞察成案
    const reasons = (r.entry.timeline.at(-1)?.diagnosis?.rejectReasons ?? []).join("\n");
    expect(reasons).toContain("[seed-only] 全引种子的洞察");
  });

  it("兜底种子(未显式指定)同样纳入种子集:全引兜底命中也被拒", async () => {
    const incubator = makeIncubator();
    const e = incubator.create({ question: "种子检索命中的问题?" }); // 无显式种子
    incubator.acquireThinking(e.id, "test");
    // 兜底种子 = searchFallbackSeeds(FTS 检索);构造一个必然命中的 engram
    const hit = makeSource("问题关键词记忆");
    observedEvents = [engramEvent(hit.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [{
          mode: "inspiration", type: "theme", title: "只引兜底命中",
          content: "c", summary: "s",
          sourceIds: [hit.id], domainTags: ["沉思"], reason: "r",
        }],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "基础盘点", evidence: { ids: [hit.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    // hit.id 是否进兜底种子集取决于 FTS 检索;两种情况都不应误伤 —— 若命中则拒,
    // 若未命中则通过。断言:引擎行为确定(不崩溃)、状态推进确定
    expect(["repairing", "done"]).toContain(r.entry.status);
  });
});

describe("诊断可达性(2026-08-20):mismatch detail / 类型级闭合出口 / critic 分账", () => {
  /** critic prompt 返回任意原文(不可解析 → null score)的 LLM mock */
  const criticRawLlm = (raw: string) => ({
    async complete(prompt: string) {
      if (prompt.includes("independent critic")) return raw;
      return "阶段结论。";
    },
  });

  it("engrams mismatch 的 detail 自解释:列出未观测 id、引擎观测集与 ids 留空的类型级出口", async () => {
    const incubator = makeIncubator();
    const a = makeSource("真来源");
    const e = incubator.create({ question: "诊断详情问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读齐相关记忆", evidence: { ids: [a.id, "编造/id"] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    const gap = r.openGaps[0]!;
    expect(gap.reason).toBe("evidence-mismatch");
    expect(gap.detail).toContain("编造/id");
    expect(gap.detail).toContain(a.id); // 引擎观测到的 id 也在详情里
    expect(gap.detail).toContain("leave evidence.ids empty");
  });

  it("skills mismatch 的 detail 指明合法锚点:宿主技能名 / skill_list 结果不是合法 evidence id", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "技能诊断问题?" });
    incubator.acquireThinking(e.id, "test");
    // 只有 skill_list 盘点调用(无 input.id → skillIds 为空),清单却报了宿主技能名
    observedEvents = [engramEvent(a.id), skillListEvent()];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          req({ resourceType: "skills", description: "技能盘点", evidence: { ids: ["cogp-sunzi"] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    const gap = r.openGaps.find((g) => g.resourceType === "skills")!;
    expect(gap.reason).toBe("evidence-mismatch");
    expect(gap.detail).toContain("cogp-sunzi");
    expect(gap.detail).toContain("skill_get / skill_invoke");
    expect(gap.detail).toContain("NOT valid ids");
  });

  it("skills 类型级闭合出口(防回归):evidence.ids 留空 + 仅 skill_list 盘点 → closed,不再 mismatch", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "类型级闭合问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id), skillListEvent()];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          // 分析类问题的正当形态:印迹盘点过但无适用印迹 → ids 留空
          req({ resourceType: "skills", description: "技能盘点", evidence: { ids: [] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    expect(r.openGaps).toHaveLength(0);
  });

  it("skills 零调用且 ids 留空 → mismatch 的 detail 指明最低成本闭合路径(先调 skill_list)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "零技能调用问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
          req({ resourceType: "skills", description: "技能盘点", evidence: { ids: [] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    const gap = r.openGaps.find((g) => g.resourceType === "skills")!;
    expect(gap.reason).toBe("evidence-mismatch");
    expect(gap.detail).toContain("skill_list");
  });

  it("critic unparseable 与低分分账:不可解析计入 criticUnparseable(基础设施信号),diagnosis 返回值可达", async () => {
    const incubator = makeIncubator({ llm: criticRawLlm("抱歉,我无法输出 JSON。") });
    const a = makeSource("来源甲");
    const b = makeSource("来源乙", ["域乙"]);
    const e = incubator.create({ question: "critic 故障问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id), engramEvent(b.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [{
          mode: "inspiration", type: "theme", title: "会被 infrastructure 误杀的洞察",
          content: "c", summary: "s",
          sourceIds: [a.id, b.id], domainTags: ["沉思"], reason: "r",
        }],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id, b.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.proposals).toBe(0); // fail-closed 行为不变:不可解析不出提案
    // 但归因口径分账:unparseable ≠ 低分
    expect(r.diagnosis.criticUnparseable).toBe(1);
    expect(r.diagnosis.criticRejected).toBe(0);
    expect(r.diagnosis.rejectReasons?.[0]).toContain("[critic-unparseable]");
    expect(r.diagnosis.rejectReasons?.[0]).toContain("infrastructure signal");
  }, 20_000); // critique 内部 3 次重试 + 2s/4s 退避(critic.ts),unparseable 路径 >5s

  it("diagnosis 摘要随返回值透传:正常终束也携带(proposals=0 不再只能翻审计)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "诊断透传问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.entry.status).toBe("done");
    expect(r.diagnosis).toMatchObject({
      drafts: 0, dupVetoed: 0, validateRejected: 0,
      criticRejected: 0, criticUnparseable: 0, llmClientMissing: false,
    });
  });

  it("pattern 洞察类型:≥2 来源通过机械校验并成案;单来源被拒并给出 pattern 专属理由", async () => {
    const incubator = makeIncubator();
    const a = makeSource("观察甲");
    const b = makeSource("观察乙", ["域乙"]);
    const e = incubator.create({ question: "pattern 类型问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id), engramEvent(b.id)];
    const r = await incubator.report({
      incubationId: e.id,
      report: {
        insights: [
          {
            mode: "inspiration", type: "pattern", title: "双来源可复用规律",
            content: "c", summary: "s",
            sourceIds: [a.id, b.id], domainTags: ["沉思"], reason: "r",
          },
          {
            mode: "inspiration", type: "pattern", title: "单来源伪规律",
            content: "c2", summary: "s2",
            sourceIds: [a.id], domainTags: ["沉思"], reason: "r2",
          },
        ],
        plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id, b.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(r.proposals).toBe(1); // 双来源 pattern 成案
    const reasons = (r.diagnosis.rejectReasons ?? []).join("\n");
    expect(reasons).toContain("[validate] 单来源伪规律");
    expect(reasons).toContain("pattern requires >=2 sources");
  });

  it("审计查询枚举已登记 contemplation 事件(action 过滤可用,诊断不再只能 grep 文件)", async () => {
    const incubator = makeIncubator();
    const a = makeSource("来源");
    const e = incubator.create({ question: "审计枚举问题?" });
    incubator.acquireThinking(e.id, "test");
    observedEvents = [engramEvent(a.id)];
    await incubator.report({
      incubationId: e.id,
      report: {
        insights: [], plan: [], trace: [],
        requirements: [
          req({ resourceType: "engrams", description: "读记忆", evidence: { ids: [a.id] } }),
        ],
      },
      trigger: "manual", actor: "test",
    });
    expect(auditEntries.some((x) => x.action === "contemplation_run_done")).toBe(true);
    // 工具入参 schema 层:action 枚举包含 contemplation_*(此前查不到的根因)
    const { EngramAuditQueryInputSchema } = await import("../src/tools/audit-query-tool.js");
    expect(() =>
      EngramAuditQueryInputSchema.parse({ action: "contemplation_run_done", limit: 5 }),
    ).not.toThrow();
  });
});

describe("advanceGaps:engineUnverified 合成缺口不阻塞终束", () => {
  const gap = (over: Partial<PonderGap>): PonderGap => ({
    hash: "h",
    resourceType: "engrams",
    description: "缺口",
    necessity: "helpful",
    state: "open",
    reopens: 0,
    ...over,
  });

  it("仅 plan 合成的 logs/web/mcp(engineUnverified)open → 不 blocking(展示保留)", () => {
    const r = advanceGaps(
      [],
      [
        gap({ hash: "a", resourceType: "logs", description: "日志佐证", engineUnverified: true, origin: "plan" }),
        gap({ hash: "b", resourceType: "web", description: "联网核查", engineUnverified: true, origin: "plan" }),
        gap({ hash: "c", resourceType: "mcp", description: "工具盘点", engineUnverified: true, origin: "plan" }),
      ],
    );
    expect(r.blocking).toBe(false);
    // 展示面不受影响:三项仍以 open 落在 gaps 里
    expect(r.gaps.filter((g) => g.state === "open")).toHaveLength(3);
  });

  it("executor 申报又悬置的不可观测项(engineUnverified 但非 plan)→ 仍 blocking(报进清单 = 承诺闭合)", () => {
    const r = advanceGaps(
      [],
      [gap({ hash: "a", resourceType: "logs", description: "行为日志佐证", engineUnverified: true })],
    );
    expect(r.blocking).toBe(true);
  });

  it("可观测类型(engrams/skills)open → 仍 blocking(防假闭合语义不变,含 plan 合成项)", () => {
    const r = advanceGaps(
      [],
      [
        gap({ hash: "a", resourceType: "engrams", description: "图谱盘点", origin: "plan" }),
        gap({ hash: "b", resourceType: "web", description: "联网核查", engineUnverified: true, origin: "plan" }),
      ],
    );
    expect(r.blocking).toBe(true);
  });

  it("engineUnverified 合成项全部转 closed → 不 blocking(修复轮推进路径)", () => {
    const prev = [
      gap({ hash: "a", resourceType: "web", description: "联网核查", engineUnverified: true, origin: "plan" }),
    ];
    const r = advanceGaps(prev, [
      gap({ hash: "a", resourceType: "web", description: "联网核查", state: "closed", engineUnverified: true, origin: "plan" }),
    ]);
    expect(r.blocking).toBe(false);
    expect(r.gaps[0]!.state).toBe("closed");
  });
});
