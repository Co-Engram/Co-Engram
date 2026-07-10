/**
 * Daemon 控制协议 — launcher ↔ daemon 之间的元信息交换。
 *
 * 不参与 MCP JSON-RPC 工具调用(那是 thin-launcher 的字节流透传职责)。
 * 本协议仅用于:
 *   - launcher 启动时探测 daemon 是否存活(读 lockfile + ping)
 *   - daemon 主动 shutdown(空闲超时 / 显式终止)
 *   - 调试用状态查询(连接数 / uptime / 版本)
 *
 * Lockfile 落在 <dataRoot>/.co-engram/daemon.lock,JSON 格式:
 *   { pid, socketPath, dataRootHash, startedAt, heartbeatAt, version }
 *
 * 与 ProcessLock 的差异:
 *   - ProcessLock 是 holder / non-holder 互斥(只允许一个跑后台任务)
 *   - daemon.lock 是 daemon 进程的 service endpoint(所有 session 共享)
 *   两者独立,daemon 自己再用 ProcessLock 决定是否启 holder-only 任务
 *
 * @module @co-engram/claude-code/daemon
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** daemon.lock 文件默认路径 */
export function defaultDaemonLockPath(dataRoot: string): string {
  return join(dataRoot, ".co-engram", "daemon.lock");
}

/** 计算 dataRoot 的短 hash(用于 socket 文件名,避免路径注入) */
export function hashDataRoot(dataRoot: string): string {
  return createHash("sha256").update(dataRoot).digest("hex").slice(0, 16);
}

/** 计算 unix socket 路径(基于 dataRoot hash,避免不同 dataRoot 冲突) */
export function defaultSocketPath(dataRoot: string): string {
  const hash = hashDataRoot(dataRoot);
  // 路径长度限制:Linux sun_path 108 字节,macOS 104 字节。
  // 用 /tmp 前缀 + hash 完全够用,避免用户路径超长。
  const dir = process.env.CO_ENGRAM_DAEMON_SOCKET_DIR ?? join(tmpdir(), "co-engram");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 已存在或权限问题忽略 — 后续 connect / listen 失败由调用方处理
  }
  return join(dir, `daemon-${hash}.sock`);
}

/** Lockfile 内容 */
export interface DaemonLockfile {
  /** daemon 进程 pid */
  readonly pid: number;
  /** unix socket 路径 */
  readonly socketPath: string;
  /** dataRoot 的 hash(防止误用其他 dataRoot 的 lockfile) */
  readonly dataRootHash: string;
  /** daemon 启动时间 ISO */
  readonly startedAt: string;
  /** 最近一次 heartbeat 时间 ISO(后台 setInterval 更新) */
  readonly heartbeatAt: string;
  /** daemon 协议版本(不匹配时 launcher 视为 stale,重新 spawn) */
  readonly version: string;
}

/** daemon 控制协议版本(变更需同步升级,旧 lockfile 视为 stale) */
export const DAEMON_PROTOCOL_VERSION = "1";

/**
 * 读 lockfile — 损坏 / 不存在 / 版本不匹配时返回 undefined。
 *
 * 版本检查确保协议升级后旧 daemon 被 launcher 视为 stale。
 */
export function readDaemonLockfile(lockPath: string): DaemonLockfile | undefined {
  if (!existsSync(lockPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: Partial<DaemonLockfile>;
  try {
    parsed = JSON.parse(raw) as Partial<DaemonLockfile>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.pid !== "number" ||
    typeof parsed.socketPath !== "string" ||
    typeof parsed.dataRootHash !== "string" ||
    parsed.version !== DAEMON_PROTOCOL_VERSION
  ) {
    return undefined;
  }
  return parsed as DaemonLockfile;
}

/**
 * 写 lockfile — 覆盖写入(< 300 字节,POSIX 单 write atomic)。
 */
export function writeDaemonLockfile(lockPath: string, content: DaemonLockfile): void {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // 已存在忽略
  }
  writeFileSync(lockPath, JSON.stringify(content), "utf8");
}

/** 删除 lockfile(忽略不存在错误) */
export function removeDaemonLockfile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/** 探测 pid 是否存活(process.kill 信号 0) */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}
