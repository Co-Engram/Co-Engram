/**
 * 进程级互斥锁 — 保证同一 dataRoot 上只有一个 host adapter 实例跑重型的
 * 后台任务(maintenance / audit rotation / fs.watch / proposal observe)。
 *
 * 背景:Claude Code 每开一个 session 就 fork 一个 mcp-server 进程,每个进程
 * 完整启动 maintenance engine + audit rotation + fs.watch,共享同一 dataRoot
 * 时彼此触发 fs.watch 链式响应,导致 CPU 被多个进程叠加烧满,viewer HTTP
 * 完全卡死。
 *
 * 锁机制:O_EXCL lockfile + pid + heartbeat + stale detect。
 *   - acquire 用 fs.openSync(path, "wx") 原子创建,EEXIST 走 stale check
 *   - holder 周期重写 heartbeatAt(默认 30s)
 *   - non-holder 周期 retry acquire(默认 45s = staleMs/2)
 *   - stale 判定:lockfile 中 pid 不存活,或 heartbeatAt 过期(默认 90s)
 *
 * 与 audit rotation 同款工程风格:setInterval + unref、fail-soft、零新依赖。
 * 不是配置开关 — 生产代码固定启用。测试通过 ProcessLockOptions 的
 * heartbeatMs / staleMs 注入快速 stale 验证(测试钩子,非生产配置)。
 *
 * @module @co-engram/core/concurrency
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_STALE_MS = 90 * 1000;

/** Lock 文件默认路径:<dataRoot>/.co-engram/agent.lock */
export function defaultLockPath(dataRoot: string): string {
  return join(dataRoot, ".co-engram", "agent.lock");
}

interface LockFileContent {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export interface ProcessLockOptions {
  /** dataRoot 路径(lockfile 落在 <dataRoot>/.co-engram/agent.lock) */
  readonly dataRoot: string;
  /**
   * host 标识(claude-code-mcp / openclaw-plugin),写入 lockfile 便于诊断
   *
   * 仅用于诊断,不参与互斥逻辑 — 同一 dataRoot 上跨 host 也互斥。
   */
  readonly host: string;
  /** heartbeat 周期(默认 30s);测试钩子,生产代码用默认值 */
  readonly heartbeatMs?: number;
  /** stale 阈值(默认 90s);测试钩子,生产代码用默认值 */
  readonly staleMs?: number;
  /** override lockfile 路径(测试用,默认 <dataRoot>/.co-engram/agent.lock) */
  readonly lockPath?: string;
}

export interface ProcessLock {
  /** 本进程是否持有锁(=是否负责后台任务) */
  readonly isHolder: boolean;
  /** lockfile 路径 */
  readonly lockPath: string;
  /** 释放:stop heartbeat / retry,holder 时额外 unlink lockfile */
  release(): void;
}

/**
 * 测试 pid 是否存活(process.kill 信号 0 = 探测)。
 *
 * 返回 true = 存活;false = 不存活(ESRCH)或无权限(EPERM,视为不存活
 * 以避免误判 zombie,虽然 EPERM 通常意味着 pid 属于其他 user)。
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM:进程存在但无权限探测。视为存活(更保守 — 不会误删别人的锁)。
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * 尝试获取 dataRoot 上的进程锁。
 *
 * 返回 ProcessLock 实例。isHolder=true 时调用方负责启动 maintenance /
 * audit rotation / fs.watch 等后台任务;isHolder=false 时调用方跳过这些
 * 任务(non-holder 模式,只做工具调用 + viewer)。
 *
 * 内部启动 setInterval:
 *   - holder:周期重写 heartbeatAt
 *   - non-holder:周期 retry acquire(holder 退出 / zombie 时接管)
 *
 * setInterval 都 unref,不阻塞 Node 退出。release() 清理所有句柄与 lockfile。
 */
export function acquireProcessLock(opts: ProcessLockOptions): ProcessLock {
  const lockPath = opts.lockPath ?? defaultLockPath(opts.dataRoot);
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pid = process.pid;

  // 父目录确保存在(dataRoot 可能在首次启动时还未创建)
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // 已存在或权限不足都忽略 — 后续 openSync 失败会被 catch
  }

  // closure-captured state,通过 getter 暴露
  const state: { isHolder: boolean } = { isHolder: false };
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  let retryHandle: ReturnType<typeof setInterval> | null = null;

  const writeLockfileFromContent = (content: LockFileContent): void => {
    // 覆盖写入(< 200 字节,POSIX 单 write atomic)
    writeFileSync(lockPath, JSON.stringify(content), "utf8");
  };

