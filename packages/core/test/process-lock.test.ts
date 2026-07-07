/**
 * 进程级互斥锁测试
 *
 * 覆盖场景:
 *   1. 空目录 acquire → holder
 *   2. 已有 fresh lock(pid 存活 + heartbeat 新鲜)→ non-holder
 *   3. stale lock(pid 不存活)→ 接管成 holder
 *   4. zombie lock(pid 存活但 heartbeat 过期)→ 接管成 holder
 *   5. 损坏 lockfile → 删除 + retry → holder
 *   6. heartbeat 周期重写 heartbeatAt
 *   7. release 清理 lockfile + stop heartbeat
 *   8. 双 acquire 同 path 竞争 → 第一个 holder,第二个 non-holder
 *   9. failover:holder release 后 non-holder 在 staleMs/2 内接管
 *
 * @module @co-engram/core/test/process-lock
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireProcessLock,
  defaultLockPath,
  type LockFileContent,
} from "../src/concurrency/process-lock.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-plock-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一个伪造的 lockfile(模拟其他进程留下的状态) */
function seedLockfile(
  lockPath: string,
  content: Partial<LockFileContent> & { readonly pid: number },
): void {
  const now = new Date().toISOString();
  const full: LockFileContent = {
    host: "test",
    acquiredAt: now,
    heartbeatAt: now,
    ...content,
  };
  mkdirSync(lockPath.replace(/[/][^/]+$/, ""), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(full), "utf8");
}

/** 等待 ms 毫秒(用于 failover / heartbeat 周期验证) */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("acquireProcessLock", () => {
  it("空目录 acquire → holder,lockfile 含 pid + acquiredAt + heartbeatAt", () => {
    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock.isHolder).toBe(true);
    expect(existsSync(lock.lockPath)).toBe(true);

    const raw = readFileSync(lock.lockPath, "utf8");
    const parsed = JSON.parse(raw) as LockFileContent;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.host).toBe("test");
    expect(parsed.acquiredAt).toBe(parsed.heartbeatAt);
    expect(Date.parse(parsed.acquiredAt)).toBeGreaterThan(0);

    lock.release();
    expect(existsSync(lock.lockPath)).toBe(false);
  });

  it("已有 fresh lock(pid 存活 + heartbeat 新鲜)→ non-holder,不写 lockfile", () => {
    const lockPath = defaultLockPath(tmpDir);
    // 用当前 pid 模拟"另一个活着的 holder"(process.kill(pid, 0) 会成功)
    seedLockfile(lockPath, { pid: process.pid, host: "other" });

    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock.isHolder).toBe(false);
    // lockfile 内容应保留原 holder(host=other,未被覆盖)
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.host).toBe("other");

    lock.release();
    // non-holder release 不删 lockfile
    expect(existsSync(lockPath)).toBe(true);
  });

  it("stale lock(pid 不存活)→ 接管成 holder,lockfile 改写为本进程 pid", () => {
    const lockPath = defaultLockPath(tmpDir);
    // pid 999999 几乎肯定不存在;process.kill 会 ESRCH
    seedLockfile(lockPath, { pid: 999_999, host: "dead" });

    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock.isHolder).toBe(true);
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.host).toBe("test");

    lock.release();
  });

  it("zombie lock(pid 存活但 heartbeat 过期)→ 接管成 holder", () => {
    const lockPath = defaultLockPath(tmpDir);
    // pid 存活(自己),但 heartbeatAt 是很久以前 → 过 staleMs
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    seedLockfile(lockPath, {
      pid: process.pid,
      host: "zombie",
      heartbeatAt: oldTime,
    });

    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock.isHolder).toBe(true);
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.host).toBe("test");

    lock.release();
  });

  it("损坏 lockfile(JSON.parse 失败)→ 删除 + retry → holder", () => {
    const lockPath = defaultLockPath(tmpDir);
    mkdirSync(lockPath.replace(/[/][^/]+$/, ""), { recursive: true });
    writeFileSync(lockPath, "{ corrupted content !!!", "utf8");

    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock.isHolder).toBe(true);
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.pid).toBe(process.pid);

    lock.release();
  });

  it("heartbeat 周期重写 heartbeatAt(acquiredAt 不变)", async () => {
    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 30,
      staleMs: 60_000,
    });
    expect(lock.isHolder).toBe(true);

    const before = JSON.parse(
      readFileSync(lock.lockPath, "utf8"),
    ) as LockFileContent;
    await sleep(80);
    const after = JSON.parse(
      readFileSync(lock.lockPath, "utf8"),
    ) as LockFileContent;

    expect(after.acquiredAt).toBe(before.acquiredAt);
    expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(
      Date.parse(before.heartbeatAt),
    );

    lock.release();
  });

  it("release 清理 lockfile + stop heartbeat(release 后 lockfile 不再被改写)", async () => {
    const lock = acquireProcessLock({
      dataRoot: tmpDir,
      host: "test",
      heartbeatMs: 20,
      staleMs: 60_000,
    });
    expect(lock.isHolder).toBe(true);

    lock.release();
    expect(existsSync(lock.lockPath)).toBe(false);

    // 等 2 个 heartbeat 周期,确认 lockfile 不会被再次写入(heartbeat 已停)
    await sleep(60);
    expect(existsSync(lock.lockPath)).toBe(false);
  });

  it("双 acquire 同 path 竞争 → 第一个 holder,第二个 non-holder", () => {
    const lockPath = defaultLockPath(tmpDir);
    const lock1 = acquireProcessLock({
      dataRoot: tmpDir,
      host: "session-1",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });
    const lock2 = acquireProcessLock({
      dataRoot: tmpDir,
      host: "session-2",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });

    expect(lock1.isHolder).toBe(true);
    expect(lock2.isHolder).toBe(false);
    expect(lock1.lockPath).toBe(lockPath);
    expect(lock2.lockPath).toBe(lockPath);

    // lockfile 内容反映第一个 holder
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.host).toBe("session-1");

    lock1.release();
    lock2.release();
  });

  it("failover:holder release 后 non-holder 在 staleMs/2 内接管", async () => {
    const lockPath = defaultLockPath(tmpDir);
    const lock1 = acquireProcessLock({
      dataRoot: tmpDir,
      host: "session-1",
      heartbeatMs: 60_000,
      staleMs: 60_000,
    });
    const lock2 = acquireProcessLock({
      dataRoot: tmpDir,
      host: "session-2",
      // 短 staleMs 让 retry 周期短(< 500ms)
      heartbeatMs: 60_000,
      staleMs: 200,
    });

    expect(lock1.isHolder).toBe(true);
    expect(lock2.isHolder).toBe(false);

    // holder release → lockfile 被删
    lock1.release();
    expect(existsSync(lockPath)).toBe(false);

    // 等 retry 周期(staleMs/2 = 100ms)+ buffer
    await sleep(300);

    // lock2 应已接管
    expect(lock2.isHolder).toBe(true);
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as LockFileContent;
    expect(parsed.host).toBe("session-2");

    lock2.release();
  });
});
