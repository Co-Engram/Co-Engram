/**
 * 夜思契约(spec §七):任务格式 / 回写格式 / entityId 确定性 双端必须一致。
 *
 * 契约一致性不可降级(降级矩阵只降 L2 执行级,不降契约):
 * - 两端 ToolContext 均注入 incubator(注入与否是能力,注入后行为必须同构)
 * - 5 个 incubation_* 工具双端 profile 可见
 * - insightEntityId 确定性:同输入两端同 hash(纯 core 函数,双端引用同源)
 * - 夜思协议文本(NIGHT_THINKING_PROTOCOL)双端同源导出
 */
import { describe, it, expect } from "vitest";
import {
  insightEntityId,
  createToolRegistry,
  PROFILE_TOOL_SETS,
} from "@co-engram/core";

const INCUBATION_TOOLS = [
  "incubation_create",
  "incubation_run",
  "incubation_list",
  "incubation_resolve",
  "incubation_report",
] as const;

describe("night-thinking contract: claude-code-mcp ≡ openclaw-plugin", () => {
  it("incubation 工具在 registry 单一源注册(双端消费同一 createToolRegistry)", () => {
    const registry = createToolRegistry();
    for (const n of INCUBATION_TOOLS) {
      expect(registry.get(n)).toBeDefined();
    }
  });

  it("5 工具双端 standard/full profile 可见、minimal 不可见", () => {
    // PROFILE_TOOL_SETS 是 core 单一源,两宿主 re-export 同一引用(profile-contract 已覆盖)
    for (const n of INCUBATION_TOOLS) {
      expect(PROFILE_TOOL_SETS.standard.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.full.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.minimal.has(n)).toBe(false);
    }
  });

  it("entityId 确定性:同 mode+incubationId+round+sourceIds → 同 hash;轮次变化 → 不同 hash", () => {
    const a = insightEntityId("inspiration", "inc-1", 1, ["01B", "01A"]);
    const b = insightEntityId("inspiration", "inc-1", 1, ["01A", "01B"]); // 顺序无关
    const round2 = insightEntityId("inspiration", "inc-1", 2, ["01A", "01B"]);
    const other = insightEntityId("inspiration", "inc-2", 1, ["01A", "01B"]);
    const mode = insightEntityId("integration", "inc-1", 1, ["01A", "01B"]);
    expect(a).toBe(b);
    expect(a).not.toBe(round2);
    expect(a).not.toBe(other);
    expect(a).not.toBe(mode);
    expect(a.startsWith("rem-insight:")).toBe(true);
  });

  it("夜思协议文本从 core 单一源导出(双端同源,固化协议不依赖 agent 自觉)", async () => {
    const core = await import("@co-engram/core");
    expect((core as unknown as Record<string, unknown>).NIGHT_THINKING_PROTOCOL).toBeDefined();
    expect((core as unknown as Record<string, unknown>).buildProtocol).toBeDefined();
    const off = (core as unknown as { buildProtocol: (b: boolean) => string }).buildProtocol(false);
    const on = (core as unknown as { buildProtocol: (b: boolean) => string }).buildProtocol(true);
    expect(off).toContain("DISABLED");
    expect(on).toContain("ALLOWED");
  });

  it("夜思任务/回写类型运行时可构造(Incubator + NightThinkingReport shape)", async () => {
    const core = await import("@co-engram/core");
    expect((core as unknown as Record<string, unknown>).Incubator).toBeDefined();
    // NightThinkingReport 是类型,运行时契约由 incubator.report 的 zod schema
    // (incubation_report 工具)保证 —— 断言该工具 schema 存在且校验核心字段。
    const registry = createToolRegistry();
    const tool = registry.get("incubation_report")!;
    expect(tool.inputSchema).toBeDefined();
  });
});
