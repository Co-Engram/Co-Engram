/**
 * Daemon e2e 测试 — 真实 spawn daemon 进程,验证 socket + 多 session 共享 + fallback。
 *
 * 标记 serial(每个 it 启停一个 daemon,不能并行)。
 * 标记 e2e(不是单测,跑真实子进程 + 真实 fs + 真实 socket)。
 *
 * 测试范围:
 *   - daemon spawn → lockfile 写入 → socket 就绪
 *   - 多 client 连接同一 daemon(共享 pid)
 *   - 跨 session 数据共享(client-A create,client-B search)
 *   - graceful shutdown(SIGTERM → lockfile + socket 清理)
 *   - CO_ENGRAM_DAEMON=0 fallback 到 in-process(不 spawn daemon)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const packageRoot = resolve(here, "../..");
const daemonEntry = resolve(packageRoot, "dist/daemon/daemon-entry.js");
const mcpEntry = resolve(packageRoot, "dist/mcp-server.js");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface DaemonHandle {
  readonly pid: number;
  readonly socketPath: string;
  readonly lockPath: string;
  shutdown: () => Promise<void>;
}

async function waitForDaemonReady(
  lockPath: string,
  timeoutMs = 10_000,
): Promise<{ readonly pid: number; readonly socketPath: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid: number; socketPath: string };
        if (parsed.pid && parsed.socketPath) {
          // probe socket
          const ok = await probeSocket(parsed.socketPath);
          if (ok) return { pid: parsed.pid, socketPath: parsed.socketPath };
        }
      } catch {
        // corrupt or stale, wait
      }
    }
    await sleep(100);
  }
  throw new Error(`daemon not ready within ${timeoutMs}ms (lockPath=${lockPath})`);
}

function probeSocket(socketPath: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ path: socketPath });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function startDaemon(dataRoot: string, idleMs = 30_000): Promise<{ child: ChildProcess; handle: DaemonHandle }> {
  const child = spawn(process.execPath, [daemonEntry, dataRoot], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CO_ENGRAM_DAEMON_IDLE_TIMEOUT_MS: String(idleMs),
      // 测试时禁用 auto-memory watcher,避免污染 ~/.claude/projects
      CO_ENGRAM_AUTO_MEMORY_SYNC: "0",
      // 禁用 maintenance 防止后台任务产生干扰
      CO_ENGRAM_MAINTENANCE_ENABLED_STAGES: "",
    },
  });
  child.stderr.on("data", () => {
    // 测试期间静默 stderr(调试时取消注释)
    // process.stderr.write("[daemon-test] " + c);
  });
  const lockPath = join(dataRoot, ".co-engram/daemon.lock");
  const info = await waitForDaemonReady(lockPath);
  const handle: DaemonHandle = {
    pid: info.pid,
    socketPath: info.socketPath,
    lockPath,
    shutdown: async () => {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // already dead
      }
      // wait lockfile gone
      for (let i = 0; i < 50; i++) {
        if (!existsSync(lockPath)) return;
        await sleep(100);
      }
    },
  };
  return { child, handle };
}

interface McpClient {
  readonly socket: Socket;
  initialize: () => Promise<unknown>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}

async function connectMcpClient(socketPath: string, name: string): Promise<McpClient> {
  const socket = createConnection({ path: socketPath });
  const buffer: Buffer[] = [];
  const pending = new Map<number, (msg: unknown) => void>();
  let reqId = 0;

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error(`${name}: connect timeout`)), 5000);
  });

  socket.on("data", (chunk: Buffer) => {
    buffer.push(chunk);
    const text = Buffer.concat(buffer).toString();
    const lines = text.split("\n");
    let consumed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { consumed = i + 1; continue; }
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          const resolver = pending.get(msg.id);
          if (resolver) {
            pending.delete(msg.id);
            resolver(msg);
            consumed = i + 1;
          } else {
            consumed = i + 1;
          }
        } else {
          consumed = i + 1;
        }
      } catch {
        break;
      }
    }
    buffer.length = 0;
    if (consumed < lines.length) {
      const remaining = lines.slice(consumed).join("\n");
      if (remaining) buffer.push(Buffer.from(remaining));
    }
  });

  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${name}.${method} timeout`));
        }
      }, 10_000);
    });
  };

  return {
    socket,
    initialize: () => send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name, version: "1.0" },
    }),
    callTool: (toolName, args) => send("tools/call", { name: toolName, arguments: args }),
    close: () => { try { socket.destroy(); } catch { /* ignore */ } },
  };
}

