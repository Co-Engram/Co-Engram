import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  LocalHeuristicHypothesisProvider,
  generateHypotheses,
  verifyHypothesis,
  type HypothesisProvider,
  type HypothesisProviderInput,
  type HypothesisProviderOutput,
} from "../src/generative/index.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-hypothesis-"));
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
  createdBy?: string;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? input.title,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["testing"],
    createdBy: input.createdBy ?? "alice",
  });
}

/** 测试用 Provider：固定输出 */
class StubProvider implements HypothesisProvider {
  constructor(private readonly output: HypothesisProviderOutput) {}
  generate(_input: HypothesisProviderInput): HypothesisProviderOutput {
    return this.output;
  }
}

// ============================================================
// LocalHeuristicHypothesisProvider
// ============================================================

describe("LocalHeuristicHypothesisProvider", () => {
  it("空候选 → confidence=0", () => {
    const p = new LocalHeuristicHypothesisProvider();
    const out = p.generate({
      topic: "adb",
      engrams: [],
    });
    expect(out.confidence).toBe(0);
    expect(out.reason).toMatch(/no source/);
  });

  it("共现关键词 → 生成假设标题", () => {
    const p = new LocalHeuristicHypothesisProvider();
    const out = p.generate({
      topic: "android",
      engrams: [
        {
          id: "a",
          title: "adb wireless pairing",
          content: "use adb wireless for android",
          summary: "adb wireless",
          domainTags: ["android"],
          kind: "observation",
        },
        {
          id: "b",
          title: "wireless debugging android",
          content: "android wireless debugging broken",
          summary: "wireless debugging",
          domainTags: ["android"],
          kind: "observation",
        },
      ],
    });
    expect(out.title).toMatch(/Hypothesis/);
    expect(out.confidence).toBeGreaterThan(0);
    // android / wireless / adb / debugging 至少有 1 个共现
    expect(out.content).toMatch(/android|wireless|adb/);
  });

  it("无共现 → confidence=minConfidence", () => {
    const p = new LocalHeuristicHypothesisProvider({ minConfidence: 0.2 });
    const out = p.generate({
      topic: "misc",
      engrams: [
        {
          id: "a",
          title: "aaa bbb",
          content: "aaa bbb",
          summary: "aaa",
          domainTags: ["t"],
          kind: "observation",
        },
        {
          id: "b",
          title: "ccc ddd",
          content: "ccc ddd",
          summary: "ccc",
          domainTags: ["t"],
          kind: "observation",
        },
      ],
    });
    expect(out.confidence).toBe(0.2);
  });
});

// ============================================================
// generateHypotheses
// ============================================================

