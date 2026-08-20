/**
 * 短临界区文件锁 —— JSON 状态文件多进程 RMW(读-改-写)互斥。
 *
 * 与 process-lock(长持锁的「单写者身份」,面向 maintenance 后台任务)互补:
 * rmw-lock 只在「读 → 变更 → 写回」的毫秒级窗口内互斥,任何进程等锁后都能
 * 进临界区。适用于用户数据通道(如 incubations.json):把 holder-only 落盘
 * 模式用在用户 CRUD 上会让 non-holder 实例静默丢数据(2026-08-19 ponder
 * 假成功 bug 的根因),本原语是其替代 —— 门禁从「进程身份」改成「临界区
 * 互斥」,多实例部署(Claude Code 每会话一个 MCP 实例 + daemon)下人人可写。
 *
 * 实现:
 * - O_EXCL 创建锁文件(内容 pid+token)→ 执行临界区 → release 按 token 校验
 *   后删除(token 不匹配 = 本锁已被 stale 破锁并由他人持有,不删 —— 防误删
 *   他人后来抢到的锁)
 * - 争用时 Atomics.wait 退避等待(不烧 CPU;Node 主线程可用)
 * - 达总超时仍拿不到:发现 stale 锁(mtime 超过 STALE_MS 的崩溃残留)则破锁
 *   并重置等待窗口重试;锁仍鲜活则抛错 —— fail-loud,宁可报错不静默丢写
 *
 * 同进程重入(如 delete 临界区内调 releaseThinking)由调用方深度计数处理,
 * 本原语不做重入。
 *
 * @module @co-engram/core/concurrency/rmw-lock
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** 争用退避序列(ms;超出后取末位) */
const BACKOFF_MS = [5, 10, 20, 40, 80, 160, 320, 320, 320] as const;
/** 拿锁总超时:超时后进入 stale 检测(临界区毫秒级,3s 足够宽) */
const TOTAL_TIMEOUT_MS = 3_000;
/** stale 判定:锁文件 mtime 距今超过该值视为崩溃残留,可破 */
const STALE_MS = 10_000;

/** 同步 sleep(Node 主线程可用;阻塞 event loop —— 仅用于毫秒级临界区争用) */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** O_EXCL 创建锁文件;已存在(EEXIST)返回 false,其余错误上抛(fail-loud) */
function tryCreateLockFile(lockPath: string, token: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, token, at: Date.now() }) + "\n",
      );
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export interface RmwLockHandle {
  /** 释放锁:按 token 校验后删除锁文件;锁已被破/被他人持有则无害退出 */
  release(): void;
}

/** 获取短临界区锁;超过总超时(含一次 stale 破锁重试)仍失败则抛错 */
export function acquireRmwLock(lockPath: string): RmwLockHandle {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let start = Date.now();
  let staleBroken = false;

  for (let round = 0; ; round += 1) {
    if (tryCreateLockFile(lockPath, token)) {
      return {
        release: () => {
          try {
            const raw = readFileSync(lockPath, "utf8");
            const owner = JSON.parse(raw) as { readonly token?: string };
            // token 匹配才删:不匹配 = 本锁已被超时破锁,现为他人持有
            if (owner.token === token) unlinkSync(lockPath);
          } catch {
            // 锁文件已不存在(被 stale 破锁):本方已不持锁,无需清理
          }
        },
      };
    }

    if (Date.now() - start > TOTAL_TIMEOUT_MS) {
      if (staleBroken) {
        throw new Error(
          `rmw-lock acquire timeout: ${lockPath} (still contended ${TOTAL_TIMEOUT_MS}ms after stale-break)`,
        );
      }
      let broke = false;
      try {
        const mtimeMs = statSync(lockPath).mtimeMs;
        if (Date.now() - mtimeMs > STALE_MS) {
          unlinkSync(lockPath);
          broke = true;
        }
      } catch {
        // 锁文件刚好消失(持有者已释放):直接重试
        broke = true;
      }
      if (broke) {
        // 破锁/消失后重置等待窗口再试一轮;锁鲜活则 fail-loud
        staleBroken = true;
        start = Date.now();
        continue;
      }
      throw new Error(
        `rmw-lock acquire timeout: ${lockPath} (contended ${TOTAL_TIMEOUT_MS}ms, lock alive — holder likely mid-critical-section or crashed recently; retry)`,
      );
    }

    sleepSync(BACKOFF_MS[Math.min(round, BACKOFF_MS.length - 1)]!);
  }
}

/** 在短临界区锁保护下执行 fn(同步临界区;临界区内禁止 LLM/网络等长耗时调用) */
export function withRmwLock<T>(lockPath: string, fn: () => T): T {
  const handle = acquireRmwLock(lockPath);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
