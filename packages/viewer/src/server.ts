/**
 * Co-Engram Viewer HTTP Server
 *
 * 绑定 127.0.0.1 的轻量 HTTP server,提供只读为主的数据访问 + 极少写操作。
 *
 * 设计目标:
 *   - 只绑定 loopback,不对外网暴露
 *   - 可选 bearer token 认证
 *   - EADDRINUSE 同端口重试(默认 10 次),固定 18899 不漂移(holder gating 单一端口契约)
 *   - 默认开启(holder gating 决定 holder 启 viewer、非 holder 不启)
 *
 * 端点清单(11 个):
 *   GET    /                    SPA HTML(htmx)
 *   GET    /api/stats           总览统计
 *   GET    /api/engrams         列表
 *   GET    /api/engrams/:id     详情
 *   PATCH  /api/engrams/:id     更新(标题/importance/visibility 等)
 *   DELETE /api/engrams/:id     删除
 *   POST   /api/engrams/:id/reveal  在系统文件管理器打开该 engram 所在目录
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
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AuditAction,
  type ToolContext,
  type EngramUpdateInput,
  type EngramVisibility,
  type Language,
  type SynapseKind,
  isSymmetricKind,
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
  readMaintenanceState,
  DEFAULT_LIGHT_INTERVAL_MS,
  DEFAULT_DEEP_INTERVAL_MS,
  DEFAULT_REM_INTERVAL_MS,
  type EngramRepository,
  type Skill,
  type AcquisitionStage,
  type RetentionStage,
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
   * 优先级:env `CO_ENGRAM_VIEWER_PORT` > `config.port` > 统一默认 `18899`。
   *
   * 2026-07 起 viewer 端口从「宿主分叉默认」(Claude Code=18799 /
   * OpenClaw=18899)收敛为单一 `18899`。理由:viewer 是 dataRoot 维度的
   * 资源(holder gating 全局唯一),端口也应是 dataRoot 维度的常量;
   * 宿主分叉会让用户从 Claude Code 启动却得到 OpenClaw 端口(或反之),
   * 浏览器访问 connection refused。
   *
   * @deprecated persisted `viewer.port` 已废弃(两宿主共享 persisted config 会冲突)。
   * 显式传入仍有效,但建议用 env `CO_ENGRAM_VIEWER_PORT` 覆盖。
   */
  readonly port?: number;
  /** 绑定 host(强制 127.0.0.1,不开放外网) */
  readonly host?: "127.0.0.1";
  /** Bearer token(可选,设置后所有 /api 请求需 Authorization: Bearer <token>) */
  readonly token?: string;
  /**
   * EADDRINUSE 同端口重试次数(默认 10)。
   *
   * viewer 端口固定 18899(holder gating 单一端口契约):冲突时**同端口重试**,
   * 等待上一任 holder 的 viewer close 释放,不漂移到别的端口(漂移会让客户端
   * 访问固定 18899 时找不到 viewer)。仅在 18899 被非 co-engram 进程长期占用时
   * 耗尽 throw。
   */
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

/**
 * Viewer 统一默认端口。
 *
 * 2026-07 起两宿主(Claude Code MCP / OpenClaw plugin)共用 18899。
 * 设计动机:viewer 是 dataRoot 维度的资源(holder gating 全局唯一),
 * 端口也应是 dataRoot 维度常量。原 host-specific 默认(Claude Code=18799 /
 * OpenClaw=18899)会让用户看到的端口取决于「谁是 holder」而非「用户用哪个
 * 宿主」,造成 connection refused 体验。统一后用户只记一个 URL。
 *
 * 旧端口 18799(Claude Code)弃用;已部署用户改书签到 18899。
 * env `CO_ENGRAM_VIEWER_PORT` 覆盖路径不变(用户想跑两个独立 dataRoot
 * 时仍可隔离)。
 */
const DEFAULT_PORT = 18899;
const DEFAULT_MAX_RETRIES = 10;
/**
 * EADDRINUSE 同端口重试间隔(毫秒)。
 *
 * 2026-07 根治端口漂移:不再递增到 port+1(漂移会让客户端访问固定 18899 时找不到 viewer),
 * 改为同端口重试,等上一任 holder 的 viewer async close 释放 18899。300ms×10=3s 足够覆盖
 * server.close 的释放时间。holder gating 保证只有 holder 调 startViewerServer,故 18899
 * 被占只能是 failover 时旧 holder viewer 尚未关闭,重试即可等到。
 */
const EADDRINUSE_RETRY_DELAY_MS = 300;

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
 * 在系统文件管理器打开指定目录(viewer server 端 spawn)。
 *
 * 浏览器无法直接唤起 OS 文件管理器(沙箱限制),由 server 代为 spawn 平台命令:
 *   Linux=xdg-open / macOS=open / Windows=explorer
 *
 * 降级:Linux 无 $DISPLAY 且无 $WAYLAND_DISPLAY(SSH 转发 / 容器 / headless)→
 * 不 spawn(xdg-open 会挂住或刷错),返回 opened=false + reason:no-desktop。
 * spawn 同步抛错(命令不在 PATH / 权限)→ opened=false + reason:spawn-failed。
 *
 * 安全:命令白名单固定(不接受外部输入);absoluteDir 由调用方(repository.
 * resolveDirectory)保证已过 path-traversal 校验。spawn 用数组参数不经 shell;
 * detached + unref 让 viewer 不阻塞、不等待文件管理器退出。
 */
