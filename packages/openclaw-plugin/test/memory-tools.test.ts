import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemorySearchTool,
  createMemoryGetTool,
  createMemoryTools,
  type MemorySearchHit,
  type MemoryGetResult,
} from "../src/memory-tools.js";
import {
  createCoEngramContext,
  rebuildSearchIndex,
} from "../src/plugin-entry.js";
import type { ToolContext } from "@co-engram/core";

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-memory-tools-"));
  ctx = createCoEngramContext({ dataRoot: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// helpers
// ============================================================

async function createEngram(
  title: string,
  content: string,
  tags: readonly string[] = [],
  kind: "fact" | "procedure" | "observation" = "fact",
): Promise<string> {
  const created = ctx.repository.createEngram({
    title,
    content,
    kind,
    domainTags: tags,
    createdBy: "tester",
  });
  return created.id;
}

/** 因为创建后索引是旧的,需要重建 */
function refreshIndex(): void {
  rebuildSearchIndex(ctx.searchOrchestrator!, ctx.repository);
}

// ============================================================
// createMemorySearchTool / schema
// ============================================================

describe("createMemorySearchTool / schema", () => {
  it("name 为 memory_search", () => {
    const tool = createMemorySearchTool(ctx, "en");
    expect(tool.name).toBe("memory_search");
  });

  it("label 为 Memory Search", () => {
    const tool = createMemorySearchTool(ctx, "en");
    expect(tool.label).toBe("Memory Search");
  });

  it("description 非空", () => {
    const tool = createMemorySearchTool(ctx, "en");
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it("parameters 是 object schema,含 query/maxResults/minScore", () => {
    const tool = createMemorySearchTool(ctx, "en");
    expect(tool.parameters.type).toBe("object");
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("maxResults");
    expect(props).toHaveProperty("minScore");
  });

  it("required 字段含 query", () => {
    const tool = createMemorySearchTool(ctx, "en");
    expect(tool.parameters.required).toContain("query");
  });

  it("maxResults schema 限制 [1,20]", () => {
    const tool = createMemorySearchTool(ctx, "en");
    const prop = (
      tool.parameters.properties as Record<
        string,
        { minimum: number; maximum: number }
      >
    ).maxResults;
    expect(prop.minimum).toBe(1);
    expect(prop.maximum).toBe(20);
  });

  it("minScore schema 限制 [0,1]", () => {
    const tool = createMemorySearchTool(ctx, "en");
    const prop = (
      tool.parameters.properties as Record<
        string,
        { minimum: number; maximum: number }
      >
    ).minScore;
    expect(prop.minimum).toBe(0);
    expect(prop.maximum).toBe(1);
  });

  it("language=zh 时 description 是中文", () => {
    const enTool = createMemorySearchTool(ctx, "en");
    const zhTool = createMemorySearchTool(ctx, "zh");
    expect(enTool.description).not.toEqual(zhTool.description);
  });

  it("默认 language=zh", () => {
    const zhTool = createMemorySearchTool(ctx, "zh");
    const defaultTool = createMemorySearchTool(ctx);
    expect(defaultTool.description).toEqual(zhTool.description);
  });
});

// ============================================================
// createMemorySearchTool / execute
// ============================================================

describe("createMemorySearchTool / execute", () => {
  it("空查询返回 error result", async () => {
    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "" });
    expect(r.details?.ok).toBe(false);
    expect(r.details?.error).toMatch(/query/i);
  });

  it("空白查询返回 error result", async () => {
    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "   " });
    expect(r.details?.ok).toBe(false);
  });

  it("无 searchOrchestrator 时返回 error", async () => {
    const ctxWithoutSearch: ToolContext = {
      ...ctx,
      searchOrchestrator: undefined,
    };
    const tool = createMemorySearchTool(ctxWithoutSearch, "en");
    const r = await tool.execute("call-1", { query: "foo" });
    expect(r.details?.ok).toBe(false);
    expect(r.details?.error).toMatch(/SearchOrchestrator/i);
  });

  it("查询匹配 engram 返回 hit 列表", async () => {
    await createEngram("Android ADB", "adb debugging tips", ["android"]);
    await createEngram("iOS Simulator", "xcode simulator hints", ["ios"]);
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "adb" });
    expect(r.details?.ok).toBe(true);
    // adapter 渲染为 markdown text(避免 OpenClaw UI 把 JSON 渲染成图表)
    expect(r.content[0]!.type).toBe("text");
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("共");
    expect(text).toContain("条记忆");
    // id 是 ULID,与路径/domainTags 解耦;验证 ULID 形态出现在 markdown 中
    expect(text).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("结果含 metadata 字段", async () => {
    await createEngram("Test Engram", "content here", ["tag1"]);
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "test" });
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("Test Engram");
    expect(text).toContain("tag1"); // tags 出现在 markdown
    expect(text).toMatch(/kind:/); // kind 字段
  });

  it("content 被截断到 ≤503 字符(500 + ...)", async () => {
    const longContent = "x".repeat(800);
    await createEngram("Long", longContent);
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "long" });
    // adapter 不再返回完整 JSON hit,而是 markdown text。
    // 这里验证 text 中 'x' 字符不超过 503(说明被截断,而非整个 800 字符)
    const text = (r.content[0] as { text?: string }).text ?? "";
    const xCount = (text.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(503);
  });

  it("maxResults 限制返回数量", async () => {
    await createEngram("A", "topic X", []);
    await createEngram("B", "topic X", []);
    await createEngram("C", "topic X", []);
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "X", maxResults: 2 });
    const text = (r.content[0] as { text?: string }).text ?? "";
    // 统计 markdown 列表项数(以 "数字. " 开头的行)
    const itemCount = (text.match(/^\d+\.\s\*\*/gm) ?? []).length;
    expect(itemCount).toBeLessThanOrEqual(2);
  });

  it("maxResults 超过 20 被 clamp", async () => {
    const tool = createMemorySearchTool(ctx, "en");
    // 不抛错(被 clamp 到 20)
    const r = await tool.execute("call-1", { query: "foo", maxResults: 100 });
    expect(r.details?.ok).toBe(true);
  });

  it("minScore 过滤低分结果", async () => {
    // 得分归一化:top 命中恒为 1.00,弱匹配 < 1.00;clampMinScore 上限 1.0。
    // 故「有匹配时不可能用 minScore 过滤到 0 条」(top=1.00 恒 ≥ minScore)。
    // 正确测法:minScore 过滤弱匹配、保留 top。
    await createEngram("Exact", "foo foo foo");
    await createEngram("Weaker", "foo bar baz qux other words here");
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const textOf = (r: { content: Array<{ text?: string }> }) =>
      (r.content[0]?.text ?? "") as string;

    // 无阈值:两条都返回(Exact=1.00,Weaker<1.00)
    const r0 = await tool.execute("call-0", { query: "foo" });
    const t0 = textOf(r0);
    expect(t0, "无阈值应返回 2 条").toMatch(/共 2 条记忆/);

    // 动态提取 Weaker 的分数(不硬编码,防 bm25 微调致脆裂)
    const weakerScore = parseFloat(
      t0.match(/Weaker[\s\S]*?score:\s*([\d.]+)/)?.[1] ?? "0",
    );
    expect(weakerScore, "Weaker 应有 >0 分数").toBeGreaterThan(0);
    expect(weakerScore, "Weaker 应 <1.0(top 才归一化为 1.00)").toBeLessThan(1);

    // minScore 设在 (weakerScore, 1.0) 之间 → 过滤 Weaker,保留 Exact(1.00)
    const threshold = (weakerScore + 1) / 2;
    const r = await tool.execute("call-1", { query: "foo", minScore: threshold });
    const text = textOf(r);
    expect(text, `minScore=${threshold} 应过滤 Weaker(${weakerScore})`).toMatch(
      /共 1 条记忆/,
    );
    expect(text).toContain("Exact");
    expect(text).not.toContain("Weaker");
  });

  it("无匹配返回空数组(非 error)", async () => {
    await createEngram("Foo", "foo content", []);
    refreshIndex();

    const tool = createMemorySearchTool(ctx, "en");
    const r = await tool.execute("call-1", { query: "nonexistent-term-xyz" });
    expect(r.details?.ok).toBe(true);
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).toMatch(/共 0 条记忆/);
  });
});

