// runDeepThought 管线 + 存活期衰减监测(mock llmClient,两阶段 mock)
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import type { Synapse } from "../src/types/synapse.js";
import type { LlmClient } from "../src/observability/necessity-evaluator.js";
import {
  parseDrafts,
  runDeepThought,
  scanInsightDecay,
  type DeepThoughtProposalSink,
} from "../src/maintenance/insight/run.js";
import { refuteEngram } from "../src/verification/upgrade.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-run-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

function make(title: string, tags: readonly string[] = ["t"]) {
  return repo.createEngram({
    title,
    content: `content ${title}`,
    kind: "fact",
    domainTags: [...tags],
    createdBy: "tester",
  });
}

function link(from: string, to: string, kind: "derives_from" | "similar_to" = "similar_to") {
  const ts = new Date().toISOString();
  const syn: Synapse = {
    id: randomUUID(),
    from,
    to,
    kind,
    weight: 0.8,
    evidence: [],
    createdBy: "tester",
    createdAt: ts,
    updatedAt: ts,
    visibility: "public",
  };
  repo.addOutgoingSynapse(from, syn);
}

/** 两阶段 mock:第 1 次调用 = 模式生成,其后 = critic */
function twoPhaseClient(generation: string, critic: string | null): LlmClient & { calls: string[] } {
  const calls: string[] = [];
  let genCalled = false;
  return {
    calls,
    async complete(prompt: string) {
      calls.push(prompt);
      if (!genCalled) {
        genCalled = true;
        return generation;
      }
      if (critic === null) throw new Error("critic boom");
      return critic;
    },
  };
}

function criticJson(overall: number): string {
  return JSON.stringify({
    evidenceSufficiency: overall,
    novelty: overall,
    actionability: overall,
    consistency: overall,
    overall,
    rationale: "test rationale",
  });
}

/** 收集 proposeInsight 调用 + 已有提案列表(sink stub) */
function makeSink() {
  const proposed: Array<Record<string, unknown>> = [];
  const sink: DeepThoughtProposalSink = {
    proposeInsight(input) {
      proposed.push(input as unknown as Record<string, unknown>);
      return true;
    },
    listAll() {
      return [];
    },
  };
  return { sink, proposed };
}

const DRAFT_JSON = (a: string, b: string, extra = "") =>
  JSON.stringify([
    {
      type: "theme",
      title: `跨情境主题 ${a} ${b}`,
      content: `共性结构 ${a} ${b} ${extra}`,
      summary: "s",
      sourceIds: [a, b],
      domainTags: ["t"],
      reason: "r",
    },
  ]);

