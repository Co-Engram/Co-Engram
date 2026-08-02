import { describe, it, expect } from "vitest";
import { buildServerInstructions } from "../src/instructions.js";

describe("buildServerInstructions", () => {
  it("英文版本包含核心引导", () => {
    const s = buildServerInstructions("en", "standard");
    expect(s).toContain("engram_search");
    expect(s).toContain("engram_create");
    expect(s).toContain("close_learning_loop");
    expect(s).toContain("When to retrieve");
    expect(s).toContain("Standard profile");
  });

  it("中文版本包含核心引导", () => {
    const s = buildServerInstructions("zh", "standard");
    expect(s).toContain("engram_search");
    expect(s).toContain("engram_create");
    expect(s).toContain("close_learning_loop");
    expect(s).toContain("何时召回");
    expect(s).toContain("standard profile");
  });

  it("minimal profile 注入 minimal 说明", () => {
    const en = buildServerInstructions("en", "minimal");
    const zh = buildServerInstructions("zh", "minimal");
    expect(en).toContain("Minimal profile");
    expect(en).toMatch(/exposed/i);
    expect(zh).toContain("minimal profile");
    expect(zh).toMatch(/暴露/);
  });

  it("full profile 注入 full 说明", () => {
    const en = buildServerInstructions("en", "full");
    const zh = buildServerInstructions("zh", "full");
    expect(en).toContain("Full profile");
    expect(en).toContain("41 tools"); // S5 后 full profile = 41 个工具
    expect(zh).toContain("full profile");
    expect(zh).toContain("41 个工具"); // S5 后 full profile = 41 个工具
  });

  it("两种语言内容不同", () => {
    const en = buildServerInstructions("en", "standard");
    const zh = buildServerInstructions("zh", "standard");
    expect(en).not.toBe(zh);
  });

  it("无 state 时长度在 2KB 以内(MCP 客户端友好)", () => {
    for (const lang of ["en", "zh"] as const) {
      for (const profile of ["minimal", "standard", "full"] as const) {
        const s = buildServerInstructions(lang, profile);
        expect(s.length, `${lang}/${profile}`).toBeLessThan(2048);
      }
    }
  });

  it("提及 CLAUDE.md 优先级(MCP host 大多是 Claude Code)", () => {
    const en = buildServerInstructions("en", "standard");
    const zh = buildServerInstructions("zh", "standard");
    expect(en).toContain("CLAUDE.md");
    expect(zh).toContain("CLAUDE.md");
  });

  it("提及 engram_report_failure 用于错误反馈", () => {
    const en = buildServerInstructions("en", "standard");
    const zh = buildServerInstructions("zh", "standard");
    expect(en).toContain("engram_report_failure");
    expect(zh).toContain("engram_report_failure");
  });

  it("minimal profile 文本列出核心工具作锚点(避免误导 agent 调用未暴露的工具)", () => {
    const en = buildServerInstructions("en", "minimal");
    const zh = buildServerInstructions("zh", "minimal");
    // PROFILE_TOOL_SETS.minimal 的核心 3 个工具作为锚点出现,其余工具名可省略
    // (完整枚举会让 instructions 超 2KB;精简版本节省字节,工具列表以 tools/list 为准)
    for (const name of ["engram_search", "engram_create", "engram_get"]) {
      expect(en, `EN missing ${name}`).toContain(name);
      expect(zh, `ZH missing ${name}`).toContain(name);
    }
  });

  it("提及唯一记忆系统机制(强制 LLM 走 engram_create,不写 auto-memory)", () => {
    const en = buildServerInstructions("en", "standard");
    const zh = buildServerInstructions("zh", "standard");
    expect(en).toContain("Memory write path");
    expect(en).toContain("engram_create");
    expect(zh).toContain("记忆写入路径");
    expect(zh).toContain("唯一");
    expect(zh).toContain("engram_create");
  });

  it("minimal profile body 不直接指挥 agent 调用 close_learning_loop(该工具未暴露)", () => {
    const en = buildServerInstructions("en", "minimal");
    const zh = buildServerInstructions("zh", "minimal");
    expect(en).not.toMatch(/call `close_learning_loop`/);
    expect(zh).not.toMatch(/调用 `close_learning_loop`/);
  });
});

