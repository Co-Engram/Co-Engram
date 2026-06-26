#!/usr/bin/env node
/**
 * 真实用户场景探针:测一些 happy path 之外的情况
 * 不放进自动化测试,目的是发现 UX 问题。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const SERVER =
  process.env.CO_ENGRAM_MCP_SERVER ??
  new URL("../../dist/mcp-server.js", import.meta.url).pathname;
const DATA_ROOT = process.argv[2] ?? "/tmp/co-engram-real-usage";

const env = {
  ...process.env,
  CO_ENGRAM_DATA_ROOT: DATA_ROOT,
  CO_ENGRAM_DEFAULT_CREATED_BY: "real-user",
  CO_ENGRAM_MAINTENANCE: "0",
  CO_ENGRAM_TOOLS_PROFILE: "full",
  CO_ENGRAM_LANGUAGE: "zh",
};

const transport = new StdioClientTransport({
  stdio: ["ignore", "pipe", "inherit"],
  command: "node",
  args: [SERVER],
  env,
});

const client = new Client(
  { name: "probe", version: "1.0" },
  { capabilities: {} },
);
await client.connect(transport);

let pass = 0,
  fail = 0;
async function probe(name, fn) {
  try {
    const summary = await fn();
    console.log(`  ✓ ${name}  —  ${summary ?? ""}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}  —  ${err.message}`);
    fail++;
  }
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) {
    const text = r.content?.[0]?.text ?? JSON.stringify(r.content);
    throw new Error(`${name}: ${text}`);
  }
  // MCP returns { content: [{type:'text', text: JSON.stringify(result)}], structuredContent: result }
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return r;
}

console.log(`\n[probe] dataRoot=${DATA_ROOT}\n`);

// === 测试 1: schema 错误消息 — LLM 容易传错类型 ===
await probe("schema 错误:kind 写错应给清晰提示", async () => {
  try {
    await call("engram_create", {
      title: "测试",
      content: "x",
      kind: "wrong_kind",
      domainTags: ["t"],
    });
    throw new Error("应该被拒绝");
  } catch (err) {
    const msg = err.message;
    if (
      msg.includes("invalid_enum_value") ||
      msg.includes("kind") ||
      msg.includes("observation")
    ) {
      return `error mentions valid kinds`;
    }
    throw new Error(`错误消息没有列出有效值: ${msg.slice(0, 200)}`);
  }
});

// === 测试 2: 创建一个 engram ===
let firstId;
await probe("创建 engram A", async () => {
  const r = await call("engram_create", {
    title: "TypeScript strict mode readonly gotcha",
    content: "In TS strict mode, readonly fields cannot be directly assigned.",
    kind: "pattern",
    domainTags: ["engineering", "typescript"],
    confidence: 0.8,
  });
  firstId = r.id;
  return `id=${r.id} verdict=${r.verdict}`;
});

// === 测试 3: dedup — 重复内容应触发 DUPLICATE/UPDATE ===
await probe("dedup: 创建近似 engram 应返回 DUPLICATE/UPDATE", async () => {
  const r = await call("engram_create", {
    title: "TypeScript strict mode readonly gotcha",
    content: "In TS strict mode, readonly fields cannot be directly assigned.",
    kind: "pattern",
    domainTags: ["engineering", "typescript"],
  });
  if (r.verdict === "NEW")
    throw new Error(`expected DUPLICATE/UPDATE, got NEW (id=${r.id})`);
  return `verdict=${r.verdict} targetId=${r.targetId ?? "-"}`;
});

// === 测试 4: 中文搜索 ===
await probe("中文搜索能命中", async () => {
  await call("engram_create", {
    title: "SSH 隧道穿透堡垒机",
    content: "使用 ssh -L 转发本地端口到内网",
    kind: "procedure",
    domainTags: ["ops", "linux"],
  });
  const r = await call("engram_search", { query: "SSH 隧道" });
  return `${r.results.length} hits`;
});

// === 测试 5: tier 渐进披露 ===
await probe("tier=catalog 只返回最小字段", async () => {
  const r = await call("engram_get", { id: firstId, tier: "catalog" });
  const entry = r.entry ?? r;
  if (entry.content) throw new Error("catalog 不应包含 content");
  return `keys=${Object.keys(entry).join(",")}`;
});

// === 测试 6: tier=content 完整内容 ===
await probe("tier=content 返回 body", async () => {
  const r = await call("engram_get", { id: firstId, tier: "content" });
  const entry = r.entry ?? r;
  if (!entry.content && !r.content) throw new Error("content tier 缺失 body");
  return "ok";
});

// === 测试 7: 错误 ID 应给清晰消息 ===
await probe("读不存在的 ID 友好报错", async () => {
  try {
    await call("engram_get", { id: "01KZZZZZZZZZZZZZZZZZZZZZZZ" });
    throw new Error("应该 not found");
  } catch (err) {
    if (!/not found|不存在|no such/i.test(err.message)) throw err;
    return "ok";
  }
});

// === 测试 8: 工具描述是中文(CO_ENGRAM_LANGUAGE=zh) ===
await probe("工具描述已本地化为中文", async () => {
  const list = await client.listTools();
  const create = list.tools.find((t) => t.name === "engram_create");
  if (!create) throw new Error("engram_create 不在工具列表");
  // 中文描述应包含中文特征字符
  const has_chinese = /[一-鿿]/.test(create.description);
  if (!has_chinese) throw new Error("描述不含中文字符");
  return `description 前 40 字符: ${create.description.slice(0, 40)}...`;
});

// === 测试 9: engram_doctor 在脏数据上能跑 ===
await probe("engram_doctor 跑出 issues 列表", async () => {
  const r = await call("engram_doctor", {});
  return `totalEngrams=${r.totalEngrams} autoFixes=${r.autoFixesApplied} pendingManual=${r.pendingManualReview}`;
});

// === 测试 10: engram_list filter 起作用 ===
await probe("engram_list filter 按 domainTags 过滤", async () => {
  const r = await call("engram_list", {
    filter: { domainTags: ["engineering"] },
  });
  return `matched=${r.total ?? r.length ?? 0}`;
});

console.log(`\n[probe] ${pass} passed, ${fail} failed\n`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
