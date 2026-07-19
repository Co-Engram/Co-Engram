import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  runRemDreaming,
  LocalHeuristicPatternAbstraction,
  clusterSimilarEngrams,
  type PatternAbstractionProvider,
  type AbstractionInput,
  type AbstractionOutput,
} from "../src/dreaming/rem.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rem-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  importance?: number;
  createdBy?: string;
  domainTags?: string[];
  kind?: "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content,
    kind: input.kind ?? "observation",
    domainTags: input.domainTags ?? ["t"],
    createdBy: input.createdBy ?? "y",
    importance: input.importance ?? 0.5,
  });
}

// ============================================================
// LocalHeuristicPatternAbstraction
// ============================================================

describe("LocalHeuristicPatternAbstraction", () => {
  const provider = new LocalHeuristicPatternAbstraction();

  it("空 cluster → confidence=0", () => {
    const result = provider.abstract({ engrams: [] });
    expect(result.confidence).toBe(0);
    expect(result.title).toMatch(/empty/);
  });

  it("相似 engram → 提取共同 token", () => {
    const result = provider.abstract({
      engrams: [
        {
          id: "a",
          title: "ADB 调试步骤 1",
          summary: "使用 adb wireless",
          content: "调试 Android 设备",
          domainTags: ["testing"],
        },
        {
          id: "b",
          title: "ADB 调试步骤 2",
          summary: "使用 adb wireless",
          content: "调试 Android 设备",
          domainTags: ["testing"],
        },
        {
          id: "c",
          title: "ADB 调试步骤 3",
          summary: "使用 adb wireless",
          content: "调试 Android 设备",
          domainTags: ["testing"],
        },
      ],
    });
    expect(result.title).toMatch(/从.*条相似记忆提炼的模式/);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.content).toContain("共同关键词");
  });

  it("无共同 token → 低 confidence", () => {
    const result = provider.abstract({
      engrams: [
        {
          id: "a",
          title: "ABC",
          summary: "aaa",
          content: "xxx yyy",
          domainTags: ["t"],
        },
        {
          id: "b",
          title: "DEF",
          summary: "bbb",
          content: "zzz www",
          domainTags: ["t"],
        },
        {
          id: "c",
          title: "GHI",
          summary: "ccc",
          content: "ppp qqq",
          domainTags: ["t"],
        },
      ],
    });
    expect(result.confidence).toBeLessThan(0.5);
  });
});

// ============================================================
// clusterSimilarEngrams
// ============================================================

describe("clusterSimilarEngrams", () => {
  it("空仓库 → 空 cluster", () => {
    expect(clusterSimilarEngrams(repo)).toEqual([]);
  });

  it("无相似 → 单节点不组 cluster", () => {
    makeEngram({ title: "完全独立 A", content: "独特内容 xyz" });
    makeEngram({ title: "完全独立 B", content: "完全不同 abc" });
    const clusters = clusterSimilarEngrams(repo);
    expect(clusters.length).toBe(0);
  });

  it("相似 engram → 组成 cluster", () => {
    makeEngram({
      title: "ADB 调试基础",
      content: "使用 adb wireless 调试 Android 设备",
    });
    makeEngram({
      title: "ADB 调试进阶",
      content: "使用 adb wireless 调试 Android 设备进阶",
    });
    makeEngram({
      title: "ADB 调试高级",
      content: "使用 adb wireless 调试 Android 设备高级",
    });
    const clusters = clusterSimilarEngrams(repo, { similarityThreshold: 0.3 });
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0]!.memberIds.length).toBeGreaterThanOrEqual(2);
  });

  it("跳过 archived", () => {
    const e = makeEngram({ title: "Archived", content: "archived content" });
    repo.updateLifecycle(e.id, "archived");
    const clusters = clusterSimilarEngrams(repo);
    expect(clusters.length).toBe(0);
  });
});

// ============================================================
// runRemDreaming
// ============================================================

