import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adaptTool,
  adaptAllTools,
  registerCoEngramTools,
  createCoEngramContext,
  createCoEngramTools,
  rebuildSearchIndex,
  type OpenClawToolDescriptor,
  type CoEngramPluginHostApi,
} from "../src/index.js";
import { createToolRegistry, detectGitAuthor } from "@co-engram/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "openclaw.plugin.json");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-openclaw-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 内存版 host：收集所有注册的 tools
 */
function createMemoryHost(): CoEngramPluginHostApi & {
  tools: Map<string, OpenClawToolDescriptor>;
} {
  const tools = new Map<string, OpenClawToolDescriptor>();
  return {
    tools,
    registerTool(tool, opts) {
      const name = opts?.name ?? tool.name;
      tools.set(name, tool);
    },
  };
}

// ============================================================
// adaptTool
// ============================================================

describe("adaptTool", () => {
  it("正确转换 name/description/parameters", () => {
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const engramCreate = tools.find((t) => t.name === "engram_create")!;

    expect(engramCreate.name).toBe("engram_create");
    expect(engramCreate.description.length).toBeGreaterThan(0);
    expect(engramCreate.parameters.type).toBe("object");
    expect(engramCreate.parameters.required).toContain("title");
    void ctx;
  });

  it("execute 返回 JSON 结果", async () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const engramCreate = tools.find((t) => t.name === "engram_create")!;

    const result = await engramCreate.execute("call-1", {
      title: "ADB 调试",
      content: "内容",
      kind: "procedure",
      domainTags: ["testing"],
      createdBy: "yang",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.content[0]!.type).toBe("json");
    const data = (result.content[0] as { data: { id: string } }).data;
    // id 是 ULID,与路径解耦
    expect(data.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("execute 错误时返回 error result", async () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const engramGet = tools.find((t) => t.name === "engram_get")!;

    const result = await engramGet.execute("call-1", {
      id: "no/such",
      tier: "catalog",
    });

    expect(result.details?.ok).toBe(false);
    // AI-3b:details.error 是 EngramToolErrorSchema 对象,不是裸字符串。
    // 含 code/message/resourceId/suggestion 等结构化字段。
    const err = result.details?.error as {
      code: string;
      message: string;
      resourceId?: string;
    };
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/not found|no such|invalid/i);
  });

  it("schema 缺失时回退到通配 object", () => {
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    const fakeTool = {
      name: "unknown_tool",
      description: "unknown",
      inputSchema: {},
      execute: () => 1,
    };
    const desc = adaptTool(fakeTool as never, ctx);
    expect(desc.parameters.type).toBe("object");
    expect(desc.parameters.additionalProperties).toBe(true);
  });
});

// ============================================================
// adaptAllTools
// ============================================================

describe("adaptAllTools", () => {
  it("批量适配所有原生工具(registry 当前 31 个,含 skill_invoke stub + engram_audit_query + AI-8 batch proposal)", () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_learning_loop",
      "contradiction_resolve",
      "engram_accept_proposal",
      "engram_accept_proposals_by_source",
      "engram_archive",
      "engram_audit_query",
      "engram_create",
      "engram_delete",
      "engram_dismiss_proposal",
      "engram_dismiss_proposals_by_filter",
      "engram_doctor",
      "engram_forget",
      "engram_get",
      "engram_list",
      "engram_list_paths",
      "engram_list_proposals",
      "engram_reinforce",
      "engram_report_failure",
      "engram_restore",
      "engram_search",
      "engram_sync",
      "engram_synthesize",
      "engram_update",
      "get_evolution_lineage",
      "skill_get",
      "skill_invoke",
      "synapse_create",
      "synapse_delete",
      "synapse_get",
      "synapse_list",
      "upgrade_verification",
    ]);
    // 数字不硬编码,跟列表长度走 —— 列表本身是 regression guard,防止工具被无意移除。
    expect(tools.length).toBe(31);
  });
});

// ============================================================
// openclaw.plugin.json manifest sync
// ============================================================

describe("openclaw.plugin.json manifest sync", () => {
  it("contracts.tools 包含 registry 全部 native 工具 + 2 个 memory_* 兼容包装", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      contracts: { tools: string[] };
    };
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const registryNames = new Set(tools.map((t) => t.name));
    const manifestNames = new Set(manifest.contracts.tools);

    // manifest 必须覆盖所有 registry 工具(regression: doctor/list_paths/audit_query 曾被遗漏)
    const missingInManifest = [...registryNames].filter(
      (n) => !manifestNames.has(n),
    );
    expect(missingInManifest).toEqual([]);

    // 还要包含 OpenClaw 兼容的 memory_* 包装(plugin-entry 注册)
    expect(manifestNames.has("memory_search")).toBe(true);
    expect(manifestNames.has("memory_get")).toBe(true);

    // 总数跟 registry 走 + 2 memory_* wrapper,避免新工具加入时再次 drift。
    expect(manifest.contracts.tools.length).toBe(registryNames.size + 2);
  });
});

// ============================================================
// registerCoEngramTools
// ============================================================