  /**
   * O_EXCL 原子创建 lockfile + writeSync 写入内容。
   *
   * fd 拿到时已 atomic claim 了 lockPath;writeSync 到 fd 保证内容与 claim
   * 之间无调度窗口(不会让其他进程读到空 lockfile)。
   */
  const tryCreateHolder = (): boolean => {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
      const now = new Date().toISOString();
      const content: LockFileContent = {
        pid,
        host: opts.host,
        acquiredAt: now,
        heartbeatAt: now,
      };
      writeSync(fd, JSON.stringify(content));
      return true;
    } catch {
      // EEXIST = 已有 lockfile;其他错误(权限/磁盘满)→ fail-soft
      // 任何错误都返回 false,由调用方走 stale check 或降级 non-holder
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }
  };

  /**
   * 检查现有 lockfile 是否 stale(应被接管)。
   *
   * stale 判据(JSON.parse 成功后):
   *   1. pid 不存活(进程已退出)
   *   2. heartbeatAt 超过 staleMs(zombie holder)
   *
   * JSON.parse 失败(损坏 lockfile)→ 视为 stale(应被覆盖接管)
   * lockfile 不存在或读不出 → 视为非 stale(由调用方再次尝试 O_EXCL)
   */
  const isLockfileStale = (): boolean => {
    let raw: string;
    try {
      raw = readFileSync(lockPath, "utf8");
    } catch {
      // 读不出(不存在 / 权限)→ 不是 stale,是 fresh empty
      return false;
    }
    let parsed: LockFileContent;
    try {
      parsed = JSON.parse(raw) as LockFileContent;
    } catch {
      // 损坏 → stale(应被接管)
      return true;
    }
    if (!isPidAlive(parsed.pid)) {
      return true;
    }
    const heartbeatAge = Date.now() - Date.parse(parsed.heartbeatAt);
    if (Number.isFinite(heartbeatAge) && heartbeatAge > staleMs) {
      return true;
    }
    return false;
  };

  /**
   * 完整 acquire 流程:O_EXCL → stale check → takeover。
   *
   * 返回 true = 本进程是 holder;false = non-holder(已有健康 holder)。
   */
  const tryAcquireOrTakeover = (): boolean => {
    if (tryCreateHolder()) return true;
    // lockfile 已存在 — 判断是否可接管
    if (!isLockfileStale()) return false;
    try {
      unlinkSync(lockPath);
    } catch {
      // 删除失败(race:别人已删 / 权限)→ 这次 acquire 失败,降级 non-holder
      return false;
    }
    // 删除成功,再试一次 O_EXCL
    return tryCreateHolder();
  };

  const stopHeartbeat = (): void => {
    if (heartbeatHandle !== null) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
  };

  const stopRetry = (): void => {
    if (retryHandle !== null) {
      clearInterval(retryHandle);
      retryHandle = null;
    }
  };

  const startRetry = (): void => {
    if (retryHandle !== null) return;
    retryHandle = setInterval(() => {
      if (tryAcquireOrTakeover()) {
        stopRetry();
        state.isHolder = true;
        startHeartbeat();
      }
    }, Math.max(50, Math.floor(staleMs / 2)));
    if (typeof retryHandle.unref === "function") retryHandle.unref();
  };

  /**
   * 启动 holder heartbeat:周期重写 heartbeatAt。
   *
   * 若 lockfile 丢失 / pid 变了(被别的进程接管),降级为 non-holder。
   */
  const startHeartbeat = (): void => {
    if (heartbeatHandle !== null) return;
    heartbeatHandle = setInterval(() => {
      let raw: string;
      try {
        raw = readFileSync(lockPath, "utf8");
      } catch {
        stopHeartbeat();
        state.isHolder = false;
        startRetry();
        return;
      }
      let parsed: LockFileContent;
      try {
        parsed = JSON.parse(raw) as LockFileContent;
      } catch {
        stopHeartbeat();
        state.isHolder = false;
        startRetry();
        return;
      }
      if (parsed.pid !== pid) {
        // lockfile 已被别人接管(holder failover 完成或本进程被偷锁)
        stopHeartbeat();
        state.isHolder = false;
        startRetry();
        return;
      }
      // 同 pid → 刷新 heartbeatAt(acquiredAt/host 保留)
      writeLockfileFromContent({
        pid,
        host: opts.host,
        acquiredAt: parsed.acquiredAt,
        heartbeatAt: new Date().toISOString(),
      });
    }, heartbeatMs);
    if (typeof heartbeatHandle.unref === "function") heartbeatHandle.unref();
  };

  // 初始 acquire
  if (tryAcquireOrTakeover()) {
    state.isHolder = true;
    startHeartbeat();
  } else {
    state.isHolder = false;
    startRetry();
  }

  return {
    get isHolder(): boolean {
      return state.isHolder;
    },
    lockPath,
    release(): void {
      stopHeartbeat();
      stopRetry();
      if (state.isHolder) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore(可能已被其他人删)
        }
        state.isHolder = false;
      }
    },
  };
}