describe("runDeepThought", () => {
  it("enabled=false → skipped(disabled),零 LLM 调用", async () => {
    const llm = twoPhaseClient("[]", criticJson(0.9));
    const { sink } = makeSink();
    const r = await runDeepThought({
      repository: repo,
      proposalEngine: sink,
      llmClient: llm,
      lastRemAt: PAST,
      config: { enabled: false },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("disabled");
    expect(llm.calls).toHaveLength(0);
  });

  it("无事件信号(一期兜底)→ skipped(no-mode-signals),零 LLM 调用", async () => {
    make("A");
    const llm = twoPhaseClient("[]", criticJson(0.9));
    const { sink } = makeSink();
    const r = await runDeepThought({
      repository: repo,
      proposalEngine: sink,
      llmClient: llm,
      lastRemAt: FUTURE, // 未来 → 无事件
      config: { enabled: true },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("no-mode-signals");
    expect(llm.calls).toHaveLength(0);
  });

  it("llmClient 未注入 → skipped(no-llm-client)", async () => {
    make("A");
    const { sink } = makeSink();
    const r = await runDeepThought({
      repository: repo,
      proposalEngine: sink,
      lastRemAt: PAST,
      config: { enabled: true },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("no-llm-client");
  });

  it("critic 分 < 阈值 → 不出提案;≥ 阈值 → proposeInsight 被调", async () => {
    const a = make("甲", ["域甲"]);
    const b = make("乙", ["域乙"]);
    link(a.id, b.id);
    // 域不相交 + 低 Jaccard → 走 analogy 校验?这里产出 theme(整合模式种子来自事件)
    const low = twoPhaseClient(DRAFT_JSON(a.id, b.id), criticJson(0.3));
    const s1 = makeSink();
    const r1 = await runDeepThought({
      repository: repo,
      proposalEngine: s1.sink,
      llmClient: low,
      lastRemAt: PAST,
      config: { enabled: true, criticThreshold: 0.6 },
    });
    expect(r1.skipped).toBe(false);
    expect(r1.proposals).toBe(0);
    expect(r1.criticRejected).toBeGreaterThanOrEqual(1);
    expect(s1.proposed).toHaveLength(0);

    const hi = twoPhaseClient(DRAFT_JSON(a.id, b.id, "distinct"), criticJson(0.85));
    const s2 = makeSink();
    const r2 = await runDeepThought({
      repository: repo,
      proposalEngine: s2.sink,
      llmClient: hi,
      lastRemAt: PAST,
      config: { enabled: true, criticThreshold: 0.6 },
    });
    expect(r2.proposals).toBeGreaterThanOrEqual(1);
    expect(s2.proposed.length).toBe(r2.proposals);
    expect(s2.proposed[0]!.criticScore).toBe(0.85);
  });

  it("限流:critic 通过 7 条 → 只 propose 5 条(按 critic 分排序取 top)", async () => {
    const a = make("甲", ["域甲"]);
    const b = make("乙", ["域乙"]);
    const drafts = Array.from({ length: 7 }, (_, i) => ({
      type: "theme",
      title: `主题 ${i}`,
      content: `结构 ${i} unique${i} payload`,
      summary: "s",
      sourceIds: [a.id, b.id],
      domainTags: ["t"],
      reason: "r",
    }));
    let criticIdx = 0;
    const llm: LlmClient & { calls: string[] } = {
      calls: [],
      async complete(prompt: string) {
        (this as { calls: string[] }).calls.push(prompt);
        if (this.calls.length === 1) return JSON.stringify(drafts);
        criticIdx += 1;
        return criticJson(0.5 + criticIdx * 0.05); // 0.55..0.85 递增
      },
    };
    const s = makeSink();
    const r = await runDeepThought({
      repository: repo,
      proposalEngine: s.sink,
      llmClient: llm,
      lastRemAt: PAST,
      config: { enabled: true, criticThreshold: 0.5 },
    });
    expect(r.draftsGenerated).toBe(7);
    expect(r.proposals).toBe(5);
    expect(s.proposed).toHaveLength(5);
  });

  it("active 孵化条目 → 灵感模式占最高优先级槽(prompt 含锚定问题)", async () => {
    const old = make("old", ["域A"]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    const between = new Date().toISOString();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    make("new", ["域B"]); // 跨域新增 → inspiration 信号
    void old;
    const llm = twoPhaseClient("[]", criticJson(0.9));
    const { sink } = makeSink();
    await runDeepThought({
      repository: repo,
      proposalEngine: sink,
      llmClient: llm,
      lastRemAt: between,
      config: { enabled: true, modesPerRun: 1 },
      incubator: {
        activeEntries: () => [
          { id: "inc-1", question: "夜思问题 X", dreamHistory: "R1: 探索过 Y" },
        ],
      },
    });
    expect(llm.calls.length).toBeGreaterThanOrEqual(1);
    // 第一个调用即灵感模式 prompt:含锚定问题 + 梦境史
    expect(llm.calls[0]).toContain("夜思问题 X");
    expect(llm.calls[0]).toContain("R1: 探索过 Y");
  });

  it("生成 LLM 返回垃圾 JSON → 该模式跳过不抛错", async () => {
    const a = make("甲", ["域甲"]);
    link(a.id, make("乙", ["域乙"]).id);
    const llm = twoPhaseClient("这不是 JSON", criticJson(0.9));
    const { sink } = makeSink();
    const r = await runDeepThought({
      repository: repo,
      proposalEngine: sink,
      llmClient: llm,
      lastRemAt: PAST,
      config: { enabled: true },
    });
    expect(r.skipped).toBe(false);
    expect(r.proposals).toBe(0);
  });
});

describe("scanInsightDecay(存活期证据链衰减)", () => {
  let insightSeq = 0;
  function makeInsight(nSources: number, nInvalid: number) {
    insightSeq += 1;
    const srcs = Array.from({ length: nSources }, (_, i) => make(`来源${insightSeq}-${i}`, ["t"]));
    const insight = repo.createEngram({
      title: `洞察 ${insightSeq}-${nSources}-${nInvalid}`,
      content: "insight",
      kind: "pattern",
      domainTags: ["t"],
      createdBy: "tester",
      encodingContext: `rem-insight:${randomUUID().slice(0, 8)}`,
    });
    srcs.forEach((s, i) => link(insight.id, s.id, "derives_from"));
    // 把前 nInvalid 个来源 refute
    for (let i = 0; i < nInvalid; i++) {
      refuteEngram(repo, srcs[i]!.id, { description: "测试", verifiedBy: "t", confidence: 0.9 });
    }
    return insight;
  }

  it("对端 refuted 占比 > 30% → 入重审摘要;≤ 30% 不入;非洞察 derives_from 不审", async () => {
    const bad = makeInsight(3, 2); // 2/3 = 0.67 > 0.3
    const good = makeInsight(3, 0); // 0 ≤ 0.3
    // 普通人工 derives_from(无 rem-insight 标记)不审
    const normal1 = make("普通1", ["t"]);
    const normal2 = make("普通2", ["t"]);
    link(normal1.id, normal2.id, "derives_from");
    void good;
    const items = await scanInsightDecay(repo, tmpDir);
    expect(items.some((i) => i.engramId === bad.id)).toBe(true);
    expect(items.find((i) => i.engramId === bad.id)!.ratio).toBeCloseTo(0.67, 1);
    // 落盘 insight-review.json(持锁写:无 processLock 视为无条件持锁)
    const reviewPath = join(tmpDir, ".co-engram", "insight-review.json");
    expect(existsSync(reviewPath)).toBe(true);
    const file = JSON.parse(readFileSync(reviewPath, "utf8"));
    expect(file.items.some((i: { engramId: string }) => i.engramId === bad.id)).toBe(true);
  });

  it("processLock.isHolder=false → 不落盘但仍返回 items", async () => {
    const bad = makeInsight(2, 1);
    const items = await scanInsightDecay(repo, tmpDir, { isHolder: false });
    expect(items.some((i) => i.engramId === bad.id)).toBe(true);
    expect(existsSync(join(tmpDir, ".co-engram", "insight-review.json"))).toBe(false);
  });
});

describe("parseDrafts", () => {
  it("剥围栏解析数组;垃圾返回空;字段不全丢弃", () => {
    const mode = "integration" as const;
    expect(parseDrafts("```json\n[]\n```", mode)).toEqual([]);
    expect(parseDrafts("garbage", mode)).toEqual([]);
    const ok = parseDrafts(
      '```json\n[{"type":"theme","title":"t","content":"c","sourceIds":["a","b"]}]\n```',
      mode,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.mode).toBe("integration");
    expect(parseDrafts('[{"type":"unknown","title":"t","content":"c","sourceIds":[]}]', mode)).toHaveLength(0);
  });
});
