/**
 * Cross-host contract test
 *
 * 防止 Claude Code MCP 与 OpenClaw plugin 在共享 core 之上漂移。
 * 双宿主各自实现 adapter 层,容易在工具集 / 默认值 / 描述 上产生不对称。
 * 本测试把两宿主的"对外契约"拉到同一张表上比对,任何漂移在 CI 阶段就暴露。
 *
 * 契约维度:
 *   1. 工具集对称性(两宿主在 full profile 下暴露相同 native 工具名)
 *   2. 工具描述同源(同一工具在两宿主的 description 都来自 core i18n agent 层)
 *   3. 默认值一致(language 默认值)
 *
 * 不测:端到端数据流(由 dual-host.e2e.test.ts 覆盖)、createdBy 回退链(由单元测试覆盖)。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerCoEngramTools } from "@co-engram/openclaw";
import type { CoEngramPluginHostApi, OpenClawToolDescriptor } from "@co-engram/openclaw";
import { createCoEngramMcpServer } from "@co-engram/claude-code";
import { createToolRegistry, localizeToolDescription, DEFAULT_LANGUAGE, PROFILE_TOOL_SETS } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-contract-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// helpers
// ============================================================

function createMemoryOpenClawHost(): CoEngramPluginHostApi & {
  tools: Map<string, OpenClawToolDescriptor>;
} {
  const tools = new Map<string, OpenClawToolDescriptor>();
  return {
    tools,
    registerTool(tool, opts) {
      tools.set(opts?.name ?? tool.name, tool);
    },
  };
}

async function startMcpClient(
  dataRoot: string,
  opts: { language?: "en" | "zh"; profile?: "minimal" | "standard" | "full" } = {},
) {
  const { server } = createCoEngramMcpServer({
    dataRoot,
    language: opts.language,
    profile: opts.profile,
    startMaintenance: false,
    autoOnboardMergeDriver: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

// ============================================================
// 1. 工具集对称性
// ============================================================

describe("cross-host contract / 工具集对称性", () => {
  it("OpenClaw 暴露全部 native + 2 兼容 = registry 全集 + 2 个工具", () => {
    const nativeCount = createToolRegistry().list().length;
    const host = createMemoryOpenClawHost();
    registerCoEngramTools(host, { dataRoot: tmpDir, language: "en", startMaintenance: false });
    expect(host.tools.size).toBe(nativeCount + 2);
  });

  it("Claude Code MCP full profile 暴露全部 native 工具(= registry 全集,不含 memory_search/memory_get)", async () => {
    const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    expect(names.size).toBe(createToolRegistry().list().length);
    expect(names.has("memory_search")).toBe(false);
    expect(names.has("memory_get")).toBe(false);
  });

  it("两宿主在 full profile 下的 native 工具名集合一致", async () => {
    const ocHost = createMemoryOpenClawHost();
    registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "en", startMaintenance: false });
    const ocNativeNames = new Set(
      Array.from(ocHost.tools.keys()).filter(
        (n) => n !== "memory_search" && n !== "memory_get",
      ),
    );

    const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
    const mcpTools = await client.listTools();
    const mcpNames = new Set(mcpTools.tools.map((t) => t.name));

    expect(ocNativeNames).toEqual(mcpNames);
  });

  it("core registry 工具数 = MCP full profile 的真相源", async () => {
    const registrySize = createToolRegistry().list().length;
    const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(registrySize);
  });

  it("MCP standard / minimal profile 工具数与 PROFILE_TOOL_SETS 一致", async () => {
    const std = await startMcpClient(tmpDir, { language: "en", profile: "standard" });
    const stdTools = await std.client.listTools();
    expect(stdTools.tools.length).toBe(PROFILE_TOOL_SETS.standard.size);

    const min = await startMcpClient(tmpDir, { language: "en", profile: "minimal" });
    const minTools = await min.client.listTools();
    expect(minTools.tools.length).toBe(PROFILE_TOOL_SETS.minimal.size);
  });
});

// ============================================================
// 2. 工具描述同源(都来自 core i18n agent 层)
// ============================================================

describe("cross-host contract / 工具描述同源", () => {
  const sampleTools = [
    "engram_create",
    "engram_search",
    "engram_reinforce",
    "synapse_create",
    "engram_doctor",
    "engram_archive",
    "engram_forget",
    "get_evolution_lineage",
  ] as const;

  for (const name of sampleTools) {
    it(`"${name}" 在两宿主的 description 都等于 core i18n agent 层 (en)`, async () => {
      const expected = localizeToolDescription(name, "en", undefined, "agent");

      const ocHost = createMemoryOpenClawHost();
      registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "en", startMaintenance: false });
      const ocDesc = ocHost.tools.get(name)?.description;

      const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
      const mcpTools = await client.listTools();
      const mcpDesc = mcpTools.tools.find((t) => t.name === name)?.description;

      expect(ocDesc).toBe(expected);
      expect(mcpDesc).toBe(expected);
    });
  }

  it("zh 语言下两宿主描述一致且来自 core i18n zh agent 层", async () => {
    const name = "engram_create";
    const expected = localizeToolDescription(name, "zh", undefined, "agent");

    const ocHost = createMemoryOpenClawHost();
    registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "zh", startMaintenance: false });
    const ocDesc = ocHost.tools.get(name)?.description;

    const { client } = await startMcpClient(tmpDir, { language: "zh", profile: "full" });
    const mcpTools = await client.listTools();
    const mcpDesc = mcpTools.tools.find((t) => t.name === name)?.description;

    expect(ocDesc).toBe(expected);
    expect(mcpDesc).toBe(expected);
    expect(ocDesc).toContain("何时调用");
  });

  it("原 LLM_TOOL_DESCRIPTIONS 未覆盖的工具(如 engram_archive)现在两宿主都有 agent 层描述", async () => {
    const name = "engram_archive";
    const ocHost = createMemoryOpenClawHost();
    registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "en", startMaintenance: false });
    const ocDesc = ocHost.tools.get(name)?.description;

    const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
    const mcpTools = await client.listTools();
    const mcpDesc = mcpTools.tools.find((t) => t.name === name)?.description;

    // 三层拆分后,engram_archive 已有 agent 层描述(带 WHEN TO CALL)
    expect(ocDesc).toContain("WHEN TO CALL");
    expect(mcpDesc).toContain("WHEN TO CALL");
    expect(ocDesc).toBe(mcpDesc);
  });
});

// ============================================================
// 3. 默认值一致
// ============================================================

describe("cross-host contract / 默认值一致", () => {
  it("两宿主默认 language 都是 DEFAULT_LANGUAGE(core 真相源)", () => {
    const ocHost = createMemoryOpenClawHost();
    const result = registerCoEngramTools(ocHost, { dataRoot: tmpDir, startMaintenance: false });
    expect(result.language).toBe(DEFAULT_LANGUAGE);
  });

  it("MCP 不传 language 时也回退到 DEFAULT_LANGUAGE", async () => {
    // 通过描述语言验证默认 language
    const { client } = await startMcpClient(tmpDir, { profile: "full" });
    const tools = await client.listTools();
    const search = tools.tools.find((t) => t.name === "engram_search");
    const expectedDefault = localizeToolDescription(
      "engram_search",
      DEFAULT_LANGUAGE,
      undefined,
      "agent",
    );
    expect(search?.description).toBe(expectedDefault);
  });

  it("两宿主显式传相同 language 时描述一致(en)", async () => {
    const name = "engram_reinforce";
    const ocHost = createMemoryOpenClawHost();
    registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "en", startMaintenance: false });
    const ocDesc = ocHost.tools.get(name)?.description;

    const { client } = await startMcpClient(tmpDir, { language: "en", profile: "full" });
    const tools = await client.listTools();
    const mcpDesc = tools.tools.find((t) => t.name === name)?.description;

    expect(ocDesc).toBe(mcpDesc);
  });

  it("两宿主显式传相同 language 时描述一致(zh)", async () => {
    const name = "engram_reinforce";
    const ocHost = createMemoryOpenClawHost();
    registerCoEngramTools(ocHost, { dataRoot: tmpDir, language: "zh", startMaintenance: false });
    const ocDesc = ocHost.tools.get(name)?.description;

    const { client } = await startMcpClient(tmpDir, { language: "zh", profile: "full" });
    const tools = await client.listTools();
    const mcpDesc = tools.tools.find((t) => t.name === name)?.description;

    expect(ocDesc).toBe(mcpDesc);
  });
});