describe("generateHypotheses", () => {
  it("候选不足 minSources → 返回空 hypotheses", async () => {
    makeEngram({ title: "A", content: "a", domainTags: ["android"] });

    const result = await generateHypotheses(
      repo,
      new LocalHeuristicHypothesisProvider(),
      {
        topic: "android",
        domainTags: ["android"],
        minSources: 3,
        createdBy: "tester",
      },
    );

    expect(result.candidateCount).toBe(1);
    expect(result.hypotheses).toEqual([]);
    expect(result.persisted).toBe(false);
  });

  it("候选充足 → 生成假设 + 创建 hypothesis engram", async () => {
    makeEngram({
      title: "adb wireless pairing",
      content: "use adb wireless",
      domainTags: ["android"],
    });
    makeEngram({
      title: "wireless debugging",
      content: "android wireless debugging",
      domainTags: ["android"],
    });
    makeEngram({
      title: "wifi adb setup",
      content: "setup adb over wifi",
      domainTags: ["android"],
    });

    const result = await generateHypotheses(
      repo,
      new LocalHeuristicHypothesisProvider(),
      {
        topic: "android",
        domainTags: ["android"],
        minSources: 3,
        createdBy: "tester",
      },
    );

    expect(result.candidateCount).toBe(3);
    expect(result.hypotheses).toHaveLength(1);
    const h = result.hypotheses[0]!;
    expect(h.engramId).not.toBeNull();
    expect(h.adopted).toBe(true);

    // 验证创建的 engram
    const engram = repo.readEngram(h.engramId!);
    expect(engram.kind).toBe("hypothesis");
    expect(engram.sourceType).toBe("inferred");
    expect(engram.verificationStatus).toBe("unverified");

    // 验证 derives_from synapse
    const syns = repo.readSynapses(h.engramId!);
    expect(syns.outgoing.length).toBe(3);
    expect(syns.outgoing.every((s) => s.kind === "derives_from")).toBe(true);
  });

  it("dryRun=true → 只返回 proposal，不创建 engram", async () => {
    makeEngram({
      title: "adb 1",
      content: "adb wireless",
      domainTags: ["android"],
    });
    makeEngram({
      title: "adb 2",
      content: "adb wireless",
      domainTags: ["android"],
    });
    makeEngram({
      title: "adb 3",
      content: "adb wireless",
      domainTags: ["android"],
    });

    const result = await generateHypotheses(
      repo,
      new LocalHeuristicHypothesisProvider(),
      {
        topic: "android",
        domainTags: ["android"],
        createdBy: "tester",
        dryRun: true,
      },
    );

    expect(result.hypotheses).toHaveLength(1);
    expect(result.hypotheses[0]!.engramId).toBeNull();
    expect(result.hypotheses[0]!.adopted).toBe(false);
    expect(result.persisted).toBe(false);
  });

  it("confidence < autoAdoptionThreshold → 不创建 engram", async () => {
    makeEngram({ title: "aaa", content: "aaa", domainTags: ["misc"] });
    makeEngram({ title: "bbb", content: "bbb", domainTags: ["misc"] });
    makeEngram({ title: "ccc", content: "ccc", domainTags: ["misc"] });

    const result = await generateHypotheses(
      repo,
      new LocalHeuristicHypothesisProvider({ minConfidence: 0.3 }),
      {
        topic: "misc",
        domainTags: ["misc"],
        createdBy: "tester",
        autoAdoptionThreshold: 0.9, // 强制不采纳
      },
    );

    expect(result.hypotheses).toHaveLength(1);
    expect(result.hypotheses[0]!.engramId).toBeNull();
    expect(result.hypotheses[0]!.adopted).toBe(false);
    expect(result.hypotheses[0]!.reason).toMatch(/confidence/);
  });

  it("注入自定义 Provider → 使用其输出", async () => {
    makeEngram({ title: "A", content: "a", domainTags: ["x"] });
    makeEngram({ title: "B", content: "b", domainTags: ["x"] });
    makeEngram({ title: "C", content: "c", domainTags: ["x"] });

    const stub = new StubProvider({
      title: "Hypothesis: 自定义标题",
      content: "自定义内容",
      summary: "自定义摘要",
      confidence: 0.9,
      reason: "stub provider",
    });

    const result = await generateHypotheses(repo, stub, {
      topic: "x",
      domainTags: ["x"],
      createdBy: "tester",
    });

    expect(result.hypotheses[0]!.proposal.title).toBe("Hypothesis: 自定义标题");
    expect(result.hypotheses[0]!.proposal.confidence).toBe(0.9);
    expect(result.hypotheses[0]!.engramId).not.toBeNull();

    const engram = repo.readEngram(result.hypotheses[0]!.engramId!);
    expect(engram.title).toBe("Hypothesis: 自定义标题");
  });

  it("不召回其他 hypothesis 作为 source", async () => {
    makeEngram({
      title: "obs A",
      content: "a",
      kind: "observation",
      domainTags: ["x"],
    });
    makeEngram({
      title: "obs B",
      content: "b",
      kind: "observation",
      domainTags: ["x"],
    });
    makeEngram({
      title: "old hypothesis",
      content: "old",
      kind: "hypothesis",
      domainTags: ["x"],
    });

    const stub = new StubProvider({
      title: "Hypothesis: new",
      content: "new",
      summary: "new",
      confidence: 0.7,
      reason: "stub",
    });

    const result = await generateHypotheses(repo, stub, {
      topic: "x",
      domainTags: ["x"],
      createdBy: "tester",
    });

    // 只召回 2 个 observation（不召回 hypothesis）
    expect(result.candidateCount).toBe(2);
  });

  it("kind 优先级：observation 优先于 fact", async () => {
    // 5 个 fact + 3 个 observation（maxSources=5 应优先召回 observation）
    const obsIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `fact-${i}`,
        content: `fact-${i}`,
        kind: "fact",
        domainTags: ["x"],
      });
    }
    for (let i = 0; i < 3; i++) {
      const e = makeEngram({
        title: `obs-${i}`,
        content: `obs-${i}`,
        kind: "observation",
        domainTags: ["x"],
      });
      obsIds.push(e.id);
    }

    const stub = new StubProvider({
      title: "H",
      content: "h",
      summary: "h",
      confidence: 0.7,
      reason: "stub",
    });

    const result = await generateHypotheses(repo, stub, {
      topic: "x",
      domainTags: ["x"],
      maxSources: 5,
      createdBy: "tester",
    });

    expect(result.candidateCount).toBe(5);
    // proposal.sourceIds 中应包含 3 个 observation
    const sourceIds = result.hypotheses[0]!.proposal.sourceIds;
    const obsCount = sourceIds.filter((id) => obsIds.includes(id)).length;
    expect(obsCount).toBe(3);
  });

  it("domainTags 过滤：不匹配的 domain 不召回", async () => {
    makeEngram({ title: "A", content: "a", domainTags: ["android"] });
    makeEngram({ title: "B", content: "b", domainTags: ["ios"] });
    makeEngram({ title: "C", content: "c", domainTags: ["android"] });
    makeEngram({ title: "D", content: "d", domainTags: ["android"] });

    const stub = new StubProvider({
      title: "H",
      content: "h",
      summary: "h",
      confidence: 0.7,
      reason: "stub",
    });

    const result = await generateHypotheses(repo, stub, {
      topic: "android",
      domainTags: ["android"],
      createdBy: "tester",
    });

    expect(result.candidateCount).toBe(3); // 只有 3 个 android
  });

  it("hypothesis 创建后 verificationStatus=unverified", async () => {
    makeEngram({ title: "A", content: "a", domainTags: ["x"] });
    makeEngram({ title: "B", content: "b", domainTags: ["x"] });
    makeEngram({ title: "C", content: "c", domainTags: ["x"] });

    const stub = new StubProvider({
      title: "H",
      content: "h",
      summary: "h",
      confidence: 0.7,
      reason: "stub",
    });

    const result = await generateHypotheses(repo, stub, {
      topic: "x",
      domainTags: ["x"],
      createdBy: "tester",
    });

    const engram = repo.readEngram(result.hypotheses[0]!.engramId!);
    expect(engram.verificationStatus).toBe("unverified");
  });
});

