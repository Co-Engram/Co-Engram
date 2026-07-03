import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EngramRepository,
  AuditLog,
  ProposalEngine,
  DEFAULT_HASHER_EMBEDDER,
  DEFAULT_HASHER_SIMILARITY_THRESHOLD,
} from "@co-engram/core";
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
let audit: AuditLog;
let proposalEngine: ProposalEngine;
let engine: AutoMemorySyncEngine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-sync-engine-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  audit = new AuditLog(tmpDir);
  proposalEngine = new ProposalEngine({
    repository: repo,
    embedder: DEFAULT_HASHER_EMBEDDER,
    auditLog: audit,
    dataRoot: tmpDir,
    config: { similarityThreshold: DEFAULT_HASHER_SIMILARITY_THRESHOLD },
  });
  engine = new AutoMemorySyncEngine({
    proposalEngine,
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
  it("首次同步 → proposed,产生 pending proposal 带 source=auto-memory + slug + payload", () => {
    const result = engine.syncMemory(makeParsed());
    expect(result.action).toBe("proposed");
    expect(result.entityId).toBe("am:test-slug");

    const pending = proposalEngine.listPending();
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p.entityId).toBe("am:test-slug");
    expect(p.source).toBe("auto-memory");
    expect(p.slug).toBe("test-slug");
    expect(p.status).toBe("pending");
    expect(p.payload).toBeDefined();
    expect(p.payload!.title).toBe("test-slug");
    expect(p.payload!.content).toContain("test body content");
    expect(p.payload!.domainTags).toContain(AUTO_MEMORY_DOMAIN_TAG);
    expect(p.payload!.encodingContext).toBe(
      `${AUTO_MEMORY_ENCODING_PREFIX}test-slug`,
    );
    expect(p.payload!.createdBy).toBe("test-user");
    // 仍然没有 engram 被创建
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("type=pattern → payload.kind = pattern + importance=0.7", () => {
    engine.syncMemory(makeParsed({ type: "pattern" }));
    const p = proposalEngine.listPending()[0]!;
    expect(p.payload!.kind).toBe("pattern");
    expect(p.payload!.importance).toBe(0.7);
  });

  it("type=feedback → payload.kind = observation + importance=0.5", () => {
    engine.syncMemory(makeParsed({ type: "feedback" }));
    const p = proposalEngine.listPending()[0]!;
    expect(p.payload!.kind).toBe("observation");
    expect(p.payload!.importance).toBe(0.5);
  });

  it("相同内容第二次同步 → no-change,payload 不变", () => {
    const first = engine.syncMemory(makeParsed());
    expect(first.action).toBe("proposed");

    const second = engine.syncMemory(makeParsed());
    expect(second.action).toBe("no-change");
    expect(second.entityId).toBe(first.entityId);

    // proposal 仍然只有 1 条
    expect(proposalEngine.listAll()).toHaveLength(1);
    // 仍然没有 engram
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("内容变化 → updated,payload 被替换(尚未 accept 时)", () => {
    engine.syncMemory(makeParsed());

    const second = engine.syncMemory(
      makeParsed({ body: "updated body content here" }),
    );
    expect(second.action).toBe("updated");
    expect(second.entityId).toBe("am:test-slug");

    const p = proposalEngine.listAll()[0]!;
    expect(p.payload!.content).toContain("updated body content here");
    expect(p.status).toBe("pending");
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("空内容 → skipped,不创建 proposal", () => {
    const result = engine.syncMemory(makeParsed({ description: "", body: "" }));
    expect(result.action).toBe("skipped");
    expect(result.entityId).toBeUndefined();
    expect(proposalEngine.listAll()).toHaveLength(0);
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("slug 相同但文件路径不同 → 视为同一 proposal(只 update)", () => {
    const first = engine.syncMemory(makeParsed({ filePath: "/a.md" }));
    const second = engine.syncMemory(
      makeParsed({ filePath: "/b.md", body: "new body" }),
    );
    expect(second.action).toBe("updated");
    expect(second.entityId).toBe(first.entityId);
    expect(proposalEngine.listAll()).toHaveLength(1);
  });

  it("slug 不同 → 独立 proposal", () => {
    engine.syncMemory(makeParsed({ slug: "slug-a" }));
    engine.syncMemory(makeParsed({ slug: "slug-b" }));
    expect(proposalEngine.listAll()).toHaveLength(2);
    expect(repo.listEngrams()).toHaveLength(0);
  });

  it("accept 后再次同步同 slug → no-change,不重开已审批项", () => {
    engine.syncMemory(makeParsed({ slug: "accepted-one" }));
    proposalEngine.accept("am:accepted-one", { createdBy: "u" });
    const engramId = repo.listEngrams()[0]!.id;
    expect(repo.readEngram(engramId)!.content).toContain("test body content");
    expect(proposalEngine.listAll()[0]!.status).toBe("accepted");

    // 再次同步(内容变化)→ no-change,不被重开
    const result = engine.syncMemory(
      makeParsed({ slug: "accepted-one", body: "changed body" }),
    );
    expect(result.action).toBe("no-change");
    expect(proposalEngine.listAll()[0]!.status).toBe("accepted");
    // engram content 不变(accept 时落库的内容)
    expect(repo.readEngram(engramId)!.content).toContain("test body content");
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
    expect(stats.proposed).toBe(2);
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
    expect(stats.proposed).toBe(0);
    expect(stats.updated).toBe(0);
  });

  it("错误计入 failed,不阻塞其他条目", () => {
    // 通过 mock proposalEngine 触发异常
    const realPropose = proposalEngine.proposeAutoMemory.bind(proposalEngine);
    let callCount = 0;
    proposalEngine.proposeAutoMemory = ((input: Parameters<typeof realPropose>[0]) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated failure");
      }
      return realPropose(input);
    }) as typeof realPropose;

    const memories = [
      makeParsed({ slug: "a" }),
      makeParsed({ slug: "b" }),
      makeParsed({ slug: "c" }),
    ];
    const stats = engine.syncBatch(memories);
    expect(stats.proposed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("b:");
  });
});

describe("AutoMemorySyncEngine 跨实例幂等", () => {
  it("新实例看到已有 pending proposal,识别为 no-change 或 updated", () => {
    const engine1 = new AutoMemorySyncEngine({
      proposalEngine,
      defaultCreatedBy: "user1",
    });
    engine1.syncMemory(makeParsed({ slug: "persisted-slug" }));
    expect(proposalEngine.listAll()).toHaveLength(1);

    // 模拟进程重启:新 engine 实例共享同一 proposalEngine(共享同一份 proposals.jsonl)
    const engine2 = new AutoMemorySyncEngine({
      proposalEngine,
      defaultCreatedBy: "user2",
    });
    // 内容变化 → updated(payload 替换)
    const result = engine2.syncMemory(
      makeParsed({ slug: "persisted-slug", body: "updated by engine2" }),
    );
    expect(result.action).toBe("updated");
    expect(result.entityId).toBe("am:persisted-slug");

    const p = proposalEngine.listAll()[0]!;
    expect(p.payload!.content).toContain("updated by engine2");
    expect(p.status).toBe("pending");
  });
});
