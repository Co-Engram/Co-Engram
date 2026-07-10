/**
 * Daemon Launcher — 发现 / spawn / 健康检查 / fallback。
 *
 * 入口策略(由 mcp-server.ts main 调用):
 *
 *   1. 解析 dataRoot(沿用 resolveBootstrapDataRoot)
 *   2. 读 daemon.lockfile
 *      - 不存在 / 损坏 / 版本不匹配 → spawn 新 daemon
 *      - 存在但 pid 不存活 → spawn 新 daemon(清理 stale lockfile/socket)
 *      - pid 存活但 socket connect 失败 → daemon 卡死,spawn 新 daemon
 *      - 全部健康 → 直接返回 socketPath(thin launcher 模式)
 *   3. spawn 新 daemon:`spawn detached co-engram-mcp-daemon <dataRoot>`
 *      - 等待 socket ready(轮询 connect,最多 10 秒)
 *      - 成功 → 返回 socketPath
 *      - 超时 / spawn 失败 → 抛错,调用方 fallback 到 in-process main
 *
 * Fallback 安全网:
 *   - 任何 spawn / connect / lockfile 错误都向上抛
 *   - mcp-server.ts main() catch 后 fallback 到当前 in-process 模式(零回归)
 *
 * 用户禁用 daemon:
 *   - env CO_ENGRAM_DAEMON=0 → 跳过 daemon 模式,直接 in-process(显式 opt-out)
 *   - 用于调试 / 受限环境
 *
 * @module @co-engram/claude-code/daemon
 */

import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync as fsExistsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  defaultDaemonLockPath,
  defaultSocketPath,
  hashDataRoot,
  readDaemonLockfile,
  removeDaemonLockfile,
  isPidAlive,
} from "./protocol.js";

/** Launcher 决策结果 */
export type LauncherDecision =
  /** daemon 已存在,thin launcher 用 socketPath 连接 */
  | { readonly kind: "connect"; readonly socketPath: string }
  /** spawn 新 daemon 失败,调用方 fallback 到 in-process main */
  | { readonly kind: "fallback"; readonly reason: string };

/** 用户显式禁用 daemon(env CO_ENGRAM_DAEMON=0) */
export function isDaemonDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CO_ENGRAM_DAEMON ?? "1").toString().trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/** 测试 socket 是否可连(50ms 超时) */
function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 等待 socket 就绪(轮询 connect,最多 totalTimeoutMs) */
async function waitForSocket(
  socketPath: string,
  totalTimeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  const probeIntervalMs = 100;
  while (Date.now() - start < totalTimeoutMs) {
    if (await probeSocket(socketPath, 200)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));
  }
  return false;
}