// ============================================================
// verifyHypothesis
// ============================================================

describe("verifyHypothesis", () => {
  async function setupHypothesis() {
    makeEngram({ title: "A", content: "a", domainTags: ["x"] });
    makeEngram({ title: "B", content: "b", domainTags: ["x"] });
    makeEngram({ title: "C", content: "c", domainTags: ["x"] });

    const stub = new StubProvider({
      title: "H",
      content: "h",
      summary: "h",
      confidence: 0.7,
      reason: "stub",
    });
    const result = await generateHypotheses(repo, stub, {
      topic: "x",
      domainTags: ["x"],
      createdBy: "tester",
    });
    return result.hypotheses[0]!.engramId!;
  }

  it("engram 不存在 → 抛错", () => {
    expect(() =>
      verifyHypothesis(repo, "no/such", "verified", {
        description: "x",
        verifiedBy: "y",
      }),
    ).toThrow(/not found/);
  });

  it("非 hypothesis engram → 抛错", () => {
    const e = makeEngram({ title: "fact", kind: "fact" });
    expect(() =>
      verifyHypothesis(repo, e.id, "verified", {
        description: "x",
        verifiedBy: "y",
      }),
    ).toThrow(/not a hypothesis/);
  });

  it("verified → verificationStatus 升级为 verified", async () => {
    const hid = await setupHypothesis();
    const result = verifyHypothesis(repo, hid, "verified", {
      description: "通过 10 次实验验证",
      verifiedBy: "alice",
      confidence: 0.95,
    });

    expect(result.previousStatus).toBe("unverified");
    expect(result.newStatus).toBe("verified");
    expect(result.evidenceAppended).toBe(true);

    const engram = repo.readEngram(hid);
    expect(engram.verificationStatus).toBe("verified");
  });

  it("refuted → verificationStatus=refuted", async () => {
    const hid = await setupHypothesis();
    const result = verifyHypothesis(repo, hid, "refuted", {
      description: "反例：在 iOS 上不工作",
      verifiedBy: "bob",
    });

    expect(result.newStatus).toBe("refuted");
    const engram = repo.readEngram(hid);
    expect(engram.verificationStatus).toBe("refuted");
  });

  it("plausible → verificationStatus=plausible", async () => {
    const hid = await setupHypothesis();
    const result = verifyHypothesis(repo, hid, "plausible", {
      description: "部分证据支持",
      verifiedBy: "carol",
    });

    expect(result.newStatus).toBe("plausible");
  });

  it("evidence 追加到 derives_from synapse", async () => {
    const hid = await setupHypothesis();
    const before = repo
      .readSynapses(hid)
      .outgoing.find((s) => s.kind === "derives_from")!;
    expect(before.evidence).toHaveLength(1); // 初始有 1 条（generateHypotheses 加的）

    verifyHypothesis(repo, hid, "verified", {
      description: "验证通过",
      verifiedBy: "tester",
    });

    const after = repo
      .readSynapses(hid)
      .outgoing.find((s) => s.kind === "derives_from")!;
    expect(after.evidence).toHaveLength(2);
    expect(after.evidence[1]!.description).toMatch(/\[verified\] 验证通过/);
  });

  it("多次验证 → evidence 累加", async () => {
    const hid = await setupHypothesis();

    verifyHypothesis(repo, hid, "plausible", {
      description: "初次",
      verifiedBy: "a",
    });
    verifyHypothesis(repo, hid, "verified", {
      description: "再次",
      verifiedBy: "b",
    });

    const syn = repo
      .readSynapses(hid)
      .outgoing.find((s) => s.kind === "derives_from")!;
    expect(syn.evidence).toHaveLength(3); // 1 初始 + 2 验证
  });
});