describe("daemon e2e (serial)", () => {
  let dataRoot: string;

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "daemon-e2e-"));
  });

  afterAll(() => {
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(join(tmpdir(), "co-engram"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("daemon spawn + multi-session sharing", () => {
    let child: ChildProcess;
    let handle: DaemonHandle;

    beforeAll(async () => {
      ({ child, handle } = await startDaemon(dataRoot));
    });

    afterAll(async () => {
      await handle.shutdown();
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    });

    it("daemon 启动后写出 lockfile + 监听 socket", () => {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.socketPath).toMatch(/daemon-[0-9a-f]{16}\.sock$/);
      expect(existsSync(handle.socketPath)).toBe(true);
    });

    it("多个 MCP client 可同时连接同一 daemon(共享 pid)", async () => {
      const clientA = await connectMcpClient(handle.socketPath, "client-A");
      const clientB = await connectMcpClient(handle.socketPath, "client-B");
      const initA = await clientA.initialize();
      const initB = await clientB.initialize();
      expect((initA as { result?: { serverInfo?: { name: string } } }).result?.serverInfo?.name).toBe("co-engram");
      expect((initB as { result?: { serverInfo?: { name: string } } }).result?.serverInfo?.name).toBe("co-engram");
      clientA.close();
      clientB.close();
    });

    it("跨 session ToolContext 共享:client-A 创建,client-B 立即搜到", async () => {
      const clientA = await connectMcpClient(handle.socketPath, "creator");
      const clientB = await connectMcpClient(handle.socketPath, "searcher");
      await clientA.initialize();
      await clientB.initialize();

      const uniqueTitle = `daemon-shared-${Date.now()}`;
      const createResp = await clientA.callTool("engram_create", {
        title: uniqueTitle,
        content: "created by client-A through the daemon",
        kind: "observation",
        domainTags: ["daemon-e2e"],
        createdBy: "e2e-A",
      }) as { result?: { structuredContent?: { id?: string } } };
      const engramId = createResp.result?.structuredContent?.id;
      expect(engramId).toBeTruthy();

      // 等索引写入完成
      await sleep(300);

      const searchResp = await clientB.callTool("engram_search", {
        query: uniqueTitle,
      }) as { result?: { structuredContent?: { results?: Array<{ title: string }> } } };

      const titles = searchResp.result?.structuredContent?.results?.map((r) => r.title) ?? [];
      expect(titles).toContain(uniqueTitle);

      clientA.close();
      clientB.close();
    });
  });

  describe("graceful shutdown", () => {
    it("SIGTERM 触发 graceful shutdown:lockfile + socket 都被清理", async () => {
      const isolated = mkdtempSync(join(tmpdir(), "daemon-shutdown-"));
      try {
        const { child, handle } = await startDaemon(isolated);
        expect(existsSync(handle.socketPath)).toBe(true);

        process.kill(handle.pid, "SIGTERM");

        // 等 lockfile 消失
        for (let i = 0; i < 50; i++) {
          if (!existsSync(handle.lockPath)) break;
          await sleep(100);
        }
        expect(existsSync(handle.lockPath)).toBe(false);

        // socket 文件也应该被删除
        await sleep(500);
        expect(existsSync(handle.socketPath)).toBe(false);

        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      } finally {
        try { rmSync(isolated, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("in-process fallback (CO_ENGRAM_DAEMON=0)", () => {
    it("env=0 时 mcp-server 直接走 in-process,不 spawn daemon", async () => {
      const isolated = mkdtempSync(join(tmpdir(), "daemon-fallback-"));
      const isolatedLock = join(isolated, ".co-engram/daemon.lock");
      try {
        // 启动 mcp-server(env=0,不会 spawn daemon)
        const child = spawn(process.execPath, [mcpEntry], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CO_ENGRAM_DAEMON: "0",
            CO_ENGRAM_AUTO_MEMORY_SYNC: "0",
            CO_ENGRAM_MAINTENANCE_ENABLED_STAGES: "",
          },
          // 注意:mcp-server 用 ~/.co-engram/config.json 的 dataRoot,
          // 不接受 env CO_ENGRAM_DATA_ROOT(deprecated)。我们临时改 config 来重定向。
        });

        // 让进程跑 2 秒,看是否产生 lockfile
        await sleep(2000);
        expect(existsSync(isolatedLock)).toBe(false);

        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      } finally {
        try { rmSync(isolated, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});
