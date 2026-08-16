import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngramRepository } from "../src/storage/repository.js";
import type { Synapse } from "../src/types/synapse.js";
import {
  buildModePrompt,
  buildNightThinkingL1Prompt,
  computeModeSignals,
  inspirationSeedFilter,
  retrospectiveSeedFilter,
} from "../src/maintenance/insight/modes.js";
import { buildSubgraph } from "../src/maintenance/insight/spread.js";
import type { InsightSubgraph } from "../src/maintenance/insight/types.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-insight-modes-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function make(title: string, domainTags: readonly string[] = ["t"]) {
  return repo.createEngram({
    title,
    content: `content of ${title}`,
    kind: "fact",
    domainTags: [...domainTags],
    createdBy: "tester",
  });
}

function link(from: string, to: string) {
  const ts = new Date().toISOString();
  const syn: Synapse = {
    id: randomUUID(),
    from,
    to,
    kind: "similar_to",
    weight: 0.8,
    evidence: [],
    createdBy: "tester",
    createdAt: ts,
    updatedAt: ts,
    visibility: "public",
  };
  repo.addOutgoingSynapse(from, syn);
}

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

const EMPTY_SUB: InsightSubgraph = { nodes: [], edges: [], globalStats: {} };

describe("computeModeSignals", () => {
  it("整合:新突触 + 同域新增密集 → strength>0 且 detail 计数正确", () => {
    make("A", ["领域X"]);
    make("B", ["领域X"]);
    make("C", ["领域X"]);
    const a = make("D", ["领域X"]);
    const b = make("E", ["领域X"]);
    link(a.id, b.id);
    const signals = computeModeSignals(repo, {
      lastRemAt: PAST,
      hasActiveIncubation: false,
    });
    const integration = signals.find((s) => s.mode === "integration")!;
    expect(integration.strength).toBeGreaterThan(0);
    expect(integration.detail.newSynapses).toBe(1);
    expect(integration.detail.sameDomainNew).toBe(5);
  });

  it("复盘:failedUses≥3 记忆成为信号源与种子;洞察自复盘也入种子", () => {
    const failing = make("failing", ["t"]);
    repo.bumpRetrievalStats(failing.id, { failedDelta: 3 });
    // rem-insight 洞察自身 failedUses≥3 → 自复盘种子(自我修正闭环)
    const insight = repo.createEngram({
      title: "旧洞察",
      content: "old insight",
      kind: "pattern",
      domainTags: ["t"],
      createdBy: "tester",
      encodingContext: "rem-insight:abc",
    });
    repo.bumpRetrievalStats(insight.id, { failedDelta: 4 });
    const signals = computeModeSignals(repo, {
      lastRemAt: PAST,
      hasActiveIncubation: false,
    });
    const retro = signals.find((s) => s.mode === "retrospective")!;
    expect(retro.strength).toBeGreaterThan(0);
    expect(retro.detail.failingEngrams).toBe(2);
    const seedOk = retrospectiveSeedFilter(repo);
    expect(seedOk(failing.id)).toBe(true);
    expect(seedOk(insight.id)).toBe(true);
    const normal = make("normal", ["t"]);
    expect(seedOk(normal.id)).toBe(false);
  });

  it("灵感:新增 unseen 域触发;仅笼统标签新增不触发(脏标签库)", () => {
    make("old", ["已有域"]);
    // 在 old 与 new-cross 之间取 lastRemAt(sleep 保证 createdAt 可区分)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    const between = new Date().toISOString();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    make("new-cross", ["全新域"]); // createdAt > between → unseen 域
    make("dirty", ["imported", "uncategorized"]); // 笼统标签不计
    const signals = computeModeSignals(repo, {
      lastRemAt: between,
      hasActiveIncubation: false,
    });
    const inspiration = signals.find((s) => s.mode === "inspiration")!;
    expect(inspiration.strength).toBeGreaterThan(0);
    expect(inspiration.detail.crossDomainNew).toBe(1); // 仅全新域那条

    // 纯笼统标签库:全部 imported/uncategorized → crossDomainNew=0 → 恒不触发
    const tmp2 = mkdtempSync(join(tmpdir(), "co-engram-insight-dirty-"));
    const repo2 = new EngramRepository({ rootPath: tmp2 });
    repo2.createEngram({
      title: "old-dirty",
      content: "c",
      kind: "fact",
      domainTags: ["imported"],
      createdBy: "t",
    });
    repo2.createEngram({
      title: "new-dirty",
      content: "c",
      kind: "fact",
      domainTags: ["uncategorized"],
      createdBy: "t",
    });
    const s2 = computeModeSignals(repo2, {
      lastRemAt: PAST,
      hasActiveIncubation: false,
    });
    expect(s2.find((s) => s.mode === "inspiration")!.strength).toBe(0);
    rmSync(tmp2, { recursive: true, force: true });
  });

  it("存在 active 孵化条目 → 灵感强度提升(占最高优先级槽)", () => {
    make("old", ["域A"]);
    make("new", ["域B"]);
    const withInc = computeModeSignals(repo, {
      lastRemAt: PAST,
      hasActiveIncubation: true,
    });
    const noInc = computeModeSignals(repo, {
      lastRemAt: PAST,
      hasActiveIncubation: false,
    });
    expect(
      withInc.find((s) => s.mode === "inspiration")!.strength,
    ).toBeGreaterThan(
      noInc.find((s) => s.mode === "inspiration")!.strength,
    );
  });

  it("无事件兜底(一期):三个强度全 0", () => {
    make("A", ["t"]);
    const signals = computeModeSignals(repo, {
      lastRemAt: FUTURE,
      hasActiveIncubation: false,
    });
    for (const s of signals) {
      expect(s.strength).toBe(0);
    }
  });

  it("灵感种子约束:仅携带非笼统域标签的记忆", () => {
    const tagged = make("tagged", ["域A"]);
    const generic = make("generic", ["imported"]);
    const ok = inspirationSeedFilter(repo);
    expect(ok(tagged.id)).toBe(true);
    expect(ok(generic.id)).toBe(false);
  });
});

