// packages/core/test/storage/index-db-concurrency.test.ts
//
// Task 1.7:跨进程并发测试 —— WAL 多 reader + 单 writer。
//
// 验证 WAL 模式下:多个 reader 子进程持续 SELECT count(*),父进程同时
// upsertEngram 50 次,双方都不应被阻塞到超时/busy。
//
// 设计要点:
// - worker 必须是独立 .mjs 文件,fork() 用 Node 直接运行(不经 vitest/Vite)。
// - worker 直接用 node:sqlite 而非 IndexDb 类:子进程无 ts 编译链路,
//   走最短路径打开同一 db 文件。
// - worker 退出码语义:0 = 100 次 SELECT 全部成功;2 = 任一次 SELECT 抛错。
// - 主断言:3 个 worker 全 exit 0;writer 50 次 upsert < 5s(WAL 不应严重退化)。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { IndexDb } from "../../src/storage/index-db.js";

let dbDir: string;
let dbPath: string;

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * 生成临时 worker 脚本:打开 dbPath,循环 SELECT count(*) N 次。
 * 用 ESM 直接 import node:sqlite,绕过 vitest/Vite resolver。
 */
function writeWorkerScript(scriptPath: string, targetDbPath: string): void {
  const code = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(targetDbPath)});
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
for (let i = 0; i < 100; i++) {
  try {
    db.prepare("SELECT count(*) as n FROM engrams").get();
  } catch (e) {
    console.error("read failed at iter", i, e?.message ?? e);
    process.exit(2);
  }
}
db.close();
process.exit(0);
`;
  writeFileSync(scriptPath, code);
}

describe("IndexDb WAL 并发", () => {
  it("多 reader 与单 writer 并发:reader 不阻塞 writer,writer 不阻塞 reader", async () => {
    dbDir = mkdtempSync(join(tmpdir(), "co-engram-conc-"));
    dbPath = join(dbDir, "index.db");
    // 初始化 schema(必须先建表,否则 worker SELECT 报 no such table)
    const init = new IndexDb({ dbPath });
    init.open();
    init.close();

    const workerFile = join(dbDir, "reader-worker.mjs");
    writeWorkerScript(workerFile, dbPath);

    // 启动 3 个 reader 子进程并发
    const readers: ChildProcess[] = [];
    for (let i = 0; i < 3; i++) {
      readers.push(fork(workerFile, [], { stdio: "pipe" }));
    }

    // 父进程并发写 50 条(WAL 单 writer,但与 reader 不互斥)
    const writer = new IndexDb({ dbPath });
    writer.open();
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      writer.upsertEngram({
        id: `conc-${i}`,
        title: `concurrent-${i}`,
        kind: "fact",
        importance: 0.5,
        confidence: 0.8,
        updatedAt: Date.now(),
        contentSize: 0,
        visibility: "public",
        status: "active",
        domainTags: ["conc"],
        summary: "",
        contentTokens: "",
      });
    }
    const elapsed = Date.now() - start;
    writer.close();

    // 等所有 reader 退出,断言 exit code 全 0
    const exitCodes = await Promise.all(
      readers.map(
        (r) =>
          new Promise<number>((resolve) => {
            r.on("exit", (code) => resolve(code ?? -1));
          }),
      ),
    );

    expect(exitCodes).toEqual([0, 0, 0]);
    // WAL 不应严重退化:50 次 upsert 应远低于 5s
    expect(elapsed).toBeLessThan(5000);
  }, 30000);
});
