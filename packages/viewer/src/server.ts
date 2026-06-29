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
} from "@co-engram/core";
import { renderSpaHtml } from "./html.js";

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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
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
    respondJson(res, 200, computeStatus(dataRoot));
    return;
  }

  // /api/engrams
  //
  // 返回 catalog + 完整排序字段(title/kind/domainTags 来自 catalog,
  // summary/importance/createdAt/updatedAt/retrievalCount 来自完整 engram)。
  // 单纯返回 catalog 会让前端排序下拉菜单(createdAt/importance/retrievalCount)
  // 失效——这些字段不在 catalog tier 里。
  if (path === "/api/engrams" && req.method === "GET") {
    // 兼容两种参数名:
    //   - tag(旧版,单数,精确匹配单个 tag)
    //   - domainTags(新版,复数,可多次出现,任一匹配即保留)
    // kind 过滤单值匹配。
    const tagFilter = url.searchParams.get("tag") ?? undefined;
    const kindFilter = url.searchParams.get("kind") ?? undefined;
    const domainTagFilters = url.searchParams
      .getAll("domainTags")
      .filter((t) => t.length > 0);
    const sortParam = url.searchParams.get("sort") ?? undefined;
    const orderParam = (url.searchParams.get("order") ?? "desc").toLowerCase();
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const descending = orderParam !== "asc";
    const entries = ctx.repository.listEngrams();
    const filtered = entries.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (tagFilter && !e.domainTags.includes(tagFilter)) return false;
      if (domainTagFilters.length > 0) {
        // 任一 domainTags 参数匹配 engram 的 tag 即保留(OR 语义)
        const matched = domainTagFilters.some((t) => e.domainTags.includes(t));
        if (!matched) return false;
      }
      return true;
    });
    const enriched = filtered.map((entry) => {
      let full: {
        summary?: string;
        importance?: number;
        createdAt?: string;
        updatedAt?: string;
        retrievalCount?: number;
      } | null = null;
      try {
        full = ctx.repository.readEngram(entry.id);
      } catch {
        full = null;
      }
      return {
        ...entry,
        summary: full?.summary ?? "",
        importance: full?.importance ?? 0,
        retrievalCount: full?.retrievalCount ?? 0,
        createdAt: full?.createdAt ?? "",
        updatedAt: full?.updatedAt ?? "",
      };
    });
    // 排序:支持 createdAt / updatedAt / importance / retrievalCount / title
    // 不识别的 sort 值保持原顺序(repository.listEngrams 的自然顺序)
    const sortField = sortParam as
      | "createdAt"
      | "updatedAt"
      | "importance"
      | "retrievalCount"
      | "title"
      | undefined;
    if (sortField) {
      enriched.sort((a, b) => {
        const av = a[sortField];
        const bv = b[sortField];
        if (av === bv) return 0;
        if (typeof av === "number" && typeof bv === "number") {
          return descending ? bv - av : av - bv;
        }
        // 字符串比较(createdAt/updatedAt/title)
        const ac = String(av ?? "");
        const bc = String(bv ?? "");
        return descending ? bc.localeCompare(ac) : ac.localeCompare(bc);
      });
    }
    // limit:截断到指定数量;不传或 NaN 时返回全部
    const limited =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? enriched.slice(0, limit)
        : enriched;
    respondJson(res, 200, { results: limited, total: enriched.length });
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
      ctx.repository.deleteEngram(id);
      respondJson(res, 200, { deleted: true, id });
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
  if (path === "/api/proposals" && req.method === "GET") {
    if (!ctx.proposalEngine) {
      respondJson(res, 200, { results: [], total: 0, enabled: false });
      return;
    }
    const status = url.searchParams.get("status") ?? "pending";
    const all = ctx.proposalEngine.listAll();
    const filtered = all.filter((p) =>
      status === "all" ? true : p.status === status,
    );
    respondJson(res, 200, {
      results: filtered,
      total: filtered.length,
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
      readonly reason?: string;
      readonly dismissDays?: number;
    }>(req);
    try {
      if (action === "accept") {
        if (!body?.title || !body.content) {
          respondJson(res, 400, { error: "accept requires title and content" });
          return;
        }
        const engramId = ctx.proposalEngine.accept(entityId, {
          title: body.title,
          content: body.content,
          domainTags: body.domainTags ?? [],
          ...(body.createdBy ? { createdBy: body.createdBy } : {}),
          ...(body.kind
            ? {
                kind: body.kind as
                  | "fact"
                  | "observation"
                  | "pattern"
                  | "procedure"
                  | "hypothesis",
              }
            : {}),
        });
        respondJson(res, 200, { ok: true, action, engramId });
        return;
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
  if (path === "/api/audit" && req.method === "GET") {
    if (!ctx.auditLog) {
      respondJson(res, 200, { results: [], total: 0, enabled: false });
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
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const entries = ctx.auditLog.query({
      ...(actionList.length === 1
        ? { action: actionList[0] as AuditAction }
        : actionList.length > 1
          ? { action: actionList as readonly AuditAction[] }
          : {}),
      ...(engramId ? { engramId } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      limit,
    });
    respondJson(res, 200, {
      results: entries,
      total: entries.length,
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
  if (path === "/api/trash" && req.method === "GET") {
    const trashed = listTrashedSimple(ctx);
    respondJson(res, 200, { results: trashed, total: trashed.length });
    return;
  }
  if (path === "/api/trash" && req.method === "DELETE") {
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    const partition = url.searchParams.get("partition") ?? undefined;
    const dryRun = url.searchParams.get("dryRun") === "1";
    const result = purgeAllTrash(ctx.repository, {
      partition: partition || undefined,
      dryRun,
      auditLog: ctx.auditLog,
      actor: "user",
    });
    respondJson(res, 200, {
      purged: result.purged,
      partitionsRemoved: result.partitionsRemoved,
      count: result.purged.length,
      dryRun,
    });
    return;
  }

  // /api/trash/:id  (GET — 预览完整内容)
  const trashItemMatch = /^\/api\/trash\/([^/]+)$/.exec(path);
  if (trashItemMatch && req.method === "GET") {
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    const id = decodeURIComponent(trashItemMatch[1]!);
    const detail = readTrashed(ctx.repository, id);
    if (!detail) {
      respondJson(res, 404, { error: `Not in trash: ${id}` });
      return;
    }
    respondJson(res, 200, detail);
    return;
  }

  // /api/trash/:id/restore
  const trashRestoreMatch = /^\/api\/trash\/(.+)\/restore$/.exec(path);
  if (trashRestoreMatch && req.method === "POST") {
    const id = decodeURIComponent(trashRestoreMatch[1]!);
    if (!ctx.repository) {
      respondJson(res, 503, { error: "Repository not available" });
      return;
    }
    const result = restoreFromTrash(
      ctx.repository,
      id,
      ctx.auditLog ? { auditLog: ctx.auditLog } : {},
    );
    if (result.ok) {
      respondJson(res, 200, { ok: true, id });
      return;
    }
    respondJson(res, 404, { ok: false, error: result.reason, id });
    return;
  }

  // /api/config (GET 返回当前配置;PUT 持久化更新)
  if (path === "/api/config") {
    if (req.method === "GET") {
      const persisted = dataRoot
        ? await readTeamMemoryConfig(dataRoot)
        : undefined;
      respondJson(res, 200, {
        enabled: !!dataRoot,
        dataRoot: dataRoot || null,
        // dataRoot 现可在 UI 编辑(写 ~/.co-engram/config.json bootstrap);
        // UI 不支持 --force,拒绝非空非 co-engram 目录(走 CLI)
        dataRootReadOnly: false,
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
          viewerEnabled:
            persisted?.viewer?.enabled === true ||
            (!!ctx.proposalEngine && persisted?.viewer?.enabled !== false),
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
      // UI 不支持 --force:拒绝非空非 co-engram 目录,提示用户走 CLI
      if (typeof body.dataRoot === "string" && body.dataRoot.trim()) {
        const result = await applyDataRootChange(body.dataRoot, {
          force: false,
        });
        if (!result.ok) {
          respondJson(res, 400, {
            ok: false,
            error: result.error,
            reason: result.reason,
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
    respondJson(res, 200, {
      enabled: true,
      root: pruneTreeForJson(tree as unknown as MutablePathNode, maxDepth, 0),
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
    const report = ctx.repository.runDoctor({ incremental });
    respondJson(res, 200, {
      enabled: true,
      report: {
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        totalEngrams: report.totalEngrams,
        totalSynapses: report.totalSynapses,
        fixes: report.fixes,
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
  readonly totalEngrams: number;
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
  const entries = ctx.repository.listEngrams();
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const bySynapseKind: Record<string, number> = {};
  const tagCount: Record<string, number> = {};
  // 贡献者统计:actor → {engram, synapse}
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
    // 读取完整 engram(catalog entry 没有 createdBy/status)
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

  // 突触按 kind 分组
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
  // bidirectional synapse 会同时出现在两端的 outgoing 里(对 A 是出、对 B 也是出),
  // 直接遍历会让同一 id 的 edge 进列表两次,前端 vis-network DataSet 拒绝重复 id。
  // 用 Set 按 synapse id 去重;directional 不受影响(只在起点 outgoing 出现一次)。
  const seenSynapseIds = new Set<string>();
  for (const entry of entries) {
    try {
      const synapses = ctx.repository.readSynapses(entry.id);
      if (synapses.outgoing) {
        for (const s of synapses.outgoing) {
          if (seenSynapseIds.has(s.id)) continue;
          seenSynapseIds.add(s.id);
          edges.push({
            id: s.id,
            from: entry.id,
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
      }
    } catch {
      // 跳过读取失败的 engram
    }
  }

  return { nodes, edges };
}

interface TrashListItem {
  readonly id: string;
  readonly partition?: string;
  readonly trashedAt?: string;
}

/**
 * 列出回收站中的 engram(物理在 .trash/<partition>/ 下)
 *
 * 注:还包含逻辑上 status=forgotten/archived 但物理仍在 engrams/ 的记录,
 * 便于用户查看全貌。
 */
function listTrashedSimple(ctx: ToolContext): TrashListItem[] {
  const trashed = listTrashed(ctx.repository);
  const out: TrashListItem[] = trashed.map((t) => ({
    id: t.id,
    partition: t.partition,
    trashedAt: t.trashedAt,
  }));

  // 补充 status=forgotten/archived 但仍在主目录的记录
  const entries = ctx.repository.listEngrams();
  for (const entry of entries) {
    try {
      const full = ctx.repository.readEngram(entry.id);
      if (full.status === "forgotten" || full.status === "archived") {
        if (!out.some((o) => o.id === entry.id)) {
          out.push({ id: entry.id });
        }
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