describe("buildModePrompt", () => {
  it("孵化条目存在时:首行锚定问题 + 梦境史回灌 + 不重复指令", () => {
    const a = make("A", ["域A"]);
    const sub = buildSubgraph(repo, {
      lastRemAt: PAST,
      maxNodes: 30,
      extraSeeds: [a.id],
    });
    const prompt = buildModePrompt("inspiration", sub, {
      incubation: {
        question: "如何让团队记忆系统自进化?",
        dreamHistory: "Round 1: 探索了 A 方向(dismissed: 证据不足)",
      },
    });
    const firstLine = prompt.split("\n")[0]!;
    expect(firstLine).toContain("如何让团队记忆系统自进化?");
    expect(prompt).toContain("Dream history");
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("do NOT repeat");
  });

  it("无孵化条目:不含锚定行,含模式指令与 JSON 输出契约", () => {
    const prompt = buildModePrompt("integration", EMPTY_SUB);
    expect(prompt).not.toContain("TASK (repeat)");
    expect(prompt).toContain("INTEGRATION mode");
    expect(prompt).toContain("JSON array");
  });

  it("复盘模式 prompt 含 AAR 四要素指令", () => {
    const prompt = buildModePrompt("retrospective", EMPTY_SUB);
    expect(prompt).toContain("expected");
    expect(prompt).toContain("actual");
    expect(prompt).toContain("cause");
    expect(prompt).toContain("improvement");
  });

  it("灵感模式 prompt 含 structure-mapping 指令(映射关系结构非表面词汇)", () => {
    const prompt = buildModePrompt("inspiration", EMPTY_SUB);
    expect(prompt).toContain("relational structure");
    expect(prompt).toContain("NOT surface vocabulary");
  });

  it("L1 夜思 prompt:锚定 + 梦境史 + 跨域指令", () => {
    const p = buildNightThinkingL1Prompt("问题 Q", "seed digests", "R1: 已探索 X");
    expect(p.split("\n")[0]).toContain("问题 Q");
    expect(p).toContain("R1: 已探索 X");
    expect(p).toContain("across domains");
  });
});

