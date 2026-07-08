/**
 * engram_audit_query 工具测试(Task 3.3 + Task 3.4 cursor 分页)
 *
 * 验证 AuditLog 数据通过工具层暴露给 agent / 用户,新 shape `{ items, nextCursor }`。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuditLog } from "../src/observability/audit-log.js";
import { engramAuditQueryTool } from "../src/tools/audit-query-tool.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { EngramRepository } from "../src/storage/repository.js";

let tmpDir: string;
let audit: AuditLog;
let ctx: ToolContext;

// Minimal stub repository — engram_audit_query 不读 repository 的内容,
// 但 AI-2 修复后会调 ctx.repository.exists(engramId) 校验存在性。
// stub 默认所有 id 都"存在",除非在 NONEXISTENT_IDS 集合里(用于 NOT_FOUND 测试)。
const NONEXISTENT_IDS = new Set(["nonexistent-id", "deleted-id"]);
const stubRepo = {
  exists: (id: string): boolean => !NONEXISTENT_IDS.has(id),
} as unknown as EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-audit-query-"));
  audit = new AuditLog(tmpDir);
  ctx = { repository: stubRepo, auditLog: audit };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 直接写 audit.jsonl,用确定性 ts 覆盖多条 entry。
 *
 * AuditLog.append 用 new Date().toISOString(),无法注入时钟。测试需要
 * 确定性 ts 序列(尤其是 cursor 分页测试)时,绕过 append 直接写文件。
 */
function writeAuditLines(
  lines: ReadonlyArray<{ ts: string; action: string; engramId?: string }>,
): void {
  mkdirSync(dirname(audit.path), { recursive: true });
  const text =
    lines
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";
  writeFileSync(audit.path, text, "utf8");
}

