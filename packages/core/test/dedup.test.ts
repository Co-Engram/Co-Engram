import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { computeContentHash } from "../src/storage/hash.js";
import { findExactHashMatch, buildHashIndex } from "../src/dedup/hash.js";
import {
  tokenizeForDedup,
  jaccardSimilarity,
  TokenJaccardSimilarityEngine,
} from "../src/dedup/similar.js";
import {
  LocalHeuristicTriage,
  DEFAULT_THRESHOLDS,
} from "../src/dedup/llm-triage.js";
import { mergeEngram } from "../src/dedup/merge.js";
import { checkDuplicate } from "../src/dedup/dedupe.js";
import type {
  DedupCandidate,
  LlmTriageProvider,
  TriageInput,
  TriageResult,
} from "../src/dedup/types.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-dedup-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content: string;
  importance?: number;
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content,
    kind: "fact",
    domainTags: ["t"],
    createdBy: "y",
    importance: input.importance ?? 0.5,
  });
}

// ============================================================
// hash.ts
// ============================================================

describe("findExactHashMatch", () => {
  it("完全相同内容 → 命中", () => {
    const engram = makeEngram({ title: "A", content: "相同内容" });
    const hash = computeContentHash("相同内容");
    const found = findExactHashMatch(repo, hash);
    expect(found).toBe(engram.id);
  });

  it("不同内容 → 不命中", () => {
    makeEngram({ title: "A", content: "内容 A" });
    const hash = computeContentHash("内容 B");
    expect(findExactHashMatch(repo, hash)).toBeNull();
  });

  it("空 hash → null", () => {
    expect(findExactHashMatch(repo, "")).toBeNull();
  });

  it("空仓库 → null", () => {
    expect(findExactHashMatch(repo, "any")).toBeNull();
  });
});

describe("buildHashIndex", () => {
  it("构建 hash → id 映射", () => {
    const a = makeEngram({ title: "A", content: "内容 A" });
    const b = makeEngram({ title: "B", content: "内容 B" });
    const index = buildHashIndex(repo);
    expect(index.size).toBe(2);
    expect(index.get(computeContentHash("内容 A"))).toBe(a.id);
    expect(index.get(computeContentHash("内容 B"))).toBe(b.id);
  });
});

// ============================================================
// F2: stale entry 跳过(index 有 entry 但磁盘文件不存在)
//
// 场景:跨进程 race / 部分 crash 后 deleteEngram 部分失败,留下孤儿 entry。
// F2 修复前:readEngram 抛错 → 整个 dedupe 失败;或返回 stale targetId
// 作为 DUPLICATE → 用户无法重建同 contentHash 的 engram(死锁)。
// 修复后:stale entry 被跳过,继续走相似度召回或 NEW 路径。
// ============================================================

describe("findExactHashMatch (F2: stale entry 跳过)", () => {
  it("index entry 存在但文件已被外部删除 → 跳过,返回 null", () => {
    const engram = makeEngram({ title: "A", content: "相同内容" });
    const hash = computeContentHash("相同内容");

    // 模拟"index 仍有 entry,但文件被外部删除"的 stale 状态。
    // listEngramIndex 返回含 path 的完整 entry(避免依赖 private resolvePath)。
    const entry = repo.listEngramIndex().find((e) => e.id === engram.id);
    expect(entry).toBeDefined();
    unlinkSync(join(tmpDir, entry!.path));

    // listEngrams 仍能看到 entry(读 index)
    expect(repo.listEngrams().find((e) => e.id === engram.id)).toBeDefined();
    // 但 exists() 检查文件 → false
    expect(repo.exists(engram.id)).toBe(false);

    // F2 修复后:跳过 stale entry,不抛错,不误判 DUPLICATE
    expect(findExactHashMatch(repo, hash)).toBeNull();
  });

  it("多个 entry 中只有部分 stale → 仅跳过 stale 的,健康的仍能命中", () => {
    const stale = makeEngram({ title: "Stale", content: "stale 内容" });
    const healthy = makeEngram({ title: "Healthy", content: "healthy 内容" });

    // 删除 stale 的文件
    const staleEntry = repo.listEngramIndex().find((e) => e.id === stale.id);
    unlinkSync(join(tmpDir, staleEntry!.path));

    // healthy 的 hash 仍能命中
    const healthyHash = computeContentHash("healthy 内容");
    expect(findExactHashMatch(repo, healthyHash)).toBe(healthy.id);

    // stale 的 hash 跳过(返回 null)
    const staleHash = computeContentHash("stale 内容");
    expect(findExactHashMatch(repo, staleHash)).toBeNull();
  });

  it("readEngram 抛错(非 ENOENT)的 entry 也被跳过,不传播异常", () => {
    const engram = makeEngram({ title: "A", content: "x" });
    const hash = computeContentHash("x");

    // 删除文件模拟 readEngram 失败
    const entry = repo.listEngramIndex().find((e) => e.id === engram.id);
    unlinkSync(join(tmpDir, entry!.path));

    // 不抛错,返回 null
    expect(() => findExactHashMatch(repo, hash)).not.toThrow();
    expect(findExactHashMatch(repo, hash)).toBeNull();
  });
});

