// packages/core/src/storage/bootstrap.ts
//
// 装配 EngramRepository + SearchEngine —— 把 host adapter(claude-code-mcp /
// openclaw-plugin)共用的初始化逻辑抽到 core,避免双宿主行为漂移。
//
// 默认行为(memory 模式)完全等同此前各 host 内联的 new SearchOrchestrator()
// + rebuildSearchIndex。sqlite 模式额外做:
//   1. 打开 .co-engram/index.db(WAL,首次自动建 schema)
//   2. 把 indexDb 注入 EngramRepository(开启 write-through)
//   3. Cold start:db 为空时从 engrams/*.md 全量重建索引
//   4. 用 SqliteSearchEngineAdapter 包装 SearchEngine
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
  readonly engineType: SearchEngineType;
  /** SQLite 模式下的 indexDb 引用;memory 模式为 undefined。host 持有以在
   *  关闭时显式 close()(进程退出时 OS 自动回收 fd,但测试 / 显式资源管理
   *  需要确定性释放)。 */
  readonly indexDb?: IndexDb;
}

/**
 * 装配 EngramRepository + SearchEngine。
 *
 * Engine 选择:env.CO_ENGRAM_SEARCH_ENGINE=sqlite → SQLite FTS5 模式;
 * 未设置 / 其他值 → 默认 memory(in-memory Intl.Segmenter)。
 *
 * Cold start 行为(sqlite 模式):db 为空时,从 repository.listEngrams()
 * 枚举全量 engram,readEngram() 读详情,转 EngramIndexEntry[] 后
 * rebuildFromEntries() 一次性灌入。已有数据的 db 不重建。
 */
export function bootstrapRepositoryAndSearch(
  opts: BootstrapOptions,
): BootstrapResult {
  const engineType = resolveSearchEngineType(opts.env);

  if (engineType === "sqlite") {
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
    if (count.n === 0) {
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
    }

    const searchEngine = createSearchEngine({ type: "sqlite", indexDb });
    return { repository, searchEngine, engineType, indexDb };
  }

  // memory 模式:行为与原 host 内联代码等价
  const repository = new EngramRepository({
    rootPath: opts.dataRoot,
    ...(opts.language ? { language: opts.language } : {}),
  });
  const searchEngine = createSearchEngine({ type: "memory" });
  return { repository, searchEngine, engineType };
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
  };
}
