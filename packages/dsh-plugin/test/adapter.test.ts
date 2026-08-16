import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  adaptToolToDefinition,
  adaptAllTools,
} from "../src/adapter.js";
import {
  bootstrapRepositoryAndSearch,
  type Tool,
  type ToolContext,
} from "@co-engram/core";

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: z.object({ q: z.string().describe("查询词") }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (args: unknown, _ctx: ToolContext) => ({ ok: true, args }) as any,
  } as unknown as Tool;
}

const roots: string[] = [];
function makeCtx(): ToolContext {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-adapter-"));
  roots.push(dataRoot);
  const { repository, searchEngine } = bootstrapRepositoryAndSearch({ dataRoot });
  return { repository, searchOrchestrator: searchEngine } as ToolContext;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("adaptToolToDefinition", () => {
  it("裸名 + description + DSL parameters + execute 透传", async () => {
    const tool = makeTool("engram_search");
    const def = adaptToolToDefinition(tool, makeCtx(), "en");
    expect(def.name).toBe("engram_search");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toMatchObject({
      q: { type: "string", required: true, description: "查询词" },
    });
    const out = await def.execute({ q: "x" }, { signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: true });
  });

  it("execute 抛错 → Error(serializeToolError 文本)", async () => {
    const tool = makeTool("boom");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tool as any).execute = async () => {
      throw new Error("kaboom");
    };
    const def = adaptToolToDefinition(tool, makeCtx(), "en");
    await expect(
      def.execute({ q: "x" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/kaboom/);
  });

  it("output 投影:JSON pretty text 块", async () => {
    const tool = makeTool("engram_list_paths");
    const def = adaptToolToDefinition(tool, makeCtx(), "en");
    expect(def.output).toBeDefined();
    const render = (def.output as { render: (a: unknown, v: unknown) => Array<{ type: string; text: string }> }).render;
    const blocks = render({}, { weird: true });
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toContain('"weird"');
  });
});

describe("adaptAllTools", () => {
  it("批量适配 + profile 过滤(standard 少于 full)", async () => {
    const { createToolRegistry, filterToolsByProfile, resolveProfile } = await import("@co-engram/core");
    const ctx = makeCtx();
    const profile = resolveProfile({}).profile;
    const filtered = filterToolsByProfile(createToolRegistry().list(), profile);
    const defs = adaptAllTools(filtered, ctx, "en");
    expect(defs.length).toBeGreaterThan(30);
    expect(defs.every((d) => !d.name.startsWith("mcp__"))).toBe(true);
  });
});
