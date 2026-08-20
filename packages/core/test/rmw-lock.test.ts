import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireRmwLock, withRmwLock } from "../src/concurrency/rmw-lock.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-rmw-lock-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("rmw-lock(短临界区文件锁)", () => {
  it("acquire → release 后锁文件清除,可再次 acquire", () => {
    const lockPath = join(tmpDir, "store.lock");
    const h1 = acquireRmwLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    h1.release();
    expect(existsSync(lockPath)).toBe(false);
    const h2 = acquireRmwLock(lockPath);
    h2.release();
  });

  it("互斥:持锁期间再次 acquire 需等待(总超时后 fail-loud 报错)", () => {
    const lockPath = join(tmpDir, "store.lock");
    const h1 = acquireRmwLock(lockPath);
    // 持锁不释放 → 第二次 acquire 在总超时(3s)后报错,而非静默通过
    expect(() => acquireRmwLock(lockPath)).toThrow(/timeout/);
    h1.release();
  });

  it("release 的 token 防误删:锁被他人持有时 release 不删他人锁", () => {
    const lockPath = join(tmpDir, "store.lock");
    const h1 = acquireRmwLock(lockPath);
    // 模拟 h1 锁文件被 stale 破锁后 h2 持有:直接伪造 h2 的锁文件
    h1.release(); // 正常释放后 h2 acquire
    const h2 = acquireRmwLock(lockPath);
    // h1 的 handle 再次 release(迟到释放):token 已不匹配 → 不删 h2 的锁
    h1.release();
    expect(existsSync(lockPath)).toBe(true);
    h2.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("stale 破锁:崩溃残留(mtime 超过 STALE_MS)可被破除并 acquire 成功", () => {
    const lockPath = join(tmpDir, "store.lock");
    // 伪造 11s 前的崩溃残留锁
    writeFileSync(lockPath, JSON.stringify({ pid: -1, token: "dead", at: 0 }) + "\n");
    const stale = new Date(Date.now() - 11_000);
    utimesSync(lockPath, stale, stale);
    const h = acquireRmwLock(lockPath); // 破锁后拿到
    h.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("withRmwLock:临界区执行 + 异常时锁仍释放", () => {
    const lockPath = join(tmpDir, "store.lock");
    expect(withRmwLock(lockPath, () => 42)).toBe(42);
    expect(() => withRmwLock(lockPath, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false); // 异常路径锁已释放
    // 锁可用性恢复
    expect(withRmwLock(lockPath, () => "ok")).toBe("ok");
  });

  it("原子性对照:锁文件不影响数据文件的 rename 原子写语义", () => {
    // 文档性用例:rmw-lock 与 tmp-rename 是互补机制(锁管互斥,rename 管原子)
    const lockPath = join(tmpDir, "store.lock");
    const h = acquireRmwLock(lockPath);
    expect(statSync(lockPath).size).toBeGreaterThan(0);
    h.release();
  });
});
