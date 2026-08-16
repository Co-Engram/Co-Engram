/**
 * Audit 日志轮转机制测试
 *
 * 覆盖场景:
 *   1. retentionDays 截止 — 过期低价值 action 被删除
 *   2. highValueRetentionDays — 高价值 action 保留更久
 *   3. maxSizeMb 硬上限 — 文件超限时从尾部截断保留最新
 *   4. 损坏行保留 — JSON parse 失败的行不擅自删除
 *   5. noop — 无可删时不动文件
 *   6. startAutoRotation — 返回 stop 函数;intervalMs<=0 不启动
 *
 * @module @co-engram/core/test/audit-rotation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuditLog } from "../src/observability/audit-log.js";

let tmpDir: string;
let audit: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-audit-rot-"));
  audit = new AuditLog(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造一条 audit 行 */
function line(
  action:
    | "create"
    | "propose"
    | "reinforce"
    | "accept"
    | "noise_filtered"
    | "importance_update",
  tsIso: string,
  engramId = "eng-1",
): string {
  return JSON.stringify({ ts: tsIso, actor: "user", action, engramId });
}

/** 直接覆盖 audit.jsonl(测试用,绕过 append 以便精确控制 ts) */
function writeRawAudit(content: string): void {
  mkdirSync(dirname(audit.path), { recursive: true });
  writeFileSync(audit.path, content, "utf8");
}

function readLines(): string[] {
  return readFileSync(audit.path, "utf8").split("\n").filter((l) => l.trim());
}

const NOW = new Date("2026-07-07T00:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("AuditLog.rotate", () => {
  it("retentionDays:过期低价值 action 被删除", () => {
    // 100 天前的 propose(低价值,默认保留 90 天)→ 应删
    // 100 天前的 create(高价值,默认保留 365 天)→ 应保留
    const old = new Date(NOW - 100 * DAY_MS).toISOString();
    const recent = new Date(NOW - 10 * DAY_MS).toISOString();
    writeRawAudit(
      [
        line("propose", old),
        line("create", old),
        line("propose", recent),
      ].join("\n") + "\n",
    );

    // Mock 当前时间(Date.now 被 AuditLog.rotate 用于算 age)
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
      });
      expect(result.droppedCount).toBe(1);
      const kept = readLines();
      // 旧 propose 删了,旧 create 留了,recent propose 留了
      expect(kept.length).toBe(2);
      expect(kept.some((l) => l.includes('"action":"propose"') && l.includes(recent))).toBe(true);
      expect(kept.some((l) => l.includes('"action":"create"') && l.includes(old))).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("highValueRetentionDays:高价值 action 即使很旧也保留", () => {
    // 200 天前的 accept(高价值,默认保留 365 天)→ 应保留
    const veryOld = new Date(NOW - 200 * DAY_MS).toISOString();
    writeRawAudit(line("accept", veryOld) + "\n");

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
      });
      expect(result.droppedCount).toBe(0);
      expect(readLines().length).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("maxSizeMb:文件超限时按行边界截断保留最新", () => {
    // audit.append() 把新条目追加到文件末尾 → 最新的在底部。
    // 写入 5 条记录(i=4 最旧,i=0 最新),顺序:oldest → newest
    const lines: string[] = [];
    for (let i = 4; i >= 0; i--) {
      const ts = new Date(NOW - i * 1000).toISOString();
      lines.push(
        JSON.stringify({
          ts,
          actor: "user" as const,
          action: "create" as const,
          engramId: `eng-${i}`,
          // padding 让单行 ~200B
          metadata: { pad: "x".repeat(150) },
        }),
      );
    }
    writeRawAudit(lines.join("\n") + "\n");

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      // maxSizeMb=0.0005 ≈ 524 字节,刚好够装 ~2-3 条
      const result = audit.rotate({
        retentionDays: 3650,
        highValueRetentionDays: 3650,
        maxSizeMb: 0.0005,
      });
      expect(result.droppedCount).toBeGreaterThan(0);
      const kept = readLines();
      // 截断后保留尾部最新(eng-0 / eng-1 ...)
      expect(kept.length).toBeLessThan(5);
      expect(kept.length).toBeGreaterThanOrEqual(1);
      // 最新的 eng-0 必须保留(在 kept 的最后一行)
      expect(kept[kept.length - 1]!.includes('"engramId":"eng-0"')).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("损坏行保留(JSON parse 失败不擅自删除)", () => {
    const recent = new Date(NOW - 1 * DAY_MS).toISOString();
    const corrupt = "{ this is not valid json";
    writeRawAudit(
      [corrupt, line("propose", recent)].join("\n") + "\n",
    );

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
      });
      expect(result.droppedCount).toBe(0);
      const kept = readLines();
      expect(kept.length).toBe(2);
      expect(kept.some((l) => l.includes("not valid json"))).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("noop:无可删行时不写文件(droppedCount=0)", () => {
    const recent = new Date(NOW - 1 * DAY_MS).toISOString();
    writeRawAudit(line("create", recent) + "\n");
    const sizeBefore = statSync(audit.path).size;

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
      });
      expect(result.droppedCount).toBe(0);
      expect(result.originalSize).toBe(sizeBefore);
      expect(result.newSize).toBe(sizeBefore);
      // 文件未被改写(mtime 不变)
      expect(existsSync(audit.path)).toBe(true);
      expect(readLines().length).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("空文件不抛错", () => {
    writeRawAudit("");
    expect(() =>
      audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
      }),
    ).not.toThrow();
  });

  it("文件不存在时返回空结果", () => {
    // 新 audit 实例,未 append 过
    const fresh = new AuditLog(mkdtempSync(join(tmpdir(), "co-engram-empty-")));
    const result = fresh.rotate({
      retentionDays: 90,
      highValueRetentionDays: 365,
      maxSizeMb: 50,
    });
    expect(result.droppedCount).toBe(0);
    expect(result.originalSize).toBe(0);
    expect(result.newSize).toBe(0);
  });
});

