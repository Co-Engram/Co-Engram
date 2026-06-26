import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/observability/audit-log.js";
import {
  EffectivenessTracker,
  computeWindowMs,
  DEFAULT_EFFECTIVENESS_WINDOWS,
} from "../src/observability/effectiveness-tracker.js";

let tmpDir: string;
let audit: AuditLog;
let tracker: EffectivenessTracker;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-effect-"));
  audit = new AuditLog(tmpDir);
  tracker = new EffectivenessTracker(tmpDir, audit);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeWindowMs", () => {
  it("单 kind 返回对应窗口", () => {
    expect(computeWindowMs(["observation"])).toBe(
      DEFAULT_EFFECTIVENESS_WINDOWS.observation,
    );
    expect(computeWindowMs(["fact"])).toBe(DEFAULT_EFFECTIVENESS_WINDOWS.fact);
    expect(computeWindowMs(["hypothesis"])).toBe(
      DEFAULT_EFFECTIVENESS_WINDOWS.hypothesis,
    );
  });

  it("多 kind 取最长", () => {
    const w = computeWindowMs(["observation", "hypothesis"]);
    expect(w).toBe(DEFAULT_EFFECTIVENESS_WINDOWS.hypothesis); // 7d > 6h
  });

  it("空 kinds 默认 fact 窗口", () => {
    expect(computeWindowMs([])).toBe(DEFAULT_EFFECTIVENESS_WINDOWS.fact);
  });

  it("可 override", () => {
    const custom = { fact: 1000 };
    expect(computeWindowMs(["fact"], custom)).toBe(1000);
    // override 未覆盖的 kind 仍用 default
    expect(computeWindowMs(["pattern"], custom)).toBe(
      DEFAULT_EFFECTIVENESS_WINDOWS.pattern,
    );
  });
});

describe("EffectivenessTracker.openWindow", () => {
  it("创建一个 open 窗口", () => {
    const win = tracker.openWindow({
      engramId: "eng-1",
      query: "how to X",
      score: 0.9,
      kinds: ["fact"],
    });
    expect(win.status).toBe("open");
    expect(win.engramId).toBe("eng-1");
    expect(win.query).toBe("how to X");
    expect(win.score).toBe(0.9);

    const open = tracker.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(win.id);
  });

  it("deadline 按 kind 计算（fact = 24h）", () => {
    const baseTime = "2026-06-21T10:00:00Z";
    const win = tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.5,
      kinds: ["fact"],
      nowIso: baseTime,
    });
    const expected = "2026-06-22T10:00:00.000Z"; // +24h
    expect(win.deadline).toBe(expected);
  });

  it("同 engram 再次命中 → 替换 open 窗口（不是叠加）", () => {
    const w1 = tracker.openWindow({
      engramId: "eng-1",
      query: "q1",
      score: 0.5,
      kinds: ["fact"],
    });
    const w2 = tracker.openWindow({
      engramId: "eng-1",
      query: "q2",
      score: 0.8,
      kinds: ["fact"],
    });
    expect(w1.id).not.toBe(w2.id);
    const open = tracker.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(w2.id);
  });

  it("不写 retrieve_hit audit(window 文件已记录 hits)", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.7,
      kinds: ["fact"],
    });
    const hits = audit.query({ action: "retrieve_hit" });
    expect(hits).toHaveLength(0);
  });
});

describe("EffectivenessTracker.closeAsEffective", () => {
  it("找到 open 窗口并关闭", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    const closed = tracker.closeAsEffective("eng-1");
    expect(closed).toBe(true);
    expect(tracker.listOpen()).toHaveLength(0);
  });

  it("没有 open 窗口时返回 false", () => {
    expect(tracker.closeAsEffective("not-exist")).toBe(false);
  });

  it("只关闭最近的 open 窗口（不关已关闭的）", () => {
    // 第一个窗口被关闭（模拟 close by timeout）
    tracker.openWindow({
      engramId: "eng-1",
      query: "q1",
      score: 0.9,
      kinds: ["fact"],
      nowIso: "2026-06-01T00:00:00Z",
    });
    // 第二个窗口才是 open（now 较新）
    tracker.openWindow({
      engramId: "eng-1",
      query: "q2",
      score: 0.5,
      kinds: ["fact"],
      nowIso: "2026-06-21T00:00:00Z",
    });
    const closed = tracker.closeAsEffective("eng-1");
    expect(closed).toBe(true);

    // 不写 retrieve_effective audit(window 文件记录 closed_by_reinforce)
    const all = audit.query({});
    const effectiveEvents = all.filter(
      (e) => e.action === "retrieve_effective",
    );
    expect(effectiveEvents).toHaveLength(0);
  });

  it("不写 retrieve_effective audit(window 文件已记录 closed_by_reinforce)", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.closeAsEffective("eng-1");
    const events = audit.query({ action: "retrieve_effective" });
    expect(events).toHaveLength(0);
  });
});

describe("EffectivenessTracker.closeAsFailure", () => {
  it("关闭窗口但不写 retrieve_effective audit", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    const closed = tracker.closeAsFailure("eng-1");
    expect(closed).toBe(true);
    expect(tracker.listOpen()).toHaveLength(0);
    expect(audit.query({ action: "retrieve_effective" })).toHaveLength(0);
  });
});

