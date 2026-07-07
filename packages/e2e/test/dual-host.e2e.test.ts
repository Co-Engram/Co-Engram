/**
 * 双宿主 E2E 测试：OpenClaw + Claude Code MCP 共享同一份 team-memory 数据
 *
 * 场景：
 *   1. OpenClaw adapter 创建 engram A
 *   2. Claude Code (MCP) adapter 创建 engram B 并连接 A → B 的 synapse
 *   3. OpenClaw adapter 读取 B + 列出 synapses（应看到来自 MCP 的数据）
 *   4. Claude Code 通过 MCP 读取 A（应看到来自 OpenClaw 的数据）
 *   5. 在两个宿主中分别 update，对方能看到新版本号
 *
 * 这验证了：核心存储 host-agnostic，两个适配器无冲突共享数据。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerCoEngramTools, rebuildSearchIndex } from "@co-engram/openclaw";
import type { CoEngramPluginHostApi } from "@co-engram/openclaw";
import { createCoEngramMcpServer } from "@co-engram/claude-code";
import { EngramRepository } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 内存版的 OpenClaw host（收集注册的 tools）
 *
 * 实现 CoEngramPluginHostApi，让 registerCoEngramTools 把工具注册进来
 */
function createMemoryOpenClawHost(): CoEngramPluginHostApi & {
  tools: Map<string, Parameters<CoEngramPluginHostApi["registerTool"]>[0]>;
} {
  const tools = new Map<
    string,
    Parameters<CoEngramPluginHostApi["registerTool"]>[0]
  >();
  return {
    tools,
    registerTool(tool, opts) {
      tools.set(opts?.name ?? tool.name, tool);
    },
  };
}

/**
 * 启动一个 MCP client 连接到新 server
 */
