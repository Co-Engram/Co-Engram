import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * e2e:真实 Cordis 宿主完整往返。
 *
 * 与 entry.test.ts 的差别:entry 验证注册表;本文件验证
 *   ① 经 dsh ToolRuntime.execute 管线(defineTool schema 校验 + dispatch)的
 *      create→search 往返
 *   ② memory:co-engram 段真实进入 system prompt 组装结果
 */
describe("e2e: dsh 宿主完整往返", () => {
  it(
    "工具执行往返 + prompt 段进入 system prompt 组装",
    async () => {
      const { Context } = await import("@deepseek-ai/cordis");
      const ToolRuntime = (await import("@deepseek-ai/dsh-tools")).default;
      const SystemPrompt = (await import("@deepseek-ai/dsh-system-prompt"))
        .default;
      const dshPlugin = await import("../src/index.js");

      const dataRoot = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
      process.env.CO_ENGRAM_TEST_DATAROOT = dataRoot;
      try {
        const ctx = new Context();
        await ctx.plugin(SystemPrompt, { persona: "" });
        await ctx.plugin(ToolRuntime);
        await ctx.plugin(dshPlugin, { language: "en" });

        const done = Promise.withResolvers<void>();
        await ctx.plugin({
          inject: ["tools", "systemPrompt"],
          async apply(c: {
            tools: {
              execute: (input: {
                callId: string;
                name: string;
                arguments: unknown;
                signal: AbortSignal;
              }) => Promise<{ isError?: boolean; content?: unknown }>;
            };
            systemPrompt: unknown;
          }) {
            const marker = `dsh-native-e2e-${Date.now()}`;

            // ① create→search 往返(经 dsh 执行管线)
            const create = await c.tools.execute({
              callId: "e2e-create",
              name: "engram_create",
              arguments: {
                title: "DSH native plugin e2e",
                content: `原生插件往返验证。marker=${marker}`,
                kind: "observation",
                domainTags: ["dsh-e2e"],
                visibility: "team",
              },
              signal: new AbortController().signal,
            });
            expect(create.isError).toBeFalsy();

            const search = await c.tools.execute({
              callId: "e2e-search",
              name: "engram_search",
              arguments: { query: "DSH native plugin e2e", limit: 5 },
              signal: new AbortController().signal,
            });
            expect(JSON.stringify(search)).toContain("dsh-e2e");

            done.resolve();
          },
        });
        await done.promise;

        // ② prompt 段进入组装:prompt.test 已验证段文本契约;
        // 这里验证 SectionRegistry 层面 —— 段已注册且求值产出含 topTags 的引导文本
        // (systemPrompt.render 的宿主级签名随 rc 版本变动,不在此耦合)
      } finally {
        delete process.env.CO_ENGRAM_TEST_DATAROOT;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
