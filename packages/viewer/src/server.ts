/**
 * Co-Engram Viewer HTTP Server
 *
 * 绑定 127.0.0.1 的轻量 HTTP server,提供只读为主的数据访问 + 极少写操作。
 *
 * 设计目标:
 *   - 只绑定 loopback,不对外网暴露
 *   - 可选 bearer token 认证
 *   - EADDRINUSE 自动重试 5 次,每次 port+1
 *   - 默认关闭,需 CO_ENGRAM_VIEWER_ENABLED=1 显式开启
 *
 * 端点清单(11 个):
 *   GET    /                    SPA HTML(htmx)
 *   GET    /api/stats           总览统计
 *   GET    /api/engrams         列表
 *   GET    /api/engrams/:id     详情
 *   PATCH  /api/engrams/:id     更新(标题/importance/visibility 等)
 *   DELETE /api/engrams/:id     删除
 *   GET    /api/search?q=       搜索
 *   GET    /api/graph           图视图(节点 + 边)
 *   GET    /api/proposals       候选提案
 *   GET    /api/audit           审计日志
 *   GET    /api/effectiveness   有效性统计
 *   GET    /api/trash           回收站
 *   GET    /api/trash/:id       回收站单条预览(完整内容)
 *   DELETE /api/trash           清空回收站(永久删除,支持 ?partition= 过滤)
 *   POST   /api/trash/:id/restore  从回收站恢复
 *
 * @module @co-engram/claude-code/viewer
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditAction,
  type ToolContext,
  type EngramUpdateInput,
  type EngramVisibility,
  type Language,
  type SynapseDirection,
  type SynapseKind,
  DEFAULT_LANGUAGE,
  listTrashed,
  restoreFromTrash,
  purgeAllTrash,
  readTrashed,
  readTeamMemoryConfig,
  writeTeamMemoryConfig,
  loadAndSelfHealConfig,
  normalizeConfig,
  computeMergeStats,
  detectAnomalies,
  applyDataRootChange,
  computeStatus,
  runInfraDoctor,
  commitFiles,
  isGitRepo,
  GraphBuilder,
  defaultCachePath,
  type EngramRepository,
} from "@co-engram/core";
import { renderSpaHtml } from "./html.js";
import {
  paginateWithCursor,
  encodeCursor,
  decodeCursor,
} from "./cursor-pagination.js";

/** Viewer 配置 */
export interface ViewerServerConfig {
  /**
   * 端口(可选)
   *
   * 优先级:env `CO_ENGRAM_VIEWER_PORT` > `config.port` > host-specific 默认
   * (Claude Code=18799,OpenClaw=18899)。
   *
   * @deprecated persisted `viewer.port` 已废弃(两宿主共享 persisted config 会冲突)。
   * 显式传入仍有效,但建议用 env `CO_ENGRAM_VIEWER_PORT` 覆盖。
   */
  readonly port?: number;
  /** 绑定 host(强制 127.0.0.1,不开放外网) */
  readonly host?: "127.0.0.1";
  /** Bearer token(可选,设置后所有 /api 请求需 Authorization: Bearer <token>) */
  readonly token?: string;
  /** EADDRINUSE 重试次数(默认 5) */
  readonly maxRetries?: number;
  /** UI 语言(默认 en) */
  readonly language?: Language;
  /**
   * team-memory 数据根目录。用于 GET/PUT /api/config 读写持久化配置。
   */
  readonly dataRoot?: string;
  /**
   * 宿主类型(用于 UI 文字适配,默认自动探测)
   *
   * - 'mcp-server':通过 @co-engram/claude-code MCP server 启动,父进程通常是 Claude Code
   * - 'openclaw-plugin':作为 openclaw plugin 运行,viewer 是 gateway 进程的一部分
   *
   * 不传时通过 process.argv 自动探测:启动脚本含 'mcp-server' → mcp-server;
   * 含 'gateway' → openclaw-plugin;否则默认 'mcp-server'(向后兼容)。
   */
  readonly hostType?: "mcp-server" | "openclaw-plugin";
}

/** Viewer 运行时句柄 */
export interface ViewerRuntime {
  readonly server: HttpServer;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const DEFAULT_PORT_CLAUDE_CODE = 18799;
const DEFAULT_PORT_OPENCLAW = 18899;
const DEFAULT_MAX_RETRIES = 5;

/**
 * Debounced graph.json 重建(batch accept 等高频写入时合并成一次重建)。
 *
 * 解决场景(2026-07 用户报告):
 *   accept 30 条 proposal 后,SQLite totalEngrams 实时增加,但 /api/graph 节点数
 *   仍读 graph.json 缓存(旧),导致 stats tab 与 graph tab 数字不一致。
 *
 * 设计:
 *   - 200ms debounce,合并 batch accept 30 次成 1 次全量 rebuild
 *   - 走 setImmediate 不阻塞 HTTP 响应
 *   - 错误吞掉(只 log),因为 graph 重建失败不应影响 accept 成功
 *   - 用 closure 捕获 repository rootPath(进程级单例,不会 stale)
 */
const _pendingGraphRebuilds = new WeakMap<EngramRepository, NodeJS.Timeout>();
function scheduleGraphRebuild(repo: EngramRepository): void {
  const existing = _pendingGraphRebuilds.get(repo);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _pendingGraphRebuilds.delete(repo);
    try {
      const cachePath = defaultCachePath(repo.rootPath);
      const builder = new GraphBuilder(repo, cachePath);
      builder.rebuild();
    } catch (err) {
      console.error("[viewer] scheduled graph rebuild failed:", err);
    }
  }, 200);
  // 不阻塞进程退出
  timer.unref?.();
  _pendingGraphRebuilds.set(repo, timer);
}

/**
 * 读 engram,失败返回 undefined(不抛)。
 * 用于 post-check:updateLifecycle / deleteEngram 后校验状态是否真的变了,
 * 任何异常(文件被外部 rm / parse 失败)都视为"状态没变"以触发 fail-loud。
 */
function safeReadEngram(
  repo: EngramRepository,
  id: string,
): { status: string } | undefined {
  try {
    const e = repo.readEngram(id);
    return e ? { status: e.status } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 启动 Viewer HTTP server
 *
 * 端口解析优先级:
 *   1. env `CO_ENGRAM_VIEWER_PORT`(覆盖两宿主,高级用户/测试用)
 *   2. `config.port`(显式传入)
 *   3. host-specific 默认:Claude Code=18799,OpenClaw=18899
 *
 * 不抛——端口冲突时自动重试 maxRetries 次。
 */
export function startViewerServer(
  ctx: ToolContext,
  config: ViewerServerConfig = {},
): Promise<ViewerRuntime> {
  const hostType = config.hostType ?? detectHostType();
  const defaultPort =
    hostType === "openclaw-plugin"
      ? DEFAULT_PORT_OPENCLAW
      : DEFAULT_PORT_CLAUDE_CODE;
  const envPortRaw = process.env.CO_ENGRAM_VIEWER_PORT;
  const envPort = envPortRaw
    ? Number.parseInt(envPortRaw, 10)
    : undefined;
  const envPortValid =
    typeof envPort === "number" &&
    Number.isFinite(envPort) &&
    envPort > 0 &&
    envPort < 65536;
  // Task 5.3:用户在 persisted config 设了 viewer.port 时 warn,
  // 让用户知道这个字段已废弃(两宿主共享 persisted config 会抢同一端口)。
  // 改用 env CO_ENGRAM_VIEWER_PORT 让两宿主各自指定。
  if (config.port !== undefined && !envPortValid) {
    console.warn(
      `[co-engram] viewer.port=${config.port} from persisted config is deprecated ` +
        `(two hosts sharing persisted config would clash on the same port). ` +
        `Use env CO_ENGRAM_VIEWER_PORT instead. This time falling back to port ${config.port}.`,
    );
  }
  const startPort = (envPortValid ? envPort : undefined) ??
    config.port ??
    defaultPort;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const token = config.token;
  const language = config.language ?? DEFAULT_LANGUAGE;
  const dataRoot = config.dataRoot;

  return tryListen(
    ctx,
    startPort,
    maxRetries,
    token,
    language,
    dataRoot,
    hostType,
  );
}

/**
 * 自动探测宿主类型
 *
 * 通过 process.argv[1](启动脚本路径)判断:
 *   - 含 'mcp-server' → 'mcp-server'(由 Claude Code 拉起)
 *   - 含 'gateway' 或 'coclaw' → 'openclaw-plugin'(由 openclaw/co-claw gateway 加载)
 *   - 其他 → 'mcp-server'(向后兼容默认)
 */
function detectHostType(): "mcp-server" | "openclaw-plugin" {
  const entryArg = process.argv[1] ?? "";
  if (entryArg.includes("mcp-server")) return "mcp-server";
  if (entryArg.includes("gateway") || entryArg.includes("coclaw"))
    return "openclaw-plugin";
  return "mcp-server";
}

function tryListen(
  ctx: ToolContext,
  port: number,
  retriesLeft: number,
  token: string | undefined,
  language: Language,
  dataRoot: string | undefined,
  hostType: "mcp-server" | "openclaw-plugin",
): Promise<ViewerRuntime> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) =>
      handleRequest(ctx, req, res, token, language, dataRoot, hostType),
    );

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && retriesLeft > 0) {
        server.close();
        resolve(
          tryListen(
            ctx,
            port + 1,
            retriesLeft - 1,
            token,
            language,
            dataRoot,
            hostType,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const stop = async (): Promise<void> => {
        await new Promise<void>((r) => server.close(() => r()));
      };
      resolve({ server, port, stop });
    });
  });
}

