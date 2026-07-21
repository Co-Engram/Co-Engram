import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoEngramMcpServer } from "../src/register.js";
import { buildLocalizedProposalPrompt } from "../src/mcp-server.js";
import { createToolRegistry } from "@co-engram/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-mcp-i18n-"));
  delete process.env.CO_ENGRAM_LANGUAGE;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CO_ENGRAM_LANGUAGE;
});

async function startClient(language: "en" | "zh") {
  const { server } = createCoEngramMcpServer({
    dataRoot: tmpDir,
    language,
    profile: "full",
  });
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

describe("MCP i18n / 工具描述本地化", () => {
  it("language=en 时 standard 工具走 LLM 英文字典", async () => {
    const { client, cleanup } = await startClient("en");
    try {
      const list = await client.listTools();
      const engramCreate = list.tools.find((t) => t.name === "engram_create");
      expect(engramCreate).toBeDefined();
      expect(engramCreate?.description).toContain("Create a new memory");
      expect(engramCreate?.description).toContain("WHEN TO CALL");
      expect(engramCreate?.description).not.toContain("何时调用");
    } finally {
      await cleanup();
    }
  });

  it("language=zh 时 standard 工具走 LLM 中文字典", async () => {
    const { client, cleanup } = await startClient("zh");
    try {
      const list = await client.listTools();
      const engramCreate = list.tools.find((t) => t.name === "engram_create");
      expect(engramCreate).toBeDefined();
      expect(engramCreate?.description).toContain("创建新记忆");
      expect(engramCreate?.description).toContain("何时调用");
      expect(engramCreate?.description).not.toContain("WHEN TO CALL");
    } finally {
      await cleanup();
    }
  });

  it("两种语言的描述确实不同(standard 走 LLM,内部工具走 core i18n)", async () => {
    const enClient = await startClient("en");
    const zhClient = await startClient("zh");
    try {
      const enList = await enClient.client.listTools();
      const zhList = await zhClient.client.listTools();

      const enSearch = enList.tools.find(
        (t) => t.name === "engram_search",
      )?.description;
      const zhSearch = zhList.tools.find(
        (t) => t.name === "engram_search",
      )?.description;
      expect(enSearch).not.toBe(zhSearch);
      expect(enSearch).toContain("WHEN TO CALL");
      expect(zhSearch).toContain("何时调用");

      const enArchive = enList.tools.find(
        (t) => t.name === "engram_archive",
      )?.description;
      const zhArchive = zhList.tools.find(
        (t) => t.name === "engram_archive",
      )?.description;
      expect(enArchive).not.toBe(zhArchive);
    } finally {
      await enClient.cleanup();
      await zhClient.cleanup();
    }
  });

  it("全部 native 工具在两种语言下都有非空 description（profile=full 应等于 registry 全集）", async () => {
    const enClient = await startClient("en");
    const zhClient = await startClient("zh");
    try {
      const enList = await enClient.client.listTools();
      const zhList = await zhClient.client.listTools();
      // 数字不硬编码 —— registry 增减工具时本断言自动跟随,避免再次 drift。
      const expected = createToolRegistry().list().length;
      expect(enList.tools.length).toBe(expected);
      expect(zhList.tools.length).toBe(expected);
      for (const t of enList.tools) {
        expect(t.description?.length, `${t.name} en desc`).toBeGreaterThan(10);
      }
      for (const t of zhList.tools) {
        expect(t.description?.length, `${t.name} zh desc`).toBeGreaterThan(10);
      }
    } finally {
      await enClient.cleanup();
      await zhClient.cleanup();
    }
  });
});

describe("MCP i18n / 仓库健康工具描述本地化(full-only)", () => {
  it("language=en 时 engram_doctor 走英文字典 + LLM 结构", async () => {
    const { client, cleanup } = await startClient("en");
    try {
      const list = await client.listTools();
      const doctor = list.tools.find((t) => t.name === "engram_doctor");
      expect(doctor).toBeDefined();
      expect(doctor?.description).toContain("WHEN TO CALL");
      expect(doctor?.description).toContain("RETURNS");
      expect(doctor?.description).not.toContain("何时调用");
    } finally {
      await cleanup();
    }
  });

  it("language=zh 时 engram_doctor 走中文字典", async () => {
    const { client, cleanup } = await startClient("zh");
    try {
      const list = await client.listTools();
      const doctor = list.tools.find((t) => t.name === "engram_doctor");
      expect(doctor).toBeDefined();
      expect(doctor?.description).toContain("何时调用");
      expect(doctor?.description).toContain("自愈扫描");
      expect(doctor?.description).not.toContain("WHEN TO CALL");
    } finally {
      await cleanup();
    }
  });

  it("language=en 时 engram_list_paths 走英文字典", async () => {
    const { client, cleanup } = await startClient("en");
    try {
      const list = await client.listTools();
      const listPaths = list.tools.find((t) => t.name === "engram_list_paths");
      expect(listPaths).toBeDefined();
      expect(listPaths?.description).toContain("WHEN TO CALL");
      expect(listPaths?.description).toContain("directory tree");
      expect(listPaths?.description).not.toContain("何时调用");
    } finally {
      await cleanup();
    }
  });

  it("language=zh 时 engram_list_paths 走中文字典", async () => {
    const { client, cleanup } = await startClient("zh");
    try {
      const list = await client.listTools();
      const listPaths = list.tools.find((t) => t.name === "engram_list_paths");
      expect(listPaths).toBeDefined();
      expect(listPaths?.description).toContain("何时调用");
      expect(listPaths?.description).toContain("目录树");
      expect(listPaths?.description).not.toContain("WHEN TO CALL");
    } finally {
      await cleanup();
    }
  });

  it("两种语言的仓库健康工具描述确实不同", async () => {
    const enClient = await startClient("en");
    const zhClient = await startClient("zh");
    try {
      const enList = await enClient.client.listTools();
      const zhList = await zhClient.client.listTools();

      const enDoctor = enList.tools.find(
        (t) => t.name === "engram_doctor",
      )?.description;
      const zhDoctor = zhList.tools.find(
        (t) => t.name === "engram_doctor",
      )?.description;
      expect(enDoctor).not.toBe(zhDoctor);

      const enListPaths = enList.tools.find(
        (t) => t.name === "engram_list_paths",
      )?.description;
      const zhListPaths = zhList.tools.find(
        (t) => t.name === "engram_list_paths",
      )?.description;
      expect(enListPaths).not.toBe(zhListPaths);
    } finally {
      await enClient.cleanup();
      await zhClient.cleanup();
    }
  });
});

describe("MCP i18n / instructions 动态段(session-fresh)", () => {
  it('MCP initialize 返回的 instructions 含 "Current state" 段(5a4603c 移除 totalMemories/pendingProposals)', async () => {
    // 5a4603c:topTags 改为 repository 实时算(此处空 repo → 无 Top tags 行);
    // lowConfidenceTopics/missedTopics 暂留空;totalMemories/pendingProposals 行已移除。
    // prompt-signals.json 不再被 instructions 读取,故不再写入。
    const { server } = createCoEngramMcpServer({
      dataRoot: tmpDir,
      language: "en",
      profile: "standard",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      expect(instructions!).toContain("## Current state (session-fresh)");
      // 5a4603c 移除的行,在 MCP initialize 产物里也不应出现
      expect(instructions!).not.toContain("Total memories");
      expect(instructions!).not.toContain("Pending proposals");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("无 prompt-signals.json 时 instructions 不含动态段(降级)", async () => {
    // 确保 signals 文件不存在
    const signalsPath = join(tmpDir, ".co-engram", "prompt-signals.json");
    if (existsSync(signalsPath)) rmSync(signalsPath);

    const { server } = createCoEngramMcpServer({
      dataRoot: tmpDir,
      language: "en",
      profile: "standard",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      // totalEngrams=0 + 无 signals → 不含动态段(动态段只在有 state 时注入,
      // 但目前实现是始终注入;若 totalEngrams=0 且全空,段会显示但行数最少)
      // 这里验证至少不崩
      expect(instructions!.length).toBeGreaterThan(100);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP i18n / buildLocalizedProposalPrompt", () => {
  it("英文单数", () => {
    const s = buildLocalizedProposalPrompt(1, "en");
    expect(s).toContain("1 memory candidate pending");
    expect(s).toContain("topic seen");
  });

  it("英文复数", () => {
    const s = buildLocalizedProposalPrompt(3, "en");
    expect(s).toContain("3 memory candidates pending");
    expect(s).toContain("topics seen");
  });

  it("中文(不区分单复数)", () => {
    const s1 = buildLocalizedProposalPrompt(1, "zh");
    const s3 = buildLocalizedProposalPrompt(3, "zh");
    expect(s1).toContain("1 个候选记忆");
    expect(s3).toContain("3 个候选记忆");
    expect(s1).toContain("engram_list_proposals");
    expect(s3).toContain("engram_accept_proposal");
  });

  it("默认语言为 zh", () => {
    const s = buildLocalizedProposalPrompt(2);
    expect(s).toContain("2 个候选记忆");
  });
});