// ============================================================
// spec 验收：5+ 相关 engram → 1+ 合理假设
// ============================================================

describe("spec 验收", () => {
  it("给定 5+ 相关 engram → 生成 1+ 合理假设", async () => {
    // 5 个 adb 相关 observation
    makeEngram({
      title: "adb wireless pairing",
      content: "use adb wireless for android",
      domainTags: ["android"],
    });
    makeEngram({
      title: "wireless debugging setup",
      content: "android wireless debugging via adb",
      domainTags: ["android"],
    });
    makeEngram({
      title: "adb over wifi",
      content: "connect adb over wifi network",
      domainTags: ["android"],
    });
    makeEngram({
      title: "tcpip adb mode",
      content: "adb tcpip mode configuration",
      domainTags: ["android"],
    });
    makeEngram({
      title: "pairing code adb",
      content: "pairing code for adb wireless",
      domainTags: ["android"],
    });

    const result = await generateHypotheses(
      repo,
      new LocalHeuristicHypothesisProvider(),
      {
        topic: "android adb wireless",
        domainTags: ["android"],
        createdBy: "tester",
      },
    );

    expect(result.candidateCount).toBe(5);
    expect(result.hypotheses.length).toBeGreaterThanOrEqual(1);

    const h = result.hypotheses[0]!;
    expect(h.adopted).toBe(true);
    expect(h.engramId).not.toBeNull();

    // 验证 engram 结构
    const engram = repo.readEngram(h.engramId!);
    expect(engram.kind).toBe("hypothesis");
    expect(engram.verificationStatus).toBe("unverified");
    expect(engram.sourceType).toBe("inferred");

    // derives_from 5 个 source
    const syns = repo.readSynapses(h.engramId!);
    expect(syns.outgoing.length).toBe(5);
  });
});
