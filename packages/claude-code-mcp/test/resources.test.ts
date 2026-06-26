import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoEngramMcpServer } from "../src/register.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-mcp-resources-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function startClient() {
  const { server } = createCoEngramMcpServer({
    dataRoot: tmpDir,
    profile: "full",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
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

async function createEngram(
  client: Client,
  args: { title: string; content: string },
): Promise<string> {
  const res = await client.callTool({
    name: "engram_create",
    arguments: {
      title: args.title,
      content: args.content,
      kind: "fact",
      domainTags: ["t"],
      createdBy: "tester",
    },
  });
  const text = (res.content[0] as { type: string; text: string }).text;
  return (JSON.parse(text) as { id: string }).id;
}

describe("MCP resources / templates", () => {
  it("注册 engram:///{id} 资源模板", async () => {
    const { client, cleanup } = await startClient();
    try {
      const result = await client.listResources();
      // 没有创建 engram,list 应为空(模板未实例化)
      expect(result.resources).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("listResourcesTemplate 返回 engram 模板", async () => {
    const { client, cleanup } = await startClient();
    try {
      const result = await client.listResourceTemplates();
      const engramTmpl = result.resourceTemplates.find((t) =>
        t.uriTemplate.startsWith("engram:///"),
      );
      expect(engramTmpl).toBeDefined();
      expect(engramTmpl?.mimeType).toBe("text/markdown");
    } finally {
      await cleanup();
    }
  });
});

describe("MCP resources / list", () => {
  it("创建 engram 后 listResources 返回条目", async () => {
    const { client, cleanup } = await startClient();
    try {
      await createEngram(client, { title: "Alpha", content: "a" });
      await createEngram(client, { title: "Beta", content: "b" });

      const result = await client.listResources();
      expect(result.resources.length).toBe(2);

      const uris = result.resources.map((r) => r.uri).sort();
      expect(uris[0]).toMatch(/^engram:\/\/\//);
      expect(uris[1]).toMatch(/^engram:\/\/\//);

      const names = result.resources.map((r) => r.name).sort();
      expect(names).toEqual(["Alpha", "Beta"]);
    } finally {
      await cleanup();
    }
  });

  it("list 最多 10 条", async () => {
    const { client, cleanup } = await startClient();
    try {
      for (let i = 0; i < 15; i++) {
        await createEngram(client, { title: `E${i}`, content: `c${i}` });
      }
      const result = await client.listResources();
      expect(result.resources.length).toBe(10);
    } finally {
      await cleanup();
    }
  });
});

describe("MCP resources / read", () => {
  it("读取存在的 engram 返回完整 markdown", async () => {
    const { client, cleanup } = await startClient();
    try {
      const id = await createEngram(client, {
        title: "ADB Debug",
        content: "use wireless adb for debugging",
      });

      const res = await client.readResource({ uri: `engram:///${id}` });
      expect(res.contents).toHaveLength(1);
      const text = (res.contents[0] as { type: string; text: string }).text;
      expect(text).toContain("# ADB Debug");
      expect(text).toContain("use wireless adb for debugging");
      expect(text).toContain(`\`${id}\``);
      // 默认 language=zh,正文小标题为中文
      expect(text).toContain("## 内容");
    } finally {
      await cleanup();
    }
  });

  it("读取不存在的 id 返回错误 markdown(不抛异常)", async () => {
    const { client, cleanup } = await startClient();
    try {
      const res = await client.readResource({
        uri: "engram:///nonexistent/x",
      });
      const text = (res.contents[0] as { type: string; text: string }).text;
      expect(text).toMatch(/Error|not found|不存在/);
    } finally {
      await cleanup();
    }
  });
});
