import { describe, it, expect } from "vitest";

import {
  extractSignals,
  dedupeSignals,
  repeatedGetRule,
  getFollowedByActionRule,
  getFollowedByNoSearchRule,
  getThenImmediateSearchRule,
  userCorrectionRule,
  contradictsCreatedRule,
  DEFAULT_RULES,
  DEFAULT_WINDOW_SIZE,
  type SignalRule,
} from "../src/signals/index.js";
import type { ToolCallEvent } from "../src/signals/index.js";

function makeEvent(
  overrides: Partial<ToolCallEvent> & { toolName: string },
): ToolCallEvent {
  return {
    input: {},
    sessionId: "s1",
    at: Date.now(),
    ...overrides,
  };
}

// ============================================================
// DEFAULT_WINDOW_SIZE 常量
// ============================================================

describe("常量", () => {
  it("DEFAULT_WINDOW_SIZE = 10", () => {
    expect(DEFAULT_WINDOW_SIZE).toBe(10);
  });

  it("DEFAULT_RULES 包含 6 条规则", () => {
    expect(DEFAULT_RULES.length).toBe(6);
  });

  it("DEFAULT_RULES 各规则名唯一", () => {
    const names = DEFAULT_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ============================================================
// 规则 1: repeatedGetRule
// ============================================================

describe("repeatedGetRule", () => {
  it("同 engram 被 get ≥ 2 次 → +0.6", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 2 }),
    ];
    const signals = repeatedGetRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.engramId).toBe("a");
    expect(signals[0]!.weight).toBe(0.6);
    expect(signals[0]!.source).toBe("repeated_get");
    expect(signals[0]!.evidence.count).toBe(2);
  });

  it("只 get 1 次 → 不产生信号", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"] }),
    ];
    expect(repeatedGetRule.match(events)).toHaveLength(0);
  });

  it("超出 windowSize 的两次 get 不算", () => {
    const events: ToolCallEvent[] = [];
    events.push(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
    );
    // 插入 10 个无关事件把窗口拉远
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ toolName: "other_tool", at: 100 + i }));
    }
    events.push(
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 200 }),
    );
    expect(repeatedGetRule.match(events)).toHaveLength(0);
  });

  it("不同 engram 各自计算", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["b"], at: 2 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 3 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["b"], at: 4 }),
    ];
    const signals = repeatedGetRule.match(events);
    expect(signals).toHaveLength(2);
    const ids = signals.map((s) => s.engramId).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

// ============================================================
// 规则 2: getFollowedByActionRule
// ============================================================

describe("getFollowedByActionRule", () => {
  it("get 后出现 file_edit → +0.8", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "file_edit", at: 2 }),
    ];
    const signals = getFollowedByActionRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.weight).toBe(0.8);
    expect(signals[0]!.evidence.actionFound).toEqual(["file_edit"]);
  });

  it("get 后出现 bash → +0.8", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "bash", at: 2 }),
    ];
    expect(getFollowedByActionRule.match(events)).toHaveLength(1);
  });

  it("get 后只有 search（无 action）→ 不产生", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_search", at: 2 }),
    ];
    expect(getFollowedByActionRule.match(events)).toHaveLength(0);
  });

  it("action 超出 windowSize → 不产生", () => {
    const events: ToolCallEvent[] = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
    ];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ toolName: "other_tool", at: 100 + i }));
    }
    events.push(makeEvent({ toolName: "file_edit", at: 999 }));
    expect(getFollowedByActionRule.match(events)).toHaveLength(0);
  });
});

// ============================================================
// 规则 3: getFollowedByNoSearchRule
// ============================================================

describe("getFollowedByNoSearchRule", () => {
  it("get 后 N 个事件无 search → +0.4", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "file_edit", at: 2 }),
      makeEvent({ toolName: "bash", at: 3 }),
    ];
    const signals = getFollowedByNoSearchRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.weight).toBe(0.4);
  });

  it("get 后立即 search → 不产生（被 immediate_search 规则捕获）", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_search", at: 2 }),
    ];
    expect(getFollowedByNoSearchRule.match(events)).toHaveLength(0);
  });

  it("前一个是 search → 跳过（避免和 immediate_search 重复）", () => {
    const events = [
      makeEvent({ toolName: "engram_search", at: 0 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "file_edit", at: 2 }),
    ];
    expect(getFollowedByNoSearchRule.match(events)).toHaveLength(0);
  });
});

// ============================================================
// 规则 4: getThenImmediateSearchRule
// ============================================================

describe("getThenImmediateSearchRule", () => {
  it("get 后 < 3 事件立即 search → -0.7", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_search", at: 2 }),
    ];
    const signals = getThenImmediateSearchRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.weight).toBe(-0.7);
  });

  it("get 后 4 个事件才 search → 不产生", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "other", at: 2 }),
      makeEvent({ toolName: "other", at: 3 }),
      makeEvent({ toolName: "other", at: 4 }),
      makeEvent({ toolName: "engram_search", at: 5 }), // 第 4 个事件后
    ];
    expect(getThenImmediateSearchRule.match(events)).toHaveLength(0);
  });

  it("get 后无 search → 不产生", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"] }),
    ];
    expect(getThenImmediateSearchRule.match(events)).toHaveLength(0);
  });
});

// ============================================================
// 规则 5: userCorrectionRule
// ============================================================

