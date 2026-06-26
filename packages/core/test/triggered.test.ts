import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  onEngramCreated,
  createTriggeredEvolutionHandler,
  DEFAULT_TRIGGERED_CONFIG,
  type TriggeredEvolutionConfig,
} from "../src/evolution/triggered.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-triggered-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content?: string;
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
  domainTags?: readonly string[];
  contextTags?: readonly string[];
  createdBy?: string;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["t"],
    contextTags: input.contextTags,
    createdBy: input.createdBy ?? "y",
  });
}

// ============================================================
// DEFAULT_TRIGGERED_CONFIG
// ============================================================

describe("DEFAULT_TRIGGERED_CONFIG", () => {
  it("包含所有字段且符合 spec", () => {
    expect(DEFAULT_TRIGGERED_CONFIG.minDomainTagOverlap).toBe(1);
    expect(DEFAULT_TRIGGERED_CONFIG.minContextTagOverlap).toBe(1);
    expect(DEFAULT_TRIGGERED_CONFIG.newSynapseWeight).toBe(0.3);
    expect(DEFAULT_TRIGGERED_CONFIG.synapseBoost).toBe(0.05);
    expect(DEFAULT_TRIGGERED_CONFIG.maxSynapseWeight).toBe(1.0);
    expect(DEFAULT_TRIGGERED_CONFIG.minContradictionKeywordOverlap).toBe(2);
    expect(DEFAULT_TRIGGERED_CONFIG.excludeSelf).toBe(true);
  });
});

// ============================================================
// onEngramCreated — 基础路径
// ============================================================

describe("onEngramCreated — 基础路径", () => {
  it("newEngramId 不存在时抛错", () => {
    expect(() => onEngramCreated(repo, "no/such/id")).toThrow(
      /Engram not found/,
    );
  });

  it("仓库为空时（只有 newEngram 自己）返回空记录", () => {
    const e = makeEngram({ title: "A", content: "a", domainTags: ["t"] });
    const result = onEngramCreated(repo, e.id);

    expect(result.newEngramId).toBe(e.id);
    expect(result.overlapCount).toBe(0);
    expect(result.reshapings).toEqual([]);
    expect(result.potentialContradictions).toEqual([]);
    expect(result.persisted).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("只有自身时不计入模式重复", () => {
    const e = makeEngram({ title: "A", content: "a", domainTags: ["t"] });
    const result = onEngramCreated(repo, e.id);
    expect(result.patternRepeats).toEqual([]);
  });
});

// ============================================================
// Synapse 重塑
// ============================================================

describe("Synapse 重塑", () => {
  it("domainTags 重叠 → 创建 similar_to（权重 newSynapseWeight）", () => {
    const a = makeEngram({
      title: "A",
      content: "a content",
      domainTags: ["android", "testing"],
    });
    const b = makeEngram({
      title: "B",
      content: "b content",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.overlapCount).toBe(1);
    expect(result.reshapings).toHaveLength(1);
    expect(result.reshapings[0]!.otherEngramId).toBe(a.id);
    expect(result.reshapings[0]!.action).toBe("created");
    expect(result.reshapings[0]!.kind).toBe("similar_to");
    expect(result.reshapings[0]!.weight).toBe(
      DEFAULT_TRIGGERED_CONFIG.newSynapseWeight,
    );

    // 持久化
    const bSynapses = repo.readSynapses(b.id);
    expect(bSynapses.outgoing).toHaveLength(1);
    expect(bSynapses.outgoing[0]!.to).toBe(a.id);
    expect(bSynapses.outgoing[0]!.kind).toBe("similar_to");
    expect(bSynapses.outgoing[0]!.direction).toBe("bidirectional");
  });

  it("contextTags 重叠也触发 similar_to", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["t1"],
      contextTags: ["pairing", "debug"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["t2"],
      contextTags: ["pairing"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.overlapCount).toBe(1);
    expect(result.reshapings[0]!.action).toBe("created");
  });

  it("无 tag 重叠 → 不创建 synapse", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
      contextTags: ["pairing"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["ios"],
      contextTags: ["debug"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.overlapCount).toBe(0);
    expect(result.reshapings).toEqual([]);
  });

  it("已有 similar_to outgoing → boost 权重（Hebbian 强化）", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    // 第一次：A 创建时 B 还不存在；这里直接手动加 A→B similar_to
    repo.addOutgoingSynapse(b.id, {
      id: "manual-syn-1",
      from: b.id,
      to: a.id,
      kind: "similar_to",
      weight: 0.4,
      direction: "bidirectional",
      evidence: [],
      createdBy: "test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.4,
    });

    // 现在 B 再次"被创建"时（模拟再次触发）：A 应被 boost
    const result = onEngramCreated(repo, b.id, {
      nowIso: "2026-06-01T00:00:00Z",
    });

    const boost = result.reshapings.find((r) => r.otherEngramId === a.id);
    expect(boost).toBeDefined();
    expect(boost!.action).toBe("boosted");
    expect(boost!.previousWeight).toBe(0.4);
    expect(boost!.weight).toBeCloseTo(
      0.4 + DEFAULT_TRIGGERED_CONFIG.synapseBoost,
      6,
    );

    // 持久化
    const bSynapses = repo.readSynapses(b.id);
    const syn = bSynapses.outgoing.find((s) => s.to === a.id);
    expect(syn!.weight).toBeCloseTo(
      0.4 + DEFAULT_TRIGGERED_CONFIG.synapseBoost,
      6,
    );
    expect(syn!.updatedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("已有 similar_to incoming（A→newEngram）→ 跳过创建（避免重复）", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    // 已有 A→B
    repo.addOutgoingSynapse(a.id, {
      id: "a-to-b",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.4,
      direction: "bidirectional",
      evidence: [],
      createdBy: "test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 0.4,
    });

    // 触发：B 应识别 incoming，不重复创建
    const result = onEngramCreated(repo, b.id);

    const reshapeForA = result.reshapings.find((r) => r.otherEngramId === a.id);
    expect(reshapeForA).toBeUndefined();

    // B 不应有 outgoing（因为已有 incoming 等价连接）
    const bSynapses = repo.readSynapses(b.id);
    expect(bSynapses.outgoing.filter((s) => s.to === a.id)).toHaveLength(0);
  });

  it("权重已达上限 → skipped_existing_max", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    repo.addOutgoingSynapse(b.id, {
      id: "maxed-syn",
      from: b.id,
      to: a.id,
      kind: "similar_to",
      weight: 1.0, // 已达上限
      direction: "bidirectional",
      evidence: [],
      createdBy: "test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      retrievalWeight: 1.0,
    });

    const result = onEngramCreated(repo, b.id);
    const reshape = result.reshapings.find((r) => r.otherEngramId === a.id);
    expect(reshape).toBeDefined();
    expect(reshape!.action).toBe("skipped_existing_max");
    expect(reshape!.weight).toBe(1.0);
  });

  it("persist=false → 返回记录但不落盘", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id, { persist: false });

    expect(result.persisted).toBe(false);
    expect(result.reshapings).toHaveLength(1);

    // 未落盘
    const bSynapses = repo.readSynapses(b.id);
    expect(bSynapses.outgoing).toHaveLength(0);
  });

  it("自定义 config 生效", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    const custom: Partial<TriggeredEvolutionConfig> = {
      newSynapseWeight: 0.7,
    };

    const result = onEngramCreated(repo, b.id, { config: custom });
    expect(result.reshapings[0]!.weight).toBe(0.7);
  });

  it("minDomainTagOverlap=2 → 单标签重叠不再触发", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id, {
      config: { minDomainTagOverlap: 2 },
    });

    expect(result.overlapCount).toBe(0);
    expect(result.reshapings).toEqual([]);
  });
});

