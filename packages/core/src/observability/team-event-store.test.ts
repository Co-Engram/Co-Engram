import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit-log.js";
import {
  TeamEventStore,
  SYNCED_TEAM_ACTIONS,
} from "./team-event-store.js";

function tmpRoot(label: string): string {
  return mkdirSync(join(tmpdir(), `team-event-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), {
    recursive: true,
  });
}

describe("TeamEventStore.record", () => {
  it("只落同步动作集内的事件(maintenance_run/retrieve_* 不落)", () => {
    const root = tmpRoot("actions");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
    });
    const log = new AuditLog(root);
    log.setTeamEventRecorder(store);
    log.append({ actor: "user", action: "create", engramId: "01A" });
    log.append({ actor: "system", action: "maintenance_run" });
    log.append({ actor: "user", action: "retrieve_effective", engramId: "01A" });

    const events = store.query();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("create");
    expect(events[0]!.engramId).toBe("01A");
    expect(typeof events[0]!.eventId).toBe("string");
    expect(events[0]!.origin).toBe("alice");
    expect(events[0]!.schemaVersion).toBe(1);
  });

  it("private engram 的事件不落盘(隐私防线)", () => {
    const root = tmpRoot("private");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: (id) => (id === "01PRIVATE" ? "private" : "public"),
    });
    store.record({
      ts: "2026-08-19T10:00:00.000Z",
      actor: "user",
      action: "create",
      engramId: "01PRIVATE",
      metadata: { title: "secret" },
    });
    store.record({
      ts: "2026-08-19T10:00:01.000Z",
      actor: "user",
      action: "create",
      engramId: "01PUBLIC",
    });
    expect(store.query()).toHaveLength(1);
    expect(store.query()[0]!.engramId).toBe("01PUBLIC");
  });

  it("无 visibilityLookup 时不落盘(宁缺勿漏:无法证明非 private)", () => {
    const root = tmpRoot("no-lookup");
    const store = new TeamEventStore(root, { origin: "alice" });
    store.record({
      ts: "2026-08-19T10:00:00.000Z",
      actor: "user",
      action: "create",
      engramId: "01A",
    });
    expect(store.query()).toHaveLength(0);
  });

  it("metadata 白名单投影:changes 只留 field 名 + contentTo 截断,全文不外带", () => {
    const root = tmpRoot("project");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
    });
    const longText = "x".repeat(300);
    store.record({
      ts: "2026-08-19T10:00:00.000Z",
      actor: "user",
      action: "update",
      engramId: "01A",
      metadata: {
        updatedBy: "alice",
        secretField: "should-not-appear",
        changes: {
          content: { from: "old", to: longText },
          importance: { from: 0.5, to: 0.8 },
        },
      },
    });
    const [event] = store.query();
    expect(event!.metadata).toBeDefined();
    expect(event!.metadata!["updatedBy"]).toBe("alice");
    expect(event!.metadata!["secretField"]).toBeUndefined();
    const changes = event!.metadata!["changes"] as Record<string, unknown>;
    // content 全文绝不外带;只留 field 名清单 + to 的截断
    expect(changes["fields"]).toEqual(["content", "importance"]);
    // 78 字 + 省略号 = 79,与 viewer feed excerptFor(slice(0,78)+'…')同口径
    expect((changes["contentTo"] as string).length).toBe(79);
    expect(changes["contentTo"]).toContain("…");
  });

  it("origin 含路径字符/中文时文件名被安全化(无 path traversal)", () => {
    const root = tmpRoot("sanitize");
    const store = new TeamEventStore(root, {
      origin: "../../etc/张三/passwd",
      visibilityLookup: () => "public",
    });
    store.record({
      ts: "2026-08-19T10:00:00.000Z",
      actor: "user",
      action: "create",
      engramId: "01A",
    });
    // 写进了 events/2026-08-19/ 下的一个 .jsonl,文件名无路径成分,未逃逸 dataRoot
    const dayDir = join(root, "events", "2026-08-19");
    expect(existsSync(dayDir)).toBe(true);
    const files = readdirSync(dayDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("..");
    // 条目内 origin 保留原文(展示用),路径安全只作用于文件名
    expect(store.query()[0]!.origin).toBe("../../etc/张三/passwd");
  });

  it("分片路径:events/<YYYY-MM-DD>/<origin>.jsonl", () => {
    const root = tmpRoot("layout");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
    });
    store.record({
      ts: "2026-08-19T23:59:59.000Z",
      actor: "user",
      action: "create",
      engramId: "01A",
    });
    const raw = readFileSync(
      join(root, "events", "2026-08-19", "alice.jsonl"),
      "utf8",
    );
    expect(JSON.parse(raw.trim()).engramId).toBe("01A");
  });
});

describe("TeamEventStore.query", () => {
  it("跨日期 × 跨 origin 合并,ts 降序;坏行/未知版本跳过", () => {
    const root = tmpRoot("query");
    const alice = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
    });
    alice.record({
      ts: "2026-08-18T10:00:00.000Z",
      actor: "user",
      action: "create",
      engramId: "01OLD",
    });
    // 模拟协作者 bob 的分片(直接写文件)+ 一行坏行 + 未来版本行
    const bobDir = join(root, "events", "2026-08-19");
    mkdirSync(bobDir, { recursive: true });
    writeFileSync(
      join(bobDir, "bob.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          eventId: "e2",
          origin: "bob",
          ts: "2026-08-19T09:00:00.000Z",
          actor: "user",
          action: "reinforce",
          engramId: "01NEW",
        }),
        "<<<this is not json>>>",
        JSON.stringify({
          schemaVersion: 99,
          eventId: "e3",
          origin: "bob",
          ts: "2026-08-19T09:00:01.000Z",
          actor: "user",
          action: "create",
          engramId: "01FUTURE",
        }),
        "",
      ].join("\n") + "\n",
      "utf8",
    );
    const events = alice.query();
    expect(events).toHaveLength(2);
    expect(events[0]!.ts).toBe("2026-08-19T09:00:00.000Z");
    expect(events[0]!.origin).toBe("bob");
    expect(events[1]!.engramId).toBe("01OLD");

    // action 过滤
    expect(alice.query({ action: "reinforce" })).toHaveLength(1);
    // since/until 过滤
    expect(alice.query({ since: "2026-08-19T00:00:00.000Z" })).toHaveLength(1);
    expect(alice.query({ until: "2026-08-19T00:00:00.000Z" })).toHaveLength(1);
    // engramId 过滤
    expect(alice.query({ engramId: "01OLD" })).toHaveLength(1);
  });

  it("events 目录不存在时返回空(老仓库/未升级对端)", () => {
    const root = tmpRoot("empty");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
    });
    expect(store.query()).toEqual([]);
  });
});

describe("TeamEventStore.cleanupExpired", () => {
  it("只删早于 retentionDays 的过去日期目录;未来/未过期目录不动", () => {
    const root = tmpRoot("cleanup");
    const store = new TeamEventStore(root, {
      origin: "alice",
      visibilityLookup: () => "public",
      retentionDays: 14,
    });
    const mk = (day: string) => {
      const dir = join(root, "events", day);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "alice.jsonl"), "{}\n", "utf8");
    };
    mk("2026-07-01"); // 19 天前 → 删
    mk("2026-08-10"); // 9 天前 → 留
    mk("2026-09-01"); // 未来(时钟漂移)→ 留
    const removed = store.cleanupExpired(new Date("2026-08-19T12:00:00.000Z"));
    expect(removed).toBe(1);
    expect(existsSync(join(root, "events", "2026-07-01"))).toBe(false);
    expect(existsSync(join(root, "events", "2026-08-10"))).toBe(true);
    expect(existsSync(join(root, "events", "2026-09-01"))).toBe(true);
  });
});

describe("SYNCED_TEAM_ACTIONS", () => {
  it("动作集与设计文档一致(feed 高价值子集,不含本机行为类)", () => {
    expect([...SYNCED_TEAM_ACTIONS].sort()).toEqual(
      [
        "accept",
        "contradicted",
        "create",
        "reinforce",
        "skill_create",
        "skill_update",
        "update",
      ].sort(),
    );
  });
});