describe("registerCoEngramTools", () => {
  it("注册全部工具到 host(registry native + 2 memory_* 兼容包装)", () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });
    // 不硬编码数字 —— createToolRegistry 的工具数 + 2 wrapper,避免 drift。
    const expected = createToolRegistry().list().length + 2;
    expect(host.tools.size).toBe(expected);
  });

  it("enabled=false 时不注册工具", () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir, enabled: false });
    expect(host.tools.size).toBe(0);
  });

  it("dataRoot 自动创建", () => {
    const newRoot = join(tmpDir, "fresh-data");
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: newRoot });
    const expected = createToolRegistry().list().length + 2;
    expect(host.tools.size).toBe(expected);
  });

  it("注册的工具可被调用", async () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });
    const engramCreate = host.tools.get("engram_create")!;
    const result = await engramCreate.execute("call", {
      title: "X",
      content: "x",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    expect(result.details?.ok).toBe(true);
  });
});

// ============================================================
// rebuildSearchIndex
// ============================================================

describe("rebuildSearchIndex", () => {
  it("create 后 search 立即能找到新 engram（invalidateSearchIndex 自动重建）", async () => {
    const { ctx, tools, rebuild } = createCoEngramTools({ dataRoot: tmpDir });

    // 创建一个 engram
    const createResult = await tools
      .find((t) => t.name === "engram_create")!
      .execute("c", {
        title: "Android ADB",
        content: "adb 调试",
        kind: "fact",
        domainTags: ["testing"],
        createdBy: "y",
      });
    const createdId = (createResult.content[0] as { data: { id: string } }).data
      .id;

    // 新行为:create 后 invalidateSearchIndex 自动重建索引,search 立即能找到
    // （旧行为是 P0 限制:写入不更新索引,需要手动 rebuild）
    // adapter 把 {results,total} 渲染为 markdown text(LLM 友好),所以这里
    // 直接验证 searchOrchestrator 的内存状态,而不是 adapter 输出。
    const directResults = ctx.searchOrchestrator.search("adb", {}, 10);
    expect(directResults.length).toBe(1);
    expect(directResults[0]!.id).toBe(createdId);

    // 同时验证 adapter 输出包含 createdId(markdown 渲染)
    const afterCreate = await tools
      .find((t) => t.name === "engram_search")!
      .execute("c", {
        query: "adb",
      });
    const afterCreateText =
      (afterCreate.content[0] as { type: string; text?: string }).text ?? "";
    expect(afterCreateText).toContain(createdId);

    // rebuild 仍然可用,作为外部触发重建的入口（如批量导入数据后）
    rebuild();

    // 再次 search 仍然能找到
    const afterRebuild = await tools
      .find((t) => t.name === "engram_search")!
      .execute("c", {
        query: "adb",
      });
    const afterRebuildText =
      (afterRebuild.content[0] as { type: string; text?: string }).text ?? "";
    expect(afterRebuildText).toContain(createdId);
  });
});

// ============================================================
// JSON Schemas
// ============================================================

describe("JSON Schemas", () => {
  it("每个工具都有对应的 schema", () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    for (const t of tools) {
      expect(t.parameters).toBeDefined();
      expect(typeof t.parameters).toBe("object");
    }
  });

  it("engram_create schema 含所有必要字段", () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const engramCreate = tools.find((t) => t.name === "engram_create")!;
    const props = engramCreate.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("title");
    expect(props).toHaveProperty("content");
    expect(props).toHaveProperty("kind");
    expect(props).toHaveProperty("domainTags");
    expect(props).toHaveProperty("createdBy");
  });

  it("synapse_create schema 含 12 种 kind", () => {
    const { tools } = createCoEngramTools({ dataRoot: tmpDir });
    const synapseCreate = tools.find((t) => t.name === "synapse_create")!;
    const kindProp = (
      synapseCreate.parameters.properties as Record<string, { enum: string[] }>
    ).kind;
    expect(kindProp.enum.length).toBe(12);
    expect(kindProp.enum).toContain("contradicts");
  });
});

// ============================================================
// 完整端到端：通过 OpenClaw adapter 执行完整流程
// ============================================================