// ============================================================
// createMemoryGetTool / schema
// ============================================================

describe("createMemoryGetTool / schema", () => {
  it("name 为 memory_get", () => {
    const tool = createMemoryGetTool(ctx, "en");
    expect(tool.name).toBe("memory_get");
  });

  it("parameters 含 id(required)", () => {
    const tool = createMemoryGetTool(ctx, "en");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.required).toContain("id");
  });

  it("language=zh 时 description 是中文", () => {
    const en = createMemoryGetTool(ctx, "en");
    const zh = createMemoryGetTool(ctx, "zh");
    expect(en.description).not.toEqual(zh.description);
  });
});

// ============================================================
// createMemoryGetTool / execute
// ============================================================

describe("createMemoryGetTool / execute", () => {
  it("空 id 返回 error result", async () => {
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", { id: "" });
    expect(r.details?.ok).toBe(false);
    expect(r.details?.error).toMatch(/id/i);
  });

  it("不存在的 id 返回 error", async () => {
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", { id: "nonexistent/path" });
    expect(r.details?.ok).toBe(false);
  });

  it("返回完整 engram 内容", async () => {
    const id = await createEngram("Full Doc", "complete content here", [
      "tag-a",
    ]);
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", { id });
    expect(r.details?.ok).toBe(true);
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("complete content here");
  });

  it("返回 metadata 各字段", async () => {
    const id = await createEngram("Meta", "content", ["t1", "t2"], "procedure");
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", { id });
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("createdAt:");
    expect(text).toContain("updatedAt:");
    expect(text).toContain("createdBy: tester");
    expect(text).toContain("importance:");
    expect(text).toContain("t1, t2");
    expect(text).toContain("kind: procedure");
    expect(text).toContain("reinforcementCount: 0");
  });

  it("返回 relatedIds 数组(无 synapse 时为空)", async () => {
    const id = await createEngram("Lonely", "solo");
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", { id });
    // 无 synapse 时,markdown 不渲染 "相关记忆" 段
    const text = (r.content[0] as { text?: string }).text ?? "";
    expect(text).not.toContain("相关记忆");
  });

  it("参数缺失(无 params)时返回 error", async () => {
    const tool = createMemoryGetTool(ctx, "en");
    const r = await tool.execute("call-1", undefined);
    expect(r.details?.ok).toBe(false);
  });
});

