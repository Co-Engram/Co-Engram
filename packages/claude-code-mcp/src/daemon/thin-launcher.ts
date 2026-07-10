/**
 * Thin Launcher — Claude Code stdio ↔ daemon socket 字节流透传。
 *
 * 这是最薄的一层:不解析 MCP JSON-RPC,不持有任何状态,只把 stdin 收到的字节
 * 转发到 socket,把 socket 收到的字节转发到 stdout。Claude Code 配置零变更
 * (`command: co-engram-mcp` 仍然有效),内部悄悄切换到 daemon 模式。
 *
 * 流程:
 *   1. 解析 dataRoot(env CO_ENGRAM_DATA_ROOT 已废弃;由 daemon.lockfile 提供)
 *      实际上 thin-launcher 不需要知道 dataRoot —— launcher 已经把 socket path
 *      通过 env CO_ENGRAM_DAEMON_SOCKET_PATH 传入,直接连接即可。
 *   2. net.connect(socketPath)
 *   3. process.stdin → socket(socket.write + drain)
 *   4. socket → process.stdout(stdout.write + drain)
 *   5. socket close / stdin EOF → process.exit(0)
 *
 * 错误处理:任何端 close / error 都让 launcher 退出。Claude Code 会看到子进程
 * 退出,可能会重启它(由 Claude Code 自己的策略决定)。
 *
 * @module @co-engram/claude-code/daemon
 */

import { createConnection } from "node:net";

export interface ThinLauncherOptions {
  /** unix socket 路径(env CO_ENGRAM_DAEMON_SOCKET_PATH 优先) */
  readonly socketPath: string;
  /**
   * 连接超时(默认 5000ms)。
   *
   * daemon 启动后 socket 就绪通常 < 100ms;超过 5s 视为僵尸 daemon,launcher 抛错。
   */
  readonly connectTimeoutMs?: number;
  /** 自定义 stdin(测试用,默认 process.stdin) */
  readonly stdin?: NodeJS.ReadStream;
  /** 自定义 stdout(测试用,默认 process.stdout) */
  readonly stdout?: NodeJS.WriteStream;
  /** 自定义 stderr(测试用,默认 process.stderr) */
  readonly stderr?: NodeJS.WriteStream;
}

/**
 * 运行 thin launcher。阻塞直到 socket 关闭或 stdin EOF。
 *
 * 返回 exit code(0 = 正常退出,非 0 = 异常)。
 */
export function runThinLauncher(opts: ThinLauncherOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;

  return new Promise<number>((resolve) => {
    let exited = false;
    const exit = (code: number): void => {
      if (exited) return;
      exited = true;
      try {
        stdin.removeAllListeners();
        socket.removeAllListeners();
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(code);
    };

    const socket = createConnection(socketOpts(opts.socketPath));

    const connectTimer = setTimeout(() => {
      stderr.write(
        `[co-engram-launcher] connect timeout (${connectTimeoutMs}ms) — daemon socket not responding\n`,
      );
      exit(1);
    }, connectTimeoutMs);
    connectTimer.unref();

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      // binary 模式 — 不解释控制字符
      // 注:setEncoding(null) 在 Node 类型上是错的,实际上 stdin 默认就是 Buffer
      // 这里只 resume,不 setEncoding(确保 chunk 是 Buffer / Uint8Array)
      stdin.resume();

      // stdin → socket
      stdin.on("data", (chunk: Buffer) => {
        const ok = socket.write(chunk);
        if (!ok) {
          stdin.pause();
          socket.once("drain", () => stdin.resume());
        }
      });
      stdin.on("end", () => {
        // Claude Code 关闭 stdin → 半关闭 socket 写端
        try {
          socket.end();
        } catch {
          // ignore
        }
      });
      stdin.on("error", (err) => {
        stderr.write(
          `[co-engram-launcher] stdin error: ${err.message}\n`,
        );
        exit(1);
      });
    });

    // socket → stdout
    socket.on("data", (chunk: Buffer) => {
      const ok = stdout.write(chunk);
      if (!ok) {
        socket.pause();
        stdout.once("drain", () => socket.resume());
      }
    });
    socket.on("close", () => {
      exit(0);
    });
    socket.on("error", (err) => {
      stderr.write(`[co-engram-launcher] socket error: ${err.message}\n`);
      exit(1);
    });

    // graceful signals
    process.on("SIGTERM", () => exit(0));
    process.on("SIGINT", () => exit(0));
  });
}

/**
 * 计算 createConnection options。
 *
 * Unix socket 路径受 sun_path 长度限制(Linux 108 / macOS 104)。已由 protocol.ts
 * 控制(<dataRoot hash>),不会超长。
 */
function socketOpts(socketPath: string): { path: string } {
  return { path: socketPath };
}
