import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  DigestBuilder,
  collectDigestLines,
} from "../src/index/digest-builder.js";
import { GraphBuilder } from "../src/index/graph-builder.js";
import { IncrementalTracker } from "../src/index/incremental.js";
import { IndexOrchestrator } from "../src/index/orchestrator.js";
import type { EngramCreateInput } from "../src/types/index.js";

let tmpDir: string;
let cacheDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-idx-"));
  cacheDir = join(tmpDir, ".co-engram");
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(overrides: Partial<EngramCreateInput>): EngramCreateInput {
  return {
    title: "Sample",
    content: "content",
    kind: "fact",
    domainTags: ["testing"],
    createdBy: "tester",
    ...overrides,
  };
}

describe("DigestBuilder", () => {
  it("rebuild 全量构建 digest.jsonl", () => {
    repo.createEngram(makeEngram({ title: "A", domainTags: ["x"] }));
    repo.createEngram(makeEngram({ title: "B", domainTags: ["y"] }));

    const builder = new DigestBuilder(repo, cacheDir);
    const result = builder.rebuild();

    expect(result.total).toBe(2);
    expect(result.added).toBe(2);
    expect(existsSync(builder.digestFilePath)).toBe(true);
  });

  it("buildIncremental 首次等同 rebuild", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const builder = new DigestBuilder(repo, cacheDir);
    const result = builder.buildIncremental();

    expect(result.total).toBe(1);
    expect(result.added).toBe(1);
  });

  it("buildIncremental 第二次只处理变化", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const builder = new DigestBuilder(repo, cacheDir);
    builder.buildIncremental();

    // 不变化
    const result2 = builder.buildIncremental();
    expect(result2.added).toBe(0);
    expect(result2.updated).toBe(0);
    expect(result2.unchanged).toBe(1);
  });

  it("digest.jsonl 是合法 JSONL（每行一个 JSON 对象）", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const builder = new DigestBuilder(repo, cacheDir);
    builder.rebuild();

    const raw = readFileSync(builder.digestFilePath, "utf8");
    const lines = raw.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("readExisting 返回 id -> DigestLine 映射", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const builder = new DigestBuilder(repo, cacheDir);
    builder.rebuild();

    const existing = builder.readExisting();
    expect(existing.size).toBe(1);
  });
});

describe("collectDigestLines", () => {
  it("空仓库 → []", () => {
    expect(collectDigestLines(repo)).toEqual([]);
  });

  it("返回每个 engram 的真实 DigestLine(含 importance / retrievalCount)", () => {
    // 用真实 importance 创建,验证不是 stub 的 0.5
    const a = repo.createEngram({
      ...makeEngram({
        title: "高重要性记忆",
        content: "完整内容",
        domainTags: ["x"],
      }),
      importance: 0.9,
    });
    const b = repo.createEngram({
      ...makeEngram({
        title: "低重要性记忆",
        content: "次要内容",
        domainTags: ["y"],
      }),
      importance: 0.1,
    });

    const lines = collectDigestLines(repo);
    expect(lines).toHaveLength(2);

    const lineA = lines.find((l) => l.id === a.id);
    const lineB = lines.find((l) => l.id === b.id);
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    // 关键回归:不能是 stub 的 0.5
    expect(lineA!.importance).toBe(0.9);
    expect(lineB!.importance).toBe(0.1);
    // status / freshness / createdBy 应来自真实 engram,不是硬编码 'active' / 'fresh' / 'system'
    expect(lineA!.createdBy).toBe("tester");
  });

  it("不写 digest.jsonl 文件(纯内存)", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    collectDigestLines(repo);
    // 不应产生 digest.jsonl(DigestBuilder.rebuild 才会写)
    expect(existsSync(join(cacheDir, "digest.jsonl"))).toBe(false);
  });

  it("与 DigestBuilder.rebuild() 产出一致", () => {
    repo.createEngram({ ...makeEngram({ title: "A" }), importance: 0.7 });
    repo.createEngram({ ...makeEngram({ title: "B" }), importance: 0.3 });

    const lines = collectDigestLines(repo);
    const builder = new DigestBuilder(repo, cacheDir);
    builder.rebuild();
    const fromFile = Array.from(builder.readExisting().values());

    // 顺序可能不同,但内容应一致(按 id 排序后 deep equal)
    const byId = (arr: typeof lines) =>
      [...arr].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(byId(lines)).toEqual(byId(fromFile));
  });
});

describe("GraphBuilder", () => {
  it("rebuild 构建节点和边", () => {
    const a = repo.createEngram(makeEngram({ title: "A" }));
    const b = repo.createEngram(makeEngram({ title: "B" }));
    const builder = new GraphBuilder(repo, cacheDir);

    // 添加一条 synapse
    repo.addOutgoingSynapse(a.id, {
      id: "syn-1",
      from: a.id,
      to: b.id,
      kind: "similar_to",
      weight: 0.5,
      direction: "bidirectional",
      evidence: [],
      createdBy: "x",
      createdAt: "2026-06-20",
      updatedAt: "2026-06-20",
      retrievalWeight: 0.5,
    });

    const result = builder.rebuild();
    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);
  });

  it("read 返回完整 GraphIndex", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const builder = new GraphBuilder(repo, cacheDir);
    builder.rebuild();

    const idx = builder.read();
    expect(idx).not.toBeNull();
    expect(idx!.nodes).toHaveLength(1);
  });

  it("read 未构建返回 null", () => {
    const builder = new GraphBuilder(repo, cacheDir);
    expect(builder.read()).toBeNull();
  });
});

describe("IncrementalTracker", () => {
  it("初始无状态", () => {
    const tracker = new IncrementalTracker(cacheDir);
    expect(tracker.needsRebuild()).toBe(true);
    expect(tracker.readLastIndexedAt()).toBeNull();
  });

  it("updateLastIndexedAt 后状态可用", () => {
    const tracker = new IncrementalTracker(cacheDir);
    tracker.updateLastIndexedAt("2026-06-20T00:00:00.000Z");
    expect(tracker.readLastIndexedAt()).toBe("2026-06-20T00:00:00.000Z");
    expect(tracker.needsRebuild()).toBe(false);
  });
});

describe("IndexOrchestrator", () => {
  it("coldStartIfNeeded 空仓库时全量重建", () => {
    const orchestrator = new IndexOrchestrator(repo, cacheDir);
    const result = orchestrator.coldStartIfNeeded();
    expect(result).not.toBeNull();
    expect(result!.digest.total).toBe(0);
    expect(result!.graph.nodes).toBe(0);
  });

  it("coldStartIfNeeded 有数据时全量重建", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const orchestrator = new IndexOrchestrator(repo, cacheDir);
    const result = orchestrator.coldStartIfNeeded();
    expect(result!.digest.total).toBe(1);
  });

  it("coldStartIfNeeded 已构建且无变化时返回 null", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const orchestrator = new IndexOrchestrator(repo, cacheDir);
    orchestrator.coldStartIfNeeded();
    // 第二次（无变化）
    const result = orchestrator.coldStartIfNeeded();
    expect(result).toBeNull();
  });

  it("fullRebuild 强制全量", () => {
    repo.createEngram(makeEngram({ title: "A" }));
    const orchestrator = new IndexOrchestrator(repo, cacheDir);
    const result = orchestrator.fullRebuild();
    expect(result.digest.added).toBe(1);
  });
});