// ============================================================
// 模式重复检测
// ============================================================

describe("模式重复检测", () => {
  it("同 kind + 同 domainTags 多次出现 → 累计", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      kind: "observation",
      domainTags: ["android", "testing"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      kind: "observation",
      domainTags: ["testing", "android"],
    });

    // 先 trigger A（仓库只有 A）
    onEngramCreated(repo, a.id);
    // 再 trigger B
    const result = onEngramCreated(repo, b.id);

    expect(result.patternRepeats).toHaveLength(1);
    expect(result.patternRepeats[0]!.kind).toBe("observation");
    expect(result.patternRepeats[0]!.occurrences).toBe(2);
    expect(result.patternRepeats[0]!.siblingIds).toEqual([a.id, b.id].sort());
  });

  it("不同 kind → 不计入同一 bucket", () => {
    const a = makeEngram({
      title: "A",
      content: "a",
      kind: "observation",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["android"],
    });

    onEngramCreated(repo, a.id);
    const result = onEngramCreated(repo, b.id);

    expect(result.patternRepeats).toEqual([]);
  });

  it("3 次出现 → occurrences=3", () => {
    const a = makeEngram({ title: "A", kind: "fact", domainTags: ["x"] });
    const b = makeEngram({ title: "B", kind: "fact", domainTags: ["x"] });
    const c = makeEngram({ title: "C", kind: "fact", domainTags: ["x"] });

    onEngramCreated(repo, a.id);
    onEngramCreated(repo, b.id);
    const result = onEngramCreated(repo, c.id);

    expect(result.patternRepeats).toHaveLength(1);
    expect(result.patternRepeats[0]!.occurrences).toBe(3);
    expect(result.patternRepeats[0]!.siblingIds).toHaveLength(3);
  });
});

// ============================================================
// 潜在 contradiction 检测
// ============================================================

