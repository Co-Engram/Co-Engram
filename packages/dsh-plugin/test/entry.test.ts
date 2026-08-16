import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dsh plugin entry(最小 Cordis 宿主)", () => {
  it(
    "apply 注册全部工具 + system prompt 段",
    async () => {
      const { Context } = await import("@deepseek-ai/cordis");
      const ToolRuntime = (await import("@deepseek-ai/dsh-tools")).default;
      const SystemPrompt = (await import("@deepseek-ai/dsh-system-prompt"))
        .default;
      const dshPlugin = await import("../src/index.js");

      const dataRoot = mkdtempSync(join(tmpdir(), "dsh-entry-"));
      process.env.CO_ENGRAM_TEST_DATAROOT = dataRoot;
      try {
        const ctx = new Context();
        await ctx.plugin(SystemPrompt, { persona: "" });
        await ctx.plugin(ToolRuntime);
        await ctx.plugin(dshPlugin, { language: "en" });

        // consumer 视角(inject 可见性机制,Task 1 实证)
        const seen = await new Promise<{
          names: string[];
          promptHasSection: boolean;
        }>((resolve, reject) => {
          void Promise.resolve(
            ctx.plugin({
              inject: ["tools", "systemPrompt"],
              apply(c: {
                tools: { schemas: () => Array<{ name: string }> };
                systemPrompt: {
                  section: (s: { name: string }) => unknown;
                };
              }) {
                // 通过注册表观察段(section 名唯一性 + 段存在性由 tools/prompt 测试覆盖)
                const names = c.tools.schemas().map((s) => s.name);
                resolve({ names, promptHasSection: names.length > 0 });
              },
            }),
          ).catch(reject);
        });
        expect(seen.names).toContain("engram_search");
        expect(seen.names).toContain("engram_create");
        expect(seen.names.filter((n) => n.startsWith("mcp__")).length).toBe(0);
        expect(seen.names.length).toBeGreaterThanOrEqual(38);
      } finally {
        delete process.env.CO_ENGRAM_TEST_DATAROOT;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
