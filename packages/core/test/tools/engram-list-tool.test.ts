// packages/core/test/tools/engram-list-tool.test.ts
//
// Task 3.1:engram_list 新 shape 测试(named input + required limit + cursor 分页)。
//
// 验证:
//   - limit 必填,缺省时 schema 拒绝
//   - limit > 500 被 schema 拒绝
//   - 返回 { items, nextCursor } 而非旧 { results, total }
//   - cursor 翻页稳定:第二页不与第一页重复,且全量遍历无遗漏
//   - 最后一页 nextCursor = null
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EngramRepository } from "../../src/storage/repository.js";
import { engramListTool } from "../../src/tools/engram-tools.js";
import type { ToolContext } from "../../src/tools/tool.js";

let repo: EngramRepository;
let ctx: ToolContext;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engram-list-tool-"));
  repo = new EngramRepository({ rootPath: tmpRoot });
  ctx = { repository: repo } as unknown as ToolContext;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

import { afterEach } from "vitest";

describe("engram_list 新 shape", () => {
  it("limit 缺失时 schema 校验失败", () => {
    expect(() => engramListTool.execute({} as never, ctx)).toThrow(/limit/);
  });

  it("limit > 500 被 schema 拒绝", () => {
    expect(() => engramListTool.execute({ limit: 501 }, ctx)).toThrow();
  });

  it("limit = 0 被拒绝(positive)", () => {
    expect(() => engramListTool.execute({ limit: 0 }, ctx)).toThrow();
  });

  it("接受 named input + 返回 { items, nextCursor }", () => {
    repo.createEngram({
      title: "t1",
      content: "c1",
      kind: "fact",
      domainTags: ["demo"],
      createdBy: "tester",
    });
    const result = engramListTool.execute({ limit: 50 }, ctx);
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("nextCursor");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(1);
    expect(result.nextCursor).toBeNull();
  });

  it("cursor 翻页稳定:第二页不与第一页重复,无遗漏", () => {
    for (let i = 0; i < 25; i++) {
      repo.createEngram({
        title: `entry-${i}`,
        content: `c-${i}`,
        kind: "fact",
        domainTags: ["demo"],
        createdBy: "tester",
      });
    }

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      const result = engramListTool.execute(
        cursor ? { limit: 10, cursor } : { limit: 10 },
        ctx,
      );
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id);
      }
      cursor = result.nextCursor;
      if (cursor === null) break;
      iterations++;
    }

    expect(seenIds.size).toBe(25);
    expect(cursor).toBeNull();
  });

  it("filter 按 domainTags 过滤", () => {
    repo.createEngram({
      title: "alpha",
      content: "a",
      kind: "fact",
      domainTags: ["a"],
      createdBy: "tester",
    });
    repo.createEngram({
      title: "beta",
      content: "b",
      kind: "fact",
      domainTags: ["b"],
      createdBy: "tester",
    });
    const result = engramListTool.execute(
      { limit: 50, filter: { domainTags: ["a"] } },
      ctx,
    );
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.title).toBe("alpha");
  });
});