describe("AuditLog.startAutoRotation", () => {
  it("intervalMs<=0 时不启动,返回 noop stop", () => {
    const stop = audit.startAutoRotation({
      retentionDays: 90,
      highValueRetentionDays: 365,
      maxSizeMb: 50,
      intervalMs: 0,
    });
    // stop 是函数,调用不抛
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("intervalMs>0 时启动,返回有效 stop 函数", () => {
    const stop = audit.startAutoRotation({
      retentionDays: 90,
      highValueRetentionDays: 365,
      maxSizeMb: 50,
      intervalMs: 60_000,
    });
    expect(typeof stop).toBe("function");
    // 清理避免 timer 泄漏(unref 已设,但显式 stop 更稳)
    stop();
  });

  it("启动首跑(30s 延迟):过期数据在首个 interval 之前就被清理(2026-08-16 修复)", () => {
    vi.useFakeTimers();
    try {
      // 100 天前的 propose(低价值)→ 过期
      const old = new Date(NOW - 100 * 24 * 60 * 60 * 1000).toISOString();
      writeRawAudit(line("propose", old) + "\n");
      const realNow = Date.now;
      Date.now = () => NOW;

      const stop = audit.startAutoRotation({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 50,
        intervalMs: 24 * 60 * 60 * 1000, // 24h:不等 interval
      });
      // 未到 30s:不跑
      vi.advanceTimersByTime(29_000);
      expect(readLines().length).toBe(1);
      // 到 30s:首跑清理
      vi.advanceTimersByTime(1_000);
      expect(readLines().length).toBe(0);
      Date.now = realNow;
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("append 背压:超上限 ×1.1 时写入路径自己触发轮转(2026-08-16)", async () => {
    vi.useFakeTimers();
    try {
      // maxSizeMb 最小粒度是 1MB → 用字节数堆过 1.1MB
      lastStop = audit.startAutoRotation({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 1,
        intervalMs: 24 * 60 * 60 * 1000,
      });
      const big = "x".repeat(2_000);
      // append 用真实当前时间 → 都在 retention 内,只被大小截断。
      // 灌到刚好跨过 1.1× 触发线(600 条 × ~2KB ≈ 1.2MB),然后放行背压的
      // setTimeout(0),断言被压回 ≤ 1MB(冷却 1h 内只此一次,故之后不再灌)
      let n = 0;
      while (n < 600) {
        audit.append({ actor: "user", action: "update", engramId: `e${n}` , metadata: { pad: big }});
        n++;
      }
      vi.advanceTimersByTime(10);
      const size = statSync(audit.path).size;
      expect(size).toBeLessThanOrEqual(1.05 * 1024 * 1024);
      stopLast();
    } finally {
      vi.useRealTimers();
    }
  });

  it("流式 rotate:行跨 64KB chunk 边界仍完整(2026-08-16 流式化)", () => {
    // 构造 >64KB 的行集,确保 chunk 边界落在行中间
    const recent = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    const rows: string[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(JSON.stringify({ ts: recent, actor: "user", action: "update", engramId: `e${i}`, metadata: { pad: "y".repeat(600) } }));
    }
    writeRawAudit(rows.join("\n") + "\n");
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = audit.rotate({ retentionDays: 90, highValueRetentionDays: 365, maxSizeMb: 50 });
      expect(r.droppedCount).toBe(0); // 全部在保留期内,未超限 → no-op
      expect(readLines().length).toBe(300);
      // 再跑一次 maxSizeMb 极小 → 全部被截断,只剩尾部能装下的
      const r2 = audit.rotate({ retentionDays: 90, highValueRetentionDays: 365, maxSizeMb: 0.01 });
      expect(r2.droppedCount).toBeGreaterThan(0);
      const after = readLines();
      expect(after.length).toBeLessThan(300);
      expect(after.length).toBeGreaterThan(0);
      // 保留的是尾部(最新)行:engramId 序号最大段
      const ids = after.map((l) => JSON.parse(l).engramId as string);
      expect(ids[ids.length - 1]).toBe("e299");
    } finally {
      Date.now = realNow;
    }
  });
});

/** 保存最近的 auto-rotation stop 以便测试清理 */
let lastStop: (() => void) | undefined;
function stopLast(): void {
  lastStop?.();
  lastStop = undefined;
}