describe("userCorrectionRule", () => {
  it('用户消息含 "不对" → -0.4', () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({
        toolName: "reply",
        input: { message: "不对，应该是 X" },
        at: 2,
      }),
    ];
    const signals = userCorrectionRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.weight).toBe(-0.4);
    expect(signals[0]!.engramId).toBe("a");
    expect(signals[0]!.evidence.correctionWord).toBe("不对");
  });

  it('"actually" 也能识别', () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({
        toolName: "reply",
        input: { text: "Actually, this is wrong" },
        at: 2,
      }),
    ];
    expect(userCorrectionRule.match(events)).toHaveLength(1);
  });

  it("前面 5 个事件内没有 engram 操作 → 不产生", () => {
    const events = [
      makeEvent({ toolName: "other", at: 0 }),
      makeEvent({ toolName: "other", at: 1 }),
      makeEvent({
        toolName: "reply",
        input: { message: "不对" },
        at: 2,
      }),
    ];
    expect(userCorrectionRule.match(events)).toHaveLength(0);
  });

  it("无纠正词 → 不产生", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "reply", input: { message: "thanks" }, at: 2 }),
    ];
    expect(userCorrectionRule.match(events)).toHaveLength(0);
  });
});

// ============================================================
// 规则 6: contradictsCreatedRule
// ============================================================

describe("contradictsCreatedRule", () => {
  it("synapse_create kind=contradicts → -0.8", () => {
    const events = [
      makeEvent({
        toolName: "synapse_create",
        input: { from: "new", to: "old", kind: "contradicts" },
        at: 1,
      }),
    ];
    const signals = contradictsCreatedRule.match(events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.weight).toBe(-0.8);
    expect(signals[0]!.engramId).toBe("old");
  });

  it("synapse_create kind=extends → 不产生", () => {
    const events = [
      makeEvent({
        toolName: "synapse_create",
        input: { from: "a", to: "b", kind: "extends" },
      }),
    ];
    expect(contradictsCreatedRule.match(events)).toHaveLength(0);
  });

  it("synapse_create 缺少 to 字段 → 不产生", () => {
    const events = [
      makeEvent({
        toolName: "synapse_create",
        input: { from: "a", kind: "contradicts" },
      }),
    ];
    expect(contradictsCreatedRule.match(events)).toHaveLength(0);
  });
});

// ============================================================
// extractSignals 组合
// ============================================================

describe("extractSignals 组合", () => {
  it("多规则同时触发 → 各自产生信号", () => {
    const events = [
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 1 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 2 }), // repeated_get
      makeEvent({ toolName: "file_edit", at: 3 }), // get_then_action
    ];
    const signals = extractSignals(events);
    // 期望:repeated_get (+0.6) 和 get_then_action (+0.8)
    const sources = signals.map((s) => s.source).sort();
    expect(sources).toContain("repeated_get");
    expect(sources).toContain("get_then_action");
  });

  it("空事件流 → 空", () => {
    expect(extractSignals([])).toEqual([]);
  });

  it("同 (engramId, source) 去重：取绝对值最大", () => {
    const signals = [
      {
        engramId: "a",
        weight: 0.3,
        source: "r1",
        evidence: {},
        sessionId: "s",
        at: 1,
      },
      {
        engramId: "a",
        weight: 0.8,
        source: "r1",
        evidence: {},
        sessionId: "s",
        at: 2,
      },
      {
        engramId: "a",
        weight: -0.5,
        source: "r1",
        evidence: {},
        sessionId: "s",
        at: 3,
      },
    ];
    const deduped = dedupeSignals(signals);
    expect(deduped).toHaveLength(1);
    // |0.8| > |−0.5| > |0.3|,取绝对值最大者
    expect(deduped[0]!.weight).toBe(0.8);
  });

  it("不同 source 各自保留", () => {
    const signals = [
      {
        engramId: "a",
        weight: 0.5,
        source: "r1",
        evidence: {},
        sessionId: "s",
        at: 1,
      },
      {
        engramId: "a",
        weight: -0.5,
        source: "r2",
        evidence: {},
        sessionId: "s",
        at: 2,
      },
    ];
    const deduped = dedupeSignals(signals);
    expect(deduped).toHaveLength(2);
  });

  it("自定义规则传入：覆盖默认", () => {
    const customRule: SignalRule = {
      name: "custom",
      weight: 0.99,
      match(events) {
        return events
          .filter((e) => e.toolName === "marker")
          .map((e) => ({
            engramId: "custom-id",
            weight: 0.99,
            source: "custom",
            evidence: { at: e.at },
            sessionId: e.sessionId,
            at: e.at,
          }));
      },
    };
    const events = [makeEvent({ toolName: "marker", at: 1 })];
    const signals = extractSignals(events, [customRule]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe("custom");
    expect(signals[0]!.weight).toBe(0.99);
  });

  it("混合场景：完整对话流", () => {
    // 模拟一个真实的会话流
    const events = [
      makeEvent({ toolName: "engram_search", input: { query: "x" }, at: 1 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 2 }),
      makeEvent({ toolName: "engram_get", retrievedEngramIds: ["a"], at: 3 }), // repeated
      makeEvent({ toolName: "file_edit", at: 4 }), // action
      makeEvent({
        toolName: "synapse_create",
        input: { from: "b", to: "c", kind: "contradicts" },
        at: 5,
      }), // contradicts c
    ];
    const signals = extractSignals(events);
    const byEngram = new Map<string, number[]>();
    for (const s of signals) {
      const arr = byEngram.get(s.engramId) ?? [];
      arr.push(s.weight);
      byEngram.set(s.engramId, arr);
    }
    // engram a 收到正信号(repeated + action + no_search)
    expect(byEngram.has("a")).toBe(true);
    const aSum = byEngram.get("a")!.reduce((x, y) => x + y, 0);
    expect(aSum).toBeGreaterThan(0);
    // engram c 收到负信号(contradicts)
    expect(byEngram.has("c")).toBe(true);
    expect(byEngram.get("c")!.some((w) => w < 0)).toBe(true);
  });
});
