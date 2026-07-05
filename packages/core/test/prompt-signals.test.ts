import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePromptSignals,
  readPromptSignals,
  writePromptSignals,
  PROMPT_SIGNALS_FILENAME,
  EMPTY_PROMPT_SIGNALS,
  type ComputePromptSignalsOptions,
} from "../src/prompt-signals/index.js";
import { EngramRepository } from "../src/storage/repository.js";
import type { Engram } from "../src/types/engram.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "co-engram-signals-"));
}

function makeEngram(
  id: string,
  tags: readonly string[],
  overrides: Partial<Engram> = {},
): Engram {
  const now = new Date().toISOString();
  return {
    id,
    title: `Test ${id}`,
    contentHash: `sha256:${id}`,
    kind: "observation",
    kinds: ["observation"],
    domainTags: tags,
    content: `content for ${id}`,
    summary: `summary ${id}`,
    contentSize: 100,
    createdBy: "test",
    createdAt: now,
    updatedBy: "test",
    updatedAt: now,
    version: 1,
    importance: 0.5,
    confidence: 0.8,
    sourceType: "firsthand",
    evidenceCount: 0,
    retrievalCount: 0,
    effectiveRetrievals: 0,
    failedUses: 0,
    reinforcementScore: 0,
    decayHalfLifeDays: 90,
    outgoingSynapseCount: 0,
    incomingSynapseCount: 0,
    activeContradictionCount: 0,
    ...overrides,
  } as Engram;
}

function setupRepo(dir: string, engrams: readonly Engram[]): EngramRepository {
  const repo = new EngramRepository({ rootPath: dir });
  for (const e of engrams) {
    // createEngram 接受 importance/confidence;RPE 计数字段(retrievalCount 等)默认 0
    const created = repo.createEngram({
      title: e.title,
      content: e.content,
      kind: e.kind,
      domainTags: [...e.domainTags],
      createdBy: e.createdBy,
      importance: e.importance,
      confidence: e.confidence,
    });
    // retrievalCount/effectiveRetrievals/failedUses/reinforcementScore 通过 bumpRetrievalStats
    if (
      e.retrievalCount ||
      e.effectiveRetrievals ||
      e.failedUses ||
      e.reinforcementScore
    ) {
      repo.bumpRetrievalStats(created.id, {
        retrievedDelta: e.retrievalCount,
        effectiveDelta: e.effectiveRetrievals,
        failedDelta: e.failedUses,
        reinforcementDelta: e.reinforcementScore,
      });
    }
  }
  return repo;
}

