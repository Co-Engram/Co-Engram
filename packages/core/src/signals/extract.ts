/**
 * 行为信号提取规则引擎（P4 A.3）
 *
 * 从 ToolCallEvent 流中推断每条 engram 的"真实效用",不依赖 agent 自律上报。
 *
 * 设计：
 *   - 数据驱动：每条规则是 { name, weight, match } 纯函数
 *   - 可组合：DEFAULT_RULES 是 6 条内置规则的组合
 *   - 可扩展：宿主可以传入自己的 rules
 *
 * 规则说明（按 weight 强弱）：
 *   强正(≥ 0.6):repeated_get / get_then_action / contradicts_deleted
 *   弱正(0.2-0.5):get_no_resimilar_search
 *   强负(≤ -0.6):get_then_immediate_search / contradicts_created
 *   弱负(-0.2 - -0.5):user_correction
 *
 * @module @co-engram/core/signals
 */

import type { BehavioralSignal, ToolCallEvent } from "./types.js";

/** 默认 sliding window 大小 */
export const DEFAULT_WINDOW_SIZE = 10;

/** 单条规则 */
export interface SignalRule {
  /** 规则名（用于审计） */
  readonly name: string;
  /** 默认权重 [-1, 1] */
  readonly weight: number;
  /** 匹配函数：从事件流提取信号 */
  match(
    events: readonly ToolCallEvent[],
    options?: SignalRuleOptions,
  ): readonly BehavioralSignal[];
}

export interface SignalRuleOptions {
  readonly windowSize?: number;
}

/**
 * 提取所有规则的信号并合并去重
 *
 * 合并策略：同 (engramId, source) 取 weight 绝对值最大的；不同 source 全部保留。
 */
export function extractSignals(
  events: readonly ToolCallEvent[],
  rules: readonly SignalRule[] = DEFAULT_RULES,
  options?: SignalRuleOptions,
): readonly BehavioralSignal[] {
  const all: BehavioralSignal[] = [];
  for (const rule of rules) {
    const signals = rule.match(events, options);
    all.push(...signals);
  }
  return dedupeSignals(all);
}

/**
 * 去重：同 (engramId, source) 取绝对值最大
 */
export function dedupeSignals(
  signals: readonly BehavioralSignal[],
): readonly BehavioralSignal[] {
  const map = new Map<string, BehavioralSignal>();
  for (const s of signals) {
    const key = `${s.engramId}::${s.source}`;
    const existing = map.get(key);
    if (!existing || Math.abs(s.weight) > Math.abs(existing.weight)) {
      map.set(key, s);
    }
  }
  return [...map.values()];
}

// ============================================================
// 内置规则
// ============================================================

/**
 * 规则 1：同 sliding window 内同一 engram 被 engram_get ≥ 2 次
 *
 * 神经科学依据：反复访问 = 强化（retrieval + reinforcement）
 * weight: +0.6（强正）
 */