describe("buildHashIndex (F2: stale entry 跳过)", () => {
  it("index entry 存在但文件已被外部删除 → 不进 hash 映射", () => {
    const stale = makeEngram({ title: "Stale", content: "stale 内容" });
    const healthy = makeEngram({ title: "Healthy", content: "healthy 内容" });

    // 删除 stale 文件
    const staleEntry = repo.listEngramIndex().find((e) => e.id === stale.id);
    unlinkSync(join(tmpDir, staleEntry!.path));

    const index = buildHashIndex(repo);
    // 只包含 healthy 的,跳过 stale
    expect(index.size).toBe(1);
    expect(index.get(computeContentHash("healthy 内容"))).toBe(healthy.id);
    expect(index.has(computeContentHash("stale 内容"))).toBe(false);
  });
});

// ============================================================
// similar.ts
// ============================================================

describe("tokenizeForDedup", () => {
  it("空字符串 → 空 set", () => {
    expect(tokenizeForDedup("").size).toBe(0);
  });

  it("英文 word", () => {
    const tokens = tokenizeForDedup("hello world test");
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("test")).toBe(true);
  });

  it("中文 bigram + 单字", () => {
    const tokens = tokenizeForDedup("调试工具");
    expect(tokens.has("调试")).toBe(true);
    expect(tokens.has("试工")).toBe(true);
    expect(tokens.has("工具")).toBe(true);
    expect(tokens.has("调")).toBe(true);
    expect(tokens.has("试")).toBe(true);
  });

  it("大小写不敏感", () => {
    const tokens = tokenizeForDedup("Hello");
    expect(tokens.has("hello")).toBe(true);
  });
});

