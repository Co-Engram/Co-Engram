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

  it("maxSizeMb 分级截断:低价值洪流超限时优先丢低价值,高价值保留(2026-08-16)", () => {
    // 复现真实事故结构:头部过期 propose(时间维度删)+ 老create(高价值)+
    // 海量 noise_filtered(低价值)。旧无差别头部截断会把老 create 一起丢掉;
    // 分级后 noise_filtered 先丢,create 全保留。
    const expired = new Date(NOW - 100 * DAY_MS).toISOString();
    const oldHigh = new Date(NOW - 80 * DAY_MS).toISOString();
    const recent = new Date(NOW - 1 * DAY_MS).toISOString();
    const lines: string[] = [
      line("propose", expired), // 过期低价值 → 时间维度删除
    ];
    for (let i = 0; i < 3; i++) {
      lines.push(line("create", oldHigh, `precious-${i}`));
    }
    const noise = JSON.stringify({
      ts: recent,
      actor: "system" as const,
      action: "noise_filtered" as const,
      metadata: { pad: "n".repeat(150) },
    });
    for (let i = 0; i < 30; i++) lines.push(noise);
    writeRawAudit(lines.join("\n") + "\n");

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      // 0.003MB ≈ 3146B;总 ~6.4KB 超限 → 只丢 noise_filtered 就能压回限内
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 0.003,
      });
      expect(result.droppedCount).toBeGreaterThan(0);
      const kept = readLines();
      // 头部 3 条老 create(高价值)全部保留
      for (let i = 0; i < 3; i++) {
        expect(kept.some((l) => l.includes(`"engramId":"precious-${i}"`))).toBe(true);
      }
      // 过期 propose 被时间维度删除
      expect(kept.some((l) => l.includes('"action":"propose"'))).toBe(false);
      // 部分低价值噪声被丢,文件压回限内
      expect(kept.filter((l) => l.includes("noise_filtered")).length).toBeLessThan(30);
      expect(statSync(audit.path).size).toBeLessThanOrEqual(0.003 * 1024 * 1024);
    } finally {
      Date.now = realNow;
    }
  });

  it("maxSizeMb 分级截断:低价值丢光仍超限 → 从最老丢高价值兜底(保尾部最新)", () => {
    // 高价值自身总量超限:最老 noise(轮1先丢)→ 仍超 → 最老 create 兜底丢,
    // 尾部最新 create 保留 —— 退化到分级前的「保尾部」语义。
    const t1 = new Date(NOW - 3 * DAY_MS).toISOString();
    const t2 = new Date(NOW - 2 * DAY_MS).toISOString();
    const t3 = new Date(NOW - 1 * DAY_MS).toISOString();
    const big = (ts: string, action: "create" | "noise_filtered", id: string) =>
      JSON.stringify({
        ts,
        actor: "user" as const,
        action: action as never,
        engramId: id,
        metadata: { pad: "x".repeat(150) },
      });
    writeRawAudit(
      [big(t1, "noise_filtered", "old-noise"), big(t2, "create", "old-create"), big(t3, "create", "new-create")].join("\n") + "\n",
    );

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      // 每行 ~260B,3 行 ~790B;0.0003MB ≈ 314B 只装得下 1 行(离行边界留余量,
      // 避免浮点边界把唯一保留行也挤掉)
      const result = audit.rotate({
        retentionDays: 90,
        highValueRetentionDays: 365,
        maxSizeMb: 0.0003,
      });
      expect(result.droppedCount).toBe(2);
      const kept = readLines();
      expect(kept.length).toBe(1);
      // 轮1丢最老低价值,轮2丢最老高价值,保尾部最新
      expect(kept[0]!.includes('"engramId":"new-create"')).toBe(true);
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
