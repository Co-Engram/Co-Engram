// packages/core/test/retrieval/engine-flag.test.ts
//
// Task 2.3:feature flag 行为单测。
//
// 验证 CO_ENGRAM_SEARCH_ENGINE 环境变量解析 + createSearchEngine 工厂行为。
// 不验证实际检索效果(那在 sqlite-orchestrator.test.ts / recall test 已覆盖)。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSearchEngine,
  resolveSearchEngineType,
  SqliteSearchEngineAdapter,
  type SearchEngineType,
} from "../../src/retrieval/search-engine.js";
import { SearchOrchestrator } from "../../src/retrieval/orchestrator.js";
import { IndexDb } from "../../src/storage/index-db.js";
import { bootstrapRepositoryAndSearch } from "../../src/storage/bootstrap.js";

afterEach(() => {
  delete process.env.CO_ENGRAM_SEARCH_ENGINE;
});

describe("resolveSearchEngineType", () => {
  it("默认 = memory(env 未设置)", () => {
    delete process.env.CO_ENGRAM_SEARCH_ENGINE;
    expect(resolveSearchEngineType()).toBe("memory");
  });

  it("CO_ENGRAM_SEARCH_ENGINE=sqlite 切换", () => {
    process.env.CO_ENGRAM_SEARCH_ENGINE = "sqlite";
    expect(resolveSearchEngineType()).toBe("sqlite");
  });

  it("大小写不敏感(SQLite / SQLITE / sqlite 等价)", () => {
    for (const v of ["SQLITE", "SQLite", "sqlite"]) {
      process.env.CO_ENGRAM_SEARCH_ENGINE = v;
      expect(resolveSearchEngineType()).toBe("sqlite");
    }
  });

  it("未知值 fallback 到 memory(fail-safe 保守)", () => {
    process.env.CO_ENGRAM_SEARCH_ENGINE = "vector"; // 未来可能值,目前不支持
    expect(resolveSearchEngineType()).toBe("memory");
  });

  it("空白字符 trim 后判定", () => {
    process.env.CO_ENGRAM_SEARCH_ENGINE = "  sqlite  ";
    expect(resolveSearchEngineType()).toBe("sqlite");
  });

  it("注入 env 参数(纯函数,不污染 process.env)", () => {
    const result = resolveSearchEngineType({ CO_ENGRAM_SEARCH_ENGINE: "sqlite" });
    expect(result).toBe("sqlite");
    expect(process.env.CO_ENGRAM_SEARCH_ENGINE).toBeUndefined();
  });
});

describe("createSearchEngine", () => {
  it("type=memory 返回 SearchOrchestrator 实例", () => {
    const engine = createSearchEngine({ type: "memory" });
    expect(engine).toBeInstanceOf(SearchOrchestrator);
  });

  it("type=sqlite 返回 SqliteSearchEngineAdapter 实例", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "engine-flag-"));
    mkdirSync(join(dbDir, ".co-engram"), { recursive: true });
    const db = new IndexDb({ dbPath: join(dbDir, ".co-engram", "index.db") });
    db.open();
    try {
      const engine = createSearchEngine({ type: "sqlite", indexDb: db });
      expect(engine).toBeInstanceOf(SqliteSearchEngineAdapter);
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("type=sqlite 但缺 indexDb 时 fail-loud 抛错", () => {
    expect(() =>
      createSearchEngine({ type: "sqlite" /* 缺 indexDb */ }),
    ).toThrow(/sqlite.*indexDb/i);
  });
});