describe("jaccardSimilarity", () => {
  it("完全相同 → 1", () => {
    const a = tokenizeForDedup("hello world");
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it("完全不同 → 0", () => {
    const a = tokenizeForDedup("hello");
    const b = tokenizeForDedup("world");
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("部分重叠 → 中间值", () => {
    const a = tokenizeForDedup("hello world foo");
    const b = tokenizeForDedup("hello world bar");
    // intersection=2 (hello, world), union=4 → 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it("两个空集 → 0", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe("TokenJaccardSimilarityEngine", () => {
  it("findCandidates 返回按 similarity 倒序", async () => {
    makeEngram({ title: "Android ADB 调试", content: "adb wireless 调试方法" });
    makeEngram({ title: "OTA 升级", content: "ota 升级流程" });
    const engine = new TokenJaccardSimilarityEngine(repo);
    const candidates = await engine.findCandidates("ADB 调试", {
      topK: 5,
      minSimilarity: 0.1,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].similarity).toBeGreaterThanOrEqual(
      candidates[candidates.length - 1]!.similarity,
    );
    expect(candidates[0].title).toContain("ADB");
  });

  it("minSimilarity 过滤", async () => {
    makeEngram({ title: "Android ADB", content: "adb 调试" });
    makeEngram({ title: "完全不同", content: "无关内容" });
    const engine = new TokenJaccardSimilarityEngine(repo);
    const candidates = await engine.findCandidates("adb 调试", {
      topK: 5,
      minSimilarity: 0.3,
    });
    expect(candidates.length).toBe(1);
    expect(candidates[0].title).toBe("Android ADB");
  });

  it("topK 截断", async () => {
    makeEngram({ title: "A", content: "common word" });
    makeEngram({ title: "B", content: "common word" });
    makeEngram({ title: "C", content: "common word" });
    const engine = new TokenJaccardSimilarityEngine(repo);
    const candidates = await engine.findCandidates("common word", {
      topK: 2,
      minSimilarity: 0.1,
    });
    expect(candidates.length).toBe(2);
  });

  it("空查询 → 空", async () => {
    makeEngram({ title: "A", content: "x" });
    const engine = new TokenJaccardSimilarityEngine(repo);
    const candidates = await engine.findCandidates("", {
      topK: 5,
      minSimilarity: 0,
    });
    expect(candidates).toEqual([]);
  });

  it("稳定排序：同 similarity 按 id 字典序", async () => {
    makeEngram({ title: "A", content: "common word" });
    makeEngram({ title: "B", content: "common word" });
    const engine = new TokenJaccardSimilarityEngine(repo);
    const candidates = await engine.findCandidates("common word", {
      topK: 10,
      minSimilarity: 0.1,
    });
    // 同 similarity，按 id 字典序
    expect(candidates[0].id < candidates[1].id).toBe(true);
  });
});

// ============================================================
// llm-triage.ts
// ============================================================

describe("LocalHeuristicTriage", () => {
  it("无候选 → NEW", async () => {
    const triage = new LocalHeuristicTriage();
    const result = await triage.triage({
      newTitle: "A",
      newContent: "a",
      candidates: [],
    });
    expect(result.verdict).toBe("NEW");
  });

  it("hash 完全匹配 → DUPLICATE", async () => {
    const engram = makeEngram({ title: "A", content: "相同内容" });
    const triage = new LocalHeuristicTriage();
    const result = await triage.triage({
      newTitle: "A",
      newContent: "相同内容",
      candidates: [
        {
          id: engram.id,
          title: engram.title,
          summary: engram.summary,
          content: engram.content,
          contentHash: engram.contentHash,
          similarity: 1,
        },
      ],
    });
    expect(result.verdict).toBe("DUPLICATE");
    expect(result.duplicateOf).toBe(engram.id);
    expect(result.confidence).toBe(1);
  });

  it("title 相同 + 高相似度 → UPDATE", async () => {
    const engram = makeEngram({
      title: "ADB 调试",
      content: "使用 adb wireless 调试 Android 设备",
    });
    const triage = new LocalHeuristicTriage();
    // 新内容：title 相同 + 高重叠
    const newContent = "使用 adb wireless 调试 Android 设备的步骤";
    const result = await triage.triage({
      newTitle: "ADB 调试",
      newContent,
      candidates: [
        {
          id: engram.id,
          title: engram.title,
          summary: engram.summary,
          content: engram.content,
          contentHash: "fake",
          similarity: 0.8,
        },
      ],
    });
    expect(result.verdict).toBe("UPDATE");
    expect(result.updateTarget).toBe(engram.id);
  });

  it("极低相似度 → NEW", async () => {
    const engram = makeEngram({ title: "A", content: "foo bar" });
    const triage = new LocalHeuristicTriage();
    const result = await triage.triage({
      newTitle: "完全不同",
      newContent: "xyz zzz",
      candidates: [
        {
          id: engram.id,
          title: engram.title,
          summary: engram.summary,
          content: engram.content,
          contentHash: "fake",
          similarity: 0.1,
        },
      ],
    });
    expect(result.verdict).toBe("NEW");
  });

  it("DEFAULT_THRESHOLDS 值合理", () => {
    expect(DEFAULT_THRESHOLDS.titleMatchUpdateThreshold).toBe(0.7);
    expect(DEFAULT_THRESHOLDS.highSimilarityUpdateThreshold).toBe(0.85);
    expect(DEFAULT_THRESHOLDS.newRelatedThreshold).toBe(0.5);
  });
});

// ============================================================
// merge.ts
// ============================================================

describe("mergeEngram", () => {
  it("合并内容：version+1 + 更新字段", () => {
    const engram = makeEngram({ title: "原标题", content: "原内容" });
    const result = mergeEngram(repo, {
      id: engram.id,
      newTitle: "新标题",
      newContent: "新内容",
      mergedBy: "y2",
      reason: "内容更新",
    });
    expect(result.version).toBe(2);
    const updated = repo.readEngram(engram.id);
    expect(updated.title).toBe("新标题");
    expect(updated.content).toBe("新内容");
  });

  it("mergeHistoryEntry 含 fromHash/toHash", () => {
    const engram = makeEngram({ title: "A", content: "原内容" });
    const oldHash = engram.contentHash;
    const result = mergeEngram(repo, {
      id: engram.id,
      newContent: "新内容",
      mergedBy: "y",
      reason: "r",
    });
    expect(result.mergeHistoryEntry.fromHash).toBe(oldHash);
    expect(result.mergeHistoryEntry.toHash).not.toBe(oldHash);
    expect(result.mergeHistoryEntry.mergedBy).toBe("y");
    expect(result.mergeHistoryEntry.reason).toBe("r");
  });

  it("不存在抛错", () => {
    expect(() =>
      mergeEngram(repo, { id: "no/such", mergedBy: "y", reason: "r" }),
    ).toThrow(/not found/);
  });

  it("只更新 importance 不改 content", () => {
    const engram = makeEngram({ title: "A", content: "内容", importance: 0.5 });
    const result = mergeEngram(repo, {
      id: engram.id,
      newImportance: 0.9,
      mergedBy: "y",
      reason: "提升重要性",
    });
    expect(result.version).toBe(2);
    expect(repo.readEngram(engram.id).importance).toBe(0.9);
  });
});

// ============================================================
// dedupe.ts (端到端)
// ============================================================

describe("checkDuplicate", () => {
  it("精确匹配 → DUPLICATE", async () => {
    const engram = makeEngram({ title: "A", content: "相同内容" });
    const result = await checkDuplicate(
      { repository: repo },
      {
        title: "A",
        content: "相同内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    expect(result.verdict).toBe("DUPLICATE");
    expect(result.targetId).toBe(engram.id);
    expect(result.confidence).toBe(1);
  });

  it("完全不同 → NEW", async () => {
    makeEngram({ title: "A", content: "内容 A" });
    const result = await checkDuplicate(
      { repository: repo },
      {
        title: "B",
        content: "完全不同的内容 xyz",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    expect(result.verdict).toBe("NEW");
  });

  it("空仓库 → NEW", async () => {
    const result = await checkDuplicate(
      { repository: repo },
      {
        title: "A",
        content: "内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    expect(result.verdict).toBe("NEW");
  });

  it("可注入自定义 triageProvider", async () => {
    makeEngram({ title: "A", content: "内容" });
    const alwaysDuplicate: LlmTriageProvider = {
      async triage(_input: TriageInput): Promise<TriageResult> {
        return {
          verdict: "DUPLICATE",
          duplicateOf: "fake-id",
          reason: "stub",
          confidence: 0.99,
        };
      },
    };
    const result = await checkDuplicate(
      { repository: repo, options: { triageProvider: alwaysDuplicate } },
      {
        title: "B",
        content: "不同内容",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    expect(result.verdict).toBe("DUPLICATE");
    expect(result.targetId).toBe("fake-id");
  });

  it("candidatesConsidered 反馈候选数", async () => {
    makeEngram({ title: "A", content: "common" });
    makeEngram({ title: "B", content: "common" });
    const result = await checkDuplicate(
      { repository: repo, options: { minSimilarity: 0.1 } },
      {
        title: "C",
        content: "common",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    expect(result.candidatesConsidered).toBeGreaterThan(0);
  });
});

// ============================================================
// 自定义 SimilarityEngine + LlmTriageProvider 注入
// ============================================================

describe("自定义 SimilarityEngine", () => {
  it("可替换为 stub 实现", async () => {
    const stubEngine = {
      async findCandidates(): Promise<readonly DedupCandidate[]> {
        return [
          {
            id: "stub-id",
            title: "Stub",
            summary: "s",
            content: "c",
            contentHash: "fake",
            similarity: 0.99,
          },
        ];
      },
    };
    const result = await checkDuplicate(
      { repository: repo, options: { similarityEngine: stubEngine } },
      {
        title: "New",
        content: "New content",
        kind: "fact",
        domainTags: ["t"],
        createdBy: "y",
      },
    );
    // similarity 0.99 > 0.85 → UPDATE
    expect(result.verdict).toBe("UPDATE");
    expect(result.targetId).toBe("stub-id");
  });
});
