// packages/core/src/retrieval/search-engine.ts
//
// SearchEngine —— 统一 in-memory 与 SQLite 两引擎的契约接口。
//
// 用途:host adapter(claude-code-mcp / openclaw-plugin)在装配阶段通过
// createSearchEngine({ type, indexDb? }) 拿到一个 SearchEngine 实例,
// 注入 ToolContext.searchOrchestrator。engram_search / memory_search
// 等工具只调 .search() / .build(),不感知底层是哪种引擎。
//
// 切换方式:环境变量 CO_ENGRAM_SEARCH_ENGINE=sqlite 启用 SQLite FTS5
// 模式;默认 memory(原 in-memory Intl.Segmenter 实现)。Phase 2 PR2
// 灰度阶段默认 memory,验证 SQLite 召回等价后切默认。
//
// @module @co-engram/core/retrieval
import type { IndexDb } from "../storage/index-db.js";
import type { DigestLine } from "../index/types.js";
import type { SearchFilter } from "../types/disclosure.js";
import { SearchOrchestrator, type SimpleSearchResult } from "./orchestrator.js";
import { SqliteSearchOrchestrator } from "./sqlite-orchestrator.js";

/** 引擎类型 */
export type SearchEngineType = "memory" | "sqlite";

/**
 * 统一检索引擎接口 —— in-memory SearchOrchestrator 与 SQLite 适配器都满足。
 *
 * 只暴露工具调用方需要的两个方法:
 *   - search(query, filter?, limit?) —— 检索
 *   - build(lines) —— 索引重建(in-memory 必需;SQLite 模式 no-op,
 *     write-through 在 EngramRepository 写入路径已透明维护索引)
 *
 * SearchOrchestrator 自身的 setClock / setWeights / listByFilter /
 * listByImportance 等方法不在此接口 —— 这些是 in-memory 引擎特有的
 * 调优 hook,SQLite 端无对应概念(bm25 自带相关度,无需三因子融合调权)。
 */
export interface SearchEngine {
  search(query: string, filter?: SearchFilter, limit?: number): SimpleSearchResult[];
  build(lines: readonly DigestLine[]): void;
}

/**
 * SQLite 引擎适配器 —— 把 SqliteSearchOrchestrator 包装成 SearchEngine。
 *
 * - search():把 3-arg signature 转成 SqliteSearchOrchestrator 的
 *   { filter, limit } opts signature,丢掉 nextCursor(search 工具不强制分页)。
 * - build():no-op。SQLite 索引由 EngramRepository 的 write-through 持续
 *   维护,不需要外部触发重建。保留方法仅为接口兼容。
 */
export class SqliteSearchEngineAdapter implements SearchEngine {
  constructor(private readonly sqlite: SqliteSearchOrchestrator) {}

  search(query: string, filter?: SearchFilter, limit = 20): SimpleSearchResult[] {
    return this.sqlite.search(query, { filter, limit }).results;
  }

  build(_lines: readonly DigestLine[]): void {
    // intentional no-op:write-through 已维护 SQLite 索引。
    // 参数保留是为了与 SearchOrchestrator.build 签名对齐,允许调用方
    // 不感知底层引擎而透明调用。
  }
}

/**
 * 工厂:按 type 创建 SearchEngine。
 *
 * sqlite 模式必须提供 indexDb(已 open())。memory 模式忽略 indexDb。
 *
 * @throws sqlite 模式未提供 indexDb 时抛错(fail-loud,避免运行时静默退化)
 */
export function createSearchEngine(opts: {
  readonly type: SearchEngineType;
  readonly indexDb?: IndexDb;
}): SearchEngine {
  if (opts.type === "sqlite") {
    if (!opts.indexDb) {
      throw new Error(
        "createSearchEngine: sqlite 模式必须提供 indexDb(已 open)。若要 fallback 到 memory,显式传 type='memory'。",
      );
    }
    return new SqliteSearchEngineAdapter(new SqliteSearchOrchestrator({ db: opts.indexDb }));
  }
  return new SearchOrchestrator();
}

/**
 * 从环境变量解析 engine flag。
 *
 * - CO_ENGRAM_SEARCH_ENGINE=sqlite → sqlite
 * - 未设置 / 空 / 其他值 → memory(默认 + 灰度保守)
 *
 * 函数纯函数(可注入 env),便于测试。
 */
export function resolveSearchEngineType(
  env: NodeJS.ProcessEnv = process.env,
): SearchEngineType {
  const v = (env.CO_ENGRAM_SEARCH_ENGINE ?? "memory").toString().toLowerCase().trim();
  return v === "sqlite" ? "sqlite" : "memory";
}