describe("runRemDreaming", () => {
  it("空仓库 → 0 提案", async () => {
    const result = await runRemDreaming(repo);
    expect(result.proposals).toEqual([]);
    expect(result.adopted).toEqual([]);
  });

  it("相似 engram ≥ minClusterSize → 生成提案", async () => {
    for (let i = 0; i < 5; i++) {
      makeEngram({
        title: `ADB 调试观察 ${i}`,
        content: `使用 adb wireless 调试 Android 设备的场景 ${i}`,
      });
    }
    const result = await runRemDreaming(repo, {
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.3 },
    });
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0]!.sourceIds.length).toBeGreaterThanOrEqual(3);
  });

  it("confidence < threshold → 不自动采纳", async () => {
    // 用真正独立的内容（不同主题），避免 token 重叠
    makeEngram({ title: "天气观察", content: "今天晴朗 微风" });
    makeEngram({ title: "烹饪观察", content: "煮鸡蛋 需要 沸水" });
    makeEngram({ title: "运动观察", content: "跑步 有益 心肺" });
    const result = await runRemDreaming(repo, {
      minClusterSize: 2,
      clustering: { similarityThreshold: 0.05 }, // 极低阈值
      autoAdoptionThreshold: 0.99, // 设高门槛
    });
    expect(result.adopted.length).toBe(0);
  });

  it("高 confidence 自动采纳：创建 pattern engram + derives_from synapse", async () => {
    // 用 stub provider 强制返回高 confidence
    const stubProvider: PatternAbstractionProvider = {
      abstract(_input: AbstractionInput): AbstractionOutput {
        return {
          title: "Stub Pattern",
          content: "抽象内容",
          summary: "stub summary",
          confidence: 0.9,
          reason: "stub",
        };
      },
    };
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `相似观察 ${i}`,
        content: `adb wireless 调试 Android ${i}`,
      });
    }
    const result = await runRemDreaming(repo, {
      abstractionProvider: stubProvider,
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.2 },
      autoAdoptionThreshold: 0.85,
    });
    expect(result.adopted.length).toBeGreaterThan(0);
    const adopted = result.adopted[0]!;
    expect(repo.exists(adopted.patternEngramId)).toBe(true);

    // pattern engram kind = pattern
    const patternEngram = repo.readEngram(adopted.patternEngramId);
    expect(patternEngram.kind).toBe("pattern");

    // pattern 的 outgoing synapses 包含每个 source 的 derives_from
    const patternSynapses = repo.readSynapses(adopted.patternEngramId);
    const derivesTargets = new Set(
      patternSynapses.outgoing
        .filter((s) => s.kind === "derives_from")
        .map((s) => s.to),
    );
    for (const sourceId of adopted.proposal.sourceIds) {
      expect(derivesTargets.has(sourceId)).toBe(true);
    }
  });

  it("dryRun=true → 只生成提案不创建 pattern", async () => {
    const stubProvider: PatternAbstractionProvider = {
      abstract(): AbstractionOutput {
        return {
          title: "Stub",
          content: "c",
          summary: "s",
          confidence: 0.99,
          reason: "stub",
        };
      },
    };
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `观察 ${i}`,
        content: `adb wireless 调试 Android 设备 ${i}`,
      });
    }
    const result = await runRemDreaming(repo, {
      abstractionProvider: stubProvider,
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.2 },
      dryRun: true,
    });
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.adopted.length).toBe(0); // dryRun 不采纳
  });

  it("可注入自定义 abstractionProvider", async () => {
    let called = false;
    const stubProvider: PatternAbstractionProvider = {
      abstract(input: AbstractionInput): AbstractionOutput {
        called = true;
        return {
          title: `Custom: ${input.engrams.length}`,
          content: "custom",
          summary: "s",
          confidence: 0.5,
          reason: "custom",
        };
      },
    };
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `X ${i}`,
        content: `shared content ${i}`,
      });
    }
    await runRemDreaming(repo, {
      abstractionProvider: stubProvider,
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.1 },
    });
    expect(called).toBe(true);
  });

  it("skipped 提案有 reason", async () => {
    const stubProvider: PatternAbstractionProvider = {
      abstract(): AbstractionOutput {
        return {
          title: "Low Confidence",
          content: "c",
          summary: "s",
          confidence: 0.3,
          reason: "stub",
        };
      },
    };
    for (let i = 0; i < 3; i++) {
      makeEngram({
        title: `观察 ${i}`,
        content: `shared content ${i}`,
      });
    }
    const result = await runRemDreaming(repo, {
      abstractionProvider: stubProvider,
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.1 },
      autoAdoptionThreshold: 0.85,
    });
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]!.reason).toMatch(/confidence/);
  });
});

// ============================================================
// 端到端：spec 验收（10 个相似 observation → 1 个 pattern）
// ============================================================

describe("spec 验收：REM 模式发现", () => {
  it("10 个相似但独立的观察 → 至少 1 个 pattern 提案", async () => {
    // 创建 10 个关于同一主题但角度不同的 observation
    const observations = [
      "ADB wireless 调试 Android 设备的方法",
      "ADB wireless 调试 Android 设备的步骤",
      "ADB wireless 调试 Android 设备的常见问题",
      "ADB wireless 调试 Android 设备的最佳实践",
      "ADB wireless 调试 Android 设备的故障排查",
      "ADB wireless 调试 Android 设备的工具链",
      "ADB wireless 调试 Android 设备的配置流程",
      "ADB wireless 调试 Android 设备的端口配置",
      "ADB wireless 调试 Android 设备的连接方式",
      "ADB wireless 调试 Android 设备的优化技巧",
    ];
    for (const content of observations) {
      makeEngram({
        title: content.slice(0, 30),
        content,
        kind: "observation",
      });
    }

    const result = await runRemDreaming(repo, {
      minClusterSize: 3,
      clustering: { similarityThreshold: 0.3 },
      autoAdoptionThreshold: 0.5, // 降低门槛便于验收
    });

    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = result.proposals[0]!;
    expect(proposal.sourceIds.length).toBeGreaterThanOrEqual(3);
    expect(proposal.title).toMatch(/从.*条相似记忆提炼的模式/);
  });
});
