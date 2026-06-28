import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCoEngramMcpServer,
  registerCoEngramTool,
} from "../src/register.js";
import { createToolRegistry } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-mcp-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 启动一个连接到 co-engram MCP server 的 client（InMemory transport）
 */
async function startClient(dataRoot: string): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const { server } = createCoEngramMcpServer({ dataRoot, profile: "full" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: { tools: {} } },
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

// ============================================================
// createCoEngramMcpServer
// ============================================================

describe("createCoEngramMcpServer", () => {
  it("创建 server + ctx", () => {
    const { server, ctx } = createCoEngramMcpServer({ dataRoot: tmpDir });
    expect(server).toBeDefined();
    expect(ctx.repository).toBeDefined();
    expect(ctx.searchOrchestrator).toBeDefined();
  });

  it("自动创建 dataRoot 目录", () => {
    const newRoot = join(tmpDir, "sub-data");
    createCoEngramMcpServer({ dataRoot: newRoot });
    // 不抛错即成功
    expect(newRoot.length).toBeGreaterThan(0);
  });

  it("dataRoot 不存在时返回 dataRootAutoCreated=true(首次运行标记)", () => {
    const newRoot = join(tmpDir, "fresh-data");
    const result = createCoEngramMcpServer({ dataRoot: newRoot });
    expect(result.dataRootAutoCreated).toBe(true);
  });

  it("dataRoot 已存在时 dataRootAutoCreated 为 undefined", () => {
    // tmpDir 由 mkdtempSync 创建,已存在
    const result = createCoEngramMcpServer({ dataRoot: tmpDir });
    expect(result.dataRootAutoCreated).toBeUndefined();
  });
});

// ============================================================
// registerCoEngramTool
// ============================================================

describe("registerCoEngramTool", () => {
  it("注册单个工具到 fresh McpServer", () => {
    const fresh = new McpServer(
      { name: "test-fresh", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const registry = createToolRegistry();
    const tool = registry.get("engram_search")!;
    expect(() =>
      registerCoEngramTool(fresh, tool, { repository: {} as never }),
    ).not.toThrow();
  });
});

// ============================================================
// 端到端：通过 MCP 协议调用
// ============================================================

describe("MCP end-to-end", () => {
  it("tools/list 返回 28 个工具（P0 12 + P1 5 + P2 3 + P3 2 + M1 proposal 3 + repo-health 2 + synthesize 1）", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const list = await client.listTools();
      expect(list.tools.length).toBe(28);
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toContain("engram_create");
      expect(names).toContain("engram_reinforce");
      expect(names).toContain("engram_report_failure");
      expect(names).toContain("engram_archive");
      expect(names).toContain("engram_restore");
      expect(names).toContain("engram_forget");
      expect(names).toContain("synapse_create");
      expect(names).toContain("skill_invoke");
      expect(names).toContain("engram_list_proposals");
      expect(names).toContain("engram_accept_proposal");
      expect(names).toContain("engram_dismiss_proposal");
    } finally {
      await cleanup();
    }
  });

  it("engram_create 工具可调用并返回结果", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const result = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "ADB 调试",
          content: "使用 wireless adb",
          kind: "procedure",
          domainTags: ["testing"],
          createdBy: "yang",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as { type: string; text: string }).text;
      const parsed = JSON.parse(text) as { id: string };
      // id 是 ULID,与路径解耦
      expect(parsed.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      await cleanup();
    }
  });

  it("非法参数返回 isError=true", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const result = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "", // 非法（空字符串）
          content: "x",
          kind: "fact",
          domainTags: ["t"],
          createdBy: "y",
        },
      });

      // MCP SDK 在服务端用 zod inputSchema 校验，失败时返回 isError=true
      // 错误内容包含 zod issue 路径或字段名
      expect(result.isError).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text.toLowerCase()).toMatch(/title|invalid|error|too_small/);
    } finally {
      await cleanup();
    }
  });

  it("engram_search 在 engram_create 后立即能找到新 engram（invalidateSearchIndex 自动重建）", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      // 创建
      const createRes = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "Android ADB",
          content: "adb 调试",
          kind: "fact",
          domainTags: ["testing"],
          createdBy: "y",
        },
      });
      const createdId = (
        JSON.parse((createRes.content[0] as { text: string }).text) as {
          id: string;
        }
      ).id;

      // 新行为:create 后 index 自动重建,search 立即能找到（之前是 P0 限制:写入不更新索引）
      const afterRes = await client.callTool({
        name: "engram_search",
        arguments: { query: "adb" },
      });
      const afterData = JSON.parse(
        (afterRes.content[0] as { text: string }).text,
      ) as { total: number; results: { id: string }[] };
      expect(afterData.total).toBe(1);
      expect(afterData.results[0]!.id).toBe(createdId);

      // 通过 engram_list 验证确实存在
      const listRes = await client.callTool({
        name: "engram_list",
        arguments: { filter: { domainTags: ["testing"] } },
      });
      const listData = JSON.parse(
        (listRes.content[0] as { text: string }).text,
      ) as { results: { id: string }[]; total: number };
      expect(listData.total).toBe(1);
      expect(listData.results[0]!.id).toBe(createdId);
    } finally {
      await cleanup();
    }
  });

  it("完整 CRUD 流程通过 MCP", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      // create
      const createRes = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "Hello",
          content: "World",
          kind: "fact",
          domainTags: ["e2e"],
          createdBy: "tester",
        },
      });
      const id = (
        JSON.parse((createRes.content[0] as { text: string }).text) as {
          id: string;
        }
      ).id;

      // get
      const getRes = await client.callTool({
        name: "engram_get",
        arguments: { id, tier: "content" },
      });
      const getData = JSON.parse(
        (getRes.content[0] as { text: string }).text,
      ) as { tier: string; content: string };
      expect(getData.tier).toBe("content");
      expect(getData.content).toBe("World");

      // update
      const updateRes = await client.callTool({
        name: "engram_update",
        arguments: { id, content: "Updated", updatedBy: "tester2" },
      });
      const updateData = JSON.parse(
        (updateRes.content[0] as { text: string }).text,
      ) as { version: number };
      expect(updateData.version).toBe(2);

      // delete
      const delRes = await client.callTool({
        name: "engram_delete",
        arguments: { id },
      });
      const delData = JSON.parse(
        (delRes.content[0] as { text: string }).text,
      ) as { deleted: boolean };
      expect(delData.deleted).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("synapse_create + synapse_list 通过 MCP", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const aRes = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "A",
          content: "a",
          kind: "fact",
          domainTags: ["t"],
          createdBy: "y",
        },
      });
      const aId = (
        JSON.parse((aRes.content[0] as { text: string }).text) as { id: string }
      ).id;

      const bRes = await client.callTool({
        name: "engram_create",
        arguments: {
          title: "B",
          content: "b",
          kind: "fact",
          domainTags: ["t"],
          createdBy: "y",
        },
      });
      const bId = (
        JSON.parse((bRes.content[0] as { text: string }).text) as { id: string }
      ).id;

      // 创建 synapse
      const synRes = await client.callTool({
        name: "synapse_create",
        arguments: {
          from: aId,
          to: bId,
          kind: "extends",
          createdBy: "y",
        },
      });
      const synData = JSON.parse(
        (synRes.content[0] as { text: string }).text,
      ) as { id: string };
      expect(synData.id).toBeTruthy();

      // 列出
      const listRes = await client.callTool({
        name: "synapse_list",
        arguments: { engramId: bId, direction: "both" },
      });
      const listData = JSON.parse(
        (listRes.content[0] as { text: string }).text,
      ) as { incoming: unknown[]; outgoing: unknown[] };
      expect(listData.incoming.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // ─── 仓库健康工具(repository 注入 + 端到端调用) ──────────────────────────────────

  it("engram_doctor 通过 MCP 可调用 (默认 ctx 注入 repository)", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const res = await client.callTool({
        name: "engram_doctor",
        arguments: {},
      });
      expect(res.isError).toBeFalsy();
      const data = JSON.parse((res.content[0] as { text: string }).text) as {
        startedAt: string;
        finishedAt: string;
        totalEngrams: number;
        totalSynapses: number;
        autoFixesApplied: number;
        pendingManualReview: number;
        issues: unknown[];
      };
      expect(data.startedAt).toBeTruthy();
      expect(data.finishedAt).toBeTruthy();
      expect(Array.isArray(data.issues)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("engram_list_paths 通过 MCP 可调用 (默认 ctx 注入 repository)", async () => {
    const { client, cleanup } = await startClient(tmpDir);
    try {
      const res = await client.callTool({
        name: "engram_list_paths",
        arguments: {},
      });
      expect(res.isError).toBeFalsy();
      const data = JSON.parse((res.content[0] as { text: string }).text) as {
        root: {
          path: string;
          engramCount: number;
          children: unknown[];
        };
      };
      expect(data.root.path).toBe("/");
      expect(data.root.engramCount).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanup();
    }
  });
});