export const repeatedGetRule: SignalRule = {
  name: "repeated_get",
  weight: 0.6,
  match(events, options) {
    const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    const signals: BehavioralSignal[] = [];
    const emittedFor = new Map<
      string,
      { count: number; windowStart: number; windowEnd: number }
    >();

    for (let i = 0; i < events.length; i++) {
      const window = events.slice(i, i + windowSize);
      const counts = new Map<string, number>();
      for (const e of window) {
        if (e.toolName !== "engram_get") continue;
        const ids = e.retrievedEngramIds ?? [];
        for (const id of ids) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      const windowEnd = window[window.length - 1]!.at;
      for (const [id, count] of counts) {
        if (count < 2) continue;
        const existing = emittedFor.get(id);
        // 同 engramId 只保留 count 最大且最早出现的那个窗口
        if (!existing || count > existing.count) {
          emittedFor.set(id, { count, windowStart: i, windowEnd });
        }
      }
    }

    for (const [id, info] of emittedFor) {
      signals.push({
        engramId: id,
        weight: 0.6,
        source: "repeated_get",
        evidence: {
          count: info.count,
          windowStart: info.windowStart,
          windowSize,
        },
        sessionId: events[info.windowStart]!.sessionId,
        at: info.windowEnd,
      });
    }
    return signals;
  },
};

/**
 * 规则 2：engram_get 后跟落地动作
 *
 * 含义：从"读"变成"做",有落地证据
 * weight: +0.8（强正）
 *
 * 动作分两类:
 *   - 宿主侧动作(file_edit / bash / git_commit ...):依赖宿主把自身工具调用
 *     上报进信号流。MCP 工具边界下宿主动作不可见(2026-08-17 实证:get_then_action
 *     在生产 10 天零触发),保留集合以待宿主 hook 接入;
 *   - 边界内落地动作(synapse_create / engram_create / engram_update /
 *     engram_synthesize):读走记忆后用知识建立关联/产出新记忆/综合多条,
 *     是 co-engram 工具流内最强的"使用完成"证据。
 */
export const getFollowedByActionRule: SignalRule = {
  name: "get_then_action",
  weight: 0.8,
  match(events, options) {
    const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    const actionTools = new Set([
      // 宿主侧动作(需宿主上报,当前 MCP 边界下不可见)
      "file_edit",
      "file_write",
      "bash",
      "git_commit",
      "git_push",
      "edit_file",
      "write_file",
      // 边界内落地动作(知识被消费的直接证据)
      "synapse_create",
      "engram_create",
      "engram_update",
      "engram_synthesize",
    ]);
    const signals: BehavioralSignal[] = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.toolName !== "engram_get") continue;
      const ids = e.retrievedEngramIds ?? [];
      if (ids.length === 0) continue;

      // 看后续 windowSize 个事件是否有 action
      const followUps = events.slice(i + 1, i + 1 + windowSize);
      const hasAction = followUps.some((f) => actionTools.has(f.toolName));
      if (!hasAction) continue;

      for (const id of ids) {
        signals.push({
          engramId: id,
          weight: 0.8,
          source: "get_then_action",
          evidence: {
            getAt: i,
            actionFound: followUps
              .filter((f) => actionTools.has(f.toolName))
              .map((f) => f.toolName),
            windowSize,
          },
          sessionId: e.sessionId,
          at: e.at,
        });
      }
    }
    return signals;
  },
};

/**
 * 规则 3：engram_get 后 windowSize 内没有 engram_search 同主题
 *
 * 含义：读了一次就够了,问题已解决
 * weight: +0.4（弱正）
 *
 * 注意：这是"沉默的满意"信号,容易误判（可能只是没继续做）。weight 较弱。
 *
 * 2026-08-17 修正:移除「前一个事件是 engram_search 则跳过」的排除。
 * 原排除理由(会被 get_then_immediate_search 捕获)不成立——那条规则要求
 * get **之后**出现 search,与 prior=search 且后续安静的模式不相交;排除条件
 * 实际杀死的恰恰是最健康的 search→get→安静干活 模式(生产 10 天正信号
 * 近零的直接原因之一)。
 */
export const getFollowedByNoSearchRule: SignalRule = {
  name: "get_no_resimilar_search",
  weight: 0.4,
  match(events, options) {
    const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    const signals: BehavioralSignal[] = [];
    const emitted = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.toolName !== "engram_get") continue;
      const ids = e.retrievedEngramIds ?? [];
      if (ids.length === 0) continue;

      const followUps = events.slice(i + 1, i + 1 + windowSize);
      // 后续 windowSize 内没有 engram_search
      const hasSearch = followUps.some((f) => f.toolName === "engram_search");
      if (hasSearch) continue;

      for (const id of ids) {
        const dedupeKey = `${id}@${i}`;
        if (emitted.has(dedupeKey)) continue;
        emitted.add(dedupeKey);
        signals.push({
          engramId: id,
          weight: 0.4,
          source: "get_no_resimilar_search",
          evidence: { getAt: i, windowSize, followUpCount: followUps.length },
          sessionId: e.sessionId,
          at: e.at,
        });
      }
    }
    return signals;
  },
};

/**
 * 规则 4：engram_get 后 < 3 事件立即 engram_search 同主题
 *
 * 含义：get 没解决问题,要再找
 * weight: -0.7（强负）
 */
export const getThenImmediateSearchRule: SignalRule = {
  name: "get_then_immediate_search",
  weight: -0.7,
  match(events) {
    const threshold = 3; // 后续 3 个事件内
    const signals: BehavioralSignal[] = [];
    const emitted = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.toolName !== "engram_get") continue;
      const ids = e.retrievedEngramIds ?? [];
      if (ids.length === 0) continue;

      const followUps = events.slice(i + 1, i + 1 + threshold);
      const hasSearch = followUps.some((f) => f.toolName === "engram_search");
      if (!hasSearch) continue;

      for (const id of ids) {
        const dedupeKey = `${id}@${i}`;
        if (emitted.has(dedupeKey)) continue;
        emitted.add(dedupeKey);
        signals.push({
          engramId: id,
          weight: -0.7,
          source: "get_then_immediate_search",
          evidence: {
            getAt: i,
            searchAt:
              i +
              1 +
              followUps.findIndex((f) => f.toolName === "engram_search"),
            window: threshold,
          },
          sessionId: e.sessionId,
          at: e.at,
        });
      }
    }
    return signals;
  },
};