describe("buildServerInstructions / pendingProposals 不再注入 instructions", () => {
  // 5a4603c:pendingProposals 从 instructions 移除——LLM 不会自发审批,用户走 viewer 审批。
  // 无论 profile / pendingProposals 多少,instructions 都不出现 pending / engram_list_proposals 指引。
  it("minimal profile + pendingProposals>0 时,instructions 不含 pending 指引", () => {
    const en = buildServerInstructions("en", "minimal", {
      totalEngrams: 10,
      pendingProposals: 2,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    const zh = buildServerInstructions("zh", "minimal", {
      totalEngrams: 10,
      pendingProposals: 2,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    expect(en).not.toContain("Pending proposals");
    expect(zh).not.toContain("待审核候选");
    expect(en).not.toMatch(/call `engram_list_proposals`/);
    expect(zh).not.toMatch(/调用 `engram_list_proposals`/);
  });

  it("standard profile + pendingProposals>0 时同样不含 pending 指引", () => {
    const en = buildServerInstructions("en", "standard", {
      totalEngrams: 10,
      pendingProposals: 2,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    expect(en).not.toMatch(/call `engram_list_proposals`/);
    expect(en).not.toContain("Pending proposals");
  });

  it("full profile + pendingProposals>0 时同样不含 pending 指引", () => {
    const en = buildServerInstructions("en", "full", {
      totalEngrams: 10,
      pendingProposals: 2,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    expect(en).not.toMatch(/call `engram_list_proposals`/);
    expect(en).not.toContain("Pending proposals");
  });
});

describe("buildServerInstructions / 动态 session 段", () => {
  it('提供 state 时英文版本含 "Current state" 段', () => {
    const s = buildServerInstructions("en", "standard", {
      totalEngrams: 42,
      pendingProposals: 3,
      topTags: ["typescript", "react"],
      lowConfidenceTopics: ["auth-flow"],
      missedTopics: [],
    });
    expect(s).toContain("## Current state (session-fresh)");
    // 5a4603c:Total memories / Pending proposals 行已从 instructions 移除
    expect(s).not.toContain("Total memories");
    expect(s).not.toContain("Pending proposals");
    expect(s).toContain("`typescript`");
    expect(s).toContain("`auth-flow`");
  });

  it('提供 state 时中文版本含"当前状态"段', () => {
    const s = buildServerInstructions("zh", "standard", {
      totalEngrams: 10,
      pendingProposals: 0,
      topTags: ["postgres"],
      lowConfidenceTopics: [],
      missedTopics: ["migration"],
    });
    expect(s).toContain("## 当前状态(会话级快照)");
    // 5a4603c:记忆总数行已移除
    expect(s).not.toContain("记忆总数");
    expect(s).toContain("`postgres`");
    expect(s).toContain("`migration`");
    expect(s).not.toContain("待审核候选"); // pendingProposals=0 不显示该行
  });

  it("pendingProposals=0 时不显示 pending 行", () => {
    const en = buildServerInstructions("en", "standard", {
      totalEngrams: 5,
      pendingProposals: 0,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    expect(en).not.toMatch(/Pending proposals/);
  });

  it("空 topTags / lowConfidenceTopics / missedTopics 时不显示对应行", () => {
    const s = buildServerInstructions("en", "standard", {
      totalEngrams: 0,
      pendingProposals: 0,
      topTags: [],
      lowConfidenceTopics: [],
      missedTopics: [],
    });
    // 5a4603c:Total memories 行已移除(恒不显示);空集合对应行不显示
    expect(s).not.toContain("Total memories");
    expect(s).not.toMatch(/Top tags|Low-confidence|Recently missed/);
  });

  it("动态段不突破 2KB 上限(即使全字段都填)", () => {
    const s = buildServerInstructions("en", "standard", {
      totalEngrams: 9999,
      pendingProposals: 50,
      topTags: ["a", "b", "c", "d", "e", "f", "g"],
      lowConfidenceTopics: ["x", "y", "z", "w"],
      missedTopics: ["m1", "m2", "m3", "m4"],
    });
    expect(s.length).toBeLessThan(2048);
  });

  it("undefined state → 不含动态段", () => {
    const s = buildServerInstructions("en", "standard");
    expect(s).not.toContain("## Current state");
  });
});