describe("潜在 contradiction 检测", () => {
  it("kind 不同 + 关键词重叠 → 记入 potentialContradictions", () => {
    const a = makeEngram({
      title: "A",
      content: "use adb wireless pairing for android debugging",
      kind: "observation",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "adb wireless debugging is broken on android",
      kind: "fact",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.potentialContradictions).toHaveLength(1);
    const pc = result.potentialContradictions[0]!;
    expect(pc.otherEngramId).toBe(a.id);
    expect(pc.newKind).toBe("fact");
    expect(pc.otherKind).toBe("observation");
    expect(pc.sharedKeywords.length).toBeGreaterThanOrEqual(2);
    // 共享 adb / wireless / debugging / android 等
    expect(pc.sharedKeywords).toContain("adb");
    expect(pc.sharedKeywords).toContain("android");
  });

  it("kind 相同 → 不视为潜在 contradiction", () => {
    const a = makeEngram({
      title: "A",
      content: "use adb wireless pairing",
      kind: "fact",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "adb wireless debugging",
      kind: "fact",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.potentialContradictions).toEqual([]);
  });

  it("关键词重叠不足 → 不记入", () => {
    const a = makeEngram({
      title: "A",
      content: "aaa bbb",
      kind: "observation",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "ccc ddd",
      kind: "fact",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);
    expect(result.potentialContradictions).toEqual([]);
  });

  it("中文 bigram 关键词检测", () => {
    const a = makeEngram({
      title: "A",
      content: "安卓调试使用无线配对",
      kind: "observation",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "安卓无线调试失败",
      kind: "fact",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);

    expect(result.potentialContradictions).toHaveLength(1);
    const pc = result.potentialContradictions[0]!;
    // 至少共享 2 个 bigram：安卓、调试、无线
    expect(pc.sharedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it("potentialContradiction 不自动创建 contradicts synapse", () => {
    const a = makeEngram({
      title: "A",
      content: "use adb wireless pairing for android debugging",
      kind: "observation",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "adb wireless debugging broken",
      kind: "fact",
      domainTags: ["android"],
    });

    const result = onEngramCreated(repo, b.id);

    // 仍然只创建 similar_to（domainTags 重叠），无 contradicts
    expect(result.reshapings.every((r) => r.kind === "similar_to")).toBe(true);

    const bSynapses = repo.readSynapses(b.id);
    expect(bSynapses.outgoing.every((s) => s.kind === "similar_to")).toBe(true);
  });
});

// ============================================================
// createTriggeredEvolutionHandler
// ============================================================

describe("createTriggeredEvolutionHandler", () => {
  it("返回一个可调用的 handler", () => {
    const handler = createTriggeredEvolutionHandler(repo);
    expect(typeof handler).toBe("function");

    const e = makeEngram({ title: "A", content: "a", domainTags: ["t"] });
    const result = handler(e.id);
    expect(result.newEngramId).toBe(e.id);
  });

  it("handler 绑定 config", () => {
    const handler = createTriggeredEvolutionHandler(repo, {
      newSynapseWeight: 0.9,
    });

    const a = makeEngram({
      title: "A",
      content: "a",
      domainTags: ["android"],
    });
    const b = makeEngram({
      title: "B",
      content: "b",
      domainTags: ["android"],
    });

    const result = handler(b.id);
    expect(result.reshapings[0]!.weight).toBe(0.9);
  });
});

// ============================================================
// 端到端集成
// ============================================================

describe("端到端：完整 evolution", () => {
  it("3 个相关 engram 依次创建 → 形成 similar_to 网络 + pattern repeat", () => {
    // a 创建并触发（仓库只有 a）
    const a = makeEngram({
      title: "Android ADB",
      content: "use adb wireless",
      kind: "observation",
      domainTags: ["android"],
    });
    const r1 = onEngramCreated(repo, a.id);
    expect(r1.reshapings).toEqual([]);

    // b 创建并触发：与 a 重叠 → 创建 b→a similar_to + pattern
    const b = makeEngram({
      title: "Android Pairing",
      content: "pairing via wifi",
      kind: "observation",
      domainTags: ["android"],
    });
    const r2 = onEngramCreated(repo, b.id);
    expect(r2.reshapings).toHaveLength(1);
    expect(r2.reshapings[0]!.otherEngramId).toBe(a.id);
    expect(r2.patternRepeats).toHaveLength(1);
    expect(r2.patternRepeats[0]!.occurrences).toBe(2);

    // c 创建并触发：与 a/b 都不重叠 → 无 synapse
    const c = makeEngram({
      title: "iOS Debug",
      content: "use xcode for ios",
      kind: "observation",
      domainTags: ["ios"],
    });
    const r3 = onEngramCreated(repo, c.id);
    expect(r3.reshapings).toEqual([]);
    // a, b pattern 仍然存在；c 自己是新 pattern（occurrences=1 → 不报告）
    expect(r3.patternRepeats).toHaveLength(1);
    expect(r3.patternRepeats[0]!.occurrences).toBe(2);
  });
});