describe("engram_audit_query (Task 3.3 + 3.4)", () => {
  it("limit 缺失时 schema 校验失败", () => {
    expect(() =>
      engramAuditQueryTool.execute({ engramId: "E1" } as never, ctx),
    ).toThrow(/limit/);
  });

  it("limit > 1000 被 schema 拒绝", () => {
    expect(() =>
      engramAuditQueryTool.execute({ limit: 1001 }, ctx),
    ).toThrow();
  });

  it("limit = 0 被拒绝(positive)", () => {
    expect(() => engramAuditQueryTool.execute({ limit: 0 }, ctx)).toThrow();
  });

  it("returns items filtered by engramId", () => {
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "create", engramId: "E2" });
    audit.append({ actor: "user", action: "update", engramId: "E1" });

    const result = engramAuditQueryTool.execute(
      { engramId: "E1", limit: 100 },
      ctx,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items.every((e) => e.engramId === "E1")).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("returns items filtered by action", () => {
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "reinforce", engramId: "E1" });
    audit.append({ actor: "user", action: "create", engramId: "E2" });

    const result = engramAuditQueryTool.execute(
      { action: "reinforce", limit: 100 },
      ctx,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.action).toBe("reinforce");
  });

  it("limit 截断 + nextCursor 提供分页边界", () => {
    // 用确定性 ts 写 10 条,确保 cursor 分页可预测
    const lines = Array.from({ length: 10 }, (_, i) => ({
      ts: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      action: "create",
      engramId: `E${i}`,
    }));
    writeAuditLines(lines);

    const result = engramAuditQueryTool.execute({ limit: 5 }, ctx);
    expect(result.items).toHaveLength(5);
    // AuditLog.query 时间正序:第一页应是最新 5 条(E5..E9)
    expect(result.items.map((e) => e.engramId)).toEqual([
      "E5",
      "E6",
      "E7",
      "E8",
      "E9",
    ]);
    // nextCursor = oldest in page = E5 的 ts
    expect(result.nextCursor).toBe(
      "2024-01-06T00:00:00.000Z",
    );
  });

  it("cursor 翻页:第二页更早事件,无重复,无遗漏", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      ts: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      action: "create",
      engramId: `E${i}`,
    }));
    writeAuditLines(lines);

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let iterations = 0;
    while (iterations < 5) {
      const result = engramAuditQueryTool.execute(
        cursor ? { limit: 4, cursor } : { limit: 4 },
        ctx,
      );
      for (const item of result.items) {
        expect(seenIds.has(item.engramId!)).toBe(false);
        seenIds.add(item.engramId!);
      }
      cursor = result.nextCursor;
      if (cursor === null) break;
      iterations++;
    }
    expect(seenIds.size).toBe(10);
    expect(cursor).toBeNull();
  });

  it("filters by since/until ISO8601 range", () => {
    const old = "2024-01-01T00:00:00.000Z";
    const mid = "2024-06-01T00:00:00.000Z";
    const young = "2024-12-01T00:00:00.000Z";

    writeAuditLines([
      { ts: old, action: "create", engramId: "E_old" },
      { ts: mid, action: "create", engramId: "E_mid" },
      { ts: young, action: "create", engramId: "E_young" },
    ]);

    const result = engramAuditQueryTool.execute(
      {
        since: "2024-03-01T00:00:00.000Z",
        until: "2024-09-01T00:00:00.000Z",
        limit: 100,
      },
      ctx,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.engramId).toBe("E_mid");
  });

  it("cursor 与 until 互斥(cursor 优先)", () => {
    // cursor 编码了 until 边界,显式传 until 应被忽略
    writeAuditLines([
      { ts: "2024-01-01T00:00:00.000Z", action: "create", engramId: "E1" },
      { ts: "2024-02-01T00:00:00.000Z", action: "create", engramId: "E2" },
      { ts: "2024-03-01T00:00:00.000Z", action: "create", engramId: "E3" },
    ]);
    // cursor = E2 的 ts → 只返回 E1(strictly older)
    const result = engramAuditQueryTool.execute(
      {
        cursor: "2024-02-01T00:00:00.000Z",
        until: "2024-12-31T00:00:00.000Z", // 应被忽略
        limit: 100,
      },
      ctx,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.engramId).toBe("E1");
  });

  it("throws clear error when auditLog not injected", () => {
    const ctxNoAudit = { repository: stubRepo } as ToolContext;
    expect(() =>
      engramAuditQueryTool.execute({ limit: 10 }, ctxNoAudit),
    ).toThrow(/auditLog/);
  });

  it("description references CONCEPT_DICTIONARY concept and explains when to call", () => {
    expect(engramAuditQueryTool.description).toContain("WHEN TO CALL");
    expect(engramAuditQueryTool.description).toContain("audit");
    expect(engramAuditQueryTool.description).toContain("{{concept:");
  });

  it("returns empty items when engramId exists but has no audit events", () => {
    // AI-2 修复后:engrId 必须先通过 exists() 校验,再走 query 过滤。
    // 这里测的语义是"存在但无事件" → 空数组 + null cursor(不是 NOT_FOUND)。
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    const result = engramAuditQueryTool.execute(
      { engramId: "E_other_exists_but_empty", limit: 100 },
      ctx,
    );
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("AI-2: nonexistent engramId throws NOT_FOUND (no silent empty)", () => {
    // 旧实现:engrId 笔误 / 已 deleted → 静默返回空数组,agent 把"空"当作"无历史"。
    // AI-2 修复:对存在性明确发声,抛结构化 EngramToolError(code=NOT_FOUND)。
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    expect(() =>
      engramAuditQueryTool.execute(
        { engramId: "nonexistent-id", limit: 100 },
        ctx,
      ),
    ).toThrow(/NOT_FOUND|does not exist|nonexistent-id/);
  });

  it("AI-2: omitted engramId 不触发 exists 校验(跨 engram 查询)", () => {
    // 跨 engram 查询(action / since / until / 全量)不应受 exists 校验影响。
    // 这是最常见的"看最近 reinforce 历史"场景。
    audit.append({ actor: "user", action: "reinforce", engramId: "E1" });
    audit.append({ actor: "user", action: "reinforce", engramId: "E2" });
    const result = engramAuditQueryTool.execute(
      { action: "reinforce", limit: 100 },
      ctx,
    );
    expect(result.items).toHaveLength(2);
  });

  it("returns items in time-ascending order (AuditLog.query semantics)", () => {
    // AuditLog.query 内部从尾部往前读再 reverse,最终是时间正序
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "update", engramId: "E1" });
    audit.append({ actor: "user", action: "reinforce", engramId: "E1" });

    const result = engramAuditQueryTool.execute(
      { engramId: "E1", limit: 100 },
      ctx,
    );
    expect(result.items.map((e) => e.action)).toEqual([
      "create",
      "update",
      "reinforce",
    ]);
  });
});