/** 定位 daemon entry 脚本(同 dist 目录下的 daemon-entry.js) */
function findDaemonEntryPath(): string | undefined {
  // 同包 src/daemon/launcher.ts → 编译后 dist/daemon/launcher.js
  // daemon-entry.js 应在 dist/daemon/daemon-entry.js
  try {
    const here = fileURLToPath(import.meta.url);
    const dir = dirname(here);
    const candidate = join(dir, "daemon-entry.js");
    if (fsExistsSync(candidate)) return candidate;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 启动新 daemon 进程。
 *
 * - detached:true(unlink from parent,父退出不影响 daemon)
 * - stdio:ignore(daemon 自己写 stderr,不污染 parent)
 * - 返回 daemon 子进程引用,供调用方跟踪(可选)
 */
function spawnDaemon(opts: {
  readonly dataRoot: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly stderrLogPath?: string;
}): ReturnType<typeof spawn> {
  const entry = findDaemonEntryPath();
  if (!entry) {
    throw new Error(
      "daemon-entry.js not found — package build missing daemon entry",
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CO_ENGRAM_DAEMON_SOCKET_PATH: opts.socketPath,
    // 把 stderr 重定向到日志文件(可选)便于诊断;不指定时继承父进程 stderr
  };

  // detached daemon:setsid + unlink from parent
  const child = spawn(process.execPath, [entry, opts.dataRoot], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // 静默 — 调用方通过 waitForSocket 失败兜底
  });
  // 防止父进程退出时 SIGTERM 传导到 daemon(unref 解除 child 与 parent 的生命周期关联)
  child.unref();
  return child;
}

/**
 * 主入口:mcp-server.ts main() 在调 thin launcher 前调此函数。
 *
 * 返回 socket path(daemon 已就绪)。失败抛错,调用方 catch 后 fallback 到 in-process。
 */
export async function ensureDaemon(opts: {
  readonly dataRoot: string;
  /**
   * spawn 超时(默认 10 秒)。
   *
   * daemon bootstrap 通常 1-3 秒(config 加载 + repository 重建索引 + viewer 启动);
   * 大库(1000+ engram)可能 5-8 秒。10 秒兜底足够。
   */
  readonly spawnTimeoutMs?: number;
  readonly stderr?: NodeJS.WriteStream;
}): Promise<string> {
  const stderr = opts.stderr ?? process.stderr;
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? 10_000;

  const lockPath = defaultDaemonLockPath(opts.dataRoot);
  const expectedSocketPath =
    process.env.CO_ENGRAM_DAEMON_SOCKET_PATH ?? defaultSocketPath(opts.dataRoot);
  const expectedDataRootHash = hashDataRoot(opts.dataRoot);

  // 1. 读 lockfile,判定现有 daemon 是否健康
  const lock = readDaemonLockfile(lockPath);
  if (lock) {
    const pidAlive = isPidAlive(lock.pid);
    const hashMatches = lock.dataRootHash === expectedDataRootHash;
    if (pidAlive && hashMatches) {
      // pid 存活 + hash 匹配 → 探测 socket
      const socketOk = await probeSocket(lock.socketPath);
      if (socketOk) {
        // 健康 → 直接复用
        return lock.socketPath;
      }
      // socket 不可连但 pid 存活 → daemon 卡死(socket handle 泄漏 / event loop 阻塞)
      stderr.write(
        `[co-engram-launcher] daemon pid=${lock.pid} alive but socket unreachable — respawning\n`,
      );
      // 尝试 kill stale daemon(不强制,失败忽略)
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch {
        // ignore — 可能已经被回收
      }
      removeDaemonLockfile(lockPath);
      try {
        unlinkSync(lock.socketPath);
      } catch {
        // ignore
      }
    } else {
      // pid 不存活 或 hash 不匹配 → 清理 stale
      stderr.write(
        `[co-engram-launcher] stale lockfile (pidAlive=${pidAlive}, hashMatches=${hashMatches}) — cleaning\n`,
      );
      removeDaemonLockfile(lockPath);
      try {
        unlinkSync(lock.socketPath);
      } catch {
        // ignore
      }
    }
  }

  // 2. spawn 新 daemon
  stderr.write(
    `[co-engram-launcher] spawning daemon for ${opts.dataRoot}\n`,
  );
  spawnDaemon({
    dataRoot: opts.dataRoot,
    socketPath: expectedSocketPath,
    lockPath,
  });

  // 3. 等待 socket 就绪
  const ready = await waitForSocket(expectedSocketPath, spawnTimeoutMs);
  if (!ready) {
    throw new Error(
      `daemon did not become ready within ${spawnTimeoutMs}ms (socket=${expectedSocketPath})`,
    );
  }

  stderr.write(`[co-engram-launcher] daemon ready at ${expectedSocketPath}\n`);
  return expectedSocketPath;
}

/**
 * 显式 shutdown daemon(测试 / 管理用)。
 *
 * 发送 SIGTERM,daemon 自身的 graceful shutdown 流程会接管。
 */
export function shutdownDaemon(dataRoot: string): void {
  const lockPath = defaultDaemonLockPath(dataRoot);
  const lock = readDaemonLockfile(lockPath);
  if (!lock) return;
  if (isPidAlive(lock.pid)) {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  // lockfile / socket 清理由 daemon 自身 shutdown 流程完成
}