function revealDirectory(absoluteDir: string): {
  opened: boolean;
  reason?: string;
} {
  const platform = process.platform;
  // Linux 桌面检测:无 DISPLAY 且无 WAYLAND_DISPLAY → headless,降级不 spawn
  if (
    platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return { opened: false, reason: "no-desktop" };
  }
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    const child = spawn(cmd, [absoluteDir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // ENOENT(命令缺失)等异步错误:handler 已返回,只能记录日志便于排查。
    // 文件管理器是 best-effort 功能;极端情况用户可凭返回的 dir 路径手动定位。
    child.on("error", (err) => {
      console.error(
        `[viewer] reveal spawn failed (cmd=${cmd}, dir=${absoluteDir}):`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return { opened: true };
  } catch {
    return { opened: false, reason: "spawn-failed" };
  }
}

/**
 * 启动 Viewer HTTP server
 *
 * 端口解析优先级:
 *   1. env `CO_ENGRAM_VIEWER_PORT`(覆盖默认,高级用户/测试用)
 *   2. `config.port`(显式传入;@deprecated)
 *   3. 统一默认 `18899`
 *
 * hostType 仅用于 UI 文字适配(显示宿主名等),不再影响端口选择。
 *
 * 不抛——端口冲突时自动重试 maxRetries 次。
 */
export function startViewerServer(
  ctx: ToolContext,
  config: ViewerServerConfig = {},
): Promise<ViewerRuntime> {
  const hostType = config.hostType ?? detectHostType();
  const envPortRaw = process.env.CO_ENGRAM_VIEWER_PORT;
  const envPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : undefined;
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
  const startPort =
    (envPortValid ? envPort : undefined) ?? config.port ?? DEFAULT_PORT;
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
        // 根治端口漂移:重试同一端口(等上一任 holder viewer close 释放),
        // 不递增到 port+1 —— viewer 必须固定 18899,漂移会让客户端访问固定端口时找不到。
        setTimeout(() => {
          resolve(
            tryListen(
              ctx,
              port,
              retriesLeft - 1,
              token,
              language,
              dataRoot,
              hostType,
            ),
          );
        }, EADDRINUSE_RETRY_DELAY_MS);
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
    // CORS:仅本机(viewer 自身同源;env 覆盖到其他端口时也允许本机任意端口)
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:18899");
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
        stats: {
          total: 0,
          byKind: {},
          byStatus: {},
          archived: 0,
          forgotten: 0,
        },
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
    respondJson(
      res,
      200,
      computeStatus(dataRoot, {
        ...(ctx.repository?.indexDb ? { indexDb: ctx.repository.indexDb } : {}),
      }),
    );
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
    const statusFilters = url.searchParams
      .getAll("status")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
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
      ...(statusFilters.length > 0 ? { status: statusFilters } : {}),
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

  // /api/engrams/:id/synapses — 该 engram 的 outgoing/incoming 突触列表
  const engramSynapsesMatch = /^\/api\/engrams\/(.+)\/synapses$/.exec(path);
  if (engramSynapsesMatch && req.method === "GET") {
    const id = decodeURIComponent(engramSynapsesMatch[1]!);
    try {
      const synapses = ctx.repository.readSynapses(id);
      respondJson(res, 200, synapses);
    } catch (err) {
      respondJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // /api/engrams/:id/reveal — 在系统文件管理器打开该 engram 所在目录
  //
  // 浏览器无法直接唤起 OS 文件管理器(沙箱限制),必须由 server 端 spawn 系统命令。
  // 路径解析走 repository.resolveDirectory(复用 resolvePath + safeJoinWithinRoot 全套
  // path-traversal 防御)。降级(无桌面 / 命令缺失 / 目录不存在)时返回目录绝对路径,
  // 前端展示路径 + 复制按钮,保证远程 / 容器场景也有价值。
  const engramRevealMatch = /^\/api\/engrams\/(.+)\/reveal$/.exec(path);
  if (engramRevealMatch && req.method === "POST") {
    const id = decodeURIComponent(engramRevealMatch[1]!);
    const dirInfo = ctx.repository.resolveDirectory(id);
    if (!dirInfo) {
      respondJson(res, 404, { error: `Not found: ${id}` });
      return;
    }
    // 目录不存在(index stale / 文件被外部删除)→ 不 spawn,降级返回路径
    if (!existsSync(dirInfo.absoluteDir)) {
      respondJson(res, 200, {
        opened: false,
        reason: "dir-not-found",
        relativePath: dirInfo.relativePath,
        dir: dirInfo.absoluteDir,
      });
      return;
    }
    const result = revealDirectory(dirInfo.absoluteDir);
    respondJson(res, 200, {
      opened: result.opened,
      ...(result.reason ? { reason: result.reason } : {}),
      relativePath: dirInfo.relativePath,
      dir: dirInfo.absoluteDir,
    });
    return;
  }

  // /api/engrams/:id/restore — 恢复 forgotten engram(清 forcedFreshness + status active)
  //
  // 用于 engram_forget 后的恢复:engram_forget 设 forcedFreshness: forgotten 锁定,
  // 此端点调 updateLifecycle(active) + clearForcedFreshness(清锁定),让 freshness 回派生。
  const engramRestoreMatch = /^\/api\/engrams\/(.+)\/restore$/.exec(path);
  if (engramRestoreMatch && req.method === "POST") {
    const id = decodeURIComponent(engramRestoreMatch[1]!);
    if (!ctx.repository.exists(id)) {
      respondJson(res, 404, { error: `Not found: ${id}` });
      return;
    }
    ctx.repository.updateLifecycle(id, "active", undefined);
    ctx.repository.clearForcedFreshness(id);
    const updated = ctx.repository.readEngram(id);
    respondJson(res, 200, {
      restored: true,
      id,
      freshness: updated.freshness,
      status: updated.status,
    });
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

  // /api/skills
  //
  // S6 Task 1: skill 列表与详情端点。
  // 默认 limit=50, max 200;支持 acquisitionStage/retentionStage 过滤。
  if (path === "/api/skills" && req.method === "GET") {
    if (!ctx.skillRepository) {
      respondJson(res, 200, {
        results: [],
        total: 0,
        enabled: false,
      });
      return;
    }
    const acquisitionStageFilter = url.searchParams.get(
      "acquisitionStage",
    ) as AcquisitionStage | null;
    const retentionStageFilter = url.searchParams.get(
      "retentionStage",
    ) as RetentionStage | null;
    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Math.min(Number(limitRaw), 200)
        : 50;

    let skills = ctx.skillRepository.listSkills();
    if (acquisitionStageFilter) {
      skills = skills.filter(
        (s) => s.acquisitionStage === acquisitionStageFilter,
      );
    }
    if (retentionStageFilter) {
      skills = skills.filter((s) => s.retentionStage === retentionStageFilter);
    }

    respondJson(res, 200, {
      results: skills.slice(0, limit),
      total: skills.length,
      enabled: true,
    });
    return;
  }

  // /api/skills/:id/reveal — 在系统文件管理器打开该 skill 所在目录
  //
  // skill 目录 = dataRoot + skill.sourcePath(sourcePath 相对 dataRoot,由 skill-detector
  // collectSkillDirs 生成)。复用 engram 的 revealDirectory + 同响应结构(opened/reason/
  // relativePath/dir),前端复用 engram 的降级 banner 文案模式。token 校验依赖上层
  // handleRequest(与 engram reveal 路由一致,路由内不重复)。
  const skillRevealMatch = /^\/api\/skills\/(.+)\/reveal$/.exec(path);
  if (skillRevealMatch && req.method === "POST") {
    const skillId = decodeURIComponent(skillRevealMatch[1]!);
    if (!ctx.skillRepository) {
      respondJson(res, 503, {
        error: "SkillRepository not available",
        enabled: false,
      });
      return;
    }
    let skill: { readonly sourcePath: string } | undefined;
    try {
      skill = ctx.skillRepository.readSkill(skillId);
    } catch {
      respondJson(res, 404, { error: `Skill not found: ${skillId}` });
      return;
    }
    const absDir = join(ctx.repository.rootPath, skill.sourcePath);
    if (!existsSync(absDir)) {
      respondJson(res, 200, {
        opened: false,
        reason: "dir-not-found",
        relativePath: skill.sourcePath,
        dir: absDir,
      });
      return;
    }
    const result = revealDirectory(absDir);
    respondJson(res, 200, {
      opened: result.opened,
      ...(result.reason ? { reason: result.reason } : {}),
      relativePath: skill.sourcePath,
      dir: absDir,
    });
    return;
  }

  // /api/skills/:id/reactivate — 重新激活 forgotten/stale 技能(viewer 恢复按钮)
  //
  // retentionStage 是纯派生投影(Oblivion 衰减,无锁字段),恢复 = touch lastUsedAt
  // 让 retention 回满 → active。不增 invocationCount、不动 utility(人工恢复不是使用)。
  const skillReactivateMatch = /^\/api\/skills\/(.+)\/reactivate$/.exec(path);
  if (skillReactivateMatch && req.method === "POST") {
    const skillId = decodeURIComponent(skillReactivateMatch[1]!);
    if (!ctx.skillRepository) {
      respondJson(res, 503, { error: "SkillRepository not available", enabled: false });
      return;
    }
    try {
      const skill = ctx.skillRepository.reactivateSkill(skillId);
      respondJson(res, 200, { reactivated: true, skillId, retentionStage: skill.retentionStage });
    } catch (err) {
      respondJson(res, 404, { error: `Skill not found: ${skillId}` });
    }
    return;
  }

  // /api/skills/:id  (GET) — skill 详情
  const skillMatch = /^\/api\/skills\/(.+)$/.exec(path);
  if (skillMatch && req.method === "GET") {
    const skillId = decodeURIComponent(skillMatch[1]!);
    if (!ctx.skillRepository) {
      respondJson(res, 503, {
        error: "SkillRepository not available",
        enabled: false,
      });
      return;
    }
    try {
      const skill = ctx.skillRepository.readSkill(skillId);
      respondJson(res, 200, skill);
    } catch (err) {
      respondJson(res, 404, {
        error: `Skill not found: ${skillId}`,
      });
    }
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

    // statusCounts:让前端按钮显示「已采纳(N) / 已驳回(N) / 全部(N)」。
    // 与上面分页 result 独立 —— statusCounts 反映全量 proposals.jsonl 状态分布,
    // 而 result 只反应当前 status filter 下的当前页。
    const statusCounts = ctx.proposalEngine.statusCounts();

    respondJson(res, 200, {
      results: result.results,
      total: result.total,
      nextCursor: result.nextCursor,
      enabled: true,
      statusCounts,
    });
    return;
  }

  // /api/proposals/purge-dismissed
  //
  // 清空所有 status=dismissed 的 proposal,释放 .co-engram/proposals.jsonl 空间。
  // 用户场景:dismissed 列表累积到几百条后,人工逐条审查已无意义,直接清空更高效。
  // 返回被清空的 entityId 列表(审计 + UI 反馈用)。
  if (path === "/api/proposals/purge-dismissed" && req.method === "POST") {
    if (!ctx.proposalEngine) {
      respondJson(res, 503, {
        error: "Proposal engine not enabled",
        enabled: false,
      });
      return;
    }
    try {
      const purgedIds = ctx.proposalEngine.purgeDismissed();
      // 审计留痕(便于追溯清空动作)
      for (const entityId of purgedIds) {
        ctx.auditLog?.append({
          actor: "user",
          action: "dismiss",
          engramId: entityId,
          metadata: { purged: true, source: "purge-dismissed" },
        });
      }
      respondJson(res, 200, {
        ok: true,
        purgedCount: purgedIds.length,
        purgedIds,
      });
      return;
    } catch (err) {
      respondJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // /api/proposals/purge-accepted
  //
  // 清空所有 status=accepted 的 proposal,释放 .co-engram/proposals.jsonl 空间。
  // 用户场景:accepted 列表累积过多,清空"采纳记录"但保留已创建的 engram。
  // 返回被清空的 entityId 列表(审计 + UI 反馈用)。
  if (path === "/api/proposals/purge-accepted" && req.method === "POST") {
    if (!ctx.proposalEngine) {
      respondJson(res, 503, {
        error: "Proposal engine not enabled",
        enabled: false,
      });
      return;
    }
    try {
      const purgedIds = ctx.proposalEngine.purgeAccepted();
      // 审计留痕(便于追溯清空动作)
      for (const entityId of purgedIds) {
        ctx.auditLog?.append({
          actor: "user",
          action: "accept",
          engramId: entityId,
          metadata: { purged: true, source: "purge-accepted" },
        });
      }
      respondJson(res, 200, {
        ok: true,
        purgedCount: purgedIds.length,
        purgedIds,
      });
      return;
    } catch (err) {
      respondJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // /api/insight-stats —— 洞察质量度量埋点(spec §九:采纳率/后续使用率/critic 一致性基线)
  if (path === "/api/insight-stats" && req.method === "GET") {
    if (!ctx.proposalEngine) {
      respondJson(res, 503, { enabled: false });
      return;
    }
    const insights = ctx.proposalEngine
      .listAll()
      .filter((p) => p.source === "rem-insight");
    let accepted = 0;
    let dismissed = 0;
    let pending = 0;
    const criticScores: Array<{ accepted: boolean; score: number }> = [];
    const usage: Array<{ engramId: string; retrievalCount: number; reinforcementScore: number; failedUses: number }> = [];
    for (const p of insights) {
      if (p.status === "accepted") {
        accepted += 1;
        const payload = p.payload as { criticScore?: number } | undefined;
        criticScores.push({ accepted: true, score: payload?.criticScore ?? 0 });
        if (p.acceptedEngramId) {
          try {
            const e = ctx.repository.readEngram(p.acceptedEngramId);
            usage.push({
              engramId: e.id,
              retrievalCount: e.retrievalCount,
              reinforcementScore: e.reinforcementScore,
              failedUses: e.failedUses,
            });
          } catch {
            // engram 可能已被删除
          }
        }
      } else if (p.status === "dismissed") {
        dismissed += 1;
        const payload = p.payload as { criticScore?: number } | undefined;
        criticScores.push({ accepted: false, score: payload?.criticScore ?? 0 });
      } else {
        pending += 1;
      }
    }
    // 后续使用率:accepted 洞察被检索/强化过的比例(存活期第三关不是死代码的度量)
    const used = usage.filter((u) => u.retrievalCount > 0 || u.reinforcementScore > 0).length;
    // critic 一致性:critic 分与人工 accept 的 Pearson 相关(样本 ≥3 才有意义)
    let criticCorrelation: number | null = null;
    if (criticScores.length >= 3) {
      const n = criticScores.length;
      const xs = criticScores.map((c) => c.score);
      const ys = criticScores.map((c): number => (c.accepted ? 1 : 0));
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i]! - mx) * (ys[i]! - my);
        dx += (xs[i]! - mx) ** 2;
        dy += (ys[i]! - my) ** 2;
      }
      criticCorrelation = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
    }
    respondJson(res, 200, {
      enabled: true,
      total: insights.length,
      accepted,
      dismissed,
      pending,
      acceptanceRate: accepted + dismissed > 0 ? accepted / (accepted + dismissed) : null,
      laterUseRate: accepted > 0 ? used / accepted : null,
      criticCorrelation,
      usage,
    });
    return;
  }

  // ============================================================
  // /api/incubations(夜思实验室,spec §四/§六)+ 异步任务 + 轮询
  // ============================================================
  if (path === "/api/incubations" && req.method === "GET") {
    if (!ctx.incubator) {
      respondJson(res, 503, { enabled: false, items: [] });
      return;
    }
    respondJson(res, 200, { enabled: true, items: ctx.incubator.list() });
    return;
  }

  if (path === "/api/incubations" && req.method === "POST") {
    if (!ctx.incubator) {
      respondJson(res, 503, { enabled: false, error: "night-thinking unavailable" });
      return;
    }
    const body = await readJsonBodyAs<{
      readonly question?: string;
      readonly seedEngramIds?: readonly string[];
      readonly webResearchOptIn?: boolean;
    }>(req);
    if (!body?.question || body.question.trim().length < 4) {
      respondJson(res, 400, { error: "question required (min 4 chars)" });
      return;
    }
    try {
      const entry = ctx.incubator.create({
        question: body.question,
        ...(body.seedEngramIds ? { seedEngramIds: body.seedEngramIds } : {}),
        webResearchOptIn: body.webResearchOptIn === true,
      });
      respondJson(res, 201, { entry });
    } catch (err) {
      respondJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    return;
  }

  // 「立即夜思」走异步任务:viewer 是独立 HTTP server,同步等待分钟级
  // L2 会话必超时 —— 创建后台任务 + GUI 轮询进度,完成后通知(spec §六)。
  const incubationRunMatch = /^\/api\/incubations\/([^/]+)\/run$/.exec(path);
  if (incubationRunMatch && req.method === "POST") {
    if (!ctx.incubator) {
      respondJson(res, 503, { enabled: false, error: "night-thinking unavailable" });
      return;
    }
    const id = decodeURIComponent(incubationRunMatch[1]!);
    const jobId = randomUUID();
    const job: IncubationJob = {
      id: jobId,
      incubationId: id,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    incubationJobs.set(jobId, job);
    trimIncubationJobs();
    void (async () => {
      try {
        const r = await ctx.incubator!.incubateOnce(id, "manual");
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        job.level = r.level;
        job.proposals = r.proposals;
        job.cycleVetoed = r.cycleVetoed;
        job.rounds = r.entry.rounds;
        job.entry = r.entry;
      } catch (err) {
        job.status = "error";
        job.finishedAt = new Date().toISOString();
        job.error = err instanceof Error ? err.message : String(err);
      }
    })();
    respondJson(res, 202, { jobId, status: "running" });
    return;
  }

  const incubationJobMatch = /^\/api\/incubation-jobs\/([^/]+)$/.exec(path);
  if (incubationJobMatch && req.method === "GET") {
    const job = incubationJobs.get(decodeURIComponent(incubationJobMatch[1]!));
    if (!job) {
      respondJson(res, 404, { error: "job not found" });
      return;
    }
    respondJson(res, 200, { ...job });
    return;
  }

  const incubationResolveMatch = /^\/api\/incubations\/([^/]+)\/resolve$/.exec(path);
  if (incubationResolveMatch && req.method === "POST") {
    if (!ctx.incubator) {
      respondJson(res, 503, { enabled: false });
      return;
    }
    const id = decodeURIComponent(incubationResolveMatch[1]!);
    const body = await readJsonBodyAs<{ readonly answered?: boolean }>(req);
    try {
      const updated = ctx.incubator.resolve(id, body?.answered === true);
      respondJson(res, 200, { entry: updated });
    } catch (err) {
      respondJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
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
          readonly kind?:
            | "fact"
            | "observation"
            | "pattern"
            | "procedure"
            | "hypothesis";
          readonly visibility?: "public" | "team" | "private" | "restricted";
        } = {
          ...(body?.title ? { title: body.title } : {}),
          ...(body?.content ? { content: body.content } : {}),
          ...(body?.domainTags ? { domainTags: body.domainTags } : {}),
          // 作者优先动态解析(ctx.resolveCreatedBy 每次读 git,改 user.name 无需重启),
          // fallback 启动快照(ctx.defaultCreatedBy),再前端 body.createdBy。
          ...(() => {
            const author =
              ctx.resolveCreatedBy?.() ??
              ctx.defaultCreatedBy ??
              body?.createdBy;
            return author ? { createdBy: author } : {};
          })(),
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

  // /api/maintenance-state — 方案 A viewer tab:展示 light/deep/rem/daily 运行状态
  //
  // 返回 maintenance-state.json 内容 + 默认 interval(让 UI 计算 "是否已过期")。
  // 文件不存在 / 损坏 → { enabled: true, state: EMPTY_STATE }(tab 显示 "从未跑过")。
  // ctx.repository 缺失 → { enabled: false }(viewer 在无 repo 模式下不展示此 tab)。
  if (path === "/api/maintenance-state" && req.method === "GET") {
    if (!ctx.repository) {
      respondJson(res, 200, { enabled: false, state: null });
      return;
    }
    const state = await readMaintenanceState(ctx.repository.rootPath);
    respondJson(res, 200, {
      enabled: true,
      state,
      intervals: {
        light: DEFAULT_LIGHT_INTERVAL_MS,
        deep: DEFAULT_DEEP_INTERVAL_MS,
        rem: DEFAULT_REM_INTERVAL_MS,
      },
    });
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

    // (2) soft forgotten/frozen(旧值 archived,doctor 自动迁移,期兼容)
    // 双路径:SQLite 可用时 O(N) 查询;不可用时(legacy / 旧 Node)走 readEngram 循环。
    // listTrashedSimple 早有 readEngram fallback,但旧 DELETE 漏掉,导致无 indexDb
    // 时 count=0(2026-07 用户反馈"永久清空全部"不生效,实测根因之一)。
    //
    // 2026-07 改名 archived → frozen:partition 参数接受新值 "frozen" 和旧值
    // "archived"(兼容未刷新的浏览器),SQLite 查询同时匹配两个值。
    const softStatuses =
      partition === "forgotten"
        ? ["forgotten"]
        : partition === "frozen" || partition === "archived"
          ? ["frozen", "archived"]
          : !partition || /^\d{4}-\d{2}$/.test(partition)
            ? ["forgotten", "frozen", "archived"]
            : [];
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
              softStatuses.includes(
                full.status as "forgotten" | "frozen" | "archived",
              )
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
        }
      }
      // 批量删除(2026-07 修复 Bug #6):
      //   旧实现逐条 deleteEngram,每次都触发 persistIndex 全量写盘,
      //   N 条回收站 = N 次写盘 = O(N²)。N=267 时累计 8-22s,期间 HTTP
      //   服务器被阻塞 → 前端 fetch 超时(Bug #7 预扫描失败的元凶)。
      //   批量路径把 N 次 persistIndex 合并成 1 次,其余逐条。
      if (!dryRun && softRows.length > 0) {
        try {
          const ids = softRows.map((r) => r.id);
          const deleted = ctx.repository.deleteEngramsBatch(ids);
          purgedIds.push(...deleted);
        } catch (err) {
          console.error("[viewer] deleteEngramsBatch failed:", err);
          // fallback:逐条删(保证功能性正确,牺牲性能)
          for (const r of softRows) {
            try {
              ctx.repository.deleteEngram(r.id);
              purgedIds.push(r.id);
            } catch (e) {
              console.error(
                `[viewer] failed to purge soft-deleted engram ${r.id}:`,
                e,
              );
            }
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
    // fallback:engrams/ 中 status=forgotten/frozen(旧值 archived 兼容)的软删除项
    if (ctx.repository.exists(id)) {
      try {
        const engram = ctx.repository.readEngram(id);
        const st = engram.status as string | undefined;
        if (st === "forgotten" || st === "frozen" || st === "archived") {
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
        const st = engram.status as string | undefined;
        if (st === "forgotten" || st === "frozen" || st === "archived") {
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
    // forgotten(软删除)不进 engramLocations:目录树计数(listPathTree)与内联文件
    // 都排除 forgotten,与卡片视图(status=active)口径一致。
    const entries = ctx.repository
      .listEngramIndex()
      .filter((e) => (e.status ?? "active") !== "forgotten");
    // ?files=1:增补 title/kind/domainTags/createdAt(取 index entry 已有字段,零额外读盘),
    // 供 viewer 目录树内联展开直属文件行。graph tab 不带 files=1 → payload 不变。
    const withFiles = url.searchParams.get("files") === "1";
    const engramLocations = entries.map((e) => ({
      id: e.id,
      path: e.path,
      ...(withFiles
        ? {
            title: e.title,
            kind: e.kind,
            domainTags: e.domainTags,
            createdAt: e.createdAt,
          }
        : {}),
    }));
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
    const rescan = url.searchParams.get("rescan") === "1";
    // 优先读持久化 doctor-report.json(maintenance deep 定期跑 doctor 写入)。
    // 健康栏默认显示"修复前的问题"——即使 maintenance 已 autoFixed(dangling/
    // orphan/ghost),用户仍能看到 deep 修了什么。?rescan=1 强制重跑(忽略缓存)。
    if (!rescan) {
      try {
        const drPath = join(
          ctx.repository.rootPath,
          ".co-engram",
          "doctor-report.json",
        );
        if (existsSync(drPath)) {
          const cached = JSON.parse(readFileSync(drPath, "utf8"));
          respondJson(res, 200, {
            enabled: true,
            report: cached,
            cached: true,
          });
          return;
        }
      } catch {
        // 持久化读取失败,fallback 到现场跑
      }
    }
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
  // === 2026-08 概览改版新增 ===
  /** 近 7 天新建 engram 数(周增量) */
  readonly weeklyNewEngrams: number;
  /** 近 30 天逐日新建数(记忆脉搏;date=YYYY-MM-DD,缺失日已补 0) */
  readonly createdLast30d: ReadonlyArray<{
    readonly date: string;
    readonly count: number;
  }>;
  /** 累计检索次数(SUM(retrieval_count)) */
  readonly totalRetrievals: number;
  /** 有效检索数(SUM(effective_retrievals),用于取用有效率) */
  readonly effectiveRetrievals: number;
  /** 检索次数 TOP(本月热点,热点榜) */
  readonly topRetrieved: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly retrievalCount: number;
    readonly importance: number;
  }>;
  /** 冷却榜:活跃 + 低重要度 + 最久未取用(重要度降幅的代理指标) */
  readonly topCooling: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly importance: number;
    readonly lastRetrievedAt: number | null;
  }>;
  readonly pendingProposals: number;
  readonly auditEnabled: boolean;
  readonly effectivenessEnabled: boolean;
  readonly proposalEnabled: boolean;
  // S6 Task 1: skill 维度
  readonly totalSkills: number;
  readonly skillsByAcquisitionStage: Record<AcquisitionStage, number>;
  readonly skillsByRetentionStage: Record<RetentionStage, number>;
}

function getStats(ctx: ToolContext): StatsResponse {
  // 按需同步派生层:补救 fs.watch(inotify)对编辑器原子写漏事件,导致 engram .md
  // 外部编辑未同步到 SQLite(无 indexDb 时 rescanModifiedEngrams 内部 noop;有则仅
  // stat 成本,mtime 未变的条目跳过)。让「改文件 → 网页内容更新」不依赖 fs.watch 实时性。
  try {
    ctx.repository.rescanModifiedEngrams();
  } catch {
    // 同步失败不阻塞 stats 读取,下次 fs.watch 事件 / 启动扫描会重试
  }
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
  const tagRows = db
    .prepare(
      `SELECT domain, count(*) AS n
     FROM engram_domains
     GROUP BY domain
     ORDER BY n DESC, domain ASC
     LIMIT 20`,
    )
    .all() as { domain: string; n: number }[];
  const topTags = tagRows.map((r) => ({ tag: r.domain, count: r.n }));

  // === 2026-08 概览改版新指标(全部走既有列,零新 schema) ===
  const DAY_MS = 86_400_000;
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const weeklyNewEngrams =
    (
      db
        .prepare(`SELECT count(*) AS n FROM engrams WHERE created_at >= ?`)
        .get(weekAgo) as { n: number }
    )?.n ?? 0;

  // 记忆脉搏:近 30 天逐日新建(SQL GROUP BY 天 + 服务端补零,客户端直接渲染)
  const pulseRows = db
    .prepare(
      `SELECT (created_at / 86400000) AS day, count(*) AS n
       FROM engrams
       WHERE created_at >= ?
       GROUP BY day`,
    )
    .all(weekAgo - 23 * DAY_MS) as { day: number; n: number }[];
  const pulseMap = new Map<number, number>(
    pulseRows.map((r) => [r.day, r.n]),
  );
  const createdLast30d: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const t = now - i * DAY_MS;
    const day = Math.floor(t / DAY_MS);
    const date = new Date(t).toISOString().slice(0, 10);
    createdLast30d.push({ date, count: pulseMap.get(day) ?? 0 });
  }

  const retrievalAgg = db
    .prepare(
      `SELECT COALESCE(SUM(retrieval_count), 0) AS total,
              COALESCE(SUM(effective_retrievals), 0) AS effective
       FROM engrams`,
    )
    .get() as { total: number; effective: number };

  const topRetrieved = (
    db
      .prepare(
        `SELECT id, title, kind, retrieval_count AS retrievalCount, importance
         FROM engrams
         WHERE status = 'active' AND retrieval_count > 0
         ORDER BY retrieval_count DESC, updated_at DESC
         LIMIT 20`,
      )
      .all() as {
      id: string;
      title: string;
      kind: string;
      retrievalCount: number;
      importance: number;
    }[]
  ).map((r) => ({ ...r, importance: Number(r.importance.toFixed(2)) }));

  const topCooling = (
    db
      .prepare(
        `SELECT id, title, kind, importance, last_retrieved_at AS lastRetrievedAt
         FROM engrams
         WHERE status = 'active' AND last_retrieved_at IS NOT NULL
         ORDER BY last_retrieved_at ASC, importance ASC
         LIMIT 20`,
      )
      .all() as {
      id: string;
      title: string;
      kind: string;
      importance: number;
      lastRetrievedAt: number | null;
    }[]
  ).map((r) => ({ ...r, importance: Number(r.importance.toFixed(2)) }));

  // 4. topContributors:engram 作者走 SQLite GROUP BY(毫秒级);
  //    synapse 作者走 graph.json edges 的 createdBy 字段(GraphBuilder 2026-07 加)。
  //    修复 Bug 3(2026-07):之前 synapseCount 写死 0,「印迹+突触合计」标题误导用户。
  //    旧 graph.json 缺 createdBy 字段时,该 synapse 不计入(下次 graph rebuild 后补齐)。
  const engramContributorRows = db
    .prepare(
      `SELECT created_by AS actor, count(*) AS n
     FROM engrams
     WHERE created_by != ''
     GROUP BY created_by`,
    )
    .all() as { actor: string; n: number }[];

  const contributorMap = new Map<string, { engram: number; synapse: number }>();
  for (const r of engramContributorRows) {
    contributorMap.set(r.actor, { engram: r.n, synapse: 0 });
  }
  // 从 graph.json edges 聚合 synapse createdBy(graph cache 已在 step 2 读)
  for (const edge of graph.edges) {
    const edgeWithCreatedBy = edge as { createdBy?: string };
    const actor = edgeWithCreatedBy.createdBy;
    if (!actor) continue; // 旧 graph.json 缺字段,跳过
    const entry = contributorMap.get(actor);
    if (entry) {
      entry.synapse += 1;
    } else {
      contributorMap.set(actor, { engram: 0, synapse: 1 });
    }
  }
  const topContributors = Array.from(contributorMap.entries())
    .map(([actor, counts]) => ({
      actor,
      engramCount: counts.engram,
      synapseCount: counts.synapse,
      total: counts.engram + counts.synapse,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // S6 Task 1: skill 统计
  let totalSkills = 0;
  const skillsByAcquisitionStage: Record<AcquisitionStage, number> = {
    draft: 0,
    compiled: 0,
    tuned: 0,
  };
  const skillsByRetentionStage: Record<RetentionStage, number> = {
    active: 0,
    aging: 0,
    stale: 0,
    forgotten: 0,
  };
  if (ctx.skillRepository) {
    const skills = ctx.skillRepository.listSkills();
    totalSkills = skills.length;
    for (const skill of skills) {
      skillsByAcquisitionStage[skill.acquisitionStage]++;
      skillsByRetentionStage[skill.retentionStage]++;
    }
  }

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
    weeklyNewEngrams,
    createdLast30d,
    totalRetrievals: retrievalAgg.total,
    effectiveRetrievals: retrievalAgg.effective,
    topRetrieved,
    topCooling,
    auditEnabled: !!ctx.auditLog,
    effectivenessEnabled: !!ctx.effectivenessTracker,
    proposalEnabled: !!ctx.proposalEngine,
    // S6 Task 1: skill 维度
    totalSkills,
    skillsByAcquisitionStage,
    skillsByRetentionStage,
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

  // S6 Task 1: skill 统计
  let totalSkills = 0;
  const skillsByAcquisitionStage: Record<AcquisitionStage, number> = {
    draft: 0,
    compiled: 0,
    tuned: 0,
  };
  const skillsByRetentionStage: Record<RetentionStage, number> = {
    active: 0,
    aging: 0,
    stale: 0,
    forgotten: 0,
  };
  if (ctx.skillRepository) {
    const skills = ctx.skillRepository.listSkills();
    totalSkills = skills.length;
    for (const skill of skills) {
      skillsByAcquisitionStage[skill.acquisitionStage]++;
      skillsByRetentionStage[skill.retentionStage]++;
    }
  }

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
    weeklyNewEngrams: 0,
    createdLast30d: [],
    totalRetrievals: 0,
    effectiveRetrievals: 0,
    topRetrieved: [],
    topCooling: [],
    auditEnabled: !!ctx.auditLog,
    effectivenessEnabled: !!ctx.effectivenessTracker,
    proposalEnabled: !!ctx.proposalEngine,
    // S6 Task 1: skill 维度
    totalSkills,
    skillsByAcquisitionStage,
    skillsByRetentionStage,
  };
}

interface GraphResponse {
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly slug?: string;
    readonly kind: string;
    readonly domainTags: readonly string[];
    /**
     * engram 节点的重要性 [0,1],前端 graph.ts 据此算节点 size
     * (size = 10 + importance * 18)。L4 修复:cache/rebuild 路径从 GraphNode
     * 下发;skill 节点与最终兜底路径不持有,前端兜底 0.5。
     */
    readonly importance?: number;
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
      let cached = graphBuilder.read();
      if (!cached) {
        // L4:graph.json 缺失 → 重建。rebuild 生成含 importance 的 GraphNode,
        // 与 cache 路径走同一映射(下发 importance 给前端算节点 size);同时
        // 写出 graph.json 让后续请求走 cache。降级到 listEngrams 的兜底路径
        // 不下发 importance(前端兜底 0.5),仅 rebuild 也失败时才走它。
        graphBuilder.rebuild();
        cached = graphBuilder.read();
      }
      if (cached) {
        const _skill = buildSkillGraph(ctx);
        return {
          nodes: [
            ...cached.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              importance: n.importance,
              ...(n.slug ? { slug: n.slug } : {}),
              kind: n.kind,
              domainTags: n.domainTags ?? [],
            })),
            ..._skill.nodes,
          ],
          edges: [
            ...cached.edges.map((e) => ({
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
            ..._skill.edges,
          ],
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
        direction: isSymmetricKind(s.kind) ? "bidirectional" : "directional",
        ...(s.resolutionState?.status
          ? { resolutionStatus: s.resolutionState.status }
          : {}),
      });
    }
  } catch {
    // synapse 目录不可用就降级为无边图
  }

  const _skill = buildSkillGraph(ctx);
  return {
    nodes: [...nodes, ..._skill.nodes],
    edges: [...edges, ..._skill.edges],
  };
}

/** S6 B6:构建 skill 节点 + composes/relatedEngrams 边(叠加到 graph,与 engram/synapse 并存) */
function buildSkillGraph(ctx: ToolContext): {
  nodes: GraphResponse["nodes"][number][];
  edges: GraphResponse["edges"][number][];
} {
  const skillRepo = (
    ctx as {
      skillRepository?: {
        listSkills(): ReadonlyArray<{
          skillId: string;
          composes?: readonly string[];
          relatedEngrams?: readonly string[];
        }>;
      };
    }
  ).skillRepository;
  if (!skillRepo) return { nodes: [], edges: [] };
  try {
    const skills = skillRepo.listSkills();
    const nid = (skillId: string) => "skill:" + skillId;
    const nodes = skills.map((s) => ({
      id: nid(s.skillId),
      title: s.skillId,
      kind: "skill",
      domainTags: ["skill"],
    }));
    const edges: GraphResponse["edges"][number][] = [];
    for (const s of skills) {
      const sid = nid(s.skillId);
      for (const target of s.composes ?? []) {
        edges.push({
          id: `compose:${s.skillId}:${target}`,
          from: sid,
          to: nid(target),
          kind: "composes",
          weight: 0.5,
          evidenceCount: 0,
          direction: "directional",
        });
      }
      for (const eid of s.relatedEngrams ?? []) {
        edges.push({
          id: `related:${s.skillId}:${eid}`,
          from: sid,
          to: eid,
          kind: "related",
          weight: 0.5,
          evidenceCount: 0,
          direction: "bidirectional",
        });
      }
    }
    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}

interface TrashListItem {
  readonly id: string;
  /**
   * 回收站项来源:
   *   - "swept":物理已 sweep 到 .trash/<partition>/ 下(由 sweepToTrash 移入)
   *   - "soft":逻辑软删除(status=forgotten/frozen,旧值 archived)但文件仍在主索引 engrams/
   *
   * 区分原因:用户「查看/恢复/清空」三类操作对两种来源的处理路径不同。
   * 旧实现把它们混入同一列表但只支持 .trash/ 路径,导致 386 条全部按钮失败。
   */
  readonly source: "swept" | "soft";
  /** 分区:swept 时是 .trash/<YYYY-MM>;soft 时是 "forgotten" / "frozen"(旧值 "archived" 兼容) */
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
      const rows = ctx.repository.indexDb
        .prepare(
          `SELECT id, title, kind, updated_at, status
         FROM engrams
         WHERE status IN ('forgotten', 'archived')
         ORDER BY updated_at DESC`,
        )
        .all() as {
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
  // Legacy fallback(SQLite 不可用时):对 forgotten/frozen(旧值 archived 兼容)子集 readEngram
  for (const entry of ctx.repository.listEngrams()) {
    if (seen.has(entry.id)) continue;
    try {
      const full = ctx.repository.readEngram(entry.id);
      const st = full.status as string | undefined;
      if (st === "forgotten" || st === "frozen" || st === "archived") {
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
/** 夜思异步任务注册表(server 进程内;「立即夜思」不挂起 HTTP 请求,spec §六) */
interface IncubationJob {
  readonly id: string;
  readonly incubationId: string;
  status: "running" | "done" | "error";
  readonly startedAt: string;
  finishedAt?: string;
  level?: "L1" | "L2";
  proposals?: number;
  cycleVetoed?: boolean;
  rounds?: number;
  entry?: unknown;
  error?: string;
}
const incubationJobs = new Map<string, IncubationJob>();
const INCUBATION_JOB_CAP = 50;

function trimIncubationJobs(): void {
  while (incubationJobs.size > INCUBATION_JOB_CAP) {
    const oldest = incubationJobs.keys().next().value;
    if (oldest === undefined) break;
    incubationJobs.delete(oldest);
  }
}

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
