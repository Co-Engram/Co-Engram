import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/observability/audit-log.js";

let tmpDir: string;
let audit: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-audit-"));
  audit = new AuditLog(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AuditLog", () => {
  it("append 写入 .co-engram/audit.jsonl", () => {
    audit.append({
      actor: "user",
      action: "create",
      engramId: "eng-1",
      metadata: { title: "hello" },
    });
    expect(existsSync(audit.path)).toBe(true);
    const raw = readFileSync(audit.path, "utf8").trim();
    expect(raw).toContain('"action":"create"');
    expect(raw).toContain('"engramId":"eng-1"');
    expect(raw).toContain('"actor":"user"');
    // ts 字段是 ISO 时间戳
    expect(raw).toMatch(/"ts":"\d{4}-\d{2}-\d{2}T/);
  });

  it("append 失败静默（不抛错）", () => {
    const bad = new AuditLog("/nonexistent/path/that/does/not/exist");
    expect(() => {
      bad.append({ actor: "user", action: "create" });
    }).not.toThrow();
  });

  it("query 按时间正序返回", async () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    await new Promise((r) => setTimeout(r, 10));
    audit.append({ actor: "user", action: "reinforce", engramId: "a" });
    await new Promise((r) => setTimeout(r, 10));
    audit.append({ actor: "user", action: "forget", engramId: "a" });

    const entries = audit.query({});
    expect(entries).toHaveLength(3);
    expect(entries[0]!.action).toBe("create");
    expect(entries[1]!.action).toBe("reinforce");
    expect(entries[2]!.action).toBe("forget");
  });

  it("query 按 action 过滤", () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    audit.append({ actor: "user", action: "reinforce", engramId: "b" });
    audit.append({ actor: "user", action: "reinforce", engramId: "c" });

    const reinforces = audit.query({ action: "reinforce" });
    expect(reinforces).toHaveLength(2);
    expect(reinforces.every((e) => e.action === "reinforce")).toBe(true);
  });

  it("query 按 action 数组过滤", () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    audit.append({ actor: "user", action: "reinforce", engramId: "b" });
    audit.append({ actor: "user", action: "forget", engramId: "c" });

    const both = audit.query({ action: ["create", "forget"] });
    expect(both).toHaveLength(2);
  });

  it("query 按 engramId 过滤", () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    audit.append({ actor: "user", action: "create", engramId: "b" });
    audit.append({ actor: "user", action: "reinforce", engramId: "a" });

    const entries = audit.query({ engramId: "a" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.engramId === "a")).toBe(true);
  });

  it("query 按 since/until 时间窗过滤", async () => {
    const t0 = new Date().toISOString();
    audit.append({ actor: "user", action: "create", engramId: "a" });
    await new Promise((r) => setTimeout(r, 20));
    const t1 = new Date().toISOString();
    audit.append({ actor: "user", action: "reinforce", engramId: "a" });
    await new Promise((r) => setTimeout(r, 20));
    const t2 = new Date().toISOString();

    expect(audit.query({ since: t1 }).length).toBe(1);
    expect(audit.query({ until: t1 }).length).toBe(1);
    expect(audit.query({ since: t0, until: t2 }).length).toBe(2);
  });

  it("query 空文件返回空数组", () => {
    expect(audit.query({})).toEqual([]);
  });

  it("query 跳过损坏的 JSON 行", () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    // 手工写入损坏行
    const { appendFileSync } = require("node:fs");
    appendFileSync(audit.path, "not-json\n");
    audit.append({ actor: "user", action: "create", engramId: "b" });

    const entries = audit.query({});
    expect(entries).toHaveLength(2); // 跳过损坏行
  });

  it("query 默认 limit 1000", () => {
    for (let i = 0; i < 5; i++) {
      audit.append({ actor: "user", action: "create", engramId: `e-${i}` });
    }
    expect(audit.query({ limit: 2 }).length).toBe(2);
  });
});

describe("AuditLog.clear", () => {
  it("清空文件", () => {
    audit.append({ actor: "user", action: "create", engramId: "a" });
    expect(audit.query({}).length).toBe(1);
    audit.clear();
    expect(audit.query({}).length).toBe(0);
  });
});