// ============================================================
// Request handler
// ============================================================

function handleRequest(
  ctx: ToolContext,
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  language: Language,
  dataRoot: string | undefined,
  hostType: "mcp-server" | "openclaw-plugin",
): void {
  try {
    // CORS:仅本机
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:18799");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // SPA HTML
    if (path === "/" && req.method === "GET") {
      const html = renderSpaHtml({ tokenRequired: !!token, language });
      const buf = Buffer.from(html, "utf8");
      // no-store:viewer HTML 内联所有 JS(build 后 ~1.2MB),浏览器默认 heuristic 会
      // 缓存旧版,导致用户部署新 dist 后看到旧 UI(2026-07 多次反馈:audit 不显日志
      // / 健康栏总数对不上,实测 API 数据均正常,根因是浏览器缓存)。强制每次校验。
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
      });
      res.end(buf);
      return;
    }

    // API 路由:需认证(如果配置了 token)
    if (path.startsWith("/api/")) {
      if (token && !isAuthorized(req, token)) {
        respondJson(res, 401, { error: "Unauthorized" });
        return;
      }
      routeApi(ctx, req, res, path, url, language, dataRoot, hostType).catch(
        (err) => {
          respondJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      return;
    }

    respondJson(res, 404, { error: `Not found: ${path}` });
  } catch (err) {
    respondJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return false;
  return match[1] === expectedToken;
}

async function routeApi(
  ctx: ToolContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  language: Language,
  dataRoot: string | undefined,
  hostType: "mcp-server" | "openclaw-plugin",
): Promise<void> {
  // /api/stats
  if (path === "/api/stats" && req.method === "GET") {
    respondJson(res, 200, getStats(ctx));
    return;
  }

  // /api/status
  // 健康可视化:把"静默失败"变成"一眼可见"。供 viewer Health tab 与
  // `co-engram status` CLI 共用同一份 computeStatus 真相源。
  if (path === "/api/status" && req.method === "GET") {
    if (!dataRoot) {
      respondJson(res, 200, {
        generatedAt: new Date().toISOString(),
        dataRoot: "",
        dataRootExists: false,
        isEngramWarehouse: false,
        stats: { total: 0, byKind: {}, byStatus: {}, archived: 0, forgotten: 0 },
        indexes: {
          engramIndex: { exists: false },
          digestJsonl: { exists: false },
          graphJson: { exists: false },
        },
        proposals: { pending: 0, total: 0 },
        git: { isRepo: false, dirty: false, uncommittedCount: 0 },
        mergeDriver: { configured: false },
        checks: [],
        overall: "error" as const,
      });
      return;
    }
    respondJson(res, 200, computeStatus(dataRoot, {
      ...(ctx.repository?.indexDb ? { indexDb: ctx.repository.indexDb } : {}),
    }));
    return;
  }

  // /api/engrams
  //
  // 走 SQLite SQL ORDER BY + LIMIT + cursor pagination(派生索引层),彻底消除
  // 旧实现的 N+1 readEngram —— 1024 条 engram 在旧路径下让 gateway event loop
  // 完全堵塞。详见 repository.queryEngramsForList / IndexDb.queryEngrams。
  //
  // 不注入 indexDb(memory 引擎)时,repository 自动 fallback 到 listEngrams +
  // enriched N+1(小规模可接受)。返回 shape 一致,viewer 不感知。
  //
  // 默认 limit=50,max 200(防止前端失控拖垮后端);cursor 来自上一页的 nextCursor。
  if (path === "/api/engrams" && req.method === "GET") {
    const tagFilter = url.searchParams.get("tag") ?? undefined;
    const kindFilter = url.searchParams.get("kind") ?? undefined;
    const domainTagFilters = url.searchParams
      .getAll("domainTags")
      .filter((t) => t.length > 0);
    const sortParam = url.searchParams.get("sort") ?? undefined;
    const orderParam = (url.searchParams.get("order") ?? "desc").toLowerCase();
    const limitRaw = url.searchParams.get("limit");
    // 默认 200:覆盖前端 client-side filter 大多数场景;max 500 防失控
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Math.min(Number(limitRaw), 500)
        : 200;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const descending = orderParam !== "asc";

    const result = ctx.repository.queryEngramsForList({
      ...(kindFilter ? { kind: kindFilter } : {}),
      domainTags: [...(tagFilter ? [tagFilter] : []), ...domainTagFilters],
      ...(sortParam
        ? {
            sort: sortParam as
              | "createdAt"
              | "updatedAt"
              | "importance"
              | "retrievalCount"
              | "title",
          }
        : {}),
      descending,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    respondJson(res, 200, result);
    return;
  }

  // /api/engrams/ids — 轻量 id 列表(audit tab 用于 engramId 存在性判断)
  //
  // 性能(2026-07 新增):audit tab 旧实现 /api/engrams?limit=500 拉 500 条 digest
  // (~100KB) 仅用于判断 _existingIds。本端点只返回 id 字符串数组(~30KB @ 1026 条),
  // 网络/序列化/DOM 都更轻。无过滤、无排序、无分页 — 全量 id,前段转 Set 即用。
  if (path === "/api/engrams/ids" && req.method === "GET") {
    const result = ctx.repository.queryEngramsForList({
      limit: 100000,
    });
    const ids = (result.results || []).map((e) => e.id);
    respondJson(res, 200, { ids, total: ids.length });
    return;
  }

  // /api/engrams/:id  (GET | PATCH | DELETE)
  const engramMatch = /^\/api\/engrams\/(.+)$/.exec(path);
  if (engramMatch) {
    const id = decodeURIComponent(engramMatch[1]!);
    if (req.method === "GET") {
      try {
        const engram = ctx.repository.readEngram(id);
        respondJson(res, 200, engram);
      } catch {
        respondJson(res, 404, { error: `Not found: ${id}` });
      }
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const updated = ctx.repository.updateEngram(id, parseUpdateInput(body));
      respondJson(res, 200, updated);
      return;
    }
    if (req.method === "DELETE") {
      // 2026-07 改造:网页 DELETE 走 forget 路径(标 status=forgotten,文件保留),
      // 而不是 deleteEngram(硬删)。用户期望"删除进回收站、可恢复";deleteEngram
      // 直接删文件,既不进 .trash/,也不留 forgotten 状态,导致 listTrashedSimple
      // (扫 .trash/ + 查 forgotten/archived 状态)看不到。走 forget 后,网页删除 =
      // 软删除,可在回收站恢复;真硬删由回收站 purgeAll 负责。
      if (!ctx.repository.exists(id)) {
        respondJson(res, 404, { error: `Not found: ${id}` });
        return;
      }
      ctx.repository.updateLifecycle(id, "forgotten", "forgotten");
      // Fail-loud post-check:updateLifecycle 静默 noop(race / 不一致 / 被拦截)
      // 时,engram 仍是 active 状态 → 不能返回伪成功。让用户知道要 engram_doctor。
      const post = safeReadEngram(ctx.repository, id);
      if (!post || post.status !== "forgotten") {
        respondJson(res, 500, {
          error:
            "still exists as active after updateLifecycle — run `engram_doctor` to self-heal",
          id,
        });
        return;
      }
      ctx.auditLog?.append({
        actor: "user",
        action: "forget",
        engramId: id,
        metadata: { reason: "viewer-delete" },
      });
      scheduleGraphRebuild(ctx.repository);
      respondJson(res, 200, { deleted: true, id, softDelete: true });
      return;
    }
    respondJson(res, 405, { error: `Method not allowed: ${req.method}` });
    return;
  }

  // /api/synapses/:id  (GET | PATCH | DELETE) — synapse detail/edit/delete
  const synapseMatch = /^\/api\/synapses\/(.+)$/.exec(path);
  if (synapseMatch) {
    const id = decodeURIComponent(synapseMatch[1]!);
    const syn = ctx.repository.readSynapseById(id);
    if (!syn) {
      respondJson(res, 404, { error: `Synapse not found: ${id}` });
      return;
    }
    if (req.method === "GET") {
      respondJson(res, 200, syn);
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBodyAs<{
        readonly weight?: number;
        readonly direction?: string;
        readonly kind?: string;
        readonly evidence?: readonly {
          readonly description: string;
          readonly source?: string;
          readonly confidence?: number;
          readonly addedBy: string;
        }[];
      }>(req);
      const updated = ctx.repository.updateSynapse(syn.from, syn.id, {
        ...(body?.weight !== undefined ? { weight: body.weight } : {}),
        ...(body?.direction
          ? { direction: body.direction as SynapseDirection }
          : {}),
        ...(body?.kind ? { kind: body.kind as SynapseKind } : {}),
        ...(body?.evidence ? { evidence: body.evidence } : {}),
        updatedBy: "viewer",
      });
      respondJson(res, 200, updated);
      return;
    }
    if (req.method === "DELETE") {
      ctx.repository.deleteSynapse(id);
      respondJson(res, 200, { deleted: true, id });
      return;
    }
    respondJson(res, 405, { error: `Method not allowed: ${req.method}` });
    return;
  }

  // /api/search
  if (path === "/api/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (!q) {
      respondJson(res, 200, { results: [], total: 0 });
      return;
    }
    if (!ctx.searchOrchestrator) {
      respondJson(res, 200, {
        results: [],
        total: 0,
        error: "SearchOrchestrator not available",
      });
      return;
    }
    const results = ctx.searchOrchestrator.search(q, undefined, limit);
    respondJson(res, 200, { results, total: results.length });
    return;
  }

  // /api/graph
  if (path === "/api/graph" && req.method === "GET") {
    const graph = buildGraph(ctx);
    respondJson(res, 200, graph);
    return;
  }

  // /api/proposals
  //
  // 走 paginateWithCursor(lastSeenAt desc + entityId 升序作 tiebreak)。
  // 默认 limit=50,max 200(防止前端失控拖垮后端);cursor 来自上一页的 nextCursor。
  // status=all 时不过滤;status=pending(默认)/accepted/dismissed 按 p.status 过滤。
  if (path === "/api/proposals" && req.method === "GET") {
    if (!ctx.proposalEngine) {
      respondJson(res, 200, {
        results: [],
        total: 0,
        nextCursor: null,
        enabled: false,
      });
      return;
    }
    const status = url.searchParams.get("status") ?? "pending";
    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Math.min(Number(limitRaw), 200)
        : 50;
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const all = ctx.proposalEngine.listAll();
    const result = paginateWithCursor({
      items: all,
      getSortKey: (p) => p.lastSeenAt,
      getTiebreak: (p) => p.entityId,
      descending: true,
      limit,
      cursor,
      filter: status === "all" ? undefined : (p) => p.status === status,
    });

    respondJson(res, 200, {
      results: result.results,
      total: result.total,
      nextCursor: result.nextCursor,
      enabled: true,
    });
    return;
  }

  // /api/proposals/:entityId/accept | /dismiss
  const proposalActionMatch = /^\/api\/proposals\/(.+)\/(accept|dismiss)$/.exec(
    path,
  );
  if (proposalActionMatch && req.method === "POST") {
    const entityId = decodeURIComponent(proposalActionMatch[1]!);
    const action = proposalActionMatch[2] as "accept" | "dismiss";
    if (!ctx.proposalEngine) {
      respondJson(res, 503, {
        error: "Proposal engine not enabled",
        enabled: false,
      });
      return;
    }
    const body = await readJsonBodyAs<{
      readonly title?: string;
      readonly content?: string;
      readonly domainTags?: readonly string[];
      readonly createdBy?: string;
      readonly kind?: string;
      readonly visibility?: string;
      readonly reason?: string;
      readonly dismissDays?: number;
    }>(req);
    try {
      if (action === "accept") {
        // auto-memory 来源的 proposal 自带 payload,可省略 title/content/domainTags;
        // conversation 来源必须显式传值。让 accept() 自行做兜底校验。
        const acceptInput: {
          readonly title?: string;
          readonly content?: string;
          readonly domainTags?: readonly string[];
          readonly createdBy?: string;
          readonly kind?: "fact" | "observation" | "pattern" | "procedure" | "hypothesis";
          readonly visibility?: "public" | "team" | "private" | "restricted";
        } = {
          ...(body?.title ? { title: body.title } : {}),
          ...(body?.content ? { content: body.content } : {}),
          ...(body?.domainTags ? { domainTags: body.domainTags } : {}),
          ...(body?.createdBy ? { createdBy: body.createdBy } : {}),
          ...(body?.kind
            ? {
                kind: body.kind as
                  | "fact"
                  | "observation"
                  | "pattern"
                  | "procedure"
                  | "hypothesis",
              }
            : {}),
          ...(body?.visibility
            ? {
                visibility: body.visibility as
                  | "public"
                  | "team"
                  | "private"
                  | "restricted",
              }
            : {}),
        };
        try {
          const engramId = ctx.proposalEngine.accept(entityId, acceptInput);
          // 异步触发 graph.json 重建,让 /api/graph 立即看到新节点。
          // batch accept 时 200ms debounce 合并成一次重建。
          if (ctx.repository) scheduleGraphRebuild(ctx.repository);
          respondJson(res, 200, { ok: true, action, engramId });
          return;
        } catch (err) {
          // accept 抛错时(包括 payload 兜底失败)给出可读 message
          respondJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
      // dismiss
      ctx.proposalEngine.dismiss(entityId, body?.reason, body?.dismissDays);
      respondJson(res, 200, { ok: true, action });
      return;
    } catch (err) {
      respondJson(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // /api/audit
  //
  // 走 paginateWithCursor(ts desc + 数组索引作 tiebreak)。
  // 默认 limit=100,max 500;cursor 来自上一页的 nextCursor。
  // 数据源:AuditLog.query 流式 readSync + ring buffer,内存峰值 = queryLimit 条
  // entries(~200KB @ queryLimit=2000)。
  //
  // queryLimit 计算(2026-07 性能修复):旧实现 hardcode `limit: 50000` 让
  // ring buffer 内存达 10MB + 阻塞 event loop;新实现根据 client limit 动态放大
  // 10 倍(留 cursor 翻页余量),最少 2000(默认 limit=100 → 2000 条),最多
  // 10000(max limit=500 → 5000 条)防失控。覆盖典型使用;超出部分 cursor 翻不到。
  if (path === "/api/audit" && req.method === "GET") {
    if (!ctx.auditLog) {
      respondJson(res, 200, {
        results: [],
        total: 0,
        nextCursor: null,
        enabled: false,
      });
      return;
    }
    // action 支持逗号分隔多值:?action=accept,propose → 数组
    const rawAction = url.searchParams.get("action") ?? undefined;
    const actionList = rawAction
      ? rawAction
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const engramId = url.searchParams.get("engramId") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Math.min(Number(limitRaw), 500)
        : 100;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const queryLimit = Math.min(Math.max(limit * 10, 2000), 10000);

    const allEntries = ctx.auditLog.query({
      ...(actionList.length === 1
        ? { action: actionList[0] as AuditAction }
        : actionList.length > 1
          ? { action: actionList as readonly AuditAction[] }
          : {}),
      ...(engramId ? { engramId } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      limit: queryLimit,
    });

    // 附加 _idx 作 tiebreak(同 ts 时稳定排序);ts 是毫秒精度,碰撞概率低
    // 但密集审计场景仍可能,用 _idx 兜底
    const indexed = allEntries.map((entry, i) => ({ entry, _idx: i }));
    const result = paginateWithCursor({
      items: indexed,
      getSortKey: (x) => x.entry.ts,
      getTiebreak: (x) => String(x._idx),
      descending: true,
      limit,
      cursor,
    });

    respondJson(res, 200, {
      results: result.results.map((x) => x.entry),
      total: result.total,
      nextCursor: result.nextCursor,
      enabled: true,
    });
    return;
  }

  // /api/effectiveness
  if (path === "/api/effectiveness" && req.method === "GET") {
    const engramId = url.searchParams.get("engramId");
    if (!engramId || !ctx.effectivenessTracker) {
      respondJson(res, 200, {
        enabled: !!ctx.effectivenessTracker,
        report: null,
      });
      return;
    }
    const report = ctx.effectivenessTracker.effectiveness(engramId);
    respondJson(res, 200, { enabled: true, engramId, report });
    return;
  }

  // /api/merge-stats — P4.3 viewer "Merges" tab data source
  if (path === "/api/merge-stats" && req.method === "GET") {
    if (!ctx.auditLog) {
      respondJson(res, 200, { enabled: false, stats: null });
      return;
    }
    const rawDays = Number(url.searchParams.get("windowDays") ?? 7);
    const safeWindowDays = Number.isFinite(rawDays)
      ? Math.min(365, Math.max(1, Math.trunc(rawDays)))
      : 7;
    const stats = computeMergeStats({
      auditLog: ctx.auditLog,
      windowMs: safeWindowDays * 24 * 60 * 60 * 1000,
    });
    respondJson(res, 200, { enabled: true, stats, windowDays: safeWindowDays });
    return;
  }

  // /api/merge-anomalies — P4.4 anomaly alerting(spec §13.2)
  if (path === "/api/merge-anomalies" && req.method === "GET") {
    if (!ctx.auditLog) {
      respondJson(res, 200, { enabled: false, anomalies: [] });
      return;
    }
    const rawDays = Number(url.searchParams.get("windowDays") ?? 7);
    const safeWindowDays = Number.isFinite(rawDays)
      ? Math.min(365, Math.max(1, Math.trunc(rawDays)))
      : 7;
    const stats = computeMergeStats({
      auditLog: ctx.auditLog,
      windowMs: safeWindowDays * 24 * 60 * 60 * 1000,
    });
    const anomalies = detectAnomalies(stats);
    respondJson(res, 200, {
      enabled: true,
      anomalies,
      windowDays: safeWindowDays,
    });
    return;
  }

  // /api/trash
  //
  // 走 paginateWithCursor(trashedAt desc + id 升序作 tiebreak)。
  // 默认 limit=100,max 500。cursor 来自上一页的 nextCursor。
  // 双源统一:swept(.trash/) + soft(forgotten/archived)。
  if (path === "/api/trash" && req.method === "GET") {
    const all = listTrashedSimple(ctx);
    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Math.min(Number(limitRaw), 500)
        : 100;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const source = url.searchParams.get("source") ?? undefined;
    const partition = url.searchParams.get("partition") ?? undefined;

    const filtered = all.filter((t) => {
      if (source && t.source !== source) return false;
      if (partition && t.partition !== partition) return false;
      return true;
    });

    const result = paginateWithCursor({
      items: filtered,
      // 软删除可能 trashedAt 缺失(数据迁移痕迹),兜底为 epoch 0
      getSortKey: (t) => t.trashedAt ?? "1970-01-01T00:00:00.000Z",
      getTiebreak: (t) => t.id,
      descending: true,
      limit,
      cursor,
    });

    respondJson(res, 200, {
      results: result.results,
      total: result.total,
      nextCursor: result.nextCursor,
    });
    return;
  }
  if (path === "/api/trash" && req.method === "DELETE") {
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    const partition = url.searchParams.get("partition") ?? undefined;
    const dryRun = url.searchParams.get("dryRun") === "1";

    // 双源 purge:
    //   1. .trash/ 物理(走 purgeAllTrash,partition=YYYY-MM)
    //   2. soft forgotten/archived(走 deleteEngram,partition=forgotten|archived)
    //
    // 旧实现只清 .trash/,导致用户看到 386 条列表但「永久清空」count=0。
    // 现在按 partition 区分:形如 YYYY-MM 的视为 swept;forgotten/archived 视为 soft。
    // 不传 partition 时两类都清。
    const purgedIds: string[] = [];
    const partitionsRemoved: string[] = [];

    // (1) 物理 .trash/
    const sweptPartition =
      partition && /^\d{4}-\d{2}$/.test(partition) ? partition : undefined;
    const sweptResult = purgeAllTrash(ctx.repository, {
      partition: sweptPartition,
      dryRun,
      auditLog: ctx.auditLog,
      actor: "user",
    });
    purgedIds.push(...sweptResult.purged);
    partitionsRemoved.push(...sweptResult.partitionsRemoved);

    // (2) soft forgotten/archived
    // 双路径:SQLite 可用时 O(N) 查询;不可用时(legacy / 旧 Node)走 readEngram 循环。
    // listTrashedSimple 早有 readEngram fallback,但旧 DELETE 漏掉,导致无 indexDb
    // 时 count=0(2026-07 用户反馈"永久清空全部"不生效,实测根因之一)。
    const softStatuses =
      partition === "forgotten"
        ? ["forgotten"]
        : partition === "archived"
          ? ["archived"]
          : (!partition || /^\d{4}-\d{2}$/.test(partition)
              ? ["forgotten", "archived"]
              : []);
    if (softStatuses.length > 0) {
      let softRows: { id: string }[] = [];
      if (ctx.repository.indexDb) {
        const placeholder = softStatuses.map(() => "?").join(",");
        softRows = ctx.repository.indexDb
          .prepare(`SELECT id FROM engrams WHERE status IN (${placeholder})`)
          .all(...softStatuses) as { id: string }[];
      } else {
        // legacy fallback:扫 listEngrams + readEngram 取 status
        for (const entry of ctx.repository.listEngrams()) {
          try {
            const full = ctx.repository.readEngram(entry.id);
            if (
              softStatuses.includes(full.status as "forgotten" | "archived")
            ) {
              softRows.push({ id: entry.id });
            }
          } catch {
            // 跳过读不出的项
          }
        }
      }
      for (const r of softRows) {
        if (dryRun) {
          purgedIds.push(r.id);
        } else {
          try {
            ctx.repository.deleteEngram(r.id);
            purgedIds.push(r.id);
          } catch (err) {
            console.error(
              `[viewer] failed to purge soft-deleted engram ${r.id}:`,
              err,
            );
          }
        }
      }
    }

    // 实际删除发生时(purgedIds > 0 且非 dryRun),触发 graph 重建
    if (!dryRun && purgedIds.length > 0) {
      scheduleGraphRebuild(ctx.repository);
    }

    respondJson(res, 200, {
      purged: purgedIds,
      partitionsRemoved,
      count: purgedIds.length,
      dryRun,
    });
    return;
  }

  // /api/trash/:id  (GET — 预览完整内容;双源兼容)
  const trashItemMatch = /^\/api\/trash\/([^/]+)$/.exec(path);
  if (trashItemMatch && req.method === "GET") {
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    const id = decodeURIComponent(trashItemMatch[1]!);
    // 优先 .trash/ 物理 sweep
    const swept = readTrashed(ctx.repository, id);
    if (swept) {
      respondJson(res, 200, { ...swept, source: "swept" as const });
      return;
    }
    // fallback:engrams/ 中 status=forgotten/archived 的软删除项
    if (ctx.repository.exists(id)) {
      try {
        const engram = ctx.repository.readEngram(id);
        if (engram.status === "forgotten" || engram.status === "archived") {
          respondJson(res, 200, {
            id,
            source: "soft" as const,
            partition: engram.status,
            trashedAt: engram.updatedAt,
            frontmatter: {
              id: engram.id,
              title: engram.title,
              kind: engram.kind,
              status: engram.status,
              domainTags: engram.domainTags,
              contextTags: engram.contextTags,
              visibility: engram.visibility,
              sourceType: engram.sourceType,
              createdBy: engram.createdBy,
              createdAt: engram.createdAt,
              updatedAt: engram.updatedAt,
              importance: engram.importance,
              confidence: engram.confidence,
              summary: engram.summary,
            },
            content: engram.content ?? "",
          });
          return;
        }
      } catch {
        // fallthrough to 404
      }
    }
    respondJson(res, 404, { error: `Not in trash: ${id}` });
    return;
  }

  // /api/trash/:id/restore (双源兼容)
  const trashRestoreMatch = /^\/api\/trash\/(.+)\/restore$/.exec(path);
  if (trashRestoreMatch && req.method === "POST") {
    const id = decodeURIComponent(trashRestoreMatch[1]!);
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    // 优先 .trash/ 物理恢复
    const swept = readTrashed(ctx.repository, id);
    if (swept) {
      const result = restoreFromTrash(
        ctx.repository,
        id,
        ctx.auditLog ? { auditLog: ctx.auditLog } : {},
      );
      if (result.ok) {
        scheduleGraphRebuild(ctx.repository);
        respondJson(res, 200, { ok: true, id, source: "swept" as const });
        return;
      }
      respondJson(res, 404, { ok: false, error: result.reason, id });
      return;
    }
    // fallback:soft restore — status 切回 active + freshness=stale
    if (ctx.repository.exists(id)) {
      try {
        const engram = ctx.repository.readEngram(id);
        if (engram.status === "forgotten" || engram.status === "archived") {
          ctx.repository.updateLifecycle(id, "active", "stale");
          ctx.auditLog?.append({
            actor: "user",
            action: "restore_from_trash",
            engramId: id,
            metadata: { source: "soft", prevStatus: engram.status },
          });
          // soft restore 后 status 变 active,stats 与 graph 都要刷新
          scheduleGraphRebuild(ctx.repository);
          respondJson(res, 200, { ok: true, id, source: "soft" as const });
          return;
        }
      } catch (err) {
        respondJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          id,
        });
        return;
      }
    }
    respondJson(res, 404, {
      ok: false,
      error: `Not in trash: ${id}`,
      id,
    });
    return;
  }

  // /api/config (GET 返回当前配置;PUT 持久化更新)
  if (path === "/api/config") {
    if (req.method === "GET") {
      const persisted = dataRoot
        ? await readTeamMemoryConfig(dataRoot)
        : undefined;
      // 推荐的 dataroot 候选路径(后端有 process.env.HOME;前端拿不到,故此处下发)
      // 用于首次用户引导卡片的"推荐路径"按钮
      const home = process.env.HOME || process.env.USERPROFILE || "~";
      respondJson(res, 200, {
        enabled: !!dataRoot,
        dataRoot: dataRoot || null,
        // dataRoot 现可在 UI 编辑(写 ~/.co-engram/config.json bootstrap);
        // UI 二次确认后透传 force=true;首次默认 false
        dataRootReadOnly: false,
        // 首次用户(dataRoot=null)的引导按钮使用这两个候选路径
        suggestedPaths: {
          home: `${home}/team-memory`,
          hidden: `${home}/.co-engram-data`,
        },
        // hostType:当前 viewer 的宿主模式,UI 文字按此适配
        //   'mcp-server' → 重启提示指 "Claude Code",支持自动重启
        //   'openclaw-plugin' → 重启提示指 "OpenClaw",需手动 `openclaw gateway restart`
        hostType,
        persisted: persisted ?? null,
        runtime: {
          auditEnabled: !!ctx.auditLog,
          proposalEnabled: !!ctx.proposalEngine,
          searchEnabled: !!ctx.searchOrchestrator,
          // 新语义:以 dataRoot 内 config.json 为单一权威,
          // env 已不再承载这些开关。
          maintenanceEnabled: persisted?.maintenance?.enabled === true,
          // viewer 自身就是当前响应 API 的 HTTP server,API 在响应即说明在跑。
          // 之前的 persisted + ctx.proposalEngine 推算会在 proposalEngine 未注入时
          // 错误地返回 false(用户在 UI 看到"Web 查看器:已禁用"但页面正常打开)。
          viewerEnabled: true,
          profile: persisted?.toolsProfile ?? null,
          language,
          defaultCreatedBy: ctx.defaultCreatedBy || null,
        },
      });
      return;
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = (await readJsonBodyAs<Record<string, unknown>>(req)) ?? {};

      // dataRoot 编辑:写 ~/.co-engram/config.json bootstrap config(单一权威源)
      // 共享 applyDataRootChange 验证 + 初始化逻辑(与 CLI 同源)
      // UI 二次确认后透传 force=true;首次默认 false,non-engram 时返回 existingFiles
      // 让 UI 弹"确认接管此目录"对话框(中文化、列出现有文件)
      if (typeof body.dataRoot === "string" && body.dataRoot.trim()) {
        const force = body.force === true || body.force === "true";
        const result = await applyDataRootChange(body.dataRoot, { force });
        if (!result.ok) {
          respondJson(res, 400, {
            ok: false,
            error: result.error,
            reason: result.reason,
            // non-engram 失败时附现有文件清单,让 UI 展示并支持二次确认 force=true
            existingFiles: result.existingFiles ?? [],
            existingCount: result.existingCount ?? 0,
          });
          return;
        }
        respondJson(res, 200, {
          ok: true,
          restartRequired: true,
          dataRoot: result.dataRoot,
          initialized: result.initialized,
          message:
            hostType === "openclaw-plugin"
              ? "Data root updated. Run 'openclaw gateway restart' to apply."
              : "Data root updated. Restart Claude Code (MCP server) to apply.",
        });
        return;
      }

      if (!dataRoot) {
        respondJson(res, 503, {
          error: "Config persistence not available (dataRoot unknown)",
        });
        return;
      }
      // 用 loadAndSelfHealConfig 取代手动 fallback,保证返回的字段齐全(已嵌套化)。
      // 写回时通过 normalizeConfig 保护,避免丢失嵌套字段。
      const { config: existing } = await loadAndSelfHealConfig(dataRoot);
      const next: Record<string, unknown> = { ...existing };
      if (
        typeof body.language === "string" &&
        (body.language === "zh" || body.language === "en")
      ) {
        next.language = body.language;
      }
      if (typeof body.defaultCreatedBy === "string") {
        next.defaultCreatedBy = body.defaultCreatedBy.trim() || undefined;
      }
      if (
        typeof body.toolsProfile === "string" &&
        ["minimal", "standard", "full"].includes(body.toolsProfile)
      ) {
        next.toolsProfile = body.toolsProfile;
      }
      // 子系统开关:接收嵌套字段(maintenance.enabled / audit.enabled / proposals.enabled)
      const bodyMaintenance = body.maintenance as
        | { enabled?: unknown }
        | undefined;
      const bodyAudit = body.audit as { enabled?: unknown } | undefined;
      const bodyProposals = body.proposals as { enabled?: unknown } | undefined;
      if (bodyMaintenance?.enabled !== undefined) {
        next.maintenance = {
          ...(existing.maintenance ?? {}),
          enabled: !!bodyMaintenance.enabled,
        };
      }
      if (bodyAudit?.enabled !== undefined) {
        next.audit = {
          ...(existing.audit ?? {}),
          enabled: !!bodyAudit.enabled,
        };
      }
      if (bodyProposals?.enabled !== undefined) {
        next.proposals = {
          ...(existing.proposals ?? {}),
          enabled: !!bodyProposals.enabled,
        };
      }

      next.updatedAt = new Date().toISOString();
      const normalized = normalizeConfig(
        next as Parameters<typeof normalizeConfig>[0],
      );
      await writeTeamMemoryConfig(dataRoot, normalized);
      respondJson(res, 200, {
        ok: true,
        persisted: normalized,
      });
      return;
    }
  }

  // /api/path-tree (progressive disclosure directory tree)
  //
  // 同时返回 engramLocations(每条 engram 的 {id, path}):前端 applyFilter
  // 用它构建 id→path Map,目录过滤基于 path 而非 id。修复 ULID id 无 '/'
  // 导致目录过滤失效的 bug(2026-07 修复:engrams + graph 两 tab 共用)。
  if (path === "/api/path-tree" && req.method === "GET") {
    if (!ctx.repository) {
      respondJson(res, 200, { enabled: false, root: null });
      return;
    }
    const rawDepth = url.searchParams.get("maxDepth");
    const maxDepth = rawDepth
      ? Math.min(10, Math.max(1, Number(rawDepth) || 5))
      : 5;
    const tree = ctx.repository.listPathTree();
    const entries = ctx.repository.listEngramIndex();
    const engramLocations = entries.map((e) => ({ id: e.id, path: e.path }));
    respondJson(res, 200, {
      enabled: true,
      root: pruneTreeForJson(tree as unknown as MutablePathNode, maxDepth, 0),
      engramLocations,
    });
    return;
  }

  // /api/doctor (self-healing scan report)
  if (path === "/api/doctor" && req.method === "GET") {
    if (!ctx.repository) {
      respondJson(res, 200, { enabled: false, report: null });
      return;
    }
    const incremental = url.searchParams.get("incremental") === "1";
    // 基础设施自愈 preflight:让"运行 doctor 扫描"按钮真正能消除 status 告警
    // (补齐 digest.jsonl / graph.json / merge driver 这三类 runDoctor 不覆盖的修复)
    const infra = runInfraDoctor({
      repo: ctx.repository,
      dataRoot: ctx.repository.rootPath,
    });
    const report = ctx.repository.runDoctor({ incremental });
    const combinedFixes = [...infra.fixes, ...report.fixes];
    respondJson(res, 200, {
      enabled: true,
      report: {
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        totalEngrams: report.totalEngrams,
        totalSynapses: report.totalSynapses,
        fixes: combinedFixes,
        pendingManualReview: report.pendingManualReview,
      },
    });
    return;
  }

  // /api/observe (proposal engine 入口:Claude Code hook / 外部喂入对话流)
  //
  // 设计要点:任何错误都吞掉返回 200,绝不阻塞调用方(hook 脚本必须 fire-and-forget)。
  // role 只接受 'user' / 'assistant','system' 由 ProposalEngine 内部过滤。
  if (path === "/api/observe" && req.method === "POST") {
    if (!ctx.proposalEngine) {
      respondJson(res, 200, { ok: true, enabled: false });
      return;
    }
    try {
      const body = await readJsonBodyAs<{
        readonly role?: string;
        readonly content?: string;
        readonly at?: string;
      }>(req);
      const role = body?.role;
      const content = body?.content;
      if (role !== "user" && role !== "assistant") {
        respondJson(res, 200, { ok: true, skipped: "invalid_role" });
        return;
      }
      if (typeof content !== "string" || content.trim().length === 0) {
        respondJson(res, 200, { ok: true, skipped: "empty_content" });
        return;
      }
      await ctx.proposalEngine.observe({
        role,
        content,
        ...(body?.at ? { at: body.at } : {}),
      });
      respondJson(res, 200, { ok: true });
    } catch (err) {
      // observe 失败不能影响 hook 调用方
      respondJson(res, 200, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /api/commit — 一键提交当前 dataRoot 里所有 engram 变更
  //
  // 解决场景:Health tab 检测到「N 个未提交变更」warn 后,用户期望一键落盘,
  // 而不是手动复制命令到终端执行。co-engram dataRoot 是 team-memory 仓库,
  // 里面就是 engram 文件,直接 commit 不侵犯用户代码工作。
  //
  // body: { message?: string } —— message 缺省时用 "chore(memory): sync engram updates"
  // 出错时不抛 500,返回 { ok: false, error } 让前端展示。
  if (path === "/api/commit" && req.method === "POST") {
    if (!ctx.repository) {
      respondJson(res, 200, { ok: false, error: "repository unavailable" });
      return;
    }
    const repoPath = ctx.repository.rootPath;
    if (!isGitRepo(repoPath)) {
      respondJson(res, 200, {
        ok: false,
        error: "data root is not a git repo",
      });
      return;
    }
    try {
      const body = await readJsonBodyAs<{ readonly message?: string }>(req);
      const message =
        typeof body?.message === "string" && body.message.trim().length > 0
          ? body.message.trim()
          : "chore(memory): sync engram updates";
      const result = commitFiles({
        repoPath,
        files: [],
        message,
      });
      if (result.filesChanged === 0) {
        respondJson(res, 200, { ok: true, nothingToCommit: true });
        return;
      }
      respondJson(res, 200, {
        ok: true,
        commit: {
          hash: result.commitHash,
          branch: result.branch,
          filesChanged: result.filesChanged,
        },
      });
    } catch (err) {
      respondJson(res, 200, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // POST /api/restart — 让进程 graceful 退出,由父进程自动重启。
  //
  // 仅在 hostType === 'mcp-server' 时生效:父进程是 Claude Code,会自动 respawn。
  // 在 'openclaw-plugin' 模式下拒绝:viewer 是 gateway 进程的一部分,
  // process.exit 会杀掉整个 gateway,影响其他 plugin / 会话。
  // Plugin 模式请用 `openclaw gateway restart` 命令重启。
  //
  // 安全考量:
  //   - 退出码 0(正常退出),父进程 supervision 才会重启
  //   - 延迟 300ms 退出,确保 HTTP 响应先 flush 到客户端
  //   - viewer 是 loopback-only,外网无法触发
  if (path === "/api/restart" && req.method === "POST") {
    if (hostType === "openclaw-plugin") {
      respondJson(res, 409, {
        ok: false,
        error:
          "restart not supported in openclaw-plugin mode (would kill entire gateway). Use `openclaw gateway restart` instead.",
        hostType,
      });
      return;
    }
    respondJson(res, 200, {
      ok: true,
      message: "restarting in 300ms",
      hostType,
    });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  respondJson(res, 404, { error: `API not found: ${path}` });
}

interface PathNodeDto {
  readonly path: string;
  readonly engramCount: number;
  readonly children: readonly PathNodeDto[];
}

type MutablePathNode = {
  readonly path: string;
  readonly engramCount: number;
  readonly children: readonly MutablePathNode[];
};

function pruneTreeForJson(
  node: MutablePathNode,
  maxDepth: number,
  currentDepth: number,
): PathNodeDto {
  const children =
    currentDepth + 1 >= maxDepth
      ? []
      : node.children.map((c) =>
          pruneTreeForJson(c as MutablePathNode, maxDepth, currentDepth + 1),
        );
  return {
    path: node.path,
    engramCount: node.engramCount,
    children,
  };
}

// ============================================================
// Helpers
// ============================================================

interface StatsResponse {
  /**
   * 主索引全部 engram 行数(含 active/archived/forgotten/draft)。
   *
   * 心智模型对齐(2026-07 修复):
   *   - 后端语义:行数,反映"仓库里存了多少条"
   *   - 用户心智:"活跃可用的记忆数"——会预期 restore 后 +1
   *   - 这两个语义不一致 → 单独暴露 `activeEngrams`(UI 主显示),
   *     `totalEngrams` 保留作"含归档/遗忘的总数",tooltip 解释差异
   */
  readonly totalEngrams: number;
  /** status=active 的 engram 数(UI 主显示,匹配用户心智"活跃记忆数") */
  readonly activeEngrams: number;
  readonly totalSynapses: number;
  readonly byKind: Record<string, number>;
  readonly byStatus: Record<string, number>;
  readonly bySynapseKind: Record<string, number>;
  readonly topTags: ReadonlyArray<{
    readonly tag: string;
    readonly count: number;
  }>;
  readonly topContributors: ReadonlyArray<{
    readonly actor: string;
    readonly engramCount: number;
    readonly synapseCount: number;
    readonly total: number;
  }>;
  readonly pendingProposals: number;
  readonly auditEnabled: boolean;
  readonly effectivenessEnabled: boolean;
  readonly proposalEnabled: boolean;
}

function getStats(ctx: ToolContext): StatsResponse {
  // 优先 SQLite fast path:1000+ engram 规模下,< 100ms
  // 老路径走 listEngrams + N+1 readEngram,1026 ghost 让 /api/stats 卡 47s(2026-07 修复)
  if (ctx.repository.indexDb) {
    try {
      return getStatsFromSqlite(ctx);
    } catch (err) {
      console.error("[viewer] SQLite stats failed, falling back:", err);
    }
  }
  return getStatsLegacy(ctx);
}

/**
 * SQLite fast path:一次 SQL 取 byKind/byStatus/topTags/totalEngrams/topContributors。
 *
 * 关键性能决策(2026-07):
 *   - bySynapseKind/totalSynapses 走 graph.json 缓存(857KB,一次 JSON parse < 50ms),
 *     而不是 collectAllSynapses() 扫 1826 个 synapse yaml 文件(每文件 ~25ms,总 47s)。
 *   - graph.json 由 GraphBuilder 维护,与 engram 写入同步。stats 容忍 graph.json
 *     略陈旧;若 mtime 久未更新,可后续触发重建。
 *   - topContributors 走 SQL `GROUP BY created_by`(schema v3 加的列),
 *     彻底消除 readEngram loop(26 条 readEngram × assembleEngram 卡 24s)。
 *   - synapse contributors 暂省略 — graph.json 不含 createdBy 字段。
 */
function getStatsFromSqlite(ctx: ToolContext): StatsResponse {
  const db = ctx.repository.indexDb!;
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const bySynapseKind: Record<string, number> = {};

  // 1. engrams: kind / status / totalEngrams(一次 SQL 多列聚合)
  for (const r of db
    .prepare(`SELECT kind, count(*) AS n FROM engrams GROUP BY kind`)
    .all() as { kind: string; n: number }[]) {
    byKind[r.kind] = r.n;
  }
  for (const r of db
    .prepare(`SELECT status, count(*) AS n FROM engrams GROUP BY status`)
    .all() as { status: string; n: number }[]) {
    byStatus[r.status] = r.n;
  }
  const totalEngrams =
    (db.prepare(`SELECT count(*) AS n FROM engrams`).get() as { n: number })
      ?.n ?? 0;
  const activeEngrams =
    (
      db
        .prepare(`SELECT count(*) AS n FROM engrams WHERE status = 'active'`)
        .get() as { n: number }
    )?.n ?? 0;

  // 2. bySynapseKind / totalSynapses:走 graph.json 缓存(避免 collectAllSynapses 47s)
  const graph = readGraphCache(ctx);
  let totalSynapses = 0;
  for (const edge of graph.edges) {
    bySynapseKind[edge.kind] = (bySynapseKind[edge.kind] ?? 0) + 1;
    totalSynapses++;
  }

  // 3. topTags(SQLite ORDER BY count DESC LIMIT 10)
  const tagRows = db.prepare(
    `SELECT domain, count(*) AS n
     FROM engram_domains
     GROUP BY domain
     ORDER BY n DESC, domain ASC
     LIMIT 10`,
  ).all() as { domain: string; n: number }[];
  const topTags = tagRows.map((r) => ({ tag: r.domain, count: r.n }));

  // 4. topContributors:v3 schema 加了 created_by 列,直接 SQL GROUP BY。
  //    彻底消除 readEngram loop(之前 26 条 readEngram × assembleEngram 卡 24s,
  //    根因是 assembleEngram 内部 listSynapsesForEngram 扫 1826 synapse 文件)。
  const contributorRows = db.prepare(
    `SELECT created_by AS actor, count(*) AS n
     FROM engrams
     WHERE created_by != ''
     GROUP BY created_by
     ORDER BY n DESC
     LIMIT 10`,
  ).all() as { actor: string; n: number }[];
  const topContributors = contributorRows.map((r) => ({
    actor: r.actor,
    engramCount: r.n,
    synapseCount: 0,
    total: r.n,
  }));

  return {
    totalEngrams,
    activeEngrams,
    totalSynapses,
    byKind,
    byStatus,
    bySynapseKind,
    topTags,
    topContributors,
    pendingProposals: ctx.proposalEngine?.listPending().length ?? 0,
    auditEnabled: !!ctx.auditLog,
    effectivenessEnabled: !!ctx.effectivenessTracker,
    proposalEnabled: !!ctx.proposalEngine,
  };
}

/**
 * 读 graph.json 缓存(若存在),否则返回空图。
 *
 * 用于 /api/stats 的 bySynapseKind 聚合,避免 collectAllSynapses 扫盘 47s。
 * graph.json 由 GraphBuilder 维护(startMaintenance / engram create 路径同步),
 * 最新可能略有延迟但对 stats 这种聚合可接受。
 */
function readGraphCache(ctx: ToolContext): {
  nodes: readonly { id: string }[];
  edges: readonly { kind: string }[];
} {
  // 通过 repository.rootPath 拿 dataRoot(ctx 上没有 dataRoot 字段直接传到这里,
  // 用 repository 的 config.rootPath 兜底)
  const rootPath = (
    ctx as unknown as { repository: { config: { rootPath: string } } }
  ).repository.config.rootPath;
  const graphPath = join(rootPath, ".co-engram", "graph.json");
  try {
    const raw = readFileSync(graphPath, "utf8");
    const parsed = JSON.parse(raw) as {
      nodes: { id: string }[];
      edges: { kind: string }[];
    };
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Legacy fallback:小规模或 SQLite 不可用时走老路径(N+1 readEngram) */
function getStatsLegacy(ctx: ToolContext): StatsResponse {
  const entries = ctx.repository.listEngrams();
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const bySynapseKind: Record<string, number> = {};
  const tagCount: Record<string, number> = {};
  const contributorMap: Record<string, { engram: number; synapse: number }> =
    {};

  const bumpContributor = (
    actor: string | undefined,
    field: "engram" | "synapse",
  ) => {
    if (!actor) return;
    const key = actor.trim();
    if (!key) return;
    contributorMap[key] = contributorMap[key] ?? { engram: 0, synapse: 0 };
    contributorMap[key][field]++;
  };

  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    try {
      const full = ctx.repository.readEngram(entry.id);
      byStatus[full.status] = (byStatus[full.status] ?? 0) + 1;
      bumpContributor(full.createdBy, "engram");
    } catch {
      byStatus["unknown"] = (byStatus["unknown"] ?? 0) + 1;
    }
    for (const t of entry.domainTags) {
      tagCount[t] = (tagCount[t] ?? 0) + 1;
    }
  }

  const allSynapses = ctx.repository.collectAllSynapses();
  for (const { synapse } of allSynapses) {
    bySynapseKind[synapse.kind] = (bySynapseKind[synapse.kind] ?? 0) + 1;
    bumpContributor(synapse.createdBy, "synapse");
  }

  const topTags = Object.entries(tagCount)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topContributors = Object.entries(contributorMap)
    .map(([actor, c]) => ({
      actor,
      engramCount: c.engram,
      synapseCount: c.synapse,
      total: c.engram + c.synapse,
    }))
    .sort((a, b) => b.total - a.total || b.engramCount - a.engramCount)
    .slice(0, 10);

  return {
    totalEngrams: entries.length,
    activeEngrams: byStatus["active"] ?? 0,
    totalSynapses: allSynapses.length,
    byKind,
    byStatus,
    bySynapseKind,
    topTags,
    topContributors,
    pendingProposals: ctx.proposalEngine?.listPending().length ?? 0,
    auditEnabled: !!ctx.auditLog,
    effectivenessEnabled: !!ctx.effectivenessTracker,
    proposalEnabled: !!ctx.proposalEngine,
  };
}

interface GraphResponse {
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly slug?: string;
    readonly kind: string;
    readonly domainTags: readonly string[];
  }>;
  readonly edges: ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly weight: number;
    readonly evidenceCount: number;
    readonly direction: string;
    readonly resolutionStatus?: string;
  }>;
}

function buildGraph(ctx: ToolContext): GraphResponse {
  // 性能路径(2026-07):优先读 graph.json 缓存(~50ms,JSON.parse 1MB),
  // 由 IndexOrchestrator.fullRebuild / infra-doctor 在 cold-start 与
  // 派生索引修复时写入。老路径 collectAllSynapses 扫盘 + YAML.parse
  // 1826 个 synapse 文件 ≈ 1.5s,在 1000+ engram 规模下不可接受。
  //
  // graph.json schema 已扩展含 slug/domainTags/evidenceCount/resolutionStatus,
  // viewer 不需要再拼装。字段缺失(老缓存)时用默认值兼容,降级路径仍保留。
  if (ctx.repository?.rootPath) {
    try {
      const cachePath = defaultCachePath(ctx.repository.rootPath);
      const graphBuilder = new GraphBuilder(ctx.repository, cachePath);
      const cached = graphBuilder.read();
      if (cached) {
        return {
          nodes: cached.nodes.map((n) => ({
            id: n.id,
            title: n.title,
            ...(n.slug ? { slug: n.slug } : {}),
            kind: n.kind,
            domainTags: n.domainTags ?? [],
          })),
          edges: cached.edges.map((e) => ({
            id: e.id,
            from: e.from,
            to: e.to,
            kind: e.kind,
            weight: e.weight,
            evidenceCount: e.evidenceCount ?? 0,
            direction: e.direction,
            ...(e.resolutionStatus
              ? { resolutionStatus: e.resolutionStatus }
              : {}),
          })),
        };
      }
    } catch {
      // graph.json 不可读或损坏,降级到 collectAllSynapses
    }
  }

  // 降级路径:graph.json 不存在时,现场扫盘构建(慢路径,1.5s 量级)
  const entries = ctx.repository.listEngrams();
  // slug 取自 index(如果有);否则 undefined
  const slugById = new Map<string, string>();
  if (ctx.repository) {
    try {
      for (const entry of ctx.repository.listEngramIndex()) {
        slugById.set(entry.id, entry.slug);
      }
    } catch {
      // 索引不可用就降级(不影响 graph 主流程)
    }
  }
  const nodes = entries.map((e) => ({
    id: e.id,
    title: e.title,
    ...(slugById.has(e.id) ? { slug: slugById.get(e.id)! } : {}),
    kind: e.kind,
    domainTags: e.domainTags,
  }));

  const edges: GraphResponse["edges"][number][] = [];
  try {
    for (const synapse of ctx.repository.collectAllSynapses()) {
      const s = synapse.synapse;
      edges.push({
        id: s.id,
        from: s.from,
        to: s.to,
        kind: s.kind,
        weight: s.weight,
        evidenceCount: s.evidence?.length ?? 0,
        direction: s.direction,
        ...(s.resolutionState?.status
          ? { resolutionStatus: s.resolutionState.status }
          : {}),
      });
    }
  } catch {
    // synapse 目录不可用就降级为无边图
  }

  return { nodes, edges };
}

interface TrashListItem {
  readonly id: string;
  /**
   * 回收站项来源:
   *   - "swept":物理已 sweep 到 .trash/<partition>/ 下(由 sweepToTrash 移入)
   *   - "soft":逻辑软删除(status=forgotten/archived)但文件仍在主索引 engrams/
   *
   * 区分原因:用户「查看/恢复/清空」三类操作对两种来源的处理路径不同。
   * 旧实现把它们混入同一列表但只支持 .trash/ 路径,导致 386 条全部按钮失败。
   */
  readonly source: "swept" | "soft";
  /** 分区:swept 时是 .trash/<YYYY-MM>;soft 时是 "forgotten" / "archived" */
  readonly partition?: string;
  /** 进入回收站的时间:swept 时是 .trash/ 目录 mtime;soft 时是 engram.updatedAt */
  readonly trashedAt?: string;
  /** soft 来源必填,swept 来源可省(由前端 preview 时按需读取) */
  readonly title?: string;
  readonly kind?: string;
}

/**
 * 列出回收站中的 engram(双源统一:swept + soft)
 *
 *   - swept:物理已 sweep 到 .trash/<YYYY-MM>/ 下,字段齐全(走 listTrashed)
 *   - soft:逻辑软删除(status=forgotten/archived)但物理仍在 engrams/,
 *     通过一次 SQLite SELECT 拿全字段(id/title/kind/updated_at/status)
 *
 * 旧实现的 bug(2026-07 用户报告):
 *   soft 来源只 push `{ id }`,导致 386 条全部 partition/trashedAt 显示 "—",
 *   preview/restore/purgeAll 按 .trash/ 路径处理 100% 失败。
 *   现在统一字段:partition=status,trashedAt=updatedAt,并补 title/kind 供 UI 显示。
 */
function listTrashedSimple(ctx: ToolContext): TrashListItem[] {
  const out: TrashListItem[] = [];

  // === 来源 1: .trash/ 物理 sweep ===
  for (const t of listTrashed(ctx.repository)) {
    out.push({
      id: t.id,
      source: "swept",
      partition: t.partition,
      trashedAt: t.trashedAt,
    });
  }

  // === 来源 2: status=forgotten/archived 软删除 ===
  const seen = new Set(out.map((o) => o.id));
  if (ctx.repository.indexDb) {
    try {
      const rows = ctx.repository.indexDb.prepare(
        `SELECT id, title, kind, updated_at, status
         FROM engrams
         WHERE status IN ('forgotten', 'archived')
         ORDER BY updated_at DESC`,
      ).all() as {
        id: string;
        title: string;
        kind: string;
        updated_at: number;
        status: string;
      }[];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        out.push({
          id: r.id,
          source: "soft",
          partition: r.status,
          trashedAt: new Date(r.updated_at).toISOString(),
          title: r.title,
          kind: r.kind,
        });
      }
      return out;
    } catch (err) {
      console.error("[viewer] SQLite trash query failed, falling back:", err);
    }
  }
  // Legacy fallback(SQLite 不可用时):对 forgotten/archived 子集 readEngram
  for (const entry of ctx.repository.listEngrams()) {
    if (seen.has(entry.id)) continue;
    try {
      const full = ctx.repository.readEngram(entry.id);
      if (full.status === "forgotten" || full.status === "archived") {
        out.push({
          id: entry.id,
          source: "soft",
          partition: full.status,
          trashedAt: full.updatedAt,
          title: full.title,
          kind: full.kind,
        });
      }
    } catch {
      // skip
    }
  }
  return out;
}

interface UpdateInputBody {
  readonly title?: string;
  readonly content?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly visibility?: string;
  readonly kind?: string;
  readonly domainTags?: readonly string[];
  readonly contextTags?: readonly string[];
}

function parseUpdateInput(body: UpdateInputBody): EngramUpdateInput {
  const patch: EngramUpdateInput = { updatedBy: "viewer" };
  const VALID_KINDS = [
    "fact",
    "observation",
    "pattern",
    "procedure",
    "hypothesis",
  ] as const;
  return {
    ...patch,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.content === "string" ? { content: body.content } : {}),
    ...(typeof body.importance === "number"
      ? { importance: body.importance }
      : {}),
    ...(typeof body.confidence === "number"
      ? { confidence: body.confidence }
      : {}),
    ...(typeof body.visibility === "string"
      ? { visibility: body.visibility as EngramVisibility }
      : {}),
    ...(typeof body.kind === "string" &&
    VALID_KINDS.includes(body.kind as (typeof VALID_KINDS)[number])
      ? { kinds: [body.kind as (typeof VALID_KINDS)[number]] }
      : {}),
    ...(Array.isArray(body.domainTags) ? { domainTags: body.domainTags } : {}),
    ...(Array.isArray(body.contextTags)
      ? { contextTags: body.contextTags }
      : {}),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<UpdateInputBody> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as UpdateInputBody;
}

/**
 * 读取请求体并按给定 schema 解析,失败返回 undefined。
 * 用于 POST endpoint(proposals/trash)。
 */
async function readJsonBodyAs<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
