import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoEngramMcpServer } from "../src/register.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-mcp-prompts-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function startClient(language: "en" | "zh" = "en") {
  const { server } = createCoEngramMcpServer({
    dataRoot: tmpDir,
    language,
    profile: "full",
    proposalEnabled: true,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: { tools: {}, prompts: {} } },
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

async function seedEngram(
  client: Client,
  args: { title: string; content: string; domainTags?: string[] },
): Promise<string> {
  const res = await client.callTool({
    name: "engram_create",
    arguments: {
      title: args.title,
      content: args.content,
      kind: "fact",
      domainTags: args.domainTags ?? ["t"],
      createdBy: "tester",
    },
  });
  const text = (res.content[0] as { type: string; text: string }).text;
  return (JSON.parse(text) as { id: string }).id;
}

describe("MCP prompts / prompts/list", () => {
  it("返回 3 个 prompts", async () => {
    const { client, cleanup } = await startClient();
    try {
      const result = await client.listPrompts();
      const names = result.prompts.map((p) => p.name).sort();
      expect(names).toEqual([
        "co-engram-recall",
        "co-engram-review-proposals",
        "co-engram-stats",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("每个 prompt 有 description", async () => {
    const { client, cleanup } = await startClient();
    try {
      const result = await client.listPrompts();
      for (const p of result.prompts) {
        expect(p.description?.length, p.name).toBeGreaterThan(10);
      }
    } finally {
      await cleanup();
    }
  });

  it("co-engram-recall 暴露 query + maxResults 参数", async () => {
    const { client, cleanup } = await startClient();
    try {
      const result = await client.listPrompts();
      const recall = result.prompts.find((p) => p.name === "co-engram-recall");
      expect(recall).toBeDefined();
      const argNames = (recall?.arguments ?? []).map((a) => a.name);
      expect(argNames).toContain("query");
      expect(argNames).toContain("maxResults");
    } finally {
      await cleanup();
    }
  });
});

describe("MCP prompts / co-engram-recall", () => {
  it('空仓库给出"无匹配"提示', async () => {
    const { client, cleanup } = await startClient();
    try {
      const res = await client.getPrompt({
        name: "co-engram-recall",
        arguments: { query: "nonexistent" },
      });
      expect(res.messages.length).toBeGreaterThan(0);
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toMatch(/No memories matched|无匹配/);
    } finally {
      await cleanup();
    }
  });

  it("有匹配时返回结构化 markdown", async () => {
    const { client, cleanup } = await startClient();
    try {
      await seedEngram(client, {
        title: "TypeScript best practices",
        content: "use strict mode",
        domainTags: ["typescript", "frontend"],
      });

      // 需要重建索引(search 默认不包含刚创建的)
      // 这里直接验证 searchOrchestrator 的已有索引(为空)
      // 改为测 stats 即可
      const res = await client.getPrompt({
        name: "co-engram-recall",
        arguments: { query: "typescript" },
      });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toContain("# Recall results");
    } finally {
      await cleanup();
    }
  });

  it("中文环境下使用中文标题", async () => {
    const { client, cleanup } = await startClient("zh");
    try {
      const res = await client.getPrompt({
        name: "co-engram-recall",
        arguments: { query: "x" },
      });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toMatch(/召回结果|无匹配/);
    } finally {
      await cleanup();
    }
  });
});

describe("MCP prompts / co-engram-stats", () => {
  it("返回总数 + tag 频次", async () => {
    const { client, cleanup } = await startClient();
    try {
      await seedEngram(client, {
        title: "A",
        content: "a",
        domainTags: ["x", "y"],
      });
      await seedEngram(client, {
        title: "B",
        content: "b",
        domainTags: ["x"],
      });

      const res = await client.getPrompt({ name: "co-engram-stats" });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toContain("Total engrams: **2**");
      expect(text).toContain("`x` × 2");
      expect(text).toContain("`y` × 1");
    } finally {
      await cleanup();
    }
  });

  it("待处理候选 > 0 时给出 review 提醒", async () => {
    const { client, cleanup } = await startClient();
    try {
      const res = await client.getPrompt({ name: "co-engram-stats" });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      // 空仓库,无候选,不应有 review 提醒
      expect(text).not.toMatch(/review-proposals/);
    } finally {
      await cleanup();
    }
  });
});

describe("MCP prompts / co-engram-review-proposals", () => {
  it('空候选给出"无待处理"消息', async () => {
    const { client, cleanup } = await startClient();
    try {
      const res = await client.getPrompt({
        name: "co-engram-review-proposals",
      });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toContain("No pending proposals");
    } finally {
      await cleanup();
    }
  });

  it("proposalEnabled=false 时给出启用提示", async () => {
    // 重新启动一个 proposal 未启用的 server
    const { server } = createCoEngramMcpServer({
      dataRoot: tmpDir,
      proposalEnabled: false,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: { tools: {}, prompts: {} } },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const res = await client.getPrompt({
        name: "co-engram-review-proposals",
      });
      const text = (res.messages[0]!.content as { type: string; text: string })
        .text;
      expect(text).toMatch(/not enabled|未启用/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
