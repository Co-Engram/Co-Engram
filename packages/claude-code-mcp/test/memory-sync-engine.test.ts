import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "@co-engram/core";
import {
  AutoMemorySyncEngine,
  AUTO_MEMORY_DOMAIN_TAG,
  AUTO_MEMORY_ENCODING_PREFIX,
  encodingContextFor,
  mapAutoMemoryType,
  renderAutoMemoryContent,
} from "../src/memory-sync/sync-engine.js";
import type { ParsedAutoMemory } from "../src/memory-sync/memory-parser.js";

let tmpDir: string;
let repo: EngramRepository;
let engine: AutoMemorySyncEngine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-sync-engine-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  engine = new AutoMemorySyncEngine({
    repository: repo,
    defaultCreatedBy: "test-user",
    log: () => {},
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeParsed(overrides: Partial<ParsedAutoMemory> = {}): ParsedAutoMemory {
  return {
    slug: "test-slug",
    description: "test description",
    type: "feedback",
    body: "test body content",
    filePath: "/tmp/test-slug.md",
    ...overrides,
  };
}

describe("mapAutoMemoryType", () => {
  it("pattern → pattern", () => {
    expect(mapAutoMemoryType("pattern")).toBe("pattern");
  });
  it("feedback/user → observation", () => {
    expect(mapAutoMemoryType("feedback")).toBe("observation");
    expect(mapAutoMemoryType("user")).toBe("observation");
  });
  it("project/reference → fact", () => {
    expect(mapAutoMemoryType("project")).toBe("fact");
    expect(mapAutoMemoryType("reference")).toBe("fact");
  });
  it("procedure → procedure / hypothesis → hypothesis", () => {
    expect(mapAutoMemoryType("procedure")).toBe("procedure");
    expect(mapAutoMemoryType("hypothesis")).toBe("hypothesis");
  });
  it("未知 type → observation", () => {
    expect(mapAutoMemoryType("unknown-type")).toBe("observation");
    expect(mapAutoMemoryType("")).toBe("observation");
  });
});

describe("renderAutoMemoryContent", () => {
  it("description + body 拼接,中间空行", () => {
    const out = renderAutoMemoryContent(makeParsed());
    expect(out).toContain("> test description");
    expect(out).toContain("test body content");
  });
  it("description 为空 → 只有 body", () => {
    const out = renderAutoMemoryContent(makeParsed({ description: "" }));
    expect(out).not.toContain(">");
    expect(out).toContain("test body content");
  });
  it("body 为空 → 只有 description(以 > 开头)", () => {
    const out = renderAutoMemoryContent(makeParsed({ body: "" }));
    expect(out).toContain("> test description");
    expect(out.trim()).not.toContain("\n\n");
  });
  it("都为空 → 空字符串", () => {
    const out = renderAutoMemoryContent(makeParsed({ description: "", body: "" }));
    expect(out).toBe("");
  });
});

describe("encodingContextFor", () => {
  it("拼前缀和 slug", () => {
    expect(encodingContextFor("foo")).toBe(`${AUTO_MEMORY_ENCODING_PREFIX}foo`);
  });
});

describe("AutoMemorySyncEngine.syncMemory", () => {
  it("首次同步 → created,产生 engram 带 auto-memory domainTag + encodingContext", () => {
    const result = engine.syncMemory(makeParsed());
    expect(result.action).toBe("created");
    expect(result.engramId).toBeDefined();

    const engram = repo.readEngram(result.engramId!);
    expect(engram.domainTags).toContain(AUTO_MEMORY_DOMAIN_TAG);
    expect(engram.encodingContext).toBe(
      `${AUTO_MEMORY_ENCODING_PREFIX}test-slug`,
    );
    expect(engram.createdBy).toBe("test-user");
  });

  it("type=pattern → engram.kind = pattern + importance=0.7", () => {
    const result = engine.syncMemory(makeParsed({ type: "pattern" }));
    const engram = repo.readEngram(result.engramId!);
    expect(engram.kind).toBe("pattern");
    expect(engram.importance).toBe(0.7);
  });

  it("type=feedback → engram.kind = observation + importance=0.5", () => {
    const result = engine.syncMemory(makeParsed({ type: "feedback" }));
    const engram = repo.readEngram(result.engramId!);
    expect(engram.kind).toBe("observation");
    expect(engram.importance).toBe(0.5);
  });

  it("相同内容第二次同步 → no-change,版本号不变", () => {
    const first = engine.syncMemory(makeParsed());
    const initialVersion = repo.readEngram(first.engramId!).version;
    const initialUpdatedAt = repo.readEngram(first.engramId!).updatedAt;

    const second = engine.syncMemory(makeParsed());
    expect(second.action).toBe("no-change");
    expect(second.engramId).toBe(first.engramId);

    const after = repo.readEngram(second.engramId!);
    expect(after.version).toBe(initialVersion);
    expect(after.updatedAt).toBe(initialUpdatedAt);
  });

  it("内容变化 → updated,version+1,但 createdBy/domainTags/encodingContext 不变", () => {
    const first = engine.syncMemory(makeParsed());
    const initialVersion = repo.readEngram(first.engramId!).version;
    const initialCreatedAt = repo.readEngram(first.engramId!).createdAt;

    const second = engine.syncMemory(
      makeParsed({ body: "updated body content here" }),
    );
    expect(second.action).toBe("updated");
    expect(second.engramId).toBe(first.engramId);

    const after = repo.readEngram(second.engramId!);
    expect(after.version).toBe(initialVersion + 1);
    expect(after.createdAt).toBe(initialCreatedAt);
    expect(after.domainTags).toContain(AUTO_MEMORY_DOMAIN_TAG);
    expect(after.encodingContext).toBe(
      `${AUTO_MEMORY_ENCODING_PREFIX}test-slug`,
    );
    expect(after.content).toContain("updated body content here");
  });

  it("空内容 → skipped,不创建 engram", () => {
    const result = engine.syncMemory(makeParsed({ description: "", body: "" }));
    expect(result.action).toBe("skipped");
    expect(result.engramId).toBeUndefined();
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("slug 相同但文件路径不同 → 视为同一 engram(只更新)", () => {
    const first = engine.syncMemory(makeParsed({ filePath: "/a.md" }));
    const second = engine.syncMemory(
      makeParsed({ filePath: "/b.md", body: "new body" }),
    );
    expect(second.action).toBe("updated");
    expect(second.engramId).toBe(first.engramId);
  });

  it("slug 不同 → 创建独立 engram", () => {
    const a = engine.syncMemory(makeParsed({ slug: "slug-a" }));
    const b = engine.syncMemory(makeParsed({ slug: "slug-b" }));
    expect(a.engramId).not.toBe(b.engramId);
    expect(repo.listEngrams()).toHaveLength(2);
  });
});

describe("AutoMemorySyncEngine.syncBatch", () => {
  it("批量同步多条 → 正确分类统计", () => {
    const memories = [
      makeParsed({ slug: "a" }),
      makeParsed({ slug: "b" }),
      makeParsed({ slug: "c", description: "", body: "" }),
    ];
    const stats = engine.syncBatch(memories);
    expect(stats.created).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it("两次同步相同批次 → 第二次全部 no-change", () => {
    const memories = [makeParsed({ slug: "a" }), makeParsed({ slug: "b" })];
    engine.syncBatch(memories);
    const stats = engine.syncBatch(memories);
    expect(stats.unchanged).toBe(2);
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
  });

  it("错误计入 failed,不阻塞其他条目", () => {
    // 通过模拟故障的 memory 触发异常:createEngram 在 slug 已有时再调 createEngram 会报 file exists
    // 这里用 mock repo 触发异常:我们手动让一个已存在 slug 的 engram 文件路径冲突
    const realCreate = repo.createEngram.bind(repo);
    let callCount = 0;
    repo.createEngram = ((input: Parameters<typeof realCreate>[0]) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated failure");
      }
      return realCreate(input);
    }) as typeof realCreate;

    const memories = [
      makeParsed({ slug: "a" }),
      makeParsed({ slug: "b" }),
      makeParsed({ slug: "c" }),
    ];
    const stats = engine.syncBatch(memories);
    expect(stats.created).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("b:");
  });
});

describe("AutoMemorySyncEngine 跨实例幂等", () => {
  it("新实例从仓库重建 slug cache,识别已存在的 slug", () => {
    // 实例 1 同步
    const engine1 = new AutoMemorySyncEngine({
      repository: repo,
      defaultCreatedBy: "user1",
    });
    engine1.syncMemory(makeParsed({ slug: "persisted-slug" }));
    expect(repo.listEngrams()).toHaveLength(1);

    // 实例 2(模拟进程重启)看到已有 engram,重建 cache,做 update
    const engine2 = new AutoMemorySyncEngine({
      repository: repo,
      defaultCreatedBy: "user2",
    });
    const result = engine2.syncMemory(
      makeParsed({ slug: "persisted-slug", body: "updated by engine2" }),
    );
    expect(result.action).toBe("updated");
    expect(result.engramId).toBeDefined();
    const engram = repo.readEngram(result.engramId!);
    expect(engram.content).toContain("updated by engine2");
    // createdBy 是创建者,不应被 update 改
    expect(engram.createdBy).toBe("user1");
  });

  it("resetCache 后下次 findBySlug 重新扫全库", () => {
    engine.syncMemory(makeParsed({ slug: "cached-slug" }));
    // cache 已构建
    expect(engine.peekSlugCache()?.has("cached-slug")).toBe(true);
    engine.resetCache();
    expect(engine.peekSlugCache()).toBeUndefined();
    // 再次同步相同 slug,会重建 cache 并识别
    const result = engine.syncMemory(makeParsed({ slug: "cached-slug" }));
    expect(result.action).toBe("no-change");
  });
});
