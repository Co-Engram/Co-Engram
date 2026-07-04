// packages/viewer/src/cursor-pagination.ts
//
// 通用内存 cursor 分页工具,供 viewer /api/proposals、/api/audit 共用。
// /api/engrams 的 cursor 在 SQLite 层(repository.queryEngramsForList),
// 不走本工具;本工具只覆盖"内存数组数据源"。
//
// 设计要点:
//   1. 稳定排序 —— 排序键 + tiebreak(唯一键),保证相同 sortKey 时顺序确定
//   2. cursor 编码 —— base64(JSON({ k, t })),无状态、可序列化
//   3. cursor 比较方向 —— descending 时,sortKey 较小者排在 cursor 之后;
//      ascending 时反之。tiebreak 始终升序。
//   4. filter 在分页前应用 —— 保证 total 反映过滤后总数,nextCursor 在过滤后
//      的稳定排序里有效
//
// 共同根因(2026-07 co-engram viewer 修复):5 个 UX 痛点中,proposals/audit
// 是同一形状 —— "大量数据 + 缺分页抽象"。此工具是该根因的单一抽象解,
// 避免在 server.ts 里散点复制分页逻辑。

export interface CursorState {
  /** sort key 值(ISO timestamp 或 number 的字符串形式) */
  readonly k: string;
  /** tiebreak 值(唯一键,保证稳定排序) */
  readonly t: string;
}

export interface CursorPaginatedResult<T> {
  readonly results: readonly T[];
  /** 过滤后 + 排序后的总数(不是 items.length,而是 filter 之后的) */
  readonly total: number;
  /** 下一页 cursor;null 表示无更多数据 */
  readonly nextCursor: string | null;
}

export interface CursorPaginateOptions<T> {
  readonly items: readonly T[];
  /** 排序键(必须返回 string 或 number;相同 sortKey 时走 tiebreak) */
  readonly getSortKey: (item: T) => string | number;
  /** 唯一 tiebreak 键(必须返回 string;稳定排序用) */
  readonly getTiebreak: (item: T) => string;
  /** 默认 true(降序,大的在前);false 升序 */
  readonly descending?: boolean;
  readonly limit: number;
  /** 来自上一页 nextCursor;decode 失败时静默从第一页开始 */
  readonly cursor?: string;
  /** 可选过滤(filter 在分页前应用) */
  readonly filter?: (item: T) => boolean;
}

const CURSOR_ENCODING = "base64";

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString(CURSOR_ENCODING);
}

export function decodeCursor(cursor: string): CursorState | null {
  try {
    const json = Buffer.from(cursor, CURSOR_ENCODING).toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorState>;
    if (typeof parsed.k !== "string" || typeof parsed.t !== "string") return null;
    return { k: parsed.k, t: parsed.t };
  } catch {
    return null;
  }
}

/**
 * 内存 cursor 分页。给定全量 items,返回当前页 + nextCursor。
 *
 * 用法:
 * ```ts
 * paginateWithCursor({
 *   items: allProposals,
 *   getSortKey: (p) => p.lastSeenAt,
 *   getTiebreak: (p) => p.entityId,
 *   descending: true,
 *   limit: 50,
 *   cursor: reqCursor,
 *   filter: status === "all" ? undefined : (p) => p.status === status,
 * })
 * ```
 */
export function paginateWithCursor<T>(
  opts: CursorPaginateOptions<T>,
): CursorPaginatedResult<T> {
  const {
    items,
    getSortKey,
    getTiebreak,
    descending = true,
    limit,
    cursor,
    filter,
  } = opts;

  // 1. filter(filter 在分页前应用,保证 total 正确)
  const working = filter ? items.filter(filter) : [...items];
  const total = working.length;

  // 2. 稳定排序:sortKey(方向由 descending 决定)+ tiebreak(始终升序)
  working.sort((a, b) => {
    const ka = getSortKey(a);
    const kb = getSortKey(b);
    let keyCmp: number;
    if (typeof ka === "string" && typeof kb === "string") {
      keyCmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    } else {
      const kan = typeof ka === "number" ? ka : Number(ka);
      const kbn = typeof kb === "number" ? kb : Number(kb);
      keyCmp = kan - kbn;
    }
    if (descending) keyCmp = -keyCmp;
    if (keyCmp !== 0) return keyCmp;
    const ta = getTiebreak(a);
    const tb = getTiebreak(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  // 3. 找 startIndex:第一个"严格排在 cursor 之后"的元素
  let startIndex = 0;
  if (cursor) {
    const state = decodeCursor(cursor);
    if (state) {
      startIndex = working.findIndex((item) => {
        const ka = getSortKey(item);
        let keyCmp: number;
        if (typeof ka === "string") {
          keyCmp = ka < state.k ? -1 : ka > state.k ? 1 : 0;
        } else {
          const kn = ka;
          const cn = Number(state.k);
          keyCmp = kn - cn;
        }
        if (descending) keyCmp = -keyCmp;
        if (keyCmp !== 0) return keyCmp > 0;
        const ta = getTiebreak(item);
        return ta > state.t;
      });
      if (startIndex < 0) startIndex = working.length;
    }
  }

  // 4. slice 当前页
  const page = working.slice(startIndex, startIndex + limit);

  // 5. nextCursor:本页最后一个元素的 (sortKey, tiebreak)
  let nextCursor: string | null = null;
  if (startIndex + limit < total) {
    const last = page[page.length - 1];
    if (last) {
      const lastKey = getSortKey(last);
      nextCursor = encodeCursor({
        k: typeof lastKey === "string" ? lastKey : String(lastKey),
        t: getTiebreak(last),
      });
    }
  }

  return { results: page, total, nextCursor };
}