// ============================================================
// 审批反馈闭环(2026-08-16 用户灵感):被拒洞察 → 复盘信号/种子/prompt
// ============================================================
import { type DismissedInsight } from "../src/maintenance/insight/modes.js";

describe("审批反馈:被拒洞察进复盘", () => {
  const dismissed: readonly DismissedInsight[] = [
    { title: "被拒洞察甲", reason: "证据不足", sourceIds: [] },
    { title: "被拒洞察乙", reason: undefined, sourceIds: [] },
  ];

  it("dismissed 计数加权复盘强度", () => {
    const withD = computeModeSignals(repo, { lastRemAt: PAST, hasActiveIncubation: false, dismissedInsights: dismissed });
    const noD = computeModeSignals(repo, { lastRemAt: PAST, hasActiveIncubation: false });
    expect(withD.find((s) => s.mode === "retrospective")!.strength).toBeGreaterThan(noD.find((s) => s.mode === "retrospective")!.strength);
    expect(withD.find((s) => s.mode === "retrospective")!.detail.dismissedInsights).toBe(2);
  });

  it("被拒洞察来源纳入复盘种子", () => {
    const src = make("洞察来源", ["t"]);
    const ok = retrospectiveSeedFilter(repo, [{ title: "x", reason: "r", sourceIds: [src.id] }]);
    expect(ok(src.id)).toBe(true);
  });

  it("复盘 prompt 含被拒标题/理由/反思指令;无被拒或非复盘不含", () => {
    const p = buildModePrompt("retrospective", EMPTY_SUB, { dismissedInsights: dismissed });
    expect(p).toContain("被拒洞察甲");
    expect(p).toContain("证据不足");
    expect(p).toContain("dismissed reason: (未填)");
    expect(p).toContain("Retrospect on WHY");
    expect(buildModePrompt("retrospective", EMPTY_SUB)).not.toContain("dismissed reason");
    expect(buildModePrompt("integration", EMPTY_SUB, { dismissedInsights: dismissed })).not.toContain("dismissed reason");
  });
});

describe("模式长期校准(第二刀:accept 洞察模式分布)", () => {
  it("strength × factor 后夹回 [0,1];detail 暴露因子与样本数", () => {
    make("A", ["x"]);
    const noCal = computeModeSignals(repo, { lastRemAt: null, hasActiveIncubation: false });
    const cal = computeModeSignals(repo, {
      lastRemAt: null,
      hasActiveIncubation: false,
      modeCalibration: new Map([
        ["integration", { factor: 1.3, samples: 8, acceptRate: 1 }],
      ]),
    });
    const raw = noCal.find((s) => s.mode === "integration")!;
    const boosted = cal.find((s) => s.mode === "integration")!;
    expect(boosted.strength).toBeCloseTo(Math.min(1, raw.strength * 1.3), 9);
    expect(boosted.strength).toBeLessThanOrEqual(1);
    expect(boosted.detail.calibrationFactor).toBe(1.3);
    expect(boosted.detail.calibrationSamples).toBe(8);
    // 未校准的模式 detail 默认 factor=1 / samples=0
    expect(cal.find((s) => s.mode === "inspiration")!.detail.calibrationFactor).toBe(1);
    expect(cal.find((s) => s.mode === "inspiration")!.detail.calibrationSamples).toBe(0);
  });

  it("冷启动 factor=1 不改变强度", () => {
    make("A", ["x"]);
    const noCal = computeModeSignals(repo, { lastRemAt: null, hasActiveIncubation: false });
    const cal = computeModeSignals(repo, {
      lastRemAt: null,
      hasActiveIncubation: false,
      modeCalibration: new Map([
        ["integration", { factor: 1, samples: 2, acceptRate: 1 }],
      ]),
    });
    expect(cal.find((s) => s.mode === "integration")!.strength).toBe(
      noCal.find((s) => s.mode === "integration")!.strength,
    );
  });
});
