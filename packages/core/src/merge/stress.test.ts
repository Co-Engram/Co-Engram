/**
 * P4.1 — 50-person concurrency stress test (spec §8.3)
 *
 * 模拟 50 个团队成员同时操作 team-memory,验证:
 *   1. 同一进程内并发 createEngram 无丢失(spec §8.3 PR1)
 *   2. 并发 createEngram + createSynapse 无悬挂引用
 *   3. 并发 updateEngram 版本号正确递增
 *   4. mixed createEngram + runDoctor 无 race corruption
 *   5. 并发写 audit log 不丢条目
 *
 * 注:vitest sandbox 内不能 spawn 子进程,所以真实多进程场景留给 e2e
 * (packages/e2e/test/dual-host.e2e.test.ts)。这里只测进程内的并发 I/O 交错。
 *
 * @module @co-engram/core/merge
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramRepository } from "../storage/repository.js";
import { AuditLog } from "../observability/audit-log.js";

const CONCURRENCY = 50;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stress-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe(`concurrency stress (N=${CONCURRENCY})`, () => {
  it("concurrent createEngram: all writes preserved, no collisions", async () => {
    const repo = new EngramRepository({ rootPath: dir, language: "en" });

    const writes = Array.from({ length: CONCURRENCY }, (_, i) =>
      repo.createEngram({
        title: `engram-${i}`,
        content: `content for ${i}`,
        kind: "observation",
        domainTags: ["stress-test"],
        createdBy: `user-${i}`,
      }),
    );

    const results = await Promise.all(writes);

    expect(results).toHaveLength(CONCURRENCY);
    const ids = new Set(results.map((e) => e.id));
    expect(ids.size).toBe(CONCURRENCY); // 无 ID 碰撞

    // 50 个 engram 全部能从仓库读回
    const catalog = repo.listEngrams();
    expect(catalog.length).toBe(CONCURRENCY);
    for (const entry of catalog) {
      const en = repo.readEngram(entry.id);
      expect(en.domainTags).toContain("stress-test");
    }
  });

  it("concurrent createEngram + createSynapse: no dangling references", async () => {
    const repo = new EngramRepository({ rootPath: dir, language: "en" });

    // 先批量创建 50 个 engram(2 个一组配对)
    const engrams = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        repo.createEngram({
          title: `node-${i}`,
          content: `node content ${i}`,
          kind: "observation",
          domainTags: ["graph"],
          createdBy: "stress",
        }),
      ),
    );

    // 然后并发建 synapse(链式:0→1, 2→3, ...)
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < engrams.length; i += 2) {
      pairs.push([engrams[i]!.id, engrams[i + 1]!.id]);
    }

    await Promise.all(
      pairs.map(([fromId, toId]) =>
        repo.createSynapse({
          from: fromId as never,
          to: toId as never,
          kind: "related_to",
          weight: 0.5,
          createdBy: "stress",
        }),
      ),
    );

    // 验证:每个有 outgoing synapse 的 engram 都能读回
    for (const [fromId] of pairs) {
      const { outgoing } = repo.readSynapses(fromId);
      expect(outgoing.length).toBeGreaterThan(0);
      // target 必须存在
      for (const syn of outgoing) {
        expect(repo.exists(syn.to)).toBe(true);
      }
    }
  });

  it("concurrent updateEngram on different engrams: all versions persist", async () => {
    const repo = new EngramRepository({ rootPath: dir, language: "en" });
    const created = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        repo.createEngram({
          title: `t-${i}`,
          content: `c-${i}`,
          kind: "observation",
          domainTags: ["concurrent-update"],
          createdBy: "u",
        }),
      ),
    );

    await Promise.all(
      created.map((en, i) =>
        repo.updateEngram(en.id, {
          content: `updated content ${i}`,
          importance: 0.5 + (i % 10) * 0.05,
          updatedBy: `user-${i}`,
        }),
      ),
    );

    for (const en of created) {
      const fresh = repo.readEngram(en.id);
      expect(fresh.version).toBe(2); // create=1, update=2
      expect(fresh.content).toMatch(/^updated content /);
    }
  });

  it("mixed createEngram + runDoctor: no race corruption", async () => {
    const repo = new EngramRepository({ rootPath: dir, language: "en" });

    const tasks: Promise<unknown>[] = [];
    // 一半在创建
    for (let i = 0; i < CONCURRENCY / 2; i++) {
      tasks.push(
        repo.createEngram({
          title: `mix-${i}`,
          content: `c-${i}`,
          kind: "observation",
          domainTags: ["mixed"],
          createdBy: "u",
        }),
      );
    }
    // 一半在跑 doctor(读路径,会触发 index 重建)
    for (let i = 0; i < CONCURRENCY / 2; i++) {
      tasks.push(
        new Promise((resolve) =>
          setImmediate(() => resolve(repo.runDoctor({ incremental: true }))),
        ),
      );
    }

    await Promise.all(tasks);

    // 校验:已创建的 engram 都在
    const catalog = repo.listEngrams();
    expect(catalog.length).toBe(CONCURRENCY / 2);
  });

  it("concurrent audit log writes: every entry persisted", async () => {
    const audit = new AuditLog(dir);
    const writes = Array.from({ length: CONCURRENCY }, (_, i) =>
      Promise.resolve(
        audit.append({
          actor: `user-${i}`,
          action: "engram_created",
          metadata: { sequence: i },
        }),
      ),
    );

    await Promise.all(writes);

    const entries = audit.query();
    expect(entries.length).toBe(CONCURRENCY);
    // ts 单调递增(ISO 字符串按字典序比较等价于按时间比较,UTC 同格式)
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.ts >= entries[i - 1]!.ts).toBe(true);
    }
    // 每个 user 都有记录
    const actors = new Set(entries.map((e) => e.actor));
    for (let i = 0; i < CONCURRENCY; i++) {
      expect(actors.has(`user-${i}`)).toBe(true);
    }
  });
});