describe("prompt-signals / computePromptSignals", () => {
  it("空 repository 返回空 signals", () => {
    const dir = makeTmp();
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const snapshot = computePromptSignals(repo);
      expect(snapshot.topTags).toEqual([]);
      expect(snapshot.missedTopics).toEqual([]);
      expect(snapshot.lowConfidenceTopics).toEqual([]);
      expect(snapshot.stats.totalEngrams).toBe(0);
      expect(snapshot.stats.uniqueTags).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("统计 topTags 频次降序", () => {
    const dir = makeTmp();
    try {
      const repo = setupRepo(dir, [
        makeEngram("e1", ["api", "design"]),
        makeEngram("e2", ["api", "frontend"]),
        makeEngram("e3", ["api", "design"]),
        makeEngram("e4", ["docs"]),
      ]);
      const snapshot = computePromptSignals(repo);
      // 'api' 出现 3 次,'design' 2 次,'frontend'/'docs' 1 次
      // minCount=3 → 只 'api' 入选
      expect(snapshot.topTags).toEqual(["api"]);
      expect(snapshot.stats.tagCounts.api).toBe(3);
      expect(snapshot.stats.tagCounts.design).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("minCount 阈值过滤低频 tag", () => {
    const dir = makeTmp();
    try {
      const repo = setupRepo(dir, [
        makeEngram("e1", ["x"]),
        makeEngram("e2", ["x"]),
        makeEngram("e3", ["y"]),
      ]);
      const options: ComputePromptSignalsOptions = { topTagsMinCount: 2 };
      const snapshot = computePromptSignals(repo, options);
      expect(snapshot.topTags).toEqual(["x"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("topTagsLimit 限制返回数量", () => {
    const dir = makeTmp();
    try {
      const repo = setupRepo(dir, [
        makeEngram("e1", ["a", "b", "c", "d"]),
        makeEngram("e2", ["a", "b", "c"]),
        makeEngram("e3", ["a", "b"]),
      ]);
      const snapshot = computePromptSignals(repo, {
        topTagsLimit: 2,
        topTagsMinCount: 1,
      });
      expect(snapshot.topTags.length).toBe(2);
      expect(snapshot.topTags[0]).toBe("a"); // 频次最高
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lowConfidenceTopics 收集频繁检索但低置信度的 tag", () => {
    const dir = makeTmp();
    try {
      const repo = setupRepo(dir, [
        // 频繁检索 + 低置信度 → 应入选
        makeEngram("e1", ["risky-topic"], {
          confidence: 0.2,
          retrievalCount: 5,
        }),
        makeEngram("e2", ["risky-topic"], {
          confidence: 0.3,
          retrievalCount: 3,
        }),
        // 高置信度 → 不入选
        makeEngram("e3", ["solid-topic"], {
          confidence: 0.9,
          retrievalCount: 10,
        }),
        // 低检索次数 → 不入选
        makeEngram("e4", ["unseen-topic"], {
          confidence: 0.1,
          retrievalCount: 1,
        }),
      ]);
      const snapshot = computePromptSignals(repo);
      expect(snapshot.lowConfidenceTopics).toContain("risky-topic");
      expect(snapshot.lowConfidenceTopics).not.toContain("solid-topic");
      expect(snapshot.lowConfidenceTopics).not.toContain("unseen-topic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missedTopics 暂为空(对话历史分析未接入)", () => {
    const dir = makeTmp();
    try {
      const repo = setupRepo(dir, [makeEngram("e1", ["topic"])]);
      const snapshot = computePromptSignals(repo);
      expect(snapshot.missedTopics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot 含 updatedAt + generatedBy", () => {
    const dir = makeTmp();
    try {
      const repo = new EngramRepository({ rootPath: dir });
      const snapshot = computePromptSignals(repo, {
        generatedBy: "test-runner",
      });
      expect(snapshot.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(snapshot.generatedBy).toBe("test-runner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prompt-signals / cache 读写", () => {
  it("writePromptSignals 创建 .co-engram/prompt-signals.json", async () => {
    const dir = makeTmp();
    try {
      await writePromptSignals(dir, {
        ...EMPTY_PROMPT_SIGNALS,
        topTags: ["api", "design"],
        updatedAt: "2026-06-21T00:00:00.000Z",
        generatedBy: "test",
      });
      const path = join(dir, ".co-engram", PROMPT_SIGNALS_FILENAME);
      expect(existsSync(path)).toBe(true);
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.topTags).toEqual(["api", "design"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPromptSignals 返回 undefined(文件不存在)", async () => {
    const dir = makeTmp();
    try {
      const result = await readPromptSignals(dir);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trip: 写入后读取保持一致", async () => {
    const dir = makeTmp();
    try {
      const snapshot = {
        ...EMPTY_PROMPT_SIGNALS,
        topTags: ["api"],
        lowConfidenceTopics: ["risky"],
        updatedAt: "2026-06-21T00:00:00.000Z",
        generatedBy: "test",
      };
      await writePromptSignals(dir, snapshot);
      const read = await readPromptSignals(dir);
      expect(read).toBeDefined();
      expect(read!.topTags).toEqual(["api"]);
      expect(read!.lowConfidenceTopics).toEqual(["risky"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPromptSignals 对损坏 JSON 返回 undefined", async () => {
    const dir = makeTmp();
    try {
      // 模拟损坏文件
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, ".co-engram"), { recursive: true });
      writeFileSync(
        join(dir, ".co-engram", PROMPT_SIGNALS_FILENAME),
        "{not valid json",
      );
      const result = await readPromptSignals(dir);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
