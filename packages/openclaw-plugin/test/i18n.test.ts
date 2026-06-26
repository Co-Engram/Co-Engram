import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptTool, adaptAllTools } from "../src/adapter.js";
import {
  buildProposalPrompt,
  registerCoEngramTools,
} from "../src/plugin-entry.js";
import {
  createToolRegistry,
  type Tool,
  type ToolContext,
} from "@co-engram/core";
import type {
  CoEngramPluginHostApi,
  OpenClawToolDescriptor,
} from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-oc-i18n-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFakeCtx(): ToolContext {
  // 最小化的 ctx,只为 adaptTool 测试(不会真的执行)
  return {
    repository: {
      listEngrams: () => [],
    } as unknown as ToolContext["repository"],
  };
}

describe("OpenClaw adapter i18n / adaptTool", () => {
  it("language=en 走 LLM 英文字典(优先于 core i18n)", () => {
    const registry = createToolRegistry();
    const tool = registry.get("engram_create") as Tool;
    const ctx = makeFakeCtx();
    const desc = adaptTool(tool, ctx, "en");
    // LLM 描述以 "Create a new memory" 开头,而不是 core i18n 的 "Create a new Engram"
    expect(desc.description).toContain("Create a new memory");
    expect(desc.description).toContain("WHEN TO CALL");
    expect(desc.description).not.toContain("创建");
  });

  it("language=zh 走 LLM 中文字典", () => {
    const registry = createToolRegistry();
    const tool = registry.get("engram_create") as Tool;
    const ctx = makeFakeCtx();
    const desc = adaptTool(tool, ctx, "zh");
    expect(desc.description).toContain("创建新记忆");
    expect(desc.description).toContain("何时调用");
    expect(desc.description).not.toContain("Create a new");
  });

  it("默认 zh", () => {
    const registry = createToolRegistry();
    const tool = registry.get("synapse_create") as Tool;
    const ctx = makeFakeCtx();
    const desc = adaptTool(tool, ctx);
    expect(desc.description).toContain("在两条记忆之间创建有类型的连接");
  });

  it("未传 language 时所有 27 个工具的描述与传 zh 一致", () => {
    const registry = createToolRegistry();
    const tools = registry.list();
    const ctx = makeFakeCtx();
    const defaultDescs = adaptAllTools(tools, ctx);
    const zhDescs = adaptAllTools(tools, ctx, "zh");
    expect(defaultDescs.length).toBe(27);
    expect(zhDescs.length).toBe(27);
    for (let i = 0; i < defaultDescs.length; i++) {
      expect(defaultDescs[i]!.description).toBe(zhDescs[i]!.description);
    }
  });

  it("LLM 字典未覆盖的工具(如 engram_archive)仍走 core i18n", () => {
    const registry = createToolRegistry();
    const tool = registry.get("engram_archive") as Tool;
    const ctx = makeFakeCtx();
    const desc = adaptTool(tool, ctx, "en");
    // engram_archive 不在 LLM_TOOL_DESCRIPTIONS 里,应回退到 core i18n
    expect(desc.description).not.toContain("WHEN TO CALL");
  });
});

describe("OpenClaw plugin i18n / registerCoEngramTools", () => {
  function makeFakeApi(): {
    api: CoEngramPluginHostApi;
    tools: OpenClawToolDescriptor[];
  } {
    const tools: OpenClawToolDescriptor[] = [];
    const api: CoEngramPluginHostApi = {
      registerTool: (tool) => {
        tools.push(tool);
      },
    };
    return { api, tools };
  }

  it("language=zh 时注册的工具描述是中文(LLM 字典优先)", () => {
    const { api, tools } = makeFakeApi();
    registerCoEngramTools(api, { dataRoot: tmpDir, language: "zh" });
    // 27 原生工具 + 2 OpenClaw 兼容(memory_search/memory_get) = 29
    expect(tools.length).toBe(29);
    const create = tools.find((t) => t.name === "engram_create");
    expect(create?.description).toContain("创建新记忆");
    expect(create?.description).toContain("何时调用");
  });

  it("language=en 时注册的工具描述是英文(LLM 字典优先)", () => {
    const { api, tools } = makeFakeApi();
    registerCoEngramTools(api, { dataRoot: tmpDir, language: "en" });
    // 27 原生工具 + 2 OpenClaw 兼容(memory_search/memory_get) = 29
    expect(tools.length).toBe(29);
    const create = tools.find((t) => t.name === "engram_create");
    expect(create?.description).toContain("Create a new memory");
    expect(create?.description).toContain("WHEN TO CALL");
  });

  it("未传 language 默认中文", () => {
    const { api, tools } = makeFakeApi();
    registerCoEngramTools(api, { dataRoot: tmpDir });
    const search = tools.find((t) => t.name === "engram_search");
    // LLM 字典覆盖 engram_search,默认 zh 应该看到 "搜索团队记忆"
    expect(search?.description).toContain("搜索团队记忆");
    expect(search?.description).toContain("何时调用");
  });

  it("注册结果包含 language", () => {
    const { api } = makeFakeApi();
    const result = registerCoEngramTools(api, {
      dataRoot: tmpDir,
      language: "zh",
    });
    expect(result.language).toBe("zh");
  });
});

describe("OpenClaw plugin i18n / buildProposalPrompt", () => {
  it("英文单数", () => {
    expect(buildProposalPrompt(1, "en")).toContain(
      "1 memory candidate pending",
    );
  });

  it("英文复数", () => {
    expect(buildProposalPrompt(3, "en")).toContain(
      "3 memory candidates pending",
    );
  });

  it("中文", () => {
    const s = buildProposalPrompt(2, "zh");
    expect(s).toContain("2 个候选记忆");
    expect(s).toContain("engram_list_proposals");
  });

  it("默认 zh", () => {
    expect(buildProposalPrompt(2)).toContain("2 个候选记忆");
  });
});