async function startMcpClient(dataRoot: string) {
  const { server } = createCoEngramMcpServer({ dataRoot });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "e2e-mcp-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * 通过 OpenClaw adapter 调用工具
 */
async function callOpenClaw(
  host: ReturnType<typeof createMemoryOpenClawHost>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = host.tools.get(toolName)!;
  const result = await tool.execute("e2e-call", args);
  // OpenClaw result: 列表类(engram_search/list)被 adapter 渲染为 markdown text,
  // 其他仍是 {type:'json', data}。两种都支持。
  const content = (
    result as { content: { type: string; data?: unknown; text?: string }[] }
  ).content;
  if (content[0] && content[0].type === "json") {
    return content[0].data;
  }
  if (
    content[0] &&
    content[0].type === "text" &&
    typeof content[0].text === "string"
  ) {
    return content[0].text;
  }
  throw new Error(`Unexpected content shape: ${JSON.stringify(content)}`);
}

/**
 * 通过 MCP 调用工具
 */
async function callMcp(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name: toolName, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  if (content[0] && content[0].text) {
    return JSON.parse(content[0].text);
  }
  throw new Error(`Unexpected MCP content: ${JSON.stringify(content)}`);
}

// ============================================================
// 共享数据场景
// ============================================================

describe("双宿主共享同一份 team-memory 数据", () => {
  it("OpenClaw 写入 → MCP 读取", async () => {
    const openclawHost = createMemoryOpenClawHost();
    const openclawCtx = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
    });

    // OpenClaw: 创建 engram A
    const created = (await callOpenClaw(openclawHost, "engram_create", {
      title: "OpenClaw 创建的 A",
      content: "由 OpenClaw adapter 写入",
      kind: "fact",
      domainTags: ["e2e", "cross-host"],
      createdBy: "openclaw-user",
    })) as { id: string };
    const aId = created.id;

    // 断言文件确实落盘（ULID 是 stableId,文件路径由 domainTags + slug 派生,通过 listEngramIndex 查询）
    const openclawRepoList = openclawCtx.repository.listEngramIndex();
    const aEntry = openclawRepoList.find((e) => e.id === aId);
    expect(aEntry).toBeDefined();
    expect(existsSync(join(tmpDir, aEntry!.path))).toBe(true);

    // 启动 MCP server（同一 dataRoot）
    const { client, cleanup } = await startMcpClient(tmpDir);
    try {
      // MCP: 读取 A
      const fetched = (await callMcp(client, "engram_get", {
        id: aId,
        tier: "content",
      })) as { tier: string; content: string; entry: { title: string } };

      expect(fetched.tier).toBe("content");
      expect(fetched.content).toBe("由 OpenClaw adapter 写入");
      expect(fetched.entry.title).toBe("OpenClaw 创建的 A");
    } finally {
      await cleanup();
    }
    void openclawCtx;
  });

  it("MCP 写入 → OpenClaw 读取", async () => {
    // 先启动 OpenClaw（拿到 ctx 和 host）
    const openclawHost = createMemoryOpenClawHost();
    const openclawCtx = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
    });

    // 启动 MCP（同一 dataRoot）
    const { client, cleanup } = await startMcpClient(tmpDir);
    try {
      // MCP: 创建 engram
      const created = (await callMcp(client, "engram_create", {
        title: "MCP 创建的 B",
        content: "由 Claude Code MCP 写入",
        kind: "procedure",
        domainTags: ["e2e", "from-mcp"],
        createdBy: "claude-code-user",
      })) as { id: string };

      // OpenClaw: 通过 engram_list 看到这个 engram（索引可能因另一宿主写入而过期,先强制重建）
      (
        openclawCtx.repository as unknown as { rebuildIndex: () => void }
      ).rebuildIndex?.();
      const list = (await callOpenClaw(openclawHost, "engram_list", {
        filter: { domainTags: ["from-mcp"] },
        limit: 50,
      })) as string;
      // adapter 把 engram_list 结果渲染为 markdown text;验证文本包含期望字段
      expect(list).toContain(created.id);
      expect(list).toContain("MCP 创建的 B");
    } finally {
      await cleanup();
    }
  });

  it("OpenClaw 创建 A → MCP 创建 B + synapse A→B → OpenClaw 查询 B 的 synapses", async () => {
    const openclawHost = createMemoryOpenClawHost();
    registerCoEngramTools(openclawHost, { dataRoot: tmpDir });

    // OpenClaw: 创建 A
    const aCreated = (await callOpenClaw(openclawHost, "engram_create", {
      title: "基础事实",
      content: "基础事实内容",
      kind: "fact",
      domainTags: ["cross"],
      createdBy: "openclaw",
    })) as { id: string };

    let bId = "";
    // 启动 MCP
    const { client, cleanup } = await startMcpClient(tmpDir);
    try {
      // MCP: 创建 B
      const bCreated = (await callMcp(client, "engram_create", {
        title: "扩展事实",
        content: "在 A 基础上扩展",
        kind: "fact",
        domainTags: ["cross"],
        createdBy: "mcp",
      })) as { id: string };
      bId = bCreated.id;

      // MCP: 创建 synapse A → B (extends)
      const synCreated = (await callMcp(client, "synapse_create", {
        from: aCreated.id,
        to: bCreated.id,
        kind: "extends",
        weight: 0.8,
        createdBy: "mcp",
      })) as { id: string };
      expect(synCreated.id).toBeTruthy();
    } finally {
      await cleanup();
    }

    // OpenClaw: 查询 B 的 incoming synapses（应由 MCP 创建的那条）
    const bList = (await callOpenClaw(openclawHost, "synapse_list", {
      engramId: bId,
      direction: "both",
    })) as { incoming: { from: string; kind: string }[]; outgoing: unknown[] };
    expect(bList.incoming.length).toBe(1);
    expect(bList.incoming[0]!.kind).toBe("extends");

    // OpenClaw: 查询 A 的 outgoing synapses
    const aList = (await callOpenClaw(openclawHost, "synapse_list", {
      engramId: aCreated.id,
      direction: "both",
    })) as { outgoing: { to: string; kind: string }[]; incoming: unknown[] };
    expect(aList.outgoing.length).toBe(1);
    expect(aList.outgoing[0]!.kind).toBe("extends");
  });

  it("两宿主分别 update 同一 engram，version 单调递增", async () => {
    const openclawHost = createMemoryOpenClawHost();
    registerCoEngramTools(openclawHost, { dataRoot: tmpDir });

    // OpenClaw 创建
    const created = (await callOpenClaw(openclawHost, "engram_create", {
      title: "共享",
      content: "V1",
      kind: "fact",
      domainTags: ["shared"],
      createdBy: "openclaw",
    })) as { id: string };

    // OpenClaw update → V2
    await callOpenClaw(openclawHost, "engram_update", {
      id: created.id,
      content: "V2",
      updatedBy: "openclaw",
    });

    // MCP update → V3
    const { client, cleanup } = await startMcpClient(tmpDir);
    try {
      const updated = (await callMcp(client, "engram_update", {
        id: created.id,
        content: "V3",
        updatedBy: "mcp",
      })) as { version: number };
      expect(updated.version).toBe(3);
    } finally {
      await cleanup();
    }

    // 通过 repository 直读验证
    const repo = new EngramRepository({ rootPath: tmpDir });
    const final = repo.readEngram(created.id);
    expect(final.version).toBe(3);
    expect(final.content).toBe("V3");
  });

  it("MCP 端搜索能找到 OpenClaw 写入的 engram（rebuild 后）", async () => {
    const openclawHost = createMemoryOpenClawHost();
    const openclawCtx = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
    });

    // OpenClaw: 写入一个 engram
    await callOpenClaw(openclawHost, "engram_create", {
      title: "Android ADB",
      content: "adb wireless debugging",
      kind: "fact",
      domainTags: ["searchable"],
      createdBy: "openclaw",
    });

    // 重建 OpenClaw 端索引
    rebuildSearchIndex(openclawCtx.searchOrchestrator!, openclawCtx.repository);

    // 启动 MCP（启动时会自动 rebuild）
    const { client, cleanup } = await startMcpClient(tmpDir);
    try {
      const result = (await callMcp(client, "engram_search", {
        query: "adb",
      })) as { results: { id: string; score: number }[]; total: number };
      expect(result.total).toBe(1);
      // id 是 ULID,与路径/domainTags 解耦
      expect(result.results[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      await cleanup();
    }
  });

  it("单文件确实落盘（frontmatter + body 在同一 .md）", async () => {
    const openclawHost = createMemoryOpenClawHost();
    const openclawCtx = registerCoEngramTools(openclawHost, {
      dataRoot: tmpDir,
    });

    const created = (await callOpenClaw(openclawHost, "engram_create", {
      title: "文件验证",
      content: "内容",
      kind: "fact",
      domainTags: ["file-check"],
      createdBy: "openclaw",
    })) as { id: string };

    // 通过 listEngramIndex 查找实际文件路径（domainTags + slug 派生）
    const entry = openclawCtx.repository
      .listEngramIndex()
      .find((e) => e.id === created.id);
    expect(entry).toBeDefined();
    const filePath = join(tmpDir, entry!.path);
    expect(existsSync(filePath)).toBe(true);

    // 单文件含 frontmatter + body(默认 zh 模式:正文在上 + 中文 keys 在下)
    const fileRaw = readFileSync(filePath, "utf-8");
    expect(fileRaw).toContain("---");
    expect(fileRaw).toContain("标题: 文件验证");
    expect(fileRaw).toContain("创建时间:");
    expect(fileRaw).toContain("版本: 1");
    expect(fileRaw).toContain("检索次数: 0");
    expect(fileRaw).toContain("内容");
  });
});