describe("EffectivenessTracker.sweepExpired", () => {
  it("超过 deadline 的 open 窗口被关闭", () => {
    // 用很早的 nowIso 开窗,fact 24h,然后扫"现在"
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
      nowIso: "2026-06-01T00:00:00Z",
    });
    // 当前是 2026-06-21,远超 24h
    const result = tracker.sweepExpired();
    expect(result.closed).toBe(1);
    expect(result.engramIds).toContain("eng-1");
    expect(tracker.listOpen()).toHaveLength(0);
  });

  it("未超时的窗口保留", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["hypothesis"], // 7 天
      nowIso: new Date().toISOString(),
    });
    const result = tracker.sweepExpired();
    expect(result.closed).toBe(0);
    expect(tracker.listOpen()).toHaveLength(1);
  });

  it("不写 retrieve_inconclusive audit(window 文件记录 closed_by_timeout)", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
      nowIso: "2026-06-01T00:00:00Z",
    });
    tracker.sweepExpired();
    const events = audit.query({ action: "retrieve_inconclusive" });
    expect(events).toHaveLength(0);
  });

  it("空表也安全", () => {
    const result = tracker.sweepExpired();
    expect(result.closed).toBe(0);
    expect(result.engramIds).toEqual([]);
  });

  it("去重 engramIds（同一 engram 多窗口）", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q1",
      score: 0.9,
      kinds: ["fact"],
      nowIso: "2026-06-01T00:00:00Z",
    });
    // close 第一个,然后开第二个（也过期）
    tracker.closeAsEffective("eng-1");
    tracker.openWindow({
      engramId: "eng-1",
      query: "q2",
      score: 0.5,
      kinds: ["fact"],
      nowIso: "2026-06-02T00:00:00Z",
    });
    const result = tracker.sweepExpired();
    expect(result.closed).toBe(1); // 只剩一个 open
    expect(result.engramIds).toEqual(["eng-1"]);
  });
});

describe("EffectivenessTracker.effectiveness", () => {
  // 注意 openWindow 是替换语义:同一 engram 只允许一个 open 窗口,
  // 重复命中时前一个会被自动 close 为 closed_by_timeout。

  it("hits < minHits → effectiveRate = null", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.closeAsEffective("eng-1");

    const report = tracker.effectiveness("eng-1");
    expect(report.hits).toBe(1);
    expect(report.effective).toBe(1);
    expect(report.effectiveRate).toBeNull();
  });

  it("达到 minHits 后返回正确率(3 hits / 1 effective / 2 inconclusive)", () => {
    // 开 3 次窗:前 2 次被替换语义关为 closed_by_timeout,第 3 个 open
    tracker.openWindow({
      engramId: "eng-1",
      query: "q1",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.openWindow({
      engramId: "eng-1",
      query: "q2",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.openWindow({
      engramId: "eng-1",
      query: "q3",
      score: 0.9,
      kinds: ["fact"],
    });
    // 第 3 个(当前 open)关为 effective
    tracker.closeAsEffective("eng-1");

    const report = tracker.effectiveness("eng-1");
    expect(report.hits).toBe(3);
    expect(report.effective).toBe(1);
    expect(report.inconclusive).toBe(2);
    // 1 / (1+2+0) = 0.333
    expect(report.effectiveRate).toBeCloseTo(1 / 3, 5);
  });

  it("contradicted 进入分母但不进分子(从 audit 派生)", () => {
    // 开 1 次窗(hits=1,open 状态,不进 effective/inconclusive 分母)
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    audit.append({ actor: "user", action: "contradicted", engramId: "eng-1" });

    const report = tracker.effectiveness("eng-1", { minHits: 1 });
    expect(report.contradicted).toBe(1);
    expect(report.effective).toBe(0);
    expect(report.effectiveRate).toBe(0); // 0 / (0+0+1) = 0
  });

  it("只查指定 engramId 的窗口", () => {
    tracker.openWindow({
      engramId: "eng-x",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.openWindow({
      engramId: "eng-y",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });

    const reportX = tracker.effectiveness("eng-x");
    const reportY = tracker.effectiveness("eng-y");
    expect(reportX.hits).toBe(1);
    expect(reportY.hits).toBe(1);
  });

  it("分母为 0(仅 1 个 open 窗口,无 closure)→ effectiveRate null", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });

    const report = tracker.effectiveness("eng-1");
    expect(report.effective).toBe(0);
    expect(report.inconclusive).toBe(0);
    expect(report.contradicted).toBe(0);
    expect(report.effectiveRate).toBeNull();
  });

  it("可自定义 minHits", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.closeAsEffective("eng-1");

    // 1 hit ≥ minHits=1,1 effective / (1+0+0) = 1
    const report = tracker.effectiveness("eng-1", { minHits: 1 });
    expect(report.effectiveRate).toBe(1);
  });

  it("closed_by_failure 不计入 effective 也不计入 inconclusive", () => {
    // 开窗后立刻 failure 关闭:状态 = closed_by_failure,不进 effectiveness 分子分母
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    tracker.closeAsFailure("eng-1");

    const report = tracker.effectiveness("eng-1", { minHits: 1 });
    expect(report.hits).toBe(1);
    expect(report.effective).toBe(0);
    expect(report.inconclusive).toBe(0);
    expect(report.effectiveRate).toBeNull(); // 分母为 0
  });
});

describe("EffectivenessTracker.clear", () => {
  it("清空所有窗口", () => {
    tracker.openWindow({
      engramId: "eng-1",
      query: "q",
      score: 0.9,
      kinds: ["fact"],
    });
    expect(tracker.listOpen()).toHaveLength(1);
    tracker.clear();
    expect(tracker.listOpen()).toHaveLength(0);
  });
});