describe("SqliteSearchEngineAdapter", () => {
  it("build(lines) 是 no-op(不抛错)", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "engine-flag-noop-"));
    mkdirSync(join(dbDir, ".co-engram"), { recursive: true });
    const db = new IndexDb({ dbPath: join(dbDir, ".co-engram", "index.db") });
    db.open();
    try {
      const engine = createSearchEngine({ type: "sqlite", indexDb: db });
      expect(() => engine.build([])).not.toThrow();
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("search() 返回 SimpleSearchResult[](向后兼容 3-arg signature)", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "engine-flag-search-"));
    mkdirSync(join(dbDir, ".co-engram"), { recursive: true });
    const db = new IndexDb({ dbPath: join(dbDir, ".co-engram", "index.db") });
    db.open();
    try {
      db.upsertEngram({
        id: "x",
        title: "测试标题",
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: 1,
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: [],
        summary: "测试摘要",
        contentTokens: "测试内容",
      });
      const engine = createSearchEngine({ type: "sqlite", indexDb: db });
      const results = engine.search("测试");
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entry.title).toContain("测试");
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapRepositoryAndSearch", () => {
  it("memory 模式:返回 SearchOrchestrator,无 indexDb", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "engine-bootstrap-mem-"));
    try {
      const result = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
      expect(result.engineType).toBe("memory");
      expect(result.searchEngine).toBeInstanceOf(SearchOrchestrator);
      expect(result.indexDb).toBeUndefined();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("sqlite 模式:返回 SqliteSearchEngineAdapter + indexDb 已 open", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "engine-bootstrap-sqlite-"));
    let result: ReturnType<typeof bootstrapRepositoryAndSearch> | undefined;
    try {
      result = bootstrapRepositoryAndSearch({
        dataRoot: tmpRoot,
        env: { CO_ENGRAM_SEARCH_ENGINE: "sqlite" },
      });
      expect(result.engineType).toBe("sqlite");
      expect(result.searchEngine).toBeInstanceOf(SqliteSearchEngineAdapter);
      expect(result.indexDb).toBeDefined();
      const count = result.indexDb!.prepare("SELECT count(*) as n FROM engrams").get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    } finally {
      result?.indexDb?.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("sqlite 模式 cold start:从已有 engrams/*.md 全量重建", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "engine-bootstrap-cold-"));
    try {
      // 第一次 bootstrap(memory 模式)创建几条 engram
      const memBootstrap = bootstrapRepositoryAndSearch({ dataRoot: tmpRoot });
      for (let i = 0; i < 5; i++) {
        memBootstrap.repository.createEngram({
          title: `engram ${i}`,
          content: `content ${i}`,
          kind: "fact",
          domainTags: ["cold-start"],
          createdBy: "tester",
        });
      }

      // 第二次 bootstrap(sqlite 模式)→ 应触发 cold start rebuild
      const sqliteBootstrap = bootstrapRepositoryAndSearch({
        dataRoot: tmpRoot,
        env: { CO_ENGRAM_SEARCH_ENGINE: "sqlite" },
      });
      try {
        const count = sqliteBootstrap.indexDb!.prepare(
          "SELECT count(*) as n FROM engrams",
        ).get() as { n: number };
        expect(count.n).toBe(5);

        // FTS 也应该有 5 条
        const ftsCount = sqliteBootstrap.indexDb!.prepare(
          "SELECT count(*) as n FROM engram_fts",
        ).get() as { n: number };
        expect(ftsCount.n).toBe(5);

        // 搜索能召回
        const results = sqliteBootstrap.searchEngine.search("engram");
        expect(results.length).toBeGreaterThan(0);
      } finally {
        sqliteBootstrap.indexDb?.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("sqlite 模式 hot start:db 已有数据时不重建(避免覆盖)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "engine-bootstrap-hot-"));
    try {
      // 先用 sqlite bootstrap 创建 3 条
      const first = bootstrapRepositoryAndSearch({
        dataRoot: tmpRoot,
        env: { CO_ENGRAM_SEARCH_ENGINE: "sqlite" },
      });
      for (let i = 0; i < 3; i++) {
        first.repository.createEngram({
          title: `first ${i}`,
          content: `c ${i}`,
          kind: "fact",
          domainTags: ["hot"],
          createdBy: "tester",
        });
      }
      first.indexDb?.close();

      // 第二次 sqlite bootstrap:db 已有 3 条,不应重建
      const second = bootstrapRepositoryAndSearch({
        dataRoot: tmpRoot,
        env: { CO_ENGRAM_SEARCH_ENGINE: "sqlite" },
      });
      try {
        const count = second.indexDb!.prepare(
          "SELECT count(*) as n FROM engrams",
        ).get() as { n: number };
        expect(count.n).toBe(3);
      } finally {
        second.indexDb?.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