/**
 * 规则 5：用户消息包含纠正词
 *
 * 纠正词表："不对" / "错了" / "should be" / "actually" / "wait" / "不是"
 * 信号来源：tool args 里如果有 message / prompt / reply 字段包含纠正词
 *
 * 注意：这是一个保守的近似——真正的用户消息可能在 transcript 里但不在 tool args 里。
 * 后续 hook 改造后可以从专门的 user_message 事件类型捕获。
 *
 * weight: -0.4（弱负）
 */
export const userCorrectionRule: SignalRule = {
  name: "user_correction",
  weight: -0.4,
  match(events) {
    const correctionWords = [
      "不对",
      "错了",
      "不是",
      "should be",
      "actually",
      "wait, no",
      "no,",
    ];
    const signals: BehavioralSignal[] = [];
    const emitted = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      // 检查 input 里是否有 message / prompt / text 字段含纠正词
      const text = extractTextFromInput(e.input);
      if (!text) continue;
      const lower = text.toLowerCase();
      const hit = correctionWords.find((w) => lower.includes(w.toLowerCase()));
      if (!hit) continue;

      // 找前面最近的 engram_get / engram_search / engram_create 作为关联
      const prior = findPriorEngramEvent(events, i);
      if (!prior) continue;
      const ids = prior.retrievedEngramIds ?? [];
      for (const id of ids) {
        const dedupeKey = `${id}@${i}`;
        if (emitted.has(dedupeKey)) continue;
        emitted.add(dedupeKey);
        signals.push({
          engramId: id,
          weight: -0.4,
          source: "user_correction",
          evidence: {
            correctionWord: hit,
            eventAt: i,
            relatedTool: prior.toolName,
          },
          sessionId: e.sessionId,
          at: e.at,
        });
      }
    }
    return signals;
  },
};

/**
 * 规则 6：创建 contradicts synapse 指向某 engram
 *
 * 含义：被显式反驳
 * weight: -0.8（强负）
 *
 * 注意：被 contradicts 不等于被 refute（refute 是 verificationStatus 状态机的事）。
 * 这里只记录信号,后续 metacognition 会综合其他维度决定是否 refute。
 */
export const contradictsCreatedRule: SignalRule = {
  name: "contradicts_created",
  weight: -0.8,
  match(events) {
    const signals: BehavioralSignal[] = [];
    for (const e of events) {
      if (e.toolName !== "synapse_create") continue;
      const kind = e.input.kind;
      if (kind !== "contradicts") continue;
      const to = e.input.to;
      if (typeof to !== "string") continue;
      signals.push({
        engramId: to,
        weight: -0.8,
        source: "contradicts_created",
        evidence: {
          synapseFrom: e.input.from,
          at: e.at,
        },
        sessionId: e.sessionId,
        at: e.at,
      });
    }
    return signals;
  },
};

/** 默认规则集（按 weight 从强到弱排序,仅影响审计日志可读性,不影响结果） */
export const DEFAULT_RULES: readonly SignalRule[] = [
  contradictsCreatedRule, // -0.8
  getThenImmediateSearchRule, // -0.7
  getFollowedByActionRule, // +0.8
  repeatedGetRule, // +0.6
  userCorrectionRule, // -0.4
  getFollowedByNoSearchRule, // +0.4
];

// ============================================================
// 工具函数
// ============================================================

function extractTextFromInput(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const fields = ["message", "prompt", "text", "reply", "content", "msg"];
  for (const f of fields) {
    const v = input[f];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function findPriorEngramEvent(
  events: readonly ToolCallEvent[],
  index: number,
): ToolCallEvent | undefined {
  for (let i = index - 1; i >= 0 && i >= index - 5; i--) {
    const e = events[i]!;
    if (
      (e.toolName === "engram_get" ||
        e.toolName === "engram_search" ||
        e.toolName === "engram_create") &&
      e.retrievedEngramIds &&
      e.retrievedEngramIds.length > 0
    ) {
      return e;
    }
  }
  return undefined;
}
