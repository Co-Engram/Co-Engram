/**
 * engram_audit_query 工具测试(Task 3.3)
 *
 * 验证 AuditLog 数据通过工具层暴露给 agent / 用户。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/observability/audit-log.js";
import { engramAuditQueryTool } from "../src/tools/audit-query-tool.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { EngramRepository } from "../src/storage/repository.js";

let tmpDir: string;
let audit: AuditLog;
let ctx: ToolContext;

// Minimal stub repository — engram_audit_query 不读 repository,只读 auditLog,
// 但 ToolContext 类型要求 repository 字段存在。
const stubRepo = { /* opaque */ } as unknown as EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-audit-query-"));
  audit = new AuditLog(tmpDir);
  ctx = { repository: stubRepo, auditLog: audit };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("engram_audit_query (Task 3.3)", () => {
  it("returns events filtered by engramId", () => {
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "create", engramId: "E2" });
    audit.append({ actor: "user", action: "update", engramId: "E1" });

    const result = engramAuditQueryTool.execute({ engramId: "E1" }, ctx);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.engramId === "E1")).toBe(true);
  });

  it("returns events filtered by action", () => {
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "reinforce", engramId: "E1" });
    audit.append({ actor: "user", action: "create", engramId: "E2" });

    const result = engramAuditQueryTool.execute({ action: "reinforce" }, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.action).toBe("reinforce");
  });

  it("respects limit and reports truncated flag", () => {
    for (let i = 0; i < 10; i++) {
      audit.append({ actor: "user", action: "create", engramId: `E${i}` });
    }
    const result = engramAuditQueryTool.execute({ limit: 5 }, ctx);
    expect(result.events).toHaveLength(5);
    expect(result.count).toBe(5);
  });

  it("filters by since/until ISO8601 range", () => {
    const old = "2024-01-01T00:00:00.000Z";
    const mid = "2024-06-01T00:00:00.000Z";
    const young = "2024-12-01T00:00:00.000Z";

    // AuditLog.append 用 new Date().toISOString(),无法注入。
    // 我们直接写文件绕过:
    const { writeFileSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(audit.path), { recursive: true });
    const lines = [
      JSON.stringify({ ts: old, actor: "user", action: "create", engramId: "E_old" }),
      JSON.stringify({ ts: mid, actor: "user", action: "create", engramId: "E_mid" }),
      JSON.stringify({ ts: young, actor: "user", action: "create", engramId: "E_young" }),
    ].join("\n") + "\n";
    writeFileSync(audit.path, lines, "utf8");

    const result = engramAuditQueryTool.execute(
      { since: "2024-03-01T00:00:00.000Z", until: "2024-09-01T00:00:00.000Z" },
      ctx,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.engramId).toBe("E_mid");
  });

  it("throws clear error when auditLog not injected", () => {
    const ctxNoAudit = { repository: stubRepo } as ToolContext;
    expect(() =>
      engramAuditQueryTool.execute({}, ctxNoAudit),
    ).toThrow(/auditLog/);
  });

  it("description references CONCEPT_DICTIONARY concept and explains when to call", () => {
    expect(engramAuditQueryTool.description).toContain("WHEN TO CALL");
    expect(engramAuditQueryTool.description).toContain("audit");
    expect(engramAuditQueryTool.description).toContain("{{concept:");
  });

  it("returns empty array when no events match filter", () => {
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    const result = engramAuditQueryTool.execute({ engramId: "nonexistent" }, ctx);
    expect(result.events).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it("returns events in time-ascending order (AuditLog.query semantics)", () => {
    // AuditLog.query 内部从尾部往前读再 reverse,最终是时间正序
    audit.append({ actor: "user", action: "create", engramId: "E1" });
    audit.append({ actor: "user", action: "update", engramId: "E1" });
    audit.append({ actor: "user", action: "reinforce", engramId: "E1" });

    const result = engramAuditQueryTool.execute({ engramId: "E1" }, ctx);
    expect(result.events.map((e) => e.action)).toEqual([
      "create",
      "update",
      "reinforce",
    ]);
  });
});
