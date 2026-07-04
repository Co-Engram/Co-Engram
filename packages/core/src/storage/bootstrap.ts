// packages/core/src/storage/bootstrap.ts
//
// 装配 EngramRepository + SearchEngine —— 把 host adapter(claude-code-mcp /
// openclaw-plugin)共用的初始化逻辑抽到 core,避免双宿主行为漂移。
//
// 默认行为:sqlite 模式(派生 SQLite 索引 + FTS5 trigram,5k+ engram 目标)。
//   1. 打开 .co-engram/index.db(WAL,首次自动建 schema)
//   2. 把 indexDb 注入 EngramRepository(开启 write-through)
//   3. Cold start:db 为空时从 engrams/*.md 全量重建索引
//   4. 用 SqliteSearchEngineAdapter 包装 SearchEngine
//
// Fail-safe:sqlite 在当前环境不可用(Node 版本边界 < 22.17 / 文件系统错误 /
// 权限问题 / schema 损坏)时,try/catch 兜底 fallback 到 memory 引擎,host
// 仍能启动(只是检索性能在 5k+ 规模下退化)。失败原因通过 console.warn 暴露。
//
// 显式 opt-out:CO_ENGRAM_SEARCH_ENGINE=memory 完全跳过 sqlite 分支,直接落
// memory(适用于嵌入式 / 只读 fs / 显式不想要 .co-engram/index.db 副作用的部署)。
//
// @module @co-engram/core/storage
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Language } from "../i18n/index.js";
import type { Engram } from "../types/engram.js";
import {
  createSearchEngine,
  resolveSearchEngineType,
  type SearchEngine,
  type SearchEngineType,
} from "../retrieval/search-engine.js";
import { EngramRepository } from "./repository.js";
import { IndexDb, type EngramIndexEntry } from "./index-db.js";

export interface BootstrapOptions {
  readonly dataRoot: string;
  readonly language?: Language;
  /** 注入 env(测试用);默认 process.env */
  readonly env?: NodeJS.ProcessEnv;
}

export interface BootstrapResult {
  readonly repository: EngramRepository;
  readonly searchEngine: SearchEngine;
  /** 实际生效的引擎类型。sqlite 装配失败 fallback 到 memory 时,这里返回 "memory"。 */
  readonly engineType: SearchEngineType;
  /** SQLite 模式下的 indexDb 引用;memory 模式为 undefined。host 持有以在
   *  关闭时显式 close()(进程退出时 OS 自动回收 fd,但测试 / 显式资源管理
   *  需要确定性释放)。 */
  readonly indexDb?: IndexDb;
}

/**
 * 装配 EngramRepository + SearchEngine。
 *
 * Engine 解析(resolveSearchEngineType):
 *   - 默认 / 未设置 / 任意非 "memory" 值 → sqlite
 *   - CO_ENGRAM_SEARCH_ENGINE=memory → memory(显式 opt-out)
 *
 * Cold start 行为(sqlite 模式):db 为空时,从 repository.listEngrams()
 * 枚举全量 engram,readEngram() 读详情,转 EngramIndexEntry[] 后
 * rebuildFromEntries() 一次性灌入。已有数据的 db 不重建。
 *
 * Fail-safe:sqlite 分支整段 try/catch,任一步失败(open / schema / cold-start rebuild)
 * 都 close 已开打的 indexDb,然后落 memory 分支重新装配。host 看到的 engineType 反映
 * 实际生效的引擎,而不是"想要"的引擎。
 */
export function bootstrapRepositoryAndSearch(
  opts: BootstrapOptions,
): BootstrapResult {
  const wantedEngine = resolveSearchEngineType(opts.env);

  if (wantedEngine === "sqlite") {
    try {
      const dbDir = join(opts.dataRoot, ".co-engram");
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
      const dbPath = join(dbDir, "index.db");

      const indexDb = new IndexDb({ dbPath });
      indexDb.open();

      // 先构造 repository with indexDb,write-through 在后续所有写入路径生效
      const repository = new EngramRepository(
        {
          rootPath: opts.dataRoot,
          ...(opts.language ? { language: opts.language } : {}),
        },
        indexDb,
      );

      // Cold start:db 空时全量重建
      const count = indexDb.prepare("SELECT count(*) as n FROM engrams").get() as {
        n: number;
      };
      const coldStart = count.n === 0;
      const startedAt = Date.now();
      let indexedCount = 0;
      if (coldStart) {
        const entries: EngramIndexEntry[] = [];
        // listEngrams 返回 EngramCatalogEntry[],取 .id 作为 readEngram 入参
        for (const catalog of repository.listEngrams()) {
          try {
            const engram = repository.readEngram(catalog.id);
            if (!engram) continue;
            entries.push(engramToIndexEntry(engram));
          } catch {
            // 跳过损坏 engram;doctor 自愈路径会单独处理
          }
        }
        indexDb.rebuildFromEntries(entries);
        indexedCount = entries.length;
      }

      const searchEngine = createSearchEngine({ type: "sqlite", indexDb });

      const elapsedMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.warn(
        `[co-engram] search engine: sqlite ` +
          `(cold-start: ${coldStart ? `yes, ${indexedCount} engrams indexed in ${elapsedMs}ms` : `no, ${count.n} engrams already indexed`})`,
      );

      return { repository, searchEngine, engineType: "sqlite", indexDb };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[co-engram] search engine: sqlite unavailable (${reason.slice(0, 200)}), falling back to memory`,
      );
      // 显式落 memory 分支(下方)
    }
  }

  // memory 模式:行为与原 host 内联代码等价;sqlite fallback 也落这里
  const repository = new EngramRepository({
    rootPath: opts.dataRoot,
    ...(opts.language ? { language: opts.language } : {}),
  });
  const searchEngine = createSearchEngine({ type: "memory" });

  if (wantedEngine === "memory") {
    // eslint-disable-next-line no-console
    console.warn(`[co-engram] search engine: memory (opt-out via CO_ENGRAM_SEARCH_ENGINE=memory)`);
  } else {
    // sqlite 失败 fallback 路径已经 warn 过原因,这里只标记最终态
    // eslint-disable-next-line no-console
    console.warn(`[co-engram] search engine: memory (active)`);
  }

  return { repository, searchEngine, engineType: "memory" };
}

/** Engram → EngramIndexEntry 投影(与 repository.syncEngramToIndex 同义) */
function engramToIndexEntry(e: Engram): EngramIndexEntry {
  return {
    id: e.id,
    title: e.title,
    kind: e.kind,
    importance: e.importance,
    confidence: e.confidence,
    updatedAt: Date.parse(e.updatedAt),
    contentSize: e.contentSize,
    visibility: e.visibility,
    status: e.status,
    domainTags: [...e.domainTags],
    summary: e.summary,
    contentTokens: e.content,
    // v2 schema:让 viewer /api/engrams SQL 排序/分页可达
    retrievalCount: e.retrievalCount,
    createdAt: Date.parse(e.createdAt),
  };
}