describe("end-to-end via OpenClaw adapter", () => {
  it("创建 → 读取 → 搜索 → 更新 → 删除", async () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });

    const create = host.tools.get("engram_create")!;
    const get = host.tools.get("engram_get")!;
    const update = host.tools.get("engram_update")!;
    const deleteTool = host.tools.get("engram_delete")!;

    // 1. 创建
    const createRes = await create.execute("c", {
      title: "Original Title",
      content: "original content",
      kind: "fact",
      domainTags: ["e2e"],
      createdBy: "tester",
    });
    const id = (createRes.content[0] as { data: { id: string } }).data.id;

    // 2. 读取（catalog）— adapter 渲染为 markdown text
    const getRes = await get.execute("c", { id, tier: "catalog" });
    const getText =
      (getRes.content[0] as { type: string; text?: string }).text ?? "";
    expect(getText).toContain("Original Title");
    expect(getText).toContain(id);

    // 3. 更新
    const updateRes = await update.execute("c", {
      id,
      title: "Updated Title",
      updatedBy: "tester2",
    });
    const updateData = (updateRes.content[0] as { data: { version: number } })
      .data;
    expect(updateData.version).toBe(2);

    // 4. 再次读取，确认标题已变
    const getRes2 = await get.execute("c", { id, tier: "catalog" });
    const getText2 =
      (getRes2.content[0] as { type: string; text?: string }).text ?? "";
    expect(getText2).toContain("Updated Title");

    // 5. 删除
    const delRes = await deleteTool.execute("c", { id });
    const delData = (delRes.content[0] as { data: { deleted: boolean } }).data;
    expect(delData.deleted).toBe(true);
  });

  it("创建两个 engram + 连接 + 查询 synapses", async () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });

    const create = host.tools.get("engram_create")!;
    const synCreate = host.tools.get("synapse_create")!;
    const synList = host.tools.get("synapse_list")!;
    const getBundle = host.tools.get("engram_get")!;

    // 1. 创建两个 engram
    const a = await create.execute("c", {
      title: "A",
      content: "a",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const aId = (a.content[0] as { data: { id: string } }).data.id;

    const b = await create.execute("c", {
      title: "B",
      content: "b",
      kind: "fact",
      domainTags: ["t"],
      createdBy: "y",
    });
    const bId = (b.content[0] as { data: { id: string } }).data.id;

    // 2. 创建 synapse
    await synCreate.execute("c", {
      from: aId,
      to: bId,
      kind: "extends",
      createdBy: "y",
    });

    // 3. 列出 B 的 synapses（应有 incoming）
    const listRes = await synList.execute("c", {
      engramId: bId,
      direction: "both",
    });
    const listData = (
      listRes.content[0] as {
        data: { incoming: unknown[]; outgoing: unknown[] };
      }
    ).data;
    expect(listData.incoming.length).toBe(1);
    expect(listData.outgoing.length).toBe(0);

    // 4. 通过 engram_get synapses tier 拿 bundle — adapter 渲染为 markdown text
    const bundleRes = await getBundle.execute("c", {
      id: aId,
      tier: "synapses",
    });
    const bundleText =
      (bundleRes.content[0] as { type: string; text?: string }).text ?? "";
    // 应包含 outgoing 段(有 1 条),且包含 bId 作为 to 目标
    expect(bundleText).toContain("Outgoing");
    expect(bundleText).toContain(bId);
    // incoming 为 0,不应渲染 Incoming 段
    expect(bundleText).not.toContain("Incoming");
  });

  it("engram_doctor 默认可用 (ctx 注入 repository)", async () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });

    const doctor = host.tools.get("engram_doctor")!;
    const res = await doctor.execute("c", {});
    expect(res.details?.ok).toBe(true);
    const data = (res.content[0] as { data: unknown }).data as {
      startedAt: string;
      finishedAt: string;
      issues: unknown[];
    };
    expect(data.startedAt).toBeTruthy();
    expect(data.finishedAt).toBeTruthy();
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it("engram_list_paths 默认可用 (ctx 注入 repository)", async () => {
    const host = createMemoryHost();
    registerCoEngramTools(host, { dataRoot: tmpDir });

    const listPaths = host.tools.get("engram_list_paths")!;
    const res = await listPaths.execute("c", {});
    expect(res.details?.ok).toBe(true);
    const data = (res.content[0] as { data: unknown }).data as {
      root: { path: string; engramCount: number };
    };
    expect(data.root.path).toBe("/");
    expect(data.root.engramCount).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// defaultCreatedBy 注入
// ============================================================

describe("defaultCreatedBy", () => {
  it('未配置时:优先 git user.name/email,否则回退到 "openclaw"', () => {
    const ctx = createCoEngramContext({ dataRoot: tmpDir });
    // 解析链:user config > git user.name/email > 'openclaw'
    // 测试机器若有 git 配置会用 git 身份;没有则回退 'openclaw'
    const expected = detectGitAuthor() ?? "openclaw";
    expect(ctx.defaultCreatedBy).toBe(expected);
  });

  it("config.defaultCreatedBy 覆盖默认值", () => {
    const ctx = createCoEngramContext({
      dataRoot: tmpDir,
      defaultCreatedBy: "yang",
    });
    expect(ctx.defaultCreatedBy).toBe("yang");
  });

  it("注入后 engram_create 不传 createdBy 时会回退", async () => {
    const { tools } = createCoEngramTools({
      dataRoot: tmpDir,
      defaultCreatedBy: "yang",
    });
    const engramCreate = tools.find((t) => t.name === "engram_create")!;

    const result = await engramCreate.execute("call-1", {
      title: "ADB 调试",
      content: "内容",
      kind: "procedure",
      domainTags: ["testing"],
      // 故意不传 createdBy
    });

    expect(result.details?.ok).toBe(true);
    const data = (result.content[0] as { data: { id: string } }).data;
    const ctx = createCoEngramContext({
      dataRoot: tmpDir,
      defaultCreatedBy: "yang",
    });
    const engram = ctx.repository.readEngram(data.id);
    expect(engram.createdBy).toBe("yang");
  });
});
