/**
 * 沉思契约(2026-08-17 重设计,spec §七):任务格式 / 回写格式 / entityId 确定性
 * 双端必须一致。
 *
 * 契约一致性不可降级(降级只发生在执行级 L2→L1,不降契约):
 * - 两端 ToolContext 均注入 incubator(注入与否是能力,注入后行为必须同构)
 * - 5 个 ponder_* 工具双端 profile 可见(旧 incubation_* 9 工具随多轮状态机移除)
 * - insightEntityId 确定性:同输入两端同 hash(纯 core 函数,双端引用同源)
 * - 沉思协议文本(CONTEMPLATION_PROTOCOL)双端同源导出
 */
import { describe, it, expect } from "vitest";
import {
  insightEntityId,
  createToolRegistry,
  PROFILE_TOOL_SETS,
} from "@co-engram/core";

const PONDER_TOOLS = [
  "ponder_create",
  "ponder_run",
  "ponder_list",
  "ponder_report",
  "ponder_delete",
] as const;

describe("contemplation contract: claude-code-mcp ≡ openclaw-plugin", () => {
  it("ponder 工具在 registry 单一源注册;旧 incubation_* 已移除(双端消费同一 createToolRegistry)", () => {
    const registry = createToolRegistry();
    for (const n of PONDER_TOOLS) {
      expect(registry.get(n)).toBeDefined();
    }
    for (const n of ["incubation_create", "incubation_resolve", "incubation_conclude", "incubation_update", "incubation_pause"] as const) {
      expect(registry.get(n)).toBeUndefined();
    }
  });

  it("5 工具双端 standard/full profile 可见、minimal 不可见", () => {
    // PROFILE_TOOL_SETS 是 core 单一源,两宿主 re-export 同一引用(profile-contract 已覆盖)
    for (const n of PONDER_TOOLS) {
      expect(PROFILE_TOOL_SETS.standard.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.full.has(n)).toBe(true);
      expect(PROFILE_TOOL_SETS.minimal.has(n)).toBe(false);
    }
  });

  it("entityId 确定性:同 mode+incubationId+round+sourceIds → 同 hash;session 变化 → 不同 hash", () => {
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

  it("沉思协议文本从 core 单一源导出(双端同源,固化协议不依赖 agent 自觉)", async () => {
    const core = await import("@co-engram/core");
    const c = core as unknown as Record<string, unknown>;
    expect(c.CONTEMPLATION_PROTOCOL).toBeDefined();
    expect(c.buildProtocol).toBeDefined();
    const protocol = (c as unknown as { buildProtocol: () => string }).buildProtocol();
    // 2026-08-17:受控联网(隐私边界固化)+ MCP/技能/突触资源 + web 申报面
    expect(protocol).toContain("CONTEMPLATION PROTOCOL");
    expect(protocol).toContain("Web research");
    expect(protocol).toContain("never send raw memory content");
    expect(protocol).toContain("resourcesUsed");
    expect(protocol).toContain("ponder_report");
  });

  it("沉思任务/回写类型运行时可构造(Incubator + NightThinkingReport shape)", async () => {
    const core = await import("@co-engram/core");
    expect((core as unknown as Record<string, unknown>).Incubator).toBeDefined();
    // NightThinkingReport 是类型,运行时契约由 incubator.report 的 zod schema
    // (ponder_report 工具)保证 —— 断言该工具 schema 存在。
    const registry = createToolRegistry();
    const tool = registry.get("ponder_report")!;
    expect(tool.inputSchema).toBeDefined();
  });

  it("L2 headless 执行器从 core 单一源导出(三宿主共用,禁止复制品分叉)", async () => {
    const core = await import("@co-engram/core");
    const c = core as unknown as Record<string, unknown>;
    expect(c.createHeadlessExecutor).toBeDefined();
    expect(c.READONLY_ALLOWED_TOOLS).toBeDefined();
    // 只读白名单:受控联网(WebSearch/WebFetch)放行,写工具一律不给
    const allowed = (c.READONLY_ALLOWED_TOOLS as readonly string[]).join(",");
    expect(allowed).toContain("WebSearch");
    expect(allowed).toContain("WebFetch");
    expect(allowed).not.toContain("engram_create");
  });
});