// ============================================================
// createMemoryTools / 批量工厂
// ============================================================

describe("createMemoryTools", () => {
  it("返回 2 个工具:memory_search + memory_get", () => {
    const tools = createMemoryTools(ctx, "en");
    expect(tools.length).toBe(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_get");
  });

  it("语言一致传递", () => {
    const enTools = createMemoryTools(ctx, "en");
    const zhTools = createMemoryTools(ctx, "zh");
    const enSearchDesc = enTools.find(
      (t) => t.name === "memory_search",
    )!.description;
    const zhSearchDesc = zhTools.find(
      (t) => t.name === "memory_search",
    )!.description;
    expect(enSearchDesc).not.toEqual(zhSearchDesc);
  });

  it("批量创建的两个工具都能独立执行", async () => {
    const tools = createMemoryTools(ctx, "en");
    const search = tools.find((t) => t.name === "memory_search")!;
    const get = tools.find((t) => t.name === "memory_get")!;

    const id = await createEngram("X", "content x");
    refreshIndex();

    const s = await search.execute("c", { query: "x" });
    expect(s.details?.ok).toBe(true);

    const g = await get.execute("c", { id });
    expect(g.details?.ok).toBe(true);
  });
});

// ============================================================
// 端到端:search → get
// ============================================================

describe("end-to-end / search → get", () => {
  it("先 search 拿 id,再用 get 读详情", async () => {
    const id = await createEngram(
      "ADB Workflow",
      "step-by-step adb debugging workflow",
      ["android", "testing"],
      "procedure",
    );
    refreshIndex();

    const tools = createMemoryTools(ctx, "en");
    const search = tools.find((t) => t.name === "memory_search")!;
    const get = tools.find((t) => t.name === "memory_get")!;

    const sRes = await search.execute("c", { query: "adb" });
    const sText = (sRes.content[0] as { text?: string }).text ?? "";
    expect(sText).toContain("ADB Workflow");
    expect(sText).toContain(id);

    const gRes = await get.execute("c", { id });
    const gText = (gRes.content[0] as { text?: string }).text ?? "";
    expect(gText).toContain("step-by-step adb debugging workflow");
    expect(gText).toContain("kind: procedure");
  });
});
